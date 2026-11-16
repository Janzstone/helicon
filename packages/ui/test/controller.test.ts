import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HeliconError, type EventHandler, type HeliconClient } from "../src/client.js";
import { HeliconController, staleThreadReason, type Platform } from "../src/model/controller.js";
import { buildTurns } from "../src/model/fold.js";
import { ZOOM_MAX, ZOOM_MIN } from "../src/model/store.js";
import type { SessionSummary, SkillEntry, TranscriptLoad, UserInputRequest } from "../src/types.js";
import { historyEvents } from "./fixtures/probe.js";

const SESSION: SessionSummary = {
  sessionId: "s1",
  cwd: "/work/app",
  title: "Probe",
  titleSource: "auto",
  turnCount: 3,
  modelId: "muse-spark-1.3",
  origin: "helicon",
  archived: false,
  createdAt: "2026-09-11T00:00:00.000Z",
  activityAt: "2026-09-11T00:00:00.000Z",
  settled: false,
  settledAt: null,
  unsettledAt: null,
  pinned: false,
  sandboxDisabled: false,
  accountId: null,
  live: null,
};

function load(overrides: Partial<TranscriptLoad> = {}): TranscriptLoad {
  return {
    session: SESSION,
    msp: { status: "idle", activeTurnId: null, modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/app", turnCount: 3 },
    events: historyEvents,
    truncated: false,
    pending: { approvals: [], userInputs: [] },
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

class FakeClient implements HeliconClient {
  handler: EventHandler | null = null;
  sent: {
    sessionId: string;
    text: string;
    ifBusy?: string;
    displayText?: string;
    attachments?: { name: string; mediaType: string; base64: string }[];
  }[] = [];
  actions: string[] = [];
  orders: string[][] = [];
  skills: SkillEntry[] = [];
  transcript: () => Promise<TranscriptLoad> = async () => load();
  sendResult: () => Promise<{ turnId: string | null; disposition: string | null }> = async () => ({ turnId: "t9", disposition: "started" });

  async probeEnvironment() {
    return { platform: "linux", wslAvailable: false, defaultDistro: null, museFound: true, musePath: "/usr/bin/muse", version: "0.2.0", persistent: true };
  }
  projects: import("../src/types.js").ProjectView[] = [
    { cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null },
  ];
  async listProjects() {
    return [...this.projects];
  }
  async addProject(cwd: string) {
    return { cwd, warning: null };
  }
  async cloneProject(_url: string, path: string) {
    return { cwd: path, warning: null };
  }
  async listDirectory(path: string) {
    return { directory: path, parent: null, separator: "/" as const, exists: true, entries: [] };
  }
  assetUrl(path: string) {
    return path;
  }
  async revealPath() {}
  async hideProject() {}
  async setPinned() {}
  async listSessions() {
    return [SESSION];
  }
  async discover() {}
  startCalls: { cwd: string; approvalMode?: string; modelId?: string; accountId: string | null }[] = [];
  async startSession(cwd: string, options?: { approvalMode?: string; modelId?: string; accountId?: string | null }) {
    this.startCalls.push({ cwd, approvalMode: options?.approvalMode, modelId: options?.modelId, accountId: options?.accountId ?? null });
    return { ...SESSION, accountId: options?.accountId ?? null };
  }
  loadTranscript() {
    return this.transcript();
  }
  async updateSession() {
    return SESSION;
  }
  async sendTurn(
    sessionId: string,
    text: string,
    options?: { ifBusy?: string; displayText?: string; attachments?: { name: string; mediaType: string; base64: string }[] },
  ) {
    this.sent.push({
      sessionId,
      text,
      ifBusy: options?.ifBusy,
      displayText: options?.displayText,
      attachments: options?.attachments,
    });
    return this.sendResult();
  }
  async interruptTurn() {}
  async unqueueTurn() {}
  decided: { approvalId: string; choiceId: string }[] = [];
  async decideApproval(input: { approvalId: string; choiceId: string }) {
    this.decided.push({ approvalId: input.approvalId, choiceId: input.choiceId });
  }
  async answerUserInput() {}
  async cancelUserInput() {}
  async clarifyUserInput() {}
  async listModels() {
    return [];
  }
  titleSettings = { enabled: true, modelId: null as string | null };
  titleError: Error | null = null;
  titleGate: Promise<void> | null = null;
  async getTitleSettings() {
    return { ...this.titleSettings };
  }
  async setTitleSettings(patch: { enabled?: boolean; modelId?: string | null }) {
    if (this.titleGate) {
      await this.titleGate;
    }
    if (this.titleError) {
      const error = this.titleError;
      this.titleError = null;
      throw error;
    }
    this.titleSettings = {
      enabled: patch.enabled ?? this.titleSettings.enabled,
      modelId: patch.modelId !== undefined ? patch.modelId : this.titleSettings.modelId,
    };
    return { ...this.titleSettings };
  }
  sandboxSettings = { disabled: false };
  sandboxError: Error | null = null;
  sandboxGate: Promise<void> | null = null;
  sandboxCalls: (boolean | undefined)[] = [];
  async getSandboxSettings() {
    return { ...this.sandboxSettings };
  }
  async setSandboxSettings(patch: { disabled?: boolean }) {
    this.sandboxCalls.push(patch.disabled);
    if (this.sandboxGate) {
      await this.sandboxGate;
    }
    if (this.sandboxError) {
      const error = this.sandboxError;
      this.sandboxError = null;
      throw error;
    }
    this.sandboxSettings = { disabled: patch.disabled ?? this.sandboxSettings.disabled };
    return { ...this.sandboxSettings };
  }
  yoloSettings = { enabled: false };
  yoloError: Error | null = null;
  yoloGate: Promise<void> | null = null;
  yoloCalls: (boolean | undefined)[] = [];
  async getYoloSettings() {
    return { ...this.yoloSettings };
  }
  async setYoloSettings(patch: { enabled?: boolean }) {
    this.yoloCalls.push(patch.enabled);
    if (this.yoloGate) {
      await this.yoloGate;
    }
    if (this.yoloError) {
      const error = this.yoloError;
      this.yoloError = null;
      throw error;
    }
    this.yoloSettings = { enabled: patch.enabled ?? this.yoloSettings.enabled };
    return { ...this.yoloSettings };
  }
  feedSettings = { catchUp: false };
  feedError: Error | null = null;
  feedGate: Promise<void> | null = null;
  feedCalls: (boolean | undefined)[] = [];
  async getFeedSettings() {
    return { ...this.feedSettings };
  }
  async setFeedSettings(patch: { catchUp?: boolean }) {
    this.feedCalls.push(patch.catchUp);
    if (this.feedGate) {
      await this.feedGate;
    }
    if (this.feedError) {
      const error = this.feedError;
      this.feedError = null;
      throw error;
    }
    this.feedSettings = { catchUp: patch.catchUp ?? this.feedSettings.catchUp };
    return { ...this.feedSettings };
  }
  async setSessionModel() {}
  approvalModes: { sessionId: string; mode: string }[] = [];
  approvalModeFailFor: Set<string> = new Set();
  async setApprovalMode(sessionId: string, mode: string) {
    this.approvalModes.push({ sessionId, mode });
    if (this.approvalModeFailFor.has(sessionId)) {
      throw new Error(`could not set the approval mode for ${sessionId}`);
    }
  }
  async setProjectOrder(cwds: string[]) {
    this.orders.push(cwds);
  }
  async usage() {
    return { since: "2026-09-01T00:00:00.000Z", days: 30, buckets: [], threads: [] };
  }
  async importOmpUsage() {
    return { files: 0, sessions: 0, calls: 0, skipped: 0 };
  }
  async runShellProxy(sessionId: string, command: string) {
    this.actions.push(`shell-proxy:${command}`);
    return {
      id: `run-${this.actions.length}`,
      sessionId,
      command,
      exitCode: 0,
      output: `ran ${command}`,
      truncated: false,
      durationMs: 12,
      at: "2026-09-11T22:00:00.000Z",
    };
  }
  compactNoop = false;
  async compact() {
    this.actions.push("compact");
    return { noop: this.compactNoop, reason: this.compactNoop ? "no_compactable_history" : null };
  }
  async runShell(sessionId: string, command: string) {
    this.actions.push(`shell:${sessionId}:${command}`);
  }
  async forkSession() {
    this.actions.push("fork");
    return { ...SESSION, sessionId: "s2", title: "Probe (fork)" };
  }
  async sideChat(sessionId: string) {
    this.actions.push(`side:${sessionId}`);
    return { ...SESSION, sessionId: "s3", title: "Probe (side chat)", sideOf: sessionId };
  }
  async listSkills(_cwd: string, sessionId?: string) {
    this.skillSessions.push(sessionId);
    return { skills: this.skills, error: null };
  }
  async skillBody(_cwd: string, skillId: string) {
    return `Instructions for ${skillId}.`;
  }
  async openFolder() {}
  skillSessions: (string | undefined)[] = [];
  efforts: string[] = [];
  goalError: Error | null = null;
  async setReasoningEffort(sessionId: string, effort: string) {
    this.efforts.push(`${sessionId}:${effort}`);
  }
  async goal(sessionId: string, action: string, objective?: string) {
    if (this.goalError) {
      throw this.goalError;
    }
    this.actions.push(`goal:${sessionId}:${action}${objective ? `:${objective}` : ""}`);
    return { turnId: action === "set" || action === "resume" ? "t-goal" : null };
  }
  async subagent(sessionId: string, action: string, subagentId: string, options?: { body?: string }) {
    this.actions.push(`subagent:${sessionId}:${action}:${subagentId}${options?.body ? `:${options.body}` : ""}`);
  }
  async task(sessionId: string, action: string, taskId?: string) {
    this.actions.push(`task:${sessionId}:${action}${taskId ? `:${taskId}` : ""}`);
  }
  workflowError: Error | null = null;
  async workflow(sessionId: string, action: string, workflowRunId: string, child?: { childId: string; attempt: number }) {
    if (this.workflowError) {
      throw this.workflowError;
    }
    this.actions.push(`workflow:${sessionId}:${action}:${workflowRunId}${child ? `:${child.childId}@${child.attempt}` : ""}`);
  }
  async readOutput(_sessionId: string, _itemId: string, _outputRef: string, offset = 0) {
    return { content: offset === 0 ? "first " : "second", encoding: "utf8", mediaType: "text/plain", offsetBytes: offset, byteLen: 6, eof: offset > 0 };
  }
  plan: import("../src/types.js").PlanUsage | null = null;
  planByAccount: Record<string, import("../src/types.js").PlanUsage> = {};
  async planUsage() {
    return { usage: this.plan, byAccount: this.planByAccount };
  }
  accounts: import("../src/types.js").AccountView[] = [];
  accountCalls: { kind: "create" | "rename" | "remove" | "default"; id?: string; cwd?: string; accountId?: string | null; name?: string }[] = [];
  async listAccounts() {
    return [...this.accounts];
  }
  async createAccount(id: string, options?: { name?: string; seedFromDefault?: boolean }) {
    this.accountCalls.push({ kind: "create", id, name: options?.name });
    this.accounts.push({ id, name: options?.name ?? id, hasLogin: false, email: null, lastUsedAt: null });
    return { id, name: options?.name ?? id };
  }
  async renameAccount(id: string, name: string) {
    this.accountCalls.push({ kind: "rename", id, name });
    const account = this.accounts.find((a) => a.id === id);
    if (account) {
      account.name = name;
    }
  }
  async removeAccount(id: string) {
    this.accountCalls.push({ kind: "remove", id });
    this.accounts = this.accounts.filter((a) => a.id !== id);
  }
  setProjectDefaultAccountError: Error | null = null;
  async setProjectDefaultAccount(cwd: string, accountId: string | null) {
    this.accountCalls.push({ kind: "default", cwd, accountId });
    if (this.setProjectDefaultAccountError) {
      const error = this.setProjectDefaultAccountError;
      this.setProjectDefaultAccountError = null;
      throw error;
    }
  }
  metaApiKeyInherited = false;
  async accountsHealth() {
    return { metaApiKeyInherited: this.metaApiKeyInherited };
  }
  loginAccountResult: { url: string; code: string | null } | { fallback: string } = {
    url: "https://auth.meta.com/oauth/device/?code=TEST-CODE",
    code: "TEST-CODE",
  };
  loginAccountCalls: string[] = [];
  async loginAccount(id: string) {
    this.loginAccountCalls.push(id);
    return this.loginAccountResult;
  }
  writes: { path: string; content: string; baseMtimeMs: number | null }[] = [];
  writeError: Error | null = null;
  async listFiles(_cwd: string, path: string) {
    return { path, entries: [], truncated: false };
  }
  async readFile(_cwd: string, path: string) {
    return { path, name: path, size: 3, mtimeMs: 100, kind: "markdown" as const, mediaType: "text/markdown", content: "# a", truncated: false };
  }
  async writeFile(_cwd: string, path: string, content: string, baseMtimeMs: number | null) {
    if (this.writeError) {
      const error = this.writeError;
      this.writeError = null;
      throw error;
    }
    this.writes.push({ path, content, baseMtimeMs });
    return { path, size: content.length, mtimeMs: 200 };
  }
  async searchFiles() {
    return [];
  }
  async openFileExternally() {}
  async revertChanges() {
    return { path: "", outcome: "reverted" as const };
  }
  fileUrl(cwd: string, path: string) {
    return `/raw?${cwd}&${path}`;
  }
  subscribe(handler: EventHandler) {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
}

function platform(hash = ""): Platform & { hash: string } {
  const state = {
    hash,
    loadPrefs: () => null,
    savePrefs: () => {},
    readHash: () => state.hash,
    writeHash: (next: string) => {
      state.hash = next;
    },
    onHashChange: () => () => {},
    now: () => Date.now(),
    schedule: (fn: () => void) => setTimeout(fn, 0),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    // Nothing is watching a test, which is also what lets one exercise what gets announced.
    focused: () => false,
  };
  return state;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

// Drains pending microtasks without ever crossing a real timer tick. The fake platform's `schedule`
// collapses every real delay to 0ms, toast auto-dismiss included, so `settle()` would let a toast this
// test wants to inspect land and expire before either check runs. This only waits long enough for a
// fire-and-forget chain (like `pushThreadModes`) to finish adding it.
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

async function started(client: FakeClient, hash = "#/t/s1") {
  const controller = new HeliconController(client, platform(hash));
  const stop = controller.start();
  await settle();
  await settle();
  return { controller, stop };
}

describe("HeliconController", () => {
  it("boots, lists threads and opens the one in the URL", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const state = controller.store.get();
    assert.equal(state.boot, "ready");
    assert.deepEqual(state.route, { kind: "thread", sessionId: "s1" });
    assert.equal(state.threads["s1"]?.load, "ready");
    assert.equal(buildTurns(state.threads["s1"]!.fold).length, 3);
    stop();
  });

  it("loads the thread-title switch at boot and flips it with rollback", async () => {
    const client = new FakeClient();
    client.titleSettings = { enabled: false, modelId: "m1" };
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().titleSettings, { enabled: false, modelId: "m1" });

    await controller.setTitleEnabled(true);
    assert.deepEqual(controller.store.get().titleSettings, { enabled: true, modelId: "m1" });

    await controller.setTitleModel(null);
    assert.deepEqual(controller.store.get().titleSettings, { enabled: true, modelId: null });

    client.titleError = new Error("daemon away");
    await controller.setTitleEnabled(false);
    assert.deepEqual(controller.store.get().titleSettings, { enabled: true, modelId: null }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change thread titles/);
    stop();
  });

  it("loads the sandbox switch at boot and flips it with rollback", async () => {
    const client = new FakeClient();
    client.sandboxSettings = { disabled: true };
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().sandboxSettings, { disabled: true });

    await controller.setSandboxDisabled(false);
    assert.deepEqual(controller.store.get().sandboxSettings, { disabled: false });

    client.sandboxError = new Error("daemon away");
    await controller.setSandboxDisabled(true);
    assert.deepEqual(controller.store.get().sandboxSettings, { disabled: false }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change the sandbox setting/);
    stop();
  });

  it("sends rapid sandbox flips to the server in order", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      let release!: () => void;
      client.sandboxGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = controller.setSandboxDisabled(true);
      const second = controller.setSandboxDisabled(false);
      try {
        await new Promise((r) => setTimeout(r, 0));
        assert.deepEqual(client.sandboxCalls, [true], "the second PATCH waits for the first");
      } finally {
        release();
      }
      await Promise.all([first, second]);
      assert.deepEqual(client.sandboxCalls, [true, false]);
      assert.deepEqual(client.sandboxSettings, { disabled: false }, "the server ends at the latest flip");
      assert.deepEqual(controller.store.get().sandboxSettings, { disabled: false });
    } finally {
      stop();
    }
  });

  it("loads the catch-up switch at boot, off unless the server says otherwise, and flips it with rollback", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().feedSettings, { catchUp: false });

    let release!: () => void;
    client.feedGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flip = controller.setCatchUp(true);
    assert.deepEqual(controller.store.get().feedSettings, { catchUp: true }, "the switch moves before the server answers");
    client.feedGate = null;
    release();
    await flip;
    assert.deepEqual(client.feedCalls, [true]);
    assert.deepEqual(controller.store.get().feedSettings, { catchUp: true });

    client.feedError = new Error("daemon away");
    await controller.setCatchUp(false);
    assert.deepEqual(controller.store.get().feedSettings, { catchUp: true }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change the live updates setting/);
    stop();
  });

  it("loads a catch-up switch the server already has on", async () => {
    const client = new FakeClient();
    client.feedSettings = { catchUp: true };
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().feedSettings, { catchUp: true });
    stop();
  });

  it("sends rapid catch-up flips to the server in order", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      let release!: () => void;
      client.feedGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = controller.setCatchUp(true);
      const second = controller.setCatchUp(false);
      try {
        await new Promise((r) => setTimeout(r, 0));
        assert.deepEqual(client.feedCalls, [true], "the second PATCH waits for the first");
      } finally {
        release();
      }
      await Promise.all([first, second]);
      assert.deepEqual(client.feedCalls, [true, false]);
      assert.deepEqual(client.feedSettings, { catchUp: false }, "the server ends at the latest flip");
      assert.deepEqual(controller.store.get().feedSettings, { catchUp: false });
    } finally {
      stop();
    }
  });

  it("rolls the catch-up switch back to what the server has when two overlapping flips both fail", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      client.setFeedSettings = async (patch) => {
        client.feedCalls.push(patch.catchUp);
        await gate;
        throw new Error("daemon away");
      };
      const first = controller.setCatchUp(true);
      // Clicked again before the first has failed: what the switch shows by now is only a guess.
      const second = controller.setCatchUp(false);
      release();
      await Promise.all([first, second]);
      assert.deepEqual(client.feedCalls, [true, false]);
      assert.deepEqual(client.feedSettings, { catchUp: false }, "the server took neither");
      assert.deepEqual(controller.store.get().feedSettings, { catchUp: false }, "so the switch shows what it has, not the first flip's guess");
    } finally {
      stop();
    }
  });

  it("clears the host error and toasts when hosts restart for the sandbox switch", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.handler?.({ type: "host", key: "k", state: "failed", message: "boom" });
    assert.equal(controller.store.get().hostError, "boom");
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    assert.equal(controller.store.get().hostError, null);
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Muse hosts restarted/);
    stop();
  });

  it("discards a stale title switch that resolves after a newer one", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    let release!: () => void;
    client.titleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = controller.setTitleEnabled(false);
    client.titleGate = null;
    await controller.setTitleEnabled(true);
    release();
    await first;
    assert.deepEqual(controller.store.get().titleSettings, { enabled: true, modelId: null });
    stop();
  });

  it("loads the YOLO switch at boot and flips it with rollback", async () => {
    const client = new FakeClient();
    client.yoloSettings = { enabled: true };
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: true });
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll", "boot under YOLO joins the open thread");
    assert.ok(
      client.approvalModes.some((p) => p.sessionId === "s1" && p.mode === "allowAll"),
      "the join is pushed to Muse",
    );

    await controller.setYoloEnabled(false);
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });

    client.yoloError = new Error("daemon away");
    await controller.setYoloEnabled(true);
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change the YOLO setting/);
    stop();
  });

  it("sends rapid YOLO flips to the server in order", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      let release!: () => void;
      client.yoloGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = controller.setYoloEnabled(true);
      const second = controller.setYoloEnabled(false);
      try {
        await new Promise((r) => setTimeout(r, 0));
        assert.deepEqual(client.yoloCalls, [true], "the second PATCH waits for the first");
      } finally {
        release();
      }
      await Promise.all([first, second]);
      assert.deepEqual(client.yoloCalls, [true, false]);
      assert.deepEqual(client.yoloSettings, { enabled: false }, "the server ends at the latest flip");
      assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });
    } finally {
      stop();
    }
  });

  it("moves open threads to full access on YOLO and restores them after", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setMode("denyUnmatched");
    controller.setPrefs({ defaultMode: "promptUnmatched" });
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched");

    await controller.setYoloEnabled(true);
    const on = controller.store.get();
    assert.equal(on.prefs.defaultMode, "allowAll");
    assert.equal(on.threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    assert.equal(controller.bypassArmed("s1"), true);

    await controller.setYoloEnabled(false);
    const off = controller.store.get();
    assert.equal(off.prefs.defaultMode, "promptUnmatched", "the default from before arming comes back");
    assert.equal(off.threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "and so does the thread's own mode");
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "denyUnmatched" });
    assert.equal(controller.bypassArmed("s1"), false);
    stop();
  });

  it("ignores a YOLO flip to the value it already has", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setMode("denyUnmatched");

    await controller.setYoloEnabled(false);
    assert.deepEqual(client.yoloCalls, [], "no PATCH leaves for a no-op flip");
    assert.equal(controller.store.get().prefs.defaultMode, "denyUnmatched");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched");

    await controller.setYoloEnabled(true);
    await controller.setYoloEnabled(true);
    assert.deepEqual(client.yoloCalls, [true], "the double-click enable PATCHes once");
    stop();
  });

  it("refuses permission changes while YOLO is on", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setYoloEnabled(true);
    const pushes = client.approvalModes.length;

    await controller.setMode("onRequest");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.equal(client.approvalModes.length, pushes, "no mode push leaves while YOLO owns the modes");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO is on/);
    stop();
  });

  it("refuses to change the sandbox switch while YOLO is on, with a toast", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setYoloEnabled(true);

    await controller.setSandboxDisabled(false);
    assert.deepEqual(client.sandboxCalls, [], "no PATCH leaves while YOLO owns the sandbox posture");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO mode is on/);
    stop();
  });

  it("joins a thread opened under YOLO to full access", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client, "#/");
    await controller.setYoloEnabled(true);
    await controller.loadThread("s1");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    stop();
  });

  it("stays silent about approvals a bypass answers on its own", async () => {
    const client = new FakeClient();
    const shown: string[] = [];
    const { controller, stop } = await started(client);
    controller.attachNotifier({
      permission: async () => "granted",
      request: async () => "granted",
      show: async (note) => {
        shown.push(note.tag);
      },
    });
    controller.setPrefs({ notifications: true });
    await controller.setYoloEnabled(true);
    client.handler?.({
      type: "session-status",
      sessionId: "s1",
      live: {
        activeTurnId: null,
        turnStartedAt: null,
        pendingApprovals: 1,
        pendingInputs: 0,
        lastTerminal: null,
        lastError: null,
      } as never,
    });
    await settle();
    assert.deepEqual(shown, [], "an armed thread answers, so nobody is needed");
    stop();
  });

  it("clears the host error and toasts when hosts restart for the YOLO switch", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.handler?.({ type: "host", key: "k", state: "failed", message: "boom" });
    assert.equal(controller.store.get().hostError, "boom");
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    assert.equal(controller.store.get().hostError, null);
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Muse hosts restarted/);
    stop();
  });

  it("waits for the YOLO patch to land before pushing any thread's approval mode", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    let release!: () => void;
    client.yoloGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flip = controller.setYoloEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(client.approvalModes.length, 0, "no mode push leaves before the PATCH resolves");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "onRequest", "the thread's own mode is untouched until then");
    release();
    await flip;
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    stop();
  });

  it("pushes no approval mode when the YOLO patch itself fails", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setMode("denyUnmatched");
    const pushes = client.approvalModes.length;
    client.yoloError = new Error("daemon away");
    await controller.setYoloEnabled(true);
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "the thread's mode never moved");
    assert.equal(client.approvalModes.length, pushes, "no mode push leaves for a flip that never landed");
    stop();
  });

  it("clears the pre-YOLO snapshot when the PATCH fails, so a later enable captures a fresh one", async () => {
    const client = new FakeClient();
    let saved: unknown = null;
    const shared: Platform & { hash: string } = {
      hash: "#/t/s1",
      loadPrefs: () => null,
      savePrefs: (prefs) => {
        saved = prefs;
      },
      readHash: () => shared.hash,
      writeHash: (next) => {
        shared.hash = next;
      },
      onHashChange: () => () => {},
      now: () => Date.now(),
      schedule: (fn: () => void) => setTimeout(fn, 0),
      cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      focused: () => false,
    };

    const controller = new HeliconController(client, shared);
    const stop = controller.start();
    await settle();
    await settle();

    await controller.setMode("denyUnmatched");
    client.yoloError = new Error("daemon away");
    await controller.setYoloEnabled(true);
    await settle();
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });
    assert.equal(
      (saved as { preYolo: unknown } | null)?.preYolo ?? null,
      null,
      "the failed enable's snapshot never sticks around in prefs",
    );

    // A different mode than the failed attempt saw, so a stale snapshot from that attempt would
    // be caught by this asserting the wrong value instead of passing by coincidence.
    await controller.setMode("promptUnmatched");
    await controller.setYoloEnabled(true);
    await settle();
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: true });
    assert.equal(
      (saved as { preYolo: { defaultMode: string } | null } | null)?.preYolo?.defaultMode,
      "promptUnmatched",
      "a following successful enable captures a fresh snapshot",
    );

    stop();
  });

  it("starts new threads at full access under YOLO, even when the local default was never touched", async () => {
    const client = new FakeClient();
    // Boot converges the open thread through convergeThread, not applyYoloApprovals, so the default
    // mode itself is left exactly as it starts: the case a new thread must not trust.
    client.yoloSettings = { enabled: true };
    const { controller, stop } = await started(client, "");
    assert.equal(controller.store.get().prefs.defaultMode, "onRequest");
    controller.newThread();
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.approvalMode, "allowAll");
    assert.equal(controller.store.get().threads[SESSION.sessionId]?.fold.meta.approvalMode, "allowAll");
    stop();
  });

  it("reloads YOLO and sandbox settings after hosts restart, and restores this client when YOLO went off elsewhere", async () => {
    const client = new FakeClient();
    client.yoloSettings = { enabled: true };
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll", "boot under YOLO joins the open thread");

    // Another client turned YOLO off and the sandbox on; this one never called setYoloEnabled itself,
    // so a restart is the only way it learns either happened.
    client.yoloSettings = { enabled: false };
    client.sandboxSettings = { disabled: true };
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    await settle();

    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });
    assert.deepEqual(controller.store.get().sandboxSettings, { disabled: true });
    assert.equal(
      controller.store.get().threads["s1"]?.fold.meta.approvalMode,
      "onRequest",
      "this client stops auto approving too, with no local snapshot to restore from",
    );
    stop();
  });

  it("keeps its pre-YOLO snapshot across a reload, so switching YOLO off afterwards still restores the real modes", async () => {
    const client = new FakeClient();
    let saved: unknown = null;
    const shared: Platform & { hash: string } = {
      hash: "#/t/s1",
      loadPrefs: () => saved,
      savePrefs: (prefs) => {
        saved = prefs;
      },
      readHash: () => shared.hash,
      writeHash: (next) => {
        shared.hash = next;
      },
      onHashChange: () => () => {},
      now: () => Date.now(),
      schedule: (fn: () => void) => setTimeout(fn, 0),
      cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      focused: () => false,
    };

    const first = new HeliconController(client, shared);
    const stopFirst = first.start();
    await settle();
    await settle();
    await first.setMode("denyUnmatched");
    await first.setYoloEnabled(true);
    await settle();
    stopFirst();

    const second = new HeliconController(client, shared);
    const stopSecond = second.start();
    await settle();
    await settle();
    await second.setYoloEnabled(false);
    assert.equal(second.store.get().prefs.defaultMode, "denyUnmatched", "the real default survives the reload");
    assert.equal(second.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "and so does the thread's own mode");
    stopSecond();
  });

  it("keeps the failed-thread toast singular for exactly one thread", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setYoloEnabled(true);
    client.approvalModeFailFor = new Set(["s1"]);
    await controller.setYoloEnabled(false);
    // The mode push is fire-and-forget from setYoloEnabled's own promise, so the toast it ends in
    // lands a tick later than the flip itself.
    await flushMicrotasks();
    assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /^1 thread kept full access\.$/);
    stop();
  });

  it("pluralizes the failed-thread toast for more than one thread", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.loadThread("s2");
    await controller.setYoloEnabled(true);
    client.approvalModeFailFor = new Set(["s1", "s2"]);
    await controller.setYoloEnabled(false);
    await flushMicrotasks();
    assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /^2 threads kept full access\.$/);
    stop();
  });

  it("refuses /permissions full while YOLO is on, without opening the confirm dialog", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setYoloEnabled(true);
    await controller.send("/permissions full");
    assert.equal(controller.store.get().picker, null, "the confirm dialog never opens");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO is on/);
    stop();
  });

  it("still announces a rule-only approval even while a bypass is armed", async () => {
    const client = new FakeClient();
    const shown: string[] = [];
    const { controller, stop } = await started(client);
    controller.attachNotifier({
      permission: async () => "granted",
      request: async () => "granted",
      show: async (note) => {
        shown.push(note.tag);
      },
    });
    controller.setPrefs({ notifications: true });
    await controller.setYoloEnabled(true);
    // A rule-only choice gives autoAllow nothing to click, so it stays pending for the user.
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "approval/requested",
      params: {
        approvalId: "a1",
        sessionId: "s1",
        availableChoices: [{ choiceId: "c1", label: "Always allow", decision: "approved", scope: "rule", rulePreview: "echo *" }],
        subject: { kind: "shell" },
      },
      at: 1,
    });
    await settle();
    client.handler?.({
      type: "session-status",
      sessionId: "s1",
      live: {
        activeTurnId: null,
        turnStartedAt: null,
        pendingApprovals: 1,
        pendingInputs: 0,
        lastTerminal: null,
        lastError: null,
      } as never,
    });
    await settle();
    assert.deepEqual(shown, ["approval:s1"], "a rule-only approval still needs the user, even armed");
    stop();
  });

  it("keeps stream events that arrive while a thread is still loading", async () => {
    const client = new FakeClient();
    let resolve: (value: TranscriptLoad) => void = () => {};
    client.transcript = () => new Promise((r) => (resolve = r));
    const { controller, stop } = await started(client);
    client.handler?.({ type: "msp", sessionId: "s1", method: "turn/started", params: { sessionId: "s1", turnId: "live-1" }, at: 1 });
    resolve(load());
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.fold.activeTurnId, "live-1");
    stop();
  });

  it("coalesces overlapping thread loads instead of losing buffered events", async () => {
    // A second load while one is in flight used to orphan the first load's buffer: every event
    // that streamed into it was dropped, and the thread never showed them (#32).
    const client = new FakeClient();
    let loads = 0;
    let resolve!: (value: TranscriptLoad) => void;
    client.transcript = () => {
      loads += 1;
      return new Promise<TranscriptLoad>((r) => (resolve = r));
    };
    const { controller, stop } = await started(client);
    client.handler?.({ type: "msp", sessionId: "s1", method: "turn/started", params: { sessionId: "s1", turnId: "live-1" }, at: 1 });
    const second = controller.loadThread("s1");
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "item/started",
      params: { sessionId: "s1", item: { itemId: "i1", kind: "agentMessage", status: "inProgress", revision: 1 } },
      at: 2,
    });
    resolve(load());
    await settle();
    await settle();
    await second;
    assert.equal(loads, 1, "overlapping loads share one transcript read");
    const fold = controller.store.get().threads["s1"]?.fold;
    assert.equal(fold?.activeTurnId, "live-1", "events buffered before the overlap still land");
    assert.ok(fold?.items.get("i1"), "events buffered during the overlap still land");
    stop();
  });

  it("echoes a sent prompt, marks the turn running, then drops the echo", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("Add a README section"), true);
    let fold = controller.store.get().threads["s1"]!.fold;
    assert.equal(fold.activeTurnId, "t9");
    assert.equal(fold.echoes[0]?.turnId, "t9");
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "item/completed",
      params: { sessionId: "s1", item: { itemId: "u9", kind: "userMessage", status: "completed", revision: 1, turnId: "t9", text: "Add a README section" } },
      at: 2,
    });
    await settle();
    fold = controller.store.get().threads["s1"]!.fold;
    assert.equal(fold.echoes.length, 0);
    stop();
  });

  it("shows a prompt once when it is acknowledged while its thread reloads (#55)", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    let ack!: (value: { turnId: string | null; disposition: string | null }) => void;
    client.sendResult = () => new Promise((resolve) => (ack = resolve));
    const sending = controller.send("Add a README section");
    await settle();
    assert.equal(controller.store.get().threads["s1"]!.fold.echoes.length, 1);

    // The reload starts while the prompt is still unacknowledged, and history already holds it when it lands.
    let resolveLoad!: (value: TranscriptLoad) => void;
    client.transcript = () => new Promise((resolve) => (resolveLoad = resolve));
    const reloading = controller.loadThread("s1");
    await settle();
    ack({ turnId: "t9", disposition: "started" });
    await sending;
    resolveLoad(
      load({
        msp: { status: "running", activeTurnId: "t9", modelId: null, approvalMode: null, workspaceRoot: null, turnCount: 4 },
        events: [
          ...historyEvents,
          { at: 2, method: "turn/started", params: { sessionId: "s1", turnId: "t9" } },
          {
            at: 3,
            method: "item/completed",
            params: { sessionId: "s1", item: { itemId: "u9", kind: "userMessage", status: "completed", revision: 1, turnId: "t9", text: "Add a README section" } },
          },
        ],
      }),
    );
    await reloading;
    await settle();
    const fold = controller.store.get().threads["s1"]!.fold;
    assert.equal(fold.items.get("u9")?.text, "Add a README section");
    assert.equal(fold.echoes.length, 0, "the history holds the prompt, so its local copy is gone");
    stop();
  });

  it("shows a prompt once when history misses it and the live stream brings it during the reload (#55)", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    let ack!: (value: { turnId: string | null; disposition: string | null }) => void;
    client.sendResult = () => new Promise((resolve) => (ack = resolve));
    const sending = controller.send("Add a README section");
    await settle();

    // History is read before Muse records the prompt; the prompt itself streams in while the load is out.
    let resolveLoad!: (value: TranscriptLoad) => void;
    client.transcript = () => new Promise((resolve) => (resolveLoad = resolve));
    const reloading = controller.loadThread("s1");
    await settle();
    ack({ turnId: "t9", disposition: "started" });
    await sending;
    client.handler?.({ type: "msp", sessionId: "s1", method: "turn/started", params: { sessionId: "s1", turnId: "t9" }, at: 2 });
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "item/completed",
      params: { sessionId: "s1", item: { itemId: "u9", kind: "userMessage", status: "completed", revision: 1, turnId: "t9", text: "Add a README section" } },
      at: 3,
    });
    resolveLoad(load({ msp: { status: "running", activeTurnId: "t9", modelId: null, approvalMode: null, workspaceRoot: null, turnCount: 4 } }));
    await reloading;
    await settle();
    const fold = controller.store.get().threads["s1"]!.fold;
    assert.equal(fold.items.get("u9")?.text, "Add a README section");
    assert.equal(fold.echoes.length, 0, "the streamed prompt replaces its local copy");
    stop();
  });

  it("queues follow-ups while a turn runs and steers on request", async () => {
    const client = new FakeClient();
    client.transcript = async () => load({ msp: { status: "running", activeTurnId: "t1", modelId: null, approvalMode: null, workspaceRoot: null, turnCount: 3 } });
    client.sendResult = async () => ({ turnId: "t2", disposition: "queued" });
    const { controller, stop } = await started(client);
    await controller.send("next thing");
    assert.equal(client.sent.at(-1)?.ifBusy, "queue");
    assert.equal(controller.store.get().threads["s1"]!.fold.echoes[0]?.disposition, "queued");
    client.sendResult = async () => ({ turnId: "t1", disposition: "steered" });
    await controller.send("actually use tabs", { steer: true });
    assert.equal(client.sent.at(-1)?.ifBusy, "steer");
    stop();
  });

  it("turns a double-pressed Enter into one send, and the duplicate still reports sent", async () => {
    const client = new FakeClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop } = await started(client);
    // Both arrive before either is acknowledged, the way two Enters land before the composer clears.
    const first = controller.send("check the vault");
    const second = controller.send("check the vault");
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(client.sent.length, 1);
    assert.equal(controller.store.get().threads["s1"]!.fold.echoes.length, 1);
    stop();
  });

  it("lets the same prompt go again once the first send settles", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("check the vault"), true);
    assert.equal(await controller.send("check the vault"), true);
    assert.equal(client.sent.length, 2);
    stop();
  });

  it("lets a different prompt go while one is still in flight", async () => {
    const client = new FakeClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop } = await started(client);
    const first = controller.send("check the vault");
    const second = controller.send("and the firewall rules");
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(client.sent.length, 2);
    stop();
  });

  it("releases the guard when the first send fails, so a retry goes", async () => {
    const client = new FakeClient();
    client.sendResult = async () => {
      throw new HeliconError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("check the vault"), false);
    client.sendResult = async () => ({ turnId: "t9", disposition: "started" });
    assert.equal(await controller.send("check the vault"), true);
    assert.equal(client.sent.length, 2);
    stop();
  });

  it("sends identical text with identical files once, but new files go", async () => {
    const client = new FakeClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop } = await started(client);
    const shot = { name: "shot.png", mediaType: "image/png", base64: "AAAA" };
    const other = { name: "other.png", mediaType: "image/png", base64: "BBBB" };
    const first = controller.send("look at this", { attachments: [shot] });
    const duplicate = controller.send("look at this", { attachments: [{ ...shot }] });
    const changed = controller.send("look at this", { attachments: [other] });
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepEqual(await Promise.all([first, duplicate, changed]), [true, true, true]);
    assert.equal(client.sent.length, 2);
    stop();
  });

  it("reports a failed send and hands the text back", async () => {
    const client = new FakeClient();
    client.sendResult = async () => {
      throw new HeliconError("input too large", 409, "inputTooLarge");
    };
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("x".repeat(10)), false);
    const state = controller.store.get();
    assert.equal(state.threads["s1"]!.fold.echoes.length, 0);
    assert.equal(state.toasts.at(-1)?.title, "Message not sent");
    stop();
  });

  it("gives a failed first prompt to the new thread's composer", async () => {
    const client = new FakeClient();
    client.sendResult = async () => {
      throw new HeliconError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop } = await started(client, "");
    // The new-thread composer unmounts on navigation, so it must not take the text back itself.
    assert.equal(await controller.send("Write the tests"), true);
    const state = controller.store.get();
    assert.deepEqual(state.route, { kind: "thread", sessionId: "s1" });
    assert.equal(state.toasts.at(-1)?.title, "Message not sent");
    assert.equal(controller.takeDraftHandoff("other"), null);
    assert.deepEqual(controller.takeDraftHandoff("s1"), { text: "Write the tests" });
    assert.equal(controller.store.get().draftHandoff, null);
    stop();
  });

  it("hands the files back with the prompt when a first send fails", async () => {
    const client = new FakeClient();
    client.sendResult = async () => {
      throw new HeliconError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop } = await started(client, "");
    const attachments = [{ name: "shot.png", mediaType: "image/png", base64: "AAAA" }];
    const previews = [{ name: "shot.png", mediaType: "image/png", kind: "image" as const, url: "blob:shot" }];
    assert.equal(await controller.send("Look at this", { attachments, previews }), true);
    // Text alone would hand back a draft asking about an image that is no longer attached to it.
    assert.deepEqual(controller.takeDraftHandoff("s1"), { text: "Look at this", attachments, previews });
    stop();
  });

  it("answers approvals itself once a thread is armed, taking allow-once over a rule", async () => {
    const client = new FakeClient();
    const request = {
      approvalId: "ap1",
      sessionId: "s1",
      currentRequirementId: null,
      subject: { kind: "command", command: "git rebase --continue" },
      availableChoices: [
        { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview: "git rebase *" },
        { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "no", label: "Reject", decision: "denied", scope: "once" },
      ],
    };
    client.transcript = async () => load({ pending: { approvals: [request], userInputs: [] } });
    const { controller, stop } = await started(client);
    // Nothing is armed yet, so the request waits for the user.
    assert.equal(Object.keys(controller.store.get().threads["s1"]!.fold.approvals).length, 1);
    assert.equal(client.decided.length, 0);

    controller.setThreadBypass("s1", true);
    await settle();
    // The remembered choice would write a standing rule into Muse's own config, so it takes the plain one.
    assert.deepEqual(client.decided, [{ approvalId: "ap1", choiceId: "once" }]);
    const fold = controller.store.get().threads["s1"]!.fold;
    assert.equal(fold.approvals["ap1"], undefined);
    assert.equal(fold.resolved["ap1"]?.resolvedBy, "bypass");
    stop();
  });

  it("records which stage of a piped command it answered", async () => {
    const client = new FakeClient();
    const request = {
      approvalId: "ap2",
      sessionId: "s1",
      currentRequirementId: { approvalId: "ap2", sourceIndex: 1 },
      subject: { kind: "command", command: "cat a | rm b" },
      availableChoices: [{ choiceId: "once", label: "Allow once", decision: "approved", scope: "once" }],
    };
    client.transcript = async () => load({ pending: { approvals: [request], userInputs: [] } });
    const { controller, stop } = await started(client);
    controller.setThreadBypass("s1", true);
    await settle();
    assert.deepEqual(client.decided, [{ approvalId: "ap2", choiceId: "once" }]);
    // A later stage of the same command can still ask; a redelivered stage 1 stays answered.
    assert.equal(controller.store.get().threads["s1"]!.fold.resolved["ap2"]?.stage, 1);
    stop();
  });

  it("leaves an approval alone when the only way to allow it writes a rule", async () => {
    const client = new FakeClient();
    const request = {
      approvalId: "ap2",
      sessionId: "s1",
      currentRequirementId: null,
      subject: { kind: "command", command: "rm -rf /tmp/scratch" },
      availableChoices: [
        { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview: "rm *" },
        { choiceId: "no", label: "Reject", decision: "denied", scope: "once" },
      ],
    };
    client.transcript = async () => load({ pending: { approvals: [request], userInputs: [] } });
    const { controller, stop } = await started(client);
    controller.setThreadBypass("s1", true);
    await settle();
    // That rule would outlive the bypass that wrote it, which is the one thing it promises not to do.
    assert.deepEqual(client.decided, []);
    assert.equal(Object.keys(controller.store.get().threads["s1"]!.fold.approvals).length, 1);
    stop();
  });

  it("keeps closed dock cards out until the thread brings them back", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const hidden = () => controller.store.get().prefs.hiddenCards;
    assert.deepEqual(hidden(), []);
    controller.setCardHidden("plan:s1", true);
    controller.setCardHidden("goal:s1", true);
    controller.setCardHidden("plan:s2", true);
    controller.setCardHidden("plan:s1", true);
    assert.deepEqual(hidden(), ["plan:s1", "goal:s1", "plan:s2"]);
    // Bringing one thread's cards back leaves another thread's alone.
    controller.showThreadCards("s1");
    assert.deepEqual(hidden(), ["plan:s2"]);
    controller.setCardHidden("plan:s2", false);
    assert.deepEqual(hidden(), []);
    stop();
  });

  it("remembers which dock cards a thread had folded away", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const collapsed = () => controller.store.get().prefs.collapsedCards;
    // Open by default, so a thread nobody has touched costs nothing to remember.
    assert.deepEqual(collapsed(), []);

    controller.setCardOpen("goal:s1", false);
    assert.deepEqual(collapsed(), ["goal:s1"]);

    // Another thread's card is its own business.
    controller.setCardOpen("goal:s2", false);
    assert.deepEqual(collapsed(), ["goal:s1", "goal:s2"]);

    // Opening one again drops it rather than recording a second state for it.
    controller.setCardOpen("goal:s1", true);
    assert.deepEqual(collapsed(), ["goal:s2"]);

    // Closing one that is already closed leaves the list alone.
    controller.setCardOpen("goal:s2", false);
    assert.deepEqual(collapsed(), ["goal:s2"]);
    stop();
  });

  it("announces the edges of what a thread is doing, not the state it is sitting in", async () => {
    const client = new FakeClient();
    const shown: string[] = [];
    const { controller, stop } = await started(client);
    controller.attachNotifier({
      permission: async () => "granted",
      request: async () => "granted",
      show: async (note) => {
        shown.push(note.tag);
      },
    });
    controller.setPrefs({ notifications: true });
    const live = (patch: Record<string, unknown>) => ({
      activeTurnId: null,
      turnStartedAt: null,
      pendingApprovals: 0,
      pendingInputs: 0,
      lastTerminal: null,
      lastError: null,
      ...patch,
    });
    const status = async (patch: Record<string, unknown>) => {
      client.handler?.({ type: "session-status", sessionId: "s1", live: live(patch) as never });
      await settle();
    };

    // A request that has just appeared is worth saying.
    await status({ pendingApprovals: 1 });
    assert.deepEqual(shown, ["approval:s1"]);

    // The same request still sitting there is not: it was already announced once.
    await status({ pendingApprovals: 1 });
    assert.deepEqual(shown, ["approval:s1"]);

    // A turn that has just ended is an edge too, and carries whether it failed.
    await status({ activeTurnId: "t1" });
    await status({ lastTerminal: "failed", lastError: "boom" });
    assert.deepEqual(shown, ["approval:s1", "finished:s1"]);

    // A goal going quiet says so; a goal still active says nothing.
    await status({ goal: { objective: "ship", status: "active", percentComplete: 10 } });
    assert.deepEqual(shown, ["approval:s1", "finished:s1"]);
    await status({ goal: { objective: "ship", status: "complete", percentComplete: 100 } });
    assert.deepEqual(shown, ["approval:s1", "finished:s1", "goal:s1"]);
    stop();
  });

  it("marks a read-only thread and refuses to send into it", async () => {
    const client = new FakeClient();
    client.transcript = async () => load({ readOnly: true, readOnlyReason: "session is loaded by another host" });
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().threads["s1"]?.readOnly, true);
    assert.equal(await controller.send("hello"), false);
    assert.equal(client.sent.length, 0);
    stop();
  });

  it("runs slash commands, skills and shell lines instead of sending their text", async () => {
    const client = new FakeClient();
    client.skills = [
      { id: "bundled:plan", name: "plan", displayName: "plan", description: "Plan it.", shortDescription: null, scope: "bundled", activation: "on" },
      { id: "user:secret", name: "secret", displayName: "secret", description: "By hand.", shortDescription: null, scope: "user", activation: "user-invocable-only" },
    ];
    const { controller, stop } = await started(client);
    await controller.loadSkills("/work/app");
    assert.equal(controller.store.get().skills["/work/app"]?.status, "ready");

    assert.equal(await controller.send("/plan tidy the API"), true);
    assert.equal(client.sent.at(-1)?.displayText, "/plan tidy the API", "the transcript shows what was typed");
    assert.match(client.sent.at(-1)?.text ?? "", /read_skill with name "bundled:plan" first, then apply it to: tidy the API$/);
    assert.equal(await controller.send("/secret go"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /<skill-body id="user:secret">\nInstructions for user:secret\.\n<\/skill-body>\n\ngo$/);

    assert.equal(await controller.send("/compact"), true);
    assert.equal(await controller.send("! git status"), true);
    assert.deepEqual(client.actions, ["compact", "shell-proxy:git status"], "Helicon runs `!` itself now");
    client.compactNoop = true;
    assert.equal(await controller.send("/compact"), true);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "Nothing to compact yet");
    assert.equal(controller.store.get().toasts.at(-1)?.detail, "There is no earlier history to summarize.");

    assert.equal(await controller.send("/effort high"), true);
    assert.equal(controller.store.get().prefs.effort, "high");
    assert.equal(await controller.send("/model"), true);
    assert.equal(controller.store.get().picker, "model");
    assert.equal(await controller.send("/permissions full"), true);
    assert.equal(controller.store.get().picker, "confirmFullAccess", "full access still asks first");
    controller.closePicker("permissions");
    assert.equal(controller.store.get().picker, "confirmFullAccess", "a menu closing after the hand-off leaves the dialog open");

    const before = client.sent.length;
    assert.equal(await controller.send("/deploy now"), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "No command named /deploy");
    assert.equal(client.sent.length, before);
    assert.equal(await controller.send("/deploy now", { raw: true }), true);
    assert.equal(client.sent.at(-1)?.text, "/deploy now");
    assert.equal(await controller.send("/usr/bin/node crashes on start"), true, "a path is a prompt, not a command");
    assert.equal(client.sent.at(-1)?.text, "/usr/bin/node crashes on start");
    stop();
  });

  it("waits for a workspace's skills when a skill is sent before they load", async () => {
    const client = new FakeClient();
    client.skills = [
      { id: "bundled:git", name: "git", displayName: "git", description: "Git safety.", shortDescription: null, scope: "bundled", activation: "on" },
    ];
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().skills["/work/app"], undefined);
    assert.equal(await controller.send("/git reply ok"), true);
    assert.equal(client.sent.at(-1)?.displayText, "/git reply ok");
    assert.equal(controller.store.get().skills["/work/app"]?.status, "ready");
    stop();
  });

  it("sets, pauses, resumes and clears goals through Muse's goal commands", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("/goal Ship the release"), true);
    assert.deepEqual(client.actions.at(-1), "goal:s1:set:Ship the release");
    assert.equal(client.sent.length, 0, "no prompt goes to the model: the goal command starts the work");
    assert.equal(await controller.send("/goal pause"), true);
    assert.equal(client.actions.at(-1), "goal:s1:pause");
    assert.equal(await controller.send("/goal Clear"), true, "the verbs are not case-sensitive");
    assert.equal(client.actions.at(-1), "goal:s1:clear");

    assert.equal(await controller.send("/goal"), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "Add the goal after /goal");

    // A paused goal resumes through goal/resume; a blocked one still gets a prompt to keep going.
    assert.equal(await controller.continueGoal("s1", "Ship the release", "paused"), true);
    assert.equal(client.actions.at(-1), "goal:s1:resume");
    assert.equal(await controller.continueGoal("s1", "Ship the release", "blocked"), true);
    assert.equal(client.sent.at(-1)?.displayText, "Keep working on the goal");

    assert.equal(await controller.goalAction("s1", "edit", "Ship 0.11"), true);
    assert.equal(client.actions.at(-1), "goal:s1:edit:Ship 0.11");
    stop();
  });

  it("falls back to asking the model for a goal on a host without goal commands", async () => {
    const client = new FakeClient();
    client.goalError = new HeliconError("no such method", 409, "methodNotFound");
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("/goal Ship the release"), true);
    assert.equal(client.sent.at(-1)?.displayText, "/goal Ship the release");
    assert.match(client.sent.at(-1)?.text ?? "", /create_goal tool\. Objective: Ship the release/);

    client.goalError = new HeliconError("goal is finished", 409, "goalNotPaused");
    assert.equal(await controller.goalAction("s1", "pause"), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not pause the goal");
    stop();
  });

  it("puts the open thread on the chosen effort, and leaves it be on auto", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("/effort low"), true);
    await settle();
    assert.deepEqual(client.efforts, ["s1:low"]);
    controller.setEffort(null);
    await settle();
    assert.deepEqual(client.efforts, ["s1:low"], "auto keeps the thread's own level");
    assert.equal(controller.store.get().prefs.effort, null);
    stop();
  });

  it("controls background tasks, subagents and workflow children", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.taskAction("s1", "background", "item-2"), true);
    assert.equal(await controller.taskAction("s1", "stop", "item-2"), true);
    assert.equal(await controller.taskAction("s1", "stopAll"), true);
    assert.equal(await controller.subagentAction("s1", "sendMessage", "sa1", "use pnpm"), true);
    assert.equal(await controller.workflowAction("s1", "retry", "run-1", { childId: "c1", attempt: 2 }), true);
    assert.deepEqual(client.actions, [
      "task:s1:background:item-2",
      "task:s1:stop:item-2",
      "task:s1:stopAll",
      "subagent:s1:sendMessage:sa1:use pnpm",
      "workflow:s1:retry:run-1:c1@2",
    ]);

    client.workflowError = new HeliconError("stale", 409, "stale_attempt");
    assert.equal(await controller.workflowAction("s1", "skip", "run-1", { childId: "c1", attempt: 1 }), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "That agent already moved on");
    stop();
  });

  it("keeps the newest plan usage from boot and from the event stream", async () => {
    const client = new FakeClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    client.plan = reading(20, 100);
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 20);
    client.handler?.({ type: "plan-usage", usage: reading(35, 200), accountId: null });
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 35);
    client.handler?.({ type: "plan-usage", usage: reading(1, 150), accountId: null });
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 35, "an older reading does not replace a newer one");
    stop();
  });

  it("keeps per-account plan usage from the event stream, and still keeps the global reading", async () => {
    const client = new FakeClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    const { controller, stop } = await started(client);
    client.handler?.({ type: "plan-usage", usage: reading(40, 300), accountId: "work" });
    assert.equal(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 40);
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 40, "a per-account reading still updates the global");
    client.handler?.({ type: "plan-usage", usage: reading(10, 250), accountId: "work" });
    assert.equal(
      controller.store.get().planUsageByAccount["work"]?.window.usedPercent,
      40,
      "an older per-account reading does not replace a newer one",
    );
    stop();
  });

  it("merges per-account plan usage from the boot load", async () => {
    const client = new FakeClient();
    client.planByAccount = {
      work: {
        tier: "high",
        observedAtMs: 500,
        window: { usedPercent: 60, resetsAtMs: 501, windowDurationMins: 300 },
        weekly: { usedPercent: 5, resetsAtMs: 502, windowDurationMins: null },
      },
    };
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 60);
    stop();
  });

  it("does not let a stale boot-load snapshot clobber a fresher per-account reading", async () => {
    const client = new FakeClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    const { controller, stop } = await started(client);
    client.handler?.({ type: "plan-usage", usage: reading(77, 200), accountId: "work" });
    assert.equal(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 77);
    client.planByAccount = { work: reading(10, 100) };
    await controller.loadPlanUsage();
    assert.equal(
      controller.store.get().planUsageByAccount["work"]?.window.usedPercent,
      77,
      "a stale byAccount snapshot from a boot GET does not replace a newer event-derived reading",
    );
    stop();
  });

  it("loads the account list and creates an account", async () => {
    const client = new FakeClient();
    const controller = new HeliconController(client, platform());
    await controller.loadAccounts();
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), []);
    assert.equal(await controller.createAccount("work", "Work"), true);
    assert.ok(client.accountCalls.some((c) => c.kind === "create" && c.id === "work"));
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), ["work"]);
  });

  it("flips metaApiKeyInherited when the client reports it", async () => {
    const client = new FakeClient();
    const controller = new HeliconController(client, platform());
    assert.equal(controller.store.get().metaApiKeyInherited, false);
    client.metaApiKeyInherited = true;
    await controller.loadAccountsHealth();
    assert.equal(controller.store.get().metaApiKeyInherited, true);
  });

  it("refreshes metaApiKeyInherited as part of loadAccounts", async () => {
    const client = new FakeClient();
    client.metaApiKeyInherited = true;
    const controller = new HeliconController(client, platform());
    await controller.loadAccounts();
    await settle();
    assert.equal(controller.store.get().metaApiKeyInherited, true);
  });

  it("begins a device-code login, waits, then flips to done once hasLogin turns true", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null }];
    const controller = new HeliconController(client, platform());

    const login = controller.beginLogin("work");
    // The modal opens right away with an empty marker, before the server has answered.
    const pending = controller.store.get().accountLogin;
    assert.equal(pending?.accountId, "work");

    await login;
    const waiting = controller.store.get().accountLogin;
    assert.ok(waiting && "status" in waiting && waiting.status === "waiting", "resolves to the waiting device shape");
    assert.equal((waiting as { url: string }).url, "https://auth.meta.com/oauth/device/?code=TEST-CODE");
    assert.equal((waiting as { code: string | null }).code, "TEST-CODE");
    assert.equal(client.loginAccountCalls.length, 1);

    const account = client.accounts.find((a) => a.id === "work");
    assert.ok(account);
    account.hasLogin = true;

    await settle();
    const done = controller.store.get().accountLogin;
    assert.ok(done && "status" in done && done.status === "done", "the poll flips status to done once hasLogin is true");
  });

  it("stores the fallback shape when the login route reports one", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null }];
    client.loginAccountResult = { fallback: "In-app login is not available when Muse runs in WSL." };
    const controller = new HeliconController(client, platform());

    await controller.beginLogin("work");
    const login = controller.store.get().accountLogin;
    assert.ok(login && !("status" in login));
    assert.equal((login as { fallback: string }).fallback, "In-app login is not available when Muse runs in WSL.");
  });

  it("cancelLogin clears the state and stops the poll", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null }];
    const controller = new HeliconController(client, platform());

    await controller.beginLogin("work");
    assert.ok(controller.store.get().accountLogin);

    controller.cancelLogin();
    assert.equal(controller.store.get().accountLogin, null);

    // The poll must not resurrect state after cancel, and must not call loginAccount again.
    const account = client.accounts.find((a) => a.id === "work");
    assert.ok(account);
    account.hasLogin = true;
    await settle();
    assert.equal(controller.store.get().accountLogin, null);
    assert.equal(client.loginAccountCalls.length, 1);
  });

  it("renames and removes accounts, reloading the list each time", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "default", name: "Default", hasLogin: true, email: "a@b.com", lastUsedAt: null }];
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), ["default"]);

    assert.equal(await controller.createAccount("work", "Work"), true);
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), ["default", "work"]);

    assert.equal(await controller.renameAccount("work", "Work Account"), true);
    assert.equal(controller.store.get().accounts?.find((a) => a.id === "work")?.name, "Work Account");

    assert.equal(await controller.removeAccount("work"), true);
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), ["default"]);
    stop();
  });

  it("sets a project's default account optimistically, and rolls back on failure", async () => {
    const client = new FakeClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null }];
    const { controller, stop } = await started(client);

    await controller.setProjectDefaultAccount("/work/app", "work");
    assert.equal(controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId, "work");
    assert.ok(client.accountCalls.some((c) => c.kind === "default" && c.cwd === "/work/app" && c.accountId === "work"));

    client.setProjectDefaultAccount = async () => {
      throw new Error("nope");
    };
    await controller.setProjectDefaultAccount("/work/app", null);
    assert.equal(
      controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId,
      "work",
      "a refused default rolls back",
    );
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not set the default account/);
    stop();
  });

  it("does not let a stale rollback clobber a newer overlapping default-account write", async () => {
    const client = new FakeClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null }];
    const { controller, stop } = await started(client);

    client.setProjectDefaultAccountError = new Error("nope");
    // Fired without awaiting: the first PATCH is queued to fail, the second to succeed. The chain
    // means the server sees them in order, so the first's rejection lands after the second's optimism.
    const first = controller.setProjectDefaultAccount("/work/app", "alpha");
    const second = controller.setProjectDefaultAccount("/work/app", "beta");
    await Promise.all([first, second]);

    assert.equal(
      controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId,
      "beta",
      "the second call's value stands; the stale rollback from the first call's failure is dropped",
    );
    assert.equal(
      controller.store.get().toasts.some((t) => /Could not set the default account/.test(t.title)),
      false,
      "a stale rollback does not toast either",
    );
    stop();
  });

  it("starts a new thread on the project's default account", async () => {
    const client = new FakeClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: "work" }];
    const { controller, stop } = await started(client, "");
    controller.newThread("/work/app");
    assert.equal(await controller.send("hello"), true);
    assert.equal(client.startCalls.at(-1)?.accountId, "work");
    const route = controller.store.get().route;
    assert.equal(route.kind, "thread");
    const sessionId = route.kind === "thread" ? route.sessionId : "";
    assert.equal(controller.store.get().sessions[sessionId]?.accountId, "work", "the seeded session carries the account the server confirmed");
    stop();
  });

  it("asks for the open thread's own skills and reloads them when Muse says they changed", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.loadSkills("/work/app");
    assert.deepEqual(client.skillSessions, ["s1"]);
    await controller.loadSkills("/work/app");
    assert.equal(client.skillSessions.length, 1, "a fresh list is reused");
    client.handler?.({ type: "msp", sessionId: "s1", method: "skill/changed", params: { sessionId: "s1" }, at: 1 });
    await settle();
    assert.equal(client.skillSessions.length, 2);
    stop();
  });

  it("opens files from paths in replies as tabs, and closes back to the tree", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const panel = () => controller.store.get().filePanels["s1"];
    assert.equal(controller.store.get().prefs.filesOpen, false);

    assert.equal(controller.openFile("s1", "/work/app/src/app.js:4-5"), true);
    assert.equal(controller.store.get().prefs.filesOpen, true, "opening a file shows the viewer");
    assert.deepEqual(panel(), { tabs: ["src/app.js"], active: "src/app.js", tree: false, line: { start: 4, end: 5 } });
    controller.openFile("s1", "README.md");
    controller.openFile("s1", "src/app.js");
    assert.deepEqual(panel()?.tabs, ["src/app.js", "README.md"], "an open file is not opened twice");
    assert.equal(panel()?.active, "src/app.js");

    controller.closeFile("s1", "src/app.js");
    assert.deepEqual(panel(), { tabs: ["README.md"], active: "README.md", tree: false, line: null });
    controller.closeFile("s1", "README.md");
    assert.deepEqual(panel(), { tabs: [], active: null, tree: true, line: null });
    assert.equal(controller.openFile("s1", "https://helicon.sh"), false, "a web link is not a file");
    controller.toggleFiles();
    assert.equal(controller.store.get().prefs.filesOpen, false);
    stop();
  });

  it("saves a draft against the version it was opened at, and offers to overwrite a file that changed", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const key = "/work/app\nREADME.md";
    controller.setFileDraft("/work/app", "README.md", "# edited", 100);
    controller.setFileDraft("/work/app", "README.md", "# edited more", 999);
    assert.deepEqual(controller.store.get().fileDrafts[key], { content: "# edited more", baseMtimeMs: 100 }, "the base is where editing began");

    assert.equal(await controller.saveFile("/work/app", "README.md"), 200);
    assert.deepEqual(client.writes.at(-1), { path: "README.md", content: "# edited more", baseMtimeMs: 100 });
    assert.equal(controller.store.get().fileDrafts[key], undefined);
    assert.equal(controller.store.get().fileVersions[key], 1, "a view of the file reloads after a save");

    controller.setFileDraft("/work/app", "README.md", "# mine", 200);
    client.writeError = new HeliconError("changed", 409, "fileChanged");
    assert.equal(await controller.saveFile("/work/app", "README.md"), null);
    const toast = controller.store.get().toasts.at(-1);
    assert.equal(toast?.title, "This file changed on disk");
    assert.ok(controller.store.get().fileDrafts[key], "the edit is kept when the save is refused");
    toast?.action?.run();
    await settle();
    assert.deepEqual(client.writes.at(-1), { path: "README.md", content: "# mine", baseMtimeMs: null }, "overwrite skips the version check");
    stop();
  });

  it("reloads an open file when Muse edits it", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "item/completed",
      params: {
        sessionId: "s1",
        item: {
          itemId: "e1",
          kind: "toolCall",
          status: "completed",
          revision: 2,
          tool: "edit",
          args: JSON.stringify({ path: "/work/app/src/app.js", old_string: "a", new_string: "b" }),
        },
      },
      at: 1,
    });
    await settle();
    controller.flush();
    assert.equal(controller.store.get().fileVersions["/work/app\nsrc/app.js"], 1);
    stop();
  });

  it("reads a tool's stored output page by page", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const first = await controller.readOutput("s1", "i1", "ref");
    assert.equal(first.eof, false);
    const next = await controller.readOutput("s1", "i1", "ref", first.offsetBytes + first.byteLen);
    assert.equal(next.eof, true);
    stop();
  });

  it("runs a `!` command itself and hands its output to Muse on request", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("!ls -la"), true);
    const run = controller.store.get().threads["s1"]?.shellRuns[0];
    assert.equal(run?.command, "ls -la");
    assert.ok(client.actions.includes("shell-proxy:ls -la"));

    assert.equal(await controller.sendShellOutput("s1", run!), true);
    const sent = client.sent.at(-1);
    assert.match(sent?.text ?? "", /I ran this in the workspace/);
    assert.match(sent?.text ?? "", /ran ls -la/);
    assert.equal(sent?.displayText, "Shared the output of `ls -la`");
    stop();
  });

  it("starts a thread beside one whose reasoning cannot be replayed", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.freshThread("s1", "pick this up again"), true);
    assert.equal(client.sent.at(-1)?.text, "pick this up again");
    assert.equal(controller.store.get().route.kind, "thread");

    // A prompt the transcript showed as `/goal …` runs as the goal command again, not as the literal text.
    const sent = client.sent.length;
    assert.equal(await controller.freshThread("s1", "/goal ship the release"), true);
    assert.equal(client.actions.at(-1), "goal:s1:set:ship the release");
    assert.equal(client.sent.length, sent);
    stop();
  });

  it("compacts a thread the provider will not take, then sends the prompt again", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.compactAndRetry("s1", "try that again");
    assert.ok(client.actions.includes("compact"), "the history is summarized first");
    assert.equal(client.sent.at(-1)?.text, "try that again");
    assert.equal(client.sent.at(-1)?.ifBusy, "queue", "the retry waits behind the compaction turn");

    let before = client.sent.length;
    await controller.compactAndRetry("s1", null);
    assert.equal(client.sent.length, before, "with no prompt to resend, it only compacts");

    // A compaction Muse refused leaves the history exactly as it was, so resending would fail the same way.
    before = client.sent.length;
    client.compactNoop = true;
    await controller.compactAndRetry("s1", "try that again");
    assert.equal(client.sent.length, before, "nothing is resent after a noop compaction");
    client.compactNoop = false;
    client.compact = async () => {
      throw new Error("no");
    };
    await controller.compactAndRetry("s1", "try that again");
    assert.equal(client.sent.length, before, "nor after one that failed");
    stop();
  });

  it("clears a failed turn's notice when the user retries it", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "turn/completed",
      params: { sessionId: "s1", turnId: "t7", terminal: "failed", error: { kind: "rateLimit", message: "quota", retryable: true } },
      at: 5,
    });
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.fold.turns["t7"]?.error?.message, "quota");

    controller.dismissTurnError("s1", "t7");
    const info = controller.store.get().threads["s1"]?.fold.turns["t7"];
    assert.equal(info?.error, undefined);
    assert.equal(info?.dismissed, true);
    // Remembered outside the fold too, which a reload rebuilds from history with the error back in it.
    assert.deepEqual(controller.store.get().prefs.dismissedTurnErrors, ["s1:t7"]);
    controller.dismissTurnError("s1", "t7");
    assert.deepEqual(controller.store.get().prefs.dismissedTurnErrors, ["s1:t7"]);
    stop();
  });

  it("reorders projects by drag, and puts them back when the server refuses", async () => {
    const client = new FakeClient();
    const project = (cwd: string) => ({ cwd, displayName: cwd.slice(6), pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null });
    client.listProjects = async () => [project("/work/a"), project("/work/b"), project("/work/c")];
    const { controller, stop } = await started(client);
    const order = () => controller.store.get().projects.map((p) => p.cwd);

    await controller.reorderProjects("/work/c", "/work/a");
    assert.deepEqual(order(), ["/work/c", "/work/a", "/work/b"]);
    assert.deepEqual(client.orders.at(-1), ["/work/c", "/work/a", "/work/b"]);

    await controller.reorderProjects("/work/c", null);
    assert.deepEqual(order(), ["/work/a", "/work/b", "/work/c"], "dropping past the last row sends it to the end");

    client.setProjectOrder = async () => {
      throw new Error("nope");
    };
    await controller.reorderProjects("/work/c", "/work/a");
    assert.deepEqual(order(), ["/work/a", "/work/b", "/work/c"], "a refused move snaps back");
    stop();
  });

  it("sends attached files with a prompt, and shows them while it is in flight", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const sent = await controller.send("look at this", {
      attachments: [{ name: "shot.png", mediaType: "image/png", base64: "AAAB" }],
      previews: [{ name: "shot.png", mediaType: "image/png", kind: "image", url: "blob:preview" }],
    });
    assert.equal(sent, true);
    assert.deepEqual(client.sent.at(-1)?.attachments, [{ name: "shot.png", mediaType: "image/png", base64: "AAAB" }]);
    assert.equal(controller.store.get().threads["s1"]?.fold.echoes.at(-1)?.attachments?.[0]?.url, "blob:preview");

    assert.equal(
      await controller.send("", { attachments: [{ name: "notes.pdf", mediaType: "application/pdf", base64: "AAAC" }] }),
      true,
      "a file with no text still sends",
    );
    assert.equal(await controller.send(""), false, "nothing to send is still nothing");
    stop();
  });

  it("hands a `!` command the host could not run to the agent", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.askToRun("s1", "ls -la"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /```sh\nls -la\n```/);
    assert.match(client.sent.at(-1)?.text ?? "", /your own shell works/, "the agent is told its own shell is fine");
    assert.equal(await controller.askToRun("s1", "echo '```'"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /````sh\necho '```'\n````/, "a fence in the command gets a longer fence around it");
    assert.equal(await controller.askToRun("s1", "printf '~~~\\n'"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /```sh\nprintf '~~~\\n'\n```/, "a tilde run in the command changes nothing");
    stop();
  });

  it("forks a thread and opens the fork", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    // Opening the fork loads its transcript, which carries the fork's own summary.
    client.transcript = async () => load({ session: { ...SESSION, sessionId: "s2", title: "Probe (fork)" } });
    assert.equal(await controller.send("/fork"), true);
    const state = controller.store.get();
    assert.deepEqual(state.route, { kind: "thread", sessionId: "s2" });
    assert.equal(state.sessions["s2"]?.title, "Probe (fork)");
    assert.equal(state.toasts.at(-1)?.title, "Forked into a new thread");
    stop();
  });

  it("opens a side chat beside the thread and switches to it", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const parentMode = controller.store.get().threads["s1"]?.fold.meta.approvalMode ?? controller.store.get().prefs.defaultMode;
    client.transcript = async () => load({ session: { ...SESSION, sessionId: "s3", title: "Probe (side chat)", sideOf: "s1" } });
    assert.equal(await controller.send("/side"), true);
    const state = controller.store.get();
    assert.ok(client.actions.includes("side:s1"));
    assert.deepEqual(state.route, { kind: "thread", sessionId: "s3" });
    assert.equal(state.sessions["s3"]?.sideOf, "s1");
    // Muse opens side chats in full access; the side chat gets its thread's mode instead.
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s3", mode: parentMode });
    stop();
  });

  it("sends nothing into a side chat whose permissions could not be set", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.approvalModeFailFor.add("s3");
    client.transcript = async () => load({ session: { ...SESSION, sessionId: "s3", title: "Probe (side chat)", sideOf: "s1" } });
    const before = client.sent.length;
    assert.equal(await controller.send("/side run the migration"), true);
    assert.equal(client.sent.length, before, "the message is not sent");
    assert.deepEqual(controller.store.get().route, { kind: "thread", sessionId: "s3" });
    assert.equal(controller.store.get().toasts.at(-1)?.title, "The side chat may run tools without asking");
    stop();
  });

  it("sends the text after /side into the new side chat", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.transcript = async () => load({ session: { ...SESSION, sessionId: "s3", title: "Probe (side chat)", sideOf: "s1" } });
    assert.equal(await controller.send("/side what does this regex do?"), true);
    assert.equal(client.sent.at(-1)?.sessionId, "s3");
    assert.equal(client.sent.at(-1)?.text, "what does this regex do?");
    stop();
  });

  it("walks interface zoom through its fixed steps and back to 100%", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const zoom = () => controller.store.get().prefs.zoom;
    assert.equal(zoom(), 1);
    controller.zoomIn();
    assert.equal(zoom(), 1.1);
    controller.zoomIn();
    assert.equal(zoom(), 1.2);
    controller.zoomOut();
    controller.zoomOut();
    assert.equal(zoom(), 1);
    controller.zoomOut();
    assert.equal(zoom(), 0.9);
    controller.resetZoom();
    assert.equal(zoom(), 1);
    stop();
  });

  it("clamps interface zoom to its ends and drops malformed saved values", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    controller.setZoom(5);
    assert.equal(controller.store.get().prefs.zoom, ZOOM_MAX);
    controller.zoomIn();
    assert.equal(controller.store.get().prefs.zoom, ZOOM_MAX);
    controller.setZoom(0.05);
    assert.equal(controller.store.get().prefs.zoom, ZOOM_MIN);
    controller.zoomOut();
    assert.equal(controller.store.get().prefs.zoom, ZOOM_MIN);
    controller.setZoom(1.234);
    assert.equal(controller.store.get().prefs.zoom, 1.23);
    stop();
    const revived = new HeliconController(client, { ...platform(), loadPrefs: () => ({ zoom: 99 }) });
    assert.equal(revived.store.get().prefs.zoom, 1);
  });

  it("returns from settings and usage to the thread they were opened from", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    controller.navigate({ kind: "settings" });
    assert.deepEqual(controller.store.get().route, { kind: "settings" });
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" });
    controller.navigate({ kind: "usage" });
    // Moving between the two pages keeps the thread as the way back, not the other page.
    controller.navigate({ kind: "settings" });
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" });
    stop();
  });

  it("returns from settings to a fresh-thread route", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client, "");
    controller.newThread();
    assert.deepEqual(controller.store.get().route, { kind: "new", cwd: "/work/app" });
    controller.navigate({ kind: "settings" });
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "new", cwd: "/work/app" });
    stop();
  });

  it("falls back to home when there is nowhere to go back to", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client, "#/settings");
    assert.deepEqual(controller.store.get().route, { kind: "settings" });
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "home" });
    stop();
  });

  it("falls back to home when the return thread is gone", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    controller.navigate({ kind: "settings" });
    await controller.archive("s1");
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "home" });
    stop();
  });

  it("pins and unpins a thread, restoring it when the save fails", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const patches: unknown[] = [];
    client.updateSession = async (_sessionId?: string, patch?: { pinned?: boolean }) => {
      patches.push(patch);
      return { ...SESSION, ...patch };
    };
    await controller.toggleThreadPin("s1");
    assert.equal(controller.store.get().sessions["s1"]?.pinned, true);
    assert.deepEqual(patches, [{ pinned: true }]);
    await controller.toggleThreadPin("s1");
    assert.equal(controller.store.get().sessions["s1"]?.pinned, false);
    client.updateSession = async () => {
      throw new Error("daemon away");
    };
    await controller.toggleThreadPin("s1");
    assert.equal(controller.store.get().sessions["s1"]?.pinned, false, "a failed pin rolls back");
    assert.ok(controller.store.get().toasts.some((t) => t.tone === "error"));
    stop();
  });
});

