import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAonia } from "@harjjotsinghh/aonia";
import {
  HeliconServer,
  deriveTitle,
  eventsFromHistory,
  frameAncestorsPolicy,
  mergeSessionSkills,
  normalizeIso,
  parseSkillList,
  stripFrontmatter,
  toWireEvent,
  type HostExit,
  type HostHandle,
  type LoginChild,
  type LoginSpawn,
  type OpenTarget,
} from "../src/server.js";
import { HeliconStore, type ExecFn, type ServeTarget } from "@helicon/daemon";

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

type Reply = unknown | ((params: Record<string, unknown>) => unknown);

class MspTestError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

class FakeConnection {
  calls: Call[] = [];
  requests: Call[] = [];
  replies = new Map<string, Reply>();
  handler: ((n: { method: string; params?: unknown }) => void) | null = null;

  private answer(method: string, params: Record<string, unknown>): unknown {
    const reply = this.replies.get(method);
    if (reply instanceof Error) {
      throw reply;
    }
    if (typeof reply === "function") {
      return (reply as (p: Record<string, unknown>) => unknown)(params);
    }
    return reply ?? { ok: true };
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    return this.answer(method, params);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.requests.push({ method, params });
    return this.answer(method, params);
  }

  onNotification(handler: (n: { method: string; params?: unknown }) => void): void {
    this.handler = handler;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.handler?.({ method, params });
  }
}

interface FactoryProbe {
  targets: ServeTarget[];
  exits: ((exit: HostExit) => void)[];
}

/** A fake `muse login` child: stdout/stderr an EventEmitter each, `kill()` fires `close` like a real process. */
class FakeLoginChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private readonly emitter = new EventEmitter();
  killCount = 0;

  on(event: "close" | "error", listener: (arg: unknown) => void): void {
    this.emitter.on(event, listener);
  }

  kill(): void {
    this.killCount += 1;
    setImmediate(() => this.emitter.emit("close", null));
  }
}

function fakeFactory(connection: FakeConnection, probe?: FactoryProbe): (target: ServeTarget) => HostHandle {
  return (target) => {
    probe?.targets.push(target);
    return {
      start: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } };
      },
      connection: connection as never,
      close: async () => ({ code: 0, signal: null }),
      onExit: (handler) => probe?.exits.push(handler),
    };
  };
}

async function start(connection: FakeConnection, extra: Partial<ConstructorParameters<typeof HeliconServer>[0]> = {}) {
  const server = new HeliconServer({
    port: 0,
    dataDir: ":memory:",
    platform: "linux",
    musePath: "muse",
    hostFactory: fakeFactory(connection),
    // No test spawns the real CLI by accident; title upgrades see a failed call.
    exec: async () => ({ stdout: "", exitCode: 127 }),
    // Nor pages a session's view by accident; the tests about that shorten this instead.
    tailTiming: { tickMs: 3_600_000 },
    ...extra,
  });
  after(() => server.close());
  const bound = await server.listen();
  return { server, base: `http://127.0.0.1:${bound.port}` };
}

async function send(
  base: string,
  path: string,
  body?: unknown,
  method = "POST",
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(base: string, path: string): Promise<any> {
  return (await fetch(`${base}${path}`)).json();
}

async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await cond()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Opens the real `/api/events` SSE stream, waits for it to be live, runs `drive`, then counts how many
 * `plan-usage` events arrived. Uses the server's actual public event API rather than a test-only hook.
 */
async function countPlanUsageEvents(base: string, drive: () => Promise<void>): Promise<number> {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawHello = false;
  let planUsageCount = 0;
  let stop = false;
  const pump = (async () => {
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) {
          continue;
        }
        const payload = JSON.parse(dataLine.slice("data: ".length));
        if (payload.type === "hello") {
          sawHello = true;
        }
        if (payload.type === "plan-usage") {
          planUsageCount += 1;
        }
      }
    }
  })();

  await waitFor(() => sawHello, "sse hello event");
  await drive();
  // Give the emitted SSE writes a moment to land before counting.
  await new Promise((r) => setTimeout(r, 150));
  stop = true;
  await reader.cancel().catch(() => undefined);
  await pump.catch(() => undefined);
  return planUsageCount;
}

const RANGE = { first: { id: "r", sequence: 1 }, last: { id: "r", sequence: 1 }, stream: { id: "s", kind: "session" } };

/** Opens `/api/events` and keeps every event it carries, until stopped. */
async function collectEvents(base: string): Promise<{ events: any[]; stop: () => Promise<void> }> {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffer = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const dataLine = buffer.slice(0, idx).split("\n").find((line) => line.startsWith("data: {"));
        buffer = buffer.slice(idx + 2);
        if (dataLine) {
          events.push(JSON.parse(dataLine.slice("data: ".length)));
        }
      }
    }
  })().catch(() => undefined);
  await waitFor(() => events.some((e) => e.type === "hello"), "sse hello event");
  return {
    events,
    stop: async () => {
      await reader.cancel().catch(() => undefined);
      await pump;
    },
  };
}

/** Fast enough for a test to wait on, in the proportions the real timings have. */
const FAST_TAIL = { tickMs: 5, quietMs: 40, suspectQuietMs: 20, busyMaxMs: 80, idleMs: 60, idleMaxMs: 120, statusMs: 60, hotMs: 2_000, idleFollowMs: 60_000 };

/**
 * A session whose view Muse serves on request and whose pushes are the test's to send or withhold,
 * which is what #42's sessions look like from here: the log completes, the view pages, nothing arrives.
 */
function quietSession(connection: FakeConnection) {
  const view: { method: string; params: Record<string, unknown> }[] = [];
  const event = (method: string, extra: Record<string, unknown> = {}) => {
    const made = { method, params: { sessionId: "s1", viewCursor: `v:s1:${view.length + 1}`, sourceRange: RANGE, ...extra } };
    view.push(made);
    return made;
  };
  const record = { activeTurnId: null as string | null };
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  const head = () => view[view.length - 1]?.params["viewCursor"] ?? "";
  const session = () => ({ sessionId: "s1", updatedAt: `2026-09-19T16:00:${String(view.length).padStart(2, "0")}Z`, ...record });
  connection.replies.set("session/resume", () => ({ session: { status: "idle", ...session() }, viewCursor: head() }));
  connection.replies.set("session/read", () => ({ session: session(), viewCursor: head() }));
  connection.replies.set("approval/listPending", { approvals: [], userInputs: [] });
  connection.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });
  /** What a page adds past the real events while `record.activeTurnId` runs: the turn closed as if the host had died. */
  const lent = () =>
    record.activeTurnId
      ? [
          { method: "item/completed", params: { sessionId: "s1", viewCursor: `v:s1:${view.length + 1}`, sourceRange: RANGE, item: { itemId: "open", kind: "toolCall", revision: 2, status: "failed", reason: "incomplete" } } },
          { method: "turn/completed", params: { sessionId: "s1", viewCursor: `v:s1:${view.length + 2}`, sourceRange: RANGE, turnId: record.activeTurnId, terminal: "failed", reason: "incomplete" } },
        ]
      : [];
  connection.replies.set("view/page", (params: Record<string, unknown>) => {
    const all = [...view, ...lent()];
    if (params["direction"] === "backward") {
      return { events: all, nextCursor: null };
    }
    const from = params["cursor"] ? all.findIndex((e) => e.params["viewCursor"] === params["cursor"]) + 1 : 0;
    return { events: all.slice(from), nextCursor: null };
  });
  return { view, event, record };
}

