import type { ContextUsage, ModelOption, MspItem } from "../types.js";
import { HIDDEN_KINDS, type CallUsage, type ThreadFold, type TurnInfo } from "./fold.js";
import { diffStats, extractDiff, formatCompactTokens, formatTokensPerSecond, modelDisplayName } from "./format.js";

/**
 * Context and session usage for the composer's context panel. Muse reports the context total,
 * every model call's token counts and the catalog prices; how the context splits between
 * prompts, replies and tool output is estimated here from the thread's own text.
 */

/** About four characters per token for English and code. Only feeds the estimated split. */
const CHARS_PER_TOKEN = 4;

export type SliceKey = "prompts" | "replies" | "tools" | "subagents" | "summary" | "system";

export interface ContextSlice {
  key: SliceKey;
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  /** Muse's own count of the tokens in context. */
  used: number;
  window: number | null;
  pressure: string;
  /** How `used` splits, in a fixed order so the bar keeps its colors as it grows. */
  slices: ContextSlice[];
  free: number | null;
}

const SLICE_LABELS: Record<SliceKey, string> = {
  prompts: "Your messages",
  replies: "Muse's replies",
  tools: "Tool calls and results",
  subagents: "Subagent results",
  summary: "Compacted summary",
  system: "System prompt and tools",
};

function estimate(text: string | null | undefined): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

/** The items still in the model's context: everything after the latest installed compaction. */
function inContext(fold: ThreadFold): { items: MspItem[]; summary: MspItem | null } {
  let start = 0;
  let summary: MspItem | null = null;
  fold.order.forEach((id, index) => {
    const item = fold.items.get(id);
    if (item?.kind === "compaction" && item.outcome === "compacted") {
      start = index + 1;
      summary = item;
    }
  });
  const items: MspItem[] = [];
  for (const id of fold.order.slice(start)) {
    const item = fold.items.get(id);
    if (item && !HIDDEN_KINDS.has(item.kind) && !item.retracted) {
      items.push(item);
    }
  }
  return { items, summary };
}

/**
 * The context reading to show. Live streams report it directly; a thread opened from history
 * only has its model calls, so the latest call's occupancy stands in, sized by the model's limit.
 */
export function contextUsageOf(fold: ThreadFold, models: readonly ModelOption[]): ContextUsage | null {
  if (fold.meta.contextUsage) {
    return fold.meta.contextUsage;
  }
  const calls = Object.values(fold.meta.calls);
  const last = calls[calls.length - 1];
  if (!last) {
    return null;
  }
  const modelId = last.modelId ?? fold.meta.modelId;
  const window = models.find((m) => m.modelId === modelId)?.contextLimit ?? undefined;
  return { usedTokens: last.promptTokens + last.outputTokens, windowTokens: window, pressure: "normal" };
}

export function contextBreakdown(fold: ThreadFold, models: readonly ModelOption[]): ContextBreakdown | null {
  const usage = contextUsageOf(fold, models);
  if (!usage) {
    return null;
  }
  const { items, summary } = inContext(fold);
  const raw: Record<Exclude<SliceKey, "system">, number> = {
    prompts: 0,
    replies: 0,
    tools: 0,
    subagents: 0,
    summary: summary?.tokensAfter ?? 0,
  };
  for (const item of items) {
    if (item.kind === "userMessage") {
      raw.prompts += estimate(item.displayText ?? item.text);
    } else if (item.kind === "agentMessage") {
      raw.replies += estimate(item.text);
    } else if (item.kind === "toolCall") {
      raw.tools += estimate(item.args) + estimate(item.visibleOutput);
    } else if (item.kind === "userShell") {
      raw.tools += estimate(item.commandText) + estimate(item.visibleOutput);
    } else if (item.kind === "subagent") {
      raw.subagents += estimate(item.result?.summary ?? item.result?.text ?? item.objective);
    }
  }
  const used = usage.usedTokens;
  const counted = Object.values(raw).reduce((total, value) => total + value, 0);
  // The estimate can overshoot what Muse counted (text the model never saw in full); shrink it to fit.
  const scale = counted > used && counted > 0 ? used / counted : 1;
  const slices: ContextSlice[] = [];
  let explained = 0;
  for (const key of ["prompts", "replies", "tools", "subagents", "summary"] as const) {
    const tokens = Math.round(raw[key] * scale);
    if (tokens > 0) {
      slices.push({ key, label: SLICE_LABELS[key], tokens });
      explained += tokens;
    }
  }
  // Whatever the thread's text does not explain is the system prompt, tool definitions and memory.
  const system = Math.max(0, used - explained);
  if (system > 0) {
    slices.push({ key: "system", label: SLICE_LABELS.system, tokens: system });
  }
  const window = usage.windowTokens ?? null;
  return { used, window, pressure: usage.pressure, slices, free: window === null ? null : Math.max(0, window - used) };
}

