/** Domain types shared by the UI, the client contract and the pure fold logic. */

export type ApprovalMode = "allowAll" | "denyUnmatched" | "onRequest" | "promptUnmatched";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type IfBusy = "queue" | "steer";

export interface EnvironmentStatus {
  platform: string;
  /** Where Muse runs: on the OS itself, as native Windows Muse, or in WSL. Older servers leave it out. */
  runtime?: "posix" | "native" | "wsl";
  wslAvailable: boolean;
  defaultDistro: string | null;
  museFound: boolean;
  musePath: string | null;
  /** False when the default Muse login has no stored credentials; null or missing when Helicon cannot tell. */
  museSignedIn?: boolean | null;
  /** Whether an `ssh` client runs where the server does, which SSH projects need. Older servers leave it out. */
  sshFound?: boolean;
  version: string;
  persistent: boolean;
}

export interface ProjectView {
  cwd: string;
  displayName: string;
  pinned: boolean;
  activityAt: string;
  /** The account new threads here default to; null for the default login. */
  defaultAccountId: string | null;
}

/** Server-tracked live state for a session; null until the server has seen it run. */
export interface LiveView {
  activeTurnId: string | null;
  turnStartedAt: string | null;
  pendingApprovals: number;
  pendingInputs: number;
  lastTerminal: string | null;
  lastError: string | null;
  /** The session's goal as the server last saw it, for threads the UI has not opened. */
  goal?: Goal | null;
  /** Monitors still watching in the background, for threads the UI has not opened. Older servers leave it out. */
  monitors?: number;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title: string;
  titleSource: "placeholder" | "auto" | "user";
  turnCount: number;
  modelId: string | null;
  origin: string;
  archived: boolean;
  createdAt: string;
  activityAt: string;
  /** Shelved out of the active list, by hand or after days without activity. */
  settled: boolean;
  settledAt: string | null;
  /** When it was last brought back from the shelf; keeps its place in the active list. */
  unsettledAt: string | null;
  /** Pinned to the top of its project's thread list. */
  pinned: boolean;
  /** Sandbox posture at creation; null for threads recorded before tracking. */
  sandboxDisabled: boolean | null;
  /** The aonia profile this thread runs under; null for the default login. */
  accountId: string | null;
  /** For a side chat, the thread it was opened from; the sidebar nests it there. */
  sideOf?: string | null;
  live: LiveView | null;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface WorkflowChild {
  childId: string;
  attempt: number;
  label?: string;
  phase?: string;
  status: string;
  terminal?: string;
  /** How long the agent ran. Present once it has stopped. */
  durationMs?: number;
  resultRef?: string;
}

/** One MSP transcript item at some revision. Unknown fields are kept and ignored. */
export interface MspItem {
  itemId: string;
  kind: string;
  status: string;
  revision: number;
  turnId?: string | null;
  recordedAt?: string;
  fallbackText?: string;
  text?: string;
  displayText?: string;
  steered?: boolean;
  retracted?: boolean;
  commandId?: string;
  tool?: string;
  /** The tool's own words for this call (Muse 1.4.9+); the item's status picks the form. */
  displayLabel?: { active: string; done: string; neutral: string };
  args?: string;
  callId?: string;
  approvalId?: string;
  visibleOutput?: string;
  truncated?: boolean;
  failureKind?: string;
  failureReason?: string;
  background?: boolean;
  summary?: string[];
  commandText?: string;
  exitCode?: number;
  exitSignal?: number;
  durationMs?: number;
  objective?: string;
  role?: string;
  controlStatus?: string;
  result?: { summary?: string; text?: string; errorKind?: string };
  usage?: TokenUsage;
  children?: WorkflowChild[];
  message?: string;
  outcome?: string;
  reason?: string;
  trigger?: string;
  tokensBefore?: number;
  /** Muse 1.4.14+, `earlierHistory`: the last messages from the part of the log Muse pruned, standing in for those items. */
  earlierHistory?: { messages: { role: string; text: string }[] };
  tokensAfter?: number;
  /** `subagent`: the durable child id the `subagent/*` controls address. Muse 1.3.0 does not fill it in yet. */
  subagentId?: string;
  /** `reminderChild`: the background task this reminder is about. */
  taskId?: string;
  /** `workflow`, and a `subagent` a workflow owns: the run the workflow controls address. */
  workflowRunId?: string;
  /** `subagent` and `reminderChild`: the child's own session. */
  childSessionId?: string;
  /** `toolCall` and `userShell`: where the full output is kept when the view truncated it. */
  outputRef?: OutputRef;
  /** `backgroundTerminalCompletion` (Muse 1.4.12+): a command the agent sent to the background has finished. */
  backgroundTerminalCompletion?: BackgroundTerminalCompletion;
  /** `peerMessage` (Muse 1.4.20+): a message another session sent to this one. */
  peerMessage?: { body: string; remote: boolean; senderLabel: string; senderSessionId?: string };
  /** `systemNotice` (Muse 1.4.20+): `info`, `warning` or `error`. Open; absent means the host named no level. */
  noticeSeverity?: string;
  [key: string]: unknown;
}

/** What a `backgroundTerminalCompletion` item says about the backgrounded command. Muse always sends every field. */
export interface BackgroundTerminalCompletion {
  command: string;
  /** Empty when the command printed nothing. */
  output: string;
  outputTruncated: boolean;
  /** `completed`, `failed`, `cancelled`, `timedOut` or `rejected`. */
  terminalStatus: string;
  /** The call id of the tool call that started it. */
  toolCallId: string;
}

/** A tool's stored output. Read it through `item/readOutput` by `id`; the uri is only for display. */
export interface OutputRef {
  id: string;
  kind?: string;
  mediaType?: string;
  byteLen?: number;
  availability?: string;
}

/** One page of stored output. `offsetBytes + byteLen` is where the next page starts. */
export interface OutputRange {
  content: string;
  encoding: string;
  mediaType: string;
  offsetBytes: number;
  byteLen: number;
  eof: boolean;
}

export interface ApprovalChoice {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
  rulePreview?: string;
}

export interface ApprovalStage {
  argv: string[];
  position: number;
  totalStages: number;
}

export interface ApprovalSubject {
  kind: string;
  command?: string;
  path?: string;
  access?: string;
  host?: string;
  port?: number;
  protocol?: string;
  toolName?: string;
  target?: string;
  workspaceRoot?: string;
  stages?: ApprovalStage[];
  /** Muse 1.4.20+, `computerUseTakeover`: the session that holds the Computer Use lock now. Label and times only. */
  holder?: { sessionLabel: string; acquiredAt: string; lastActivityAt: string };
}

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  availableChoices: ApprovalChoice[];
  currentRequirementId: unknown;
  subject: ApprovalSubject;
  itemId?: string;
  toolName?: string;
  toolCallId?: string;
  turnId?: string;
  rawArgs?: string;
  protectedWrite?: boolean;
  judgeEscalated?: boolean;
  /** Muse 1.4.14+: the safety check's reason for flagging the call, one short line. */
  reviewerReason?: string;
  /** Muse 1.4.12+: what a Computer Use call is about to do, from the host rather than the model. */
  cuaCardFacts?: CuaCardFacts;
}