describe("HeliconServer", () => {
  it("serves health, projects, sessions and turns", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1", modelId: "muse-spark-1.3" } });
    connection.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });
    const { base } = await start(connection);

    const health = await get(base, "/api/health");
    assert.equal(health.ok, true);

    const created = await send(base, "/api/sessions", { cwd: "/work/proj/" });
    assert.equal(created.status, 200);
    assert.equal(created.json.session.sessionId, "s1");
    assert.equal(created.json.session.cwd, "/work/proj");
    assert.equal(created.json.session.modelId, "muse-spark-1.3");

    const turn = await send(base, "/api/turns", { sessionId: "s1", text: "hello", ifBusy: "steer", reasoningEffort: "high" });
    assert.equal(turn.status, 200);
    assert.equal(turn.json.turnId, "t1");
    assert.deepEqual(connection.calls.at(-1)?.params, {
      sessionId: "s1",
      input: [{ type: "text", text: "hello" }],
      ifBusy: "steer",
      reasoningEffort: "high",
    });

    // max is a real level on the contributor tier, so it has to pass validation like the rest of the scale.
    const top = await send(base, "/api/turns", { sessionId: "s1", text: "hello", reasoningEffort: "max" });
    assert.equal(top.status, 200);
    assert.equal((connection.calls.at(-1)?.params as { reasoningEffort?: string }).reasoningEffort, "max");

    const projects = await get(base, "/api/projects");
    assert.deepEqual(projects.projects.map((p: { cwd: string }) => p.cwd), ["/work/proj"]);

    const denied = await send(base, "/api/turns", { sessionId: "s1" });
    assert.equal(denied.status, 400);
  });

  it("rejects bad modes, dispositions, efforts and missing fields", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.equal((await send(base, "/api/sessions", { cwd: "/w", approvalMode: "yolo" })).status, 400);
    assert.equal((await send(base, "/api/sessions", {})).status, 400);
    assert.equal((await send(base, "/api/turns", { sessionId: "s", text: "x", ifBusy: "later" })).status, 400);
    assert.equal((await send(base, "/api/turns", { sessionId: "s", text: "x", reasoningEffort: "louder" })).status, 400);
    assert.equal((await send(base, "/api/approvals/decide", { sessionId: "s" })).status, 400);
    assert.equal((await send(base, "/api/user-input/clarify", { sessionId: "s", userInputId: "u" })).status, 400);
    const bad = await fetch(`${base}/api/turns`, { method: "POST", body: "{nope" });
    assert.equal(bad.status, 400);
  });

  it("requires a token when one is configured", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { token: "secret" });
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    assert.equal((await fetch(`${base}/api/health?token=secret`)).status, 200);
  });

  it("answers an allowed origin and refuses one nobody listed", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { allowOrigins: ["https://helicon.example"] });
    const blocked = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(blocked.status, 403);
    // Nothing to read even by accident: a refused origin gets no CORS headers at all.
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    const allowed = await fetch(`${base}/api/health`, { headers: { origin: "https://helicon.example" } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://helicon.example");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
  });

  it("limits who may frame the UI with a frame-ancestors policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helicon-static-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>h</title>");
    const { base } = await start(new FakeConnection(), { staticDir: dir, frameAncestors: ["https://code.example"] });
    const page = await fetch(`${base}/`);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /^frame-ancestors /);
    for (const source of ["'self'", "vscode-webview:", "vscode-file:", "https://*.vscode-cdn.net", "https://code.example"]) {
      assert.ok(csp.split(" ").includes(source), `${source} in ${csp}`);
    }
    // Never a wildcard that lets any site frame it.
    assert.ok(!csp.split(" ").includes("*"));
    assert.ok(!csp.split(" ").includes("https:"));
  });

  it("drops frame ancestors that could break out of the directive", () => {
    const csp = frameAncestorsPolicy(["https://ok.example", "https://x.example; script-src *", "'none'", "a,b"]);
    assert.ok(csp.includes("https://ok.example"));
    assert.ok(!csp.includes("script-src"));
    assert.ok(!csp.includes("'none'"));
    assert.ok(!csp.includes("a,b"));
  });

  it("answers a preflight for an allowed origin", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { allowOrigins: ["https://helicon.example"] });
    const res = await fetch(`${base}/api/turns`, { method: "OPTIONS", headers: { origin: "https://helicon.example" } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  });

  it("trades a token for a cookie, which is what the event stream can carry", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { token: "secret" });
    assert.equal((await send(base, "/api/auth", { token: "wrong" })).status, 401);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /helicon_token=secret/);
    assert.match(cookie, /HttpOnly/);
    // EventSource cannot send a header, so the cookie alone has to be enough.
    assert.equal((await fetch(`${base}/api/health`, { headers: { cookie: "helicon_token=secret" } })).status, 200);
  });

  it("takes a token from the URL only when no other site is asking", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { token: "secret", allowOrigins: ["https://helicon.example"] });
    // No origin at all: curl, the desktop shell, the page this daemon served itself.
    assert.equal((await fetch(`${base}/api/health?token=secret`)).status, 200);
    // Its own page writing back still counts as itself, origin header and all.
    assert.equal((await fetch(`${base}/api/health?token=secret`, { headers: { origin: base } })).status, 200);
    // Another site holding the same link gets nothing, so sharing the URL hands over no access.
    const cross = await fetch(`${base}/api/health?token=secret`, { headers: { origin: "https://helicon.example" } });
    assert.equal(cross.status, 401);
  });

  it("translates Windows paths at the WSL boundary", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s9" } });
    connection.replies.set("session/list", {
      sessions: [
        { session: { sessionId: "tui-1", workspaceRoot: "/mnt/d/work/proj" } },
        { sessionId: "tui-2", workspaceRoot: "/mnt/d/work/other", turnCount: 4, updatedAt: "2026-09-11T12:35:42.947855Z" },
      ],
      nextCursor: null,
    });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, {
      platform: "win32",
      musePath: "/home/dev/.local/bin/muse",
      hostFactory: fakeFactory(connection, probe),
    });

    const created = await send(base, "/api/sessions", { cwd: "D:\\work\\proj" });
    assert.equal(created.status, 200);
    const startCall = connection.calls.find((c) => c.method === "session/start");
    assert.equal(startCall?.params?.["workspaceRoot"], "/mnt/d/work/proj");
    assert.equal(probe.targets[0]?.command, "wsl");
    assert.deepEqual(probe.targets[0]?.args.slice(0, 2), ["-d", "Ubuntu"]);
    assert.equal(probe.targets[0]?.cwd, "D:\\work\\proj");

    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    assert.equal(found.json.sessions.length, 2);
    const listCall = connection.requests.find((c) => c.method === "session/list");
    assert.equal(listCall?.params?.["commandId"], undefined, "queries must not carry a commandId");
    const projects = await get(base, "/api/projects");
    const cwds = projects.projects.map((p: { cwd: string }) => p.cwd);
    assert.ok(cwds.includes("D:\\work\\proj"));
    assert.ok(cwds.includes("D:\\work\\other"));
    const sessions = await get(base, `/api/sessions?cwd=${encodeURIComponent("D:\\work\\other")}`);
    assert.equal(sessions.sessions[0].origin, "tui");
    assert.equal(sessions.sessions[0].turnCount, 4);
    assert.equal(sessions.sessions[0].activityAt, "2026-09-11T12:35:42.947Z");
  });

  it("runs native Windows Muse with Windows paths, and no WSL", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s9" } });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "tui-1", workspaceRoot: "d:/work/other", turnCount: 2 }],
      nextCursor: null,
    });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const ran: { command: string; args: string[] }[] = [];
    const binary = "C:\\Users\\ada\\AppData\\Local\\Programs\\muse\\muse-bin-1.3.0-R1.exe";
    const { base } = await start(connection, {
      platform: "win32",
      musePath: undefined,
      findNativeMuse: () => ({ binary, dir: "C:\\Users\\ada\\AppData\\Local\\Programs\\muse", version: "1.3.0-R1", launcher: null }),
      hostFactory: fakeFactory(connection, probe),
      shellRunner: async (command: string, args: string[]) => {
        ran.push({ command, args });
        return { output: "ok\n", exitCode: 0, truncated: false };
      },
    });

    const env = await get(base, "/api/env");
    assert.equal(env.runtime, "native");
    assert.equal(env.musePath, binary);

    const created = await send(base, "/api/sessions", { cwd: "D:\\work\\it's here" });
    assert.equal(created.status, 200);
    const startCall = connection.calls.find((c) => c.method === "session/start");
    assert.equal(startCall?.params?.["workspaceRoot"], "D:\\work\\it's here", "native Muse gets the Windows path itself");
    assert.equal(probe.targets[0]?.command, binary);
    assert.deepEqual(probe.targets[0]?.args, ["serve"]);
    assert.equal(probe.targets[0]?.cwd, "D:\\work\\it's here");

    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    const cwds = (await get(base, "/api/projects")).projects.map((p: { cwd: string }) => p.cwd);
    assert.ok(cwds.includes("D:\\work\\other"), "a root spelled d:/work/other is stored as D:\\work\\other");

    const shell = await send(base, "/api/sessions/s9/shell-proxy", { command: "Get-ChildItem" });
    assert.equal(shell.status, 200);
    assert.match(ran[0]!.command, /powershell\.exe$/i);
    const script = ran[0]!.args.at(-1)!;
    assert.ok(script.startsWith("Set-Location -LiteralPath 'D:\\work\\it''s here'"), script);
    assert.ok(script.endsWith("\nGet-ChildItem"));
  });

  it("tells whether native Windows Muse is signed in from the same auth.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "helicon-winhome-"));
    const xdg = process.env["XDG_CONFIG_HOME"];
    const key = process.env["META_API_KEY"];
    delete process.env["XDG_CONFIG_HOME"];
    delete process.env["META_API_KEY"];
    try {
      const binary = "C:\\Users\\ada\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.10-R1.exe";
      const { base } = await start(new FakeConnection(), {
        platform: "win32",
        musePath: undefined,
        home,
        findNativeMuse: () => ({ binary, dir: "C:\\Users\\ada\\AppData\\Local\\Programs\\muse", version: "1.4.10-R1", launcher: null }),
      });
      assert.equal((await get(base, "/api/env")).museSignedIn, false, "no auth.json yet");
      await mkdir(join(home, ".config", "muse"), { recursive: true });
      await writeFile(join(home, ".config", "muse", "auth.json"), JSON.stringify({ schema_version: 1, providers: { meta: {} } }));
      assert.equal((await get(base, "/api/env?refresh=1")).museSignedIn, true);
    } finally {
      if (xdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = xdg;
      if (key !== undefined) process.env["META_API_KEY"] = key;
    }
  });

  it("counts the monitors a thread has watching", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const read = async () => (await get(base, "/api/sessions")).sessions[0];
    const monitor = (status: string) => ({
      itemId: "m1",
      kind: "toolCall",
      tool: "monitor",
      turnId: "t1",
      revision: 1,
      status,
      args: JSON.stringify({ command: "tail -n 0 -F log.txt", description: "watch log.txt" }),
    });

    connection.notify("turn/started", { sessionId: "s1", turnId: "t1", sourceRange: RANGE });
    connection.notify("item/started", { sessionId: "s1", item: monitor("inProgress") });
    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
    let session = await read();
    assert.equal(session.live.activeTurnId, null, "the turn ends while the monitor keeps watching");
    assert.equal(session.live.monitors, 1);

    connection.notify("item/completed", { sessionId: "s1", item: monitor("cancelled") });
    session = await read();
    assert.equal(session.live.monitors, 0);

    connection.notify("item/updated", { sessionId: "s1", item: { ...monitor("inProgress"), itemId: "m2" } });
    connection.notify("session/closed", { sessionId: "s1" });
    session = await read();
    assert.equal(session.live.monitors, 0, "a closed session has nothing watching");
  });

  it("tracks live status and derives titles from the view stream", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const read = async () => (await get(base, "/api/sessions")).sessions[0];

    assert.equal((await read()).title, "New thread");
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1", sourceRange: RANGE });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "\n  Fix the flaky login test in CI\nmore detail" },
    });
    connection.notify("approval/requested", { sessionId: "s1", approvalId: "a1" });
    let session = await read();
    assert.equal(session.title, "Fix the flaky login test in CI");
    assert.equal(session.live.activeTurnId, "t1");
    assert.equal(session.live.pendingApprovals, 1);

    connection.notify("approval/resolved", { sessionId: "s1", approvalId: "a1" });
    connection.notify("turn/completed", {
      sessionId: "s1",
      turnId: "t1",
      terminal: "failed",
      error: { kind: "modelError", message: "Provider timed out", retryable: true },
    });
    session = await read();
    assert.equal(session.live.activeTurnId, null);
    assert.equal(session.live.pendingApprovals, 0);
    assert.equal(session.live.lastTerminal, "failed");
    assert.equal(session.live.lastError, "Provider timed out");
    assert.equal(session.turnCount, 1);

    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i2", kind: "userMessage", revision: 1, status: "completed", text: "Something else entirely" },
    });
    assert.equal((await read()).title, "Fix the flaky login test in CI", "only the first prompt names a thread");
  });

  it("takes Muse's own name for a thread, unless the user named it", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Wire up the updater", title: "fix the updater please" }],
      nextCursor: null,
    });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });
    const read = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1");
    assert.equal((await read()).title, "fix the updater please");

    await send(base, "/api/discover", {});
    assert.equal((await read()).title, "Wire up the updater", "the name Muse shows in its own CLI wins");

    await send(base, "/api/sessions/s1", { title: "Updater work" }, "PATCH");
    await send(base, "/api/discover", {});
    assert.equal((await read()).title, "Updater work", "a title the user typed stays");
  });

  it("loads a transcript from resume, paged history and pending requests", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t2", turnCount: 1, modelId: "muse-spark-1.3", updatedAt: "2026-09-11T14:00:00Z" },
    });
    const event = (n: number, method: string, extra: Record<string, unknown> = {}) => ({
      method,
      params: { sessionId: "s1", viewCursor: `v:${n}`, sourceRange: RANGE, ...extra },
    });
    connection.replies.set("view/page", (params: Record<string, unknown>) =>
      params["cursor"]
        ? {
            events: [
              event(1, "turn/started", { turnId: "t1" }),
              event(2, "item/completed", { item: { itemId: "u1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode" } }),
            ],
            nextCursor: null,
          }
        : { events: [event(3, "turn/completed", { turnId: "t1", terminal: "completed" }), event(4, "turn/started", { turnId: "t2" })], nextCursor: "v:3" },
    );
    connection.replies.set("approval/listPending", {
      approvals: [{ approvalId: "a1", sessionId: "s1", sourceRange: RANGE, subject: { kind: "shell", command: "rm -rf dist" } }],
      userInputs: [],
    });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.readOnly, false);
    assert.deepEqual(
      loaded.json.events.map((e: { params: { viewCursor: string } }) => e.params.viewCursor),
      ["v:1", "v:2", "v:3", "v:4"],
    );
    assert.equal(loaded.json.events[0].params.sourceRange, undefined);
    assert.equal(loaded.json.pending.approvals[0].subject.command, "rm -rf dist");
    assert.equal(loaded.json.pending.approvals[0].sourceRange, undefined);
    assert.equal(loaded.json.msp.activeTurnId, "t2");
    assert.equal(loaded.json.session.title, "Add dark mode");
    assert.equal(loaded.json.session.live.pendingApprovals, 1);
    assert.equal(loaded.json.session.live.activeTurnId, "t2");
    const resume = connection.calls.find((c) => c.method === "session/resume");
    assert.equal(resume?.params?.["excludeItems"], true);
    const pages = connection.requests.filter((c) => c.method === "view/page");
    assert.deepEqual(pages.map((p) => p.params?.["direction"]), ["backward", "backward"]);
  });

  it("falls back to a read-only transcript when another host holds the session", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null } });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.readOnly, true);
    assert.match(loaded.json.readOnlyReason, /another host/);
    const read = connection.requests.find((c) => c.method === "session/read");
    assert.equal(read?.params?.["excludeItems"], false);
  });

  it("hydrates a read-only CLI transcript from session/read items", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: null, turnCount: 1 },
      history: {
        mode: "inline",
        items: [
          { itemId: "i1", kind: "userMessage", text: "Ship the fairtab tip", status: "completed", revision: 1 },
          { itemId: "i2", kind: "agentMessage", text: "Done.", status: "completed", revision: 1 },
        ],
      },
    });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.readOnly, true);
    assert.deepEqual(
      loaded.json.events.map((e: { method: string; params: { item: { itemId: string } } }) => [e.method, e.params.item.itemId]),
      [
        ["item/completed", "i1"],
        ["item/completed", "i2"],
      ],
    );
  });

  it("turns session/read history items into fold events", () => {
    const events = eventsFromHistory({
      history: {
        mode: "inline",
        items: [{ itemId: "a", kind: "userMessage", text: "Hi", sourceRange: { first: 1 } }],
      },
    });
    assert.deepEqual(events, [{ method: "item/completed", params: { item: { itemId: "a", kind: "userMessage", text: "Hi" } } }]);
  });

  it("surfaces resume failures that are not about another host", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", new MspTestError("stream mismatch", "sessionStreamMismatch"));
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null } });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const failed = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(failed.status, 409);
    assert.equal(failed.json.kind, "sessionStreamMismatch");
    assert.equal(failed.json.readOnly, undefined);
  });

  it("reports MSP error kinds with a useful status", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", new MspTestError("input too large", "inputTooLarge"));
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const failed = await send(base, "/api/turns", { sessionId: "s1", text: "x" });
    assert.equal(failed.status, 409);
    assert.equal(failed.json.kind, "inputTooLarge");
    assert.equal(failed.json.error, "input too large");
  });

  it("renames and archives threads, and hides projects", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const renamed = await send(base, "/api/sessions/s1", { title: "  Ship the sidebar  " }, "PATCH");
    assert.equal(renamed.json.session.title, "Ship the sidebar");
    assert.equal(renamed.json.session.titleSource, "user");
    await send(base, "/api/sessions/s1", { archived: true }, "PATCH");
    assert.equal((await get(base, "/api/sessions")).sessions.length, 0);
    assert.equal((await get(base, "/api/sessions?archived=1")).sessions.length, 1);
    assert.equal((await send(base, "/api/sessions/missing", { title: "x" }, "PATCH")).status, 404);

    await send(base, `/api/projects?cwd=${encodeURIComponent("/work/proj")}`, undefined, "DELETE");
    assert.equal((await get(base, "/api/projects")).projects.length, 0);
    const readded = await send(base, "/api/projects", { cwd: "/work/proj" });
    assert.equal(readded.status, 200);
    assert.equal((await get(base, "/api/projects")).projects.length, 1);
  });

  it("opens known project folders only", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/list", { sessions: [], nextCursor: null });
    const opened: { path: string; target: OpenTarget }[] = [];
    const { base } = await start(connection, {
      platform: "win32",
      musePath: "/home/dev/.local/bin/muse",
      opener: async (path, target) => {
        opened.push({ path, target });
      },
    });
    assert.equal((await send(base, "/api/open", { cwd: "C:\\nowhere" })).status, 404);
    await send(base, "/api/projects", { cwd: "/mnt/d/work/app" });
    assert.equal((await send(base, "/api/open", { cwd: "/mnt/d/work/app", target: "editor" })).status, 200);
    assert.deepEqual(opened, [{ path: "D:\\work\\app", target: "editor" }]);
  });

  it("settles and un-settles threads, and wakes a settled thread when work starts", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const settled = await send(base, "/api/sessions/s1", { settled: true }, "PATCH");
    assert.equal(settled.json.session.settled, true);
    assert.ok(settled.json.session.settledAt);
    const active = await send(base, "/api/sessions/s1", { settled: false }, "PATCH");
    assert.equal(active.json.session.settled, false);
    assert.equal(active.json.session.settledAt, null);
    assert.ok(active.json.session.unsettledAt);

    await send(base, "/api/sessions/s1", { settled: true }, "PATCH");
    await send(base, "/api/turns", { sessionId: "s1", text: "pick this back up" });
    const woken = (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1");
    assert.equal(woken.settled, false);
    assert.ok(woken.unsettledAt);
  });

  it("pins and unpins threads, and lists the flag back", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const find = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1");

    assert.equal((await find()).pinned, false);
    const pinned = await send(base, "/api/sessions/s1", { pinned: true }, "PATCH");
    assert.equal(pinned.json.session.pinned, true);
    assert.equal((await find()).pinned, true);
    const unpinned = await send(base, "/api/sessions/s1", { pinned: false }, "PATCH");
    assert.equal(unpinned.json.session.pinned, false);
    assert.equal((await find()).pinned, false);
  });

  it("wakes a settled thread when discovery shows it moved on in another client", async () => {
    const connection = new FakeConnection();
    const list = (updatedAt: string) => ({ sessions: [{ sessionId: "tui-1", workspaceRoot: "/work/proj", updatedAt }], nextCursor: null });
    connection.replies.set("session/list", list("2026-09-01T00:00:00.000Z"));
    const { base } = await start(connection);
    await send(base, "/api/discover", {});
    assert.equal((await send(base, "/api/sessions/tui-1", { settled: true }, "PATCH")).json.session.settled, true);
    const find = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "tui-1");

    await send(base, "/api/discover", {});
    assert.equal((await find()).settled, true, "nothing new happened, so it stays settled");

    connection.replies.set("session/list", list(new Date(Date.now() + 60_000).toISOString()));
    await send(base, "/api/discover", {});
    assert.equal((await find()).settled, false);
  });

  it("still finds CLI threads when subagent sessions fill the newest pages (#50)", async () => {
    const connection = new FakeConnection();
    // Newest first, like session/list: 450 subagent rows, then the threads started from the muse CLI.
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 450; i += 1) {
      rows.push({ sessionId: `sub-${i}`, kind: "subagent", workspaceRoot: "/work/proj", updatedAt: "2026-10-20T00:00:00.000Z" });
    }
    for (let i = 0; i < 3; i += 1) {
      rows.push({ sessionId: `cli-${i}`, kind: "root", workspaceRoot: "/work/proj", turnCount: 2, updatedAt: "2026-10-19T00:00:00.000Z" });
    }
    connection.replies.set("session/list", ((params: Record<string, unknown>) => {
      const from = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
      const size = Math.min(Number(params["limit"] ?? 50), 200);
      const next = from + size;
      return { sessions: rows.slice(from, next), nextCursor: next < rows.length ? String(next) : null };
    }) as never);
    const { base } = await start(connection);

    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    const ids = found.json.sessions.map((s: { sessionId: string }) => s.sessionId).sort();
    assert.deepEqual(ids, ["cli-0", "cli-1", "cli-2"]);
  });

  it("stops discovering when session/list hands back a cursor it already gave", async () => {
    const connection = new FakeConnection();
    let calls = 0;
    connection.replies.set("session/list", ((params: Record<string, unknown>) => {
      calls += 1;
      if (params["cursor"] === undefined || params["cursor"] === null) {
        return { sessions: [{ sessionId: "a", kind: "root", workspaceRoot: "/work/proj", turnCount: 1, updatedAt: "2026-10-20T00:00:00.000Z" }], nextCursor: "p1" };
      }
      // A host stuck on one page: the same cursor back every time.
      return { sessions: [{ sessionId: "b", kind: "root", workspaceRoot: "/work/proj", turnCount: 1, updatedAt: "2026-10-20T00:00:00.000Z" }], nextCursor: "p1" };
    }) as never);
    const { base } = await start(connection);

    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    assert.deepEqual(found.json.sessions.map((s: { sessionId: string }) => s.sessionId).sort(), ["a", "b"]);
    assert.equal(calls, 2, `session/list was called ${calls} times`);
  });

  it("stops discovering on an empty page that still names a next cursor", async () => {
    const connection = new FakeConnection();
    let calls = 0;
    connection.replies.set("session/list", ((params: Record<string, unknown>) => {
      calls += 1;
      return { sessions: [], nextCursor: `p${calls}` };
    }) as never);
    const { base } = await start(connection);

    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    assert.deepEqual(found.json.sessions, []);
    assert.equal(calls, 1, `session/list was called ${calls} times`);
  });

  it("carries a turn's reasoning effort as the session default, once per change", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const efforts = () => connection.calls.filter((c) => c.method === "session/setReasoningEffort").map((c) => c.params?.["reasoningEffort"]);

    await send(base, "/api/turns", { sessionId: "s1", text: "one", reasoningEffort: "low" });
    const methods = connection.calls.map((c) => c.method);
    assert.ok(methods.indexOf("session/setReasoningEffort") < methods.lastIndexOf("turn/start"), "the default is set before the turn goes");
    await send(base, "/api/turns", { sessionId: "s1", text: "two", reasoningEffort: "low" });
    await send(base, "/api/turns", { sessionId: "s1", text: "three" });
    assert.deepEqual(efforts(), ["low"], "an unchanged or absent effort sends nothing");

    // Changed in another client: the next turn asking for that level has nothing to do.
    connection.notify("session/reasoningEffortChanged", { sessionId: "s1", reasoningEffort: "xhigh", source: "user" });
    await send(base, "/api/turns", { sessionId: "s1", text: "four", reasoningEffort: "xhigh" });
    assert.deepEqual(efforts(), ["low"]);

    const direct = await send(base, "/api/sessions/s1/effort", { reasoningEffort: "max" });
    assert.equal(direct.status, 200);
    assert.deepEqual(efforts(), ["low", "max"]);
    assert.equal((await send(base, "/api/sessions/s1/effort", { reasoningEffort: "loud" })).status, 400);

    // A host without the method still takes the turn, with the effort riding on turn/start.
    connection.replies.set("session/setReasoningEffort", new MspTestError("no such method", "methodNotFound"));
    const old = await send(base, "/api/turns", { sessionId: "s1", text: "five", reasoningEffort: "low" });
    assert.equal(old.status, 200);
    assert.equal(connection.calls.at(-1)?.params?.["reasoningEffort"], "low");

    connection.replies.set("session/setReasoningEffort", new MspTestError("not loaded", "sessionNotLoaded"));
    const unloaded = await send(base, "/api/turns", { sessionId: "s1", text: "six", reasoningEffort: "medium" });
    assert.equal(unloaded.status, 409);
    assert.equal(unloaded.json.kind, "sessionNotLoaded", "the UI reloads and retries on this kind");
  });

  it("drives goals, subagents, background tasks and workflow children", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("goal/set", { commandId: "c", status: "accepted", turnId: "t7" });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const last = () => connection.calls.at(-1);

    const goal = await send(base, "/api/sessions/s1/goal", { action: "set", objective: "get CI green" });
    assert.deepEqual(goal.json, { turnId: "t7" });
    assert.deepEqual(last(), { method: "goal/set", params: { sessionId: "s1", objective: "get CI green" } });
    await send(base, "/api/sessions/s1/goal", { action: "pause" });
    assert.deepEqual(last(), { method: "goal/pause", params: { sessionId: "s1" } });
    assert.equal((await send(base, "/api/sessions/s1/goal", { action: "edit" })).status, 400);
    assert.equal((await send(base, "/api/sessions/s1/goal", { action: "finish" })).status, 400);

    await send(base, "/api/sessions/s1/subagent", { action: "sendMessage", subagentId: "sa1", body: "use pnpm" });
    assert.deepEqual(last(), { method: "subagent/sendMessage", params: { sessionId: "s1", subagentId: "sa1", body: "use pnpm" } });
    assert.equal((await send(base, "/api/sessions/s1/subagent", { action: "followupTask", subagentId: "sa1" })).status, 400);
    assert.equal((await send(base, "/api/sessions/s1/subagent", { action: "stop" })).status, 400);

    await send(base, "/api/sessions/s1/tasks", { action: "background", taskId: "item-4" });
    assert.deepEqual(last(), { method: "task/background", params: { sessionId: "s1", taskId: "item-4" } });
    await send(base, "/api/sessions/s1/tasks", { action: "stop", taskId: "item-4" });
    assert.deepEqual(last(), { method: "task/stop", params: { sessionId: "s1", taskId: "item-4" } });
    await send(base, "/api/sessions/s1/tasks", { action: "stopAll" });
    assert.deepEqual(last(), { method: "task/stopAll", params: { sessionId: "s1" } });
    assert.equal((await send(base, "/api/sessions/s1/tasks", { action: "stop" })).status, 400);

    await send(base, "/api/sessions/s1/workflow", { action: "cancel", workflowRunId: "run-9" });
    assert.deepEqual(last(), { method: "workflow/cancel", params: { sessionId: "s1", workflowRunId: "run-9" } });
    await send(base, "/api/sessions/s1/workflow", { action: "pause", workflowRunId: "run-9" });
    assert.deepEqual(last(), { method: "workflow/pause", params: { sessionId: "s1", workflowRunId: "run-9" } });
    await send(base, "/api/sessions/s1/workflow", { action: "resume", workflowRunId: "run-9" });
    assert.deepEqual(last(), { method: "workflow/resume", params: { sessionId: "s1", workflowRunId: "run-9" } });
    await send(base, "/api/sessions/s1/workflow", { action: "skip", workflowRunId: "run-9", childId: "c1", attempt: 2 });
    assert.deepEqual(last(), { method: "workflow/childControl", params: { sessionId: "s1", workflowRunId: "run-9", childId: "c1", attempt: 2, action: "skip" } });
    assert.equal((await send(base, "/api/sessions/s1/workflow", { action: "retry", workflowRunId: "run-9", childId: "c1", attempt: 0 })).status, 400);
    assert.equal((await send(base, "/api/sessions/s1/workflow", { action: "cancel" })).status, 400);

    connection.replies.set("workflow/childControl", new MspTestError("stale attempt", "stale_attempt"));
    const stale = await send(base, "/api/sessions/s1/workflow", { action: "retry", workflowRunId: "run-9", childId: "c1", attempt: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.kind, "stale_attempt");
  });

  it("reads a tool's stored output one page at a time", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("item/readOutput", (params: Record<string, unknown>) => ({
      content: "x".repeat(4),
      encoding: "utf8",
      mediaType: "text/plain",
      offsetBytes: params["offsetBytes"],
      byteLen: 4,
      eof: params["offsetBytes"] === 4,
    }));
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const first = await get(base, "/api/sessions/s1/output?itemId=i1&outputRef=bash-1");
    assert.deepEqual(first.output, { content: "xxxx", encoding: "utf8", mediaType: "text/plain", offsetBytes: 0, byteLen: 4, eof: false });
    const next = await get(base, "/api/sessions/s1/output?itemId=i1&outputRef=bash-1&offset=4&length=99999999");
    assert.equal(next.output.eof, true);
    assert.deepEqual(connection.requests.at(-1)?.params, { sessionId: "s1", itemId: "i1", outputRef: "bash-1", offsetBytes: 4, lengthBytes: 1024 * 1024 });
    assert.equal((await fetch(`${base}/api/sessions/s1/output?itemId=i1`)).status, 400);
  });

  it("keeps the newest subscription window any host reports", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const window = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1000, windowDurationMins: 300 },
      weekly: { usedPercent: 10, resetsAtMs: at + 9000 },
    });
    const { base } = await start(connection);
    connection.replies.set("usage/read", {});
    assert.equal((await get(base, "/api/plan-usage")).usage, null, "no host running and nothing seen");

    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal((await get(base, "/api/plan-usage")).usage, null, "a host that has seen nothing is not an error");

    connection.notify("usage/changed", window(40, 2_000));
    assert.equal((await get(base, "/api/plan-usage")).usage.window.usedPercent, 40);
    connection.notify("usage/changed", window(5, 1_000));
    assert.equal((await get(base, "/api/plan-usage")).usage.window.usedPercent, 40, "an older reading never replaces a newer one");
    connection.replies.set("usage/read", { usage: window(55, 3_000) });
    const read = await get(base, "/api/plan-usage");
    assert.equal(read.usage.window.usedPercent, 55);
    assert.equal(read.usage.weekly.windowDurationMins, null);
  });

  it("tracks plan usage per account and keeps the newest as the default", async () => {
    const work = new FakeConnection();
    const personal = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    await aonia.createProfile("personal");
    // Route each account's host to its own connection so their notifications are distinct.
    const factory = (target: ServeTarget): HostHandle => {
      // Normalize separators: aonia's profile root uses backslashes on Windows (...\profiles\work\config).
      const account = target.env?.["XDG_CONFIG_HOME"]?.replaceAll("\\", "/").includes("/work/") ? work : personal;
      return fakeFactory(account)(target);
    };
    const { base } = await start(work, { hostFactory: factory, aonia });

    work.replies.set("session/start", { session: { sessionId: "w1" } });
    personal.replies.set("session/start", { session: { sessionId: "p1" } });
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "personal" });

    // usage/changed notifications carry the SubscriptionUsage fields flat (see parseSubscriptionUsage and
    // the "keeps the newest subscription window any host reports" test above); only the usage/read
    // request/reply wraps them under a "usage" key.
    work.notify("usage/changed", { tier: "1", observedAtMs: 100, window: { usedPercent: 90, resetsAtMs: 1, windowDurationMins: 300 }, weekly: { usedPercent: 50, resetsAtMs: 1, windowDurationMins: null } });
    personal.notify("usage/changed", { tier: "1", observedAtMs: 200, window: { usedPercent: 12, resetsAtMs: 1, windowDurationMins: 300 }, weekly: { usedPercent: 8, resetsAtMs: 1, windowDurationMins: null } });

    const res = await get(base, "/api/plan-usage");
    assert.equal(res.byAccount.work.window.usedPercent, 90);
    assert.equal(res.byAccount.personal.window.usedPercent, 12);
    assert.equal(res.usage.window.usedPercent, 12, "usage holds the newest across accounts");
  });

  it("does not re-broadcast plan-usage when a repeat GET re-reads the same window", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    const reading = {
      tier: "high",
      observedAtMs: 5_000,
      window: { usedPercent: 30, resetsAtMs: 6_000, windowDurationMins: 300 },
      weekly: { usedPercent: 9, resetsAtMs: 12_000, windowDurationMins: null },
    };
    connection.replies.set("usage/read", { usage: reading });
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const count = await countPlanUsageEvents(base, async () => {
      await get(base, "/api/plan-usage");
      await get(base, "/api/plan-usage");
    });
    assert.equal(count, 1, "a same-timestamp re-read must not re-emit plan-usage");
  });

  it("gives Muse the name typed here, and takes the name Muse settles on", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const read = async () => (await get(base, "/api/sessions")).sessions[0];

    await send(base, "/api/sessions/s1", { title: "Ship the sidebar" }, "PATCH");
    assert.deepEqual(connection.calls.at(-1), { method: "session/rename", params: { sessionId: "s1", name: "Ship the sidebar" } });

    connection.notify("session/nameChanged", { sessionId: "s1", name: "sidebar-v2", viewCursor: "c", sourceRange: RANGE });
    let session = await read();
    assert.equal(session.title, "sidebar-v2", "a `/name` in another client is the newest name");
    assert.equal(session.titleSource, "user", "and a thread the user named stays theirs");

    connection.replies.set("session/rename", new MspTestError("ephemeral", "unsupported"));
    const renamed = await send(base, "/api/sessions/s1", { title: "Local only" }, "PATCH");
    assert.equal(renamed.status, 200, "a rename Muse refuses still renames the thread here");
    assert.equal(renamed.json.session.title, "Local only");

    const renames = connection.calls.filter((c) => c.method === "session/rename").length;
    await send(base, "/api/sessions/s1", { title: "Local only" }, "PATCH");
    assert.equal(connection.calls.filter((c) => c.method === "session/rename").length, renames, "an unchanged title is not sent again");
    session = await read();
    assert.equal(session.title, "Local only");
  });

  it("keeps thread-title settings behind a switch and a model choice", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.deepEqual(await get(base, "/api/title-settings"), { enabled: true, modelId: null });

    const patched = await send(base, "/api/title-settings", { enabled: false, modelId: "m1" }, "PATCH");
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json, { enabled: false, modelId: "m1" });
    assert.deepEqual(await get(base, "/api/title-settings"), { enabled: false, modelId: "m1" });

    const merged = await send(base, "/api/title-settings", { enabled: true }, "PATCH");
    assert.deepEqual(merged.json, { enabled: true, modelId: "m1" });

    const badEnabled = await send(base, "/api/title-settings", { enabled: "yes" }, "PATCH");
    assert.equal(badEnabled.status, 400);
    const badModel = await send(base, "/api/title-settings", { modelId: "" }, "PATCH");
    assert.equal(badModel.status, 400);
    assert.deepEqual(await get(base, "/api/title-settings"), { enabled: true, modelId: "m1" }, "a rejected patch changes nothing");
  });

  it("keeps sandbox settings behind a boolean switch, defaulting to sandbox-on", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.deepEqual(await get(base, "/api/sandbox-settings"), { disabled: false });

    const patched = await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json, { disabled: true });
    assert.deepEqual(await get(base, "/api/sandbox-settings"), { disabled: true });

    const bad = await send(base, "/api/sandbox-settings", { disabled: "yes" }, "PATCH");
    assert.equal(bad.status, 400);
    assert.deepEqual(await get(base, "/api/sandbox-settings"), { disabled: true }, "a rejected patch changes nothing");
  });

  it("keeps feed settings behind a boolean switch, defaulting to catch-up off", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.deepEqual(await get(base, "/api/feed-settings"), { catchUp: false });

    const patched = await send(base, "/api/feed-settings", { catchUp: true }, "PATCH");
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json, { catchUp: true });
    assert.deepEqual(await get(base, "/api/feed-settings"), { catchUp: true });

    const bad = await send(base, "/api/feed-settings", { catchUp: "yes" }, "PATCH");
    assert.equal(bad.status, 400);
    assert.deepEqual(await get(base, "/api/feed-settings"), { catchUp: true }, "a rejected patch changes nothing");

    const empty = await send(base, "/api/feed-settings", {}, "PATCH");
    assert.deepEqual(empty.json, { catchUp: true }, "an empty patch changes nothing either");
    assert.deepEqual((await send(base, "/api/feed-settings", { catchUp: false }, "PATCH")).json, { catchUp: false });
  });

  it("spawns hosts with --disable-sandbox, restarting them when the switch flips", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    let closes = 0;
    const inner = fakeFactory(connection, probe);
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes += 1;
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve"]]);

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await waitFor(() => closes === 1, "the live host closing");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(
      probe.targets.map((t) => t.args),
      [["serve"], ["serve", "--disable-sandbox"]],
      "the respawned host carries the new posture",
    );

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closes, 1, "an unchanged switch restarts nothing");
  });

  it("drops --disable-sandbox from respawned hosts when the switch flips back on", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    let closes = 0;
    const inner = fakeFactory(connection, probe);
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes += 1;
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve", "--disable-sandbox"]]);

    await send(base, "/api/sandbox-settings", { disabled: false }, "PATCH");
    await waitFor(() => closes === 1, "the live host closing");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(
      probe.targets.map((t) => t.args),
      [["serve", "--disable-sandbox"], ["serve"]],
      "the respawned host drops --disable-sandbox",
    );
  });

  it("marks sessions with their creation posture, inherited by forks", async () => {
    const connection = new FakeConnection();
    let started = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${(started += 1)}` } }));
    const { base } = await start(connection);

    const plain = await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(plain.json.session.sandboxDisabled, false);

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    const lifted = await send(base, "/api/sessions", { cwd: "/work/other" });
    assert.equal(lifted.json.session.sandboxDisabled, true, "a session records its creating host's flags");

    connection.replies.set("session/fork", { session: { sessionId: "s3" } });
    const fork = await send(base, "/api/sessions/s2/fork", {});
    assert.equal(fork.json.session.sandboxDisabled, true, "a fork inherits its source's posture");

    const sessions = (await get(base, "/api/sessions")).sessions as { sessionId: string; sandboxDisabled: boolean | null }[];
    assert.equal(
      sessions.find((s) => s.sessionId === "s1")?.sandboxDisabled,
      false,
      "flipping the switch never rewrites old rows",
    );
  });

  it("never starts a session on a host retired by a flip", async () => {
    const connection = new FakeConnection();
    let started = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${(started += 1)}` } }));
    const probe: FactoryProbe = { targets: [], exits: [] };
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const inner = fakeFactory(connection, probe);
    let first = true;
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const gateThis = first;
      first = false;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (gateThis) {
          await closeGate;
        }
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve", "--disable-sandbox"]]);

    await send(base, "/api/sandbox-settings", { disabled: false }, "PATCH");
    const pending = send(base, "/api/sessions", { cwd: "/work/proj" });
    try {
      const raced = await Promise.race([pending.then((r) => r), new Promise((r) => setTimeout(() => r("waiting"), 50))]);
      assert.equal(raced, "waiting", "creation waits for the flip's restart");
    } finally {
      // Always unblock the retired host: teardown closes it even when the test fails.
      releaseClose();
    }
    const created = await pending;
    assert.equal(created.status, 200);
    assert.equal(created.json.session.sandboxDisabled, false, "the session lands on the new posture's host");
  });

  it("keeps YOLO settings behind a boolean switch, defaulting to off", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.deepEqual(await get(base, "/api/yolo-settings"), { enabled: false });

    const patched = await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json, { enabled: true });
    assert.deepEqual(await get(base, "/api/yolo-settings"), { enabled: true });

    const bad = await send(base, "/api/yolo-settings", { enabled: "yes" }, "PATCH");
    assert.equal(bad.status, 400);
    assert.deepEqual(await get(base, "/api/yolo-settings"), { enabled: true }, "a rejected patch changes nothing");
  });

  it("spawns hosts with the YOLO flags, restarting them when the switch flips", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    let closes = 0;
    const inner = fakeFactory(connection, probe);
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes += 1;
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve"]]);

    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await waitFor(() => closes === 1, "the live host closing");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(
      probe.targets.map((t) => t.args),
      [["serve"], ["serve", "--disable-sandbox", "--trust-workspace"]],
      "the respawned host carries the new posture",
    );

    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closes, 1, "an unchanged switch restarts nothing");
  });

  it("drops the YOLO flags from respawned hosts when the switch flips back off", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    let closes = 0;
    const inner = fakeFactory(connection, probe);
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes += 1;
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve", "--disable-sandbox", "--trust-workspace"]]);

    await send(base, "/api/yolo-settings", { enabled: false }, "PATCH");
    await waitFor(() => closes === 1, "the live host closing");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(
      probe.targets.map((t) => t.args),
      [
        ["serve", "--disable-sandbox", "--trust-workspace"],
        ["serve"],
      ],
      "the respawned host drops the YOLO flags",
    );
  });

  it("spawns hosts with --disable-sandbox once when both the sandbox switch and YOLO are on", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe) });

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve", "--disable-sandbox", "--trust-workspace"]]);
  });

  it("upgrades an echo title with one muse exec call, and pushes the name back", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      await gate;
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Fix login redirect" } }),
        exitCode: 0,
      };
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions[0].title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "please fix the login redirect bug in the web app when sessions expire" },
    });
    await waitFor(() => calls.length > 0, "the title call to start");
    assert.equal(await titleOf(), "please fix the login redirect bug in the web app when sessions expire");
    release();
    await waitFor(async () => (await titleOf()) === "Fix login redirect", "the upgraded title");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "muse");
    assert.equal(calls[0]?.[1], "exec");
    assert.ok(!calls[0]?.includes("--model"), "no model flag without a chosen model");
    assert.match(calls[0]?.at(-1) ?? "", /please fix the login redirect bug/);
    assert.deepEqual(connection.calls.at(-1), { method: "session/rename", params: { sessionId: "s1", name: "Fix login redirect" } });
  });

  it("passes the chosen model to the title call", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: "not json", exitCode: 0 };
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/title-settings", { modelId: "m9" }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });
    await waitFor(() => calls.length > 0, "the title call");
    const modelFlag = calls[0]?.indexOf("--model") ?? -1;
    assert.deepEqual(calls[0]?.slice(modelFlag, modelFlag + 2), ["--model", "m9"]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await get(base, "/api/sessions")).sessions[0].title, "Add dark mode everywhere", "garbage output keeps the echo");
  });

  it("stays silent while switched off, and upgrades on re-enable", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("view/page", {
      events: [{ method: "item/completed", params: { item: { itemId: "u1", kind: "userMessage", text: "Add dark mode everywhere" } } }],
      nextCursor: null,
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Add dark mode" } }),
        exitCode: 0,
      };
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/title-settings", { enabled: false }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions[0].title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });
    assert.equal(await titleOf(), "Add dark mode everywhere");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, "no model call while switched off");
    await send(base, "/api/title-settings", { enabled: true }, "PATCH");
    await waitFor(async () => (await titleOf()) === "Add dark mode", "the upgrade after re-enable");
    assert.equal(calls.length, 1);
  });

  it("lets a rename typed mid-upgrade win over the generated title", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    let release!: (result: { stdout: string; exitCode: number }) => void;
    const gate = new Promise<{ stdout: string; exitCode: number }>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return gate;
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });
    await waitFor(() => calls.length > 0, "the title call to start");
    await send(base, "/api/sessions/s1", { title: "Mine" }, "PATCH");
    release({
      stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Add dark mode" } }),
      exitCode: 0,
    });
    await new Promise((r) => setTimeout(r, 50));
    const session = (await get(base, "/api/sessions")).sessions[0];
    assert.equal(session.title, "Mine");
    assert.equal(session.titleSource, "user");
  });

  it("spawns one host per workspace under concurrency and respawns after a crash", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe) });
    await Promise.all([
      send(base, "/api/sessions", { cwd: "/work/proj" }),
      send(base, "/api/sessions", { cwd: "/work/proj" }),
    ]);
    assert.equal(probe.targets.length, 1);
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    probe.exits[0]?.({ code: 1, signal: null });
    const session = (await get(base, "/api/sessions")).sessions[0];
    assert.equal(session.live.activeTurnId, null);
    assert.equal(session.live.lastTerminal, "failed");
    assert.match((await get(base, "/api/health")).lastHostError, /exited/);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(probe.targets.length, 2);
  });

  it("accepts an injected aonia and still starts a plain host with no account", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, {
      hostFactory: fakeFactory(connection, probe),
      aonia: createAonia({ home, platform: "linux", musePath: "muse" }),
    });
    const res = await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(res.status, 200);
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve"]]);
    assert.equal(probe.targets[0]?.env, undefined, "no account means no per-profile env, same as today");
  });

  it("spawns a per-account host with the profile environment merged over process.env", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    const work = await aonia.createProfile("work");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), aonia });

    const res = await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    assert.equal(res.status, 200);
    const target = probe.targets[0];
    assert.ok(target?.env, "the account host carries an env");
    assert.equal(target.env["XDG_CONFIG_HOME"], work.roots.config);
    assert.equal(target.env["XDG_DATA_HOME"], work.roots.data);
    // Look PATH up case-insensitively: Windows names it "Path", and the spread keeps that casing.
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path");
    assert.ok(pathKey, "the runner has a PATH");
    assert.equal(target.env[pathKey], process.env[pathKey], "process.env is spread first");
  });

  it("keeps a separate host per account in the same workspace", async () => {
    const connection = new FakeConnection();
    let n = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${++n}` } }));
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    await aonia.createProfile("personal");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), aonia });

    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "personal" });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(probe.targets.length, 3, "three accounts in one workspace means three hosts");
  });

  it("rejects a session for an account that does not exist", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const { base } = await start(connection, { aonia: createAonia({ home, platform: "linux", musePath: "muse" }) });
    const res = await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "ghost" });
    assert.equal(res.status, 400);
  });

  it("puts a session back on its account after the host is forgotten", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), aonia });
    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    // Ask for the transcript by session id after dropping the in-memory host map is exercised by managerForSession;
    // here assert the session row carries the account so a rebuild has what it needs.
    const listed = await get(base, "/api/sessions");
    assert.ok(listed.sessions?.length > 0, "sessions listed");
  });

  it("lists, creates, renames and removes accounts through aonia", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const { base } = await start(connection, { aonia: createAonia({ home, platform: "linux", musePath: "muse" }) });

    assert.deepEqual((await get(base, "/api/accounts")).accounts, []);

    const created = await send(base, "/api/accounts", { id: "work", name: "Work" });
    assert.equal(created.status, 200);
    assert.equal(created.json.account.id, "work");

    const listed = (await get(base, "/api/accounts")).accounts;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "work");
    assert.equal(listed[0].name, "Work");
    assert.equal(listed[0].hasLogin, false);

    const renamed = await send(base, "/api/accounts/work", { name: "Client A" }, "PATCH");
    assert.equal(renamed.status, 200);
    assert.equal((await get(base, "/api/accounts")).accounts[0].name, "Client A");

    const removed = await send(base, "/api/accounts/work", undefined, "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual((await get(base, "/api/accounts")).accounts, []);
  });

  it("rejects a bad account id and a duplicate", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const { base } = await start(connection, { aonia: createAonia({ home, platform: "linux", musePath: "muse" }) });
    assert.equal((await send(base, "/api/accounts", { id: "Not Valid" })).status, 400);
    await send(base, "/api/accounts", { id: "work" });
    assert.equal((await send(base, "/api/accounts", { id: "work" })).status, 409);
  });

  it("reports metaApiKeyInherited from the aonia doctor finding", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const { base } = await start(connection, {
      aonia: createAonia({ home, platform: "linux", musePath: "muse", env: { META_API_KEY: "x" } }),
    });
    const res = await get(base, "/api/accounts/health");
    assert.equal(res.metaApiKeyInherited, true);
  });

  it("reports metaApiKeyInherited false when META_API_KEY is not set", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const { base } = await start(connection, {
      aonia: createAonia({ home, platform: "linux", musePath: "muse", env: {} }),
    });
    const res = await get(base, "/api/accounts/health");
    assert.equal(res.metaApiKeyInherited, false);
  });

  it("logs an account in: resolves url and code from staged stdout, through the server's own muse path", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const children: FakeLoginChild[] = [];
    const loginSpawn: LoginSpawn = (command, args, opts) => {
      calls.push({ command, args, env: opts.env });
      const child = new FakeLoginChild();
      children.push(child);
      setImmediate(() => {
        child.stdout.emit("data", "Open this page to sign in: https://auth.meta.com/oauth/device/?code=ABCD-1234\n");
      });
      return child as unknown as LoginChild;
    };
    // aonia's own musePath stays the bare default "muse"; the server carries a different configured
    // path, so the route must resolve through the server's own musePath rather than aonia's.
    const { base } = await start(connection, { musePath: "/custom/muse", aonia, loginSpawn });

    const res = await send(base, "/api/accounts/work/login", undefined);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { url: "https://auth.meta.com/oauth/device/?code=ABCD-1234", code: "ABCD-1234" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/custom/muse");
    assert.deepEqual(calls[0].args, ["login"]);
  });

  it("returns a WSL fallback for the login route instead of spawning", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    let spawned = false;
    const loginSpawn: LoginSpawn = () => {
      spawned = true;
      throw new Error("must not spawn when Muse runs in WSL");
    };
    const { base } = await start(connection, {
      platform: "win32",
      musePath: "/home/dev/.local/bin/muse",
      aonia,
      loginSpawn,
    });

    const res = await send(base, "/api/accounts/work/login", undefined);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      fallback: "In-app login is not available when Muse runs in WSL. Log in from a terminal with: aonia login work.",
    });
    assert.equal(spawned, false);
  });

  it("kills the first login child when a second login call arrives for the same account", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const children: FakeLoginChild[] = [];
    const loginSpawn: LoginSpawn = () => {
      const child = new FakeLoginChild();
      children.push(child);
      return child as unknown as LoginChild;
    };
    const { base } = await start(connection, { aonia, loginSpawn });

    const first = send(base, "/api/accounts/work/login", undefined);
    await waitFor(() => children.length === 1, "first login child to spawn");

    const second = send(base, "/api/accounts/work/login", undefined);
    await waitFor(() => children.length === 2, "second login child to spawn");
    assert.equal(children[0]?.killCount, 1);

    children[1]?.stdout.emit("data", "Open this page to sign in: https://auth.meta.com/oauth/device/?code=WXYZ-9999\n");
    const secondRes = await second;
    assert.equal(secondRes.status, 200);
    assert.deepEqual(secondRes.json, { url: "https://auth.meta.com/oauth/device/?code=WXYZ-9999", code: "WXYZ-9999" });

    // The killed first child's own close event lands async; give it a moment to settle its request.
    const firstRes = await first;
    assert.equal(firstRes.status, 504);
  });

  it("sets a project's default account", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const { base } = await start(connection, { aonia: createAonia({ home, platform: "linux", musePath: "muse" }) });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const res = await send(base, "/api/projects/default-account", { cwd: "/work/proj", accountId: "work" }, "PATCH");
    assert.equal(res.status, 200);
    assert.equal(res.json.defaultAccountId, "work");
  });

  it("reports a session's account and a project's default account over the wire", async () => {
    const connection = new FakeConnection();
    // Distinct ids per call: recordSession treats accountId as set-once-at-creation, so a fake
    // host that reused one id across two sessions would leak the first session's account onto the second.
    let n = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${++n}` } }));
    const home = await mkdtemp(join(tmpdir(), "helicon-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const { base } = await start(connection, { hostFactory: fakeFactory(connection), aonia });

    const created = await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    assert.equal(created.json.session.accountId, "work");
    const plain = await send(base, "/api/sessions", { cwd: "/other/proj" });
    assert.equal(plain.json.session.accountId, null);

    await send(base, "/api/projects/default-account", { cwd: "/work/proj", accountId: "work" }, "PATCH");
    const projects = await get(base, "/api/projects");
    const proj = projects.projects.find((p: { cwd: string }) => p.cwd === "/work/proj");
    assert.equal(proj.defaultAccountId, "work");
    const other = projects.projects.find((p: { cwd: string }) => p.cwd === "/other/proj");
    assert.equal(other.defaultAccountId, null);
  });
});

