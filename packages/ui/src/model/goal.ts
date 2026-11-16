import type { ThreadFold } from "./fold.js";

/**
 * A thread's goal, the way Muse keeps working toward an objective across turns. Muse reports the goal
 * block live (`session/goalChanged`: objective, status, percent, current and next work); its goal tools
 * return the full record, with when it started, its token count and budget. Helicon adds what neither
 * says outright: how long it has run, and how many turns and tokens its work took.
 */

/** Muse's full goal record, from the output of its goal tools. */
export interface GoalRecord {
  goalId: string | null;
  objective: string;
  status: string;
  percentComplete: number;
  currentWork: string | null;
  nextWork: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  lastProgressAt: number | null;
  /** Muse's own count, updated when a goal tool runs. */
  tokensUsed: number | null;
  tokenBudget: number | null;
}

/** The model's goal tools; each returns the whole record as `{"goal": {...}}`. */
export const GOAL_TOOLS: ReadonlySet<string> = new Set(["create_goal", "update_goal", "report_progress", "get_goal"]);

export type GoalTone = "active" | "paused" | "done" | "attention" | "ended";

const STATUS: Record<string, { label: string; tone: GoalTone }> = {
  active: { label: "In progress", tone: "active" },
  paused: { label: "Paused", tone: "paused" },
  complete: { label: "Done", tone: "done" },
  blocked: { label: "Blocked", tone: "attention" },
  budget_limited: { label: "Out of budget", tone: "attention" },
  usage_limited: { label: "Usage limit reached", tone: "attention" },
  cleared: { label: "Cleared", tone: "ended" },
  cancelled: { label: "Cancelled", tone: "ended" },
  superseded: { label: "Replaced", tone: "ended" },
  abandoned: { label: "Abandoned", tone: "ended" },
};

