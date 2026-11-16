import type { ApprovalRequest, CuaDataFact, CuaStep, MspItem } from "../types.js";
import { GOAL_TOOLS } from "./goal.js";

/** Compact relative time for sidebars: now, 4m, 3h, 2d, 3w, then a short date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) {
    return "";
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 45) {
    return "now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.round(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "";
  }
  const millis = Math.max(0, Math.round(ms));
  if (millis < 1000) {
    return `${millis}ms`;
  }
  const total = Math.round(ms / 1000);
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** A short wall-clock time: `3:42 PM` today, `Sep 10, 3:42 PM` on another day, with the year once it differs. */
export function formatClock(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const today = new Date(now);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) {
    return time;
  }
  const sameYear = date.getFullYear() === today.getFullYear();
  const day = date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `${day}, ${time}`;
}

/** The full date and time, for tooltips behind a short clock time. */
export function formatFullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Output speed: `42 tok/s`, with one decimal below ten. */
export function formatSpeed(tokensPerSecond: number): string {
  return `${tokensPerSecond < 10 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond)} tok/s`;
}

/** Session-average speed for the telemetry pills: one decimal below 100, a whole number from there up. */
export function formatTokensPerSecond(tokensPerSecond: number): string {
  const value = tokensPerSecond < 100 ? tokensPerSecond.toFixed(1).replace(/\.0$/, "") : String(Math.round(tokensPerSecond));
  return `${value} tok/s`;
}

/** A running timer as T3 Code shows it: `42s`, then `7m`, then `1h 7m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}M`;
}

/** An exact token count with thousands separators, for the usage dialog. */
export function formatExactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Compact tokens for the telemetry pills: like formatTokens but with one decimal into the tens of
 * thousands, so a session at 18,400 tokens reads `18.4k` rather than `18k`.
 */
export function formatCompactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  if (value >= 1000 && value < 100_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return formatTokens(value);
}

/** `1 call`, `2 calls`: a count with its noun in the right number. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** Keep the tail of a long path readable: `D:\...\helicon\packages\ui`. */
export function shortenPath(path: string, max = 48): string {
  if (path.length <= max) {
    return path;
  }
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/);
  let tail = parts.pop() ?? "";
  while (parts.length > 1) {
    const next = parts[parts.length - 1] as string;
    if ((next + separator + tail).length + 4 > max) {
      break;
    }
    tail = next + separator + tail;
    parts.pop();
  }
  const head = parts[0] ?? "";
  return `${head}${separator}...${separator}${tail}`;
}

const ANSI_PATTERN = `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`;

/**
 * The last non-blank line of a (possibly huge) output, scanned from the end so a running tool
 * row's preview costs its tail rather than the whole log on every flush.
 */
export function lastLine(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const ansi = new RegExp(ANSI_PATTERN, "g");
  let end = text.length;
  while (end > 0) {
    let lineEnd = end;
    if (text[lineEnd - 1] === "\n") {
      lineEnd -= 1;
    }
    if (lineEnd === 0) {
      return null;
    }
    const lineStart = text.lastIndexOf("\n", lineEnd - 1) + 1;
    const line = text.slice(lineStart, lineEnd).replace(ansi, "").trim();
    if (line) {
      return line;
    }
    if (lineStart === 0) {
      return null;
    }
    end = lineStart;
  }
  return null;
}