/** A Computer Use approval's facts. Empty lists and missing rows are left out. */
export interface CuaCardFacts {
  /** Muse 1.4.13+: data the call would send, such as a secret. A card with any offers only one-time choices. */
  data?: CuaDataFact[];
  /** For a browser, the host of the page in the target window. */
  page?: { host: string; hostAscii: string };
  /** Only the steps that change something, in call order. */
  steps?: CuaStep[];
  /** The target window's title. The app sets it, so it is shown quoted and never trusted. */
  windowTitle?: string;
}

/** One piece of data a Computer Use call would send. `kind` is open: `secret`, `other`, or one Helicon doesn't know yet. */
export interface CuaDataFact {
  kind: string;
  /** For a secret, the parts the host lets the card show. Never the value itself. */
  mask?: { chars?: number; last4?: string; prefix?: string };
  /** For a secret, the scanner's tag, such as `github_token`. Open. */
  secretKind?: string;
}

export interface CuaStep {
  /** The host's verb phrase, such as `click` or `type into`. */
  action: string;
  /** The key chord, for a key step. */
  chord?: string;
  /** The host's sentence for what the step may do. */
  effect: string;
  kind: string;
  /** The control's label. The app sets it, so it is shown quoted. */
  label?: string;
  /** Model coordinates from 0 to 1000, only for a step aimed at a point. */
  point?: { x: number; y: number };
  /** `button`, `link`, `menu item` or `key`. */
  roleWord?: string;
  /** The step's place in the whole batch, from 1. Steps that change nothing are left out, so the numbers can skip. */
  step: number;
}

