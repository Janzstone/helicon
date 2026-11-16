/**
 * Replays a recorded Muse Code run (scripts/record-demo-run.mjs) through the real Helicon UI, one step at a
 * time. The events are the ones the app received during the run; only the pacing is the visitor's.
 */
import type { ApprovalRequest, TranscriptLoad, ViewEvent } from "@/product/types";
import { DemoClient, summary } from "./client";

export type Recording = {
  task: string;
  repo: string;
  cwd: string;
  prompt: string;
  recordedAt: string;
  modelId: string | null;
  live: ViewEvent[];
};

export type StepKind = "prompt" | "tool" | "approval" | "reply";

export type ReplayStep = {
  kind: StepKind;
  /** What the step shows, for the caption under the controls. */
  label: string;
  events: ViewEvent[];
};

export type ReplayState = {
  /** Steps already played. */
  played: number;
  total: number;
  /** A recorded approval is on screen and the run waits for the visitor. */
  waiting: boolean;
  /** The visitor rejected the approval; the run stops until they approve it. */
  denied: boolean;
  done: boolean;
};

type Params = Record<string, unknown>;

const params = (event: ViewEvent) => (event.params ?? {}) as Params;
const item = (event: ViewEvent) => params(event)["item"] as Params | undefined;

function parseArgs(raw: unknown): Params {
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw) as Params;
  } catch {
    return {};
  }
}

function shortPath(path: unknown, cwd: string): string {
  const text = typeof path === "string" ? path : "";
  return text.startsWith(cwd + "/") ? text.slice(cwd.length + 1) : text || "a file";
}

function toolLabel(entry: Params, cwd: string): string {
  const args = parseArgs(entry["args"]);
  switch (entry["tool"]) {
    case "bash": {
      const command = String(args["command"] ?? "").split("\n")[0];
      return `Ran ${command.length > 60 ? command.slice(0, 57) + "..." : command}`;
    }
    case "read_file":
      return `Read ${shortPath(args["path"], cwd)}`;
    case "edit_file":
    case "write_file":
      return `Edited ${shortPath(args["path"], cwd)}`;
    case "write_todos":
      return "Updated its plan";
    case "read_skill":
      return "Read a skill";
    case "ls":
      return `Listed ${shortPath(args["path"], cwd) || "the folder"}`;
    default:
      return `Used ${String(entry["tool"] ?? "a tool")}`;
  }
}

/**
 * Splits a run into the steps a visitor clicks through: the prompt, each tool call (calls that run side by
 * side share a step), each approval and the closing reply. Usage and status events ride along with the step
 * they follow, and the run's tail (turn end, cleanup) joins the last step.
 */
export function buildSteps(recording: Recording): ReplayStep[] {
  const steps: ReplayStep[] = [];
  let current: ViewEvent[] = [];
  let labels: string[] = [];
  const open = new Set<string>();
  const close = (kind: StepKind, label: string) => {
    steps.push({ kind, label, events: current });
    current = [];
    labels = [];
  };
  for (const event of recording.live) {
    const method = event.method;
    // Later stages of an approval and its resolution are played when the visitor decides.
    if (method === "approval/updated" || method === "approval/resolved") continue;
    current.push(event);
    const entry = item(event);
    if (method === "item/completed" && entry?.["kind"] === "userMessage" && steps.length === 0) {
      close("prompt", "Sent the prompt");
    } else if (method === "approval/requested") {
      close("approval", "Muse asks before it runs a command");
    } else if (entry?.["kind"] === "toolCall") {
      const id = String(entry["itemId"]);
      if (method === "item/started") open.add(id);
      if (method === "item/completed") {
        open.delete(id);
        labels.push(toolLabel(entry, recording.cwd));
        if (open.size === 0) close("tool", labels.length > 2 ? `${labels[0]} and ${labels.length - 1} more` : labels.join(", "));
      }
    } else if (method === "item/completed" && entry?.["kind"] === "agentMessage") {
      close("reply", "Muse sums up");
    }
  }
  const last = steps.at(-1);
  if (last && current.length > 0) last.events.push(...current);
  else if (current.length > 0) steps.push({ kind: "reply", label: "Done", events: current });
  return steps;
}

