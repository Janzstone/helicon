import { errorKind, errorMessage, type HeliconClient } from "../client.js";
import type {
  ApprovalMode,
  ApprovalRequest,
  AttachmentView,
  FeedSettings,
  GoalAction,
  HeliconEvent,
  OutgoingAttachment,
  OutputRange,
  ReasoningEffort,
  SessionSummary,
  SkillEntry,
  SubagentAction,
  TaskAction,
  UserInputAnswer,
  UserInputRequest,
  ViewEvent,
  WorkflowAction,
} from "../types.js";
import { withSettled } from "./changes.js";
import { describeTool, modelDisplayName, type RevertStep } from "./format.js";
import { fileKey, fileTarget, type LineRange } from "./files.js";
import { goalPrompt } from "./goal.js";
import { isSshPath } from "./paths.js";
import {
  INIT_PROMPT,
  findModel,
  parseEffort,
  parseMode,
  parseSlash,
  resolveSlash,
  skillTurn,
  slashCommands,
  type ParsedSlash,
} from "./slash.js";
import {
  addEcho,
  applyEvents,
  emptyFold,
  foldFromLoad,
  removeEcho,
  requirementIndex,
  updateEcho,
  type EchoAttachment,
  type LocalEcho,
  type ThreadFold,
} from "./fold.js";
import {
  FILES_WIDTH_MAX,
  FILES_WIDTH_MIN,
  Store,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  defaultPrefs,
  initialState,
  revivePrefs,
  type AppState,
  type CodeTheme,
  type ComposerPicker,
  type FilePanel,
  type GroupBy,
  type Prefs,
  type Route,
  type SkillsState,
  type ThemePref,
  type ThreadState,
  type Toast,
} from "./store.js";
import { NotificationManager, type Notifier } from "./notify.js";
import { UpdateManager, type AppUpdater } from "./updates.js";

/** The environment the controller runs in; injectable so the logic stays testable without a DOM. */
export interface Platform {
  loadPrefs(): unknown;
  savePrefs(prefs: Prefs): void;
  readHash(): string;
  writeHash(hash: string): void;
  onHashChange(handler: () => void): () => void;
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** Whether the window has the user's attention; nothing is announced to someone already watching. */
  focused(): boolean;
}

const PREFS_KEY = "helicon.prefs.v1";

export function browserPlatform(): Platform {
  return {
    loadPrefs: () => {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    },
    savePrefs: (prefs) => {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* storage unavailable: prefs stay in memory */
      }
    },
    readHash: () => window.location.hash,
    writeHash: (hash) => {
      if (hash) {
        window.location.hash = hash;
      } else if (window.location.hash) {
        window.history.pushState(null, "", window.location.pathname + window.location.search);
      }
    },
    onHashChange: (handler) => {
      window.addEventListener("hashchange", handler);
      window.addEventListener("popstate", handler);
      return () => {
        window.removeEventListener("hashchange", handler);
        window.removeEventListener("popstate", handler);
      };
    },
    now: () => Date.now(),
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (handle) => window.clearTimeout(handle as number),
    // A window with no document at all is not one anybody is looking at.
    focused: () => typeof document !== "undefined" && document.hasFocus(),
  };
}

export function routeToHash(route: Route): string {
  switch (route.kind) {
    case "home":
      return "";
    case "new":
      return route.cwd ? `#/new/${encodeURIComponent(route.cwd)}` : "#/new";
    case "thread":
      return `#/t/${encodeURIComponent(route.sessionId)}`;
    case "usage":
      return "#/usage";
    case "settings":
      return "#/settings";
  }
}

export function hashToRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h === "/usage") {
    return { kind: "usage" };
  }
  if (h === "/settings") {
    return { kind: "settings" };
  }
  const thread = h.match(/^\/t\/(.+)$/);
  if (thread) {
    return { kind: "thread", sessionId: decodeURIComponent(thread[1] as string) };
  }
  const fresh = h.match(/^\/new(?:\/(.+))?$/);
  if (fresh) {
    return { kind: "new", cwd: fresh[1] ? decodeURIComponent(fresh[1]) : null };
  }
  return { kind: "home" };
}

function blankThread(): ThreadState {
  return {
    load: "idle",
    error: null,
    readOnly: false,
    readOnlyReason: null,
    truncated: false,
    fold: emptyFold(),
    attachments: [],
    shellRuns: [],
    stalled: false,
  };
}

let localSeq = 0;
function nextLocalId(): string {
  localSeq += 1;
  return `local-${Date.now().toString(36)}-${localSeq}`;
}

/** What a prompt carries beyond its text: files for the model, and their local previews for the echo. */
interface TurnDelivery {
  steer?: boolean;
  /** Queue behind whatever is running even if this client has not seen the turn start yet. */
  queue?: boolean;
  displayText?: string;
  attachments?: OutgoingAttachment[];
  previews?: EchoAttachment[];
  /** Deliver to this thread rather than wherever the user is standing now: a retry belongs to the turn that failed. */
  sessionId?: string;
}

export interface SendOptions extends TurnDelivery {
  /** Send the text as a prompt even when it looks like a slash command. */
  raw?: boolean;
}

const FLUSH_MS = 24;
const TOAST_MS = { info: 5000, success: 4000, error: 9000 } as const;
const SKILLS_FRESH_MS = 60_000;
const SKILLS_RETRY_MS = 10_000;
/** How often loaded threads are checked for a stream that went silent. */
const STALE_CHECK_MS = 30_000;
/** How often an in-progress device-code login checks whether the account has signed in. */
const LOGIN_POLL_MS = 2_000;
/** Gives up polling after this many attempts (two minutes at `LOGIN_POLL_MS`); the modal stays open. */
const LOGIN_POLL_MAX_ATTEMPTS = 60;
/** A fold still showing a turn the server finished this long ago missed its ending: reload it. */
const DIVERGED_GRACE_MS = 30_000;
/** Both sides agree a turn is running, but nothing landed for this long: reload it. */
const QUIET_TURN_MS = 90_000;
/**
 * Reloads one stuck turn is worth. A turn whose ending is missing from history too, rather than
 * just from the stream, converges on nothing: without a cap the thread would refetch its whole
 * history every grace period for as long as it stays open, which is worst on the very large
 * sessions this watchdog exists for.
 */
const STALE_RELOAD_LIMIT = 2;

/** Why a loaded thread needs reloading from history: its ending never landed, or its stream went quiet mid-turn. */
export type StaleThreadReason = "diverged" | "quiet";

/**
 * Whether a loaded thread is stale enough to reload. A fold still showing a turn the server has
 * finished is a missed ending (#32: the view froze while the backend kept working); a turn both
 * sides agree is running but silent is a dead stream. Either way history converges the view, so a
 * reload is what a restart would have done, without losing the rest of the app.
 */
export function staleThreadReason(
  foldActiveTurnId: string | null,
  liveActiveTurnId: string | null | undefined,
  lastAppliedAt: number | null,
  now: number,
): StaleThreadReason | null {
  if (!foldActiveTurnId || lastAppliedAt === null) {
    return null;
  }
  if (!liveActiveTurnId) {
    return now - lastAppliedAt > DIVERGED_GRACE_MS ? "diverged" : null;
  }
  return now - lastAppliedAt > QUIET_TURN_MS ? "quiet" : null;
}

/**
 * Owns app state and every side effect: server calls, the event stream, routing and prefs.
 * Components read state through hooks and call these methods; they never talk to the client.
 */
const GOAL_FAILURES: Record<GoalAction, string> = {
  set: "Could not set the goal",
  edit: "Could not change the goal",
  pause: "Could not pause the goal",
  resume: "Could not resume the goal",
  clear: "Could not clear the goal",
};

const TASK_FAILURES: Record<TaskAction, string> = {
  background: "Could not move that to the background",
  stop: "Could not stop that task",
  stopAll: "Could not stop the background tasks",
};

export class HeliconController {
  readonly store: Store<AppState>;
  private readonly pending = new Map<string, ViewEvent[]>();
  private readonly loading = new Map<string, ViewEvent[]>();
  /** Thread loads in flight, so overlapping reloads of one session coalesce onto a single buffer. */
  private readonly inflightLoads = new Map<string, Promise<void>>();
  /** Keys of prompt deliveries still waiting for the server, so a double-sent draft turns once. */
  private readonly inflightSends = new Set<string>();
  private readonly disposers: (() => void)[] = [];
  private flushHandle: unknown = null;
  private refreshHandle: unknown = null;
  private saveHandle: unknown = null;
  private staleHandle: unknown = null;
  private disposed = false;
  /** When stream events were last applied per session, so a thread that went silent can be noticed. */
  private readonly appliedAt = new Map<string, number>();
  /** Reloads already spent on a thread's current stuck turn, so a hopeless one is not refetched forever. */
  private readonly staleReloads = new Map<string, { turnId: string; count: number }>();
  private refreshing: Promise<void> | null = null;
  private refreshQueued = false;
  private toastSeq = 0;
  /** Bumped by every title-settings request, so only the latest completion or rollback lands. */
  private titleSettingsRev = 0;
  /** Bumped by every sandbox-settings request, so only the latest completion or rollback lands. */
  private sandboxSettingsRev = 0;
  /** Sandbox PATCHes queue behind each other so rapid opposite flips land in order. */
  private sandboxSettingsChain: Promise<void> = Promise.resolve();
  /** Bumped by every yolo-settings request, so only the latest completion or rollback lands. */
  private yoloSettingsRev = 0;
  /** YOLO PATCHes queue behind each other so rapid opposite flips land in order. */
  private yoloSettingsChain: Promise<void> = Promise.resolve();
  /** Bumped by every feed-settings request, so only the latest completion or rollback lands. */
  private feedSettingsRev = 0;
  /** Feed PATCHes queue behind each other so rapid opposite flips land in order. */
  private feedSettingsChain: Promise<void> = Promise.resolve();
  /** The feed mode as the server last gave it, which is what a failed flip goes back to. */
  private feedSettingsConfirmed: FeedSettings | null = null;
  /** Bumped by every accounts request, so only the latest completion or rollback lands. */
  private accountsRev = 0;
  /** Account mutations queue behind each other so rapid edits land in order. */
  private accountsChain: Promise<void> = Promise.resolve();
  /** Bumped by every project-default-account request, so only the latest completion or rollback lands. */
  private projectDefaultRev = 0;
  /** Bumped by every `beginLogin`/`cancelLogin`, so a stale in-flight login never overwrites a newer one. */
  private loginRev = 0;
  /** The scheduled next poll tick for an in-progress device-code login, if one is pending. */
  private loginPollHandle: unknown = null;
  private loginPollAttempts = 0;
  /** Approval modes from before YOLO was armed, restored when it is switched off. Null when never armed here. */
  private preYolo: { defaultMode: ApprovalMode; threads: Record<string, ApprovalMode | null> } | null = null;
  /** The main route Back leaves the settings/usage pages for; cleared once back on a main route. */
  private returnRoute: Route | null = null;

  private updates: UpdateManager | null = null;
  private notifications: NotificationManager | null = null;
  /** Kept as well as the manager, because asking for permission is the shell's job, not the manager's. */
  private notifier: Notifier | null = null;

  constructor(
    readonly client: HeliconClient,
    private readonly platform: Platform = browserPlatform(),
  ) {
    const fallback = defaultPrefs(new Date(platform.now()).toISOString());
    this.store = new Store(initialState(revivePrefs(platform.loadPrefs(), fallback)));
    // Carries a pre-YOLO snapshot over a reload: the field itself is per-launch, but prefs are not.
    this.preYolo = this.state.prefs.preYolo;
  }

  private get state(): AppState {
    return this.store.get();
  }

  private update(fn: (state: AppState) => AppState): void {
    this.store.set(fn);
  }

  start(): () => void {
    this.disposers.push(this.client.subscribe((event) => this.onEvent(event)));
    this.disposers.push(
      this.platform.onHashChange(() => {
        const hash = this.platform.readHash();
        if (hash !== routeToHash(this.state.route)) {
          this.applyRoute(hashToRoute(hash), false);
        }
      }),
    );
    if (this.updates) {
      this.updates.start();
      this.disposers.push(() => this.updates?.stop());
    }
    this.scheduleStaleCheck();
    void this.boot(false);
    return () => this.dispose();
  }

  /**
   * How this shell tells the user something happened: the browser's own notifications, or whatever
   * the desktop OS ships. Call before `start`. Both settings are read per announcement, so turning
   * the switch off or coming back to the window takes effect at once.
   */
  attachNotifier(notifier: Notifier): void {
    this.notifier = notifier;
    this.notifications = new NotificationManager(
      notifier,
      () => ({ enabled: this.state.prefs.notifications, focused: this.platform.focused() }),
      () => this.platform.now(),
    );
  }

  /** Asks for permission, which browsers only grant from a real gesture, so a button has to call this. */
  async askToNotify(): Promise<void> {
    const granted = (await this.notifier?.request()) ?? "denied";
    if (granted !== "granted") {
      this.toast("info", "Notifications are off", "Your browser or system refused them, so nothing will be raised.");
      return;
    }
    this.setPrefs({ notifications: true });
  }

  /** The desktop shell's updater. Call before `start`; a browser never has one. */
  attachUpdater(updater: AppUpdater): void {
    this.updates = new UpdateManager(
      updater,
      () => ({ autoUpdate: this.state.prefs.autoUpdate, paused: this.state.prefs.updatesPaused }),
      (next) => {
        const previous = this.state.updates?.status;
        this.update((s) => ({ ...s, updates: next }));
        if (next.status === "ready" && previous !== "ready") {
          this.toast(
            "info",
            `Helicon ${next.update?.version ?? ""} is ready`,
            this.state.prefs.autoUpdate && !this.state.prefs.updatesPaused ? "It installs when you close Helicon." : "Restart Helicon to install it.",
            { label: "Restart now", run: () => this.restartToUpdate() },
          );
        }
      },
      () => this.platform.now(),
    );
    this.update((s) => ({ ...s, updates: this.updates?.current ?? null }));
  }

  checkForUpdates(): void {
    void this.updates?.check(true);
  }

  downloadUpdate(): void {
    void this.updates?.download();
  }

  restartToUpdate(): void {
    void this.updates?.restart();
  }

  setAutoUpdate(autoUpdate: boolean): void {
    this.setPrefs({ autoUpdate });
    if (autoUpdate && !this.state.prefs.updatesPaused) {
      void this.updates?.download();
    }
  }

