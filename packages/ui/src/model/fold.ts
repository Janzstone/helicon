import type {
  ApprovalMode,
  ApprovalRequest,
  ContextUsage,
  Goal,
  MspItem,
  SessionSummary,
  TodoItem,
  TokenTotals,
  TranscriptLoad,
  UserInputAnswer,
  UserInputRequest,
  ViewEvent,
} from "../types.js";

/**
 * The per-thread fold of the MSP view stream. Pure and immutable: every apply returns a new
 * object (or the same one when nothing changed), so React can compare by reference.
 */

export interface TurnInfo {
  turnId: string;
  startedAt?: number;
  completedAt?: number;
  terminal?: string;
  durationMs?: number;
  /** Time to the first streamed token, when the host measured it. */
  firstTokenMs?: number;
  /** The model text streaming in right now, for a live speed estimate. A pause starts a new burst. */
  stream?: { chars: number; startAt: number; lastAt: number };
  error?: { kind: string; message: string; retryable: boolean };
  /** The user acted on the failure notice, so the transcript stops showing it. */
  dismissed?: boolean;
  retry?: { attempt: number; maxAttempts: number; nextAttempt: number; reason: string; retryDelayMs: number };
  retracted?: boolean;
}

/** A prompt the user sent that the stream has not echoed back yet. */
/** A file going out with a prompt that has not landed yet; `url` is a local object URL while it is in flight. */
export interface EchoAttachment {
  name: string;
  mediaType: string;
  kind: "image" | "file";
  url: string | null;
}

export interface LocalEcho {
  localId: string;
  text: string;
  turnId: string | null;
  disposition: "sending" | "started" | "queued" | "steered";
  createdAt: number;
  attachments?: EchoAttachment[];
}

/** One model call's usage, from its `session/tokenUsage` event. */
export interface CallUsage {
  turnId: string | null;
  modelId: string | null;
  /** Prompt tokens counted once under the provider's cache convention. */
  promptTokens: number;
  outputTokens: number;
  inputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number | null;
}

export interface ThreadMeta {
  todoList: TodoItem[] | null;
  branch: string | null;
  contextUsage: ContextUsage | null;
  tokenTotals: TokenTotals | null;
  /** Every model call's usage, keyed by view cursor so a reloaded history never counts one twice. */
  calls: Record<string, CallUsage>;
  modelId: string | null;
  approvalMode: ApprovalMode | null;
  goal: Goal | null;
  /** A goal change arrived, so a null goal means cleared rather than never set. */
  goalSeen: boolean;
  /** When the current objective first appeared live; the goal record's own start time is preferred. */
  goalSince: number | null;
  /** When the goal's status last changed live, so a paused or finished goal's clock stops there. */
  goalStatusAt: number | null;
  /** Stretches the goal spent paused or blocked, seen live; its running time and counts leave them out. */
  goalPauses: { from: number; to: number | null }[];
}


const ITEM_SHARDS = 256;

function shardOf(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) % ITEM_SHARDS;
}

type ItemShard = ReadonlyMap<string, MspItem>;

/**
 * A thread's items, keyed by id. Immutable: a write makes a new store that shares every shard it did not touch.
 * A plain object would be copied whole for every batch, and spreading an object of thousands of keys is slow enough
 * that a long thread's live stream outran it and the view froze (#32).
 */
export class ItemStore {
  static readonly empty = new ItemStore(new Array<ItemShard | undefined>(ITEM_SHARDS).fill(undefined), 0);

  constructor(
    readonly shards: readonly (ItemShard | undefined)[],
    readonly size: number,
  ) {}

  get(id: string): MspItem | undefined {
    return this.shards[shardOf(id)]?.get(id);
  }

  values(): MspItem[] {
    const all: MspItem[] = [];
    for (const shard of this.shards) {
      if (shard) {
        for (const item of shard.values()) {
          all.push(item);
        }
      }
    }
    return all;
  }
}

export interface ThreadFold {
  items: ItemStore;
  /** Item ids in first-opened order. */
  order: string[];
  turns: Record<string, TurnInfo>;
  activeTurnId: string | null;
  /** Pending approvals and questions for this thread, keyed by id. */
  approvals: Record<string, ApprovalRequest>;
  userInputs: Record<string, UserInputRequest>;
  /** `stage` is the requirement index that was decided, so a later stage of a piped command can still ask. */
  resolved: Record<string, { decision: string; resolvedBy: string; stage?: number }>;
  /** Approvals the auto-reviewer holds (`approval/reviewing`): nothing to decide until it releases or settles them. */
  reviewing: Record<string, true>;
  settled: Record<string, { outcome: string; answers: UserInputAnswer[] }>;
  echoes: LocalEcho[];
  meta: ThreadMeta;
  /** The host unloaded the session; the next command must resume it first. */
  closed: boolean;
}