export interface UserInputOption {
  label: string;
  description?: string;
  preview?: { content: string; format: string };
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
  selection: { mode: "single" | "multiple" | string; minSelections?: number; maxSelections?: number };
}

export interface UserInputRequest {
  userInputId: string;
  sessionId: string;
  questions: UserInputQuestion[];
  itemId?: string;
  toolName?: string;
  turnId?: string;
  autoResolutionMs?: number;
}

export interface UserInputAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
}

export interface TodoItem {
  text: string;
  status: string;
  activeForm?: string;
}

export interface ContextUsage {
  usedTokens: number;
  windowTokens?: number;
  pressure: string;
}

export interface TokenTotals {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface Goal {
  objective: string;
  status: string;
  percentComplete: number;
  currentWork?: string;
  nextWork?: string;
}

export interface ModelOption {
  modelId: string;
  displayLabel: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  contextLimit: number | null;
  outputLimit: number | null;
  /** Catalog price per million tokens; null when the catalog lists none. */
  cost: { input: number; output: number; cached: number; currency: string | null } | null;
  /** Contributor-tier models may use prompts and outputs for product improvement. */
  contributor: boolean;
}

/** Server-owned thread-title generation: the switch, and the model when one is chosen. */
export interface TitleSettings {
  enabled: boolean;
  modelId: string | null;
}

/** Server-owned Muse sandbox posture: whether hosts spawn with `--disable-sandbox`. */
export interface SandboxSettings {
  disabled: boolean;
}

/** Server-owned YOLO mode: hosts spawn with `--disable-sandbox --trust-workspace`, approvals bypassed. */
export interface YoloSettings {
  enabled: boolean;
}

/** Server-owned feed mode: whether a thread Muse stops sending updates for is asked for them instead. */
export interface FeedSettings {
  catchUp: boolean;
}

/** A skill Muse can load in a workspace, from `muse skills list`. Skills switched off are left out. */
export interface SkillEntry {
  id: string;
  name: string;
  displayName: string;
  /** Written for the model, so often long; menus show `shortDescription` or its first sentence. */
  description: string;
  shortDescription: string | null;
  scope: string;
  /** `on`, or `user-invocable-only` for skills the model never loads by itself. */
  activation: string;
  /** What the skill expects after its name, when it says. */
  argumentHint?: string | null;
}

/** The skills for one workspace; `error` says why the list is empty when loading failed. */
export interface SkillCatalog {
  skills: SkillEntry[];
  error: string | null;
}

/** The subfolders of one folder, for the add-project picker. */
export interface DirectoryListing {
  /** The folder listed, as an absolute path in the user's style (`~` expanded). */
  directory: string;
  parent: string | null;
  separator: "/" | "\\";
  exists: boolean;
  entries: { name: string }[];
}

/** A `!` command Helicon ran itself in the workspace, with what it printed. */
export interface ShellRun {
  id: string;
  sessionId: string;
  command: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  durationMs: number | null;
  at: string;
}

/** One day's tokens for one model, as the server aggregates them for the usage page. */
export interface UsageBucket {
  day: string;
  modelId: string;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number;
}

export interface UsageThread {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelIds: string[];
  /** Tokens split by model, so a thread that switched models is priced at each model's own rate. */
  models?: { modelId: string; calls: number; promptTokens: number; outputTokens: number; cachedTokens: number }[];
  lastAt: string;
}

/** Every model call Helicon has seen, bucketed; the UI puts prices on it. */
export interface UsageReport {
  since: string;
  days: number;
  buckets: UsageBucket[];
  threads: UsageThread[];
}

/** What one OMP `muse-code` usage import scanned and recorded. */
export interface OmpImportResult {
  files: number;
  sessions: number;
  calls: number;
  skipped: number;
}

/** A view notification, live or paged from history. `at` is the emission time when known. */
export interface ViewEvent {
  method: string;
  params: Record<string, unknown>;
  at?: number;
}

/** A file the user attached to a prompt, as the server kept it: Muse's own view carries metadata only. */
export interface AttachmentView {
  id: string;
  turnId: string | null;
  name: string;
  mediaType: string;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  /** Where the bytes are served from, relative to the server. */
  url: string;
}

/** A file on its way out with a prompt. */
export interface OutgoingAttachment {
  name: string;
  mediaType: string;
  /** The file's bytes, base64 without a `data:` prefix. */
  base64: string;
  width?: number;
  height?: number;
}

/** A usage window as a percentage of the plan's allowance, with when it resets. */
export interface PlanWindow {
  usedPercent: number;
  resetsAtMs: number;
  /** The short rolling window's length; null for the weekly block. */
  windowDurationMins: number | null;
}

/** The subscription meter Muse last saw: the rolling window, the weekly cap, and the plan tier. */
export interface PlanUsage {
  tier: string;
  observedAtMs: number;
  window: PlanWindow;
  weekly: PlanWindow;
}

export type PlanUsageByAccount = Record<string, PlanUsage>;

export interface AccountView {
  id: string;
  name: string;
  hasLogin: boolean;
  email: string | null;
  lastUsedAt: string | null;
}

/** What the file viewer does with a file: text and markdown come inline, media is loaded from its own URL. */
export type FileKind = "text" | "markdown" | "image" | "video" | "audio" | "pdf" | "binary";

export interface FileEntry {
  name: string;
  /** Relative to the project folder, with forward slashes. */
  path: string;
  kind: "dir" | "file";
  size: number;
  mtimeMs: number;
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  /** When it was last written; a save sends it back, so an edit made meanwhile is not overwritten. */
  mtimeMs: number;
  kind: FileKind;
  mediaType: string;
  /** Text and markdown only. */
  content?: string;
  /** Text too large to send whole; `content` is its start. */
  truncated: boolean;
}

export type GoalAction = "set" | "edit" | "pause" | "resume" | "clear";
export type SubagentAction = "interrupt" | "stop" | "close" | "resume" | "reopen" | "sendMessage" | "followupTask" | "readResult";
export type TaskAction = "background" | "stop" | "stopAll";
export type WorkflowAction = "cancel" | "pause" | "resume" | "skip" | "retry";

export interface TranscriptLoad {
  session: SessionSummary | null;
  msp: {
    status: string | null;
    activeTurnId: string | null;
    modelId: string | null;
    approvalMode: string | null;
    workspaceRoot: string | null;
    turnCount: number;
    contextUsage?: ContextUsage | null;
    tokenUsage?: TokenTotals | null;
  } | null;
  events: ViewEvent[];
  truncated: boolean;
  /** Every file attached to this thread's prompts, in send order. */
  attachments?: AttachmentView[];
  /** Every `!` command Helicon ran itself for this thread. */
  shellRuns?: ShellRun[];
  pending: { approvals: ApprovalRequest[]; userInputs: UserInputRequest[] };
  readOnly: boolean;
  readOnlyReason: string | null;
}

export type HeliconEvent =
  | { type: "hello"; version: string }
  | { type: "msp"; sessionId: string; method: string; params: Record<string, unknown>; at: number }
  | { type: "session-status"; sessionId: string; live: LiveView | null }
  /** The server asked Muse and this turn is still running, with nothing new to show for it. */
  | { type: "feed"; sessionId: string; activeTurnId: string; at: number }
  | { type: "sessions-changed" }
  | { type: "shell-run"; sessionId: string; run: ShellRun }
  | { type: "plan-usage"; usage: PlanUsage; accountId: string | null }
  | { type: "host"; key: string; state: string; message: string }
  | { type: "connection"; state: "open" | "lost" };
