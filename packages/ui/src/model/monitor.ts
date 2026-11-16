import type { MspItem } from "../types.js";
import type { ThreadFold, TurnView } from "./fold.js";
import { parseArgs, pickString } from "./format.js";

/**
 * Muse Code's Monitor: the agent calls a `monitor` tool with a command to watch (CI, a build, a log).
 * The tool call stays in progress for as long as the monitor watches, and when the command prints
 * something worth acting on, Muse starts a turn on its own. `task/stop` with the item id stops it.
 */
export interface MonitorView {
  itemId: string;
  description: string | null;
  command: string | null;
  persistent: boolean;
  watching: boolean;
  /** When the monitor's tool call was first recorded, in ms. */
  startedAt: number | null;
}

export function isMonitor(item: MspItem | undefined): item is MspItem {
  return item?.kind === "toolCall" && item.tool === "monitor";
}

export function monitorView(item: MspItem, startedAt: number | null = null): MonitorView {
  const args = parseArgs(item.args);
  return {
    itemId: item.itemId,
    description: pickString(args, ["description"]),
    command: pickString(args, ["command", "cmd"]),
    persistent: args?.["persistent"] === true,
    watching: item.status === "inProgress",
    startedAt: startedAt ?? (item.recordedAt ? Date.parse(item.recordedAt) || null : null),
  };
}

/** The thread's monitors that are still watching, oldest first. */
export function activeMonitors(fold: ThreadFold): MonitorView[] {
  const out: MonitorView[] = [];
  for (const id of fold.order) {
    const item = fold.items.get(id);
    if (isMonitor(item) && item.status === "inProgress") {
      out.push(monitorView(item, fold.turns[item.turnId ?? ""]?.startedAt ?? null));
    }
  }
  return out;
}

/**
 * A label for each turn Muse started by itself after a monitor was set up, keyed by turn key. Those turns
 * have no prompt from anyone: a monitor saw something (or was stopped) and woke the agent.
 */
export function wakeLabels(turns: TurnView[]): Record<string, string> {
  const labels: Record<string, string> = {};
  const seen = new Map<string, string | null>();
  for (const turn of turns) {
    if (turn.turnId && !turn.prompt && seen.size > 0) {
      const names = [...new Set([...seen.values()].filter((d): d is string => Boolean(d)))];
      labels[turn.key] = seen.size === 1 && names[0] ? `Woken by a monitor: ${names[0]}` : "Woken by a monitor";
    }
    for (const item of [...turn.entries, ...(turn.final ? [turn.final] : [])]) {
      if (isMonitor(item)) {
        seen.set(item.itemId, monitorView(item).description);
      }
    }
  }
  return labels;
}