describe("staleThreadReason", () => {
  const NOW = 1_000_000;

  it("leaves idle threads alone", () => {
    assert.equal(staleThreadReason(null, null, NOW - 60_000, NOW), null);
    assert.equal(staleThreadReason(null, "t1", NOW - 600_000, NOW), null);
  });

  it("leaves threads without an applied stamp alone", () => {
    assert.equal(staleThreadReason("t1", null, null, NOW), null);
  });

  it("reloads a fold still showing a turn the server finished", () => {
    assert.equal(staleThreadReason("t1", null, NOW - 30_000, NOW), null);
    assert.equal(staleThreadReason("t1", null, NOW - 30_001, NOW), "diverged");
    assert.equal(staleThreadReason("t1", undefined, NOW - 31_000, NOW), "diverged");
  });

  it("reloads a turn both sides agree is running but silent", () => {
    assert.equal(staleThreadReason("t1", "t1", NOW - 90_000, NOW), null);
    assert.equal(staleThreadReason("t1", "t1", NOW - 90_001, NOW), "quiet");
  });
});

describe("stale thread watchdog", () => {
  function watchPlatform() {
    const base = platform("#/t/s1");
    let now = 1_000_000;
    const timers: ({ fn: () => void; ms: number } | null)[] = [];
    const fake: Platform = {
      ...base,
      now: () => now,
      schedule: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      cancel: (handle: unknown) => {
        if (typeof handle === "number") {
          timers[handle] = null;
        }
      },
    };
    return {
      fake,
      setNow: (value: number) => {
        now = value;
      },
      runStaleChecks: () => {
        for (const timer of [...timers]) {
          if (timer && timer.ms === 30_000) {
            timer.fn();
          }
        }
      },
    };
  }

  const runningLoad = (): TranscriptLoad =>
    load({
      msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/app", turnCount: 4 },
      events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
    });

  async function startedWatching(client: FakeClient) {
    const watch = watchPlatform();
    const controller = new HeliconController(client, watch.fake);
    const stop = controller.start();
    await settle();
    await settle();
    return { controller, stop, ...watch };
  }

  it("reloads a thread whose ending never landed", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.equal(loads, 1);
    runStaleChecks();
    assert.equal(loads, 1, "a thread that just applied anything is left alone");
    setNow(1_000_000 + 31_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 2, "a fold still showing a finished turn reloads from history");
    runStaleChecks();
    assert.equal(loads, 2, "a fresh reload is not reloaded again at once");
    setNow(1_000_000 + 62_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 3, "a thread that stays silent is retried once per grace period");
    setNow(1_000_000 + 93_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 3, "a turn history never finishes stops being refetched");
    stop();
  });

  it("leaves a turn alone while it waits on the user, however long that takes (#54)", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return load({
        msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/app", turnCount: 4 },
        events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
        // On load the server's pending set is what the fold trusts, not the event log.
        pending: {
          approvals: [],
          userInputs: [{ userInputId: "q1", turnId: "live-1", questions: [{ question: "Which one?", options: [] }] } as unknown as UserInputRequest],
        },
      });
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.equal(loads, 1);
    for (const minutes of [2, 5, 10, 30]) {
      setNow(1_000_000 + minutes * 60_000);
      runStaleChecks();
      await settle();
      await settle();
    }
    assert.equal(loads, 1, "a question left unanswered for half an hour is never reloaded");
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "and never reported as stalled");
    stop();
  });

  it("says a thread stalled once the reloads are spent, and retries when asked", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "nothing is stalled to begin with");

    setNow(1_000_000 + 31_000);
    runStaleChecks();
    await settle();
    await settle();
    setNow(1_000_000 + 62_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "still trying, so nothing is said yet");

    setNow(1_000_000 + 93_000);
    runStaleChecks();
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.stalled, true, "out of reloads: the view says so");
    assert.equal(loads, 3, "and stops reloading");

    await controller.retryStalledThread("s1");
    await settle();
    assert.equal(loads, 4, "asking by hand tries again");
    stop();
  });

  it("reloads a turn both sides agree is running but silent", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { stop, setNow, runStaleChecks } = await startedWatching(client);
    client.handler?.({
      type: "session-status",
      sessionId: "s1",
      live: { activeTurnId: "live-1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null },
    });
    setNow(1_000_000 + 60_000);
    runStaleChecks();
    assert.equal(loads, 1, "a quiet-but-running turn gets a longer grace period");
    setNow(1_000_000 + 91_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 2);
    stop();
  });

  it("leaves a quiet turn alone for as long as the server confirms it is running", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    client.handler?.({
      type: "session-status",
      sessionId: "s1",
      live: { activeTurnId: "live-1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null },
    });
    // A long command: nothing to show for it, and the server checking with Muse throughout.
    for (let minutes = 1; minutes <= 8; minutes += 1) {
      setNow(1_000_000 + minutes * 60_000);
      client.handler?.({ type: "feed", sessionId: "s1", activeTurnId: "live-1", at: 1_000_000 + minutes * 60_000 });
      setNow(1_000_000 + minutes * 60_000 + 45_000);
      runStaleChecks();
      await settle();
    }
    assert.equal(loads, 1, "a turn known to be running is never reloaded for being quiet");
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "and never reported as stalled");

    setNow(1_000_000 + 8 * 60_000 + 91_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 2, "once the confirmations stop, quiet means what it used to");
    stop();
  });

  it("does not take a confirmation of some other turn as news of this one", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { stop, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_000_000 + 31_000);
    client.handler?.({ type: "feed", sessionId: "s1", activeTurnId: "live-2", at: 1_000_000 + 31_000 });
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 2, "the fold shows a turn the server is not vouching for, so it reloads");
    stop();
  });

  it("clears the stalled notice when the server confirms the turn after all", async () => {
    const client = new FakeClient();
    client.transcript = async () => runningLoad();
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    for (const seconds of [31, 62, 93]) {
      setNow(1_000_000 + seconds * 1_000);
      runStaleChecks();
      await settle();
      await settle();
    }
    assert.equal(controller.store.get().threads["s1"]?.stalled, true);
    client.handler?.({ type: "feed", sessionId: "s1", activeTurnId: "live-1", at: 1_000_000 + 94_000 });
    assert.equal(controller.store.get().threads["s1"]?.stalled, false);
    stop();
  });

  it("turns catch-up on from the stalled notice, and only then reloads the thread", async () => {
    const client = new FakeClient();
    const order: string[] = [];
    client.transcript = async () => {
      order.push(`load with catch-up ${client.feedSettings.catchUp ? "on" : "off"}`);
      return runningLoad();
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    for (const seconds of [31, 62, 93]) {
      setNow(1_000_000 + seconds * 1_000);
      runStaleChecks();
      await settle();
      await settle();
    }
    assert.equal(controller.store.get().threads["s1"]?.stalled, true);
    order.length = 0;

    await controller.keepThreadLive("s1");
    assert.deepEqual(client.feedCalls, [true]);
    assert.deepEqual(controller.store.get().feedSettings, { catchUp: true });
    assert.deepEqual(order, ["load with catch-up on"], "the server follows a thread from a load made once the mode is on");
    stop();
  });

  it("still reloads from the stalled notice when catch-up could not be switched on", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { controller, stop } = await startedWatching(client);
    client.feedError = new Error("daemon away");
    await controller.keepThreadLive("s1");
    assert.deepEqual(controller.store.get().feedSettings, { catchUp: false }, "the switch rolls back");
    assert.equal(loads, 2, "and the reload is the one the Reload button makes");
    stop();
  });

  it("reloads a thread already stalled when catch-up is switched on in Settings", async () => {
    const client = new FakeClient();
    const order: string[] = [];
    client.transcript = async () => {
      order.push(`load with catch-up ${client.feedSettings.catchUp ? "on" : "off"}`);
      return runningLoad();
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    for (const seconds of [31, 62, 93]) {
      setNow(1_000_000 + seconds * 1_000);
      runStaleChecks();
      await settle();
      await settle();
    }
    assert.equal(controller.store.get().threads["s1"]?.stalled, true, "its reloads are spent, so it would never load again unasked");
    order.length = 0;

    await controller.setCatchUp(true);
    assert.deepEqual(order, ["load with catch-up on"], "the load the server starts following it from");

    await controller.setCatchUp(true);
    assert.deepEqual(order, ["load with catch-up on"], "a switch already on has nothing to pick up");
    stop();
  });

  it("takes the stalled notice down when the thread's events arrive after all", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    for (const seconds of [31, 62, 93]) {
      setNow(1_000_000 + seconds * 1_000);
      runStaleChecks();
      await settle();
      await settle();
    }
    assert.equal(controller.store.get().threads["s1"]?.stalled, true);
    assert.equal(loads, 3);

    // Catch-up delivers what push did not. The turn is still running, and visibly moving.
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "item/completed",
      params: { sessionId: "s1", item: { itemId: "late", kind: "agentMessage", revision: 1, status: "completed", text: "still here" } },
      at: 1_000_000 + 94_000,
    });
    controller.flush();
    assert.equal(controller.store.get().threads["s1"]?.fold.activeTurnId, "live-1");
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "a thread that is receiving updates has not stopped receiving them");

    setNow(1_000_000 + 94_000 + 91_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 4, "and the turn has its reloads back, should it go quiet again");
    stop();
  });

  it("takes it down as well when what arrives is the turn's ending, after which nothing vouches for the turn", async () => {
    const client = new FakeClient();
    client.transcript = async () => runningLoad();
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    for (const seconds of [31, 62, 93]) {
      setNow(1_000_000 + seconds * 1_000);
      runStaleChecks();
      await settle();
      await settle();
    }
    assert.equal(controller.store.get().threads["s1"]?.stalled, true);

    // The turn's ending is delivered at last.
    client.handler?.({ type: "msp", sessionId: "s1", method: "turn/completed", params: { sessionId: "s1", turnId: "live-1", terminal: "completed" }, at: 1_000_000 + 94_000 });
    controller.flush();
    assert.equal(controller.store.get().threads["s1"]?.fold.activeTurnId, null);
    assert.equal(controller.store.get().threads["s1"]?.stalled, false);
    stop();
  });

  it("keeps the stalled notice down when the turn is confirmed while a reload is on its way", async () => {
    const client = new FakeClient();
    client.transcript = async () => runningLoad();
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    for (const seconds of [31, 62, 93]) {
      setNow(1_000_000 + seconds * 1_000);
      runStaleChecks();
      await settle();
      await settle();
    }
    assert.equal(controller.store.get().threads["s1"]?.stalled, true);

    let resolve!: (value: TranscriptLoad) => void;
    client.transcript = () => new Promise<TranscriptLoad>((r) => (resolve = r));
    const reload = controller.retryStalledThread("s1");
    await settle();
    client.handler?.({ type: "feed", sessionId: "s1", activeTurnId: "live-1", at: 1_000_000 + 94_000 });
    assert.equal(controller.store.get().threads["s1"]?.stalled, false);

    // History lands with the turn still running, as the confirmation said it was.
    resolve(runningLoad());
    await reload;
    assert.equal(controller.store.get().threads["s1"]?.load, "ready");
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "what the load found before the confirmation does not put the notice back");
    stop();
  });

  it("reloads a thread mid-turn that is not the open one when the event stream comes back", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { controller, stop } = await startedWatching(client);
    controller.navigate({ kind: "home" });
    assert.equal(loads, 1);

    client.handler?.({ type: "connection", state: "lost" });
    client.handler?.({ type: "hello", version: "0.21.0" });
    await settle();
    await settle();
    assert.equal(loads, 2, "what was sent while the stream was down is filled in from history, not left to a quiet reload a confirmed turn never gets");
    stop();
  });

  it("leaves idle threads and threads already loading alone", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return load();
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.equal(loads, 1);
    setNow(1_000_000 + 900_000);
    runStaleChecks();
    assert.equal(loads, 1, "an idle thread never reloads itself");

    let resolve!: (value: TranscriptLoad) => void;
    client.transcript = () => {
      loads += 1;
      return new Promise<TranscriptLoad>((r) => (resolve = r));
    };
    const loading = controller.loadThread("s1");
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.load, "loading");
    runStaleChecks();
    resolve(load());
    await loading;
    await settle();
    assert.equal(loads, 2, "a reload never piles onto a load already in flight");
    stop();
  });
});