  setUpdatesPaused(updatesPaused: boolean): void {
    this.setPrefs({ updatesPaused });
    if (!updatesPaused) {
      void this.updates?.check();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    for (const handle of [this.flushHandle, this.refreshHandle, this.saveHandle, this.staleHandle, this.loginPollHandle]) {
      if (handle !== null) {
        this.platform.cancel(handle);
      }
    }
    this.staleHandle = null;
    this.loginPollHandle = null;
    this.platform.savePrefs(this.state.prefs);
  }

  private async boot(refreshEnv: boolean): Promise<void> {
    this.update((s) => ({ ...s, boot: "loading", bootError: null }));
    try {
      const env = await this.client.probeEnvironment(refreshEnv);
      this.update((s) => ({ ...s, env }));
      if (!env.museFound) {
        this.update((s) => ({ ...s, boot: "ready" }));
        return;
      }
      await this.refresh();
      this.update((s) => ({ ...s, boot: "ready" }));
      this.applyRoute(hashToRoute(this.platform.readHash()), false);
      void this.discoverAll(true);
      void this.loadModels();
      void this.loadTitleSettings();
      void this.loadSandboxSettings();
      void this.loadYoloSettings();
      void this.loadFeedSettings();
      void this.loadPlanUsage();
      void this.loadAccounts();
    } catch (error) {
      this.update((s) => ({ ...s, boot: "error", bootError: errorMessage(error) }));
    }
  }

  retryBoot(): void {
    void this.boot(true);
  }

  /** Probes the environment again without a full reload, for when the person signs in to Muse after Helicon opened. */
  async recheckEnvironment(): Promise<void> {
    try {
      const env = await this.client.probeEnvironment(true);
      this.update((s) => ({ ...s, env }));
    } catch {
      // The card stays up and the person can try again.
    }
  }

  /** Clears the "Muse could not start" card once the person has fixed it, so the next prompt is a fresh try. */
  dismissHostError(): void {
    this.update((s) => ({ ...s, hostError: null }));
  }

  // ---------------------------------------------------------------- data

  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = this.loadLists()
      .catch((error) => {
        if (this.state.boot !== "ready") {
          throw error;
        }
      })
      .finally(() => {
        this.refreshing = null;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          void this.refresh();
        }
      });
    return this.refreshing;
  }

  private async loadLists(): Promise<void> {
    const [projects, sessions] = await Promise.all([this.client.listProjects(), this.client.listSessions()]);
    const byId: Record<string, SessionSummary> = {};
    for (const session of sessions) {
      byId[session.sessionId] = session;
    }
    this.update((s) => ({ ...s, projects, sessions: byId, sessionsLoaded: true }));
  }

  private scheduleRefresh(): void {
    if (this.refreshHandle !== null) {
      return;
    }
    this.refreshHandle = this.platform.schedule(() => {
      this.refreshHandle = null;
      void this.refresh();
    }, 150);
  }

  async discoverAll(silent = false): Promise<void> {
    if (this.state.discovering) {
      return;
    }
    this.update((s) => ({ ...s, discovering: true }));
    try {
      await this.client.discover();
      await Promise.all([this.refresh(), this.loadPlanUsage()]);
      if (!silent) {
        this.toast("success", "Threads refreshed");
      }
    } catch (error) {
      if (!silent) {
        this.toast("error", "Could not refresh threads from Muse", errorMessage(error));
      }
    } finally {
      this.update((s) => ({ ...s, discovering: false }));
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const models = await this.client.listModels();
      this.update((s) => ({ ...s, models }));
    } catch {
      /* the picker falls back to the session's model */
    }
  }

  private async loadTitleSettings(): Promise<void> {
    const rev = ++this.titleSettingsRev;
    try {
      const titleSettings = await this.client.getTitleSettings();
      if (rev === this.titleSettingsRev) {
        this.update((s) => ({ ...s, titleSettings }));
      }
    } catch {
      /* opening Settings retries the load */
    }
  }

  private async loadSandboxSettings(): Promise<void> {
    const rev = ++this.sandboxSettingsRev;
    try {
      const sandboxSettings = await this.client.getSandboxSettings();
      if (rev === this.sandboxSettingsRev) {
        this.update((s) => ({ ...s, sandboxSettings }));
      }
    } catch {
      /* opening Settings retries the load */
    }
  }

  private async loadFeedSettings(): Promise<void> {
    const rev = ++this.feedSettingsRev;
    try {
      const feedSettings = await this.client.getFeedSettings();
      if (rev === this.feedSettingsRev) {
        this.feedSettingsConfirmed = feedSettings;
        this.update((s) => ({ ...s, feedSettings }));
      }
    } catch {
      /* opening Settings retries the load */
    }
  }

  private async loadYoloSettings(): Promise<void> {
    const rev = ++this.yoloSettingsRev;
    // Held onto before the update overwrites it: another client can flip YOLO off without this one
    // ever calling `setYoloEnabled`, and that edge only shows up by comparing what this load replaces.
    const wasEnabled = this.state.yoloSettings?.enabled === true;
    try {
      const yoloSettings = await this.client.getYoloSettings();
      if (rev === this.yoloSettingsRev) {
        this.update((s) => ({ ...s, yoloSettings }));
        if (yoloSettings.enabled) {
          // Boot lands threads and settings in either order; a thread that loaded first still joins YOLO.
          for (const sessionId of Object.keys(this.state.threads)) {
            this.convergeThread(sessionId);
          }
        } else if (wasEnabled) {
          // Another client turned YOLO off. This client must stop auto-approving too, whether or
          // not it holds a local snapshot: the same restore path `setYoloEnabled` uses on a genuine
          // flip. `applyYoloApprovals(false)` already consumes `this.preYolo` when one is present,
          // and falls back to Ask-first when it is not, so this is safe to call either way.
          this.applyYoloApprovals(false);
        }
      }
    } catch {
      /* opening Settings retries the load */
    }
  }

  /**
   * Brings one open thread into YOLO's full access, when YOLO is on and the thread is not there
   * yet. A thread's own mode would otherwise keep asking, answered one card at a time by the
   * implied bypass instead of never asking at all.
   */
  private convergeThread(sessionId: string): void {
    if (this.state.yoloSettings?.enabled !== true) {
      return;
    }
    const thread = this.state.threads[sessionId];
    const mode = thread?.fold.meta.approvalMode ?? null;
    if (thread && !thread.readOnly && mode !== "allowAll") {
      this.patchMeta(sessionId, { approvalMode: "allowAll" });
      void this.pushThreadModes({ [sessionId]: "allowAll" }, { [sessionId]: mode }, "asking");
    }
  }

  // ---------------------------------------------------------------- routing

  navigate(route: Route): void {
    this.applyRoute(route, true);
  }

  /** Leaves the settings/usage pages for wherever the user was before opening them. */
  goBack(): void {
    this.navigate(this.returnRoute ?? { kind: "home" });
  }

  openThread(sessionId: string): void {
    this.navigate({ kind: "thread", sessionId });
  }

  newThread(cwd?: string | null): void {
    const target = cwd ?? this.state.prefs.lastProject ?? this.state.projects[0]?.cwd ?? null;
    const known = target && this.state.projects.some((p) => p.cwd === target) ? target : (this.state.projects[0]?.cwd ?? null);
    this.navigate({ kind: "new", cwd: known });
  }

  private applyRoute(requested: Route, push: boolean): void {
    let route = requested;
    const previous = this.state.route;
    if (previous.kind === "thread") {
      this.markSeen(previous.sessionId, true);
    }
    if (route.kind === "thread" && this.state.sessionsLoaded && !this.state.sessions[route.sessionId]) {
      route = { kind: "home" };
    }
    const overlay = route.kind === "usage" || route.kind === "settings";
    const wasOverlay = previous.kind === "usage" || previous.kind === "settings";
    if (overlay) {
      if (!wasOverlay) {
        this.returnRoute = previous;
      }
    } else {
      this.returnRoute = null;
    }
    this.update((s) => ({ ...s, route }));
    if (push) {
      const hash = routeToHash(route);
      if (this.platform.readHash() !== hash) {
        this.platform.writeHash(hash);
      }
    }
    if (route.kind === "thread") {
      this.markSeen(route.sessionId, true);
      const thread = this.state.threads[route.sessionId];
      if (!thread || thread.load === "idle" || thread.load === "error" || thread.fold.closed) {
        void this.loadThread(route.sessionId);
      }
    } else if (route.kind === "new" && route.cwd) {
      this.setPrefs({ lastProject: route.cwd });
    } else if (route.kind === "settings") {
      if (this.state.titleSettings === null) {
        void this.loadTitleSettings();
      }
      if (this.state.sandboxSettings === null) {
        void this.loadSandboxSettings();
      }
      if (this.state.yoloSettings === null) {
        void this.loadYoloSettings();
      }
      if (this.state.feedSettings === null) {
        void this.loadFeedSettings();
      }
      if (this.state.accounts === null) {
        void this.loadAccounts();
      }
    }
  }

  /**
   * Asked for by hand from the stalled notice. The watchdog's budget is spent per stuck turn, so a
   * retry clears it: the user asking is new information, and one more attempt is cheap.
   */
  retryStalledThread(sessionId: string): Promise<void> {
    this.staleReloads.delete(sessionId);
    return this.loadThread(sessionId);
  }

  /**
   * The stalled notice's other way out, offered while catch-up is off: switch it on, then reload.
   * In that order, because the server starts following a thread from its next history load, and
   * only once the mode is on. Switching it on reloads every thread waiting on a turn, this one
   * among them. A switch that did not take leaves this a plain reload.
   */
  async keepThreadLive(sessionId: string): Promise<void> {
    if (await this.setCatchUp(true)) {
      return;
    }
    // A load already on its way would be joined rather than made again: wait that one out, so the
    // reload asked for here is one of its own.
    await this.inflightLoads.get(sessionId);
    await this.retryStalledThread(sessionId);
  }

  /**
   * Loads again every thread that is waiting on a turn, once catch-up has been switched on. The
   * server follows a thread from its next history load, and none of these would make one unasked:
   * a stalled thread has spent its reloads, and what would move the others on is not arriving.
   */
  private async followThreads(): Promise<void> {
    const waiting = Object.entries(this.state.threads)
      .filter(([, thread]) => !thread.readOnly && (thread.stalled || thread.fold.activeTurnId !== null))
      .map(([id]) => id);
    await Promise.all(
      waiting.map(async (id) => {
        // A load already on its way may have reached the server before the switch did, and a second
        // one would only join it: wait that one out, so the reload made here is one that counts.
        await this.inflightLoads.get(id);
        await this.retryStalledThread(id);
      }),
    );
  }

  async loadThread(sessionId: string): Promise<void> {
    // A second load while one is in flight would orphan the first load's buffer: every event that
    // streamed into it is dropped, and the thread never shows them (#32: a frozen view on a thread
    // whose backend kept working). Coalescing waits on the one buffer instead, so nothing is lost.
    const inflight = this.inflightLoads.get(sessionId);
    if (inflight) {
      return inflight;
    }
    const run = this.reloadThread(sessionId).finally(() => {
      if (this.inflightLoads.get(sessionId) === run) {
        this.inflightLoads.delete(sessionId);
      }
    });
    this.inflightLoads.set(sessionId, run);
    return run;
  }

  private async reloadThread(sessionId: string): Promise<void> {
    const existing = this.state.threads[sessionId];
    this.loading.set(sessionId, []);
    this.setThread(sessionId, { ...(existing ?? blankThread()), load: "loading", error: null });
    try {
      const load = await this.client.loadTranscript(sessionId);
      const buffered = this.loading.get(sessionId) ?? [];
      this.loading.delete(sessionId);
      // Its echoes as they stand now: a send acknowledged, failed or started while history was on its way has
      // changed them, and carrying the ones from before would show a prompt twice, with nothing left to clear it (#55).
      const current = this.state.threads[sessionId]?.fold ?? existing?.fold ?? null;
      const fold = applyEvents(foldFromLoad(load, current), buffered);
      this.appliedAt.set(sessionId, this.platform.now());
      // As it stands now, not as it stood before the load: word that the turn is running can
      // arrive while history is on its way, and the notice it took down stays down.
      const wasStalled = this.state.threads[sessionId]?.stalled ?? false;
      this.update((s) => ({
        ...s,
        threads: {
          ...s.threads,
          [sessionId]: {
            load: "ready",
            error: null,
            readOnly: load.readOnly,
            readOnlyReason: load.readOnlyReason,
            truncated: load.truncated,
            fold,
            attachments: (load.attachments ?? []).map((file) => this.stamp(file)),
            shellRuns: load.shellRuns ?? [],
            // History moved the turn on, so the notice goes; a turn still running keeps it.
            stalled: wasStalled && fold.activeTurnId !== null,
          },
        },
        sessions: load.session ? { ...s.sessions, [sessionId]: load.session } : s.sessions,
      }));
      // Whatever was already waiting when the thread opened counts too, not only what arrives next.
      this.autoAllow([sessionId]);
      this.convergeThread(sessionId);
    } catch (error) {
      this.loading.delete(sessionId);
      this.setThread(sessionId, {
        ...(this.state.threads[sessionId] ?? blankThread()),
        load: "error",
        error: errorMessage(error),
      });
    }
  }

  // ---------------------------------------------------------------- events

  private onEvent(event: HeliconEvent): void {
    switch (event.type) {
      case "hello": {
        const wasLost = this.state.connection === "lost";
        this.update((s) => ({ ...s, connection: "open" }));
        if (wasLost && this.state.boot === "ready") {
          // Goals could have moved while the stream was down, and not every thread is reloaded. Let the
          // others take the server's goal again rather than the last one they saw streamed.
          for (const id of Object.keys(this.state.threads)) {
            this.patchFold(id, (f) => (f.meta.goalSeen ? { ...f, meta: { ...f.meta, goalSeen: false } } : f));
          }
          void this.refresh();
          const route = this.state.route;
          if (route.kind === "thread") {
            void this.loadThread(route.sessionId);
          }
          // Nothing sent while the stream was down is sent again, so a thread mid-turn may have a
          // hole in it. A `feed` vouches for what the server sent, not for what arrived here, so
          // the quiet reload cannot be counted on to fill it: history does, now.
          for (const [id, thread] of Object.entries(this.state.threads)) {
            if (thread.fold.activeTurnId !== null && !(route.kind === "thread" && route.sessionId === id)) {
              void this.loadThread(id);
            }
          }
        }
        break;
      }
      case "connection":
        this.update((s) => ({ ...s, connection: event.state === "open" ? "open" : "lost" }));
        break;
      case "msp":
        if (event.method === "skill/changed") {
          this.refreshSkillsFor(event.sessionId);
        }
        this.queueEvent(event.sessionId, { method: event.method, params: event.params, at: event.at });
        break;
      case "plan-usage":
        this.takePlanUsage(event.usage, event.accountId);
        break;
      case "session-status": {
        const known = this.state.sessions[event.sessionId];
        if (!known) {
          this.scheduleRefresh();
          break;
        }
        // Held onto before the update overwrites it: what changed is the entire question.
        const before = known.live;
        this.update((s) => {
          const current = s.sessions[event.sessionId];
          return current ? { ...s, sessions: { ...s.sessions, [event.sessionId]: { ...current, live: event.live } } } : s;
        });
        this.announce(event.sessionId, known.title, before, event.live);
        // The only word we get about a thread this app has never opened: it is waiting on someone.
        if (this.bypassArmed(event.sessionId) && (event.live?.pendingApprovals ?? 0) > 0) {
          this.loadForBypass(event.sessionId);
        }
        break;
      }
      case "feed": {
        // A turn that is quiet because it is working, not because its updates were lost: the server
        // checked with Muse. That counts as hearing from it, so the stale check leaves the thread
        // alone, and a thread already marked as having stopped is marked no longer.
        const thread = this.state.threads[event.sessionId];
        if (thread && thread.fold.activeTurnId === event.activeTurnId) {
          this.appliedAt.set(event.sessionId, this.platform.now());
          this.staleReloads.delete(event.sessionId);
          if (thread.stalled) {
            this.setThread(event.sessionId, { ...thread, stalled: false });
          }
        }
        break;
      }
      case "shell-run":
        this.addShellRun(event.sessionId, event.run);
        break;
      case "sessions-changed":
        this.scheduleRefresh();
        break;
      case "host":
        if (event.state === "failed" || event.state === "exited") {
          this.update((s) => ({ ...s, hostError: event.message }));
          this.toast("error", event.state === "failed" ? "Muse could not start" : "Muse stopped unexpectedly", event.message);
        } else if (event.state === "restarted") {
          this.update((s) => ({ ...s, hostError: null }));
          this.toast("info", "Muse hosts restarted", event.message);
          // A restart follows any settings PATCH, including one from a different client. Reload both
          // so this client's posture (and any thread it owns) tracks what actually took effect.
          void this.loadYoloSettings();
          void this.loadSandboxSettings();
        }
        break;
    }
  }

  private queueEvent(sessionId: string, event: ViewEvent): void {
    const buffer = this.loading.get(sessionId);
    if (buffer) {
      buffer.push(event);
      return;
    }
    if (!this.state.threads[sessionId]) {
      return;
    }
    const list = this.pending.get(sessionId);
    if (list) {
      list.push(event);
    } else {
      this.pending.set(sessionId, [event]);
    }
    if (this.flushHandle === null) {
      this.flushHandle = this.platform.schedule(() => this.flush(), FLUSH_MS);
    }
  }

  /** Apply queued stream events once per frame-ish, so fast deltas cost one render. */
  flush(): void {
    this.flushHandle = null;
    if (this.pending.size === 0) {
      return;
    }
    const batches = [...this.pending];
    this.pending.clear();
    const appliedNow = this.platform.now();
    for (const [id] of batches) {
      this.appliedAt.set(id, appliedNow);
      // Events arriving are the thread being heard from, which says more than a `feed` does: a
      // notice that it stopped comes down, and its turn gets its reloads back.
      if (this.state.threads[id]?.stalled) {
        this.staleReloads.delete(id);
      }
    }
    this.update((s) => {
      const threads = { ...s.threads };
      for (const [id, events] of batches) {
        const thread = threads[id];
        if (thread) {
          threads[id] = { ...thread, fold: applyEvents(thread.fold, events), stalled: false };
        }
      }
      return { ...s, threads };
    });
    this.autoAllow(batches.map(([id]) => id));
    this.noteEditedFiles(batches);
    const route = this.state.route;
    if (route.kind === "thread" && batches.some(([id]) => id === route.sessionId)) {
      this.markSeen(route.sessionId);
    }
  }

  private scheduleStaleCheck(): void {
    if (this.staleHandle !== null || this.disposed) {
      return;
    }
    this.staleHandle = this.platform.schedule(() => {
      this.staleHandle = null;
      this.checkStaleThreads();
    }, STALE_CHECK_MS);
  }

  /**
   * Reloads loaded threads whose stream went silent: a missed ending or a dead stream looks exactly
   * like a frozen view with a spinner (#32), and history converges it the way a restart would. A
   * reload stamps the thread fresh, so a thread that stays silent is retried at most once per grace
   * period — and a reload can never loop with itself, since a thread already loading is skipped.
   */
  private checkStaleThreads(): void {
    if (!this.disposed) {
      this.scheduleStaleCheck();
    }
    const now = this.platform.now();
    for (const [id, thread] of Object.entries(this.state.threads)) {
      if (thread.load !== "ready" || this.loading.has(id)) {
        continue;
      }
      const turnId = thread.fold.activeTurnId;
      if (!turnId) {
        this.staleReloads.delete(id);
        continue;
      }
      const applied = this.appliedAt.get(id) ?? null;
      if (applied === null) {
        continue;
      }
      // A turn waiting on the user is quiet because it should be, not because the stream died (#54).
      // Reloading it sends session/resume into a live session mid-question, which is how a turn that
      // was fine came to be reported failed. Treat the wait as activity, so the grace period starts
      // over once the answer goes in rather than firing the moment it does.
      const live = this.state.sessions[id]?.live;
      const waiting =
        Object.keys(thread.fold.userInputs).length > 0 ||
        Object.keys(thread.fold.approvals).length > 0 ||
        Object.keys(thread.fold.reviewing).length > 0 ||
        (live?.pendingInputs ?? 0) > 0 ||
        (live?.pendingApprovals ?? 0) > 0;
      if (waiting) {
        this.appliedAt.set(id, now);
        this.staleReloads.delete(id);
        if (thread.stalled) {
          this.setThread(id, { ...thread, stalled: false });
        }
        continue;
      }
      if (staleThreadReason(turnId, live?.activeTurnId ?? null, applied, now) === null) {
        continue;
      }
      const spent = this.staleReloads.get(id);
      const count = spent && spent.turnId === turnId ? spent.count : 0;
      if (count >= STALE_RELOAD_LIMIT) {
        // Out of reloads and the turn still has not moved. Say so: a spinner that will never
        // resolve reads as the app working, and the user waits for nothing (#42).
        if (!thread.stalled) {
          this.setThread(id, { ...thread, stalled: true });
        }
        continue;
      }
      this.staleReloads.set(id, { turnId, count: count + 1 });
      void this.loadThread(id);
    }
  }

  /** Files Muse just wrote or edited, so a view of one reloads instead of showing what was there before. */
  private noteEditedFiles(batches: [string, ViewEvent[]][]): void {
    const touched: string[] = [];
    for (const [sessionId, events] of batches) {
      const cwd = this.state.sessions[sessionId]?.cwd;
      if (!cwd) {
        continue;
      }
      for (const event of events) {
        const item = event.method === "item/completed" ? (event.params["item"] as import("../types.js").MspItem | undefined) : undefined;
        if (!item || item.kind !== "toolCall" || item.status !== "completed") {
          continue;
        }
        const tool = describeTool(item);
        const target = (tool.kind === "edit" || tool.kind === "write") && tool.subject ? fileTarget(tool.subject, cwd) : null;
        if (target) {
          touched.push(fileKey(cwd, target.path));
        }
      }
    }
    if (touched.length > 0) {
      this.update((s) => {
        const fileVersions = { ...s.fileVersions };
        for (const key of touched) {
          fileVersions[key] = (fileVersions[key] ?? 0) + 1;
        }
        return { ...s, fileVersions };
      });
    }
  }

  // ---------------------------------------------------------------- turns

  /**
   * Send from the composer. `/commands` and `!shell` lines run as themselves; `raw` sends the text as a plain prompt.
   * Returns false when the sending composer should put the text back.
   */
  async send(text: string, options: SendOptions = {}): Promise<boolean> {
    const trimmed = text.trim();
    const files = options.attachments ?? [];
    if (!trimmed && files.length === 0) {
      return false;
    }
    if (!options.raw && trimmed) {
      const shell = /^!\s*([\s\S]+)$/.exec(trimmed);
      if (shell) {
        return this.runShell((shell[1] as string).trim());
      }
      const parsed = parseSlash(trimmed);
      if (parsed) {
        // `queue` rides along: a retry after compaction has to wait for it, slash command or not.
        return this.runSlash(trimmed, parsed, {
          steer: options.steer,
          queue: options.queue,
          // A command that sends a prompt takes the files along; one that opens a picker has none to take.
          attachments: files,
          previews: options.previews,
        });
      }
    }
    return this.deliver(trimmed, { steer: options.steer, queue: options.queue, attachments: files, previews: options.previews });
  }

  /** The project a new thread starts in: the new-thread screen's, else the last one used. */
  private newThreadTarget(): string | null {
    const route = this.state.route;
    const target =
      (route.kind === "new" ? route.cwd : null) ?? this.state.prefs.lastProject ?? this.state.projects[0]?.cwd ?? null;
    if (!target) {
      this.toast("info", "Add a project first", "Pick the folder Muse should work in.");
      this.setAddProjectOpen(true);
    }
    return target;
  }

  /** Sends a prompt to the open thread, or starts a thread with it. */
  private deliver(text: string, options: TurnDelivery): Promise<boolean> {
    const route = this.state.route;
    const bound = options.sessionId ?? (route.kind === "thread" ? route.sessionId : null);
    if (bound) {
      return this.sendToThread(bound, text, options, false);
    }
    const target = this.newThreadTarget();
    if (!target) {
      return Promise.resolve(false);
    }
    return this.startThread(
      target,
      options.displayText ?? text,
      (sessionId) => this.sendToThread(sessionId, text, options, false),
      { attachments: options.attachments, previews: options.previews },
    );
  }

  /** Called by the composer showing `key`: takes back a prompt that failed to send from elsewhere. */
  takeDraftHandoff(key: string): { text: string; attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } | null {
    const handoff = this.state.draftHandoff;
    if (!handoff || handoff.key !== key) {
      return null;
    }
    this.update((s) => ({ ...s, draftHandoff: null }));
    const { key: _key, ...draft } = handoff;
    return draft;
  }

  /** Puts text in a thread's composer as if the user typed it, like `/goal ` for a new objective. */
  prefillComposer(sessionId: string, text: string): void {
    this.update((s) => ({ ...s, draftHandoff: { key: sessionId, text } }));
  }

  /** Starts a thread in `cwd` and runs its first action there; what the user typed goes to its composer if that fails. */
  private async startThread(
    cwd: string,
    typed: string,
    first: (sessionId: string) => Promise<boolean>,
    files: { attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},
  ): Promise<boolean> {
    if (this.state.busy["start"]) {
      return false;
    }
    this.setBusy("start", true);
    try {
      const { defaultMode } = this.state.prefs;
      // The model the composer shows: the saved choice, else the one Muse's catalog marks as default. Passing it
      // explicitly keeps the new thread on the model the user saw, not whatever Muse picks on its own.
      const defaultModelId = this.state.prefs.defaultModelId ?? this.state.models.find((m) => m.isDefault)?.modelId ?? null;
      // YOLO owns every thread's posture while it is on, new or old: a stale default from before it
      // was armed must never seed a thread that asks when the rest of the app does not.
      const approvalMode: ApprovalMode = this.state.yoloSettings?.enabled === true ? "allowAll" : defaultMode;
      const project = this.state.projects.find((p) => p.cwd === cwd);
      // SSH projects always run on the remote host's own login.
      const accountId = isSshPath(cwd) ? null : (project?.defaultAccountId ?? null);
      const session = await this.client.startSession(cwd, {
        approvalMode,
        modelId: defaultModelId ?? undefined,
        accountId,
      });
      const base = emptyFold();
      const fold: ThreadFold = {
        ...base,
        meta: { ...base.meta, modelId: session.modelId ?? defaultModelId, approvalMode },
      };
      this.update((s) => ({
        ...s,
        sessions: { ...s.sessions, [session.sessionId]: session },
        threads: {
          ...s.threads,
          [session.sessionId]: {
            load: "ready",
            error: null,
            readOnly: false,
            readOnlyReason: null,
            truncated: false,
            fold,
            attachments: [],
            shellRuns: [],
            stalled: false,
          },
        },
      }));
      this.setPrefs({ lastProject: cwd });
      this.navigate({ kind: "thread", sessionId: session.sessionId });
      const sent = await first(session.sessionId);
      if (!sent) {
        // The new-thread composer that sent this is gone, so the prompt goes to the new thread's composer,
        // carrying its files: without them a prompt sent for an image would come back as an empty draft.
        const carried = {
          ...(files.attachments?.length ? { attachments: files.attachments } : {}),
          ...(files.previews?.length ? { previews: files.previews } : {}),
        };
        this.update((s) => ({ ...s, draftHandoff: { key: session.sessionId, text: typed, ...carried } }));
      }
      return true;
    } catch (error) {
      this.toast("error", "Could not start a thread", errorMessage(error));
      return false;
    } finally {
      this.setBusy("start", false);
    }
  }

  private async sendToThread(
    sessionId: string,
    text: string,
    options: TurnDelivery,
    retried: boolean,
  ): Promise<boolean> {
    const thread = this.state.threads[sessionId];
    if (!thread) {
      return false;
    }
    if (thread.readOnly) {
      this.toast("info", "This thread is read-only here", thread.readOnlyReason ?? "Another Muse session has it open.");
      return false;
    }
    // A second Enter lands before the composer clears, so one draft arrives twice: the first send owns
    // it, and the duplicate reports sent — the text is going, so the composer stays clear.
    const key = this.sendKey(sessionId, text, options);
    if (this.inflightSends.has(key)) {
      return true;
    }
    this.inflightSends.add(key);
    // A caller that knows a turn is starting elsewhere can say so, before its `turn/started` reaches us.
    const running = thread.fold.activeTurnId !== null || options.queue === true;
    const echo: LocalEcho = {
      localId: nextLocalId(),
      // The echo shows what the transcript will, so it matches the prompt item when that arrives.
      text: options.displayText ?? text,
      turnId: null,
      disposition: running ? (options.steer ? "steered" : "queued") : "sending",
      createdAt: this.platform.now(),
      ...(options.previews?.length ? { attachments: options.previews } : {}),
    };
    this.patchFold(sessionId, (f) => addEcho(f, echo));
    try {
      const ack = await this.client.sendTurn(sessionId, text, {
        ifBusy: running ? (options.steer ? "steer" : "queue") : undefined,
        reasoningEffort: this.state.prefs.effort ?? undefined,
        displayText: options.displayText,
        attachments: options.attachments,
      });
      const disposition: LocalEcho["disposition"] =
        ack.disposition === "queued" ? "queued" : ack.disposition === "steered" ? "steered" : "started";
      this.patchFold(sessionId, (f) => updateEcho(f, echo.localId, { turnId: ack.turnId, disposition }));
      // The echo goes when the prompt lands, so the thread takes the saved files now rather than on a reload.
      this.keepAttachments(sessionId, ack.attachments ?? []);
      const turnId = ack.turnId;
      if (disposition === "started" && turnId) {
        this.patchFold(sessionId, (f) =>
          f.activeTurnId || f.turns[turnId]?.terminal
            ? f
            : {
                ...f,
                activeTurnId: turnId,
                turns: { ...f.turns, [turnId]: { startedAt: this.platform.now(), ...f.turns[turnId], turnId } },
              },
        );
      }
      return true;
    } catch (error) {
      this.patchFold(sessionId, (f) => removeEcho(f, echo.localId));
      const kind = errorKind(error);
      if (!retried && (kind === "sessionNotLoaded" || kind === "sessionStreamMismatch")) {
        await this.loadThread(sessionId);
        // The retry re-sends under this key, so it must not trip over its own guard.
        this.inflightSends.delete(key);
        return this.sendToThread(sessionId, text, options, true);
      }
      this.toast("error", "Message not sent", errorMessage(error));
      return false;
    } finally {
      this.inflightSends.delete(key);
    }
  }

  /** What makes two prompt deliveries the same send: the thread, the text, and the files riding along. */
  private sendKey(sessionId: string, text: string, options: TurnDelivery): string {
    const files = (options.attachments ?? [])
      .map((file) => `${file.name}:${file.mediaType}:${file.base64.length}:${file.base64.slice(0, 24)}`)
      .join(",");
    const mode = options.steer ? "steer" : options.queue ? "queue" : "send";
    return [sessionId, mode, options.displayText ?? "", text, files].join("\n");
  }

  async stop(sessionId: string): Promise<void> {
    const key = `stop:${sessionId}`;
    if (this.state.busy[key]) {
      return;
    }
    this.setBusy(key, true);
    try {
      await this.client.interruptTurn(sessionId, this.state.threads[sessionId]?.fold.activeTurnId ?? undefined);
    } catch (error) {
      this.toast("error", "Could not stop the turn", errorMessage(error));
    } finally {
      this.setBusy(key, false);
    }
  }

  async unqueue(sessionId: string, echo: LocalEcho): Promise<void> {
    if (!echo.turnId) {
      this.patchFold(sessionId, (f) => removeEcho(f, echo.localId));
      return;
    }
    try {
      await this.client.unqueueTurn(sessionId, echo.turnId);
      this.patchFold(sessionId, (f) => removeEcho(f, echo.localId));
    } catch (error) {
      this.toast("info", "That message already started", errorMessage(error));
    }
  }

  /** Clears a failed turn's notice, for when the user has acted on it and it is only taking up room. */
  /**
   * Closes a failed turn's notice. Kept in prefs as well as the fold: the fold is rebuilt from Muse's history
   * whenever the thread reloads, and the notice would come back with it.
   */
  dismissTurnError(sessionId: string, turnId: string | null): void {
    if (!turnId) {
      return;
    }
    const key = `${sessionId}:${turnId}`;
    const dismissed = this.state.prefs.dismissedTurnErrors;
    if (!dismissed.includes(key)) {
      this.setPrefs({ dismissedTurnErrors: [...dismissed, key].slice(-300) });
    }
    this.patchFold(sessionId, (f) => {
      const info = f.turns[turnId];
      if (!info?.error) {
        return f;
      }
      const { error: _error, ...rest } = info;
      return { ...f, turns: { ...f.turns, [turnId]: { ...rest, dismissed: true } } };
    });
  }

  /** True when the prompt actually went; a caller can then tell whether to hand the text back to the user. */
  async retryTurn(
    sessionId: string,
    prompt: string,
    options: { queue?: boolean; attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},
  ): Promise<boolean> {
    const delivery: TurnDelivery = {
      queue: options.queue,
      attachments: options.attachments,
      previews: options.previews,
      // Named, not read off the route: the user may have walked to another thread while the skills loaded.
      sessionId,
    };
    // A turn started by `/plan …` or `/init` shows the command, so retrying runs the command again.
    const parsed = parseSlash(prompt);
    const cwd = this.state.sessions[sessionId]?.cwd ?? null;
    if (parsed && cwd) {
      await this.loadSkills(cwd);
      const skills = this.state.skills[cwd]?.skills ?? [];
      if (resolveSlash(parsed, slashCommands(skills, { inThread: true }), skills).kind !== "unknown") {
        return this.runSlash(prompt, parsed, delivery);
      }
    }
    return this.sendToThread(sessionId, prompt, delivery, false);
  }

  // ---------------------------------------------------------------- approvals and questions

  /** True when this thread answers its own approvals: its own arming, the session-wide switch, or YOLO. */
  bypassArmed(sessionId: string): boolean {
    return this.state.bypassAll || this.state.yoloSettings?.enabled === true || this.state.bypassThreads.includes(sessionId);
  }

  setBypassAll(on: boolean): void {
    this.update((s) => ({ ...s, bypassAll: on }));
    if (on) {
      this.autoAllow(Object.keys(this.state.threads));
      // A thread nobody has opened here has no local state at all, so its events are dropped on arrival and
      // its approvals are invisible. The server's live view is what says which sessions are waiting.
      for (const session of Object.values(this.state.sessions)) {
        if ((session.live?.pendingApprovals ?? 0) > 0) {
          this.loadForBypass(session.sessionId);
        }
      }
    }
  }

  /**
   * What a change in a thread's live state is worth saying out loud. Only the edges count: a request
   * that has just appeared, a turn that has just ended, a goal that has just stopped being active.
   * A state that was already true when the last report came in says nothing again.
   */
  private announce(
    sessionId: string,
    thread: string,
    before: SessionSummary["live"],
    after: SessionSummary["live"],
  ): void {
    const manager = this.notifications;
    if (!manager || !after) {
      return;
    }
    // An armed thread answers its own approvals, so "needs you" would be a lie told a second before the
    // bypass lands. But a rule-only request offers the bypass nothing to click, so it is left for the
    // user exactly as `autoAllow` leaves it: that one still needs the announcement.
    if (
      (after.pendingApprovals ?? 0) > 0 &&
      (before?.pendingApprovals ?? 0) === 0 &&
      (!this.bypassArmed(sessionId) || this.hasUnanswerableApproval(sessionId))
    ) {
      void manager.announce({ kind: "approval", sessionId, thread });
    }
    if ((after.pendingInputs ?? 0) > 0 && (before?.pendingInputs ?? 0) === 0) {
      void manager.announce({ kind: "question", sessionId, thread });
    }
    if (after.activeTurnId === null && before?.activeTurnId != null && after.lastTerminal) {
      const failed = Boolean(after.lastError) || after.lastTerminal === "failed";
      void manager.announce({ kind: "finished", sessionId, thread, failed });
    }
    const status = after.goal?.status ?? null;
    if (status && status !== "active" && status !== (before?.goal?.status ?? null)) {
      void manager.announce({ kind: "goal", sessionId, thread, status });
    }
  }

  /** Opens a thread only so the bypass can reach its approvals, and answers them once it is there. */
  private loadForBypass(sessionId: string): void {
    const thread = this.state.threads[sessionId];
    if (!thread) {
      void this.loadThread(sessionId);
    } else if (thread.load === "ready") {
      this.autoAllow([sessionId]);
    }
  }

  setThreadBypass(sessionId: string, on: boolean): void {
    this.update((s) => ({
      ...s,
      bypassThreads: on ? [...new Set([...s.bypassThreads, sessionId])] : s.bypassThreads.filter((id) => id !== sessionId),
    }));
    if (on) {
      this.autoAllow([sessionId]);
    }
  }

  /** Puts every thread that was answering for itself back to asking, without touching the session-wide switch. */
  clearThreadBypass(): void {
    if (this.state.bypassThreads.length > 0) {
      this.update((s) => ({ ...s, bypassThreads: [] }));
    }
  }

  /**
   * What a bypass answers with: allow this once. A choice carrying a rule preview would write a standing
   * rule into Muse's own config, which is not a thing to do on someone's behalf while they are not looking.
   */
  private allowOnce(request: ApprovalRequest): string | null {
    const choices = request.availableChoices ?? [];
    // Only a choice that leaves nothing behind. Where the sole way to allow is to remember a rule, the
    // request stays for the user: a rule in Muse's own config would outlive the bypass that wrote it.
    return choices.find((choice) => choice.decision === "approved" && !choice.rulePreview)?.choiceId ?? null;
  }

  /**
   * True when a known pending approval in this thread has no plain approve choice for `autoAllow` to
   * take, only a rule preview or nothing at all. `announce` uses this to still speak up for a request
   * an armed bypass will leave sitting there, using the same predicate `autoAllow` answers with.
   */
  private hasUnanswerableApproval(sessionId: string): boolean {
    const thread = this.state.threads[sessionId];
    if (!thread) {
      return false;
    }
    return Object.values(thread.fold.approvals).some((request) => this.allowOnce(request) === null);
  }

  /** Answers what is pending in every armed thread; a request offering no approval is left to the user. */
  private autoAllow(sessionIds: Iterable<string>): void {
    for (const sessionId of new Set(sessionIds)) {
      const thread = this.state.threads[sessionId];
      if (!this.bypassArmed(sessionId) || !thread || thread.readOnly) {
        continue;
      }
      for (const request of Object.values(thread.fold.approvals)) {
        const choiceId = this.allowOnce(request);
        if (choiceId && !this.state.busy[`approval:${request.approvalId}`]) {
          void this.decide(request, choiceId, null, "bypass");
        }
      }
    }
  }

  async decide(
    request: ApprovalRequest,
    choiceId: string,
    feedback: string | null,
    by: "user" | "bypass" = "user",
  ): Promise<void> {
    const key = `approval:${request.approvalId}`;
    if (this.state.busy[key]) {
      return;
    }
    this.setBusy(key, true);
    // The card goes on the click, not on the host's `approval/resolved`, which can be a second or more behind.
    const decision = (request.availableChoices ?? []).find((c) => c.choiceId === choiceId)?.decision ?? "approved";
    this.patchFold(request.sessionId, (f) => {
      const approvals = { ...f.approvals };
      delete approvals[request.approvalId];
      const stage = requirementIndex(request);
      const resolved = { decision, resolvedBy: by, ...(stage !== undefined ? { stage } : {}) };
      return { ...f, approvals, resolved: { ...f.resolved, [request.approvalId]: resolved } };
    });
    try {
      await this.client.decideApproval({
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        requirementId: request.currentRequirementId,
        choiceId,
        feedback,
      });
    } catch (error) {
      const kind = errorKind(error);
      if (kind === "approvalAlreadyResolved" || kind === "approvalNotFound") {
        /* it was already settled elsewhere; the card is gone either way */
      } else if (kind === "approvalRequirementStale") {
        this.restoreApproval(request);
        this.toast("info", "The request changed", "Review the updated request and decide again.");
      } else {
        this.restoreApproval(request);
        this.toast("error", "Decision not sent", errorMessage(error));
      }
    } finally {
      this.setBusy(key, false);
    }
  }

  /** Puts a request back when its decision did not land, so the choice is still the user's. */
  private restoreApproval(request: ApprovalRequest): void {
    this.patchFold(request.sessionId, (f) => {
      const resolved = { ...f.resolved };
      delete resolved[request.approvalId];
      return { ...f, approvals: { ...f.approvals, [request.approvalId]: request }, resolved };
    });
  }

  private dropInput(request: UserInputRequest): void {
    this.patchFold(request.sessionId, (f) => {
      const userInputs = { ...f.userInputs };
      delete userInputs[request.userInputId];
      return { ...f, userInputs };
    });
  }

  private async settleInput(request: UserInputRequest, action: () => Promise<void>, failure: string): Promise<void> {
    const key = `input:${request.userInputId}`;
    if (this.state.busy[key]) {
      return;
    }
    this.setBusy(key, true);
    try {
      await action();
    } catch (error) {
      const kind = errorKind(error);
      if (kind === "userInputAlreadySettled" || kind === "userInputNotFound") {
        this.dropInput(request);
      } else {
        this.toast("error", failure, errorMessage(error));
      }
    } finally {
      this.setBusy(key, false);
    }
  }

  answer(request: UserInputRequest, answers: UserInputAnswer[]): Promise<void> {
    return this.settleInput(
      request,
      () => this.client.answerUserInput(request.sessionId, request.userInputId, answers),
      "Answer not sent",
    );
  }

  skipQuestion(request: UserInputRequest): Promise<void> {
    return this.settleInput(
      request,
      () => this.client.cancelUserInput(request.sessionId, request.userInputId),
      "Could not skip the question",
    );
  }

  clarify(request: UserInputRequest, content: string): Promise<void> {
    return this.settleInput(
      request,
      () => this.client.clarifyUserInput(request.sessionId, request.userInputId, content),
      "Reply not sent",
    );
  }

  // ---------------------------------------------------------------- composer settings

  async setModel(modelId: string): Promise<void> {
    const model = this.state.models.find((m) => m.modelId === modelId);
    if (model?.contributor && !this.state.prefs.contributorAck) {
      this.setPrefs({ contributorAck: true });
      this.toast(
        "info",
        "Contributor model selected",
        model.description ?? "Prompts and outputs on contributor models may be used for product improvement.",
      );
    }
    this.setPrefs({ defaultModelId: modelId });
    const route = this.state.route;
    if (route.kind !== "thread") {
      return;
    }
    const previous = this.state.threads[route.sessionId]?.fold.meta.modelId ?? null;
    this.patchMeta(route.sessionId, { modelId });
    try {
      await this.client.setSessionModel(route.sessionId, modelId);
    } catch (error) {
      this.patchMeta(route.sessionId, { modelId: previous });
      this.toast("error", "Could not switch models", errorMessage(error));
    }
  }

  async setMode(mode: ApprovalMode): Promise<void> {
    // The menu disables its modes under YOLO, but `/permissions` still lands here. Refusing beats
    // silently leaving YOLO: a thread-scoped command must not flip a host-wide posture behind a restart.
    if (this.state.yoloSettings?.enabled === true) {
      this.toast("info", "YOLO is on", "Switch YOLO off to change permissions.");
      return;
    }
    this.setPrefs({ defaultMode: mode });
    const route = this.state.route;
    if (route.kind !== "thread") {
      return;
    }
    const previous = this.state.threads[route.sessionId]?.fold.meta.approvalMode ?? null;
    this.patchMeta(route.sessionId, { approvalMode: mode });
    try {
      await this.client.setApprovalMode(route.sessionId, mode);
    } catch (error) {
      this.patchMeta(route.sessionId, { approvalMode: previous });
      this.toast("error", "Could not change permissions", errorMessage(error));
    }
  }

  /**
   * Flips YOLO mode: the server respawns its hosts with `--disable-sandbox --trust-workspace`,
   * and every open thread moves to full access with the bypass implied, like `muse --yolo`.
   * Switching off restores the modes from before arming, or Ask-first when they are unknown.
   */
  async setYoloEnabled(enabled: boolean): Promise<void> {
    // A flip to the value already showing is a double-click, not intent: answering it would
    // snapshot the YOLO modes as the pre-YOLO ones (or restore over them) and PATCH for nothing.
    if (this.state.yoloSettings?.enabled === enabled) {
      return;
    }
    const previous = this.state.yoloSettings;
    const rev = ++this.yoloSettingsRev;
    let capturedPreYolo = false;
    if (enabled && this.preYolo === null) {
      this.capturePreYolo();
      capturedPreYolo = true;
    }
    this.update((s) => ({ ...s, yoloSettings: { enabled } }));
    // The PATCH queues a host restart on the server, and `hostFor` awaits `restartChain`, so an
    // approval mode pushed before the PATCH lands would be applied before the restart, not after
    // it: the host would come back up and immediately see a session with the wrong posture. Wait
    // for the PATCH to resolve before touching any thread's approval mode.
    const run = this.yoloSettingsChain.then(() => this.client.setYoloSettings({ enabled }));
    this.yoloSettingsChain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      const yoloSettings = await run;
      if (rev === this.yoloSettingsRev) {
        this.update((s) => ({ ...s, yoloSettings }));
        this.applyYoloApprovals(enabled);
      }
    } catch (error) {
      if (rev === this.yoloSettingsRev) {
        // The flip never reached the server, so no mode was ever pushed: only the optimistic
        // flag comes back, nothing to unwind on the approvals side.
        this.update((s) => ({ ...s, yoloSettings: previous }));
        this.toast("error", "Could not change the YOLO setting", errorMessage(error));
        if (capturedPreYolo) {
          // This call's snapshot never armed anything: drop it so the next enable captures a
          // fresh one instead of restoring modes from a YOLO session that never happened.
          this.preYolo = null;
          this.setPrefs({ preYolo: null });
        }
      }
    }
  }

  /**
   * Approval modes as they stand now, so switching YOLO back off restores them. Saved into prefs too,
   * so a reload while YOLO is on does not lose it: the in-memory field starts fresh on every launch,
   * but the snapshot it would have captured just now is exactly what boot already persisted.
   */
  private capturePreYolo(): void {
    this.preYolo = {
      defaultMode: this.state.prefs.defaultMode,
      threads: Object.fromEntries(
        Object.entries(this.state.threads).map(([id, thread]) => [id, thread.fold.meta.approvalMode ?? null]),
      ),
    };
    this.setPrefs({ preYolo: this.preYolo });
  }

  /** Threads YOLO may flip: open ones owned here, never another session's read-only thread. */
  private yoloThreadIds(): string[] {
    return Object.entries(this.state.threads)
      .filter(([, thread]) => !thread.readOnly)
      .map(([id]) => id);
  }

  private applyYoloApprovals(enabled: boolean): void {
    if (enabled) {
      this.setPrefs({ defaultMode: "allowAll" });
      const modes: Record<string, ApprovalMode> = {};
      for (const sessionId of this.yoloThreadIds()) {
        this.patchMeta(sessionId, { approvalMode: "allowAll" });
        modes[sessionId] = "allowAll";
      }
      void this.pushThreadModes(modes, this.preYolo?.threads ?? {}, "asking");
      this.autoAllow(Object.keys(this.state.threads));
      return;
    }
    const prev = this.preYolo;
    this.preYolo = null;
    this.setPrefs({ preYolo: null });
    if (prev) {
      this.setPrefs({ defaultMode: prev.defaultMode });
    } else if (this.state.prefs.defaultMode === "allowAll") {
      // No snapshot to restore from. Only clean up a default this same client forced to Full access;
      // a default the user set some other way, before YOLO was armed elsewhere, is not ours to touch.
      this.setPrefs({ defaultMode: "onRequest" });
    }
    const modes: Record<string, ApprovalMode> = {};
    const fallback: Record<string, ApprovalMode | null> = {};
    for (const sessionId of this.yoloThreadIds()) {
      // A thread the snapshot never saw (opened after arming) falls back to that snapshot's default;
      // with no snapshot at all, every thread goes to Ask first rather than guessing at the live default.
      const mode = prev ? (prev.threads[sessionId] ?? prev.defaultMode) : "onRequest";
      this.patchMeta(sessionId, { approvalMode: mode });
      modes[sessionId] = mode;
      fallback[sessionId] = "allowAll";
    }
    void this.pushThreadModes(modes, fallback, "full access");
  }

  /**
   * Pushes approval modes thread by thread; a thread the server refuses keeps its `fallback` mode
   * locally instead of pretending the flip landed. One toast however many fail.
   */
  private async pushThreadModes(
    modes: Record<string, ApprovalMode>,
    fallback: Record<string, ApprovalMode | null>,
    kept: string,
  ): Promise<void> {
    const ids = Object.keys(modes);
    if (ids.length === 0) {
      return;
    }
    const results = await Promise.allSettled(ids.map((sessionId) => this.client.setApprovalMode(sessionId, modes[sessionId] as ApprovalMode)));
    let failed = 0;
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failed += 1;
        const sessionId = ids[i] as string;
        this.patchMeta(sessionId, { approvalMode: fallback[sessionId] ?? null });
      }
    });
    if (failed > 0) {
      this.toast("error", "Could not change permissions for every thread", `${failed} thread${failed === 1 ? "" : "s"} kept ${kept}.`);
    }
  }

  async setTitleEnabled(enabled: boolean): Promise<void> {
    const previous = this.state.titleSettings;
    const rev = ++this.titleSettingsRev;
    this.update((s) => ({ ...s, titleSettings: { enabled, modelId: previous?.modelId ?? null } }));
    try {
      const titleSettings = await this.client.setTitleSettings({ enabled });
      if (rev === this.titleSettingsRev) {
        this.update((s) => ({ ...s, titleSettings }));
      }
    } catch (error) {
      if (rev === this.titleSettingsRev) {
        this.update((s) => ({ ...s, titleSettings: previous }));
        this.toast("error", "Could not change thread titles", errorMessage(error));
      }
    }
  }

  async setTitleModel(modelId: string | null): Promise<void> {
    const previous = this.state.titleSettings;
    const rev = ++this.titleSettingsRev;
    this.update((s) => ({ ...s, titleSettings: { enabled: previous?.enabled ?? true, modelId } }));
    try {
      const titleSettings = await this.client.setTitleSettings({ modelId });
      if (rev === this.titleSettingsRev) {
        this.update((s) => ({ ...s, titleSettings }));
      }
    } catch (error) {
      if (rev === this.titleSettingsRev) {
        this.update((s) => ({ ...s, titleSettings: previous }));
        this.toast("error", "Could not change the title model", errorMessage(error));
      }
    }
  }

  async setSandboxDisabled(disabled: boolean): Promise<void> {
    // The Sandbox row disables its toggle under YOLO, but nothing else routes through here today.
    // Refuse anyway: YOLO already forces the sandbox off, and flipping this switch behind it would
    // queue a pointless restart and desync the toggle from the setting it no longer controls.
    if (this.state.yoloSettings?.enabled === true) {
      this.toast("info", "YOLO mode is on", "The sandbox is already off. Switch YOLO off to control it separately.");
      return;
    }
    const previous = this.state.sandboxSettings;
    const rev = ++this.sandboxSettingsRev;
    this.update((s) => ({ ...s, sandboxSettings: { disabled } }));
    // The rev below drops stale responses but cannot order the requests. Queue the PATCHes
    // so a slow disable can never persist after a faster re-enable.
    const run = this.sandboxSettingsChain.then(() => this.client.setSandboxSettings({ disabled }));
    this.sandboxSettingsChain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      const sandboxSettings = await run;
      if (rev === this.sandboxSettingsRev) {
        this.update((s) => ({ ...s, sandboxSettings }));
      }
    } catch (error) {
      if (rev === this.sandboxSettingsRev) {
        this.update((s) => ({ ...s, sandboxSettings: previous }));
        this.toast("error", "Could not change the sandbox setting", errorMessage(error));
      }
    }
  }

  /**
   * Whether the server asks Muse for a thread's updates once Muse stops sending them. Nothing
   * restarts for this: the server starts following a thread from its next history load or update,
   * so switching it on loads again the threads that are waiting on a turn. Answers whether it did.
   */
  async setCatchUp(enabled: boolean): Promise<boolean> {
    const rev = ++this.feedSettingsRev;
    this.update((s) => ({ ...s, feedSettings: { catchUp: enabled } }));
    // The rev below drops stale responses but cannot order the requests. Queue the PATCHes
    // so a slow switch-on can never persist after a faster switch-off.
    const run = this.feedSettingsChain.then(() => this.client.setFeedSettings({ catchUp: enabled }));
    this.feedSettingsChain = run.then(
      () => undefined,
      () => undefined,
    );
    let switchedOn = false;
    try {
      const feedSettings = await run;
      switchedOn = feedSettings.catchUp && this.feedSettingsConfirmed?.catchUp !== true;
      this.feedSettingsConfirmed = feedSettings;
      if (rev === this.feedSettingsRev) {
        this.update((s) => ({ ...s, feedSettings }));
      }
    } catch (error) {
      if (rev === this.feedSettingsRev) {
        // Back to what the server has, not to what the switch showed when this flip began: that
        // may have been an earlier flip's guess, since failed too.
        const feedSettings = this.feedSettingsConfirmed;
        this.update((s) => ({ ...s, feedSettings }));
        this.toast("error", "Could not change the live updates setting", errorMessage(error));
      }
    }
    if (switchedOn) {
      await this.followThreads();
    }
    return switchedOn;
  }

  /**
   * The effort for new turns. The open thread takes it at once, as its standing default: that is the only effort
   * `muse serve` applies, and setting it now means the TUI and any other client see the same level. Auto leaves
   * the thread where it is.
   */
  setEffort(effort: ReasoningEffort | null): void {
    this.setPrefs({ effort });
    const route = this.state.route;
    const thread = route.kind === "thread" ? this.state.threads[route.sessionId] : undefined;
    if (effort === null || route.kind !== "thread" || !thread || thread.readOnly) {
      return;
    }
    void this.client.setReasoningEffort(route.sessionId, effort).catch((error: unknown) => {
      // A thread that is not loaded yet takes the effort with its next turn instead.
      const kind = errorKind(error);
      if (kind !== "sessionNotLoaded" && kind !== "sessionStreamMismatch") {
        this.toast("error", "Could not change the effort for this thread", errorMessage(error));
      }
    });
  }

  // ---------------------------------------------------------------- plan usage

  /** The subscription window Muse last saw, from the server; it also arrives as an event whenever it moves. */
  async loadPlanUsage(): Promise<void> {
    try {
      const { usage, byAccount } = await this.client.planUsage();
      if (usage) {
        this.takePlanUsage(usage);
      }
      for (const [accountId, accountUsage] of Object.entries(byAccount)) {
        this.takePlanUsage(accountUsage, accountId);
      }
    } catch {
      /* the meter is extra: a server without it leaves the usage page as it was */
    }
  }

  private takePlanUsage(usage: import("../types.js").PlanUsage, accountId: string | null = null): void {
    const current = this.state.planUsage;
    const currentForAccount = accountId ? this.state.planUsageByAccount[accountId] : undefined;
    const takeGlobal = !current || current.observedAtMs <= usage.observedAtMs;
    const takeForAccount = accountId !== null && (!currentForAccount || currentForAccount.observedAtMs <= usage.observedAtMs);
    if (!takeGlobal && !takeForAccount) {
      return;
    }
    this.update((s) => ({
      ...s,
      planUsage: takeGlobal ? usage : s.planUsage,
      planUsageByAccount: takeForAccount ? { ...s.planUsageByAccount, [accountId as string]: usage } : s.planUsageByAccount,
    }));
  }

  // ---------------------------------------------------------------- accounts

  async loadAccounts(): Promise<void> {
    const rev = ++this.accountsRev;
    try {
      const accounts = await this.client.listAccounts();
      if (rev === this.accountsRev) {
        this.update((s) => ({ ...s, accounts }));
      }
    } catch {
      /* opening Settings retries the load */
    }
    void this.loadAccountsHealth();
  }

  /** Whether META_API_KEY in the environment makes every account share one Meta login. A server without the route leaves this false. */
  async loadAccountsHealth(): Promise<void> {
    try {
      const res = await this.client.accountsHealth();
      this.update((s) => ({ ...s, metaApiKeyInherited: res.metaApiKeyInherited }));
    } catch {
      /* a server without the route leaves the flag false */
    }
  }

  async createAccount(id: string, name?: string, seedFromDefault?: boolean): Promise<boolean> {
    const run = this.accountsChain.then(() =>
      this.client.createAccount(id, { ...(name ? { name } : {}), seedFromDefault: seedFromDefault ?? false }),
    );
    this.accountsChain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      await run;
      await this.loadAccounts();
      return true;
    } catch (error) {
      this.toast("error", "Could not create the account", errorMessage(error));
      return false;
    }
  }

  async renameAccount(id: string, name: string): Promise<boolean> {
    const run = this.accountsChain.then(() => this.client.renameAccount(id, name));
    this.accountsChain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      await run;
      await this.loadAccounts();
      return true;
    } catch (error) {
      this.toast("error", "Could not rename the account", errorMessage(error));
      return false;
    }
  }

  async removeAccount(id: string): Promise<boolean> {
    const run = this.accountsChain.then(() => this.client.removeAccount(id));
    this.accountsChain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      await run;
      await this.loadAccounts();
      return true;
    } catch (error) {
      this.toast("error", "Could not remove the account", errorMessage(error));
      return false;
    }
  }

  async setProjectDefaultAccount(cwd: string, accountId: string | null): Promise<void> {
    const previous = this.state.projects;
    const rev = ++this.projectDefaultRev;
    this.update((s) => ({ ...s, projects: s.projects.map((p) => (p.cwd === cwd ? { ...p, defaultAccountId: accountId } : p)) }));
    const run = this.accountsChain.then(() => this.client.setProjectDefaultAccount(cwd, accountId));
    this.accountsChain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      await run;
    } catch (error) {
      if (rev === this.projectDefaultRev) {
        this.update((s) => ({ ...s, projects: previous }));
        this.toast("error", "Could not set the default account", errorMessage(error));
      }
    }
  }

  /**
   * Starts an in-app device-code sign-in for an account: spawns `muse login` on the server and shows
   * the code the moment it arrives. Opens the modal right away with an empty marker so the wait for
   * Muse to print the link is not silent, then polls `loadAccounts` until the account reports it is
   * signed in (or gives up after `LOGIN_POLL_MAX_ATTEMPTS`, leaving the modal open with its link).
   */
  async beginLogin(id: string): Promise<void> {
    this.stopLoginPoll();
    const rev = ++this.loginRev;
    this.update((s) => ({ ...s, accountLogin: { accountId: id, url: "", code: null, status: "waiting" } }));
    try {
      const result = await this.client.loginAccount(id);
      if (rev !== this.loginRev) {
        return;
      }
      if ("fallback" in result) {
        this.update((s) => ({ ...s, accountLogin: { accountId: id, fallback: result.fallback } }));
        return;
      }
      this.update((s) => ({ ...s, accountLogin: { accountId: id, url: result.url, code: result.code, status: "waiting" } }));
      this.loginPollAttempts = 0;
      this.scheduleLoginPoll(id, rev);
    } catch (error) {
      if (rev !== this.loginRev) {
        return;
      }
      this.update((s) => ({ ...s, accountLogin: null }));
      this.toast("error", "Could not start sign-in", errorMessage(error));
    }
  }

  /** Closes the device-code modal and stops its poll. Safe to call whether or not a login is running. */
  cancelLogin(): void {
    this.loginRev += 1;
    this.stopLoginPoll();
    this.update((s) => ({ ...s, accountLogin: null }));
  }

  private scheduleLoginPoll(id: string, rev: number): void {
    if (this.disposed || rev !== this.loginRev) {
      return;
    }
    this.loginPollHandle = this.platform.schedule(() => {
      this.loginPollHandle = null;
      void this.pollLogin(id, rev);
    }, LOGIN_POLL_MS);
  }

  private async pollLogin(id: string, rev: number): Promise<void> {
    if (rev !== this.loginRev || !this.isWaitingLogin(id)) {
      return;
    }
    this.loginPollAttempts += 1;
    await this.loadAccounts();
    if (rev !== this.loginRev || !this.isWaitingLogin(id)) {
      return;
    }
    const account = this.state.accounts?.find((a) => a.id === id);
    if (account?.hasLogin) {
      this.update((s) => {
        const login = s.accountLogin;
        if (!login || login.accountId !== id || !("status" in login)) {
          return s;
        }
        return { ...s, accountLogin: { ...login, status: "done" } };
      });
      return;
    }
    if (this.loginPollAttempts >= LOGIN_POLL_MAX_ATTEMPTS) {
      return;
    }
    this.scheduleLoginPoll(id, rev);
  }

  /** Whether `accountLogin` is still the device prompt for `id`, waiting on a poll. */
  private isWaitingLogin(id: string): boolean {
    const login = this.state.accountLogin;
    return !!login && login.accountId === id && "status" in login && login.status === "waiting";
  }

  private stopLoginPoll(): void {
    if (this.loginPollHandle !== null) {
      this.platform.cancel(this.loginPollHandle);
      this.loginPollHandle = null;
    }
    this.loginPollAttempts = 0;
  }

  // ---------------------------------------------------------------- threads and projects

  async rename(sessionId: string, title: string): Promise<void> {
    const clean = title.trim();
    const current = this.state.sessions[sessionId];
    if (!clean || !current || clean === current.title) {
      return;
    }
    this.upsertSession({ ...current, title: clean, titleSource: "user" });
    try {
      const saved = await this.client.updateSession(sessionId, { title: clean });
      if (saved) {
        this.upsertSession(saved);
      }
    } catch (error) {
      this.upsertSession(current);
      this.toast("error", "Could not rename the thread", errorMessage(error));
    }
  }

  async archive(sessionId: string): Promise<void> {
    const current = this.state.sessions[sessionId];
    if (!current) {
      return;
    }
    this.update((s) => {
      const sessions = { ...s.sessions };
      delete sessions[sessionId];
      return { ...s, sessions };
    });
    const route = this.state.route;
    if (route.kind === "thread" && route.sessionId === sessionId) {
      this.navigate({ kind: "new", cwd: current.cwd });
    }
    try {
      await this.client.updateSession(sessionId, { archived: true });
      this.toast("info", "Thread archived", current.title, {
        label: "Undo",
        run: () => void this.unarchive(current),
      });
    } catch (error) {
      this.upsertSession(current);
      this.toast("error", "Could not archive the thread", errorMessage(error));
    }
  }

  /** Shelves a thread in its project's Settled list, or brings it back. */
  async setSettled(sessionId: string, settled: boolean): Promise<void> {
    const current = this.state.sessions[sessionId];
    if (!current || current.settled === settled) {
      return;
    }
    const now = new Date(this.platform.now()).toISOString();
    this.upsertSession(
      settled ? { ...current, settled: true, settledAt: now, unsettledAt: null } : { ...current, settled: false, settledAt: null, unsettledAt: now },
    );
    try {
      const saved = await this.client.updateSession(sessionId, { settled });
      if (saved) {
        this.upsertSession(saved);
      }
    } catch (error) {
      this.upsertSession(current);
      this.toast("error", settled ? "Could not settle the thread" : "Could not bring the thread back", errorMessage(error));
    }
  }

  toggleShelf(key: string): void {
    const open = this.state.prefs.openShelves;
    this.setPrefs({ openShelves: open.includes(key) ? open.filter((k) => k !== key) : [...open, key] });
  }

  private async unarchive(session: SessionSummary): Promise<void> {
    try {
      const saved = await this.client.updateSession(session.sessionId, { archived: false });
      this.upsertSession(saved ?? { ...session, archived: false });
    } catch (error) {
      this.toast("error", "Could not restore the thread", errorMessage(error));
    }
  }

  listDirectory(path: string): Promise<import("../types.js").DirectoryListing> {
    return this.client.listDirectory(path);
  }

  async revealPath(path: string): Promise<void> {
    try {
      await this.client.revealPath(path);
    } catch (error) {
      this.toast("error", "Could not open the folder", errorMessage(error));
    }
  }

  async cloneProject(url: string, path: string): Promise<boolean> {
    if (this.state.busy["cloneProject"]) {
      return false;
    }
    this.setBusy("cloneProject", true);
    try {
      const added = await this.client.cloneProject(url, path);
      await this.refresh();
      this.setAddProjectOpen(false);
      this.toast(
        "info",
        "Repository cloned",
        added.warning ? `Muse could not list its threads yet: ${added.warning}` : added.cwd,
      );
      this.newThread(added.cwd);
      return true;
    } catch (error) {
      this.toast("error", "Could not clone the repository", errorMessage(error));
      return false;
    } finally {
      this.setBusy("cloneProject", false);
    }
  }

  async addProject(cwd: string, options: { create?: boolean } = {}): Promise<boolean> {
    const path = cwd.trim();
    if (!path || this.state.busy["addProject"]) {
      return false;
    }
    this.setBusy("addProject", true);
    try {
      const added = await this.client.addProject(path, options);
      await this.refresh();
      this.setAddProjectOpen(false);
      if (added.warning) {
        this.toast("info", "Project added", `Muse could not list its threads yet: ${added.warning}`);
      }
      this.newThread(added.cwd);
      return true;
    } catch (error) {
      this.toast("error", "Could not add that folder", errorMessage(error));
      return false;
    } finally {
      this.setBusy("addProject", false);
    }
  }

  /** Token usage across every thread the server knows, for the usage page. */
  usageReport(days: number): Promise<import("../types.js").UsageReport> {
    return this.client.usage(days);
  }

  /** Imports OMP sessions made through the `muse-code` provider into the usage page. */
  importOmpUsage(): Promise<import("../types.js").OmpImportResult> {
    return this.client.importOmpUsage();
  }

  /** Moves a project in the sidebar, taking the new order from the row it was dropped on. */
  async reorderProjects(cwd: string, beforeCwd: string | null): Promise<void> {
    const current = this.state.projects;
    const moving = current.find((p) => p.cwd === cwd);
    if (!moving || cwd === beforeCwd) {
      return;
    }
    const rest = current.filter((p) => p.cwd !== cwd);
    const at = beforeCwd === null ? rest.length : rest.findIndex((p) => p.cwd === beforeCwd);
    const next = [...rest.slice(0, at < 0 ? rest.length : at), moving, ...rest.slice(at < 0 ? rest.length : at)];
    this.update((s) => ({ ...s, projects: next }));
    try {
      await this.client.setProjectOrder(next.map((p) => p.cwd));
    } catch (error) {
      this.update((s) => ({ ...s, projects: current }));
      this.toast("error", "Could not reorder the projects", errorMessage(error));
    }
  }

  async hideProject(cwd: string): Promise<void> {
    const project = this.state.projects.find((p) => p.cwd === cwd);
    if (!project) {
      return;
    }
    this.update((s) => ({ ...s, projects: s.projects.filter((p) => p.cwd !== cwd) }));
    const route = this.state.route;
    const active = route.kind === "thread" ? this.state.sessions[route.sessionId] : null;
    if ((route.kind === "new" && route.cwd === cwd) || active?.cwd === cwd) {
      this.navigate({ kind: "home" });
    }
    try {
      await this.client.hideProject(cwd);
      this.toast("info", `Removed ${project.displayName} from the sidebar`, "Its Muse threads are untouched.", {
        label: "Undo",
        run: () => void this.addProject(cwd),
      });
    } catch (error) {
      void this.refresh();
      this.toast("error", "Could not remove the project", errorMessage(error));
    }
  }

  async refreshProject(cwd: string): Promise<void> {
    try {
      await this.client.discover(cwd);
      await this.refresh();
    } catch (error) {
      this.toast("error", "Could not refresh that project", errorMessage(error));
    }
  }

  async togglePin(cwd: string): Promise<void> {
    const project = this.state.projects.find((p) => p.cwd === cwd);
    if (!project) {
      return;
    }
    try {
      await this.client.setPinned(cwd, !project.pinned);
      await this.refresh();
    } catch (error) {
      this.toast("error", "Could not update the project", errorMessage(error));
    }
  }

  /** Pins a thread above its project's list, or returns it to its stable place in it. */
  async toggleThreadPin(sessionId: string): Promise<void> {
    const current = this.state.sessions[sessionId];
    if (!current) {
      return;
    }
    const pinned = !current.pinned;
    this.upsertSession({ ...current, pinned });
    try {
      const saved = await this.client.updateSession(sessionId, { pinned });
      if (saved) {
        this.upsertSession(saved);
      }
    } catch (error) {
      this.upsertSession(current);
      this.toast("error", pinned ? "Could not pin the thread" : "Could not unpin the thread", errorMessage(error));
    }
  }

  // ---------------------------------------------------------------- slash commands, skills and shell

  /** The workspace the composer's commands act on: the open thread's, or where a new thread would start. */
  composerCwd(): string | null {
    const route = this.state.route;
    if (route.kind === "thread") {
      return this.state.sessions[route.sessionId]?.cwd ?? null;
    }
    return (route.kind === "new" ? route.cwd : null) ?? this.state.prefs.lastProject ?? this.state.projects[0]?.cwd ?? null;
  }

  private readonly skillLoads = new Map<string, Promise<void>>();

  /**
   * Loads a workspace's skills for the slash menu. A loaded list is reused for a minute and a failed load
   * retries after ten seconds; a load already running is shared, so a command sent mid-load waits for it.
   */
  loadSkills(cwd: string): Promise<void> {
    const running = this.skillLoads.get(cwd);
    if (running) {
      return running;
    }
    const current = this.state.skills[cwd];
    const age = this.platform.now() - (current?.loadedAt ?? 0);
    if (current && age < (current.status === "ready" ? SKILLS_FRESH_MS : SKILLS_RETRY_MS)) {
      return Promise.resolve();
    }
    const load = this.fetchSkills(cwd, current).finally(() => this.skillLoads.delete(cwd));
    this.skillLoads.set(cwd, load);
    return load;
  }

  /** Muse said a thread's skills changed: its workspace's list is stale, and the open composer should see the new one. */
  private refreshSkillsFor(sessionId: string): void {
    const cwd = this.state.sessions[sessionId]?.cwd;
    const current = cwd ? this.state.skills[cwd] : undefined;
    if (!cwd || !current) {
      return;
    }
    this.setSkills(cwd, { ...current, loadedAt: 0 });
    void this.loadSkills(cwd);
  }

  /** The open thread, when it is in `cwd`: Muse's own skill list for it is the one to show. */
  private skillSession(cwd: string): string | undefined {
    const route = this.state.route;
    return route.kind === "thread" && this.state.sessions[route.sessionId]?.cwd === cwd ? route.sessionId : undefined;
  }

  private async fetchSkills(cwd: string, current: SkillsState | undefined): Promise<void> {
    this.setSkills(cwd, { status: "loading", skills: current?.skills ?? [], error: null, loadedAt: current?.loadedAt ?? 0 });
    try {
      const catalog = await this.client.listSkills(cwd, this.skillSession(cwd));
      this.setSkills(cwd, {
        status: catalog.error ? "error" : "ready",
        skills: catalog.skills,
        error: catalog.error,
        loadedAt: this.platform.now(),
      });
    } catch (error) {
      this.setSkills(cwd, { status: "error", skills: current?.skills ?? [], error: errorMessage(error), loadedAt: this.platform.now() });
    }
  }

  private setSkills(cwd: string, next: SkillsState): void {
    this.update((s) => ({ ...s, skills: { ...s.skills, [cwd]: next } }));
  }

  setPicker(picker: ComposerPicker | null): void {
    this.update((s) => (s.picker === picker ? s : { ...s, picker }));
  }

  /** Closes `picker` only if it is still the open one, so a menu closing after it hands off to a dialog leaves the dialog open. */
  closePicker(picker: ComposerPicker): void {
    this.update((s) => (s.picker === picker ? { ...s, picker: null } : s));
  }

  /** `!command` runs in the thread's workspace shell; on the new-thread screen it starts the thread first. */
  private async runShell(command: string): Promise<boolean> {
    const run = async (sessionId: string): Promise<boolean> => {
      const thread = this.state.threads[sessionId];
      if (thread?.readOnly) {
        this.toast("info", "This thread is read-only here", thread.readOnlyReason ?? "Another Muse session has it open.");
        return false;
      }
      const key = `shell:${sessionId}`;
      if (this.state.busy[key]) {
        return false;
      }
      this.setBusy(key, true);
      try {
        // Helicon runs `!` itself: Muse's own host has no sandbox for these, so it never runs them at all.
        this.addShellRun(sessionId, await this.client.runShellProxy(sessionId, command));
        return true;
      } catch (error) {
        this.toast("error", "Command not run", errorMessage(error));
        return false;
      } finally {
        this.setBusy(key, false);
      }
    };
    const route = this.state.route;
    if (route.kind === "thread") {
      return run(route.sessionId);
    }
    const target = this.newThreadTarget();
    return target ? this.startThread(target, `!${command}`, run) : false;
  }

  /**
   * The server returns a relative URL for each saved file. The browser loads these on its own, outside the
   * client's calls, so a token-protected server would refuse every one of them: the image in the transcript
   * and the bytes a retry reads back alike. They carry the same credentials as everything else from here on.
   */
  private stamp(file: AttachmentView): AttachmentView {
    return { ...file, url: this.client.assetUrl(file.url) };
  }

  /** Adds files the server has just saved to the open thread, skipping any it already has. */
  private keepAttachments(sessionId: string, saved: AttachmentView[]): void {
    if (saved.length === 0) {
      return;
    }
    this.update((s) => {
      const thread = s.threads[sessionId];
      if (!thread) {
        return s;
      }
      const known = new Set(thread.attachments.map((file) => file.id));
      const added = saved.filter((file) => !known.has(file.id)).map((file) => this.stamp(file));
      if (added.length === 0) {
        return s;
      }
      return { ...s, threads: { ...s.threads, [sessionId]: { ...thread, attachments: [...thread.attachments, ...added] } } };
    });
  }

  /** Keeps a command Helicon ran in the thread it belongs to, whoever started it. */
  private addShellRun(sessionId: string, run: import("../types.js").ShellRun): void {
    this.update((s) => {
      const thread = s.threads[sessionId];
      if (!thread || thread.shellRuns.some((existing) => existing.id === run.id)) {
        return s;
      }
      return { ...s, threads: { ...s.threads, [sessionId]: { ...thread, shellRuns: [...thread.shellRuns, run] } } };
    });
  }

  /** Hands a command's output to Muse as the next prompt, since Muse never saw it run. */
  sendShellOutput(sessionId: string, run: import("../types.js").ShellRun): Promise<boolean> {
    const fence = "`".repeat(Math.max(3, ...(run.output.match(/`+/g) ?? []).map((mark) => mark.length + 1)));
    const status = run.exitCode === 0 ? "" : ` (exit ${run.exitCode ?? "unknown"})`;
    const text = `I ran this in the workspace${status}:\n\n${fence}sh\n${run.command}\n${fence}\n\nIts output:\n\n${fence}\n${run.output.trim() || "(no output)"}\n${fence}`;
    return this.sendToThread(sessionId, text, { displayText: `Shared the output of \`${run.command}\`` }, false);
  }

  private async runSlash(typed: string, parsed: ParsedSlash, options: TurnDelivery): Promise<boolean> {
    const route = this.state.route;
    // A retry names the thread the command belongs to; a typed command acts wherever the user is.
    const bound = options.sessionId ?? null;
    const cwd = bound ? (this.state.sessions[bound]?.cwd ?? null) : this.composerCwd();
    // A skill typed before the workspace's skills arrived waits for them instead of reading as unknown;
    // built-ins other than `/skill` never wait on a slow skills list.
    const builtin = slashCommands([], { inThread: true }).find((c) => c.name === parsed.name || c.aliases.includes(parsed.name));
    if (cwd && (!builtin || builtin.action === "skill")) {
      await this.loadSkills(cwd);
    }
    const skills = cwd ? (this.state.skills[cwd]?.skills ?? []) : [];
    // Resolve against every built-in, so a thread-only command typed outside a thread gets a useful answer.
    const resolved = resolveSlash(parsed, slashCommands(skills, { inThread: true }), skills);
    if (resolved.kind === "unknown") {
      this.toast("info", `No command named /${resolved.name}`, "Pick one from the list, or send the text as a prompt from the menu.");
      return false;
    }
    if (resolved.kind === "skill") {
      return this.runSkill(resolved.skill, resolved.args, typed, cwd, options);
    }
    const { command, args } = resolved;
    const sessionId = bound ?? (route.kind === "thread" ? route.sessionId : null);
    if (command.needsThread && !sessionId) {
      this.toast("info", `Open a thread to use /${command.name}`);
      return false;
    }
    switch (command.action) {
      case "compact":
        await this.compact(sessionId as string);
        return true;
      case "fork":
        return this.fork(sessionId as string);
      case "side":
        return this.sideChat(sessionId as string, args);
      case "new":
        this.newThread(cwd);
        return true;
      case "resume":
        this.setPaletteOpen(true);
        return true;
      case "init":
        return this.deliver(INIT_PROMPT, { ...options, displayText: typed });
      case "goal": {
        if (!args) {
          this.toast("info", "Add the goal after /goal", "For example: /goal get the test suite passing");
          return false;
        }
        const verb = /^(pause|resume|clear)$/i.exec(args.trim())?.[1]?.toLowerCase() as GoalAction | undefined;
        if (verb) {
          if (!sessionId) {
            this.toast("info", `Open a thread to ${verb} its goal`);
            return false;
          }
          return this.goalAction(sessionId, verb);
        }
        if (sessionId) {
          return this.setGoal(sessionId, args, typed, options);
        }
        const target = this.newThreadTarget();
        if (!target) {
          return false;
        }
        return this.startThread(target, typed, (fresh) => this.setGoal(fresh, args, typed, options));
      }
      case "model": {
        if (!args) {
          this.setPicker("model");
          return true;
        }
        const model = findModel(this.state.models, args, modelDisplayName);
        if (!model) {
          this.toast("info", `No model named ${args}`, "Type /model to pick from the list.");
          return false;
        }
        await this.setModel(model.modelId);
        return true;
      }
      case "effort": {
        if (!args) {
          this.setPicker("effort");
          return true;
        }
        const effort = parseEffort(args);
        if (effort === undefined) {
          this.toast("info", `Unknown effort level: ${args}`, "Use off, minimal, low, medium, high, xhigh, max or auto.");
          return false;
        }
        this.setEffort(effort);
        return true;
      }
      case "permissions": {
        if (!args) {
          this.setPicker("permissions");
          return true;
        }
        const mode = parseMode(args);
        if (!mode) {
          this.toast("info", `Unknown permission mode: ${args}`, "Use ask, unlisted, deny or full.");
          return false;
        }
        if (mode === "allowAll") {
          // YOLO already owns full access host-wide; opening the confirm dialog here would promise a
          // thread-scoped change setMode itself refuses once the dialog says yes.
          if (this.state.yoloSettings?.enabled === true) {
            this.toast("info", "YOLO is on", "Switch YOLO off to change permissions.");
            return true;
          }
          // Full access always goes through its confirmation.
          this.setPicker("confirmFullAccess");
          return true;
        }
        await this.setMode(mode);
        return true;
      }
      default:
        return false;
    }
  }

  /** A skill turn: the model loads the skill itself, or gets the body inline when only users may invoke it. */
  private async runSkill(
    skill: SkillEntry,
    args: string,
    typed: string,
    cwd: string | null,
    options: TurnDelivery,
  ): Promise<boolean> {
    let body: string | null = null;
    if (skill.activation === "user-invocable-only") {
      try {
        body = await this.client.skillBody(cwd ?? "", skill.id);
      } catch (error) {
        this.toast("error", `Could not load /${skill.name}`, errorMessage(error));
        return false;
      }
    }
    const turn = skillTurn(skill, args, typed, body);
    return this.deliver(turn.text, { ...options, displayText: turn.displayText });
  }

  /**
   * Picks a goal back up. A paused goal resumes through Muse's own goal command; a blocked one, which that command
   * does not cover, gets a prompt asking the model to keep going.
   */
  async continueGoal(sessionId: string, objective: string, status?: string): Promise<boolean> {
    if (status === "paused" && (await this.goalAction(sessionId, "resume", undefined, { quiet: true }))) {
      return true;
    }
    return this.sendToThread(sessionId, `Keep working toward the goal: ${objective}`, { displayText: "Keep working on the goal" }, false);
  }

  /**
   * Sets the thread's goal through `goal/set`, which also starts work on it when the thread is idle. A host without
   * the goal commands gets the old route: a prompt asking the model to set it with its own tool.
   */
  private async setGoal(sessionId: string, objective: string, typed: string, options: TurnDelivery): Promise<boolean> {
    const thread = this.state.threads[sessionId];
    if (thread?.readOnly) {
      this.toast("info", "This thread is read-only here", thread.readOnlyReason ?? "Another Muse session has it open.");
      return false;
    }
    try {
      await this.client.goal(sessionId, "set", objective);
      return true;
    } catch (error) {
      if (errorKind(error) === "methodNotFound") {
        return this.sendToThread(sessionId, goalPrompt(objective), { ...options, displayText: typed }, false);
      }
      this.toast("error", "Could not set the goal", errorMessage(error));
      return false;
    }
  }

  /** Pause, resume, clear or edit the thread's goal. `quiet` leaves failures to the caller. */
  async goalAction(sessionId: string, action: GoalAction, objective?: string, options: { quiet?: boolean } = {}): Promise<boolean> {
    const key = `goal:${sessionId}`;
    if (this.state.busy[key]) {
      return false;
    }
    this.setBusy(key, true);
    try {
      await this.client.goal(sessionId, action, objective);
      return true;
    } catch (error) {
      if (!options.quiet) {
        // Muse refuses a verb the goal's current state does not allow, like pausing one that is already blocked.
        const stale = /invalid_goal_state|missing_goal/.test(errorMessage(error));
        this.toast(stale ? "info" : "error", GOAL_FAILURES[action], stale ? "The goal changed since this panel last updated. Try again once it catches up." : errorMessage(error));
      }
      return false;
    } finally {
      this.setBusy(key, false);
    }
  }

  // ---------------------------------------------------------------- tasks, subagents and workflows

  /** `background` or `stop` one tool task by its item id, or `stopAll` the thread's background work. */
  async taskAction(sessionId: string, action: TaskAction, taskId?: string): Promise<boolean> {
    const key = `task:${sessionId}:${taskId ?? "all"}`;
    if (this.state.busy[key]) {
      return false;
    }
    this.setBusy(key, true);
    try {
      await this.client.task(sessionId, action, taskId);
      return true;
    } catch (error) {
      this.toast("error", TASK_FAILURES[action], errorMessage(error));
      return false;
    } finally {
      this.setBusy(key, false);
    }
  }

  async subagentAction(sessionId: string, action: SubagentAction, subagentId: string, body?: string): Promise<boolean> {
    const key = `subagent:${sessionId}:${subagentId}`;
    if (this.state.busy[key]) {
      return false;
    }
    this.setBusy(key, true);
    try {
      await this.client.subagent(sessionId, action, subagentId, body ? { body } : {});
      return true;
    } catch (error) {
      this.toast("error", "The subagent did not take that", errorMessage(error));
      return false;
    } finally {
      this.setBusy(key, false);
    }
  }

  async workflowAction(
    sessionId: string,
    action: WorkflowAction,
    workflowRunId: string,
    child?: { childId: string; attempt: number },
  ): Promise<boolean> {
    const key = `workflow:${sessionId}:${workflowRunId}:${child?.childId ?? "run"}`;
    if (this.state.busy[key]) {
      return false;
    }
    this.setBusy(key, true);
    try {
      await this.client.workflow(sessionId, action, workflowRunId, child);
      return true;
    } catch (error) {
      // A stale attempt means the child moved on since this card last drew; the next view update redraws it.
      const stale = errorKind(error) === "stale_attempt";
      this.toast(stale ? "info" : "error", stale ? "That agent already moved on" : "The workflow did not take that", stale ? "Try again once the card updates." : errorMessage(error));
      return false;
    } finally {
      this.setBusy(key, false);
    }
  }

  /** One page of a tool's full stored output; the caller keeps asking from `offsetBytes + byteLen` until `eof`. */
  readOutput(sessionId: string, itemId: string, outputRef: string, offset = 0): Promise<OutputRange> {
    return this.client.readOutput(sessionId, itemId, outputRef, offset);
  }

  /** Hands a `!` command the host could not run to the agent, whose own shell tool can. */
  askToRun(sessionId: string, command: string): Promise<boolean> {
    // A fence longer than any run of backticks in the command, so the command cannot close its own block.
    const runs = command.match(/`+/g) ?? [];
    const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    // The failed `!` item says the environment is broken, which makes the agent refuse; tell it that its own shell is fine.
    const text =
      `Run this with your shell tool and show me the output:\n\n${fence}sh\n${command}\n${fence}\n\n` +
      "That failure came from Helicon's `!` path, not from your tools: your own shell works here.";
    return this.sendToThread(sessionId, text, {}, false);
  }

  /** Branches a thread into a new one and opens it. */
  async fork(sessionId: string): Promise<boolean> {
    const key = `fork:${sessionId}`;
    if (this.state.busy[key]) {
      return false;
    }
    this.setBusy(key, true);
    try {
      const session = await this.client.forkSession(sessionId);
      this.upsertSession(session);
      this.navigate({ kind: "thread", sessionId: session.sessionId });
      this.toast("success", "Forked into a new thread", "The original thread stays as it was.");
      return true;
    } catch (error) {
      this.toast(
        "error",
        "Could not fork the thread",
        errorKind(error) === "forkBoundaryInvalid" ? "Muse could not find a point in this thread to fork it at." : errorMessage(error),
      );
      return false;
    } finally {
      this.setBusy(key, false);
    }
  }

  /**
   * Opens a side chat beside a thread and switches to it, sending `text` there when there is some.
   * The thread itself is left as it was.
   */
  async sideChat(sessionId: string, text = ""): Promise<boolean> {
    const key = `side:${sessionId}`;
    if (this.state.busy[key]) {
      return false;
    }
    this.setBusy(key, true);
    try {
      const parentMode = this.state.threads[sessionId]?.fold.meta.approvalMode ?? null;
      const session = await this.client.sideChat(sessionId);
      this.upsertSession(session);
      // Muse 1.4.4 opens every side chat in full access, whatever its thread uses. The side chat
      // gets its thread's permissions instead, so it never runs tools the thread would ask about.
      const mode: ApprovalMode = this.state.yoloSettings?.enabled === true ? "allowAll" : (parentMode ?? this.state.prefs.defaultMode);
      let guarded = true;
      try {
        await this.client.setApprovalMode(session.sessionId, mode);
      } catch (error) {
        guarded = false;
        this.toast(
          "error",
          "The side chat may run tools without asking",
          `Helicon could not set its permissions, so nothing was sent. Set them in the composer before you send. ${errorMessage(error)}`,
        );
      }
      this.navigate({ kind: "thread", sessionId: session.sessionId });
      const message = text.trim();
      // Fail closed: a message never goes into a side chat whose permissions could not be set.
      if (message && guarded) {
        await this.loadThread(session.sessionId);
        return this.sendToThread(session.sessionId, message, {}, false);
      }
      return true;
    } catch (error) {
      this.toast("error", "Could not open a side chat", errorMessage(error));
      return false;
    } finally {
      this.setBusy(key, false);
    }
  }

  /** True only when Muse took the compaction on: a refusal or a noop leaves the history exactly as it was. */
  async compact(sessionId: string): Promise<boolean> {
    try {
      const result = await this.client.compact(sessionId);
      if (result.noop) {
        const reason = result.reason === "no_compactable_history" ? "There is no earlier history to summarize." : result.reason;
        this.toast("info", "Nothing to compact yet", reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1).replace(/_/g, " ")}` : undefined);
        return false;
      }
      this.toast("info", "Compacting context", "Muse will summarize earlier turns to free up the context window.");
      return true;
    } catch (error) {
      this.toast("error", "Could not compact the context", errorMessage(error));
      return false;
    }
  }

  /**
   * For a thread whose history the provider will not take: summarize it, which leaves the unusable part
   * behind, then send the prompt again. The retry queues behind the compaction Muse runs as its own turn.
   */
  /**
   * For a thread whose stored reasoning cannot be replayed at all: start one beside it in the same project
   * and send the prompt there. Compacting keeps the recent turns as they are, so it cannot clear that.
   */
  async freshThread(
    sessionId: string,
    prompt: string | null,
    files: { attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},
  ): Promise<boolean> {
    const cwd = this.state.sessions[sessionId]?.cwd ?? null;
    if (!cwd) {
      this.toast("error", "Could not start a new thread", "That thread's project is not known here.");
      return false;
    }
    // An image with no words of its own is still a question, so it goes too; with neither, there is
    // nothing to ask again and the new thread simply opens.
    const carrying = files.attachments?.length ?? 0;
    if (!prompt && carrying === 0) {
      this.newThread(cwd);
      return true;
    }
    const text = prompt ?? "";
    // Through the retry path, so a prompt entered as `/goal …` or a skill is expanded again rather than
    // reaching the model as the literal command the transcript showed.
    // The real result, so a prompt that did not go comes back to the composer instead of being lost.
    return this.startThread(cwd, text, (fresh) => this.retryTurn(fresh, text, files), files);
  }

  async compactAndRetry(
    sessionId: string,
    prompt: string | null,
    files: { attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},
  ): Promise<void> {
    // Only a compaction Muse took on changes the history: after a refusal or a noop, the prompt would fail
    // exactly as before. The retry queues behind the compaction turn, which may not have reached us yet.
    if (!(await this.compact(sessionId)) || !prompt) {
      return;
    }
    await this.retryTurn(sessionId, prompt, { ...files, queue: true });
  }

  async openFolder(cwd: string, target: "files" | "editor"): Promise<void> {
    try {
      await this.client.openFolder(cwd, target);
    } catch (error) {
      this.toast("error", target === "editor" ? "Could not open VS Code" : "Could not open the folder", errorMessage(error));
    }
  }

  // ---------------------------------------------------------------- prefs and chrome

  setPrefs(patch: Partial<Prefs>): void {
    this.update((s) => ({ ...s, prefs: { ...s.prefs, ...patch } }));
    if (this.saveHandle === null) {
      this.saveHandle = this.platform.schedule(() => {
        this.saveHandle = null;
        this.platform.savePrefs(this.state.prefs);
      }, 400);
    }
  }

  markSeen(sessionId: string, force = false): void {
    const now = new Date(this.platform.now()).toISOString();
    const previous = this.state.prefs.lastSeen[sessionId];
    if (!force && previous && Date.parse(now) - Date.parse(previous) < 2000) {
      return;
    }
    this.setPrefs({ lastSeen: { ...this.state.prefs.lastSeen, [sessionId]: now } });
  }

  /**
   * Remembers whether a dock card is open, per thread. Without this the card is local state that dies with
   * the view, so leaving a thread and coming back reopens what the user had folded away.
   */
  setCardOpen(key: string, open: boolean): void {
    const collapsed = this.state.prefs.collapsedCards;
    if (open === !collapsed.includes(key)) {
      return;
    }
    this.setPrefs({ collapsedCards: open ? collapsed.filter((k) => k !== key) : [...collapsed, key] });
  }

  /** Closes a dock card for good, or brings it back. The oldest are forgotten past a few hundred threads. */
  setCardHidden(key: string, hidden: boolean): void {
    const current = this.state.prefs.hiddenCards;
    if (hidden === current.includes(key)) {
      return;
    }
    this.setPrefs({ hiddenCards: hidden ? [...current, key].slice(-300) : current.filter((k) => k !== key) });
  }

  /** Brings back every dock card closed in one thread. */
  showThreadCards(sessionId: string): void {
    const suffix = `:${sessionId}`;
    const current = this.state.prefs.hiddenCards;
    const kept = current.filter((k) => !k.endsWith(suffix));
    if (kept.length !== current.length) {
      this.setPrefs({ hiddenCards: kept });
    }
  }

  setGroupBy(groupBy: GroupBy): void {
    this.setPrefs({ groupBy });
  }

  setTheme(theme: ThemePref): void {
    this.setPrefs({ theme });
  }

  setCodeTheme(codeTheme: CodeTheme): void {
    this.setPrefs({ codeTheme });
  }

  setZoom(zoom: number): void {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
    this.setPrefs({ zoom: clamped });
  }

  zoomIn(): void {
    const current = this.state.prefs.zoom;
    this.setZoom(ZOOM_STEPS.find((step) => step > current + 1e-9) ?? ZOOM_MAX);
  }

  zoomOut(): void {
    const current = this.state.prefs.zoom;
    this.setZoom([...ZOOM_STEPS].reverse().find((step) => step < current - 1e-9) ?? ZOOM_MIN);
  }

  resetZoom(): void {
    this.setZoom(1);
  }

  setSidebarCollapsed(collapsed: boolean): void {
    if (this.state.prefs.sidebarCollapsed !== collapsed) {
      this.setPrefs({ sidebarCollapsed: collapsed });
    }
  }

  toggleSidebar(): void {
    this.setPrefs({ sidebarCollapsed: !this.state.prefs.sidebarCollapsed });
  }

  // ---------------------------------------------------------------- files

  /** Shows or hides the file viewer beside threads; it keeps each thread's open files either way. */
  toggleFiles(open?: boolean): void {
    this.setPrefs({ filesOpen: open ?? !this.state.prefs.filesOpen });
  }

  setFilesWidth(width: number): void {
    this.setPrefs({ filesWidth: Math.round(Math.min(FILES_WIDTH_MAX, Math.max(FILES_WIDTH_MIN, width))) });
  }

  private patchPanel(sessionId: string, fn: (panel: FilePanel) => FilePanel): void {
    this.update((s) => {
      const current = s.filePanels[sessionId] ?? { tabs: [], active: null, tree: true, line: null };
      return { ...s, filePanels: { ...s.filePanels, [sessionId]: fn(current) } };
    });
  }

  /**
   * Opens a file in a thread's viewer, from the tree or from a path a reply named, and shows the viewer. A path with
   * a line (`app.ts:12`) scrolls there. Returns false when the thread's project is unknown.
   */
  openFile(sessionId: string, raw: string, line: LineRange | null = null): boolean {
    const cwd = this.state.sessions[sessionId]?.cwd;
    const target = cwd ? fileTarget(raw, cwd) : null;
    if (!cwd || !target || !target.path) {
      return false;
    }
    if (this.externalFileOpener) {
      this.externalFileOpener(cwd, target.path, line ?? target.line);
      return true;
    }
    this.patchPanel(sessionId, (panel) => ({
      tabs: panel.tabs.includes(target.path) ? panel.tabs : [...panel.tabs, target.path],
      active: target.path,
      tree: false,
      line: line ?? target.line,
    }));
    if (!this.state.prefs.filesOpen) {
      this.setPrefs({ filesOpen: true });
    }
    return true;
  }

  /** Set when a host (an editor extension) opens files itself: file links then go there, not to the viewer. */
  private externalFileOpener: ((cwd: string, path: string, line: LineRange | null) => void) | null = null;

  setExternalFileOpener(opener: ((cwd: string, path: string, line: LineRange | null) => void) | null): void {
    this.externalFileOpener = opener;
  }

  showFileTree(sessionId: string, tree: boolean): void {
    this.patchPanel(sessionId, (panel) => ({ ...panel, tree: tree || panel.active === null }));
  }

  activateFile(sessionId: string, path: string): void {
    this.patchPanel(sessionId, (panel) => (panel.tabs.includes(path) ? { ...panel, active: path, tree: false, line: null } : panel));
  }

  /** Closes a tab, discarding its unsaved edit; the view asks first when there is one. */
  closeFile(sessionId: string, path: string): void {
    const cwd = this.state.sessions[sessionId]?.cwd;
    if (cwd) {
      this.setFileDraft(cwd, path, null);
    }
    this.patchPanel(sessionId, (panel) => {
      const index = panel.tabs.indexOf(path);
      const tabs = panel.tabs.filter((tab) => tab !== path);
      // The neighbour to the left takes over, as in an editor; closing the last tab shows the tree.
      const active = panel.active !== path ? panel.active : (tabs[Math.max(0, index - 1)] ?? null);
      return { tabs, active, tree: active === null ? true : panel.tree, line: panel.active === path ? null : panel.line };
    });
  }

  /** Keeps an unsaved edit across tab switches; null drops it. */
  setFileDraft(cwd: string, path: string, content: string | null, baseMtimeMs: number | null = null): void {
    const key = fileKey(cwd, path);
    this.update((s) => {
      const fileDrafts = { ...s.fileDrafts };
      if (content === null) {
        delete fileDrafts[key];
      } else {
        fileDrafts[key] = { content, baseMtimeMs: fileDrafts[key]?.baseMtimeMs ?? baseMtimeMs };
      }
      return { ...s, fileDrafts };
    });
  }

  /**
   * Saves a file's unsaved edit. When the file changed on disk since it was opened, nothing is written and the user
   * chooses: the toast's action overwrites, or reloading the file shows the other change. Returns the new write time.
   */
  async saveFile(cwd: string, path: string, overwrite = false): Promise<number | null> {
    const key = fileKey(cwd, path);
    const draft = this.state.fileDrafts[key];
    if (!draft || this.state.busy[`save:${key}`]) {
      return null;
    }
    this.setBusy(`save:${key}`, true);
    try {
      const saved = await this.client.writeFile(cwd, path, draft.content, overwrite ? null : draft.baseMtimeMs);
      // Only a draft still holding what was sent is done; typing during the save keeps the newer text as unsaved.
      this.update((s) => {
        const fileDrafts = { ...s.fileDrafts };
        if (fileDrafts[key]?.content === draft.content) {
          delete fileDrafts[key];
        } else if (fileDrafts[key]) {
          fileDrafts[key] = { ...fileDrafts[key], baseMtimeMs: saved.mtimeMs };
        }
        return { ...s, fileDrafts, fileVersions: { ...s.fileVersions, [key]: (s.fileVersions[key] ?? 0) + 1 } };
      });
      return saved.mtimeMs;
    } catch (error) {
      if (errorKind(error) === "fileChanged") {
        this.toast("error", "This file changed on disk", "Something else saved it since you opened it. Reload to see that change, or overwrite it with yours.", {
          label: "Overwrite",
          run: () => void this.saveFile(cwd, path, true),
        });
      } else {
        this.toast("error", "Could not save the file", errorMessage(error));
      }
      return null;
    } finally {
      this.setBusy(`save:${key}`, false);
    }
  }

  toggleTreeFolder(cwd: string, path: string): void {
    this.update((s) => {
      const open = s.fileTreeOpen[cwd] ?? [];
      const next = open.includes(path) ? open.filter((p) => p !== path) : [...open, path];
      return { ...s, fileTreeOpen: { ...s.fileTreeOpen, [cwd]: next } };
    });
  }

  listFiles(cwd: string, path: string) {
    return this.client.listFiles(cwd, path);
  }

  readFile(cwd: string, path: string) {
    return this.client.readFile(cwd, path);
  }

  searchFiles(cwd: string, query: string) {
    return this.client.searchFiles(cwd, query);
  }

  fileUrl(cwd: string, path: string): string {
    return this.client.fileUrl(cwd, path);
  }

  /** Accepts these files' changes: they leave the "files changed" card until the thread edits them again. */
  keepChanges(sessionId: string, files: { path: string; count: number }[]): void {
    if (files.length > 0) {
      this.setPrefs({ settledChanges: withSettled(this.state.prefs.settledChanges, sessionId, files) });
    }
  }

  /**
   * Takes back the thread's edits to these files, one file at a time, and settles the ones that came back. A file that
   * no longer matches what the thread wrote is left as it is and named in the toast, never overwritten.
   */
  async undoChanges(sessionId: string, files: { path: string; count: number; steps: RevertStep[] | null }[]): Promise<void> {
    const cwd = this.state.sessions[sessionId]?.cwd;
    // A second click while the first undo of a file is still running would only report a false conflict.
    files = files.filter((file) => !this.undoing.has(`${sessionId}|${file.path}`));
    if (!cwd || files.length === 0) {
      return;
    }
    const keys = files.map((file) => `${sessionId}|${file.path}`);
    keys.forEach((k) => this.undoing.add(k));
    try {
      await this.undoFiles(sessionId, cwd, files);
    } finally {
      keys.forEach((k) => this.undoing.delete(k));
    }
  }

  private readonly undoing = new Set<string>();

  private async undoFiles(
    sessionId: string,
    cwd: string,
    files: { path: string; count: number; steps: RevertStep[] | null }[],
  ): Promise<void> {
    const done: { path: string; count: number }[] = [];
    const left: string[] = [];
    let lastReason = "";
    for (const file of files) {
      if (!file.steps) {
        left.push(file.path);
        lastReason = "Muse changed it in a way Helicon cannot reverse from the record.";
        continue;
      }
      try {
        await this.client.revertChanges(cwd, file.path, file.steps);
        done.push({ path: file.path, count: file.count });
      } catch (error) {
        left.push(file.path);
        lastReason = errorMessage(error);
      }
    }
    this.keepChanges(sessionId, done);
    if (left.length === 0) {
      this.toast("success", done.length === 1 ? "Change undone" : `${done.length} files restored`, "Muse is not told: say so in your next message if it should know.");
      return;
    }
    this.toast(
      "error",
      done.length > 0 ? `Undid ${done.length}, left ${left.length} as they are` : "Could not undo",
      left.length === 1 ? lastReason : `${left.slice(0, 3).join(", ")}${left.length > 3 ? ` and ${left.length - 3} more` : ""}: ${lastReason}`,
    );
  }

  async openFileExternally(cwd: string, path: string): Promise<void> {
    try {
      await this.client.openFileExternally(cwd, path);
    } catch (error) {
      this.toast("error", "Could not open the file", errorMessage(error));
    }
  }

  setSidebarWidth(width: number): void {
    this.setPrefs({ sidebarWidth: Math.round(Math.min(480, Math.max(220, width))) });
  }

  toggleProjectCollapsed(cwd: string): void {
    const collapsed = this.state.prefs.collapsedProjects;
    this.setPrefs({
      collapsedProjects: collapsed.includes(cwd) ? collapsed.filter((c) => c !== cwd) : [...collapsed, cwd],
    });
  }

  setPaletteOpen(open: boolean): void {
    this.update((s) => (s.paletteOpen === open ? s : { ...s, paletteOpen: open }));
  }

  setAddProjectOpen(open: boolean): void {
    this.update((s) => (s.addProjectOpen === open ? s : { ...s, addProjectOpen: open }));
  }

  /** Opens the release notes from Settings, rather than waiting for a version to change. */
  setWhatsNewOpen(open: boolean): void {
    this.update((s) => (s.whatsNewOpen === open ? s : { ...s, whatsNewOpen: open }));
  }

  toast(tone: Toast["tone"], title: string, detail?: string, action?: Toast["action"]): void {
    this.toastSeq += 1;
    const id = this.toastSeq;
    this.update((s) => ({ ...s, toasts: [...s.toasts.slice(-3), { id, tone, title, detail, action }] }));
    this.platform.schedule(() => this.dismissToast(id), TOAST_MS[tone]);
  }

  dismissToast(id: number): void {
    this.update((s) => (s.toasts.some((t) => t.id === id) ? { ...s, toasts: s.toasts.filter((t) => t.id !== id) } : s));
  }

  // ---------------------------------------------------------------- helpers

  private setBusy(key: string, on: boolean): void {
    this.update((s) => {
      if (Boolean(s.busy[key]) === on) {
        return s;
      }
      const busy = { ...s.busy };
      if (on) {
        busy[key] = true;
      } else {
        delete busy[key];
      }
      return { ...s, busy };
    });
  }

  private setThread(sessionId: string, thread: ThreadState): void {
    this.update((s) => ({ ...s, threads: { ...s.threads, [sessionId]: thread } }));
  }

  private patchFold(sessionId: string, fn: (fold: ThreadFold) => ThreadFold): void {
    this.update((s) => {
      const thread = s.threads[sessionId];
      if (!thread) {
        return s;
      }
      const fold = fn(thread.fold);
      return fold === thread.fold ? s : { ...s, threads: { ...s.threads, [sessionId]: { ...thread, fold } } };
    });
  }

  private patchMeta(sessionId: string, patch: Partial<ThreadFold["meta"]>): void {
    this.patchFold(sessionId, (f) => ({ ...f, meta: { ...f.meta, ...patch } }));
  }

  private upsertSession(session: SessionSummary): void {
    this.update((s) => ({ ...s, sessions: { ...s.sessions, [session.sessionId]: session } }));
  }
}