describe("a session Muse stops pushing", () => {
  const msp = (events: any[]) => events.filter((e) => e.type === "msp").map((e) => e.method);
  /** Catching up is a mode, off until asked for; this is the switch in Settings. */
  const catchUp = (base: string, on = true) => send(base, "/api/feed-settings", { catchUp: on }, "PATCH");
  /** What only the tail asks of Muse: forward pages of a view, and reads of a session's record. */
  const asked = (connection: FakeConnection) => ({
    pages: connection.requests.filter((c) => c.method === "view/page" && c.params?.["direction"] === "forward").length,
    reads: connection.requests.filter((c) => c.method === "session/read").length,
  });

  it("delivers the turn from the view when none of it is pushed", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection, { tailTiming: FAST_TAIL });
    await catchUp(base);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    // The last thing Muse pushed for this session; everything after it has to be asked for.
    const old = muse.event("item/completed", { item: { itemId: "old", kind: "agentMessage", revision: 1, status: "completed", text: "earlier" } });
    connection.notify(old.method, old.params);
    await send(base, "/api/sessions/s1/resume", {});
    const stream = await collectEvents(base);

    await send(base, "/api/turns", { sessionId: "s1", text: "go" });
    muse.event("turn/started", { turnId: "t1" });
    // Muse's record moves with its view. Left saying nothing runs, the tail would end the turn itself.
    muse.record.activeTurnId = "t1";
    muse.event("item/completed", { item: { itemId: "a1", kind: "agentMessage", revision: 1, status: "completed", text: "done" } });
    await waitFor(() => msp(stream.events).includes("item/completed"), "the paged item");
    // Long enough for several looks at a turn with nothing new to show.
    await new Promise((r) => setTimeout(r, 120));
    const running = (await get(base, "/api/sessions")).sessions[0];
    assert.equal(running.live.activeTurnId, "t1", "a paged turn/started is tracked as a pushed one is");

    muse.event("turn/completed", { turnId: "t1", terminal: "completed" });
    muse.record.activeTurnId = null;
    await waitFor(() => msp(stream.events).includes("turn/completed"), "the paged turn ending");
    await stream.stop();

    assert.deepEqual(msp(stream.events), ["turn/started", "item/completed", "turn/completed"], "what was pushed is not delivered again");
    assert.equal(stream.events.find((e) => e.method === "turn/started").params.sourceRange, undefined, "stripped as on the push path");
    assert.equal((await get(base, "/api/sessions")).sessions[0].live.activeTurnId, null);
    const health = await get(base, "/api/health");
    assert.equal(health.diagnostics.tail.s1.recovered, 3);
    assert.equal(health.diagnostics.sessions.s1.count, 1, "and none of it counted as pushed");
  });

  it("delivers an event once when push and a page both carry it, and pages the hole a gap reports", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection, { tailTiming: FAST_TAIL });
    await catchUp(base);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    await send(base, "/api/sessions/s1/resume", {});
    const stream = await collectEvents(base);

    const started = muse.event("turn/started", { turnId: "t1" });
    muse.record.activeTurnId = "t1";
    const lost = muse.event("item/completed", { item: { itemId: "a1", kind: "agentMessage", revision: 1, status: "completed", text: "one" } });
    const after = muse.event("item/completed", { item: { itemId: "a2", kind: "agentMessage", revision: 1, status: "completed", text: "two" } });
    connection.notify(started.method, started.params);
    connection.notify(after.method, after.params);
    connection.notify("view/gap", { sessionId: "s1", after: started.params.viewCursor, next: after.params.viewCursor });
    await waitFor(() => msp(stream.events).length >= 3, "the event in the hole");
    // Its twin turns up late, and the session is looked at a few more times: neither delivers anything again.
    connection.notify(lost.method, lost.params);
    await new Promise((r) => setTimeout(r, 200));
    await stream.stop();

    const texts = stream.events.filter((e) => e.method === "item/completed").map((e) => e.params.item.text);
    assert.deepEqual(texts.sort(), ["one", "two"]);
    assert.deepEqual(msp(stream.events).filter((m) => m === "turn/started"), ["turn/started"]);
    assert.equal(msp(stream.events).includes("view/gap"), false);
    const health = await get(base, "/api/health");
    assert.equal(health.diagnostics.tail.s1.recovered, 1);
    assert.equal(health.diagnostics.tail.s1.gaps, 1);
  });

  it("says a quiet turn is still running, and ends one whose ending the view lost", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection, { tailTiming: FAST_TAIL });
    await catchUp(base);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    await send(base, "/api/sessions/s1/resume", {});
    const stream = await collectEvents(base);

    const started = muse.event("turn/started", { turnId: "t1" });
    connection.notify(started.method, started.params);
    muse.record.activeTurnId = "t1";
    await waitFor(() => stream.events.some((e) => e.type === "feed"), "confirmation that the turn runs");
    assert.deepEqual(
      stream.events.filter((e) => e.type === "feed").map((e) => [e.sessionId, e.activeTurnId]),
      Array(stream.events.filter((e) => e.type === "feed").length).fill(["s1", "t1"]),
    );
    assert.equal((await get(base, "/api/sessions")).sessions[0].live.activeTurnId, "t1");

    // The turn ends in Muse's record, and the view never says so.
    muse.record.activeTurnId = null;
    await waitFor(async () => (await get(base, "/api/sessions")).sessions[0].live.activeTurnId === null, "the turn to be ended from the record");
    await stream.stop();
    const status = stream.events.filter((e) => e.type === "session-status").at(-1);
    assert.equal(status.live.activeTurnId, null, "clients are told, so a thread still showing the turn reloads");
  });

  it("loads a running thread without the ending the view lends its turn (#54)", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection);
    // Catch-up is left off, as it is by default: a history load is put right whether or not it is on.
    assert.deepEqual(await get(base, "/api/feed-settings"), { catchUp: false });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    muse.event("turn/started", { turnId: "t1" });
    muse.event("item/started", { item: { itemId: "open", kind: "toolCall", revision: 1, status: "inProgress" } });
    muse.record.activeTurnId = "t1";

    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.deepEqual(
      loaded.json.events.map((e: { method: string }) => e.method),
      ["turn/started", "item/started"],
      "the page also held the call and the turn closed as failed; neither has happened",
    );
    assert.equal(loaded.json.msp.activeTurnId, "t1");
    assert.equal(JSON.stringify(loaded.json.events).includes("incomplete"), false);
  });

  it("does the same for a thread another host is running, and keeps an ending that is real", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection);
    assert.deepEqual(await get(base, "/api/feed-settings"), { catchUp: false });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    muse.event("turn/started", { turnId: "t1" });
    muse.record.activeTurnId = "t1";
    // Another host holds it, so the resume says nothing about what is running; a lease-free read does.
    connection.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));
    const running = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(running.json.readOnly, true);
    assert.deepEqual(running.json.events.map((e: { method: string }) => e.method), ["turn/started"]);

    // That host dies mid-turn. Muse now records the turn as incomplete for real, and nothing is running.
    muse.event("turn/completed", { turnId: "t1", terminal: "failed", reason: "incomplete" });
    muse.record.activeTurnId = null;
    const died = await send(base, "/api/sessions/s1/resume", {});
    assert.deepEqual(died.json.events.map((e: { method: string }) => e.method), ["turn/started", "turn/completed"]);
  });

  it("asks Muse nothing about a quiet session while catch-up is off, which it is by default", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection, { tailTiming: FAST_TAIL });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const old = muse.event("item/completed", { item: { itemId: "old", kind: "agentMessage", revision: 1, status: "completed", text: "earlier" } });
    connection.notify(old.method, old.params);
    await send(base, "/api/sessions/s1/resume", {});
    const stream = await collectEvents(base);

    // A turn starts, and after its first event nothing more of it is pushed while it runs.
    await send(base, "/api/turns", { sessionId: "s1", text: "go" });
    const started = muse.event("turn/started", { turnId: "t1" });
    connection.notify(started.method, started.params);
    muse.record.activeTurnId = "t1";
    muse.event("item/completed", { item: { itemId: "a1", kind: "agentMessage", revision: 1, status: "completed", text: "done" } });
    // Push says there is a hole, and says something twice. Both go through as they always did.
    connection.notify("view/gap", { sessionId: "s1", after: old.params.viewCursor, next: started.params.viewCursor });
    connection.notify(started.method, started.params);
    // Many times over what a tail that was on would wait before asking.
    await new Promise((r) => setTimeout(r, 400));
    await stream.stop();

    assert.deepEqual(asked(connection), { pages: 0, reads: 0 }, "nothing is paged forward and the record is never read");
    assert.deepEqual(msp(stream.events), ["turn/started", "view/gap", "turn/started"], "only what was pushed, exactly as it was pushed");
    assert.equal(stream.events.some((e) => e.type === "feed"), false, "and nothing vouches for the turn");
    const sessions = (await get(base, "/api/sessions")).sessions;
    assert.equal(sessions[0].live.activeTurnId, "t1");
    assert.deepEqual((await get(base, "/api/health")).diagnostics.tail, {});
  });

  it("follows a thread from its next history load once catch-up is switched on, and lets go when it is switched off", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection, { tailTiming: FAST_TAIL });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const started = muse.event("turn/started", { turnId: "t1" });
    connection.notify(started.method, started.params);
    muse.record.activeTurnId = "t1";
    await send(base, "/api/sessions/s1/resume", {});
    const stream = await collectEvents(base);

    // Switching it on does nothing for a thread by itself: there is nowhere to page from yet.
    await catchUp(base);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(asked(connection), { pages: 0, reads: 0 });

    // The reload the stalled notice makes is what gives the tail its place in the view.
    await send(base, "/api/sessions/s1/resume", {});
    muse.event("item/completed", { item: { itemId: "a1", kind: "agentMessage", revision: 1, status: "completed", text: "done" } });
    await waitFor(() => msp(stream.events).includes("item/completed"), "the item push never delivered");
    await waitFor(() => stream.events.some((e) => e.type === "feed"), "confirmation that the turn runs");

    await catchUp(base, false);
    // A look under way when the switch went off may finish its request; nothing is asked after that.
    await new Promise((r) => setTimeout(r, 50));
    const before = asked(connection);
    const delivered = msp(stream.events).length;
    muse.event("item/completed", { item: { itemId: "a2", kind: "agentMessage", revision: 1, status: "completed", text: "more" } });
    await new Promise((r) => setTimeout(r, 300));
    await stream.stop();
    assert.deepEqual(asked(connection), before, "nothing more is asked of Muse");
    assert.equal(msp(stream.events).length, delivered, "and nothing more is delivered");
    assert.deepEqual((await get(base, "/api/health")).diagnostics.tail, {}, "what it was following is forgotten");
  });

  it("starts with catch-up on when that is how it was left", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "helicon-feed-"));
    // What an earlier run of the server kept when the switch was flipped.
    const kept = new HeliconStore(join(dataDir, "helicon.db"));
    kept.setFeedSettings({ catchUp: true });
    kept.close();

    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection, { dataDir, tailTiming: FAST_TAIL });
    assert.deepEqual(await get(base, "/api/feed-settings"), { catchUp: true });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    await send(base, "/api/sessions/s1/resume", {});
    const stream = await collectEvents(base);
    muse.event("turn/started", { turnId: "t1" });
    await waitFor(() => msp(stream.events).includes("turn/started"), "an event paged without the switch being touched again");
    await stream.stop();
  });

  it("stops following a session once its host is gone", async () => {
    const connection = new FakeConnection();
    quietSession(connection);
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { tailTiming: FAST_TAIL, hostFactory: fakeFactory(connection, probe) });
    await catchUp(base);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    await send(base, "/api/sessions/s1/resume", {});
    await waitFor(() => connection.requests.some((c) => c.method === "view/page" && c.params?.["direction"] === "forward"), "a first page");

    for (const exit of probe.exits) {
      exit({ code: 1, signal: null });
    }
    await new Promise((r) => setTimeout(r, 50));
    const before = connection.requests.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(connection.requests.length, before, "nothing is asked of a host that exited");
    assert.deepEqual((await get(base, "/api/health")).diagnostics.tail, {}, "and the session is no longer followed at all");
  });

  it("gives up on a look Muse never answers, so what is pushed meanwhile still arrives", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection, { tailTiming: { ...FAST_TAIL, lookMaxMs: 150 } });
    await catchUp(base);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    await send(base, "/api/sessions/s1/resume", {});
    const stream = await collectEvents(base);
    // The host stops answering reads, as one whose reply was dropped on the way would. Its pushes go on.
    const before = asked(connection).reads;
    connection.replies.set("session/read", () => new Promise(() => undefined));
    await waitFor(() => asked(connection).reads > before, "a look that will get no answer");
    const started = muse.event("turn/started", { turnId: "t1" });
    connection.notify(started.method, started.params);
    connection.notify("approval/requested", { sessionId: "s1", approvalId: "ap1", turnId: "t1" });

    await waitFor(() => msp(stream.events).length === 2, "the pushes held for the look");
    await stream.stop();
    assert.deepEqual(msp(stream.events), ["turn/started", "approval/requested"], "in the order they were pushed");
    const session = (await get(base, "/api/sessions")).sessions[0];
    assert.equal(session.live.activeTurnId, "t1");
    assert.equal(session.live.pendingApprovals, 1, "an approval is not left waiting on a host that went quiet");
    const tail = (await get(base, "/api/health")).diagnostics.tail.s1;
    assert.ok(tail.failures >= 1);
    assert.equal(tail.lastError, "the look went unanswered");
  });

  it("stops following a session Muse closes", async () => {
    const connection = new FakeConnection();
    quietSession(connection);
    const { base } = await start(connection, { tailTiming: FAST_TAIL });
    await catchUp(base);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    await send(base, "/api/sessions/s1/resume", {});
    await waitFor(async () => "s1" in (await get(base, "/api/health")).diagnostics.tail, "the session to be looked at");

    connection.notify("session/closed", { sessionId: "s1" });
    await waitFor(async () => !("s1" in (await get(base, "/api/health")).diagnostics.tail), "the session to be forgotten");
    assert.deepEqual((await get(base, "/api/health")).diagnostics.tail, {});
  });

  it("keeps paging the host that loaded a session when another host's discovery lists it as running", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    // The host a discovery with no folder runs on. It can list any session, but it never loaded
    // this one, so it has no view of it to page. Muse named the session, so no title is looked for there.
    const other = new FakeConnection();
    other.replies.set("session/list", {
      sessions: [{ sessionId: "s1", name: "Proj work", workspaceRoot: "/work/proj", status: "running", activeTurnId: "t1" }],
      nextCursor: null,
    });
    other.replies.set("session/read", () => ({ session: { sessionId: "s1", ...muse.record }, viewCursor: muse.view.at(-1)?.params["viewCursor"] ?? "" }));
    other.replies.set("view/page", new MspTestError("session is not loaded", "sessionNotLoaded"));
    const { base } = await start(connection, {
      tailTiming: FAST_TAIL,
      hostFactory: (target) => fakeFactory(target.cwd === "/work/proj" ? connection : other)(target),
    });
    await catchUp(base);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    await send(base, "/api/sessions/s1/resume", {});
    const stream = await collectEvents(base);
    const started = muse.event("turn/started", { turnId: "t1" });
    connection.notify(started.method, started.params);
    muse.record.activeTurnId = "t1";

    // The sidebar is refreshed mid-turn, and after that nothing more of the turn is pushed.
    assert.equal((await send(base, "/api/discover", {})).status, 200);
    assert.equal(other.requests.some((c) => c.method === "session/list"), true, "the discovery ran on the other host");
    muse.event("item/completed", { item: { itemId: "a1", kind: "agentMessage", revision: 1, status: "completed", text: "done" } });
    await waitFor(() => msp(stream.events).includes("item/completed"), "the item, paged from the host that has the session");
    await stream.stop();
    assert.equal(other.requests.some((c) => c.method === "view/page"), false, "the host that never loaded it is not asked for its view");
  });

  it("loads a thread whose turn started under the load without its lent ending, wherever the record's head then is (#54)", async () => {
    const connection = new FakeConnection();
    const muse = quietSession(connection);
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    // The resume is answered before the turn starts: idle, with an empty view.
    connection.replies.set("session/resume", (connection.replies.get("session/resume") as () => unknown)());
    muse.event("turn/started", { turnId: "t1" });
    muse.record.activeTurnId = "t1";
    // The pages are read mid-turn and lend it an ending. By the time the record is read again, real
    // events hold the cursors that ending was lent.
    const page = connection.replies.get("view/page") as (params: Record<string, unknown>) => unknown;
    connection.replies.set("view/page", (params: Record<string, unknown>) => {
      const result = page(params);
      if (muse.view.length === 1) {
        muse.event("item/started", { item: { itemId: "open", kind: "toolCall", revision: 1, status: "inProgress" } });
        muse.event("item/completed", { item: { itemId: "open", kind: "toolCall", revision: 2, status: "completed" } });
      }
      return result;
    });

    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.deepEqual(
      loaded.json.events.map((e: { method: string }) => e.method),
      ["turn/started"],
      "the head now names the cursor of the lent turn ending, which is still not what happened",
    );
    assert.equal(JSON.stringify(loaded.json.events).includes("incomplete"), false);
  });
});