// Kinds added in Muse 1.4.11 and 1.4.12 are hidden until the UI has a design for them. Shown as generic rows, a trailing one would move a turn's final reply into the work log.
// Muse 1.4.20 adds `subagentInput`, `subagentResult` and `bodyCompletion`. They echo what the subagent and background-command rows already show.
export const HIDDEN_KINDS: ReadonlySet<string> = new Set([
  "reminderChild",
  "damagedRange",
  "scheduledFire",
  "overdueNotice",
  "subagentInput",
  "subagentResult",
  "bodyCompletion",
]);

/** Kinds that report on earlier work and can land after a turn's reply. They don't stop that reply being the turn's final one. */
export const NOTICE_KINDS: ReadonlySet<string> = new Set(["backgroundTerminalCompletion", "peerMessage", "systemNotice"]);

export function emptyFold(): ThreadFold {
  return {
    items: ItemStore.empty,
    order: [],
    turns: {},
    activeTurnId: null,
    approvals: {},
    userInputs: {},
    resolved: {},
    reviewing: {},
    settled: {},
    echoes: [],
    meta: {
      todoList: null,
      branch: null,
      contextUsage: null,
      tokenTotals: null,
      calls: {},
      modelId: null,
      approvalMode: null,
      goal: null,
      goalSeen: false,
      goalSince: null,
      goalStatusAt: null,
      goalPauses: [],
    },
    closed: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The stage index of an approval's current requirement (`currentRequirementId.sourceIndex`), if it has one. */
export function requirementIndex(request: unknown): number | undefined {
  const requirement = (request as { currentRequirementId?: unknown } | undefined)?.currentRequirementId;
  return typeof requirement === "object" && requirement !== null ? numberOr((requirement as { sourceIndex?: unknown }).sourceIndex) : undefined;
}

/**
 * A piped command asks once per stage under one approval id. Deciding stage 0 marks the id resolved, so a request
 * for a later stage clears that mark. A redelivered request for the stage already decided stays resolved.
 */
function reopenForLaterStage(resolved: ThreadFold["resolved"], id: string, request: unknown): void {
  const decided = resolved[id]?.stage;
  const stage = requirementIndex(request);
  if (decided !== undefined && stage !== undefined && stage > decided) {
    delete resolved[id];
  }
}

/** A goal block from `session/goalChanged`, or null when it is not one. Odd field types fall back to safe values. */
function asGoal(value: unknown): Goal | null {
  const record = asRecord(value);
  const objective = record ? str(record["objective"]) : null;
  if (!record || !objective) {
    return null;
  }
  return {
    objective,
    status: str(record["status"]) ?? "active",
    percentComplete: numberOr(record["percentComplete"]) ?? 0,
    currentWork: str(record["currentWork"]) ?? undefined,
    nextWork: str(record["nextWork"]) ?? undefined,
  };
}

function asItem(value: unknown): MspItem | null {
  const record = asRecord(value);
  if (!record || typeof record["itemId"] !== "string" || typeof record["kind"] !== "string") {
    return null;
  }
  return {
    ...record,
    status: typeof record["status"] === "string" ? record["status"] : "completed",
    revision: typeof record["revision"] === "number" ? record["revision"] : 1,
  } as MspItem;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "allowAll" || value === "denyUnmatched" || value === "onRequest" || value === "promptUnmatched";
}

/** Mutable working copy used inside one batch; collections are copied once, on first write. */
/** Which of the fold's maps a batch of events can write to, so the rest are shared rather than copied. */
interface Touched {
  turns: boolean;
  approvals: boolean;
  userInputs: boolean;
}

/** What each event method writes to. An unknown method copies nothing, because it changes nothing here either. */
function touchedBy(events: readonly ViewEvent[]): Touched {
  const touches: Touched = { turns: false, approvals: false, userInputs: false };
  for (const event of events) {
    const method = event.method;
    if (method.startsWith("item/")) {
      // A delta's characters count towards its turn's streaming speed.
      touches.turns = true;
    } else if (method.startsWith("turn/")) {
      touches.turns = true;
      // A finished turn ends any auto-review hold that never got its own resolve.
      touches.approvals ||= method === "turn/completed";
    } else if (method.startsWith("approval/")) {
      touches.approvals = true;
    } else if (method.startsWith("userInput/")) {
      touches.userInputs = true;
    }
  }
  return touches;
}

class Draft {
  fold: ThreadFold;
  private orderCopied = false;
  private echoesCopied = false;
  private callsCopied = false;
  private shards: (ItemShard | undefined)[] | null = null;
  private ownShards = new Set<number>();
  private size = 0;

  /**
   * Only the maps this batch can write to are copied. A long thread holds tens of thousands of items, and copying
   * every map for every batch made applying a stream cost time in the square of the thread's length: a thread with
   * subagents in it, which produce far more items than anything else, would slow to a stop and never recover.
   */
  constructor(base: ThreadFold, touches: Touched) {
    this.fold = {
      ...base,
      ...(touches.turns ? { turns: { ...base.turns } } : {}),
      ...(touches.approvals ? { approvals: { ...base.approvals }, resolved: { ...base.resolved }, reviewing: { ...base.reviewing } } : {}),
      ...(touches.userInputs ? { userInputs: { ...base.userInputs }, settled: { ...base.settled } } : {}),
      // Small, and nearly every event reads or writes something in it.
      meta: { ...base.meta },
    };
  }

  getItem(id: string): MspItem | undefined {
    return (this.shards ?? this.fold.items.shards)[shardOf(id)]?.get(id);
  }

  /** Items are stored by shard and a batch copies only the shards it writes to, however long the thread is. */
  setItem(id: string, item: MspItem): void {
    if (!this.shards) {
      this.shards = [...this.fold.items.shards];
      this.size = this.fold.items.size;
    }
    const index = shardOf(id);
    let shard = this.shards[index] as Map<string, MspItem> | undefined;
    if (!this.ownShards.has(index)) {
      shard = new Map(shard);
      this.shards[index] = shard;
      this.ownShards.add(index);
    }
    if (!shard!.has(id)) {
      this.size += 1;
    }
    shard!.set(id, item);
  }

  /** The folded result, with the items written during the batch. */
  finish(): ThreadFold {
    if (this.shards) {
      this.fold.items = new ItemStore(this.shards, this.size);
    }
    return this.fold;
  }

  pushOrder(id: string): void {
    if (!this.orderCopied) {
      this.fold.order = [...this.fold.order];
      this.orderCopied = true;
    }
    this.fold.order.push(id);
  }

  removeEcho(index: number): void {
    if (!this.echoesCopied) {
      this.fold.echoes = [...this.fold.echoes];
      this.echoesCopied = true;
    }
    this.fold.echoes.splice(index, 1);
  }

  patchEcho(index: number, patch: Partial<LocalEcho>): void {
    if (!this.echoesCopied) {
      this.fold.echoes = [...this.fold.echoes];
      this.echoesCopied = true;
    }
    this.fold.echoes[index] = { ...(this.fold.echoes[index] as LocalEcho), ...patch };
  }

  putCall(key: string, call: CallUsage): void {
    if (!this.callsCopied) {
      this.fold.meta.calls = { ...this.fold.meta.calls };
      this.callsCopied = true;
    }
    this.fold.meta.calls[key] = call;
  }
}

function upsertItem(draft: Draft, incoming: MspItem): void {
  const d = draft.fold;
  // Subagent children are never rendered, and a plan that runs subagents produces far more of them than of anything
  // else. Keeping them would grow the fold without ever showing a line of it, and every later event pays for that.
  if (HIDDEN_KINDS.has(incoming.kind)) {
    return;
  }
  const current = draft.getItem(incoming.itemId);
  if (!current) {
    draft.setItem(incoming.itemId, incoming);
    draft.pushOrder(incoming.itemId);
    if (incoming.kind === "userMessage") {
      matchEcho(draft, incoming);
    }
    return;
  }
  const currentDone = current.status !== "inProgress";
  const incomingDone = incoming.status !== "inProgress";
  const newer =
    incoming.revision > current.revision ||
    current.revision === 0 ||
    (incoming.revision === current.revision && incomingDone && !currentDone);
  if (!newer) {
    return;
  }
  const next: MspItem = { ...incoming };
  // A final that arrives empty keeps what already streamed in.
  if (!next.text && current.text) {
    next.text = current.text;
  }
  if (!next.visibleOutput && current.visibleOutput) {
    next.visibleOutput = current.visibleOutput;
  }
  if ((!next.summary || next.summary.length === 0) && current.summary && current.summary.length > 0) {
    next.summary = current.summary;
  }
  if (next.turnId === undefined && current.turnId !== undefined) {
    next.turnId = current.turnId;
  }
  draft.setItem(incoming.itemId, next);
  // A later revision can bring the shown text (`displayText`) the first one lacked, so match again.
  if (next.kind === "userMessage") {
    matchEcho(draft, next);
  }
}

/** Both forms of a prompt: what the transcript shows and what the model got; a local echo holds one of them. */
function promptTexts(item: MspItem): Set<string> {
  return new Set([item.displayText, item.text].filter((t): t is string => Boolean(t)).map((t) => normalizeText(t)));
}

function matchEcho(draft: Draft, item: MspItem): void {
  const echoes = draft.fold.echoes;
  if (echoes.length === 0) {
    return;
  }
  const texts = promptTexts(item);
  let index = echoes.findIndex(
    (e) => e.turnId !== null && (e.turnId === item.turnId || e.turnId === item.commandId) && texts.has(normalizeText(e.text)),
  );
  if (index < 0) {
    index = echoes.findIndex((e) => texts.has(normalizeText(e.text)));
  }
  if (index >= 0) {
    draft.removeEcho(index);
  }
}

function appendDelta(draft: Draft, params: Record<string, unknown>): void {
  const d = draft.fold;
  const id = str(params["itemId"]);
  const delta = typeof params["delta"] === "string" ? params["delta"] : "";
  if (!id || !delta) {
    return;
  }
  const field = str(params["field"]) ?? "text";
  let item = draft.getItem(id);
  if (!item) {
    item = {
      itemId: id,
      kind: field === "output" ? "toolCall" : field.startsWith("summary") ? "reasoning" : "agentMessage",
      status: "inProgress",
      revision: 0,
    };
    draft.pushOrder(id);
  } else if (item.status !== "inProgress") {
    // The authoritative final already landed; a late delta would duplicate text.
    return;
  }
  const next: MspItem = { ...item };
  if (field === "text") {
    next.text = (next.text ?? "") + delta;
  } else if (field === "output") {
    next.visibleOutput = (next.visibleOutput ?? "") + delta;
  } else if (field.startsWith("summary.")) {
    const index = Number(field.slice("summary.".length));
    if (Number.isInteger(index) && index >= 0) {
      const summary = [...(next.summary ?? [])];
      while (summary.length < index) {
        summary.push("");
      }
      summary[index] = (summary[index] ?? "") + delta;
      next.summary = summary;
    }
  } else {
    const previous = next[field];
    next[field] = (typeof previous === "string" ? previous : "") + delta;
  }
  draft.setItem(id, next);
}

/** A pause longer than this between text chunks means a new model call, so its speed is measured afresh. */
const STREAM_GAP_MS = 2000;

/** Counts streamed model text (replies and reasoning, not tool output) per turn, in bursts. */
function trackStream(draft: Draft, params: Record<string, unknown>, at: number | undefined): void {
  const field = str(params["field"]) ?? "text";
  const delta = typeof params["delta"] === "string" ? params["delta"] : "";
  if (at === undefined || !delta || field === "output") {
    return;
  }
  const d = draft.fold;
  const itemId = str(params["itemId"]);
  const turnId = str(params["turnId"]) ?? (itemId ? (draft.getItem(itemId)?.turnId ?? null) : null);
  if (!turnId) {
    return;
  }
  const turn = d.turns[turnId] ?? { turnId };
  const previous = turn.stream && at - turn.stream.lastAt <= STREAM_GAP_MS ? turn.stream : { chars: 0, startAt: at, lastAt: at };
  d.turns[turnId] = { ...turn, stream: { chars: previous.chars + delta.length, startAt: previous.startAt, lastAt: at } };
}

function applyOne(draft: Draft, event: ViewEvent): void {
  const d = draft.fold;
  const params = event.params;
  switch (event.method) {
    case "item/started":
    case "item/updated":
    case "item/completed": {
      const item = asItem(params["item"]);
      if (item) {
        upsertItem(draft, item);
      }
      break;
    }
    case "item/delta":
      appendDelta(draft, params);
      trackStream(draft, params, event.at);
      break;
    case "turn/started": {
      const turnId = str(params["turnId"]);
      if (!turnId) {
        break;
      }
      const previous = d.turns[turnId];
      d.turns[turnId] = { ...previous, turnId, startedAt: previous?.startedAt ?? event.at };
      if (!previous?.terminal) {
        d.activeTurnId = turnId;
      }
      d.closed = false;
      const echo = d.echoes.findIndex((e) => e.turnId === turnId && e.disposition === "queued");
      if (echo >= 0) {
        draft.patchEcho(echo, { disposition: "started" });
      }
      break;
    }
    case "turn/completed": {
      const turnId = str(params["turnId"]);
      if (!turnId) {
        break;
      }
      for (const id of Object.keys(d.reviewing)) {
        delete d.reviewing[id];
      }
      const error = asRecord(params["error"]);
      d.turns[turnId] = {
        ...d.turns[turnId],
        turnId,
        terminal: str(params["terminal"]) ?? "completed",
        durationMs: numberOr(params["durationMs"]) ?? d.turns[turnId]?.durationMs,
        firstTokenMs: numberOr(params["timeToFirstTokenMs"]) ?? d.turns[turnId]?.firstTokenMs,
        completedAt: event.at ?? d.turns[turnId]?.completedAt,
        error: error
          ? {
              kind: str(error["kind"]) ?? "error",
              message: str(error["message"]) ?? "The turn failed.",
              retryable: error["retryable"] === true,
            }
          : undefined,
        retry: undefined,
      };
      if (d.activeTurnId === turnId) {
        d.activeTurnId = null;
      }
      // The turn is over, so its local copy has done its job: the prompt is either in the transcript or it
      // never will be. Keeping it would leave a bubble stuck on "Sending" for the rest of the thread.
      const echo = d.echoes.findIndex((e) => e.turnId === turnId);
      if (echo >= 0) {
        draft.removeEcho(echo);
      }
      break;
    }
    case "turn/retryScheduled": {
      const turnId = str(params["turnId"]);
      if (turnId) {
        d.turns[turnId] = {
          ...d.turns[turnId],
          turnId,
          retry: {
            attempt: numberOr(params["attempt"]) ?? 1,
            maxAttempts: numberOr(params["maxAttempts"]) ?? 1,
            nextAttempt: numberOr(params["nextAttempt"]) ?? 2,
            reason: str(params["reason"]) ?? "",
            retryDelayMs: numberOr(params["retryDelayMs"]) ?? 0,
          },
        };
      }
      break;
    }
    case "turn/retracted": {
      const turnId = str(params["turnId"]);
      // Muse 1.4.10 also reports a retract it declined; the prompt stood, so the turn is unchanged.
      // An absent or unknown outcome means accepted, as older hosts only sent accepted retracts.
      if (turnId && params["outcome"] !== "declined") {
        d.turns[turnId] = { ...d.turns[turnId], turnId, retracted: true };
      }
      break;
    }
    case "turn/unqueued": {
      const turnId = str(params["turnId"]);
      if (turnId) {
        d.turns[turnId] = { ...d.turns[turnId], turnId, terminal: "unqueued" };
        const echo = d.echoes.findIndex((e) => e.turnId === turnId);
        if (echo >= 0) {
          draft.removeEcho(echo);
        }
      }
      break;
    }
    case "approval/reviewing": {
      const id = str(params["approvalId"]);
      if (id) {
        reopenForLaterStage(d.resolved, id, params);
      }
      if (id && !d.resolved[id] && !d.approvals[id]) {
        d.reviewing[id] = true;
      }
      break;
    }
    case "approval/requested":
    case "approval/updated": {
      const id = str(params["approvalId"]);
      if (id) {
        reopenForLaterStage(d.resolved, id, params);
      }
      const pending = id ? requirementIndex(d.approvals[id]) : undefined;
      const incoming = requirementIndex(params);
      const stale = pending !== undefined && incoming !== undefined && incoming < pending;
      if (id && !d.resolved[id] && !stale) {
        delete d.reviewing[id];
        d.approvals[id] = { ...d.approvals[id], ...(params as unknown as ApprovalRequest) };
      }
      break;
    }
    case "approval/resolved": {
      const id = str(params["approvalId"]);
      if (id) {
        const stage = requirementIndex(params) ?? requirementIndex(d.approvals[id]) ?? d.resolved[id]?.stage;
        delete d.approvals[id];
        delete d.reviewing[id];
        d.resolved[id] = {
          decision: str(params["decision"]) ?? "resolved",
          resolvedBy: str(params["resolvedBy"]) ?? "user",
          ...(stage !== undefined ? { stage } : {}),
        };
      }
      break;
    }
    case "userInput/requested": {
      const id = str(params["userInputId"]);
      if (id && !d.settled[id]) {
        d.userInputs[id] = params as unknown as UserInputRequest;
      }
      break;
    }
    case "userInput/settled": {
      const id = str(params["userInputId"]);
      if (id) {
        delete d.userInputs[id];
        d.settled[id] = {
          outcome: str(params["outcome"]) ?? "answered",
          answers: Array.isArray(params["answers"]) ? (params["answers"] as UserInputAnswer[]) : [],
        };
      }
      break;
    }
    case "session/todoListChanged":
      d.meta.todoList = Array.isArray(params["items"]) ? (params["items"] as TodoItem[]) : [];
      break;
    case "session/branchChanged":
      d.meta.branch = str(params["branch"]);
      break;
    case "session/contextUsage":
      d.meta.contextUsage = {
        usedTokens: numberOr(params["usedTokens"]) ?? 0,
        windowTokens: numberOr(params["windowTokens"]),
        pressure: str(params["pressure"]) ?? "normal",
      };
      break;
    case "session/tokenUsage": {
      const cumulative = asRecord(params["cumulative"]);
      if (cumulative) {
        d.meta.tokenTotals = {
          promptTokens: numberOr(cumulative["promptTokens"]) ?? 0,
          outputTokens: numberOr(cumulative["outputTokens"]) ?? 0,
          totalTokens: numberOr(cumulative["totalTokens"]) ?? 0,
        };
      }
      const usage = asRecord(params["usage"]) ?? {};
      const promptTokens = numberOr(params["promptTokens"]) ?? numberOr(usage["inputTokens"]) ?? 0;
      const key = str(params["viewCursor"]) ?? `${str(params["turnId"]) ?? "turn"}:${Object.keys(d.meta.calls).length}`;
      draft.putCall(key, {
        turnId: str(params["turnId"]),
        modelId: str(params["modelId"]),
        promptTokens,
        outputTokens: numberOr(usage["outputTokens"]) ?? Math.max(0, (numberOr(params["totalTokens"]) ?? 0) - promptTokens),
        inputTokens: numberOr(usage["inputTokens"]) ?? 0,
        cachedTokens: numberOr(usage["cachedTokens"]) ?? 0,
        cacheReadTokens: numberOr(usage["cacheReadTokens"]) ?? 0,
        cacheWriteTokens: numberOr(usage["cacheWriteTokens"]) ?? 0,
        reasoningTokens: numberOr(usage["reasoningTokens"]) ?? 0,
        durationMs: numberOr(params["durationMs"]) ?? null,
      });
      break;
    }
    case "session/modelChanged":
      d.meta.modelId = str(params["modelId"]) ?? d.meta.modelId;
      break;
    case "session/approvalModeChanged":
      if (isApprovalMode(params["mode"])) {
        d.meta.approvalMode = params["mode"];
      }
      break;
    case "session/goalChanged": {
      const raw = params["goal"];
      const next = asGoal(raw);
      // A block that is there but is not a goal (no objective) changes nothing; only null clears.
      if (raw !== null && raw !== undefined && !next) {
        break;
      }
      const prev = d.meta.goal;
      const same = next !== null && prev !== null && next.objective === prev.objective;
      // A new objective restarts the live clock; the goal record's own start time wins when there is one.
      if (!same) {
        d.meta.goalSince = next ? (event.at ?? null) : null;
        d.meta.goalPauses = [];
      }
      // A pause or finish stops the goal's clock at this moment; history carries no time, so it stays unknown there.
      if (!same || next?.status !== prev?.status) {
        d.meta.goalStatusAt = next ? (event.at ?? null) : null;
      }
      // Time paused or blocked is not running time: a live change marks where each pause began and ended.
      if (same && next && prev && event.at !== undefined && next.status !== prev.status) {
        const pauses = d.meta.goalPauses;
        const open = pauses[pauses.length - 1];
        if (prev.status === "active") {
          d.meta.goalPauses = [...pauses, { from: event.at, to: null }];
        } else if (next.status === "active" && open && open.to === null) {
          d.meta.goalPauses = [...pauses.slice(0, -1), { from: open.from, to: event.at }];
        }
      }
      d.meta.goal = next;
      d.meta.goalSeen = true;
      break;
    }
    case "session/started": {
      const session = asRecord(params["session"]);
      if (session) {
        d.meta.modelId = str(session["modelId"]) ?? d.meta.modelId;
        const mode = asRecord(session["approvalMode"])?.["mode"];
        if (isApprovalMode(mode)) {
          d.meta.approvalMode = mode;
        }
      }
      d.closed = false;
      break;
    }
    case "session/closed":
      d.closed = true;
      d.activeTurnId = null;
      break;
    default:
      break;
  }
}

/** Apply a batch of view events. Returns the input fold untouched when the batch is empty. */
/** Every method `applyOne` handles. Anything else, such as a notification a newer Muse added, leaves the fold as it was. */
const FOLDED_METHODS: ReadonlySet<string> = new Set([
  "item/started", "item/updated", "item/completed", "item/delta",
  "turn/started", "turn/completed", "turn/retryScheduled", "turn/retracted", "turn/unqueued",
  "approval/reviewing", "approval/requested", "approval/updated", "approval/resolved",
  "userInput/requested", "userInput/settled",
  "session/todoListChanged", "session/branchChanged", "session/contextUsage", "session/tokenUsage",
  "session/modelChanged", "session/approvalModeChanged", "session/goalChanged", "session/started", "session/closed",
]);

export function applyEvents(fold: ThreadFold, events: readonly ViewEvent[]): ThreadFold {
  // Copying the fold for an event it ignores would hand React a new object and rerender the transcript for nothing.
  const folded = events.filter((event) => FOLDED_METHODS.has(event.method));
  if (folded.length === 0) {
    return fold;
  }
  const draft = new Draft(fold, touchedBy(folded));
  for (const event of folded) {
    applyOne(draft, event);
  }
  return draft.finish();
}

export function applyEvent(fold: ThreadFold, event: ViewEvent): ThreadFold {
  return applyEvents(fold, [event]);
}

/**
 * The local echoes worth keeping across a reload. History is replayed onto an empty fold, so nothing
 * in it clears an echo the way the live stream would, and an echo whose prompt the history already
 * holds used to render alongside it (#55). Only echoes the server acknowledged with a turn id are
 * matched: an unacknowledged one could otherwise pair with an older prompt that shares its text, the
 * way a second "continue" would, and vanish while still in flight.
 */
function carriedEchoes(fold: ThreadFold, echoes: readonly LocalEcho[]): LocalEcho[] {
  const kept: LocalEcho[] = [];
  for (const echo of echoes) {
    const turnId = echo.turnId;
    if (!turnId) {
      kept.push(echo);
      continue;
    }
    if (fold.turns[turnId]?.terminal) {
      continue;
    }
    const text = normalizeText(echo.text);
    const landed = fold.order.some((id) => {
      const item = fold.items.get(id);
      return item?.kind === "userMessage" && (item.turnId === turnId || item.commandId === turnId) && promptTexts(item).has(text);
    });
    if (landed) {
      continue;
    }
    // A queued prompt whose turn history shows started is running now, as the live stream would have said.
    kept.push(echo.disposition === "queued" && fold.turns[turnId] ? { ...echo, disposition: "started" } : echo);
  }
  return kept;
}

/** Build a fold from a resume response; the server's pending set is authoritative. */
export function foldFromLoad(load: TranscriptLoad, previous?: ThreadFold | null): ThreadFold {
  let fold = applyEvents(emptyFold(), load.events);
  const approvals: Record<string, ApprovalRequest> = {};
  for (const approval of load.pending.approvals) {
    approvals[approval.approvalId] = approval;
  }
  const userInputs: Record<string, UserInputRequest> = {};
  for (const input of load.pending.userInputs) {
    userInputs[input.userInputId] = input;
  }
  // A hold the server already lists as pending was released while we were away.
  const reviewing: Record<string, true> = {};
  for (const id of Object.keys(fold.reviewing)) {
    if (!approvals[id]) {
      reviewing[id] = true;
    }
  }
  fold = {
    ...fold,
    approvals,
    reviewing,
    userInputs,
    activeTurnId: load.msp ? load.msp.activeTurnId : fold.activeTurnId,
    echoes: carriedEchoes(fold, previous?.echoes ?? []),
    meta: {
      ...fold.meta,
      // History pages carry no context readings; the session's own fill in until the next live one.
      contextUsage:
        fold.meta.contextUsage ?? (typeof load.msp?.contextUsage?.usedTokens === "number" ? load.msp.contextUsage : null),
      tokenTotals: fold.meta.tokenTotals ?? (typeof load.msp?.tokenUsage?.totalTokens === "number" ? load.msp.tokenUsage : null),
      modelId: fold.meta.modelId ?? load.msp?.modelId ?? load.session?.modelId ?? null,
      approvalMode: fold.meta.approvalMode ?? (isApprovalMode(load.msp?.approvalMode) ? load.msp.approvalMode : null),
    },
    closed: false,
  };
  return fold;
}

export function addEcho(fold: ThreadFold, echo: LocalEcho): ThreadFold {
  return { ...fold, echoes: [...fold.echoes, echo] };
}

export function updateEcho(fold: ThreadFold, localId: string, patch: Partial<LocalEcho>): ThreadFold {
  const index = fold.echoes.findIndex((e) => e.localId === localId);
  if (index < 0) {
    return fold;
  }
  // If the stream already echoed this prompt back, the local copy is done.
  if (patch.turnId && patch.disposition !== "queued") {
    const echo = fold.echoes[index] as LocalEcho;
    const landed = fold.order.some((id) => {
      const item = fold.items.get(id);
      return (
        item?.kind === "userMessage" &&
        (item.turnId === patch.turnId || item.commandId === patch.turnId) &&
        promptTexts(item).has(normalizeText(echo.text))
      );
    });
    if (landed) {
      return removeEcho(fold, localId);
    }
  }
  const echoes = [...fold.echoes];
  echoes[index] = { ...(echoes[index] as LocalEcho), ...patch };
  return { ...fold, echoes };
}

export function removeEcho(fold: ThreadFold, localId: string): ThreadFold {
  const echoes = fold.echoes.filter((e) => e.localId !== localId);
  return echoes.length === fold.echoes.length ? fold : { ...fold, echoes };
}

/** One turn as the transcript renders it. */
export interface TurnView {
  key: string;
  turnId: string | null;
  prompt: MspItem | null;
  /** Everything between the prompt and the final reply, in stream order. */
  entries: MspItem[];
  /** The closing agent message of a finished turn, shown outside the work log. */
  final: MspItem | null;
  /** Notices that landed after the final reply, shown below it. Empty unless `final` is set. */
  after: MspItem[];
  info: TurnInfo | null;
  running: boolean;
}

/**
 * The turns a side chat carries over from its thread. Muse builds a side chat as a fork: the
 * thread's turns come along as reference for the model, then the side chat's own turns start.
 * Anything recorded before the side chat was opened (`since`) is the thread's, not the side chat's.
 * Both times come from Muse (item record times, session creation), so the client clock plays no part.
 */
export function inheritedTurns(fold: ThreadFold, since: number | null): Set<string> {
  const inherited = new Set<string>();
  if (since === null || !Number.isFinite(since)) {
    return inherited;
  }
  for (const id of fold.order) {
    const item = fold.items.get(id);
    const at = item?.recordedAt ? Date.parse(item.recordedAt) : Number.NaN;
    if (item?.turnId && at < since) {
      inherited.add(item.turnId);
    }
  }
  return inherited;
}

/** When a side chat was opened, which is where its own turns begin; null for any other thread. */
export function sideStart(session: Pick<SessionSummary, "sideOf" | "createdAt"> | undefined): number | null {
  if (!session?.sideOf) {
    return null;
  }
  const at = Date.parse(session.createdAt);
  return Number.isNaN(at) ? null : at;
}

export function buildTurns(fold: ThreadFold, inherited: ReadonlySet<string> = new Set()): TurnView[] {
  const byKey = new Map<string, TurnView>();
  const views: TurnView[] = [];
  for (const id of fold.order) {
    const item = fold.items.get(id);
    if (!item || HIDDEN_KINDS.has(item.kind) || (item.kind === "userMessage" && item.retracted)) {
      continue;
    }
    if (item.turnId && inherited.has(item.turnId)) {
      continue;
    }
    const key = item.turnId ? `turn:${item.turnId}` : `item:${id}`;
    let view = byKey.get(key);
    if (!view) {
      view = {
        key,
        turnId: item.turnId ?? null,
        prompt: null,
        entries: [],
        final: null,
        after: [],
        info: item.turnId ? (fold.turns[item.turnId] ?? null) : null,
        running: item.turnId ? fold.activeTurnId === item.turnId : false,
      };
      byKey.set(key, view);
      views.push(view);
    }
    if (item.kind === "userMessage" && !item.steered && !view.prompt) {
      view.prompt = item;
    } else {
      view.entries.push(item);
    }
  }
  for (const view of views) {
    if (view.running) {
      continue;
    }
    let end = view.entries.length;
    while (end > 0 && NOTICE_KINDS.has(view.entries[end - 1]!.kind)) {
      end -= 1;
    }
    const last = view.entries[end - 1];
    if (last && last.kind === "agentMessage" && (last.text ?? "").trim().length > 0) {
      view.final = last;
      view.after = view.entries.slice(end);
      view.entries = view.entries.slice(0, end - 1);
    }
  }
  return views.filter((view) => !isMirroredPrefix(view.info));
}

/** The thread's most recent prompt as the user wrote it, for Up in an empty composer. A prompt still sending counts. */
export function lastPrompt(fold: ThreadFold): string | null {
  for (let i = fold.echoes.length - 1; i >= 0; i -= 1) {
    const text = fold.echoes[i]!.text;
    if (text.trim()) {
      return text;
    }
  }
  const said = (item: MspItem | null | undefined) => item?.displayText ?? item?.text ?? "";
  const turns = buildTurns(fold);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    // A message steered into a running turn came after the prompt that started it.
    for (let j = turn.entries.length - 1; j >= 0; j -= 1) {
      const entry = turn.entries[j]!;
      if (entry.kind === "userMessage" && said(entry).trim()) {
        return said(entry);
      }
    }
    if (said(turn.prompt).trim()) {
      return said(turn.prompt);
    }
  }
  return null;
}

/**
 * Muse 1.4.4 seeds a new side chat with copies of its thread's turns, each one failed with this
 * reason, though a side chat is meant to open empty (Muse #49416). They are not the side chat's own
 * turns, and retrying one re-sends the thread's prompt, so the transcript leaves them out.
 */
export function isMirroredPrefix(info: TurnInfo | null): boolean {
  return info?.terminal === "failed" && /mirrored from the exact prefix/i.test(info.error?.message ?? "");
}

/** The pending approval or question that gates a given tool item, if any. */
export function gateFor(
  fold: ThreadFold,
  itemId: string,
): { kind: "approval"; request: ApprovalRequest } | { kind: "input"; request: UserInputRequest } | null {
  for (const request of Object.values(fold.approvals)) {
    if (request.itemId === itemId) {
      return { kind: "approval", request };
    }
  }
  for (const request of Object.values(fold.userInputs)) {
    if (request.itemId === itemId) {
      return { kind: "input", request };
    }
  }
  return null;
}