/** Calls with this few output tokens say nothing about speed, as in opencode's gateway. */
const MIN_SPEED_TOKENS = 10;
/** Shorter generation windows are too noisy to report. */
const MIN_SPEED_MS = 100;

export interface TurnSpeed {
  tokensPerSecond: number;
  outputTokens: number;
  generationMs: number;
}

/**
 * A finished turn's output speed, measured the way opencode's gateway measures each model call:
 * output tokens (reasoning included, as Muse counts it) over the time the model spent producing
 * them, ignoring calls of ten tokens or fewer. The time is each counted call's own wall time, so
 * tool runs between calls never count. Muse's time to first token cannot be taken off: it runs from
 * the turn's start to its first visible text, across calls and tool runs, not per call.
 */
export function turnSpeed(fold: ThreadFold, turnId: string): TurnSpeed | null {
  let tokens = 0;
  let generation = 0;
  for (const call of Object.values(fold.meta.calls)) {
    if (call.turnId === turnId && call.outputTokens > MIN_SPEED_TOKENS && (call.durationMs ?? 0) > 0) {
      tokens += call.outputTokens;
      generation += call.durationMs ?? 0;
    }
  }
  if (tokens === 0 || generation < MIN_SPEED_MS) {
    return null;
  }
  return { tokensPerSecond: (tokens / generation) * 1000, outputTokens: tokens, generationMs: generation };
}

/** Every finished turn's speed, by turn id. */
export function turnSpeeds(fold: ThreadFold): Record<string, TurnSpeed> {
  const speeds: Record<string, TurnSpeed> = {};
  for (const turnId of new Set(Object.values(fold.meta.calls).map((call) => call.turnId))) {
    if (turnId && turnId !== fold.activeTurnId) {
      const speed = turnSpeed(fold, turnId);
      if (speed) {
        speeds[turnId] = speed;
      }
    }
  }
  return speeds;
}

/** The most recent finished turn that has a speed. */
export function lastTurnSpeed(fold: ThreadFold): TurnSpeed | null {
  const calls = Object.values(fold.meta.calls);
  const seen = new Set<string>();
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const turnId = calls[index]?.turnId;
    if (!turnId || seen.has(turnId) || turnId === fold.activeTurnId) {
      continue;
    }
    seen.add(turnId);
    const speed = turnSpeed(fold, turnId);
    if (speed) {
      return speed;
    }
  }
  return null;
}