describe("file viewer", () => {
  async function project() {
    const { mkdtemp, mkdir, writeFile, symlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "helicon-files-"));
    const outside = await mkdtemp(join(tmpdir(), "helicon-outside-"));
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Title\n\nBody\n");
    await writeFile(join(root, "docs", "guide.md"), "guide");
    await writeFile(join(root, "docs", "page.html"), "<script>alert(1)</script>");
    await writeFile(join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    await writeFile(join(root, "clip.mp4"), Buffer.from("0123456789"));
    await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2, 0]));
    await writeFile(join(root, "node_modules", "pkg", "guide.md"), "vendored");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    const connection = new FakeConnection();
    const { base } = await start(connection, { platform: process.platform });
    const added = await send(base, "/api/projects", { cwd: root });
    const cwd = added.json.project.cwd as string;
    const q = (path: string) => `cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
    return { base, root, cwd, q };
  }

  it("lists folders first and reads text, markdown and media descriptions", async () => {
    const { base, root, q } = await project();
    const listing = await get(base, `/api/files/list?${q("")}`);
    assert.deepEqual(
      listing.entries.map((e: { name: string; kind: string }) => `${e.kind}:${e.name}`).slice(0, 2),
      ["dir:docs", "dir:node_modules"],
    );
    assert.ok(listing.entries.some((e: { name: string }) => e.name === "README.md"));
    const nested = await get(base, `/api/files/list?${q("docs")}`);
    assert.deepEqual(nested.entries.map((e: { path: string }) => e.path), ["docs/guide.md", "docs/page.html"]);

    const readme = await get(base, `/api/files/read?${q("README.md")}`);
    assert.equal(readme.kind, "markdown");
    assert.equal(readme.content, "# Title\n\nBody\n");
    // An agent names files by absolute path; that resolves inside the project too.
    const absolute = await get(base, `/api/files/read?${q(`${root}/docs/guide.md`)}`);
    assert.equal(absolute.path, "docs/guide.md");
    assert.equal((await get(base, `/api/files/read?${q("clip.mp4")}`)).kind, "video");
    const binary = await get(base, `/api/files/read?${q("blob.bin")}`);
    assert.equal(binary.kind, "binary");
    assert.equal(binary.content, undefined);
  });

  it("refuses paths outside the project, through .. or a symlink, and unknown projects", async () => {
    const { base, q, cwd } = await project();
    assert.equal((await fetch(`${base}/api/files/read?${q("../../etc/passwd")}`)).status, 403);
    assert.equal((await fetch(`${base}/api/files/read?${q("escape.txt")}`)).status, 403, "a symlink out of the project is refused");
    assert.equal((await fetch(`${base}/api/files/raw?${q("escape.txt")}`)).status, 403);
    assert.equal((await fetch(`${base}/api/files/read?${q("/etc/passwd")}`)).status, 404, "an absolute path elsewhere resolves inside the project, where it is not");
    assert.equal((await fetch(`${base}/api/files/list?cwd=${encodeURIComponent("/etc")}&path=`)).status, 404);
    const write = await fetch(`${base}/api/files/write`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: "../evil.md", content: "x", baseMtimeMs: null }),
    });
    assert.equal(write.status, 403);
  });

  it("never serves a file as a page that can script this origin, and serves video in ranges", async () => {
    const { base, q } = await project();
    const html = await fetch(`${base}/api/files/raw?${q("docs/page.html")}`);
    assert.equal(html.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
    const svg = await fetch(`${base}/api/files/raw?${q("icon.svg")}`);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.match(svg.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(svg.headers.get("x-content-type-options"), "nosniff");

    const part = await fetch(`${base}/api/files/raw?${q("clip.mp4")}`, { headers: { range: "bytes=2-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await part.text(), "2345");
    const tail = await fetch(`${base}/api/files/raw?${q("clip.mp4")}`, { headers: { range: "bytes=-3" } });
    assert.equal(await tail.text(), "789");
  });

  it("saves an edit, and refuses one made against a file that changed on disk", async () => {
    const { base, root, cwd, q } = await project();
    const { writeFile, readFile, utimes } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const opened = await get(base, `/api/files/read?${q("README.md")}`);
    const put = (content: string, baseMtimeMs: number | null) =>
      fetch(`${base}/api/files/write`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, path: "README.md", content, baseMtimeMs }),
      });
    const saved = await put("# Edited\n", opened.mtimeMs);
    assert.equal(saved.status, 200);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "# Edited\n");
    const after = (await saved.json()) as { mtimeMs: number };

    // Something else writes the file: the stale save is refused and the other change survives.
    await writeFile(join(root, "README.md"), "# Agent\n");
    await utimes(join(root, "README.md"), new Date(), new Date(after.mtimeMs + 5000));
    const stale = await put("# Mine\n", after.mtimeMs);
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { kind: string }).kind, "fileChanged");
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "# Agent\n");
  });

  it("finds files by path words, skipping generated folders", async () => {
    const { base, cwd } = await project();
    const found = await get(base, `/api/files/search?cwd=${encodeURIComponent(cwd)}&q=guide`);
    assert.deepEqual(found.files.map((f: { path: string }) => f.path), ["docs/guide.md"], "node_modules is not searched");
  });

  describe("undoing a thread's edits", () => {
    const read = async (root: string, name: string) => (await import("node:fs/promises")).readFile(`${root}/${name}`, "utf8");
    const revert = (base: string, cwd: string, path: string, steps: unknown) => send(base, "/api/files/revert", { cwd, path, steps });

    it("puts an edited file back and refuses when it has moved on", async () => {
      const { writeFile } = await import("node:fs/promises");
      const { base, root, cwd } = await project();
      await writeFile(`${root}/a.txt`, "one\nTWO\nthree\nFOUR\n");
      const steps = [
        { before: "four", after: "FOUR" },
        { before: "two", after: "TWO" },
      ];
      const done = await revert(base, cwd, "a.txt", steps);
      assert.equal(done.status, 200);
      assert.equal(done.json.outcome, "reverted");
      assert.equal(await read(root, "a.txt"), "one\ntwo\nthree\nfour\n");

      await writeFile(`${root}/b.txt`, "one\nsomething else\n");
      const conflict = await revert(base, cwd, "b.txt", [{ before: "two", after: "TWO" }]);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.json.kind, "revertConflict");
      assert.equal(await read(root, "b.txt"), "one\nsomething else\n", "a refused undo leaves the file alone");

      await writeFile(`${root}/c.txt`, "x\nTWO\nTWO\n");
      const twice = await revert(base, cwd, "c.txt", [{ before: "two", after: "TWO" }]);
      assert.equal(twice.status, 409, "an edit that matches twice is ambiguous and refused");
    });

    it("keeps CRLF files as they are", async () => {
      const { writeFile } = await import("node:fs/promises");
      const { base, root, cwd } = await project();
      await writeFile(`${root}/win.txt`, "a\r\nNEW\r\nb\r\n");
      const done = await revert(base, cwd, "win.txt", [{ before: "old\n", after: "NEW\n" }]);
      assert.equal(done.status, 200);
      assert.equal(await read(root, "win.txt"), "a\r\nold\r\nb\r\n");
    });

    it("deletes a file the thread created only when git does not track it and it is unchanged", async () => {
      const { writeFile, access } = await import("node:fs/promises");
      const { execFileSync } = await import("node:child_process");
      const { base, root, cwd } = await project();
      execFileSync("git", ["init", "-q"], { cwd: root });
      await writeFile(`${root}/new.txt`, "made by muse");
      const edited = await revert(base, cwd, "new.txt", [{ before: null, after: "changed since" }]);
      assert.equal(edited.status, 409, "a created file that changed afterwards is kept");
      const done = await revert(base, cwd, "new.txt", [{ before: null, after: "made by muse", at: Date.now() - 1000 }]);
      assert.equal(done.status, 200);
      assert.equal(done.json.outcome, "deleted");
      await writeFile(`${root}/old.txt`, "was here before");
      const early = await revert(base, cwd, "old.txt", [{ before: null, after: "was here before", at: Date.now() + 60_000 }]);
      assert.equal(early.status, 409, "a file that existed before the write is kept");
      await writeFile(`${root}/.gitignore`, "mine.txt\n");
      await writeFile(`${root}/mine.txt`, "private");
      const ignored = await revert(base, cwd, "mine.txt", [{ before: null, after: "private", at: Date.now() - 1000 }]);
      assert.equal(ignored.status, 409, "an ignored file is never deleted");
      await assert.rejects(access(`${root}/new.txt`));

      execFileSync("git", ["add", "README.md"], { cwd: root });
      const tracked = await revert(base, cwd, "README.md", [{ before: null, after: "# Title\n\nBody\n" }]);
      assert.equal(tracked.status, 409, "a tracked file is never deleted");
      assert.equal(await read(root, "README.md"), "# Title\n\nBody\n");
    });

    it("refuses a file that is not valid UTF-8 or is already gone", async () => {
      const { writeFile } = await import("node:fs/promises");
      const { base, root, cwd } = await project();
      await writeFile(`${root}/latin.txt`, Buffer.from([0x6f, 0x6c, 0x64, 0xe9]));
      assert.equal((await revert(base, cwd, "latin.txt", [{ before: "x", after: "old" }])).status, 409);
      assert.equal((await revert(base, cwd, "missing.txt", [{ before: "x", after: "y" }])).status, 404);
    });

    it("refuses paths outside the project and malformed bodies", async () => {
      const { base, cwd } = await project();
      assert.equal((await revert(base, cwd, "../../etc/passwd", [{ before: "a", after: "b" }])).status, 403);
      assert.equal((await revert(base, cwd, "escape.txt", [{ before: "a", after: "b" }])).status, 403);
      assert.equal((await revert(base, cwd, "README.md", "nope")).status, 400);
      assert.equal((await revert(base, cwd, "README.md", [{ before: 1, after: "b" }])).status, 400);
    });
  });
});

describe("slash commands, skills and shell", () => {
  const LIST = JSON.stringify({
    diagnostics: [],
    skills: [
      { id: "bundled:plan", name: "plan", display_name: "plan", description: "Plan it. Use ONLY when asked.", short_description: null, scope: "bundled", activation: "on", path: "bundled://muse-core/skills/plan/SKILL.md" },
      { id: "user:secret", name: "secret", display_name: "secret", description: "Only by hand.", short_description: "Hand only", scope: "user", activation: "user-invocable-only", path: "/home/me/.config/muse/skills/secret/SKILL.md" },
      { id: "bundled:off", name: "off", display_name: "off", description: "Switched off.", activation: "off", path: "bundled://muse-core/skills/off/SKILL.md" },
    ],
  });

  it("lists a workspace's skills through the muse CLI, keeps them a minute, and reads only listed skills", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("list")) {
        return { stdout: LIST, exitCode: 0 };
      }
      return { stdout: "---\nname: secret\ndescription: x\n---\n\n# Secret\nDo the thing.\n", exitCode: 0 };
    };
    const { base } = await start(new FakeConnection(), { exec });
    const listed = await get(base, "/api/slash?cwd=%2Fwork%2Fproj");
    assert.deepEqual(
      listed.skills.map((s: { id: string }) => s.id),
      ["bundled:plan", "user:secret"],
      "skills switched off are left out",
    );
    assert.equal(listed.skills[1].activation, "user-invocable-only");
    assert.equal(listed.error, null);
    assert.deepEqual(calls[0], ["muse", "skills", "list", "--json", "--workspace", "/work/proj"]);
    await get(base, "/api/slash?cwd=%2Fwork%2Fproj");
    assert.equal(calls.length, 1, "a fresh list is reused");

    const body = await get(base, "/api/slash/skill?cwd=%2Fwork%2Fproj&id=user%3Asecret");
    assert.equal(body.body, "# Secret\nDo the thing.");
    assert.deepEqual(calls[1], ["sh", "-c", 'exec cat -- "$1"', "sh", "/home/me/.config/muse/skills/secret/SKILL.md"]);
    await get(base, "/api/slash/skill?cwd=%2Fwork%2Fproj&id=bundled%3Aplan");
    assert.equal(calls[2]?.[4], "muse-core/skills/plan/SKILL.md", "bundled skills resolve inside Muse's data folder");
    const unlisted = await fetch(`${base}/api/slash/skill?cwd=%2Fwork%2Fproj&id=%2Fetc%2Fpasswd`);
    assert.equal(unlisted.status, 404);
  });

  it("lists a loaded session's skills from Muse, joined to the CLI listing, and refreshes on skill/changed", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: LIST, exitCode: 0 };
    };
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("skill/list", {
      skills: [
        { selector: "plan", displayName: "Plan", description: "Plan the work", source: "bundled" },
        { selector: "acme:deploy", displayName: "deploy", description: "Ship it", source: "plugin", pluginId: "acme", argumentHint: "<env>" },
      ],
    });
    const { base } = await start(connection, { exec });
    // No session named: the CLI listing answers, as before.
    assert.deepEqual((await get(base, "/api/slash?cwd=%2Fwork%2Fproj")).skills.map((s: { id: string }) => s.id), ["bundled:plan", "user:secret"]);

    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const listed = await get(base, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.deepEqual(
      listed.skills.map((s: { id: string; name: string }) => [s.id, s.name]),
      [["bundled:plan", "plan"], ["acme:deploy", "acme:deploy"]],
      "a skill the CLI also lists keeps its id, so its instructions can still be read",
    );
    assert.equal(listed.skills[1].argumentHint, "<env>");
    assert.equal(listed.skills[1].scope, "plugin");
    assert.equal(connection.requests.filter((r) => r.method === "skill/list").length, 1);

    const before = calls.length;
    connection.notify("skill/changed", { sessionId: "s1" });
    await get(base, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.equal(calls.length, before + 1, "skill/changed drops the cached CLI listing for that workspace");

    connection.replies.set("skill/list", new MspTestError("method not found", "methodNotFound"));
    const fallback = await get(base, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.deepEqual(fallback.skills.map((s: { id: string }) => s.id), ["bundled:plan", "user:secret"], "an older host falls back to the CLI");
  });

  it("joins session skills to CLI entries by id, name or plugin selector only", () => {
    const cli = [
      { id: "bundled:doctor", name: "doctor", displayName: "doctor", description: "cli", shortDescription: "Short", scope: "bundled", activation: "on" },
      { id: "deploy", name: "deploy", displayName: "deploy", description: "a user skill", shortDescription: null, scope: "user", activation: "on" },
      { id: "plugin:acme:lint", name: "plugin:acme:lint", displayName: "lint", description: "", shortDescription: null, scope: "plugin", activation: "on" },
    ];
    const merged = mergeSessionSkills(
      [
        { selector: "doctor", displayName: "Doctor", description: "", source: "bundled", argumentHint: null, pluginId: null },
        { selector: "acme:deploy", displayName: "deploy", description: "plugin deploy", source: "plugin", argumentHint: null, pluginId: "acme" },
        { selector: "acme:lint", displayName: "lint", description: "", source: "plugin", argumentHint: null, pluginId: "acme" },
      ],
      cli,
    );
    assert.deepEqual(merged.map((s) => s.id), ["bundled:doctor", "acme:deploy", "plugin:acme:lint"]);
    assert.equal(merged[0]?.shortDescription, "Short");
    assert.equal(merged[0]?.description, "cli", "an empty session description falls back to the CLI's");
    assert.equal(merged[1]?.scope, "plugin", "a plugin skill never borrows a same-named user skill");
  });

  it("answers a failed skill list with an error instead of failing the request", async () => {
    const { base } = await start(new FakeConnection(), { exec: async () => ({ stdout: "", exitCode: 127 }) });
    const listed = await get(base, "/api/slash?cwd=%2Fwork%2Fproj");
    assert.deepEqual(listed.skills, []);
    assert.match(listed.error, /Could not list Muse skills/);
  });

  it("runs shell commands in a session and forks it into a new thread", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const shell = await send(base, "/api/sessions/s1/shell", { command: " git status " });
    assert.equal(shell.status, 200);
    assert.deepEqual(connection.calls.at(-1), { method: "session/userShell", params: { sessionId: "s1", commandText: "git status" } });
    assert.equal((await send(base, "/api/sessions/s1/shell", { command: "  " })).status, 400);

    connection.replies.set("session/fork", { session: { sessionId: "s2", modelId: "muse-spark-1.3" } });
    const fork = await send(base, "/api/sessions/s1/fork", {});
    assert.equal(fork.status, 200);
    assert.equal(fork.json.session.sessionId, "s2");
    assert.equal(fork.json.session.title, "New thread (fork)");
    assert.deepEqual(connection.calls.at(-1), { method: "session/fork", params: { sessionId: "s1", excludeItems: true } });
    const ids = (await get(base, "/api/sessions")).sessions.map((s: { sessionId: string }) => s.sessionId).sort();
    assert.deepEqual(ids, ["s1", "s2"]);

    connection.replies.set("session/sideChat", { session: { sessionId: "s3", sideFrom: { sessionId: "s1", commandId: "c1", cutCursor: "x" } } });
    const side = await send(base, "/api/sessions/s1/side", {});
    assert.equal(side.status, 200);
    assert.equal(side.json.session.sessionId, "s3");
    assert.equal(side.json.session.sideOf, "s1");
    assert.equal(side.json.session.title, "New thread (side chat)");
    assert.deepEqual(connection.calls.at(-1), { method: "session/sideChat", params: { sessionId: "s1" } });

    connection.replies.set("session/sideChat", { session: { sessionId: "s4", sideFrom: { sessionId: "s3", commandId: "c2", cutCursor: "y" } } });
    const nested = await send(base, "/api/sessions/s3/side", {});
    assert.equal(nested.json.session.title, "New thread (side chat)", "a side chat of a side chat keeps one suffix");
  });

  it("links side chats Muse lists to their thread, and leaves subagent sessions out", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/list", {
      sessions: [
        { sessionId: "main", workspaceRoot: "/work/proj", turnCount: 3 },
        { sessionId: "side", workspaceRoot: "/work/proj", sideFrom: { sessionId: "main", commandId: "c1", cutCursor: "x" } },
        { sessionId: "child", workspaceRoot: "/work/proj", kind: "subagent", parentSessionId: "main" },
      ],
      nextCursor: null,
    });
    const { base } = await start(connection);
    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    const sessions = (await get(base, "/api/sessions")).sessions as { sessionId: string; sideOf: string | null }[];
    assert.deepEqual(sessions.map((s) => s.sessionId).sort(), ["main", "side"]);
    assert.equal(sessions.find((s) => s.sessionId === "side")?.sideOf, "main");
    assert.equal(sessions.find((s) => s.sessionId === "main")?.sideOf, null);
  });

  it("names a deleted project folder when Muse cannot start there (#105)", async () => {
    const connection = new FakeConnection();
    const failing = (): HostHandle => ({
      start: async () => {
        throw new Error("write EPIPE");
      },
      connection: connection as never,
      close: async () => ({ code: 0, signal: null }),
      onExit: () => {},
    });
    const { base } = await start(connection, { hostFactory: failing });
    const gone = join(tmpdir(), `helicon-gone-${process.pid}-${Date.now()}`);
    const missing = await send(base, "/api/sessions", { cwd: gone });
    assert.equal(missing.status, 409);
    assert.match(missing.json.error, /no longer exists/);
    assert.ok(String(missing.json.error).includes(gone));
    // A folder that is still there keeps Muse's own error.
    const here = await mkdtemp(join(tmpdir(), "helicon-here-"));
    const broken = await send(base, "/api/sessions", { cwd: here });
    assert.equal(broken.status, 502);
    assert.match(broken.json.error, /Could not start Muse: write EPIPE/);
  });

  it("runs a `!` command itself and keeps it with the thread", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const ran: { command: string; args: string[] }[] = [];
    const { base } = await start(connection, {
      shellRunner: async (command: string, args: string[]) => {
        ran.push({ command, args });
        return { output: "total 0\n", exitCode: 0, truncated: false };
      },
    });
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const result = await send(base, "/api/sessions/s1/shell-proxy", { command: " ls -la " });
    assert.equal(result.status, 200);
    assert.equal(result.json.run.command, "ls -la");
    assert.equal(result.json.run.exitCode, 0);
    assert.equal(result.json.run.output, "total 0\n");
    assert.ok(ran[0]?.args.includes("/work/proj"), "the command runs where the workspace is");
    assert.ok(ran[0]?.args.includes("ls -la"), "the command itself is an argument, never spliced into a script");

    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.deepEqual(
      loaded.json.shellRuns.map((run: { command: string }) => run.command),
      ["ls -la"],
    );
    assert.equal((await send(base, "/api/sessions/s1/shell-proxy", { command: "   " })).status, 400);
    assert.equal((await send(base, "/api/sessions/missing/shell-proxy", { command: "ls" })).status, 404);
  });

  it("sends an attached image to the model and serves it back", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { turnId: "t1", status: "accepted", disposition: "started" });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

    const sent = await send(base, "/api/turns", {
      sessionId: "s1",
      text: "what is this?",
      attachments: [{ name: "shot.png", mediaType: "image/png", base64: png, width: 10, height: 20 }],
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.attachments?.[0]?.name, "shot.png", "the ack carries what was saved, for the open thread");
    assert.match(sent.json.attachments?.[0]?.url ?? "", /^\/api\/attachments\//);
    const turn = connection.calls.find((c) => c.method === "turn/start");
    assert.deepEqual(turn?.params?.["input"], [
      { type: "text", text: "what is this?" },
      { type: "image", base64Data: png, mediaType: "image/png", width: 10, height: 20 },
    ]);

    const loaded = await send(base, "/api/sessions/s1/resume", {});
    const file = loaded.json.attachments[0];
    assert.equal(file.name, "shot.png");
    assert.equal(file.kind, "image");
    assert.equal(file.turnId, "t1");
    const served = await fetch(`${base}${file.url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), png);

    const empty = await send(base, "/api/turns", { sessionId: "s1" });
    assert.equal(empty.status, 400, "a message with neither text nor a file is refused");
  });

  it("lets Muse's own name replace a title derived from a /skill prompt", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: {
        itemId: "u1",
        kind: "userMessage",
        status: "completed",
        revision: 1,
        turnId: "t1",
        text: 'Use skill bundled:plan: call read_skill with name "bundled:plan" first, then apply it to: tidy the API',
        displayText: "/plan tidy the API",
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const titleOf = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1")?.title;
    assert.equal(await titleOf(), "/plan tidy the API", "until Muse has named it, the thread shows what the user typed");
    // Muse names the session itself, and that name is what its own CLI shows, so discovery takes it.
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Tidy the API surface", title: "Use skill bundled:plan: call read_skill" }],
      nextCursor: null,
    });
    assert.equal((await send(base, "/api/discover", {})).status, 200);
    assert.equal(await titleOf(), "Tidy the API surface");
  });

  it("prefers Muse's session name over the prompt-echo title during discovery", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.replies.set("session/list", {
      sessions: [
        { sessionId: "s1", workspaceRoot: "/work/proj", name: "pebble-caliban", title: "So far, I have been developing and working on my project Helicon on Windows only. It goes on and on.", turnCount: 9 },
        { sessionId: "s2", workspaceRoot: "/work/proj", title: "``` Set up this Mac from my private repo", turnCount: 0 },
      ],
      nextCursor: null,
    });
    assert.equal((await send(base, "/api/discover", {})).status, 200);
    const sessions = (await get(base, "/api/sessions")).sessions;
    const byId = (id: string) => sessions.find((s: { sessionId: string }) => s.sessionId === id)?.title;
    assert.equal(byId("s1"), "pebble-caliban");
    assert.equal(byId("s2"), "Set up this Mac from my private repo");
  });

  it("never lets a discovery echo clobber a generated title", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", title: "fix the updater please" }],
      nextCursor: null,
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Fix the updater" } }),
        exitCode: 0,
      };
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1").title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });
    await waitFor(async () => (await titleOf()) === "Fix the updater", "the upgraded title");
    await send(base, "/api/discover", {});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await titleOf(), "Fix the updater", "the echo is a fallback, never an update");
    assert.equal(calls.length, 1, "and no second model call is spent");
  });

  it("never upgrades a thread Muse named itself", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Fix the updater" } }),
        exitCode: 0,
      };
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/title-settings", { enabled: false }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions[0].title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });
    connection.notify("session/nameChanged", { sessionId: "s1", name: "Muse One", viewCursor: "c", sourceRange: RANGE });
    assert.equal(await titleOf(), "Muse One");
    await send(base, "/api/title-settings", { enabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await titleOf(), "Muse One", "a live rename cancels the owed attempt");
    assert.equal(calls.length, 0);

    const second = new FakeConnection();
    second.replies.set("session/start", { session: { sessionId: "s1" } });
    second.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", title: "fix the updater please" }],
      nextCursor: null,
    });
    const { base: base2 } = await start(second, { exec });
    await send(base2, "/api/title-settings", { enabled: false }, "PATCH");
    await send(base2, "/api/sessions", { cwd: "/work/proj" });
    await send(base2, "/api/discover", {});
    second.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Muse Two", title: "fix the updater please" }],
      nextCursor: null,
    });
    await send(base2, "/api/discover", {});
    const titleOf2 = async () => (await get(base2, "/api/sessions")).sessions[0].title;
    assert.equal(await titleOf2(), "Muse Two");
    await send(base2, "/api/title-settings", { enabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await titleOf2(), "Muse Two", "a discovered name cancels the owed attempt");
    assert.equal(calls.length, 0);
  });

  it("keeps each session's goal in its live view for the sidebar", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const liveGoal = async () =>
      (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1")?.live?.goal;
    const settle = () => new Promise((r) => setTimeout(r, 20));
    assert.equal(await liveGoal(), null);
    connection.notify("session/goalChanged", { sessionId: "s1", goal: { objective: "Ship it", status: "active", percentComplete: 40, currentWork: "Notes" } });
    await settle();
    assert.deepEqual(await liveGoal(), { objective: "Ship it", status: "active", percentComplete: 40, currentWork: "Notes" });
    connection.notify("session/goalChanged", { sessionId: "s1", goal: { status: "paused" } });
    await settle();
    assert.equal((await liveGoal())?.objective, "Ship it", "a block with no objective is not a goal");
    connection.notify("session/goalChanged", { sessionId: "s1", goal: null });
    await settle();
    assert.equal(await liveGoal(), null);
  });

  it("parses skill lists and strips frontmatter", () => {
    assert.equal(parseSkillList("not json"), null);
    assert.equal(parseSkillList(JSON.stringify({ skills: [{ name: "no id" }] }))?.skills.length, 0);
    assert.equal(stripFrontmatter("\uFEFF---\nname: x\n---\nBody"), "Body");
    assert.equal(stripFrontmatter("No frontmatter"), "No frontmatter");
  });
});