export function humanize(identifier: string): string {
  const spaced = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function parseArgs(args: string | undefined): Record<string, unknown> | null {
  if (!args) {
    return null;
  }
  try {
    const parsed = JSON.parse(args) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function pickString(args: Record<string, unknown> | null, keys: string[]): string | null {
  if (!args) {
    return null;
  }
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

export type ToolKind =
  | "shell"
  | "read"
  | "edit"
  | "write"
  | "search"
  | "list"
  | "web"
  | "question"
  | "plan"
  | "agent"
  | "goal"
  | "monitor"
  | "generic";

const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "targetFile"];
const PATTERN_KEYS = ["pattern", "query", "regex", "search", "q"];

/** Classify a tool by the words in its name, so `frobnicate` never reads as `cat`. */
export function toolKind(tool: string | undefined, args: Record<string, unknown> | null): ToolKind {
  // Muse's goal tools, checked first so `create_goal` never reads as writing a file.
  if (tool && GOAL_TOOLS.has(tool)) {
    return "goal";
  }
  // Muse's Monitor: checked before shell, since its args carry the command it watches.
  if (tool === "monitor") {
    return "monitor";
  }
  const words = new Set(
    (tool ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const has = (...candidates: string[]) => candidates.some((c) => words.has(c));
  if (has("ask", "question", "questions") || (has("user") && has("input"))) {
    return "question";
  }
  if (has("todo", "todos", "plan", "todowrite")) {
    return "plan";
  }
  if (has("web", "websearch", "webfetch", "fetch", "http", "browse", "browser", "url")) {
    return "web";
  }
  if (pickString(args, ["command", "cmd"]) || has("bash", "shell", "exec", "execute", "run", "terminal", "powershell", "sh", "cmd")) {
    return "shell";
  }
  if (has("grep", "search", "find", "glob", "rg", "ripgrep")) {
    return "search";
  }
  if (has("edit", "multiedit", "patch", "replace", "apply", "modify")) {
    return "edit";
  }
  if (has("write", "create", "save")) {
    return "write";
  }
  if (has("read", "view", "cat", "open")) {
    return "read";
  }
  if (has("list", "ls", "dir", "tree")) {
    return "list";
  }
  if (has("agent", "task", "subagent", "delegate", "spawn")) {
    return "agent";
  }
  return "generic";
}

export interface ToolDescription {
  kind: ToolKind;
  /** Sentence-start verb for the current state: "Ran", "Running", "Read"... */
  verb: string;
  /** What the tool acted on: a command, path, pattern or URL. */
  subject: string | null;
  /** Render the subject in the code face. */
  mono: boolean;
  /** Optional model-authored explanation, e.g. bash's `description`. */
  note: string | null;
}

const VERBS: Record<ToolKind, [string, string]> = {
  shell: ["Ran", "Running"],
  read: ["Read", "Reading"],
  edit: ["Edited", "Editing"],
  write: ["Wrote", "Writing"],
  search: ["Searched for", "Searching for"],
  list: ["Listed", "Listing"],
  web: ["Fetched", "Fetching"],
  question: ["Asked you", "Asking you"],
  plan: ["Updated the plan", "Updating the plan"],
  agent: ["Delegated", "Delegating"],
  goal: ["Updated the goal", "Updating the goal"],
  monitor: ["Watched", "Watching"],
  generic: ["Used", "Using"],
};

/** The tool's own label for its current status, when Muse sent a complete one. */
function toolLabel(item: MspItem): string | null {
  const label = item.displayLabel;
  if (!label || typeof label !== "object") {
    return null;
  }
  const text = item.status === "inProgress" ? label.active : item.status === "completed" ? label.done : label.neutral;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

export function describeTool(item: MspItem): ToolDescription {
  const args = parseArgs(item.args);
  const kind = toolKind(item.tool, args);
  const running = item.status === "inProgress";
  const verb = VERBS[kind][running ? 1 : 0];
  const note = pickString(args, ["description", "reason", "explanation"]);
  switch (kind) {
    case "monitor": {
      const command = pickString(args, ["command", "cmd"]);
      const description = pickString(args, ["description"]);
      const verbFor = item.status === "cancelled" ? "Stopped watching" : verb;
      return { kind, verb: verbFor, subject: description ?? command, mono: !description, note: description ? command : null };
    }
    case "shell":
      return { kind, verb, subject: pickString(args, ["command", "cmd"]) ?? item.args ?? null, mono: true, note };
    case "read":
    case "edit":
    case "write":
    case "list":
      return { kind, verb, subject: pickString(args, PATH_KEYS) ?? pickString(args, ["directory", "dir"]), mono: true, note };
    case "search": {
      const pattern = pickString(args, PATTERN_KEYS);
      return { kind, verb, subject: pattern, mono: true, note: pickString(args, PATH_KEYS) ?? note };
    }
    case "web": {
      const url = pickString(args, ["url", "uri"]);
      if (url) {
        return { kind, verb, subject: url, mono: true, note };
      }
      return {
        kind,
        verb: running ? "Searching the web for" : "Searched the web for",
        subject: pickString(args, PATTERN_KEYS),
        mono: false,
        note,
      };
    }
    case "question": {
      const questions = args && Array.isArray(args["questions"]) ? (args["questions"] as Record<string, unknown>[]) : [];
      const first = questions[0];
      return {
        kind,
        verb,
        subject: first && typeof first["question"] === "string" ? first["question"] : null,
        mono: false,
        note: null,
      };
    }
    case "plan":
      return { kind, verb, subject: null, mono: false, note };
    case "agent":
      return { kind, verb, subject: pickString(args, ["description", "prompt", "objective", "task"]), mono: false, note: null };
    case "goal": {
      if (item.tool === "create_goal") {
        return { kind, verb: running ? "Setting a goal" : "Set a goal", subject: pickString(args, ["objective"]), mono: false, note: null };
      }
      if (item.tool === "report_progress") {
        const percent = args && typeof args["percent_complete"] === "number" ? `${Math.round(args["percent_complete"])}%` : null;
        return {
          kind,
          verb: running ? "Reporting progress" : "Reported progress",
          subject: percent,
          mono: false,
          note: pickString(args, ["current_work", "next_work"]),
        };
      }
      if (item.tool === "update_goal") {
        const status = pickString(args, ["status"]);
        return {
          kind,
          verb: running ? "Updating the goal" : "Marked the goal",
          subject: status === "complete" ? "done" : status,
          mono: false,
          note: null,
        };
      }
      return { kind, verb: running ? "Checking the goal" : "Checked the goal", subject: null, mono: false, note: null };
    }
    default: {
      const firstString = args ? Object.values(args).find((v): v is string => typeof v === "string" && v.length < 160) : null;
      const label = toolLabel(item);
      if (label) {
        return { kind, verb: label, subject: null, mono: false, note: firstString ?? null };
      }
      return {
        kind,
        verb: running ? "Using" : "Used",
        subject: item.tool ? humanize(item.tool) : "a tool",
        mono: false,
        note: firstString ?? null,
      };
    }
  }
}

export interface DiffRow {
  kind: "same" | "del" | "add";
  text: string;
}

export interface DiffHunk {
  rows: DiffRow[];
}

export type DiffView = { path: string | null; hunks: DiffHunk[] } | { path: string | null; patch: string };

function lines(value: unknown): string[] {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").split("\n") : [];
}

/** Old/new line pairs past this skip the alignment table and read as two plain blocks. */
export const ALIGN_CELL_LIMIT = 250_000;

/**
 * Aligns an edit's old and new lines the way a diff does: unchanged lines read as context instead of
 * showing as removed and re-added, which is what the find block's padding lines would otherwise do.
 */
export function alignLines(removed: string[], added: string[]): DiffRow[] {
  if (removed.length === 0) {
    return added.map((text) => ({ kind: "add" as const, text }));
  }
  if (added.length === 0) {
    return removed.map((text) => ({ kind: "del" as const, text }));
  }
  // The table below costs a cell per old/new pair, and a running edit's diff is recomputed on every
  // flush: past this many cells a giant edit would eat the frame budget on its own, so it reads as
  // one removed block followed by one added block instead of an aligned diff. Nothing is dropped.
  if (removed.length * added.length > ALIGN_CELL_LIMIT) {
    return [
      ...removed.map((text) => ({ kind: "del" as const, text })),
      ...added.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const width = added.length + 1;
  const table = new Uint32Array((removed.length + 1) * width);
  for (let i = 1; i <= removed.length; i += 1) {
    for (let j = 1; j <= added.length; j += 1) {
      table[i * width + j] =
        removed[i - 1] === added[j - 1]
          ? (table[(i - 1) * width + (j - 1)] as number) + 1
          : Math.max(table[(i - 1) * width + j] as number, table[i * width + (j - 1)] as number);
    }
  }
  const rows: DiffRow[] = [];
  let i = removed.length;
  let j = added.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && removed[i - 1] === added[j - 1]) {
      rows.push({ kind: "same", text: removed[i - 1] as string });
      i -= 1;
      j -= 1;
      // Ties walk back through the additions first, so deletions read before them going forward.
    } else if (j > 0 && (i === 0 || (table[i * width + (j - 1)] as number) >= (table[(i - 1) * width + j] as number))) {
      rows.push({ kind: "add", text: added[j - 1] as string });
      j -= 1;
    } else {
      rows.push({ kind: "del", text: removed[i - 1] as string });
      i -= 1;
    }
  }
  return rows.reverse();
}

interface EchoBlock {
  removed: string[];
  added: string[];
}

/**
 * Splits the runtime's edit echo(es) off the front of a tool result. Null when the output is not an
 * echo at all; a bare blank line reads as both sides', since no prefix says which side dropped it.
 */
function splitDiffEcho(output: string): { blocks: EchoBlock[]; rest: string } | null {
  const echoLines = output.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const blocks: EchoBlock[] = [];
  for (;;) {
    const head = echoLines.slice(i, i + 5);
    if (
      head.length < 5 ||
      !/^edited\b/.test(head[0] as string) ||
      !(head[1] as string).startsWith("changed lines:") ||
      head[2] !== "--- original" ||
      head[3] !== "+++ updated" ||
      !(head[4] as string).startsWith("@@")
    ) {
      break;
    }
    i += 5;
    const block: EchoBlock = { removed: [], added: [] };
    while (i < echoLines.length) {
      const line = echoLines[i] as string;
      if (line.startsWith("+")) {
        block.added.push(line.slice(1));
      } else if (line.startsWith("-")) {
        block.removed.push(line.slice(1));
      } else if (line === "") {
        block.removed.push("");
        block.added.push("");
      } else if (!line.startsWith("\\ No newline")) {
        break;
      }
      i += 1;
    }
    blocks.push(block);
  }
  if (blocks.length === 0) {
    return null;
  }
  return { blocks, rest: echoLines.slice(i).join("\n") };
}

/**
 * Strips the runtime's edit echo from a tool result, leaving anything it carried beyond the echo. Null
 * when the output is not an echo at all, so callers keep showing those; "" when it is only the echo,
 * which the receipt's own diff already shows better.
 */
export function withoutDiffEcho(output: string): string | null {
  return splitDiffEcho(output)?.rest ?? null;
}

/** Builds the receipt's diff from the result's echo, for when the arguments do not carry the change. */
export function diffFromEcho(output: string, path: string | null): DiffView | null {
  const echo = splitDiffEcho(output);
  if (!echo) {
    return null;
  }
  const hunks = echo.blocks.map((block) => ({ rows: alignLines(block.removed, block.added) }));
  if (!hunks.some((hunk) => hunk.rows.length > 0)) {
    return null;
  }
  return { path, hunks };
}

/** Pull a reviewable diff out of an edit-style tool call, when its arguments carry one. */
export function extractDiff(item: MspItem): DiffView | null {
  const args = parseArgs(item.args);
  if (!args) {
    return null;
  }
  const path = pickString(args, PATH_KEYS);
  const oldKey = ["old_string", "oldString", "old_str", "find", "search", "old"].find((k) => typeof args[k] === "string");
  const newKey = ["new_string", "newString", "new_str", "replace", "new"].find((k) => typeof args[k] === "string");
  if (oldKey && newKey) {
    return { path, hunks: [{ rows: alignLines(lines(args[oldKey]), lines(args[newKey])) }] };
  }
  if (Array.isArray(args["edits"])) {
    const hunks: DiffHunk[] = [];
    for (const edit of args["edits"] as unknown[]) {
      const e = edit && typeof edit === "object" ? (edit as Record<string, unknown>) : null;
      if (!e) {
        continue;
      }
      const o = e["old_string"] ?? e["oldString"] ?? e["old_str"];
      const n = e["new_string"] ?? e["newString"] ?? e["new_str"];
      if (typeof o === "string" || typeof n === "string") {
        hunks.push({ rows: alignLines(lines(o), lines(n)) });
      }
    }
    if (hunks.length > 0) {
      return { path, hunks };
    }
  }
  const patch = pickString(args, ["patch", "diff", "input"]);
  if (patch && /^(\*\*\* |--- |\+\+\+ |@@|diff --git)/m.test(patch)) {
    return { path, patch };
  }
  const content = pickString(args, ["content", "contents", "text", "file_text"]);
  if (content && toolKind(item.tool, args) === "write") {
    return { path, hunks: [{ rows: alignLines([], lines(content)) }] };
  }
  // Last resort: the result echoes the change even when the arguments do not name it, so an unfamiliar
  // tool shape still renders an aligned diff instead of the raw echo.
  if (item.visibleOutput && !item.truncated) {
    const kind = toolKind(item.tool, args);
    if (kind === "edit" || kind === "write") {
      return diffFromEcho(item.visibleOutput, path);
    }
  }
  return null;
}

/**
 * One recorded change, in the form the server can reverse: swap `after` back to `before` inside the file, or
 * delete a file that a whole-file write put there (`before` is null, `after` is what was written).
 */
export interface RevertStep {
  before: string | null;
  after: string;
  /** For a whole-file write: when the call ran (epoch ms), so a file that already existed then is never deleted. */
  at?: number;
}

/**
 * What undoing one edit-style tool call takes, or null when the arguments do not carry exact text (a patch,
 * or a tool whose shape is unknown). Only the arguments are read, never the aligned diff, so the strings are
 * exactly what the tool wrote.
 */
export function extractRevertSteps(item: MspItem): RevertStep[] | null {
  const args = parseArgs(item.args);
  if (!args) {
    return null;
  }
  const oldKey = ["old_string", "oldString", "old_str", "find", "search", "old"].find((k) => typeof args[k] === "string");
  const newKey = ["new_string", "newString", "new_str", "replace", "new"].find((k) => typeof args[k] === "string");
  if (oldKey && newKey) {
    // An empty replacement is a deletion: the text to find is gone, so it cannot be located again.
    return args["replace_all"] === true || args["replaceAll"] === true || args[newKey] === ""
      ? null
      : [{ before: args[oldKey] as string, after: args[newKey] as string }];
  }
  if (Array.isArray(args["edits"])) {
    const steps: RevertStep[] = [];
    for (const edit of args["edits"] as unknown[]) {
      const e = edit && typeof edit === "object" ? (edit as Record<string, unknown>) : null;
      const o = e?.["old_string"] ?? e?.["oldString"] ?? e?.["old_str"];
      const n = e?.["new_string"] ?? e?.["newString"] ?? e?.["new_str"];
      if (typeof o !== "string" || typeof n !== "string" || n === "") {
        return null;
      }
      steps.push({ before: o, after: n });
    }
    return steps.length > 0 ? steps : null;
  }
  const content = pickString(args, ["content", "contents", "text", "file_text"]);
  if (content !== null && toolKind(item.tool, args) === "write") {
    const at = item.recordedAt ? Date.parse(item.recordedAt) : NaN;
    return [{ before: null, after: content, ...(Number.isFinite(at) ? { at } : {}) }];
  }
  return null;
}

export function diffStats(diff: DiffView): { added: number; removed: number } {
  if ("patch" in diff) {
    let added = 0;
    let removed = 0;
    for (const line of diff.patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed += 1;
      }
    }
    return { added, removed };
  }
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const row of hunk.rows) {
      if (row.kind === "add") {
        added += 1;
      } else if (row.kind === "del") {
        removed += 1;
      }
    }
  }
  return { added, removed };
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
}

/** Flattens one diff into renderable rows, marking the gaps between its hunks. */
export function diffLines(diff: DiffView): DiffLine[] {
  const lines: DiffLine[] = [];
  if ("patch" in diff) {
    for (const line of diff.patch.split("\n")) {
      if (/^(\+\+\+|---|\*\*\*|@@|diff )/.test(line)) {
        lines.push({ kind: "meta", text: line });
      } else if (line.startsWith("+")) {
        lines.push({ kind: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        lines.push({ kind: "del", text: line.slice(1) });
      } else {
        lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
      }
    }
    return lines;
  }
  diff.hunks.forEach((hunk, index) => {
    if (index > 0) {
      lines.push({ kind: "meta", text: "..." });
    }
    for (const row of hunk.rows) {
      lines.push({ kind: row.kind === "same" ? "ctx" : row.kind, text: row.text });
    }
  });
  return lines;
}

/** Joins one file's diffs into a single continuous row stream, in turn order. */
export function mergeDiffLines(diffs: DiffView[]): DiffLine[] {
  const lines: DiffLine[] = [];
  diffs.forEach((diff, index) => {
    if (index > 0) {
      lines.push({ kind: "meta", text: "..." });
    }
    lines.push(...diffLines(diff));
  });
  return lines;
}

export interface ApprovalDescription {
  title: string;
  detail: string | null;
  mono: boolean;
}

export function describeApproval(request: ApprovalRequest): ApprovalDescription {
  const subject = request.subject ?? { kind: "tool" };
  const stagesCommand = subject.stages?.map((s) => s.argv.join(" ")).join(" | ");
  switch (subject.kind) {
    case "shell":
      return { title: "Run a shell command", detail: subject.command ?? stagesCommand ?? request.rawArgs ?? null, mono: true };
    case "fileAccess": {
      const access = subject.access ? subject.access.toLowerCase() : "access";
      const verb = access.includes("write") ? "Write to" : access.includes("read") ? "Read" : "Access";
      return { title: `${verb} a file`, detail: subject.path ?? subject.target ?? null, mono: true };
    }
    case "network": {
      const target = subject.host
        ? `${subject.protocol ? `${subject.protocol}://` : ""}${subject.host}${subject.port ? `:${subject.port}` : ""}`
        : (subject.target ?? null);
      return { title: "Connect to the network", detail: target, mono: true };
    }
    case "process":
      return { title: "Start a process", detail: subject.command ?? subject.target ?? stagesCommand ?? null, mono: true };
    case "tool":
      return {
        title: `Use the ${humanize(subject.toolName ?? request.toolName ?? "tool").toLowerCase()} tool`,
        detail: request.rawArgs ?? null,
        mono: true,
      };
    case "computerUseTakeover":
      return {
        title: "Take over Computer Use",
        detail: subject.holder?.sessionLabel
          ? `Another session is using it now: ${quoteAppText(subject.holder.sessionLabel)}`
          : "Another session is using it now",
        mono: false,
      };
    default:
      return {
        title: `Allow ${humanize(subject.kind).toLowerCase()}`,
        detail: subject.command ?? subject.path ?? subject.target ?? request.rawArgs ?? null,
        mono: true,
      };
  }
}

/** Drops control and format characters (bidi overrides, zero-width joiners), which can reorder or hide what the user reads. */
export function plainAppText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Text an app controls (a window title, a button label) is quoted and capped, so it can't pass for Helicon's own words.
 * Its own double quotes become single ones, so a label can't close the quote early and add words of its own.
 */
export function quoteAppText(text: string, max = 80): string {
  const flat = plainAppText(text).replace(/["\u201C\u201D]/g, "'");
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
}

/** One Computer Use step as a line: `Click button "Save"`, `Press Ctrl+S`, `Click at 120, 480`. */
export function describeCuaStep(step: CuaStep): string {
  const action = step.action.charAt(0).toUpperCase() + step.action.slice(1);
  if (step.label) {
    return `${action} ${step.roleWord ? `${step.roleWord} ` : ""}${quoteAppText(step.label)}`;
  }
  if (step.chord) {
    return `${action} ${step.chord}`;
  }
  if (step.point) {
    return `${action} at ${step.point.x}, ${step.point.y}`;
  }
  return action;
}

const SECRET_KINDS: Record<string, string> = {
  github_token: "a GitHub token",
  secret_named_value: "a secret value",
};

/**
 * One piece of data a Computer Use call would send: `Sends a GitHub token ghp_…3f9a`, `Sends a secret value password=… (12 chars)`.
 * Unknown kinds still get a row, so new data never goes unmentioned.
 */
export function describeCuaData(fact: CuaDataFact): string {
  if (fact.kind !== "secret") {
    return "Sends data Muse couldn't describe";
  }
  const what = (fact.secretKind && SECRET_KINDS[fact.secretKind]) || "a secret";
  const { chars, last4, prefix } = fact.mask ?? {};
  const shown = prefix || last4 ? `${plainAppText(prefix ?? "").slice(0, 40)}…${plainAppText(last4 ?? "").slice(0, 4)}` : "";
  const length = Number.isFinite(chars) && chars! > 0 ? `(${chars} chars)` : "";
  return ["Sends", what, shown, length].filter(Boolean).join(" ");
}

/** Strip the provider tier suffix for display; the tier gets its own badge. */
export function modelDisplayName(modelId: string | null | undefined): string {
  if (!modelId) {
    return "Default model";
  }
  return modelId.replace(/-contributor$/i, "");
}