export interface TurnCost {
  cost: number;
  currency: string | null;
  /** False when a call ran on a model with no listed price, so the total undercounts. */
  complete: boolean;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** What one turn would have cost at API rates, from the calls it made. */
export function turnCost(fold: ThreadFold, turnId: string, models: readonly ModelOption[]): TurnCost | null {
  let cost = 0;
  let priced = 0;
  let calls = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let currency: string | null = null;
  for (const call of Object.values(fold.meta.calls)) {
    if (call.turnId !== turnId) {
      continue;
    }
    calls += 1;
    const cached = cacheReads(call);
    promptTokens += call.promptTokens;
    cachedTokens += cached;
    outputTokens += call.outputTokens;
    reasoningTokens += call.reasoningTokens;
    const price = models.find((m) => m.modelId === call.modelId)?.cost ?? null;
    if (price) {
      cost += ((call.promptTokens - cached) * price.input + cached * price.cached + call.outputTokens * price.output) / 1_000_000;
      priced += 1;
      currency = currency ?? price.currency;
    }
  }
  if (calls === 0) {
    return null;
  }
  return { cost, currency, complete: priced === calls, promptTokens, cachedTokens, outputTokens, reasoningTokens };
}

/** Every turn's cost, by turn id. */
export function turnCosts(fold: ThreadFold, models: readonly ModelOption[]): Record<string, TurnCost> {
  const costs: Record<string, TurnCost> = {};
  for (const turnId of new Set(Object.values(fold.meta.calls).map((call) => call.turnId))) {
    if (!turnId) {
      continue;
    }
    const cost = turnCost(fold, turnId, models);
    if (cost) {
      costs[turnId] = cost;
    }
  }
  return costs;
}

/** A rough live speed for the text streaming right now: characters over four, per second of the burst. */
export function streamingSpeed(info: TurnInfo | null | undefined): number | null {
  const stream = info?.stream;
  if (!stream) {
    return null;
  }
  const ms = stream.lastAt - stream.startAt;
  const tokens = stream.chars / CHARS_PER_TOKEN;
  if (ms < 500 || tokens <= MIN_SPEED_TOKENS) {
    return null;
  }
  return (tokens / ms) * 1000;
}

export interface ModelUsage {
  modelId: string;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  /** Null when the catalog lists no price for this model. */
  cost: number | null;
}

export interface ToolUsage {
  tool: string;
  calls: number;
  /** Estimated from the call's arguments and visible output. */
  tokens: number;
}

export interface SubagentUsage {
  itemId: string;
  label: string;
  tokens: number;
}

export interface CompactionRecord {
  itemId: string;
  trigger: string | null;
  outcome: string | null;
  before: number | null;
  after: number | null;
}

export interface SessionUsage {
  calls: number;
  /** Counted-once session totals, as Muse reports them. */
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Raw per-call counters, summed. */
  inputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Share of prompt tokens served from the provider's cache; null before any call. */
  cacheHit: number | null;
  modelMs: number;
  models: ModelUsage[];
  /** Estimated from catalog prices; null when no model used here lists one. */
  cost: number | null;
  currency: string | null;
  /** False when some calls ran on a model without a price, so `cost` undercounts. */
  costComplete: boolean;
  lines: { added: number; removed: number; files: number };
  turns: number;
  workedMs: number;
  firstTokenMs: number | null;
  tools: ToolUsage[];
  subagents: SubagentUsage[];
  compactions: CompactionRecord[];
}

/** Cached prompt tokens for one call, whichever counter the provider fills. */
function cacheReads(call: CallUsage): number {
  return Math.min(call.promptTokens, call.cacheReadTokens || call.cachedTokens);
}

export function sessionUsage(fold: ThreadFold, models: readonly ModelOption[]): SessionUsage {
  const calls = Object.values(fold.meta.calls);
  const sum = (pick: (call: CallUsage) => number) => calls.reduce((total, call) => total + pick(call), 0);
  const perCallPrompt = sum((c) => c.promptTokens);

  const byModel = new Map<string, ModelUsage>();
  let cost = 0;
  let priced = 0;
  let currency: string | null = null;
  for (const call of calls) {
    const id = call.modelId ?? "unknown";
    const entry = byModel.get(id) ?? { modelId: id, calls: 0, promptTokens: 0, outputTokens: 0, cost: null };
    entry.calls += 1;
    entry.promptTokens += call.promptTokens;
    entry.outputTokens += call.outputTokens;
    const price = models.find((m) => m.modelId === call.modelId)?.cost ?? null;
    if (price) {
      const cached = cacheReads(call);
      const callCost = ((call.promptTokens - cached) * price.input + cached * price.cached + call.outputTokens * price.output) / 1_000_000;
      entry.cost = (entry.cost ?? 0) + callCost;
      cost += callCost;
      priced += 1;
      currency = currency ?? price.currency;
    }
    byModel.set(id, entry);
  }

  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  const tools = new Map<string, ToolUsage>();
  const subagents: SubagentUsage[] = [];
  const compactions: CompactionRecord[] = [];
  for (const id of fold.order) {
    const item = fold.items.get(id);
    if (!item) {
      continue;
    }
    if (item.kind === "toolCall") {
      const diff = extractDiff(item);
      if (diff) {
        const stats = diffStats(diff);
        added += stats.added;
        removed += stats.removed;
        files.add(diff.path ?? item.itemId);
      }
      const name = item.tool ?? "tool";
      const entry = tools.get(name) ?? { tool: name, calls: 0, tokens: 0 };
      entry.calls += 1;
      entry.tokens += estimate(item.args) + estimate(item.visibleOutput);
      tools.set(name, entry);
    } else if (item.kind === "subagent" && item.usage) {
      const tokens = (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0);
      subagents.push({ itemId: item.itemId, label: item.role ?? item.objective ?? "Subagent", tokens });
    } else if (item.kind === "compaction" && item.status !== "inProgress") {
      compactions.push({
        itemId: item.itemId,
        trigger: item.trigger ?? null,
        outcome: item.outcome ?? null,
        before: item.tokensBefore ?? null,
        after: item.tokensAfter ?? null,
      });
    }
  }

  const turns = Object.values(fold.turns).filter((turn) => turn.terminal);
  const firstTokens = turns.map((turn) => turn.firstTokenMs).filter((ms): ms is number => typeof ms === "number");
  const totals = fold.meta.tokenTotals;
  return {
    calls: calls.length,
    promptTokens: totals?.promptTokens ?? perCallPrompt,
    outputTokens: totals?.outputTokens ?? sum((c) => c.outputTokens),
    totalTokens: totals?.totalTokens ?? perCallPrompt + sum((c) => c.outputTokens),
    inputTokens: sum((c) => c.inputTokens),
    cachedTokens: sum((c) => c.cachedTokens),
    cacheReadTokens: sum((c) => c.cacheReadTokens),
    cacheWriteTokens: sum((c) => c.cacheWriteTokens),
    reasoningTokens: sum((c) => c.reasoningTokens),
    cacheHit: perCallPrompt > 0 ? sum(cacheReads) / perCallPrompt : null,
    modelMs: sum((c) => c.durationMs ?? 0),
    models: [...byModel.values()].sort((a, b) => b.promptTokens + b.outputTokens - (a.promptTokens + a.outputTokens)),
    cost: priced > 0 ? cost : null,
    currency,
    costComplete: priced === calls.length,
    lines: { added, removed, files: files.size },
    turns: turns.length,
    workedMs: turns.reduce((total, turn) => total + (turn.durationMs ?? 0), 0),
    firstTokenMs: firstTokens.length > 0 ? firstTokens.reduce((a, b) => a + b, 0) / firstTokens.length : null,
    tools: [...tools.values()].sort((a, b) => b.tokens - a.tokens),
    subagents: subagents.sort((a, b) => b.tokens - a.tokens),
    compactions,
  };
}

/** Per-model totals behind the telemetry dialogs, grouped the way sessionUsage groups them. */
export interface TelemetryModelUsage {
  modelId: string;
  /** The model id in display form, e.g. with the contributor tier suffix stripped. */
  name: string;
  calls: number;
  outputTokens: number;
}

/** Live per-thread totals for the telemetry pills above the composer. */
export interface SessionTelemetry {
  /** Call-derived details cover only the loaded history. */
  partial: boolean;
  /** Cumulative tokens when available, otherwise the loaded calls' sum. */
  totalTokens: number;
  totalsComplete: boolean;
  /** Turns the fold knows about, including the one still running. */
  turns: number;
  /** Model calls the session made. */
  steps: number;
  /** Calls that reported how long the model spent on them. */
  timedCalls: number;
  /** The model's own time, summed over the timed calls only. */
  durationMs: number;
  /** Output tokens over the timed calls' time; null when no call has timing. */
  tokensPerSecond: number | null;
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Uncached input in the loaded calls, using the same cache convention as cacheHitPct. */
  uncachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Share of prompt tokens served from cache, rounded 0–100; null before any prompt tokens. */
  cacheHitPct: number | null;
  models: TelemetryModelUsage[];
}

/**
 * What the telemetry pills show, from the same per-call records sessionUsage reads. The turn count is
 * the fold's own, so a thread mid-turn is counted too; speed and time only cover the calls that
 * reported a duration, the way turnSpeed measures but across the whole session.
 */
export function sessionTelemetry(fold: ThreadFold, truncated = false): SessionTelemetry {
  const calls = Object.values(fold.meta.calls);
  let timedCalls = 0;
  let durationMs = 0;
  let timedOutput = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  const byModel = new Map<string, TelemetryModelUsage>();
  for (const call of calls) {
    promptTokens += call.promptTokens;
    outputTokens += call.outputTokens;
    cachedTokens += cacheReads(call);
    cacheWriteTokens += call.cacheWriteTokens;
    reasoningTokens += call.reasoningTokens;
    if (call.durationMs !== null) {
      timedCalls += 1;
      durationMs += call.durationMs;
      timedOutput += call.outputTokens;
    }
    const id = call.modelId ?? "unknown";
    const entry = byModel.get(id) ?? { modelId: id, name: modelDisplayName(id), calls: 0, outputTokens: 0 };
    entry.calls += 1;
    entry.outputTokens += call.outputTokens;
    byModel.set(id, entry);
  }
  const totals = fold.meta.tokenTotals;
  const partial = truncated || Boolean(totals && (totals.promptTokens > promptTokens || totals.outputTokens > outputTokens));
  return {
    partial,
    totalTokens: totals?.totalTokens ?? promptTokens + outputTokens,
    totalsComplete: totals !== null || !partial,
    turns: Object.keys(fold.turns).length,
    steps: calls.length,
    timedCalls,
    durationMs,
    tokensPerSecond: timedCalls > 0 && durationMs > 0 ? (timedOutput / durationMs) * 1000 : null,
    promptTokens: totals?.promptTokens ?? promptTokens,
    outputTokens: totals?.outputTokens ?? outputTokens,
    cachedTokens,
    uncachedTokens: Math.max(0, promptTokens - cachedTokens),
    cacheWriteTokens,
    reasoningTokens,
    cacheHitPct: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : null,
    models: [...byModel.values()].sort((a, b) => b.outputTokens - a.outputTokens),
  };
}

/** The time pill's label: `3 turns · 8 steps · 62 tok/s`, the speed left off when nothing timed. */
export function timePillLabel(t: SessionTelemetry): string {
  const speed = t.tokensPerSecond === null ? "" : ` · ${formatTokensPerSecond(t.tokensPerSecond)}`;
  const turns = `${t.turns} ${t.turns === 1 ? "turn" : "turns"}`;
  const steps = `${t.steps} ${t.steps === 1 ? "step" : "steps"}`;
  return `${t.partial ? "Partial · " : ""}${turns} · ${steps}${speed}`;
}

/** The usage pill's label: `252K tok · Cache hit 87%`, the cache left off before any prompt tokens. */
export function usagePillLabel(t: SessionTelemetry): string {
  const total = formatCompactTokens(t.totalTokens).toUpperCase();
  const hit = t.partial || t.cacheHitPct === null ? "" : ` · Cache hit ${t.cacheHitPct}%`;
  return `${total}${t.totalsComplete ? "" : "+"} tok${hit}`;
}
