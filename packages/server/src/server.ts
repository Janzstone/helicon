import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, posix, resolve, sep, win32 } from "node:path";
import type { Readable } from "node:stream";
import {
  HeliconMspHost,
  HeliconStore,
  SessionManager,
  isApprovalMode,
  isGoalAction,
  isIfBusy,
  isReasoningEffort,
  isSubagentAction,
  isWorkflowChildAction,
  parseSubscriptionUsage,
  nativeReleaseInfo,
  parseRuntimePreference,
  planHostCommand,
  refreshNativeMuse,
  type MuseRuntime,
  type NativeMuse,
  type RuntimePreference,
  planMuseCli,
  planServe,
  probeEnvironment,
  museSignedIn,
  resolveMuseInDistro,
  defaultExec,
  toWslPath,
  toWindowsPath,
  type ApprovalMode,
  type AttachmentRecord,
  type CommandConnection,
  type ExecFn,
  type ServeTarget,
  type ReasoningEffort,
  type SessionRecord,
  type SessionSkill,
  type SubscriptionUsage,
  type TurnImage,
} from "@helicon/daemon";
import { FileError, listFolder, readProjectFile, resolveInRoot, revertProjectFile, searchProjectFiles, serveProjectFile, writeProjectFile } from "./files.js";
import { PathError, createDirectory, listDirectory, resolveUserPath, type DirectoryListing, type PathContext } from "./paths.js";
import {
  SSH_HOME_CACHE_MS,
  SshError,
  defaultSshRun,
  discoveredProjectRoot,
  isSshCwd,
  listSshDirectory,
  needsSshHome,
  normalizeSshCwd,
  parseSshProject,
  readSshHome,
  resolveSshPath,
  sshDirectoryListing,
  sshServeArgs,
  type SshRunFn,
} from "./ssh.js";
import { buildThreadTitlePrompt, deriveTitle, parseExecTitle, sanitizeThreadTitle } from "./threadTitles.js";
import { importOmpUsage, resolveOmpSessionsDirs } from "./ompUsage.js";
import {
  DEFAULT_TAIL_TIMING,
  ViewTail,
  endsIncomplete,
  withoutProvisionalEnding,
  type SessionRecordView,
  type TailEvent,
  type ViewTailTiming,
} from "./viewTail.js";
import { AoniaError, createAonia, parseLoginOutput, type Aonia, type Profile } from "@harjjotsinghh/aonia";

export const HELICON_VERSION = "0.23.3";

export interface HostExit {
  code: number | null;
  signal: string | null;
}

/** What a session's live notification feed has done, for answering "did it go quiet, or was it idle?". */
export interface SessionNotifyStats {
  /** Epoch milliseconds of the last notification routed to this session. */
  lastAt: number;
  count: number;
  byMethod: Record<string, number>;
}

/** How many sessions keep notification stats. Oldest are dropped first; this is a debugging aid. */
const NOTIFY_STATS_LIMIT = 200;

export interface HostHandle {
  start(version: string): Promise<unknown>;
  connection: CommandConnection;
  close(): Promise<unknown>;
  onExit?(handler: (exit: HostExit) => void): void;
  readonly recentStderr?: string;
}

export type HostFactory = (target: ServeTarget) => HostHandle;

export type OpenTarget = "files" | "editor";
export type Opener = (path: string, target: OpenTarget) => Promise<void>;

const realHostFactory: HostFactory = (target) => new HeliconMspHost(target);

/** The shape of a spawned `muse login` child the route needs: readable output and a way to kill it. */
export interface LoginChild {
  stdout: Readable;
  stderr: Readable;
  on(event: "close" | "error", listener: (arg: unknown) => void): void;
  kill(): void;
}

/** Spawns `muse login` for a profile. `env` is the profile's overlay; the real impl spreads it over `process.env`. */
export type LoginSpawn = (command: string, args: string[], opts: { env: Record<string, string> }) => LoginChild;

const defaultLoginSpawn: LoginSpawn = (command, args, opts) =>
  spawn(command, args, {
    cwd: homedir(),
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as LoginChild;

/** Runs a `!` command where the workspace is, and hands back what it printed. */
export type ShellRunner = (
  command: string,
  args: string[],
) => Promise<{ output: string; exitCode: number | null; truncated: boolean }>;

/**
 * Who may frame the UI the server serves. `'self'` covers the UI framing its own file previews. The
 * editor extension frames it from a webview, whose page (and the pages above it, which
 * `frame-ancestors` also checks) sits on `vscode-webview:` and `vscode-file:` in VS Code and its forks,
 * or on `*.vscode-cdn.net` in the browser build. Loopback hosts cover local dev shells. The desktop app
 * and the landing demo load the UI top-level or from their own bundle, so they need no entry here.
 * Embedders not listed (a self-hosted code-server, say) are added with `--frame-ancestor`.
 */
export const FRAME_ANCESTORS = [
  "'self'",
  "vscode-webview:",
  "vscode-file:",
  "https://*.vscode-cdn.net",
  "http://127.0.0.1:*",
  "http://localhost:*",
];

/** The `Content-Security-Policy` value that limits who may frame the UI. */
export function frameAncestorsPolicy(extra: string[] = []): string {
  const safe = extra.filter((source) => /^[^\s;,'"]+$/.test(source));
  return `frame-ancestors ${[...FRAME_ANCESTORS, ...safe].join(" ")}`;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  staticDir?: string | null;
  token?: string | null;
  /** Browser origins allowed to reach this daemon from another site. Empty means same-origin only. */
  allowOrigins?: string[];
  /** Extra page origins allowed to frame the UI, on top of `FRAME_ANCESTORS`. */
  frameAncestors?: string[];
  platform?: string;
  distro?: string;
  musePath?: string | null;
  /** Named Muse profiles. Defaults to a real aonia over ~/.aonia; injected in tests. */
  aonia?: Aonia;
  /** How eagerly a quiet session's view is paged; the defaults suit a real Muse, tests shorten them. */
  tailTiming?: Partial<ViewTailTiming>;
  /** On Windows: `native` runs Windows Muse, `wsl` runs Muse in WSL, `auto` (the default) prefers native once installed. */
  runtime?: RuntimePreference;
  /** Finds native Windows Muse; the real install folders by default. */
  findNativeMuse?: () => NativeMuse | null;
  hostFactory?: HostFactory;
  opener?: Opener;
  /** Where `~` points in typed paths; the OS home by default. */
  home?: string;
  /** Days without activity before a thread settles on its own; null turns auto-settle off. */
  autoSettleDays?: number | null;
  /** Runs `muse` CLI calls, like listing skills; the real process runner by default. */
  exec?: ExecFn;
  /** Runs short `ssh` commands for SSH projects (folder listings, the remote `$HOME`); the real `ssh` by default. */
  sshRun?: SshRunFn;
  /** Runs the user's own `!` commands; spawns a real process by default. */
  shellRunner?: ShellRunner;
  /** Spawns `muse login` for the device-code route; a thin wrapper over `node:child_process` spawn by default. */
  loginSpawn?: LoginSpawn;
}

interface ManagedHost {
  key: string;
  accountId: string | null;
  target: ServeTarget;
  handle: HostHandle;
  manager: SessionManager;
  serverVersion: string | null;
  startedAt: string;
}

/** What the server knows about a session's live run, derived from the MSP view stream. */
/** A session's goal block, kept so the sidebar can show goals in threads the UI has not opened. */
export interface GoalBlock {
  objective: string;
  status: string;
  percentComplete: number;
  currentWork?: string;
  nextWork?: string;
}

interface LiveState {
  activeTurnId: string | null;
  turnStartedAt: string | null;
  pendingApprovals: Set<string>;
  pendingInputs: Set<string>;
  lastTerminal: string | null;
  lastError: string | null;
  goal: GoalBlock | null;
  /** Bumped on every live goal change, so a slow transcript load never writes an older goal over a newer one. */
  goalSeq: number;
  /** Monitors the agent started that are still watching (a `monitor` tool call in progress), by item id. */
  monitors: Set<string>;
}

export interface LiveView {
  activeTurnId: string | null;
  turnStartedAt: string | null;
  pendingApprovals: number;
  pendingInputs: number;
  lastTerminal: string | null;
  lastError: string | null;
  goal: GoalBlock | null;
  /** How many monitors are watching in the background; the thread can be idle while they do. */
  monitors: number;
}

/** A `session/goalChanged` goal: null clears it; undefined means the block is not a goal (no objective). */
function goalOf(value: unknown): GoalBlock | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  const objective = record ? str(record["objective"]) : null;
  if (!record || !objective) {
    return undefined;
  }
  const currentWork = str(record["currentWork"]);
  const nextWork = str(record["nextWork"]);
  return {
    objective,
    status: str(record["status"]) ?? "active",
    percentComplete: num(record["percentComplete"]) ?? 0,
    ...(currentWork ? { currentWork } : {}),
    ...(nextWork ? { nextWork } : {}),
  };
}

type SseSink = (event: string, data: unknown) => void;

const MAX_HISTORY_PAGES = 4;
const HISTORY_PAGE_SIZE = 1000;
/** Events per page when following a quiet session; one that fell far behind takes several pages. */
const TAIL_PAGE_SIZE = 200;
/** Newest threads kept per discovery, newest first; `session/list` pages are at most 200 rows. */
const DISCOVER_LIMIT = 500;
const DISCOVER_PAGE_SIZE = 200;
/** Rows read in all, subagent rows included, so a host with a huge history cannot stall a refresh. */
const DISCOVER_SCAN_LIMIT = 3000;

/** A subagent's own session belongs to the thread that spawned it, not to the list. */
function isSubagentRow(item: unknown): boolean {
  const record = asRecord(item);
  const session = (record && asRecord(record["session"])) ?? record;
  return session?.["kind"] === "subagent";
}
/** Echo-titled threads one discovery may hand to the titler. Each is a model call on the user's plan, so it is a
 * handful of recent threads rather than a whole history. */
const TITLE_BACKFILL_LIMIT = 30;
const ENV_CACHE_MS = 30_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const AUTO_SETTLE_SWEEP_MS = 60_000;
const LOGIN_TIMEOUT_MS = 30_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const found = str(record[key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function isWindowsAbs(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isWslAbs(path: string): boolean {
  return path.startsWith("/");
}

function nowIso(): string {
  return new Date().toISOString();
}

function lastLines(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
}

/** Runs a command to completion; rejects with the tail of its stderr. */
/** Output kept from a `!` command Helicon runs itself, and how long it may run. */
const MAX_SHELL_OUTPUT = 64 * 1024;
const SHELL_TIMEOUT_MS = 2 * 60_000;

/** Runs a program and keeps what it printed, both streams together, as a terminal would show it. */
function runCapture(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let truncated = false;
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_SHELL_OUTPUT) {
        output = output.slice(-MAX_SHELL_OUTPUT);
        truncated = true;
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      truncated = true;
      output += "\n[stopped: the command ran longer than two minutes]";
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ output: `${output}\n${error.message}`.trim(), exitCode: null, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ output, exitCode: code, truncated });
    });
  });
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      // Fail fast on a private repository instead of waiting for a password nobody can type.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        WSLENV: [process.env["WSLENV"], "GIT_TERMINAL_PROMPT/u"].filter(Boolean).join(":"),
      },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill();
      fail(new HttpError(504, "The clone took too long and was stopped."));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new HttpError(500, `Could not run ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done();
      } else {
        fail(new HttpError(500, lastLines(stderr) || `${command} exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

/** MSP timestamps carry microseconds; store them in JS ISO form so they sort as strings. */
export function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Why an SSH project cannot run on a named account. */
const SSH_ACCOUNT_MESSAGE =
  "SSH projects run on the remote host's own Muse login, so they cannot use a local account. Use the default login.";

function normalizeCwd(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("ssh://")) {
    const normal = normalizeSshCwd(trimmed);
    if (!normal) {
      throw new PathError("SSH projects look like ssh://host/absolute/path.");
    }
    return normal;
  }
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed) || trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/[\\/]+$/, "");
}

/** A name safe to write into a workspace: the base name only, and nothing that needs quoting. */
export function safeFileName(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 80);
  return clean.length > 0 ? clean : "file";
}

export { deriveTitle };

function errorInfo(error: unknown): { status: number; message: string; kind: string | null } {
  if (error instanceof HttpError) {
    return { status: error.status, message: error.message, kind: null };
  }
  const kind = typeof (error as { kind?: unknown })?.kind === "string" ? ((error as { kind: string }).kind) : null;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PathError) {
    return { status: 400, message, kind: null };
  }
  if (error instanceof SshError) {
    return { status: error.status, message, kind: null };
  }
  if (error instanceof FileError) {
    return { status: error.status, message, kind: error.kind };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, message: "Request body is not valid JSON.", kind: null };
  }
  if (kind === "sessionNotFound" || kind === "notFound" || kind === "approvalNotFound" || kind === "userInputNotFound") {
    return { status: 404, message, kind };
  }
  if (kind) {
    return { status: 409, message, kind };
  }
  return { status: 500, message, kind: null };
}

function stripSource(params: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...params };
  delete rest["sourceRange"];
  return rest;
}

function stripEvent(event: unknown): { method: string; params: Record<string, unknown> } | null {
  const record = asRecord(event);
  const method = record ? str(record["method"]) : null;
  const params = record ? asRecord(record["params"]) : null;
  if (!method || !params) {
    return null;
  }
  return { method, params: stripSource(params) };
}

/** What a `session/read` or `session/resume` reply says about where the view ends and what is running. */
function recordView(reply: unknown): SessionRecordView | undefined {
  const record = asRecord(reply);
  const session = asRecord(record?.["session"]);
  if (!record || !session) {
    return undefined;
  }
  const head = str(record["viewCursor"]);
  const activeTurnId = str(session["activeTurnId"]);
  const updatedAt = str(session["updatedAt"]);
  // A session whose projection is unavailable reports an empty cursor, which is no head at all. Its
  // update time still moves with every event, so that is what says whether there is anything to page.
  return { head, activeTurnId, stamp: updatedAt ? `${updatedAt} ${activeTurnId ?? ""} ${head ?? ""}` : null };
}

/** The position of the newest event in a history read oldest first; `null` when the view is empty. */
function newestCursor(events: { params: Record<string, unknown> }[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const cursor = events[index]?.params["viewCursor"];
    if (typeof cursor === "string") {
      return cursor;
    }
  }
  return null;
}

function asHistoryItem(value: unknown): Record<string, unknown> | null {
  const item = asRecord(value);
  return item && typeof item["itemId"] === "string" ? item : null;
}

/** Folded items from `session/read`, which works even when another host holds the session. */
export function eventsFromHistory(payload: unknown): { method: string; params: Record<string, unknown> }[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  const history = asRecord(record["history"]) ?? record;
  const fromInline = Array.isArray(history["items"]) ? history["items"] : [];
  const snapshot = asRecord(history["snapshot"]);
  const state = asRecord(snapshot?.["state"]);
  const fromSnapshot = Array.isArray(state?.["items"]) ? state["items"] : [];
  const bag = asRecord(state?.["items"]);
  const order = Array.isArray(state?.["order"]) ? state["order"] : bag ? Object.keys(bag) : [];
  const fromBag = bag ? order.map((id) => bag[String(id)]) : [];
  const items = [...fromInline, ...fromSnapshot, ...fromBag].map(asHistoryItem).filter((item): item is Record<string, unknown> => item !== null);
  const seen = new Set<string>();
  const events: { method: string; params: Record<string, unknown> }[] = [];
  for (const item of items) {
    const id = String(item["itemId"]);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    events.push({ method: "item/completed", params: { item: stripSource(item) } });
  }
  return events;
}

/** A live MSP notification reshaped for the browser: session-scoped, provenance stripped. */
export function toWireEvent(
  method: string,
  params: Record<string, unknown>,
  at?: number,
): { type: "msp"; sessionId: string; method: string; params: Record<string, unknown>; at: number } | null {
  const session = asRecord(params["session"]);
  const sessionId = str(params["sessionId"]) ?? (session ? str(session["sessionId"]) : null);
  if (!sessionId) {
    return null;
  }
  return { type: "msp", sessionId, method, params: stripSource(params), at: at ?? Date.now() };
}