/** How long the run took on the machine it was recorded on, in ms. */
export function runDuration(recording: Recording): number {
  const end = recording.live.find((e) => e.method === "turn/completed");
  const reported = Number(params(end ?? { method: "", params: {} })["durationMs"]);
  if (Number.isFinite(reported) && reported > 0) return reported;
  const first = recording.live.find((e) => e.method === "turn/started");
  return Math.max(0, (end?.at ?? 0) - (first?.at ?? 0));
}

/** How often a turn the visitor has paused says it is still running. The app reloads a turn quiet for 90 s. */
const STILL_RUNNING_MS = 30_000;

export class ReplayClient extends DemoClient {
  readonly sessionId: string;
  readonly steps: ReplayStep[];
  private played = 0;
  private waiting: string | null = null;
  private denied = false;
  private pending: ReturnType<typeof setTimeout>[] = [];
  private queued: ViewEvent[] = [];
  private listeners = new Set<(state: ReplayState) => void>();
  /** The recorded resolution of each approval, played when the visitor decides. */
  private resolutions = new Map<string, ViewEvent>();
  /** A rejected approval comes back under a fresh id, since the app treats a resolved id as settled. */
  private aliases = new Map<string, string>();
  private turnId: string | null = null;
  private stillRunning: ReturnType<typeof setInterval> | null = null;

  constructor(readonly recording: Recording) {
    super();
    this.sessions.clear();
    this.steps = buildSteps(recording);
    this.sessionId = String(params(recording.live[0])["sessionId"] ?? "replay");
    for (const event of recording.live) {
      if (event.method === "approval/resolved") this.resolutions.set(String(params(event)["approvalId"]), event);
    }
    const start = Date.now();
    const entry = {
      summary: { ...summary(this.sessionId, recording.cwd, recording.prompt, start, 0), titleSource: "auto" as const },
      events: [
        {
          method: "session/started",
          params: {
            sessionId: this.sessionId,
            session: {
              sessionId: this.sessionId,
              status: "idle",
              modelId: recording.modelId,
              workspaceRoot: recording.cwd,
              approvalMode: { mode: "onRequest", source: "startup", lastCommandId: null },
              turnCount: 0,
            },
          },
          at: start,
        },
      ] as ViewEvent[],
      approvals: [],
    };
    this.sessions.set(this.sessionId, entry);
  }

  override dispose() {
    super.dispose();
    this.stopStillRunning();
    for (const t of this.pending) clearTimeout(t);
    this.pending = [];
    this.listeners.clear();
  }

  override async listProjects() {
    return [{ cwd: this.recording.cwd, displayName: this.recording.repo, pinned: false, activityAt: new Date().toISOString(), defaultAccountId: null }];
  }

  override async loadTranscript(sessionId: string): Promise<TranscriptLoad> {
    const load = await super.loadTranscript(sessionId);
    return load.msp ? { ...load, msp: { ...load.msp, modelId: this.recording.modelId ?? load.msp.modelId } } : load;
  }

  override async sendTurn(): Promise<{ turnId: string; disposition: string }> {
    throw new Error("This is a replay of a recorded run. Install Helicon to run your own prompt.");
  }

  state(): ReplayState {
    return {
      played: this.played,
      total: this.steps.length,
      waiting: this.waiting !== null,
      denied: this.denied,
      done: this.played >= this.steps.length && this.queued.length === 0,
    };
  }

