import type { MspItem, WorkflowChild } from "../types.js";
import type { ThreadFold } from "./fold.js";

/**
 * What a workflow run tells us about itself. Muse reports the run as one item that is revised as it
 * goes (one real run produced 72 revisions), carrying its children, and a reconciliation payload
 * wrapped in a tag inside `message`. Tokens and cost appear nowhere in any of it, per agent or per
 * run, so nothing here invents them.
 */

/** One agent the workflow fanned out to. */
export interface WorkflowAgent {
  id: string;
  attempt: number;
  /** Muse's own word, `terminal` once it has stopped. */
  status: string | null;
  /** `completed`, `failed`, or null while it is still going. */
  terminal: string | null;
  durationMs: number | null;
  /** Tool calls it made, which only the reconciliation payload reports. */
  toolCalls: number | null;
}

export interface WorkflowView {
  runId: string | null;
  scriptId: string | null;
  /** What started it: `guidanceAuto` when the model chose to, otherwise the caller. */
  trigger: string | null;
  status: string;
  running: boolean;
  /**
   * Stopped by `workflow/pause` (any client, the terminal included). Muse keeps the status
   * `inProgress` and sets `paused: true` on the item, so a paused run is not `running`, but it has
   * not finished either and is still cancellable.
   */
  paused: boolean;
  /** A human line for the row, like "Workflow: model-chosen generated workflow". */
  label: string;
  /** From the tool call that launched it; the run itself never carries it. */
  objective: string | null;
  agents: WorkflowAgent[];
  used: number;
  working: number;
  done: number;
  failed: number;
  /** Across every agent, when the payload reported them. */
  toolCalls: number | null;
  /** The slowest single agent, which is the closest thing to the run's own length. */
  longestMs: number | null;
  /** Every agent's time added up. Larger than the wall clock, since they run together. */
  agentMs: number | null;
  /** The report the run produced, as markdown. */
  summary: string | null;
  summaryStatus: string | null;
  failure: string | null;
  /** The launch token budget, when the run was given one. */
  tokenBudget: number | null;
  admitted: boolean;
  /** Handed to the background, so the thread carried on without waiting for it. */
  deferred: boolean;
}

interface Reconciled {
  agents_activity?: { agent?: string; duration_ms?: number; tool_calls?: number }[];
  final_summary?: { status?: string; summary?: string };
  latest_failure?: unknown;
  launch_admitted?: boolean;
  deferred_to_background?: boolean;
  call_id?: string;
}

const WRAPPER = /<workflow-launch-reconciled>([\s\S]*?)<\/workflow-launch-reconciled>/;

/** Terminal statuses that mean the run did not succeed, matching how the transcript reads items. */
export const TERMINAL_FAILURES = new Set(["failed", "rejected", "cancelled", "timedOut"]);

/** The reconciliation payload Muse tucks inside `message`, or null when there is not one yet. */
export function reconciled(message: string | undefined): Reconciled | null {
  if (!message) {
    return null;
  }
  const inner = WRAPPER.exec(message)?.[1] ?? (message.trim().startsWith("{") ? message : null);
  if (!inner) {
    return null;
  }
  try {
    const parsed = JSON.parse(inner) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Reconciled) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The objective, which lives in the launching tool call rather than the run. Its arguments carry
 * another JSON document as a string, and the key inside has been seen as both `goal` and `objective`.
 */
export function objectiveOf(args: string | undefined): string | null {
  if (!args) {
    return null;
  }
  try {
    const outer = JSON.parse(args) as Record<string, unknown>;
    const inner = typeof outer["args"] === "string" ? (JSON.parse(outer["args"] as string) as Record<string, unknown>) : outer;
    return text(inner["objective"]) ?? text(inner["goal"]) ?? text(inner["task"]);
  } catch {
    return null;
  }
}

/** The tool call a run came from, matched on the call id its own payload reports. */
function launchArgs(fold: ThreadFold | null, callId: string | null): string | undefined {
  if (!fold || !callId) {
    return undefined;
  }
  for (const id of fold.order) {
    const item = fold.items.get(id);
    if (item?.kind === "toolCall" && item.callId === callId && item.args) {
      return item.args;
    }
  }
  return undefined;
}

/**
 * `runTerminal` is the run's own outcome once it has stopped, or null while it is still going.
 * Agents taken from the payload have no status of their own, so they inherit it.
 */
function agentsOf(children: readonly WorkflowChild[], payload: Reconciled | null, runTerminal: string | null): WorkflowAgent[] {
  const activity = new Map<string, { duration_ms?: number; tool_calls?: number }>();
  for (const entry of payload?.agents_activity ?? []) {
    if (entry.agent) {
      activity.set(entry.agent, entry);
    }
  }
  if (children.length === 0) {
    // The payload knows about agents before the run reports children of its own. They carry no
    // status, so a run that has stopped hands them its outcome: without that, a finished workflow
    // shows every agent spinning at nought of N.
    return [...activity].map(([id, entry]) => ({
      id,
      attempt: 1,
      status: runTerminal,
      terminal: runTerminal,
      durationMs: typeof entry.duration_ms === "number" ? entry.duration_ms : null,
      toolCalls: typeof entry.tool_calls === "number" ? entry.tool_calls : null,
    }));
  }
  return children.map((child) => {
    const extra = activity.get(child.childId);
    return {
      id: child.childId,
      attempt: child.attempt,
      status: text(child.status),
      terminal: text(child.terminal),
      durationMs: typeof child.durationMs === "number" ? child.durationMs : (extra?.duration_ms ?? null),
      toolCalls: typeof extra?.tool_calls === "number" ? extra.tool_calls : null,
    };
  });
}

function budgetOf(value: unknown): number | null {
  const total = value && typeof value === "object" ? (value as { total?: unknown }).total : undefined;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null;
}

function sum(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
}

/** Everything the card and the sheet show, from one workflow item and the thread it sits in. */
export function workflowView(item: MspItem, fold: ThreadFold | null): WorkflowView {
  const payload = reconciled(item.message);
  // The pause flag is only ever `true` or absent, and Muse clears it when the run resumes or ends.
  const open = item.status === "inProgress";
  const paused = open && item["paused"] === true;
  const running = open && !paused;
  // A paused run's unreported agents have not finished either, so they get no outcome to inherit.
  const agents = agentsOf(item.children ?? [], payload, open ? null : item.status);
  const durations = agents.map((agent) => agent.durationMs);
  const known = durations.filter((value): value is number => value !== null);
  const failure = text(payload?.latest_failure) ?? text(item.failureReason);
  return {
    runId: text(item["workflowRunId"]),
    scriptId: text(item["scriptId"]),
    trigger: text(item["triggerSource"]),
    status: item.status,
    running,
    paused,
    label: text(item.fallbackText) ?? "Workflow",
    objective: objectiveOf(launchArgs(fold, text(payload?.call_id))),
    agents,
    used: agents.length,
    working: agents.filter((agent) => !agent.terminal).length,
    done: agents.filter((agent) => agent.terminal === "completed").length,
    failed: agents.filter((agent) => agent.terminal && agent.terminal !== "completed").length,
    toolCalls: sum(agents.map((agent) => agent.toolCalls)),
    longestMs: known.length > 0 ? Math.max(...known) : null,
    agentMs: sum(durations),
    summary: text(payload?.final_summary?.summary),
    summaryStatus: text(payload?.final_summary?.status),
    failure,
    tokenBudget: budgetOf(item["tokenBudget"]),
    admitted: payload?.launch_admitted === true,
    deferred: payload?.deferred_to_background === true,
  };
}