const CMD_UNSAFE = /[&|<>^%!"\r\n]/;

export function defaultOpener(platform: string): Opener {
  return (path, target) =>
    new Promise<void>((resolveOpen, rejectOpen) => {
      let command: string;
      let args: string[];
      if (platform === "win32") {
        if (CMD_UNSAFE.test(path)) {
          rejectOpen(new HttpError(400, "That folder path contains characters Helicon will not pass to the shell."));
          return;
        }
        [command, args] = target === "editor" ? ["cmd.exe", ["/d", "/c", "code", path]] : ["explorer.exe", [path]];
      } else if (platform === "darwin") {
        [command, args] = target === "editor" ? ["code", [path]] : ["open", [path]];
      } else {
        [command, args] = target === "editor" ? ["code", [path]] : ["xdg-open", [path]];
      }
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", (error) =>
        rejectOpen(
          new HttpError(
            500,
            target === "editor"
              ? `Could not launch VS Code (${error.message}). Make sure the \`code\` command is on your PATH.`
              : `Could not open the folder (${error.message}).`,
          ),
        ),
      );
      child.once("spawn", () => {
        child.unref();
        resolveOpen();
      });
    });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

interface EnvView {
  platform: string;
  runtime: MuseRuntime;
  wslAvailable: boolean;
  defaultDistro: string | null;
  museFound: boolean;
  musePath: string | null;
  /** Whether the default Muse login has credentials; null when Helicon cannot tell (WSL, or no Muse). */
  museSignedIn: boolean | null;
  /** Whether an `ssh` client runs here, which SSH projects need. */
  sshFound: boolean;
  version: string;
  persistent: boolean;
}

export interface SkillView {
  id: string;
  name: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  scope: string;
  activation: string;
  /** What the skill expects after its name, when it says. */
  argumentHint?: string | null;
}

/**
 * The skills Muse reports for a loaded session, joined to the CLI listing. The session's list is the truth about
 * what can be invoked there; the CLI listing is still where each skill's file lives, so the join keeps its id.
 * Bundled skills list as `bundled:<name>` in the CLI and plugin skills as `plugin:<selector>`.
 */
export function mergeSessionSkills(rows: readonly SessionSkill[], cli: readonly SkillView[]): SkillView[] {
  const byKey = new Map<string, SkillView>();
  for (const skill of cli) {
    byKey.set(skill.id, skill);
    if (!byKey.has(skill.name)) {
      byKey.set(skill.name, skill);
    }
  }
  return rows.map((row) => {
    const match = byKey.get(row.selector) ?? byKey.get(`plugin:${row.selector}`) ?? null;
    return {
      id: match?.id ?? row.selector,
      name: row.selector,
      displayName: row.displayName,
      description: row.description || match?.description || "",
      shortDescription: match?.shortDescription ?? null,
      scope: match?.scope ?? row.source,
      activation: match?.activation ?? "on",
      argumentHint: row.argumentHint,
    };
  });
}

/** One workspace's skills. Where each SKILL.md lives stays on the server; the browser only names skills by id. */
interface SkillListing {
  at: number;
  skills: SkillView[];
  paths: Map<string, string>;
  error: string | null;
}

/** Parses `muse skills list --json`, leaving out skills switched off. Null when the output is not that JSON. */
export function parseSkillList(stdout: string): { skills: SkillView[]; paths: Map<string, string> } | null {
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (!root || !Array.isArray(root["skills"])) {
    return null;
  }
  const skills: SkillView[] = [];
  const paths = new Map<string, string>();
  for (const entry of root["skills"]) {
    const r = asRecord(entry);
    const id = r ? str(r["id"]) : null;
    if (!r || !id || str(r["activation"]) === "off") {
      continue;
    }
    const name = str(r["name"]) ?? id;
    skills.push({
      id,
      name,
      displayName: str(r["display_name"]) ?? name,
      description: str(r["description"]) ?? "",
      shortDescription: str(r["short_description"]),
      scope: str(r["scope"]) ?? "unknown",
      activation: str(r["activation"]) ?? "on",
    });
    const path = str(r["path"]);
    if (path) {
      paths.set(id, path);
    }
  }
  return { skills, paths };
}

/** A SKILL.md body without its YAML frontmatter. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim();
}

const SKILL_CACHE_MS = 60_000;

/** One page of a tool's stored output; Muse serves at most 6 MiB a request, and a browser needs far less at once. */
const OUTPUT_PAGE_BYTES = 1024 * 1024;

/** Attachment limits: enough for a screenshot or a PDF, not enough to wedge the host. */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_BODY_BYTES = 96 * 1024 * 1024;
/** Where a non-image attachment lands inside the workspace, so Muse's own tools can open it. */
const ATTACHMENT_DIR = [".helicon", "attachments"];

interface PreparedAttachment {
  name: string;
  mediaType: string;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  bytes: Buffer;
}

export class HeliconServer {
  private readonly server: Server;
  private readonly store: HeliconStore;
  private readonly aonia: Aonia;
  private readonly hosts = new Map<string, ManagedHost>();
  private readonly starting = new Map<string, Promise<ManagedHost>>();
  /** Restarts queued by a settings flip, oldest first. Hosts are only acquired past the tail. */
  private restartChain: Promise<void> = Promise.resolve();
  private readonly fingerprints = new Map<string, unknown>();
  private readonly sinks = new Set<SseSink>();
  private readonly live = new Map<string, LiveState>();
  private readonly sessionHosts = new Map<string, string>();
  private readonly opener: Opener;
  private readonly titleQueue: string[] = [];
  private titleWorker: Promise<void> | null = null;
  /** Echo-titled sessions still owed one LLM title attempt; user-named and Muse-named threads never land here. */
  private readonly titleUpgradePending = new Set<string>();
  /** Upgrades with a model call in flight, so discovery cannot queue a second one for the same thread. */
  private readonly titleUpgradeActive = new Set<string>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private envCache: { at: number; value: EnvView } | null = null;
  private readonly skillCache = new Map<string, SkillListing>();
  /** Remote `$HOME` answers per SSH host, so `~` expansion costs one round trip a minute at most. */
  private readonly sshHomeCache = new Map<string, { home: string; at: number }>();
  /** The newest subscription window any host reported; `usage/changed` carries no session, so it lives here. */
  private planUsage: SubscriptionUsage | null = null;
  /** The newest window per account, keyed by aonia profile id. The default login is not keyed here. */
  private readonly planUsageByAccount = new Map<string, SubscriptionUsage>();
  /** The reasoning effort each session is known to be running at, so a turn only re-sets it when it changes. */
  private readonly effortApplied = new Map<string, ReasoningEffort>();
  private lastHostError: string | null = null;
  /**
   * Per-session notification health. #42 reported live notifications stopping mid-session while the
   * durable log completed and sibling sessions kept flowing; nothing here could tell that apart from
   * a backend that simply had nothing to say. Bounded to the most recently seen sessions.
   */
  private readonly notifyStats = new Map<string, SessionNotifyStats>();
  /**
   * Pages the view of any session whose push feed has gone quiet, so a thread need not depend on
   * push alone. Only while the feed setting's catch-up is on; otherwise it stands by and does nothing.
   */
  private readonly tail: ViewTail;
  private protocolErrors = 0;
  private lastProtocolError: string | null = null;
  private forwardFailures = 0;
  private lastForwardFailure: string | null = null;
  /** Notifications that carried no sessionId, so nothing could be routed from them. */
  private unroutedByMethod = new Map<string, number>();
  /** Where Muse runs, once known; see `museRuntime`. */
  private runtimeKnown: MuseRuntime | null = null;
  private closed = false;
  private readonly options: Required<
    Omit<
      ServerOptions,
      | "staticDir"
      | "token"
      | "platform"
      | "distro"
      | "musePath"
      | "hostFactory"
      | "opener"
      | "exec"
      | "findNativeMuse"
      | "aonia"
      | "loginSpawn"
      | "tailTiming"
    >
  > &
    Pick<ServerOptions, "staticDir" | "token" | "findNativeMuse"> & {
      platform: string;
      distro?: string;
      musePath?: string | null;
      hostFactory: HostFactory;
      exec: ExecFn;
      loginSpawn: LoginSpawn;
    };
  /** `muse login` children in flight, keyed by account id; a reopened modal kills and replaces the old one. */
  private readonly loginChildren = new Map<string, LoginChild>();

  constructor(options: ServerOptions = {}) {
    this.options = {
      port: options.port ?? 3127,
      host: options.host ?? "127.0.0.1",
      dataDir: options.dataDir ?? ":memory:",
      staticDir: options.staticDir ? resolve(options.staticDir) : null,
      token: options.token ?? null,
      allowOrigins: options.allowOrigins ?? [],
      frameAncestors: options.frameAncestors ?? [],
      platform: options.platform ?? process.platform,
      distro: (options.distro ?? process.env["HELICON_WSL_DISTRO"])?.trim() || undefined,
      musePath: options.musePath,
      runtime: options.runtime ?? parseRuntimePreference(process.env["HELICON_MUSE_RUNTIME"]),
      findNativeMuse: options.findNativeMuse,
      hostFactory: options.hostFactory ?? realHostFactory,
      home: options.home ?? homedir(),
      autoSettleDays: options.autoSettleDays === undefined ? 3 : options.autoSettleDays,
      exec: options.exec ?? defaultExec,
      sshRun: options.sshRun ?? defaultSshRun,
      shellRunner: options.shellRunner ?? ((command, args) => runCapture(command, args, undefined, SHELL_TIMEOUT_MS)),
      loginSpawn: options.loginSpawn ?? defaultLoginSpawn,
    };
    this.opener = options.opener ?? defaultOpener(this.options.platform);
    this.tail = new ViewTail(
      {
        page: (sessionId, cursor) => this.pageForward(sessionId, cursor),
        read: async (sessionId) => {
          const manager = this.loadedManager(sessionId);
          return manager ? this.readRecord(manager, sessionId) : undefined;
        },
        deliver: (sessionId, event) => this.deliver(sessionId, event),
        believed: (sessionId) => this.believed(sessionId),
        confirmed: (sessionId, activeTurnId) => this.emit("helicon", { type: "feed", sessionId, activeTurnId, at: Date.now() }),
        corrected: (sessionId, activeTurnId) => this.correctActiveTurn(sessionId, activeTurnId),
        log: (message) => this.log(message),
      },
      { ...DEFAULT_TAIL_TIMING, ...options.tailTiming },
    );
    this.store = new HeliconStore(
      this.options.dataDir === ":memory:" ? ":memory:" : join(this.options.dataDir, "helicon.db"),
    );
    // Catching up is a mode the user switches on; until then the tail is inert.
    this.tail.setEnabled(this.store.getFeedSettings().catchUp);
    this.aonia = options.aonia ?? createAonia(this.options.musePath ? { musePath: this.options.musePath } : {});
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((error) => this.fail(res, 500, String(error)));
    });
  }

  async listen(): Promise<{ port: number; host: string }> {
    await new Promise<void>((resolve) => this.server.listen(this.options.port, this.options.host, resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    // No sweep at startup: which threads are busy in other Muse clients is only known after discovery.
    this.settleTimer = setInterval(() => this.autoSettle(), AUTO_SETTLE_SWEEP_MS);
    this.settleTimer.unref?.();
    this.tail.start();
    return { port, host: this.options.host };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
    this.tail.stop();
    this.titleQueue.length = 0;
    for (const sink of [...this.sinks]) {
      this.sinks.delete(sink);
    }
    for (const pending of this.starting.values()) {
      await pending.catch(() => undefined);
    }
    for (const managed of this.hosts.values()) {
      try {
        await managed.handle.close();
      } catch {
        /* best effort */
      }
    }
    this.hosts.clear();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
    await this.titleWorker?.catch(() => undefined);
    this.store.close();
  }

  private emit(type: string, data: unknown): void {
    for (const sink of this.sinks) {
      try {
        sink(type, data);
      } catch {
        /* drop broken sinks on next write */
      }
    }
  }

  /** Coalesce bursts (discovery, title backfill) into one sidebar refresh. */
  private sessionsChanged(): void {
    if (this.changeTimer || this.closed) {
      return;
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit("helicon", { type: "sessions-changed" });
    }, 120);
  }

  /** What the event stream authenticates with, since EventSource cannot be given a header. */
  private static readonly AUTH_COOKIE = "helicon_token";

  /**
   * The origin of a request that came from a different site. A browser sends `Origin` on its own
   * writes too, so comparing against `Host` is what separates "another site" from "this one".
   */
  private foreignOrigin(req: IncomingMessage): string | null {
    const origin = req.headers["origin"];
    if (typeof origin !== "string" || !origin) {
      return null;
    }
    const host = typeof req.headers["host"] === "string" ? req.headers["host"] : "";
    if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
      return null;
    }
    return origin;
  }

  private cookie(req: IncomingMessage, name: string): string | null {
    const raw = req.headers["cookie"];
    if (typeof raw !== "string") {
      return null;
    }
    for (const part of raw.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key === name) {
        return decodeURIComponent(rest.join("="));
      }
    }
    return null;
  }

  /**
   * Cross-origin access is opt-in and fails closed: an origin nobody listed gets no CORS headers and
   * no answer at all. Same-origin requests carry no foreign origin and are left exactly as they were.
   */
  private cors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = this.foreignOrigin(req);
    if (!origin) {
      return true;
    }
    if (!this.options.allowOrigins.includes(origin)) {
      return false;
    }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "authorization, content-type, range");
    res.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    return true;
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.options.token) {
      return true;
    }
    if (this.cookie(req, HeliconServer.AUTH_COOKIE) === this.options.token) {
      return true;
    }
    if (req.headers["authorization"] === `Bearer ${this.options.token}`) {
      return true;
    }
    // A token in the URL leaks through history, server logs and any shared link, so it counts only
    // for requests carrying no foreign origin: curl, the desktop shell, the page served from here.
    if (this.foreignOrigin(req)) {
      return false;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token") === this.options.token;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  }

  private fail(res: ServerResponse, status: number, message: string, kind: string | null = null): void {
    if (!res.headersSent) {
      this.json(res, status, { error: message, kind });
    } else {
      res.end();
    }
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        throw new HttpError(413, "That request is too large.");
      }
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) {
      return {};
    }
    return asRecord(JSON.parse(text) as unknown) ?? {};
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    if (!this.cors(req, res)) {
      this.fail(res, 403, "This daemon does not answer that origin.");
      return;
    }
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // The handshake is how a browser earns its cookie, so it cannot itself demand one.
    if (!(method === "POST" && path === "/api/auth") && !this.authorized(req)) {
      this.fail(res, 401, "Missing or invalid token.");
      return;
    }
    if (path.startsWith("/api/")) {
      try {
        const handled = await this.api(method, path, url, req, res);
        if (!handled) {
          this.fail(res, 404, "Not found.");
        }
      } catch (error) {
        const info = errorInfo(error);
        this.fail(res, info.status, info.message, info.kind);
      }
      return;
    }
    if (this.options.staticDir && method === "GET") {
      const served = await this.serveStatic(path, res);
      if (served) {
        return;
      }
    }
    this.fail(res, 404, "Not found.");
  }

  private async api(
    method: string,
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (method === "POST" && path === "/api/auth") {
      const body = await this.readBody(req);
      if (!this.options.token) {
        // Nothing to prove: a daemon started without a token answers whoever can reach it.
        this.json(res, 200, { ok: true, required: false });
        return true;
      }
      if (str(body["token"]) !== this.options.token) {
        throw new HttpError(401, "That token does not match this daemon.");
      }
      // The stream cannot carry a header, so the cookie is what it authenticates with. Cross-site
      // cookies are only accepted over HTTPS, which is why a remote daemon needs TLS or a tunnel.
      const cross = this.foreignOrigin(req) !== null;
      const cookie = [
        `${HeliconServer.AUTH_COOKIE}=${encodeURIComponent(this.options.token)}`,
        "Path=/",
        "HttpOnly",
        "Max-Age=604800",
        cross ? "SameSite=None" : "SameSite=Lax",
      ];
      if (cross) {
        cookie.push("Secure");
      }
      res.setHeader("set-cookie", cookie.join("; "));
      this.json(res, 200, { ok: true, required: true });
      return true;
    }
    if (method === "GET" && path === "/api/health") {
      this.json(res, 200, {
        ok: true,
        version: HELICON_VERSION,
        hosts: [...this.hosts.values()].map((h) => ({
          key: h.key,
          serverVersion: h.serverVersion,
          startedAt: h.startedAt,
        })),
        lastHostError: this.lastHostError,
        fingerprintWarnings: Object.fromEntries(this.fingerprints),
        // Enough to answer "has this session's feed gone quiet, and did anything get dropped?".
        diagnostics: {
          now: new Date().toISOString(),
          protocolErrors: this.protocolErrors,
          lastProtocolError: this.lastProtocolError,
          forwardFailures: this.forwardFailures,
          lastForwardFailure: this.lastForwardFailure,
          unroutedByMethod: Object.fromEntries(this.unroutedByMethod),
          // Sessions whose view had to be paged; `recovered` counts events push never delivered.
          tail: this.tail.stats(),
          sessions: Object.fromEntries(
            [...this.notifyStats].map(([id, stats]) => [
              id,
              {
                lastNotificationAt: new Date(stats.lastAt).toISOString(),
                quietForMs: Date.now() - stats.lastAt,
                count: stats.count,
                byMethod: stats.byMethod,
              },
            ]),
          ),
        },
      });
      return true;
    }
    if (method === "GET" && path === "/api/env") {
      this.json(res, 200, await this.environment(url.searchParams.get("refresh") === "1"));
      return true;
    }
    if (method === "GET" && path === "/api/events") {
      this.serveEvents(res);
      return true;
    }
    if (method === "GET" && path === "/api/projects") {
      this.json(res, 200, {
        projects: this.store.listProjects().map((p) => ({
          cwd: p.cwd,
          displayName: p.displayName,
          pinned: p.pinned,
          activityAt: p.activityAt,
          defaultAccountId: p.defaultAccountId,
        })),
      });
      return true;
    }
    if (method === "POST" && path === "/api/projects") {
      const body = await this.readBody(req);
      const raw = str(body["cwd"]);
      if (!raw || !raw.trim()) {
        throw new HttpError(400, "cwd is required.");
      }
      const cwd = await this.canonicalCwd(raw, body["create"] === true);
      this.json(res, 200, await this.addProjectFolder(cwd));
      return true;
    }
    if (method === "POST" && path === "/api/projects/clone") {
      const body = await this.readBody(req);
      const remote = str(body["url"])?.trim() ?? "";
      const target = str(body["path"])?.trim() ?? "";
      if (!remote || !target) {
        throw new HttpError(400, "url and path are required.");
      }
      if (!/^(https?:\/\/|ssh:\/\/|git:\/\/)\S+$/.test(remote) && !/^git@[^\s:]+:\S+$/.test(remote)) {
        throw new HttpError(400, "That does not look like a Git URL.");
      }
      const cwd = normalizeCwd(await this.cloneRepository(remote, target));
      this.json(res, 200, await this.addProjectFolder(cwd));
      return true;
    }
    if (method === "GET" && path === "/api/fs/list") {
      const target = url.searchParams.get("path") ?? "";
      if (target.trim().startsWith("ssh://")) {
        this.json(res, 200, await this.listSshFolder(target));
        return true;
      }
      this.json(res, 200, await listDirectory(target, await this.pathContext(target)));
      return true;
    }
    if (path.startsWith("/api/files/")) {
      return this.files(method, path, url, req, res);
    }
    if (method === "POST" && path === "/api/fs/reveal") {
      const body = await this.readBody(req);
      const target = str(body["path"]);
      if (!target) {
        throw new HttpError(400, "path is required.");
      }
      if (target.trim().startsWith("ssh://")) {
        throw new HttpError(400, "Opening remote folders is not available for SSH projects in this version.");
      }
      const resolved = resolveUserPath(target, await this.pathContext(target));
      const info = await stat(resolved.local).catch(() => null);
      if (!info?.isDirectory()) {
        throw new HttpError(404, "That folder does not exist.");
      }
      await this.opener(resolved.local, "files");
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "DELETE" && path === "/api/projects") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) {
        throw new HttpError(400, "cwd is required.");
      }
      this.store.setHidden(cwd, true);
      this.sessionsChanged();
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "PATCH" && path === "/api/projects/order") {
      const body = await this.readBody(req);
      const raw = body["cwds"];
      if (!Array.isArray(raw)) {
        throw new HttpError(400, "cwds is required.");
      }
      this.store.setProjectOrder(raw.filter((cwd): cwd is string => typeof cwd === "string" && cwd.trim().length > 0).map(normalizeCwd));
      this.sessionsChanged();
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "PATCH" && path === "/api/projects/pin") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]);
      if (!cwd) {
        throw new HttpError(400, "cwd is required.");
      }
      this.store.upsertProject(cwd);
      this.store.setPinned(cwd, body["pinned"] === true);
      this.sessionsChanged();
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "GET" && path === "/api/slash") {
      const listing = await this.listSkills(normalizeCwd(url.searchParams.get("cwd") ?? ""), url.searchParams.get("sessionId"));
      this.json(res, 200, { skills: listing.skills, error: listing.error });
      return true;
    }
    if (method === "GET" && path === "/api/slash/skill") {
      const id = url.searchParams.get("id");
      if (!id) {
        throw new HttpError(400, "id is required.");
      }
      const body = await this.skillBody(normalizeCwd(url.searchParams.get("cwd") ?? ""), id);
      this.json(res, 200, { id, body });
      return true;
    }
    if (method === "GET" && path === "/api/sessions") {
      const cwd = url.searchParams.get("cwd");
      const includeArchived = url.searchParams.get("archived") === "1";
      const projects = cwd
        ? [this.store.getProject(cwd)].filter((p): p is NonNullable<typeof p> => p !== null)
        : this.store.listProjects();
      const sessions = projects.flatMap((project) =>
        this.store
          .listSessionsByProject(project.id, { includeArchived })
          .map((record) => this.summary(record, project.cwd)),
      );
      this.json(res, 200, { sessions });
      return true;
    }
    if (method === "POST" && path === "/api/discover") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]) ?? undefined;
      this.json(res, 200, { sessions: await this.discover(cwd) });
      return true;
    }
    if (method === "POST" && path === "/api/sessions") {
      const body = await this.readBody(req);
      const raw = str(body["cwd"]);
      if (!raw) {
        throw new HttpError(400, "cwd is required.");
      }
      const mode = body["approvalMode"];
      if (mode !== undefined && mode !== null && !isApprovalMode(mode)) {
        throw new HttpError(400, "Unknown approvalMode.");
      }
      const accountRaw = body["accountId"];
      if (accountRaw !== undefined && accountRaw !== null && typeof accountRaw !== "string") {
        throw new HttpError(400, "accountId must be a string.");
      }
      const session = await this.startSession(
        normalizeCwd(raw),
        mode === undefined || mode === null ? undefined : (mode as ApprovalMode),
        str(body["modelId"]) ?? undefined,
        typeof accountRaw === "string" && accountRaw.length > 0 ? accountRaw : null,
      );
      this.json(res, 200, { session });
      return true;
    }

    const proxyMatch = path.match(/^\/api\/sessions\/([^/]+)\/shell-proxy$/);
    if (method === "POST" && proxyMatch) {
      const sessionId = decodeURIComponent(proxyMatch[1] as string);
      const body = await this.readBody(req);
      const command = str(body["command"])?.trim();
      if (!command) {
        throw new HttpError(400, "command is required.");
      }
      const found = this.store.findSession(sessionId);
      if (!found) {
        throw new HttpError(404, "Unknown session.");
      }
      if (isSshCwd(found.cwd)) {
        throw new HttpError(400, "The shell proxy is not available for SSH projects in this version. Run the command with ! in the thread instead.");
      }
      const result = await this.runInWorkspace(found.cwd, command);
      const run = this.store.addShellRun({
        id: randomUUID(),
        sessionId,
        command,
        exitCode: result.exitCode,
        output: result.output,
        truncated: result.truncated,
        durationMs: result.durationMs,
        at: nowIso(),
      });
      this.store.updateSession(sessionId, { activityAt: nowIso() });
      this.emit("helicon", { type: "shell-run", sessionId, run });
      this.json(res, 200, { run });
      return true;
    }

    const outputMatch = path.match(/^\/api\/sessions\/([^/]+)\/output$/);
    if (method === "GET" && outputMatch) {
      const sessionId = decodeURIComponent(outputMatch[1] as string);
      const itemId = url.searchParams.get("itemId");
      const outputRef = url.searchParams.get("outputRef");
      if (!itemId || !outputRef) {
        throw new HttpError(400, "itemId and outputRef are required.");
      }
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      const length = Number.parseInt(url.searchParams.get("length") ?? String(OUTPUT_PAGE_BYTES), 10);
      const manager = await this.managerForSession(sessionId);
      const range = await manager.readItemOutput(sessionId, itemId, outputRef, {
        offsetBytes: Number.isFinite(offset) && offset > 0 ? offset : 0,
        lengthBytes: Number.isFinite(length) && length > 0 ? Math.min(length, OUTPUT_PAGE_BYTES) : OUTPUT_PAGE_BYTES,
      });
      this.json(res, 200, { output: range });
      return true;
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(resume|model|approval-mode|compact|shell|fork|side|effort|goal|subagent|tasks|workflow))?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1] as string);
      const action = sessionMatch[2];
      if (method === "PATCH" && !action) {
        const body = await this.readBody(req);
        const found = this.store.findSession(sessionId);
        if (!found) {
          throw new HttpError(404, "Unknown session.");
        }
        const title = typeof body["title"] === "string" ? body["title"].trim().slice(0, 200) : undefined;
        const settled = typeof body["settled"] === "boolean" ? body["settled"] : undefined;
        if (settled === true && this.isBusy(sessionId)) {
          throw new HttpError(409, "Stop the running turn and answer its requests before settling this thread.");
        }
        if (title && title !== found.session.title) {
          await this.renameInMuse(sessionId, title);
        }
        const record = this.store.updateSession(sessionId, {
          ...(title ? { title, titleSource: "user" as const } : {}),
          ...(typeof body["archived"] === "boolean" ? { archived: body["archived"] } : {}),
          ...(typeof body["pinned"] === "boolean" ? { pinned: body["pinned"] } : {}),
          // Un-settling by hand keeps the thread out of auto-settle until its next activity.
          ...(settled === true ? { settledOverride: "settled" as const, settledAt: nowIso(), unsettledAt: null } : {}),
          ...(settled === false ? { settledOverride: "active" as const, settledAt: null, unsettledAt: nowIso() } : {}),
        });
        this.sessionsChanged();
        this.json(res, 200, { session: record ? this.summary(record, found.cwd) : null });
        return true;
      }
      if (method === "POST" && action) {
        const body = await this.readBody(req);
        if (action === "resume") {
          this.json(res, 200, await this.loadTranscript(sessionId));
          return true;
        }
        const manager = await this.managerForSession(sessionId);
        if (action === "model") {
          if (!("model" in body)) {
            throw new HttpError(400, "model is required.");
          }
          await manager.setSessionModel(sessionId, body["model"]);
          const modelId = str(asRecord(body["model"])?.["modelId"]);
          if (modelId) {
            this.store.updateSession(sessionId, { modelId });
          }
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "compact") {
          this.json(res, 200, { result: await manager.compactSession(sessionId) });
          return true;
        }
        if (action === "shell") {
          const command = str(body["command"])?.trim();
          if (!command) {
            throw new HttpError(400, "command is required.");
          }
          this.wake(sessionId);
          await manager.userShell(sessionId, command);
          this.store.updateSession(sessionId, { activityAt: nowIso() });
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "fork") {
          this.json(res, 200, { session: await this.forkSession(sessionId, manager) });
          return true;
        }
        if (action === "side") {
          this.json(res, 200, { session: await this.sideChat(sessionId, manager) });
          return true;
        }
        if (action === "effort") {
          const effort = body["reasoningEffort"];
          if (!isReasoningEffort(effort)) {
            throw new HttpError(400, "Unknown reasoningEffort.");
          }
          // Set outright, not through the cache: this is the user asking, and a TUI change may not have reached us.
          await manager.setReasoningEffort(sessionId, effort);
          this.effortApplied.set(sessionId, effort);
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "goal") {
          const goalAction = body["action"];
          if (!isGoalAction(goalAction)) {
            throw new HttpError(400, "Unknown goal action.");
          }
          const objective = str(body["objective"])?.trim();
          if ((goalAction === "set" || goalAction === "edit") && !objective) {
            throw new HttpError(400, "An objective is required.");
          }
          // Setting or resuming a goal on an idle session wakes a turn, which is activity like any prompt.
          this.wake(sessionId);
          const ack = await manager.goal(sessionId, goalAction, objective);
          this.store.updateSession(sessionId, { activityAt: nowIso() });
          this.json(res, 200, { turnId: ack.turnId });
          return true;
        }
        if (action === "subagent") {
          const subagentAction = body["action"];
          const subagentId = str(body["subagentId"]);
          if (!isSubagentAction(subagentAction) || !subagentId) {
            throw new HttpError(400, "A known subagent action and a subagentId are required.");
          }
          const text = str(body["body"])?.trim();
          if ((subagentAction === "sendMessage" || subagentAction === "followupTask") && !text) {
            throw new HttpError(400, "A message is required.");
          }
          await manager.subagent(sessionId, subagentAction, subagentId, { reason: str(body["reason"]) ?? undefined, body: text });
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "tasks") {
          const taskAction = body["action"];
          const taskId = str(body["taskId"]);
          if (taskAction === "stopAll") {
            await manager.stopAllTasks(sessionId);
          } else if ((taskAction === "background" || taskAction === "stop") && taskId) {
            await (taskAction === "background" ? manager.backgroundTask(sessionId, taskId) : manager.stopTask(sessionId, taskId));
          } else {
            throw new HttpError(400, "Use background or stop with a taskId, or stopAll.");
          }
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "workflow") {
          const workflowAction = body["action"];
          const workflowRunId = str(body["workflowRunId"]);
          if (!workflowRunId) {
            throw new HttpError(400, "workflowRunId is required.");
          }
          if (workflowAction === "cancel") {
            await manager.cancelWorkflow(sessionId, workflowRunId);
          } else if (workflowAction === "pause") {
            await manager.pauseWorkflow(sessionId, workflowRunId);
          } else if (workflowAction === "resume") {
            await manager.resumeWorkflow(sessionId, workflowRunId);
          } else if (isWorkflowChildAction(workflowAction)) {
            const childId = str(body["childId"]);
            const attempt = body["attempt"];
            if (!childId || typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
              throw new HttpError(400, "childId and the child's current attempt are required.");
            }
            await manager.controlWorkflowChild(sessionId, workflowRunId, childId, attempt, workflowAction);
          } else {
            throw new HttpError(400, "Use cancel, pause, resume, skip or retry.");
          }
          this.json(res, 200, { ok: true });
          return true;
        }
        const mode = body["mode"];
        if (!isApprovalMode(mode)) {
          throw new HttpError(400, "Unknown mode.");
        }
        await manager.setSessionApprovalMode(sessionId, mode);
        this.json(res, 200, { ok: true });
        return true;
      }
    }

    if (method === "GET" && path === "/api/plan-usage") {
      this.json(res, 200, await this.readPlanUsage());
      return true;
    }
    if (method === "GET" && path === "/api/title-settings") {
      this.json(res, 200, this.store.getTitleSettings());
      return true;
    }
    if (method === "PATCH" && path === "/api/title-settings") {
      const body = await this.readBody(req);
      const patch: { enabled?: boolean; modelId?: string | null } = {};
      if ("enabled" in body) {
        if (typeof body["enabled"] !== "boolean") {
          throw new HttpError(400, "enabled must be a boolean.");
        }
        patch.enabled = body["enabled"];
      }
      if ("modelId" in body) {
        const modelId = body["modelId"];
        if (modelId !== null && (typeof modelId !== "string" || modelId.trim().length === 0 || modelId.length > 200)) {
          throw new HttpError(400, "modelId must be null or a non-empty string.");
        }
        patch.modelId = modelId === null ? null : (modelId as string).trim();
      }
      const wasEnabled = this.store.getTitleSettings().enabled;
      const next = this.store.setTitleSettings(patch);
      if (!wasEnabled && next.enabled) {
        for (const sessionId of this.titleUpgradePending) {
          this.queueTitle(sessionId);
        }
      }
      this.json(res, 200, next);
      return true;
    }
    if (method === "GET" && path === "/api/sandbox-settings") {
      this.json(res, 200, this.store.getSandboxSettings());
      return true;
    }
    if (method === "PATCH" && path === "/api/sandbox-settings") {
      const body = await this.readBody(req);
      const patch: { disabled?: boolean } = {};
      if ("disabled" in body) {
        if (typeof body["disabled"] !== "boolean") {
          throw new HttpError(400, "disabled must be a boolean.");
        }
        patch.disabled = body["disabled"];
      }
      const wasDisabled = this.store.getSandboxSettings().disabled;
      const next = this.store.setSandboxSettings(patch);
      if (wasDisabled !== next.disabled) {
        // Posture is fixed at spawn, so live hosts restart; closing can outlast this request.
        // Restarts queue behind each other so a session created mid-flip never lands on a retired host.
        const run = this.restartChain.then(() => this.restartHosts());
        this.restartChain = run.catch(() => undefined);
      }
      this.json(res, 200, next);
      return true;
    }
    if (method === "GET" && path === "/api/yolo-settings") {
      this.json(res, 200, this.store.getYoloSettings());
      return true;
    }
    if (method === "PATCH" && path === "/api/yolo-settings") {
      const body = await this.readBody(req);
      const patch: { enabled?: boolean } = {};
      if ("enabled" in body) {
        if (typeof body["enabled"] !== "boolean") {
          throw new HttpError(400, "enabled must be a boolean.");
        }
        patch.enabled = body["enabled"];
      }
      const wasEnabled = this.store.getYoloSettings().enabled;
      const next = this.store.setYoloSettings(patch);
      if (wasEnabled !== next.enabled) {
        // Posture is fixed at spawn, so live hosts restart; closing can outlast this request.
        // Restarts queue behind each other so a session created mid-flip never lands on a retired host.
        const run = this.restartChain.then(() => this.restartHosts());
        this.restartChain = run.catch(() => undefined);
      }
      this.json(res, 200, next);
      return true;
    }
    if (method === "GET" && path === "/api/feed-settings") {
      this.json(res, 200, this.store.getFeedSettings());
      return true;
    }
    if (method === "PATCH" && path === "/api/feed-settings") {
      const body = await this.readBody(req);
      const patch: { catchUp?: boolean } = {};
      if ("catchUp" in body) {
        if (typeof body["catchUp"] !== "boolean") {
          throw new HttpError(400, "catchUp must be a boolean.");
        }
        patch.catchUp = body["catchUp"];
      }
      const next = this.store.setFeedSettings(patch);
      // No host restarts for this: the tail starts or stops following, and sessions are picked up
      // from their next history load or pushed event.
      this.tail.setEnabled(next.catchUp);
      this.json(res, 200, next);
      return true;
    }
    if (method === "GET" && path === "/api/accounts") {
      this.json(res, 200, { accounts: await this.accountList() });
      return true;
    }
    if (method === "POST" && path === "/api/accounts") {
      const body = await this.readBody(req);
      const id = str(body["id"]);
      if (!id) {
        throw new HttpError(400, "id is required.");
      }
      const name = str(body["name"]);
      const seed = body["seedFromDefault"] === true;
      try {
        const profile = await this.aonia.createProfile(id, {
          ...(name ? { name } : {}),
          seedFromDefault: seed,
        });
        this.json(res, 200, { account: { id: profile.id, name: profile.name } });
      } catch (error) {
        throw this.accountError(error);
      }
      return true;
    }
    if (method === "PATCH" && path.startsWith("/api/accounts/")) {
      const id = decodeURIComponent(path.slice("/api/accounts/".length));
      const body = await this.readBody(req);
      const name = str(body["name"]);
      if (!name) {
        throw new HttpError(400, "name is required.");
      }
      try {
        await this.aonia.renameProfile(id, name);
      } catch (error) {
        throw this.accountError(error);
      }
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "DELETE" && path.startsWith("/api/accounts/")) {
      const id = decodeURIComponent(path.slice("/api/accounts/".length));
      try {
        await this.aonia.removeProfile(id);
      } catch (error) {
        throw this.accountError(error);
      }
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "GET" && path === "/api/accounts/health") {
      const findings = await this.aonia.doctor();
      const inherited = findings.some((f) => f.code === "meta_api_key_inherited");
      this.json(res, 200, { metaApiKeyInherited: inherited });
      return true;
    }
    if (method === "POST" && path.startsWith("/api/accounts/") && path.endsWith("/login")) {
      const id = decodeURIComponent(path.slice("/api/accounts/".length, path.length - "/login".length));
      if ((await this.museRuntime()) === "wsl") {
        this.json(res, 200, {
          fallback: `In-app login is not available when Muse runs in WSL. Log in from a terminal with: aonia login ${id}.`,
        });
        return true;
      }
      let profile: Profile;
      try {
        profile = await this.aonia.getProfile(id);
      } catch (error) {
        throw this.accountError(error);
      }
      const result = await this.runLogin(id, profile);
      this.json(res, 200, result);
      return true;
    }
    if (method === "PATCH" && path === "/api/projects/default-account") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]);
      if (!cwd) {
        throw new HttpError(400, "cwd is required.");
      }
      const accountRaw = body["accountId"];
      if (accountRaw !== undefined && accountRaw !== null && typeof accountRaw !== "string") {
        throw new HttpError(400, "accountId must be a string or null.");
      }
      const accountId = typeof accountRaw === "string" && accountRaw.length > 0 ? accountRaw : null;
      if (accountId && isSshCwd(cwd)) {
        throw new HttpError(400, SSH_ACCOUNT_MESSAGE);
      }
      this.store.upsertProject(normalizeCwd(cwd));
      this.store.setDefaultAccount(normalizeCwd(cwd), accountId);
      this.json(res, 200, { defaultAccountId: accountId });
      return true;
    }
    if (method === "GET" && path === "/api/usage") {
      const requested = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
      const days = Number.isFinite(requested) ? Math.min(365, Math.max(1, requested)) : 30;
      this.json(res, 200, this.usageReport(days));
      return true;
    }
    if (method === "POST" && path === "/api/usage/import-omp") {
      const counts = await importOmpUsage(resolveOmpSessionsDirs(this.options.home), this.store);
      this.json(res, 200, counts);
      return true;
    }
    const attachmentMatch = path.match(/^\/api\/attachments\/([A-Za-z0-9-]{1,64})$/);
    if (method === "GET" && attachmentMatch) {
      const found = this.store.readAttachment(attachmentMatch[1] as string);
      if (!found) {
        throw new HttpError(404, "No such attachment.");
      }
      res.writeHead(200, {
        "content-type": found.record.mediaType,
        "content-length": String(found.bytes.length),
        "cache-control": "private, max-age=86400",
      });
      res.end(Buffer.from(found.bytes));
      return true;
    }
    if (method === "POST" && path === "/api/turns") {
      const body = await this.readBody(req);
      const sessionId = str(body["sessionId"]);
      const text = str(body["text"]) ?? "";
      const files = Array.isArray(body["attachments"]) ? body["attachments"] : [];
      if (!sessionId || (!text && files.length === 0)) {
        throw new HttpError(400, "sessionId and either text or an attachment are required.");
      }
      const ifBusy = body["ifBusy"];
      if (ifBusy !== undefined && ifBusy !== null && !isIfBusy(ifBusy)) {
        throw new HttpError(400, "Unknown ifBusy.");
      }
      const effort = body["reasoningEffort"];
      if (effort !== undefined && effort !== null && !isReasoningEffort(effort)) {
        throw new HttpError(400, "Unknown reasoningEffort.");
      }
      const manager = await this.managerForSession(sessionId);
      if (typeof effort === "string") {
        await this.applyEffort(manager, sessionId, effort);
      }
      const prepared = await this.prepareAttachments(this.store.findSession(sessionId)?.cwd ?? "", files);
      this.wake(sessionId);
      const ack = await manager.sendTurn(sessionId, prepared.prompt(text), {
        displayText: str(body["displayText"]) ?? undefined,
        ifBusy: typeof ifBusy === "string" ? ifBusy : undefined,
        reasoningEffort: typeof effort === "string" ? effort : undefined,
        images: prepared.images,
      });
      // The saved attachments go back with the ack: the open thread shows them without waiting for a reload.
      const saved = prepared.files.map((file, index) =>
        this.attachmentView(
          this.store.addAttachment({
            id: randomUUID(),
            sessionId,
            turnId: ack.turnId,
            ord: index,
            name: file.name,
            mediaType: file.mediaType,
            kind: file.kind,
            width: file.width,
            height: file.height,
            bytes: file.bytes,
          }),
        ),
      );
      this.store.updateSession(sessionId, { activityAt: nowIso() });
      this.json(res, 200, { turnId: ack.turnId, status: ack.status, disposition: ack.disposition, attachments: saved });
      return true;
    }

    const turnMatch = path.match(/^\/api\/turns\/(steer|interrupt|cancel|unqueue)$/);
    if (method === "POST" && turnMatch) {
      const action = turnMatch[1] as string;
      const body = await this.readBody(req);
      const sessionId = str(body["sessionId"]);
      const turnId = str(body["turnId"]);
      if (!sessionId) {
        throw new HttpError(400, "sessionId is required.");
      }
      const manager = await this.managerForSession(sessionId);
      if (action === "steer") {
        const text = str(body["text"]);
        if (!turnId || !text) {
          throw new HttpError(400, "turnId and text are required to steer.");
        }
        await manager.steerTurn(sessionId, turnId, text);
      } else if (action === "interrupt") {
        await manager.interruptTurn(sessionId, turnId ?? undefined, body["retract"] === true);
      } else if (action === "cancel") {
        if (!turnId) {
          throw new HttpError(400, "turnId is required.");
        }
        await manager.cancelTurn(sessionId, turnId);
      } else {
        if (!turnId) {
          throw new HttpError(400, "turnId is required.");
        }
        await manager.unqueueTurn(sessionId, turnId);
      }
      this.json(res, 200, { ok: true });
      return true;
    }

    if (method === "POST" && path === "/api/approvals/decide") {
      const body = await this.readBody(req);
      const sessionId = str(body["sessionId"]);
      const approvalId = str(body["approvalId"]);
      const choiceId = str(body["choiceId"]);
      if (!sessionId || !approvalId || !choiceId || !("requirementId" in body)) {
        throw new HttpError(400, "sessionId, approvalId, requirementId and choiceId are required.");
      }
      const manager = await this.managerForSession(sessionId);
      await manager.decideApproval({
        sessionId,
        approvalId,
        requirementId: body["requirementId"],
        choiceId,
        feedback: str(body["feedback"]),
      });
      this.json(res, 200, { ok: true });
      return true;
    }

    if (method === "GET" && path === "/api/models") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const manager = sessionId ? await this.managerForSession(sessionId) : (await this.hostFor("")).manager;
      this.json(res, 200, { models: await manager.listModels(sessionId) });
      return true;
    }

    const inputMatch = path.match(/^\/api\/user-input\/(answer|cancel|clarify)$/);
    if (method === "POST" && inputMatch) {
      const action = inputMatch[1] as string;
      const body = await this.readBody(req);
      const sessionId = str(body["sessionId"]);
      const userInputId = str(body["userInputId"]);
      if (!sessionId || !userInputId) {
        throw new HttpError(400, "sessionId and userInputId are required.");
      }
      const manager = await this.managerForSession(sessionId);
      if (action === "answer") {
        const answers = body["answers"];
        if (!Array.isArray(answers)) {
          throw new HttpError(400, "answers are required.");
        }
        await manager.answerUserInput(sessionId, userInputId, answers as never);
      } else if (action === "cancel") {
        await manager.cancelUserInput(sessionId, userInputId, str(body["reason"]) ?? undefined);
      } else {
        const content = str(body["content"]);
        if (!content) {
          throw new HttpError(400, "content is required.");
        }
        await manager.clarifyUserInput(sessionId, userInputId, content);
      }
      this.json(res, 200, { ok: true });
      return true;
    }

    if (method === "POST" && path === "/api/open") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]);
      if (!cwd || !this.store.getProject(cwd)) {
        throw new HttpError(404, "Unknown project folder.");
      }
      if (isSshCwd(cwd)) {
        throw new HttpError(400, "Opening remote folders is not available for SSH projects in this version.");
      }
      const target: OpenTarget = body["target"] === "editor" ? "editor" : "files";
      await this.opener(this.localPathFor(cwd), target);
      this.json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  /**
   * The WSL distro Muse runs in: the pinned one (`--distro` / `HELICON_WSL_DISTRO`), else the distro the
   * probe found Muse in (WSL's default). Launching anywhere else would run a Muse path found in one distro
   * inside another. Undefined off Windows, where it is unused.
   */
  private async wslDistro(): Promise<string | undefined> {
    if (this.options.distro) {
      return this.options.distro;
    }
    if (this.options.platform !== "win32") {
      return undefined;
    }
    return (await this.environment(false)).defaultDistro ?? undefined;
  }

  private async environment(refresh: boolean): Promise<EnvView> {
    if (!refresh && this.envCache && Date.now() - this.envCache.at < ENV_CACHE_MS) {
      return this.envCache.value;
    }
    const hint = this.runtimeHint();
    const probe = await probeEnvironment(defaultExec, this.options.platform, {
      preference: hint === "native" || hint === "wsl" ? hint : this.options.runtime,
      ...(this.options.distro ? { distro: this.options.distro } : {}),
      ...(this.options.findNativeMuse ? { findNative: this.options.findNativeMuse } : {}),
    });
    if (!hint) {
      this.runtimeKnown = probe.runtime;
    }
    if (probe.runtime === "native" && probe.native && !this.options.findNativeMuse) {
      refreshNativeMuse(probe.native);
    }
    const value: EnvView = {
      platform: probe.platform,
      runtime: probe.runtime,
      wslAvailable: probe.wslAvailable,
      defaultDistro: probe.defaultDistro,
      museFound: probe.musePath !== null,
      musePath: probe.musePath,
      museSignedIn: probe.runtime !== "wsl" && probe.musePath !== null ? museSignedIn(this.options.home) : null,
      sshFound: !(await this.options.sshRun(["-V"])).missing,
      version: HELICON_VERSION,
      persistent: this.options.dataDir !== ":memory:",
    };
    this.envCache = { at: Date.now(), value };
    return value;
  }

  private serveEvents(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const sink: SseSink = (event, data) => {
      if (res.writableEnded) {
        this.sinks.delete(sink);
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    this.sinks.add(sink);
    sink("helicon", { type: "hello", version: HELICON_VERSION });
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        this.sinks.delete(sink);
        return;
      }
      // A named event rather than a comment: EventSource never surfaces comments to a listener, so a client
      // holding a stream whose upstream died behind a proxy cannot tell it from a quiet one. This is what
      // the client's watchdog listens for.
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, 25000);
    res.on("close", () => {
      clearInterval(heartbeat);
      this.sinks.delete(sink);
    });
  }

  private async serveStatic(path: string, res: ServerResponse): Promise<boolean> {
    if (!this.options.staticDir) {
      return false;
    }
    const root = this.options.staticDir;
    const rel = path === "/" ? "/index.html" : path;
    const full = normalize(join(root, rel));
    if (!full.startsWith(root + sep) && full !== root) {
      return false;
    }
    try {
      const info = await stat(full);
      const file = info.isDirectory() ? join(full, "index.html") : full;
      const body = await readFile(file);
      const immutable = file.includes(`${sep}assets${sep}`);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "content-security-policy": frameAncestorsPolicy(this.options.frameAncestors),
        "x-content-type-options": "nosniff",
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  private liveFor(sessionId: string): LiveState {
    let state = this.live.get(sessionId);
    if (!state) {
      state = {
        activeTurnId: null,
        turnStartedAt: null,
        pendingApprovals: new Set(),
        pendingInputs: new Set(),
        lastTerminal: null,
        lastError: null,
        goal: null,
        goalSeq: 0,
        monitors: new Set(),
      };
      this.live.set(sessionId, state);
    }
    return state;
  }

  private liveView(sessionId: string): LiveView | null {
    const state = this.live.get(sessionId);
    if (!state) {
      return null;
    }
    return {
      activeTurnId: state.activeTurnId,
      turnStartedAt: state.turnStartedAt,
      pendingApprovals: state.pendingApprovals.size,
      pendingInputs: state.pendingInputs.size,
      lastTerminal: state.lastTerminal,
      lastError: state.lastError,
      goal: state.goal,
      monitors: state.monitors.size,
    };
  }

  private emitStatus(sessionId: string): void {
    this.emit("helicon", { type: "session-status", sessionId, live: this.liveView(sessionId) });
  }

  private summary(record: SessionRecord, cwd: string): Record<string, unknown> {
    return {
      sessionId: record.id,
      cwd,
      title: record.title,
      titleSource: record.titleSource,
      turnCount: record.turnCount,
      modelId: record.modelId,
      origin: record.origin,
      archived: record.archived,
      createdAt: record.createdAt,
      activityAt: record.activityAt,
      settled: record.settledOverride === "settled",
      settledAt: record.settledAt,
      unsettledAt: record.unsettledAt,
      pinned: record.pinned,
      sandboxDisabled: record.sandboxDisabled,
      accountId: record.accountId,
      sideOf: record.sideOf,
      live: this.liveView(record.id),
    };
  }

  private isBusy(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return Boolean(live && (live.activeTurnId || live.pendingApprovals.size > 0 || live.pendingInputs.size > 0));
  }

  /** New activity wakes a settled thread, and lifts a manual "keep active" so auto-settle can apply again. */
  private wake(sessionId: string): void {
    const record = this.store.getSession(sessionId);
    if (!record || record.settledOverride === null) {
      return;
    }
    this.store.updateSession(sessionId, {
      settledOverride: null,
      settledAt: null,
      unsettledAt: record.settledOverride === "settled" ? nowIso() : record.unsettledAt,
    });
    this.sessionsChanged();
  }

  /** Settles threads nobody has touched for `autoSettleDays`, as T3 Code does; a busy thread is left alone. */
  private autoSettle(): void {
    const days = this.options.autoSettleDays;
    if (days === null || this.closed) {
      return;
    }
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let changed = false;
    for (const record of this.store.listSettleCandidates(cutoff)) {
      if (this.isBusy(record.id)) {
        continue;
      }
      this.store.updateSession(record.id, { settledOverride: "settled", settledAt: record.activityAt, unsettledAt: null });
      changed = true;
    }
    if (changed) {
      this.sessionsChanged();
    }
  }

  /** A runtime the options settle without probing: the OS, an explicit `--runtime`, or the style of a `--muse` path. */
  private runtimeHint(): MuseRuntime | null {
    if (this.options.platform !== "win32") {
      return "posix";
    }
    if (this.options.runtime === "native" || this.options.runtime === "wsl") {
      return this.options.runtime;
    }
    const configured = this.options.musePath;
    if (configured && isWindowsAbs(configured)) {
      return "native";
    }
    if (configured?.startsWith("/")) {
      return "wsl";
    }
    return null;
  }

  /** Where Muse runs. On Windows, native Muse wins over WSL once it is installed, unless WSL was asked for. */
  private async museRuntime(): Promise<MuseRuntime> {
    const hinted = this.runtimeHint();
    if (hinted) {
      return hinted;
    }
    if (!this.runtimeKnown) {
      await this.environment(false);
    }
    return this.runtimeKnown ?? "wsl";
  }

  private spawnCwdFor(cwd: string): string {
    if (!cwd || isSshCwd(cwd)) {
      // An SSH host spawns locally only as `ssh`: the local folder is meaningless.
      return process.cwd();
    }
    if (this.options.platform !== "win32") {
      return cwd;
    }
    if (isWslAbs(cwd)) {
      try {
        return toWindowsPath(cwd);
      } catch {
        return process.cwd();
      }
    }
    return cwd;
  }

  /** The workspace path as Muse sees it: `/mnt/d/...` for Muse in WSL, `D:\\...` for native Windows Muse. */
  private hostPathFor(cwd: string): string {
    if (isSshCwd(cwd)) {
      // Stored SSH keys are always absolute, so this is the remote path itself.
      return parseSshProject(cwd)?.remotePath ?? cwd;
    }
    if (!cwd || this.options.platform !== "win32") {
      return cwd;
    }
    if ((this.runtimeHint() ?? this.runtimeKnown) === "native") {
      return this.spawnCwdFor(cwd);
    }
    if (isWindowsAbs(cwd)) {
      try {
        return toWslPath(cwd);
      } catch {
        return cwd;
      }
    }
    return cwd;
  }

  /** One host per (account, workspace). "default" stands in for the default login so today's keys are unchanged in spirit. */
  private hostKey(cwd: string, accountId: string | null): string {
    if (isSshCwd(cwd)) {
      // The full SSH key addresses the host: translating it would point at the wrong machine. The remote
      // host's own login always applies, so a local account never splits one SSH folder into two hosts.
      return `default::${normalizeCwd(cwd)}`;
    }
    return `${accountId ?? "default"}::${this.hostPathFor(cwd) || "__default__"}`;
  }

  private storePathFor(remoteRoot: string): string {
    if (isSshCwd(remoteRoot)) {
      return normalizeCwd(remoteRoot);
    }
    if (this.options.platform === "win32" && isWindowsAbs(remoteRoot)) {
      // Native Muse may spell a folder `d:/work`; the store keeps one spelling, `D:\\work`.
      const normal = win32.normalize(remoteRoot);
      return normal.charAt(0).toUpperCase() + normal.slice(1);
    }
    if (this.options.platform !== "win32" || !isWslAbs(remoteRoot)) {
      return remoteRoot;
    }
    try {
      return toWindowsPath(remoteRoot);
    } catch {
      return remoteRoot;
    }
  }

  /** A path the local OS can open: WSL `/mnt/x` roots become `X:\` on Windows. */
  private localPathFor(cwd: string): string {
    if (this.options.platform === "win32" && isWslAbs(cwd)) {
      try {
        return toWindowsPath(cwd);
      } catch {
        return cwd;
      }
    }
    return cwd;
  }

  /** How typed paths map onto this machine. The WSL distro is only probed for Linux paths on Windows. */
  private async pathContext(forPath: string): Promise<PathContext> {
    const platform = this.options.platform ?? process.platform;
    const value = forPath.trim();
    let distro: string | null = this.options.distro ?? null;
    if (!distro && platform === "win32" && value.startsWith("/") && !/^\/mnt\/[A-Za-z](\/|$)/.test(value)) {
      distro = (await this.environment(false)).defaultDistro;
    }
    return { platform, home: this.options.home ?? homedir(), distro };
  }

  /** The stored form of a project folder: absolute, `~` expanded, one separator style. */
  private async canonicalCwd(raw: string, create: boolean): Promise<string> {
    const trimmed = raw.trim();
    if (trimmed.startsWith("ssh://")) {
      // No remote mkdir in this version: creating a remote folder is refused loudly.
      if (create) {
        throw new SshError(400, "Creating folders on an SSH host is not available in this version. Create it over SSH first.");
      }
      const parsed = parseSshProject(trimmed);
      if (!parsed) {
        throw new SshError(400, "SSH projects look like ssh://host/absolute/path.");
      }
      const home = needsSshHome(parsed.remotePath) ? await this.sshHome(parsed.host) : null;
      const abs = resolveSshPath(parsed.host, parsed.remotePath, home);
      const normal = normalizeSshCwd(`ssh://${parsed.host}${abs}`);
      if (!normal) {
        throw new SshError(400, "SSH projects look like ssh://host/absolute/path.");
      }
      return normal;
    }
    const ctx = await this.pathContext(raw);
    try {
      const resolved = create ? await createDirectory(raw, ctx) : resolveUserPath(raw, ctx);
      return normalizeCwd(resolved.display);
    } catch (error) {
      if (create || !(error instanceof PathError)) {
        throw error;
      }
      return normalizeCwd(raw);
    }
  }

  /** The remote `$HOME` on an SSH host, cached. Throws SshError when the host is unreachable. */
  private async sshHome(host: string): Promise<string> {
    const cached = this.sshHomeCache.get(host);
    if (cached && Date.now() - cached.at < SSH_HOME_CACHE_MS) {
      return cached.home;
    }
    const home = await readSshHome(host, this.options.sshRun);
    this.sshHomeCache.set(host, { home, at: Date.now() });
    return home;
  }

  /** The add-project picker's listing for an `ssh://host/path` folder. */
  private async listSshFolder(raw: string): Promise<DirectoryListing> {
    const parsed = parseSshProject(raw);
    if (!parsed) {
      throw new SshError(400, "SSH folders look like ssh://host/absolute/path.");
    }
    const home = needsSshHome(parsed.remotePath) ? await this.sshHome(parsed.host) : null;
    const abs = resolveSshPath(parsed.host, parsed.remotePath, home);
    const listed = await listSshDirectory(parsed.host, abs, this.options.sshRun);
    return sshDirectoryListing(parsed.host, abs, listed);
  }

  private async addProjectFolder(cwd: string): Promise<Record<string, unknown>> {
    this.store.upsertProject(cwd);
    this.store.setHidden(cwd, false);
    // Say so now: discovery below starts Muse and can take many seconds, and the project can show before its threads.
    this.sessionsChanged();
    let warning: string | null = null;
    let sessions: Record<string, unknown>[] = [];
    try {
      sessions = await this.discover(cwd);
    } catch (error) {
      warning = errorInfo(error).message;
    }
    this.sessionsChanged();
    return { project: { cwd, displayName: this.store.getProject(cwd)?.displayName ?? cwd }, sessions, warning };
  }

  private async cloneRepository(remote: string, target: string): Promise<string> {
    if (target.trim().startsWith("ssh://")) {
      throw new HttpError(400, "Cloning onto an SSH host is not available in this version.");
    }
    const ctx = await this.pathContext(target);
    const resolved = resolveUserPath(target, ctx);
    const existing = await readdir(resolved.local).catch(() => null);
    if (existing && existing.length > 0) {
      throw new HttpError(409, "That folder already exists and is not empty. Pick another name.");
    }
    await mkdir((ctx.platform === "win32" ? win32 : posix).dirname(resolved.local), { recursive: true });
    // A Linux folder under WSL is cloned by WSL's own git, so it gets Linux line endings and permissions.
    if (ctx.platform === "win32" && resolved.flavor === "posix" && !resolved.display.startsWith("/mnt/")) {
      await runProcess("wsl.exe", ["-d", ctx.distro ?? "", "--", "git", "clone", "--", remote, resolved.display], CLONE_TIMEOUT_MS);
    } else {
      await runProcess("git", ["clone", "--", remote, resolved.local], CLONE_TIMEOUT_MS);
    }
    return resolved.display;
  }

  /** The muse binary for one-off CLI calls; on Windows the environment probe finds it natively or inside WSL. */
  private async cliMusePath(): Promise<string | null> {
    await this.museRuntime();
    const configured = this.options.musePath ?? null;
    if (this.options.platform !== "win32" || (configured && (configured.includes("/") || configured.includes("\\")))) {
      return configured;
    }
    return (await this.environment(false)).musePath;
  }

  /** A workspace's skills as `muse skills list` reports them, kept for a minute. A failure comes back as `error`, never a throw. */
  /**
   * A workspace's skills. With a session that is loaded on a host, Muse's own `skill/list` decides which skills are
   * there, so it stays right as skills are added or switched off; without one, `muse skills list` stands in.
   */
  private async listSkills(cwd: string, sessionId?: string | null): Promise<SkillListing> {
    const cli = await this.listCliSkills(cwd);
    const hostKey = sessionId ? this.sessionHosts.get(sessionId) : undefined;
    const managed = hostKey ? this.hosts.get(hostKey) : undefined;
    if (!sessionId || !managed) {
      return cli;
    }
    try {
      const rows = await managed.manager.listSessionSkills(sessionId);
      return { ...cli, skills: mergeSessionSkills(rows, cli.skills), error: null };
    } catch {
      // An older host without skill/list, or a session that just unloaded: the CLI listing still answers.
      return cli;
    }
  }

  private async listCliSkills(cwd: string): Promise<SkillListing> {
    const key = cwd || "__default__";
    if (isSshCwd(cwd)) {
      const listing: SkillListing = {
        at: Date.now(),
        skills: [],
        paths: new Map(),
        error: "Skills are not listed for SSH projects in this version.",
      };
      this.skillCache.set(key, listing);
      return listing;
    }
    const cached = this.skillCache.get(key);
    if (cached && !cached.error && Date.now() - cached.at < SKILL_CACHE_MS) {
      return cached;
    }
    const args = ["skills", "list", "--json"];
    const musePath = await this.cliMusePath();
    const root = this.hostPathFor(cwd);
    if (root) {
      args.push("--workspace", root);
    }
    const plan = planMuseCli({ platform: this.options.platform, distro: await this.wslDistro(), musePath, args, runtime: await this.museRuntime() });
    const result = await this.options.exec(plan.command, plan.args);
    const parsed = parseSkillList(result.stdout);
    const listing: SkillListing = parsed
      ? { at: Date.now(), ...parsed, error: null }
      : {
          at: Date.now(),
          skills: [],
          paths: new Map(),
          error:
            result.exitCode === 0
              ? "Muse listed its skills in a form Helicon does not understand."
              : "Could not list Muse skills. Check that muse runs in a terminal.",
        };
    this.skillCache.set(key, listing);
    return listing;
  }

  /** A listed skill's instructions, read where Muse keeps them. The path comes from Muse, never from the request. */
  private async skillBody(cwd: string, id: string): Promise<string> {
    const path = (await this.listCliSkills(cwd)).paths.get(id);
    if (!path) {
      throw new HttpError(404, "Muse does not list that skill for this workspace.");
    }
    const bundled = /^bundled:\/\/(.+)$/.exec(path)?.[1];
    if (bundled?.split("/").includes("..")) {
      throw new HttpError(400, "That skill's path is not readable.");
    }
    if ((await this.museRuntime()) === "native") {
      // Native Muse keeps its data where the launcher keeps its config: XDG folders under the user profile.
      const dataHome = process.env["XDG_DATA_HOME"] || join(this.options.home, ".local", "share");
      const file = bundled ? win32.join(dataHome, "muse", "skills", "bundled", ...bundled.split("/")) : path;
      const body = stripFrontmatter(await readFile(file, "utf8").catch(() => ""));
      if (!body) {
        throw new HttpError(502, "Could not read that skill's instructions.");
      }
      return body;
    }
    // Bundled skills live in Muse's data folder; the others list a real file path.
    const script = bundled ? 'exec cat -- "${XDG_DATA_HOME:-$HOME/.local/share}/muse/skills/bundled/$1"' : 'exec cat -- "$1"';
    const plan = planHostCommand({
      platform: this.options.platform,
      distro: await this.wslDistro(),
      program: "sh",
      args: ["-c", script, "sh", bundled ?? path],
    });
    const result = await this.options.exec(plan.command, plan.args);
    const body = result.exitCode === 0 ? stripFrontmatter(result.stdout) : "";
    if (!body) {
      throw new HttpError(502, "Could not read that skill's instructions.");
    }
    return body;
  }

  private async forkSession(sessionId: string, manager: SessionManager): Promise<Record<string, unknown>> {
    const found = this.store.findSession(sessionId);
    if (!found) {
      throw new HttpError(404, "Unknown session.");
    }
    const forked = await manager.forkSession(sessionId);
    const raw = asRecord(asRecord(forked.raw)?.["session"]);
    const record = this.store.recordSession({
      id: forked.sessionId,
      projectId: found.session.projectId,
      origin: "helicon",
      // The fork carries its source's name until the user renames it.
      title: `${found.session.title} (fork)`,
      titleSource: "auto",
      modelId: raw ? str(raw["modelId"]) : found.session.modelId,
      turnCount: num(raw?.["turnCount"]),
      createdAt: normalizeIso(raw?.["createdAt"]),
      // A fork branches its source session, so it inherits the source's posture.
      sandboxDisabled: found.session.sandboxDisabled,
    });
    const hostKey = this.sessionHosts.get(sessionId);
    if (hostKey) {
      this.sessionHosts.set(forked.sessionId, hostKey);
    }
    this.liveFor(forked.sessionId);
    this.sessionsChanged();
    return this.summary(record, found.cwd);
  }

  /** Opens a side chat beside a thread. It is its own session, nested under the thread in the sidebar. */
  private async sideChat(sessionId: string, manager: SessionManager): Promise<Record<string, unknown>> {
    const found = this.store.findSession(sessionId);
    if (!found) {
      throw new HttpError(404, "Unknown session.");
    }
    const side = await manager.sideChat(sessionId);
    const raw = asRecord(asRecord(side.raw)?.["session"]);
    const record = this.store.recordSession({
      id: side.sessionId,
      projectId: found.session.projectId,
      origin: "helicon",
      // A side chat of a side chat keeps one suffix, not "(side chat) (side chat)".
      title: `${found.session.title.replace(/ \(side chat\)$/, "")} (side chat)`,
      titleSource: "auto",
      modelId: raw ? str(raw["modelId"]) : found.session.modelId,
      createdAt: normalizeIso(raw?.["createdAt"]),
      sandboxDisabled: found.session.sandboxDisabled,
      sideOf: sessionId,
    });
    const hostKey = this.sessionHosts.get(sessionId);
    if (hostKey) {
      this.sessionHosts.set(side.sessionId, hostKey);
    }
    this.liveFor(side.sessionId);
    this.sessionsChanged();
    return this.summary(record, found.cwd);
  }

  private async startSession(
    cwd: string,
    approvalMode?: ApprovalMode,
    modelId?: string,
    accountId: string | null = null,
  ): Promise<Record<string, unknown>> {
    if (accountId && isSshCwd(cwd)) {
      throw new HttpError(400, SSH_ACCOUNT_MESSAGE);
    }
    const project = this.store.upsertProject(cwd);
    this.store.setHidden(cwd, false);
    const host = await this.hostFor(cwd, accountId);
    const started = await host.manager.startSession({
      workspaceRoot: this.hostPathFor(cwd),
      approvalMode,
      modelId,
    });
    const raw = asRecord(asRecord(started.raw)?.["session"]);
    const record = this.store.recordSession({
      id: started.sessionId,
      projectId: project.id,
      origin: "helicon",
      // session/start's reply names Muse's default; the daemon sets the requested model right after it.
      modelId: modelId ?? (raw ? str(raw["modelId"]) : null),
      createdAt: normalizeIso(raw?.["createdAt"]),
      // The creating host's own flags, not the live switch: a flip's restart may still be closing the old host.
      sandboxDisabled: host.target.args.includes("--disable-sandbox"),
      accountId,
    });
    this.sessionHosts.set(started.sessionId, host.key);
    // A new session's view is empty, so the start of it is somewhere to page from.
    this.tail.anchor(started.sessionId, null);
    if (accountId) {
      await this.aonia.touch(accountId).catch(() => undefined);
    }
    this.liveFor(started.sessionId);
    this.sessionsChanged();
    return this.summary(record, cwd);
  }

  /**
   * Files posted with a prompt. Images are the one non-text part MSP takes, so they go straight to the model;
   * anything else is written into the workspace under `.helicon/attachments` and mentioned in the prompt,
   * which is how Muse reaches a file. Every one is kept here too, so a reopened thread can show it.
   */
  private async prepareAttachments(
    cwd: string,
    raw: unknown[],
  ): Promise<{ images: TurnImage[]; files: PreparedAttachment[]; prompt: (text: string) => string }> {
    const mentions: string[] = [];
    const images: TurnImage[] = [];
    const files: PreparedAttachment[] = [];
    if (raw.length > MAX_ATTACHMENTS) {
      throw new HttpError(400, `A message takes at most ${MAX_ATTACHMENTS} files.`);
    }
    for (const entry of raw) {
      const record = asRecord(entry);
      const base64 = record ? str(record["base64"]) : null;
      const mediaType = record ? str(record["mediaType"]) : null;
      if (!record || !base64 || !mediaType) {
        throw new HttpError(400, "Each attachment needs a name, a mediaType and base64 bytes.");
      }
      const name = safeFileName(str(record["name"]));
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0) {
        throw new HttpError(400, `${name} has no content.`);
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new HttpError(413, `${name} is over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
      }
      const width = num(record["width"]) ?? null;
      const height = num(record["height"]) ?? null;
      if (mediaType.startsWith("image/")) {
        images.push({
          base64Data: base64,
          mediaType,
          ...(width !== null && height !== null ? { width, height } : {}),
        });
        files.push({ name, mediaType, kind: "image", width, height, bytes });
        continue;
      }
      if (!cwd) {
        throw new HttpError(400, `${name} needs a workspace to land in.`);
      }
      if (isSshCwd(cwd)) {
        throw new HttpError(400, `${name} cannot land in an SSH project in this version. Images can still be attached.`);
      }
      const written = await this.writeIntoWorkspace(cwd, name, bytes);
      mentions.push(`@${[...ATTACHMENT_DIR, written].join("/")}`);
      files.push({ name: written, mediaType, kind: "file", width, height, bytes });
    }
    return {
      images,
      files,
      prompt: (text: string) => [text, ...mentions].filter((part) => part.length > 0).join("\n\n"),
    };
  }

  /** Writes an attached file into the workspace, keeping its name unless one is already taken. */
  private async writeIntoWorkspace(cwd: string, name: string, bytes: Buffer): Promise<string> {
    const directory = join(cwd, ...ATTACHMENT_DIR);
    await mkdir(directory, { recursive: true });
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const suffix = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const taken = await stat(join(directory, candidate)).then(
        () => true,
        () => false,
      );
      if (!taken) {
        break;
      }
      candidate = `${stem}-${attempt + 2}${suffix}`;
    }
    await writeFile(join(directory, candidate), bytes);
    return candidate;
  }

  /**
   * One model call's tokens, kept so the usage page can look across every thread rather than only the ones
   * open in the UI. The view cursor is the key, so replaying a thread's history never counts a call twice.
   */
  private recordUsage(sessionId: string, params: Record<string, unknown>): void {
    const usage = asRecord(params["usage"]) ?? {};
    const promptTokens = num(params["promptTokens"]) ?? num(usage["inputTokens"]) ?? 0;
    const outputTokens = num(usage["outputTokens"]) ?? Math.max(0, (num(params["totalTokens"]) ?? 0) - promptTokens);
    if (promptTokens === 0 && outputTokens === 0) {
      return;
    }
    this.store.recordUsage({
      key: str(params["viewCursor"]) ?? `${sessionId}:${str(params["turnId"]) ?? "turn"}:${randomUUID()}`,
      sessionId,
      turnId: str(params["turnId"]),
      modelId: str(params["modelId"]),
      promptTokens,
      outputTokens,
      inputTokens: num(usage["inputTokens"]) ?? 0,
      cachedTokens: num(usage["cachedTokens"]) ?? 0,
      cacheReadTokens: num(usage["cacheReadTokens"]) ?? 0,
      cacheWriteTokens: num(usage["cacheWriteTokens"]) ?? 0,
      reasoningTokens: num(usage["reasoningTokens"]) ?? 0,
      durationMs: num(params["durationMs"]) ?? null,
      at: normalizeIso(params["at"]) ?? nowIso(),
    });
  }

  /** Tokens per day and model, plus a row per thread, for the usage page to price. */
  private usageReport(days: number): Record<string, unknown> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.store.listUsage(since);
    const buckets = new Map<string, Record<string, unknown>>();
    const threads = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const day = row.at.slice(0, 10);
      const modelId = row.modelId ?? "unknown";
      const cached = Math.min(row.promptTokens, row.cacheReadTokens || row.cachedTokens);
      const bucketKey = `${day}|${modelId}`;
      const bucket = buckets.get(bucketKey) ?? {
        day,
        modelId,
        calls: 0,
        promptTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        durationMs: 0,
      };
      bucket["calls"] = (bucket["calls"] as number) + 1;
      bucket["promptTokens"] = (bucket["promptTokens"] as number) + row.promptTokens;
      bucket["outputTokens"] = (bucket["outputTokens"] as number) + row.outputTokens;
      bucket["cachedTokens"] = (bucket["cachedTokens"] as number) + cached;
      bucket["cacheReadTokens"] = (bucket["cacheReadTokens"] as number) + row.cacheReadTokens;
      bucket["cacheWriteTokens"] = (bucket["cacheWriteTokens"] as number) + row.cacheWriteTokens;
      bucket["reasoningTokens"] = (bucket["reasoningTokens"] as number) + row.reasoningTokens;
      bucket["durationMs"] = (bucket["durationMs"] as number) + (row.durationMs ?? 0);
      buckets.set(bucketKey, bucket);

      const thread = threads.get(row.sessionId) ?? {
        sessionId: row.sessionId,
        title: row.sessionTitle,
        cwd: row.projectCwd,
        calls: 0,
        promptTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        modelIds: [] as string[],
        // A thread that switched models has to be priced per model, not at whichever one it started on.
        models: [] as Record<string, unknown>[],
        lastAt: row.at,
      };
      thread["calls"] = (thread["calls"] as number) + 1;
      thread["promptTokens"] = (thread["promptTokens"] as number) + row.promptTokens;
      thread["outputTokens"] = (thread["outputTokens"] as number) + row.outputTokens;
      thread["cachedTokens"] = (thread["cachedTokens"] as number) + cached;
      const ids = thread["modelIds"] as string[];
      if (!ids.includes(modelId)) {
        ids.push(modelId);
      }
      const perModel = thread["models"] as Record<string, unknown>[];
      const share = perModel.find((entry) => entry["modelId"] === modelId);
      if (share) {
        share["calls"] = (share["calls"] as number) + 1;
        share["promptTokens"] = (share["promptTokens"] as number) + row.promptTokens;
        share["outputTokens"] = (share["outputTokens"] as number) + row.outputTokens;
        share["cachedTokens"] = (share["cachedTokens"] as number) + cached;
      } else {
        perModel.push({
          modelId,
          calls: 1,
          promptTokens: row.promptTokens,
          outputTokens: row.outputTokens,
          cachedTokens: cached,
        });
      }
      thread["lastAt"] = row.at;
      threads.set(row.sessionId, thread);
    }
    return {
      since,
      days,
      buckets: [...buckets.values()],
      threads: [...threads.values()].sort((a, b) => ((a["lastAt"] as string) < (b["lastAt"] as string) ? 1 : -1)),
    };
  }

  /**
   * Runs a `!` command where the workspace lives: through WSL on Windows, in the folder itself elsewhere.
   * This is the user's own shell, not Muse's sandbox, which is the point: Muse cannot run these at all.
   */
  private async runInWorkspace(
    cwd: string,
    command: string,
  ): Promise<{ output: string; exitCode: number | null; truncated: boolean; durationMs: number }> {
    const started = Date.now();
    if ((await this.museRuntime()) === "native") {
      // Native Windows Muse works in PowerShell, so `!` commands run there too, in the workspace folder.
      // PowerShell reads curly single quotes as quotes too, so each kind is doubled to stay literal.
      const folder = this.spawnCwdFor(cwd).replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&");
      const powershell = win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `Set-Location -LiteralPath '${folder}' -ErrorAction Stop\n${command}`;
      const result = await this.options.shellRunner(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]);
      return { ...result, output: result.output.replace(/\r\n/g, "\n"), durationMs: Date.now() - started };
    }
    const plan = planHostCommand({
      platform: this.options.platform,
      distro: await this.wslDistro(),
      program: "sh",
      // $1 is the workspace, then the command; a login shell so the user's PATH is the one they expect.
      args: ["-c", 'cd "$1" || exit 1; shift; exec "${SHELL:-/bin/sh}" -lc "$1"', "sh", this.hostPathFor(cwd), command],
    });
    const result = await this.options.shellRunner(plan.command, plan.args);
    return { ...result, durationMs: Date.now() - started };
  }

  private attachmentView(record: AttachmentRecord): Record<string, unknown> {
    return {
      id: record.id,
      turnId: record.turnId,
      name: record.name,
      mediaType: record.mediaType,
      kind: record.kind,
      width: record.width,
      height: record.height,
      url: `/api/attachments/${record.id}`,
    };
  }

  private async pageTranscript(
    manager: SessionManager,
    sessionId: string,
  ): Promise<{ events: { method: string; params: Record<string, unknown> }[]; truncated: boolean }> {
    const pages: unknown[][] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const result = await manager.pageView(sessionId, { cursor, direction: "backward", limit: HISTORY_PAGE_SIZE });
      pages.unshift(result.events);
      if (!result.nextCursor || result.events.length === 0) {
        break;
      }
      cursor = result.nextCursor;
      truncated = page === MAX_HISTORY_PAGES - 1;
    }
    return {
      events: pages.flat().map(stripEvent).filter((e): e is NonNullable<typeof e> => e !== null),
      truncated,
    };
  }

  /**
   * History without the ending the view lends a turn still running. Loading a thread mid-turn used
   * to show that turn as failed and its open tool calls as failed with it, and the calls stayed that
   * way after they finished (#54). `record` is what the resume said; a session another host holds
   * has none, and one whose turn started as the page was read has a stale one, so an ending left
   * unexplained is checked against a fresh read. Only what the ending looks like counts then: read
   * after the pages, a head can be a cursor one of them filled with a lent event.
   */
  private async settled(
    manager: SessionManager,
    sessionId: string,
    events: { method: string; params: Record<string, unknown> }[],
    record: SessionRecordView | undefined,
  ): Promise<{ method: string; params: Record<string, unknown> }[]> {
    const first = withoutProvisionalEnding(events, [record?.activeTurnId], record?.head);
    if (first.length !== events.length || !endsIncomplete(events)) {
      return first;
    }
    const fresh = await this.readRecord(manager, sessionId).catch(() => undefined);
    return withoutProvisionalEnding(events, [fresh?.activeTurnId], null);
  }

  private async loadTranscript(sessionId: string): Promise<Record<string, unknown>> {
    // A goal change can land while this load is in flight; history must not then write the older goal back.
    const goalSeqAtStart = this.liveFor(sessionId).goalSeq;
    const found = this.store.findSession(sessionId);
    const host = await this.hostFor(found?.cwd ?? "", found?.session.accountId ?? null);
    const manager = host.manager;
    let readOnly = false;
    let readOnlyReason: string | null = null;
    let msp: Record<string, unknown> | null = null;
    let resumedAs: SessionRecordView | undefined;
    try {
      const resumed = await manager.resumeSession(sessionId, true);
      msp = asRecord(asRecord(resumed)?.["session"]);
      resumedAs = recordView(resumed);
      this.sessionHosts.set(sessionId, host.key);
    } catch (error) {
      const info = errorInfo(error);
      // Only another host holding the session makes it read-only here; any other failure is real and surfaces.
      if (info.kind !== "sessionInUse") {
        throw error;
      }
      readOnly = true;
      readOnlyReason = info.message;
    }

    let events: { method: string; params: Record<string, unknown> }[] = [];
    let truncated = false;
    try {
      const paged = await this.pageTranscript(manager, sessionId);
      events = await this.settled(manager, sessionId, paged.events, resumedAs);
      truncated = paged.truncated;
      if (!readOnly) {
        // History ends where the tail begins: the newest event read is where a quiet feed is paged from.
        this.tail.anchor(sessionId, newestCursor(events));
      }
    } catch (error) {
      const kind = errorInfo(error).kind;
      // view/page needs a loaded session; another host's lease leaves this host with nothing to page.
      if (kind !== "sessionInUse" && kind !== "sessionNotLoaded") {
        throw error;
      }
    }

    // session/read with items is a point-in-time log: it does not take the lease, so CLI history still lands.
    if (events.length === 0) {
      const read = await manager.readSession(sessionId, false).catch(() => null);
      const payload = asRecord(read);
      if (!msp) {
        msp = asRecord(payload?.["session"]);
      }
      events = eventsFromHistory(payload);
    }

    const pending = await manager.listPending(sessionId).catch(() => ({ approvals: [], userInputs: [] }));
    const approvals = pending.approvals.map((a) => stripSource(asRecord(a) ?? {}));
    const userInputs = pending.userInputs.map((u) => stripSource(asRecord(u) ?? {}));

    const live = this.liveFor(sessionId);
    if (msp) {
      const active = str(msp["activeTurnId"]);
      if (active !== live.activeTurnId) {
        live.activeTurnId = active;
        live.turnStartedAt = active ? (live.turnStartedAt ?? nowIso()) : null;
      }
    }
    live.pendingApprovals = new Set(approvals.map((a) => str(a["approvalId"])).filter((id): id is string => id !== null));
    live.pendingInputs = new Set(userInputs.map((u) => str(u["userInputId"])).filter((id): id is string => id !== null));
    // Opening a thread backfills the usage page with the calls it made before this server ever ran.
    for (const event of events) {
      if (event.method === "session/tokenUsage") {
        this.recordUsage(sessionId, event.params);
      }
    }
    // The history's last goal change is the goal as of now, unless a live one arrived while this load ran.
    for (let index = events.length - 1; live.goalSeq === goalSeqAtStart && index >= 0; index -= 1) {
      const event = events[index];
      const goal = event?.method === "session/goalChanged" ? goalOf(event.params["goal"]) : undefined;
      if (goal !== undefined) {
        live.goal = goal;
        break;
      }
    }
    this.emitStatus(sessionId);

    if (found) {
      this.store.recordSession({
        id: sessionId,
        projectId: found.session.projectId,
        turnCount: num(msp?.["turnCount"]),
        modelId: msp ? str(msp["modelId"]) : null,
        activityAt: normalizeIso(msp?.["updatedAt"]),
      });
      if (found.session.titleSource === "placeholder") {
        const title = titleFromEvents(events);
        if (title) {
          this.store.updateSession(sessionId, { title, titleSource: "auto" });
          this.titleUpgradePending.add(sessionId);
          // The history is in hand, so no queue and no re-page; the upgrade never throws.
          void this.maybeUpgradeThreadTitle(sessionId, firstUserText(events) ?? "");
          this.sessionsChanged();
        }
      }
    }
    const record = this.store.getSession(sessionId);
    return {
      session: record && found ? this.summary(record, found.cwd) : null,
      msp: msp
        ? {
            status: str(msp["status"]),
            activeTurnId: str(msp["activeTurnId"]),
            modelId: str(msp["modelId"]),
            approvalMode: asRecord(msp["approvalMode"])?.["mode"] ?? null,
            workspaceRoot: str(msp["workspaceRoot"]),
            turnCount: num(msp["turnCount"]) ?? 0,
            // History pages carry no context readings, so pass along the session's own when it has them.
            contextUsage: asRecord(msp["contextUsage"]) ?? null,
            tokenUsage: asRecord(msp["tokenUsage"]) ?? null,
          }
        : null,
      events,
      truncated,
      attachments: this.store.listAttachments(sessionId).map((record) => this.attachmentView(record)),
      shellRuns: this.store.listShellRuns(sessionId),
      pending: { approvals, userInputs },
      readOnly,
      readOnlyReason,
    };
  }

  private async discover(cwd?: string): Promise<Record<string, unknown>[]> {
    const host = await this.hostFor(cwd ?? "");
    const remote: unknown[] = [];
    let scanned = 0;
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      if (cursor !== null) {
        seen.add(cursor);
      }
      const page = await host.manager.listSessionsPage({
        workspaceRoot: cwd ? this.hostPathFor(cwd) : undefined,
        limit: DISCOVER_PAGE_SIZE,
        cursor,
      });
      scanned += page.sessions.length;
      // Subagent rows are dropped below, so they must not use up the budget meant for real threads (#50).
      remote.push(...page.sessions.filter((item) => !isSubagentRow(item)).slice(0, DISCOVER_LIMIT - remote.length));
      // An empty page, or a cursor already followed, would never move the scan forward.
      cursor = page.sessions.length > 0 && page.nextCursor && !seen.has(page.nextCursor) ? page.nextCursor : null;
    } while (cursor && remote.length < DISCOVER_LIMIT && scanned < DISCOVER_SCAN_LIMIT);

    const views: Record<string, unknown>[] = [];
    let backfill = 0;
    for (const item of remote) {
      const record = asRecord(item);
      const session = (record && asRecord(record["session"])) ?? record;
      const sessionId = session ? str(session["sessionId"]) : null;
      if (!session || !sessionId) {
        continue;
      }
      // A subagent's own session is part of the thread that spawned it, not a thread of its own.
      if (session["kind"] === "subagent") {
        continue;
      }
      const reported = firstString(session, ["workspaceRoot"]);
      const root = this.storePathFor(discoveredProjectRoot(cwd, reported));
      if (!root) {
        continue;
      }
      const project = this.store.upsertProject(root);
      const existing = this.store.getSession(sessionId);
      // Muse names its own sessions, and that name is what the user sees in the CLI, so it wins here too.
      // Only a title the user typed in Helicon outranks it. MSP `title` is just the first-prompt echo,
      // so it is only a fallback, sanitized like any other derived title.
      const keepOurs = existing?.titleSource === "user";
      const mspName = keepOurs ? null : firstString(session, ["name"]);
      const mspTitle = keepOurs ? null : firstString(session, ["title"]);
      const echoTitle = mspName ? null : mspTitle ? deriveTitle(mspTitle) : null;
      // The echo is a fallback for threads seen here first, never an update: it must not clobber
      // a title a past upgrade wrote, or every discovery would revert it and spend another call.
      const takeEcho = echoTitle !== null && (!existing || existing.titleSource === "placeholder" || existing.title === echoTitle);
      const title = mspName ?? (takeEcho ? echoTitle : null);
      const stored = this.store.recordSession({
        id: sessionId,
        projectId: project.id,
        origin: existing?.origin ?? "tui",
        title: title ?? undefined,
        titleSource: title ? "auto" : undefined,
        turnCount: num(session["turnCount"]),
        modelId: str(session["modelId"]),
        createdAt: normalizeIso(session["createdAt"]),
        activityAt: normalizeIso(session["updatedAt"]),
        // Side chats are told apart by `sideFrom`, not by `kind`.
        sideOf: str(asRecord(session["sideFrom"])?.["sessionId"]),
      });
      const running = str(session["status"]) === "running" && Boolean(str(session["activeTurnId"]));
      if (running) {
        const live = this.liveFor(sessionId);
        live.activeTurnId = str(session["activeTurnId"]);
        live.turnStartedAt = live.turnStartedAt ?? nowIso();
        // Any host can list a session, but only the one that loaded it can page its view. A host
        // still alive keeps the session, or a refresh mid-turn would send its tail to the wrong one.
        if (!this.loadedManager(sessionId)) {
          this.sessionHosts.set(sessionId, host.key);
        }
      }
      // A settled thread that moved on in another Muse client (running now, or updated since) comes back.
      let current = stored;
      if (stored.settledOverride === "settled" && (running || (stored.settledAt !== null && stored.activityAt > stored.settledAt))) {
        this.wake(sessionId);
        current = this.store.getSession(sessionId) ?? stored;
      }
      if (mspName) {
        // A Muse-selected name is never upgraded, even if an echo here owed an attempt.
        this.titleUpgradePending.delete(sessionId);
      }
      // A stored echo still owes one LLM attempt; anything Muse named, the user typed, with a call
      // already in flight, or a past upgrade already replaced no longer qualifies, even across restarts.
      const needsUpgrade =
        !this.titleUpgradeActive.has(sessionId) &&
        (stored.titleSource === "placeholder" ||
          (stored.titleSource === "auto" && echoTitle !== null && stored.title === echoTitle));
      if (needsUpgrade && backfill < TITLE_BACKFILL_LIMIT) {
        backfill += 1;
        this.titleUpgradePending.add(sessionId);
        this.queueTitle(sessionId);
      }
      views.push(this.summary(current, project.cwd));
    }
    this.sessionsChanged();
    return views;
  }

  private queueTitle(sessionId: string): void {
    if (this.closed || this.titleQueue.includes(sessionId)) {
      return;
    }
    this.titleQueue.push(sessionId);
    if (!this.titleWorker) {
      this.titleWorker = this.drainTitles().finally(() => {
        this.titleWorker = null;
      });
    }
  }

  private async drainTitles(): Promise<void> {
    while (this.titleQueue.length > 0 && !this.closed) {
      const sessionId = this.titleQueue.shift() as string;
      try {
        const current = this.store.getSession(sessionId);
        if (!current || current.titleSource === "user") {
          this.titleUpgradePending.delete(sessionId);
          continue;
        }
        if (current.titleSource !== "placeholder" && !this.titleUpgradePending.has(sessionId)) {
          continue;
        }
        const host = await this.hostFor("");
        const page = await host.manager.pageView(sessionId, { direction: "forward", limit: 30 });
        if (this.closed) {
          return;
        }
        const events = page.events.map(stripEvent).filter((e): e is NonNullable<typeof e> => e !== null);
        if (current.titleSource === "placeholder") {
          const title = titleFromEvents(events);
          if (!title) {
            this.titleUpgradePending.delete(sessionId);
            continue;
          }
          this.store.updateSession(sessionId, { title, titleSource: "auto" });
          this.titleUpgradePending.add(sessionId);
          this.sessionsChanged();
        }
        await this.maybeUpgradeThreadTitle(sessionId, firstUserText(events) ?? "");
      } catch {
        /* a title is a nicety; the placeholder stays */
      }
    }
  }

  /**
   * One LLM title attempt for an echo-titled thread. Nothing happens on failure; the echo stays.
   * The claim happens before the first await, so a live upgrade and a queued one cannot both run.
   * Never throws, so live paths can fire it without awaiting it.
   */
  private async maybeUpgradeThreadTitle(sessionId: string, firstText: string): Promise<void> {
    if (!this.titleUpgradePending.has(sessionId) || this.titleUpgradeActive.has(sessionId)) {
      return;
    }
    try {
      const settings = this.store.getTitleSettings();
      if (!settings.enabled) {
        return;
      }
      const before = this.store.getSession(sessionId);
      // The title runs a local `muse exec`: an SSH thread's first prompt would reach the local login.
      const remote = isSshCwd(this.store.findSession(sessionId)?.cwd ?? "");
      if (!before || before.titleSource !== "auto" || !firstText.trim() || remote) {
        this.titleUpgradePending.delete(sessionId);
        return;
      }
      this.titleUpgradePending.delete(sessionId);
      this.titleUpgradeActive.add(sessionId);
      try {
        await this.runThreadTitleUpgrade(sessionId, firstText, before.title, settings.modelId);
      } finally {
        this.titleUpgradeActive.delete(sessionId);
      }
    } catch {
      /* a title is a nicety; the echo stays */
    }
  }

  private async runThreadTitleUpgrade(
    sessionId: string,
    firstText: string,
    expectedTitle: string,
    modelId: string | null,
  ): Promise<void> {
    const musePath = await this.cliMusePath();
    const plan = planMuseCli({
      platform: this.options.platform,
      distro: await this.wslDistro(),
      musePath,
      args: [
        "exec",
        "--json",
        "--no-session-log",
        "--disable-web-tools",
        "--reasoning-effort",
        "minimal",
        "--max-model-steps",
        "1",
        ...(modelId ? ["--model", modelId] : []),
        buildThreadTitlePrompt(firstText),
      ],
      runtime: await this.museRuntime(),
    });
    const result = await this.options.exec(plan.command, plan.args);
    if (this.closed || result.exitCode !== 0) {
      return;
    }
    const title = sanitizeThreadTitle(parseExecTitle(result.stdout) ?? "", firstText);
    if (!title || title === expectedTitle) {
      return;
    }
    const current = this.store.getSession(sessionId);
    if (!current || current.titleSource !== "auto" || current.title !== expectedTitle) {
      return;
    }
    this.store.updateSession(sessionId, { title, titleSource: "auto" });
    await this.renameInMuse(sessionId, title);
    this.sessionsChanged();
  }

  private async managerForSession(sessionId: string): Promise<SessionManager> {
    // Whatever is about to be asked of this session, its events should be looked for soon after.
    this.tail.nudge(sessionId);
    const key = this.sessionHosts.get(sessionId);
    const loaded = key ? this.hosts.get(key) : undefined;
    if (loaded) {
      return loaded.manager;
    }
    const found = this.store.findSession(sessionId);
    return (await this.hostFor(found?.cwd ?? "", found?.session.accountId ?? null)).manager;
  }

  private async hostFor(cwd: string, accountId: string | null = null): Promise<ManagedHost> {
    await this.museRuntime();
    // A flip's restart runs past its PATCH response. Wait it out so a new session never
    // starts on a host with the previous posture. Starts never wait for the chain, so this
    // cannot deadlock against the restart awaiting them.
    await this.restartChain;
    const key = this.hostKey(cwd, accountId);
    const existing = this.hosts.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.starting.get(key);
    if (pending) {
      return pending;
    }
    if (this.closed) {
      throw new HttpError(503, "Helicon is shutting down.");
    }
    const startup = this.spawnHost(key, cwd, accountId);
    this.starting.set(key, startup);
    try {
      return await startup;
    } finally {
      this.starting.delete(key);
    }
  }

  private async spawnHost(key: string, cwd: string, accountId: string | null): Promise<ManagedHost> {
    const target = await this.serveTargetFor(cwd, accountId);
    const handle = this.options.hostFactory(target);
    let started: { fingerprintWarning?: unknown; initializeResult?: unknown } | null;
    try {
      started = (await handle.start(HELICON_VERSION)) as typeof started;
    } catch (error) {
      this.lastHostError = error instanceof Error ? error.message : String(error);
      this.emit("helicon", { type: "host", key, state: "failed", message: this.lastHostError });
      // A deleted project folder surfaces as `write EPIPE` from the dead child (#105), which says
      // nothing about the cause. Only a failed start pays for the check.
      if (cwd && !isSshCwd(cwd) && !(await isDirectory(target.cwd))) {
        throw new HttpError(
          409,
          `The folder ${cwd} no longer exists, so Muse cannot start there. Recreate it (an empty folder is enough to open its threads again) or remove the project.`,
        );
      }
      throw new HttpError(502, `Could not start Muse: ${this.lastHostError}`);
    }
    this.lastHostError = null;
    this.fingerprints.set(key, started?.fingerprintWarning ?? null);
    const manager = new SessionManager(handle.connection);
    manager.onNotification((notification) => this.forward(key, notification));
    // A frame the SDK refuses never becomes a notification, so without this it is indistinguishable
    // from the backend having nothing to send (#42, H3).
    const reportsProtocolErrors = manager.onProtocolError((error) => {
      this.protocolErrors += 1;
      this.lastProtocolError = error instanceof Error ? error.message : String(error);
      this.log(`protocol error on host ${key}: ${this.lastProtocolError}`);
    });
    if (!reportsProtocolErrors) {
      this.log(`host ${key} cannot report protocol errors; dropped frames stay invisible`);
    }
    const serverInfo = asRecord(asRecord(started?.initializeResult)?.["serverInfo"]);
    const managed: ManagedHost = {
      key,
      accountId,
      target,
      handle,
      manager,
      serverVersion: serverInfo ? str(serverInfo["version"]) : null,
      startedAt: nowIso(),
    };
    handle.onExit?.((exit) => this.hostExited(managed, exit));
    this.hosts.set(key, managed);
    return managed;
  }

  private hostExited(managed: ManagedHost, exit: HostExit): void {
    if (this.hosts.get(managed.key) !== managed) {
      return;
    }
    const detail = managed.handle.recentStderr?.trim();
    const message = `The Muse host exited (${exit.code ?? exit.signal ?? "unknown"}).${detail ? ` ${detail}` : ""}`;
    this.lastHostError = message;
    this.emit("helicon", { type: "host", key: managed.key, state: "exited", message });
    this.forgetHost(managed, message);
  }

  /**
   * Drops a host gone for any reason. Its sessions resume lazily on their next touch, but anything
   * in flight is over, so live turns fail with the given message instead of hanging as running.
   */
  private forgetHost(managed: ManagedHost, lastError: string): void {
    this.hosts.delete(managed.key);
    for (const [sessionId, key] of this.sessionHosts) {
      if (key !== managed.key) {
        continue;
      }
      this.sessionHosts.delete(sessionId);
      this.tail.forget(sessionId);
      this.effortApplied.delete(sessionId);
      const live = this.live.get(sessionId);
      if (live && (live.activeTurnId || live.pendingApprovals.size || live.pendingInputs.size)) {
        live.activeTurnId = null;
        live.turnStartedAt = null;
        live.pendingApprovals.clear();
        live.pendingInputs.clear();
        live.lastTerminal = "failed";
        live.lastError = lastError;
        this.emitStatus(sessionId);
      }
    }
  }

  /**
   * Closes every live host so the next use respawns it with the current sandbox and YOLO
   * posture. Never throws: closing is best effort, and a host that refuses to die is dropped
   * the same way. The respawn only fixes new sessions: Muse commits each session's
   * filesystem/network posture at creation (a `yolo` cause carries fs=unrestricted,
   * net=enabled), so only new threads pick a flipped posture up. The approval side of YOLO
   * mode flips over MSP instead.
   */
  private async restartHosts(): Promise<void> {
    for (const pending of this.starting.values()) {
      await pending.catch(() => undefined);
    }
    for (const managed of [...this.hosts.values()]) {
      try {
        await managed.handle.close();
      } catch {
        /* best effort */
      }
      const message = "The Muse host restarted to apply a settings change.";
      this.forgetHost(managed, message);
      this.emit("helicon", { type: "host", key: managed.key, state: "restarted", message });
    }
  }

  private async accountList(): Promise<Record<string, unknown>[]> {
    const profiles = await this.aonia.listProfiles();
    return Promise.all(
      profiles.map(async (profile) => {
        const identity = await this.aonia.identityOf(profile);
        return {
          id: profile.id,
          name: profile.name,
          hasLogin: identity.hasLogin,
          email: identity.email,
          lastUsedAt: profile.lastUsedAt,
        };
      }),
    );
  }

  /** Turns an aonia error into the right HTTP status: a duplicate is 409, a bad id or missing profile is 400. */
  private accountError(error: unknown): HttpError {
    if (error instanceof AoniaError) {
      if (error.code === "profile_exists") {
        return new HttpError(409, error.message);
      }
      return new HttpError(400, error.message);
    }
    return new HttpError(500, error instanceof Error ? error.message : String(error));
  }

  /**
   * Spawns `muse login` for a profile and resolves as soon as the device URL appears in its output.
   * The child keeps running after that (the user finishes the sign-in in a browser); it exits on its
   * own. A second call for the same account id kills and replaces whatever is already running for it.
   */
  private async runLogin(id: string, profile: Profile): Promise<{ url: string; code: string | null }> {
    const command = this.aonia.loginCommand(profile);
    const resolved = command.command === "muse" && this.options.musePath ? this.options.musePath : command.command;
    const previous = this.loginChildren.get(id);
    if (previous) {
      previous.kill();
      this.loginChildren.delete(id);
    }
    const child = this.options.loginSpawn(resolved, command.args, { env: command.env });
    this.loginChildren.set(id, child);
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      let accumulated = "";
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        this.loginChildren.delete(id);
        reject(new HttpError(504, "Muse did not return a sign-in link."));
      }, LOGIN_TIMEOUT_MS);
      const onData = (chunk: unknown) => {
        if (settled) {
          return;
        }
        accumulated += String(chunk);
        const parsed = parseLoginOutput(accumulated);
        if (parsed.url) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({ url: parsed.url, code: parsed.code });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", () => {
        if (this.loginChildren.get(id) === child) {
          this.loginChildren.delete(id);
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new HttpError(504, "Muse did not return a sign-in link."));
        }
      });
      child.on("error", (error) => {
        if (this.loginChildren.get(id) === child) {
          this.loginChildren.delete(id);
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private async serveTargetFor(cwd: string, accountId: string | null = null): Promise<ServeTarget> {
    let profileEnv: Record<string, string> | null = null;
    if (accountId) {
      let profile;
      try {
        profile = await this.aonia.getProfile(accountId);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : `Unknown account "${accountId}".`);
      }
      profileEnv = this.aonia.envFor(profile);
    }
    // Sandbox posture is fixed at spawn: every host carries the settings as they stand now.
    const sandboxDisabled = this.store.getSandboxSettings().disabled;
    const yoloEnabled = this.store.getYoloSettings().enabled;
    const serveArgs = [
      "serve",
      ...(sandboxDisabled || yoloEnabled ? ["--disable-sandbox"] : []),
      ...(yoloEnabled ? ["--trust-workspace"] : []),
    ];
    if (isSshCwd(cwd)) {
      const parsed = parseSshProject(cwd);
      if (!parsed) {
        throw new HttpError(400, "SSH projects look like ssh://host/absolute/path.");
      }
      // MSP rides the SSH connection's stdio. The login on the remote host applies;
      // local profile env cannot cross SSH, so none is attached.
      return {
        command: "ssh",
        args: sshServeArgs(parsed.host, parsed.remotePath, serveArgs),
        cwd: process.cwd(),
      };
    }
    if (this.options.platform !== "win32") {
      return {
        command: this.options.musePath ?? "muse",
        args: serveArgs,
        cwd: cwd || process.cwd(),
        ...(profileEnv ? { env: { ...process.env, ...profileEnv } } : {}),
      };
    }
    const runtime = await this.museRuntime();
    let musePath = this.options.musePath ?? null;
    if (!musePath || (!musePath.includes("/") && !musePath.includes("\\"))) {
      const probe = await this.environment(false);
      musePath = probe.musePath;
    }
    if (runtime === "native") {
      if (!musePath) {
        throw new HttpError(503, "Muse for Windows is not installed. Install it from PowerShell: irm https://dev.meta.ai/install.ps1 | iex");
      }
      const releaseInfo = this.releaseInfoFor(musePath);
      return {
        command: musePath,
        args: serveArgs,
        cwd: this.spawnCwdFor(cwd) || process.cwd(),
        ...(releaseInfo || profileEnv
          ? { env: { ...process.env, ...(releaseInfo ? { MUSE_RELEASE_INFO: releaseInfo } : {}), ...(profileEnv ?? {}) } }
          : {}),
      };
    }
    // WSL profile env passthrough is P3 (needs WSLENV); accounts on WSL are a later change.
    const plan = planServe({
      platform: "win32",
      distro: await this.wslDistro(),
      musePath,
      cwd: this.spawnCwdFor(cwd),
      sandboxDisabled,
      yoloEnabled,
    });
    return { command: plan.command, args: plan.args, cwd: plan.cwd };
  }

  /** The launcher's release details for a binary in its install folder, as the launcher itself would pass them. */
  private releaseInfoFor(binary: string): string | null {
    const version = /muse-bin-(.+)\.exe$/i.exec(win32.basename(binary))?.[1] ?? null;
    return version ? nativeReleaseInfo({ binary, dir: win32.dirname(binary), version, launcher: null }) : null;
  }

  /**
   * One notification from a host. Everything here is wrapped: this runs inside the SDK's read loop,
   * so a throw used to take the whole host connection down with it and end every session on it, not
   * just the one that produced the bad frame (#42).
   */
  private forward(hostKey: string, notification: { method: string; params?: unknown; emittedAtMs?: number }): void {
    try {
      const params = asRecord(notification.params) ?? {};
      if (notification.method === "usage/changed") {
        const usage = parseSubscriptionUsage(params);
        const accountId = this.hosts.get(hostKey)?.accountId ?? null;
        this.observeUsage(usage, accountId);
        return;
      }
      const event = toWireEvent(notification.method, params, notification.emittedAtMs);
      if (!event) {
        // No sessionId, so there is nothing to route it to. Counted rather than dropped in silence.
        this.unroutedByMethod.set(notification.method, (this.unroutedByMethod.get(notification.method) ?? 0) + 1);
        return;
      }
      this.sessionHosts.set(event.sessionId, hostKey);
      this.noteNotification(event.sessionId, notification.method);
      // The tail keeps what it already delivered from a page, and holds a push that lands mid-page.
      if (!this.tail.heard(event.sessionId, { method: notification.method, params, at: notification.emittedAtMs })) {
        return;
      }
      this.track(event.sessionId, notification.method, params);
      this.emit("helicon", event);
    } catch (error) {
      this.forwardFailures += 1;
      this.lastForwardFailure = `${notification.method}: ${error instanceof Error ? error.message : String(error)}`;
      this.log(`forward(${notification.method}) threw: ${this.lastForwardFailure}`);
    }
  }

  /** One view event the tail paged or held back, taken exactly as a pushed one is. */
  private deliver(sessionId: string, event: TailEvent): void {
    try {
      const wire = toWireEvent(event.method, { ...event.params, sessionId }, event.at);
      if (!wire) {
        return;
      }
      this.track(sessionId, event.method, event.params);
      this.emit("helicon", wire);
    } catch (error) {
      this.forwardFailures += 1;
      this.lastForwardFailure = `${event.method}: ${error instanceof Error ? error.message : String(error)}`;
      this.log(`deliver(${event.method}) threw: ${this.lastForwardFailure}`);
    }
  }

  /** The host that has a session loaded, if one does. Unlike `managerForSession`, this never starts one. */
  private loadedManager(sessionId: string): SessionManager | null {
    const key = this.sessionHosts.get(sessionId);
    return (key ? this.hosts.get(key)?.manager : undefined) ?? null;
  }

  private async pageForward(sessionId: string, cursor: string | null): Promise<{ events: unknown[]; nextCursor: string | null }> {
    const manager = this.loadedManager(sessionId);
    if (!manager) {
      throw new Error("No host has this session loaded.");
    }
    return manager.pageView(sessionId, { cursor: cursor ?? undefined, direction: "forward", limit: TAIL_PAGE_SIZE });
  }

  /** Muse's own record of a session: a read that takes no lease, loads nothing and changes nothing. */
  private async readRecord(manager: SessionManager, sessionId: string): Promise<SessionRecordView | undefined> {
    return recordView(await manager.readSession(sessionId, true));
  }

  private believed(sessionId: string): { busy: boolean; activeTurnId: string | null } {
    const live = this.live.get(sessionId);
    // A monitor can start a turn with nobody asking, so a watching session is paged as a busy one is.
    return { busy: this.isBusy(sessionId) || (live?.monitors.size ?? 0) > 0, activeTurnId: live?.activeTurnId ?? null };
  }

  /**
   * Muse's session record and this server disagree about what is running, and the view holds no
   * event that settles it (#42: a view that stops advancing on a long-lived host). The record wins:
   * it is what a restart would read. A thread still showing the turn reloads from history on seeing this.
   */
  private correctActiveTurn(sessionId: string, activeTurnId: string | null): void {
    const live = this.liveFor(sessionId);
    if (live.activeTurnId === activeTurnId) {
      return;
    }
    live.activeTurnId = activeTurnId;
    live.turnStartedAt = activeTurnId ? nowIso() : null;
    this.emitStatus(sessionId);
    this.sessionsChanged();
  }

  /** Records that a session's feed is alive, so a silence can later be told apart from an idle session. */
  private noteNotification(sessionId: string, method: string): void {
    let stats = this.notifyStats.get(sessionId);
    if (!stats) {
      if (this.notifyStats.size >= NOTIFY_STATS_LIMIT) {
        const oldest = this.notifyStats.keys().next();
        if (!oldest.done) {
          this.notifyStats.delete(oldest.value);
        }
      }
      stats = { lastAt: 0, count: 0, byMethod: {} };
      this.notifyStats.set(sessionId, stats);
    }
    stats.lastAt = Date.now();
    stats.count += 1;
    stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
  }

  /** Everything worth reading later goes to stderr, which is where the daemon's log ends up. */
  private log(message: string): void {
    process.stderr.write(`[helicon] ${new Date().toISOString()} ${message}\n`);
  }

  private track(sessionId: string, method: string, params: Record<string, unknown>): void {
    const live = this.liveFor(sessionId);
    let changed = false;
    switch (method) {
      case "turn/started": {
        live.activeTurnId = str(params["turnId"]);
        live.turnStartedAt = nowIso();
        live.lastError = null;
        changed = true;
        this.wake(sessionId);
        break;
      }
      case "turn/completed": {
        const turnId = str(params["turnId"]);
        if (!live.activeTurnId || live.activeTurnId === turnId) {
          live.activeTurnId = null;
          live.turnStartedAt = null;
        }
        const terminal = str(params["terminal"]) ?? "completed";
        live.lastTerminal = terminal;
        live.lastError = terminal === "failed" ? (str(asRecord(params["error"])?.["message"]) ?? "The turn failed.") : null;
        if (turnId) {
          try {
            this.store.recordTurn(turnId, sessionId);
            this.store.updateTurnStatus(turnId, terminal);
          } catch {
            /* session not tracked locally */
          }
        }
        changed = true;
        this.sessionsChanged();
        break;
      }
      case "approval/requested": {
        const id = str(params["approvalId"]);
        if (id && !live.pendingApprovals.has(id)) {
          live.pendingApprovals.add(id);
          changed = true;
          this.wake(sessionId);
        }
        break;
      }
      case "approval/resolved": {
        const id = str(params["approvalId"]);
        changed = id ? live.pendingApprovals.delete(id) : false;
        break;
      }
      case "userInput/requested": {
        const id = str(params["userInputId"]);
        if (id && !live.pendingInputs.has(id)) {
          live.pendingInputs.add(id);
          changed = true;
          this.wake(sessionId);
        }
        break;
      }
      case "userInput/settled": {
        const id = str(params["userInputId"]);
        changed = id ? live.pendingInputs.delete(id) : false;
        break;
      }
      case "session/closed": {
        changed = live.activeTurnId !== null || live.pendingApprovals.size > 0 || live.pendingInputs.size > 0 || live.monitors.size > 0;
        live.activeTurnId = null;
        live.turnStartedAt = null;
        live.pendingApprovals.clear();
        live.pendingInputs.clear();
        live.monitors.clear();
        this.sessionHosts.delete(sessionId);
        this.tail.forget(sessionId);
        break;
      }
      case "session/modelChanged": {
        const modelId = str(params["modelId"]);
        if (modelId) {
          this.store.updateSession(sessionId, { modelId });
        }
        break;
      }
      case "session/tokenUsage": {
        this.recordUsage(sessionId, params);
        break;
      }
      case "session/goalChanged": {
        const goal = goalOf(params["goal"]);
        // A block with no objective is not a goal; the last one stands.
        if (goal !== undefined) {
          live.goal = goal;
          live.goalSeq += 1;
          changed = true;
        }
        break;
      }
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const item = asRecord(params["item"]);
        if (method === "item/completed" && item && item["kind"] === "userMessage") {
          this.maybeTitle(sessionId, item);
        }
        // A monitor is a `monitor` tool call that stays in progress while it watches; stopping it cancels the item.
        if (item && item["kind"] === "toolCall" && item["tool"] === "monitor") {
          const id = str(item["itemId"]);
          if (id) {
            const before = live.monitors.size;
            if (item["status"] === "inProgress") {
              live.monitors.add(id);
            } else {
              live.monitors.delete(id);
            }
            changed = live.monitors.size !== before;
          }
        }
        break;
      }
      case "session/nameChanged": {
        this.adoptMuseName(sessionId, str(params["name"]));
        break;
      }
      case "session/reasoningEffortChanged": {
        const effort = params["reasoningEffort"];
        if (isReasoningEffort(effort)) {
          this.effortApplied.set(sessionId, effort);
        }
        break;
      }
      case "skill/changed": {
        // The next skill list for this session's workspace goes back to Muse instead of the cache.
        const found = this.store.findSession(sessionId);
        this.skillCache.delete(found?.cwd || "__default__");
        break;
      }
      default:
        break;
    }
    if (changed) {
      this.emitStatus(sessionId);
    }
  }

  /**
   * Gives Muse the name typed here, so the CLI, `/name` addressing and other clients see it too. Only a host that
   * already has the session loaded is asked; the local title stands either way, since a thread that never loads
   * still deserves the name the user gave it.
   */
  private async renameInMuse(sessionId: string, name: string): Promise<void> {
    const hostKey = this.sessionHosts.get(sessionId);
    const managed = hostKey ? this.hosts.get(hostKey) : undefined;
    if (!managed) {
      return;
    }
    try {
      await managed.manager.renameSession(sessionId, name);
    } catch {
      /* an ephemeral session, or a host without session/rename */
    }
  }

  /**
   * The file viewer. Every call names a project folder the user added, never an arbitrary path: the folder is where
   * reading and writing are confined, and a path that leaves it is refused.
   */
  private async files(method: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = method === "PUT" || method === "POST" ? await this.readBody(req) : {};
    const cwd = str(body["cwd"]) ?? url.searchParams.get("cwd");
    if (!cwd || !this.store.getProject(cwd)) {
      throw new HttpError(404, "Unknown project folder.");
    }
    if (isSshCwd(cwd)) {
      throw new HttpError(400, "The file viewer is not available for SSH projects in this version.");
    }
    let root: string;
    try {
      root = resolveUserPath(cwd, await this.pathContext(cwd)).local;
    } catch {
      root = this.localPathFor(cwd);
    }
    const target = str(body["path"]) ?? url.searchParams.get("path") ?? "";
    if (method === "GET" && path === "/api/files/list") {
      this.json(res, 200, await listFolder(root, cwd, target));
      return true;
    }
    if (method === "GET" && path === "/api/files/read") {
      this.json(res, 200, await readProjectFile(root, cwd, target));
      return true;
    }
    if ((method === "GET" || method === "HEAD") && path === "/api/files/raw") {
      await serveProjectFile(req, res, root, cwd, target);
      return true;
    }
    if (method === "GET" && path === "/api/files/search") {
      this.json(res, 200, { files: await searchProjectFiles(root, url.searchParams.get("q") ?? "") });
      return true;
    }
    if (method === "PUT" && path === "/api/files/write") {
      const content = body["content"];
      if (typeof content !== "string") {
        throw new HttpError(400, "content is required.");
      }
      const base = body["baseMtimeMs"];
      this.json(res, 200, await writeProjectFile(root, cwd, target, content, typeof base === "number" ? base : null));
      return true;
    }
    if (method === "POST" && path === "/api/files/revert") {
      const raw = body["steps"];
      const steps = Array.isArray(raw)
        ? raw.flatMap((entry: unknown) => {
            const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
            return e && typeof e["after"] === "string" && (typeof e["before"] === "string" || e["before"] === null)
              ? [
                  {
                    before: e["before"] as string | null,
                    after: e["after"],
                    ...(typeof e["at"] === "number" && Number.isFinite(e["at"]) ? { at: e["at"] } : {}),
                  },
                ]
              : [];
          })
        : [];
      if (!Array.isArray(raw) || steps.length !== raw.length) {
        throw new HttpError(400, "steps must be a list of { before, after }.");
      }
      this.json(res, 200, await revertProjectFile(root, cwd, target, steps));
      return true;
    }
    if (method === "POST" && path === "/api/files/open") {
      const { abs } = await resolveInRoot(root, target, cwd);
      await this.opener(abs, "files");
      this.json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  /** A newer subscription window from any host replaces the one held, and every open window hears about it. */
  private observeUsage(usage: SubscriptionUsage | null, accountId: string | null = null): void {
    if (!usage) {
      return;
    }
    let changed = false;
    if (accountId) {
      const prior = this.planUsageByAccount.get(accountId);
      if (!prior || prior.observedAtMs < usage.observedAtMs) {
        this.planUsageByAccount.set(accountId, usage);
        changed = true;
      }
    }
    if (!this.planUsage || this.planUsage.observedAtMs < usage.observedAtMs) {
      this.planUsage = usage;
      changed = true;
    }
    if (changed) {
      this.emit("helicon", { type: "plan-usage", usage, accountId });
    }
  }

  /** Asks every running host what it last saw; none is started just for this, since it would have seen nothing. */
  private async readPlanUsage(): Promise<{ usage: SubscriptionUsage | null; byAccount: Record<string, SubscriptionUsage> }> {
    await Promise.all(
      [...this.hosts.values()].map(async (managed) => {
        try {
          this.observeUsage(await managed.manager.readSubscriptionUsage(), managed.accountId);
        } catch {
          /* an older host without usage/read */
        }
      }),
    );
    return { usage: this.planUsage, byAccount: Object.fromEntries(this.planUsageByAccount) };
  }

  /** Muse named or renamed the session, here or in another client; the newest name wins, and a typed title stays typed. */
  private adoptMuseName(sessionId: string, name: string | null): void {
    const title = name?.trim().slice(0, 200);
    const record = title ? this.store.getSession(sessionId) : null;
    if (!title || !record || record.title === title) {
      return;
    }
    // A Muse-selected name is never upgraded, even if an echo here owed an attempt.
    this.titleUpgradePending.delete(sessionId);
    this.store.updateSession(sessionId, { title, titleSource: record.titleSource === "user" ? "user" : "auto" });
    this.sessionsChanged();
  }

  /**
   * Puts a session on the effort a turn asks for. `muse serve` 1.3.0 drops the effort sent with `turn/start`
   * (muse-code-sdk#6) but honours the session default, so that is what carries it. A host without the method
   * leaves the turn's own effort to do what it can; a session that is not loaded fails the turn the same way.
   */
  private async applyEffort(manager: SessionManager, sessionId: string, effort: ReasoningEffort): Promise<void> {
    if (this.effortApplied.get(sessionId) === effort) {
      return;
    }
    try {
      await manager.setReasoningEffort(sessionId, effort);
      this.effortApplied.set(sessionId, effort);
    } catch (error) {
      const kind = errorInfo(error).kind;
      if (kind === "sessionNotLoaded" || kind === "sessionStreamMismatch" || kind === "sessionNotFound") {
        throw error;
      }
    }
  }

  private maybeTitle(sessionId: string, item: Record<string, unknown>): void {
    const record = this.store.getSession(sessionId);
    if (!record || record.titleSource !== "placeholder") {
      return;
    }
    const raw = str(item["displayText"]) ?? str(item["text"]) ?? "";
    const title = deriveTitle(raw);
    if (title) {
      this.store.updateSession(sessionId, { title, titleSource: "auto" });
      this.titleUpgradePending.add(sessionId);
      // The text is in hand, so no queue and no re-page; the upgrade never throws.
      void this.maybeUpgradeThreadTitle(sessionId, raw);
      this.sessionsChanged();
    }
  }
}

function titleFromEvents(events: { method: string; params: Record<string, unknown> }[]): string | null {
  for (const event of events) {
    const item = asRecord(event.params["item"]);
    if (item && item["kind"] === "userMessage") {
      const title = deriveTitle(str(item["displayText"]) ?? str(item["text"]) ?? "");
      if (title) {
        return title;
      }
    }
  }
  return null;
}

/** The raw opening prompt behind an echo title, for asking Muse for a better one. */
function firstUserText(events: { method: string; params: Record<string, unknown> }[]): string | null {
  for (const event of events) {
    const item = asRecord(event.params["item"]);
    if (item && item["kind"] === "userMessage") {
      const text = str(item["displayText"]) ?? str(item["text"]) ?? "";
      if (text.trim()) {
        return text;
      }
    }
  }
  return null;
}

export async function resolveMusePath(
  platform: string,
  distro: string,
): Promise<string | null> {
  if (platform === "win32") {
    const probe = await probeEnvironment(defaultExec, platform);
    void distro;
    return probe.musePath;
  }
  const found = await defaultExec("sh", ["-lc", "command -v muse"]);
  if (found.exitCode !== 0) {
    return null;
  }
  return found.stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
}

export { resolveMuseInDistro };