  onChange(listener: (state: ReplayState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  /**
   * Between steps the turn waits on the visitor, not on a lost stream. Say so the way the server does for a
   * long command, so the app does not reload the turn and then report that the thread stopped.
   */
  private startStillRunning() {
    this.stopStillRunning();
    this.stillRunning = setInterval(() => {
      if (!this.turnId) return;
      for (const h of this.handlers) h({ type: "feed", sessionId: this.sessionId, activeTurnId: this.turnId, at: Date.now() });
    }, STILL_RUNNING_MS);
  }

  private stopStillRunning() {
    if (this.stillRunning !== null) clearInterval(this.stillRunning);
    this.stillRunning = null;
  }

  private send(event: ViewEvent) {
    const p = { ...params(event) };
    const id = p["approvalId"];
    if (typeof id === "string" && this.aliases.has(id)) p["approvalId"] = this.aliases.get(id);
    const entry = item(event);
    if (event.method === "turn/started") {
      this.turnId = String(p["turnId"]);
      this.setLive(this.sessionId, { activeTurnId: this.turnId, turnStartedAt: new Date().toISOString(), pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null });
      this.startStillRunning();
    }
    if (event.method === "session/nameChanged" && typeof p["name"] === "string") {
      const session = this.sessions.get(this.sessionId);
      if (session) session.summary = { ...session.summary, title: p["name"] };
    }
    delete p["sessionId"];
    delete p["viewCursor"];
    this.emit(this.sessionId, event.method, entry ? { ...p, item: { ...entry } } : p);
    if (event.method === "approval/requested") {
      this.waiting = String(p["approvalId"]);
      this.sessions.get(this.sessionId)?.approvals.push({ ...p, sessionId: this.sessionId } as unknown as ApprovalRequest);
      this.setLive(this.sessionId, { activeTurnId: this.turnId, turnStartedAt: new Date().toISOString(), pendingApprovals: 1, pendingInputs: 0, lastTerminal: null, lastError: null });
    }
    if (event.method === "turn/completed") {
      this.stopStillRunning();
      this.setLive(this.sessionId, { activeTurnId: null, turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: "completed", lastError: null });
    }
  }

  /** Plays out whatever the current step still has queued, at once. */
  private flush() {
    for (const t of this.pending) clearTimeout(t);
    this.pending = [];
    const rest = this.queued;
    this.queued = [];
    for (const event of rest) this.send(event);
  }

  /**
   * Plays the next step. Events inside a step keep their recorded order and roughly their rhythm, capped,
   * so a tool call shows its spinner before its result. Returns false when the run is over or waiting.
   */
  next(): boolean {
    this.flush();
    if (this.waiting !== null || this.denied || this.played >= this.steps.length) {
      this.changed();
      return false;
    }
    const step = this.steps[this.played++];
    this.queued = [...step.events];
    let delay = 0;
    let previous = step.events[0]?.at ?? 0;
    for (const event of step.events) {
      delay += Math.min(450, Math.max(0, (event.at ?? previous) - previous));
      previous = event.at ?? previous;
      const t = setTimeout(() => {
        this.pending = this.pending.filter((x) => x !== t);
        const index = this.queued.indexOf(event);
        if (index >= 0) {
          this.queued.splice(index, 1);
          this.send(event);
        }
        if (this.queued.length === 0) this.changed();
      }, delay);
      this.pending.push(t);
    }
    this.changed();
    return true;
  }

  override async decideApproval(input: { sessionId: string; approvalId: string; choiceId: string }) {
    const shown = this.waiting;
    if (shown === null) return;
    const session = this.sessions.get(this.sessionId);
    if (session) session.approvals = [];
    const original = [...this.aliases.entries()].find(([, alias]) => alias === shown)?.[0] ?? shown;
    const request = this.steps.flatMap((s) => s.events).find((e) => e.method === "approval/requested" && params(e)["approvalId"] === original);
    const choices = (params(request ?? { method: "", params: {} })["availableChoices"] ?? []) as { choiceId: string; decision: string }[];
    const decision = choices.find((c) => c.choiceId === input.choiceId)?.decision ?? "approved";
    this.waiting = null;
    if (decision === "abort" || decision === "denied") {
      this.denied = true;
      this.emit(this.sessionId, "approval/resolved", { approvalId: shown, decision: "abort", resolvedBy: "user" });
      this.setLive(this.sessionId, { activeTurnId: this.turnId, turnStartedAt: new Date().toISOString(), pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null });
      this.changed();
      return;
    }
    this.denied = false;
    const resolved = this.resolutions.get(original);
    this.emit(this.sessionId, "approval/resolved", { ...(resolved ? params(resolved) : {}), approvalId: shown, decision: "approved", resolvedBy: "user", sessionId: undefined, viewCursor: undefined });
    this.setLive(this.sessionId, { activeTurnId: this.turnId, turnStartedAt: new Date().toISOString(), pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null });
    // Approving is the visitor's step; the command it allowed runs straight away.
    this.next();
  }

  /** Puts a rejected approval back on screen, so the visitor can approve it after all. */
  askAgain() {
    if (!this.denied) return;
    const step = this.steps[this.played - 1];
    const request = step?.events.find((e) => e.method === "approval/requested");
    if (!request) return;
    const original = String(params(request)["approvalId"]);
    this.aliases.set(original, `${original}-again-${this.aliases.size + 1}`);
    this.denied = false;
    this.send(request);
    this.changed();
  }
}