export interface GoalView {
  objective: string;
  status: string;
  label: string;
  tone: GoalTone;
  /** Clamped to 0 to 100; Muse passes larger values through. */
  percent: number;
  currentWork: string | null;
  nextWork: string | null;
  startedAt: number | null;
  /** When the clock stopped, for a goal no longer in progress. */
  endedAt: number | null;
  /** Time it spent paused or blocked before it last resumed, which is not running time. */
  pausedMs: number;
  lastProgressAt: number | null;
  /** Turns that did work toward the goal. */
  turns: number;
  /** Those same turns by id, so the goal can be priced over exactly the work its token count covers. */
  turnIds: string[];
  /** Input plus output tokens of those turns' model calls. */
  tokens: number;
  tokenBudget: number | null;
  /** Muse's own token count for the goal, as of its last goal tool call. */
  tokensUsed: number | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Parses a goal tool's output. Null when it is not a goal record, as with a failed or cut-off call. */
export function parseGoalRecord(output: string | undefined): GoalRecord | null {
  if (!output) {
    return null;
  }
  let root: unknown;
  try {
    root = JSON.parse(output);
  } catch {
    return null;
  }
  const goal = root && typeof root === "object" ? (root as Record<string, unknown>)["goal"] : null;
  if (!goal || typeof goal !== "object") {
    return null;
  }
  const g = goal as Record<string, unknown>;
  const objective = text(g["objective"]);
  if (!objective) {
    return null;
  }
  return {
    goalId: text(g["goal_id"]),
    objective,
    status: text(g["status"]) ?? "active",
    percentComplete: num(g["percent_complete"]) ?? 0,
    currentWork: text(g["current_work"]),
    nextWork: text(g["next_work"]),
    createdAt: num(g["created_at_ms"]),
    updatedAt: num(g["updated_at_ms"]),
    lastProgressAt: num(g["last_progress_at_ms"]),
    tokensUsed: num(g["tokens_used"]),
    tokenBudget: num(g["token_budget"]),
  };
}

/** The newest goal record in the thread, with the turn whose tool call returned it. */
export function latestGoalRecord(fold: ThreadFold): { record: GoalRecord; turnId: string | null } | null {
  for (let index = fold.order.length - 1; index >= 0; index -= 1) {
    const item = fold.items.get(fold.order[index] as string);
    if (item?.kind === "toolCall" && item.tool && GOAL_TOOLS.has(item.tool) && item.status === "completed") {
      const record = parseGoalRecord(item.visibleOutput);
      if (record) {
        return { record, turnId: item.turnId ?? null };
      }
    }
  }
  return null;
}

export function statusLabel(status: string): { label: string; tone: GoalTone } {
  const known = STATUS[status];
  if (known) {
    return known;
  }
  const words = status.replace(/[_-]+/g, " ").trim();
  return { label: words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Unknown", tone: "paused" };
}

/** Turns with work recorded while the goal ran: from `start` to `end`, outside its pauses, plus the turn that set it. */
function goalTurns(fold: ThreadFold, start: number, end: number | null, setIn: string | null): Set<string> {
  const turns = new Set<string>();
  if (setIn) {
    turns.add(setIn);
  }
  const pauses = fold.meta.goalPauses;
  const paused = (at: number) => pauses.some((p) => at > p.from && at < (p.to ?? Number.POSITIVE_INFINITY));
  const inside = (at: number) => at >= start && (end === null || at <= end) && !paused(at);
  for (const id of fold.order) {
    const item = fold.items.get(id);
    const at = item?.recordedAt ? Date.parse(item.recordedAt) : Number.NaN;
    if (item?.turnId && !Number.isNaN(at) && inside(at)) {
      turns.add(item.turnId);
    }
  }
  // A live turn may not have a recorded item yet.
  for (const info of Object.values(fold.turns)) {
    if (info.startedAt !== undefined && inside(info.startedAt)) {
      turns.add(info.turnId);
    }
  }
  return turns;
}

/**
 * Everything the goal panel shows, or null when the thread has no goal. The live block wins for status
 * and progress; the record, when it describes the same objective, supplies times, budget and Muse's count.
 */
export function goalView(fold: ThreadFold): GoalView | null {
  const block = fold.meta.goal;
  const latest = latestGoalRecord(fold);
  // A goal Muse cleared stays cleared, even though an older tool record still describes it.
  if (!block && (fold.meta.goalSeen || !latest)) {
    return null;
  }
  const objective = block?.objective ?? latest?.record.objective ?? "";
  const record = latest && latest.record.objective === objective ? latest.record : null;
  const status = block?.status ?? record?.status ?? "active";
  const { label, tone } = statusLabel(status);
  const startedAt = record?.createdAt ?? fold.meta.goalSince;
  // The clock stops when the status last changed: seen live, or the record's own update when it describes this status.
  const endedAt = tone === "active" ? null : (fold.meta.goalStatusAt ?? (record && record.status === status ? record.updatedAt : null));
  const turns = startedAt === null ? new Set<string>() : goalTurns(fold, startedAt, endedAt, record ? latest?.turnId ?? null : null);
  let tokens = 0;
  for (const call of Object.values(fold.meta.calls)) {
    if (call.turnId && turns.has(call.turnId)) {
      tokens += call.promptTokens + call.outputTokens;
    }
  }
  const percent = block?.percentComplete ?? record?.percentComplete ?? 0;
  return {
    objective,
    status,
    label,
    tone,
    percent: Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)),
    currentWork: block?.currentWork ?? record?.currentWork ?? null,
    nextWork: block?.nextWork ?? record?.nextWork ?? null,
    startedAt,
    endedAt,
    pausedMs: fold.meta.goalPauses.reduce((total, p) => total + (p.to === null ? 0 : Math.max(0, p.to - p.from)), 0),
    lastProgressAt: record?.lastProgressAt ?? null,
    turns: turns.size,
    turnIds: [...turns],
    tokens,
    tokenBudget: record?.tokenBudget ?? null,
    tokensUsed: record?.tokensUsed ?? null,
  };
}

/** What `/goal <objective>` sends: Muse's terminal UI sets goals itself, a served session asks the model. */
export function goalPrompt(objective: string): string {
  return `Create a goal with your create_goal tool. Objective: ${objective.trim()}\nThen work toward it until it is complete.`;
}