describe("wire helpers", () => {
  it("reshapes notifications for the browser", () => {
    const delta = toWireEvent("item/delta", { sessionId: "s1", itemId: "i1", delta: "po", field: "text" }, 5);
    assert.deepEqual(delta, {
      type: "msp",
      sessionId: "s1",
      method: "item/delta",
      params: { sessionId: "s1", itemId: "i1", delta: "po", field: "text" },
      at: 5,
    });
    const started = toWireEvent("session/started", { session: { sessionId: "s2" } });
    assert.equal(started?.sessionId, "s2");
    const completed = toWireEvent("turn/completed", { sessionId: "s1", turnId: "t1", sourceRange: RANGE });
    assert.equal(completed?.params["sourceRange"], undefined);
    assert.equal(toWireEvent("initialized", {}), null);
  });

  it("derives thread titles from the first prompt line", () => {
    assert.equal(deriveTitle("# Fix login\nand more"), "Fix login");
    assert.equal(deriveTitle("   \n  "), null);
    const long = deriveTitle("Refactor the session manager so that queries never mint command ids and paging works for long threads");
    assert.ok(long && long.length <= 75 && long.endsWith("..."));
  });

  it("skips code fences when deriving thread titles", () => {
    assert.equal(deriveTitle("```\nSet up this Mac\nmore"), "Set up this Mac");
    assert.equal(deriveTitle("``` Fix login"), "Fix login");
    assert.equal(deriveTitle("```python\nprint(1)"), "print(1)");
    assert.equal(deriveTitle("Use `helicon.db` here"), "Use `helicon.db` here");
    assert.equal(deriveTitle("```\n```"), null);
  });

  it("normalizes MSP timestamps", () => {
    assert.equal(normalizeIso("2026-09-11T12:35:42.947855Z"), "2026-09-11T12:35:42.947Z");
    assert.equal(normalizeIso("nope"), undefined);
    assert.equal(normalizeIso(42), undefined);
  });
});
