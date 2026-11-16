// Unit tests for src/extension.ts. The vscode module is a fake (test/support/vscode-fake.mjs); the
// helicon-server child is a small fake HTTP server written into a temp extension folder, so the
// real spawn, readiness and error paths run.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ColorThemeKind,
  FakeView,
  Range,
  Uri,
  ViewColumn,
  createContext,
  createFakeVscode,
  loadExtension,
  removeStub,
} from "./support/vscode-fake.mjs";

after(removeStub);

const PANEL = "helicon.panel";
const COMMANDS = [
  "helicon.open",
  "helicon.newThread",
  "helicon.openInEditor",
  "helicon.openForFolder",
  "helicon.openInBrowser",
  "helicon.restart",
  "helicon.showLog",
];
const folder = (path) => [{ uri: Uri.file(path) }];
const newThread = (path) => ({ type: "navigate-hash", hash: `#/new/${encodeURIComponent(path)}` });

/**
 * A fake helicon-server. It logs each start (its argv) and each request to logPath, answers
 * POST /api/projects with 200, or with 500 when mode is "reject". mode "exit" dies before listening.
 */
function serverSource(logPath, mode) {
  return `const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + "\\n");
if (${JSON.stringify(mode)} === "exit") {
  console.error("boom");
  process.exit(3);
}
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    log({ method: req.method, url: req.url, body });
    const fail = ${JSON.stringify(mode)} === "reject";
    res.writeHead(fail ? 500 : 200, { "content-type": "text/plain" });
    res.end(fail ? "no project" : "{}");
  });
});
server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1", () => {
  log({ started: args });
  console.log("helicon-server listening on http://127.0.0.1:" + server.address().port);
});
`;
}

async function readServerLog(logPath) {
  if (!existsSync(logPath)) return [];
  const text = await readFile(logPath, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const startCount = (fake) => fake.log.output.split("Starting helicon-server with").length - 1;

async function until(check, what) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function reachable(url) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

/** Activates a fresh copy of the extension against a fake vscode and a temp extension folder. */
async function harness(t, { mode = "ok", withServer = true, ...fakeOptions } = {}) {
  const root = await mkdtemp(join(tmpdir(), "helicon-ext-test-"));
  const extensionPath = join(root, "extension");
  const logPath = join(root, "server.log");
  await mkdir(join(extensionPath, "dist"), { recursive: true });
  if (withServer) {
    await writeFile(join(extensionPath, "dist", "server.cjs"), serverSource(logPath, mode));
  }
  const fake = createFakeVscode(fakeOptions);
  const mod = await loadExtension(fake);
  const context = createContext(extensionPath);
  const api = mod.activate(context);
  t.after(async () => {
    mod.deactivate();
    for (const item of context.subscriptions) item.dispose?.();
    await rm(root, { recursive: true, force: true });
  });
  return {
    fake,
    mod,
    api,
    extensionPath,
    serverLog: () => readServerLog(logPath),
    run: (id, ...args) => fake.registered.get(id)(...args),
  };
}

/** Resolves the side panel view the way VS Code does when the panel is shown. */
async function resolve(h) {
  const view = new FakeView();
  await h.fake.viewProviders.get(PANEL).provider.resolveWebviewView(view);
  return view;
}

test("activate registers the Helicon commands and the side panel view", async (t) => {
  const h = await harness(t);
  assert.deepEqual([...h.fake.registered.keys()].sort(), [...COMMANDS].sort());
  const panel = h.fake.viewProviders.get(PANEL);
  assert.ok(panel, "the side panel view is registered");
  assert.equal(panel.options.webviewOptions.retainContextWhenHidden, true);
});

test("activate creates the Helicon output channel, subscribes to events, and returns the test API", async (t) => {
  const h = await harness(t);
  assert.deepEqual(h.fake.log.channels, ["Helicon"]);
  assert.equal(h.fake.events.theme.count(), 1);
  assert.equal(h.fake.events.folders.count(), 1);
  assert.equal(h.fake.events.config.count(), 1);
  assert.equal(h.api.panelLoaded(), null);
  assert.equal(typeof h.api.serverUrl, "function");
  assert.equal(typeof h.api.frameMessage, "function");
});

test("serverUrl starts helicon-server on a free port with the bundled UI and the extension's own data folder", async (t) => {
  const h = await harness(t);
  const url = await h.api.serverUrl();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const starts = (await h.serverLog()).filter((entry) => entry.started);
  assert.equal(starts.length, 1);
  const dist = join(h.extensionPath, "dist");
  assert.deepEqual(starts[0].started, [
    "--port",
    "0",
    "--static",
    join(dist, "frontend"),
    "--data-dir",
    join(h.extensionPath, "storage"),
  ]);
  assert.ok(existsSync(join(h.extensionPath, "storage")), "the data folder is created before the start");
});

test("serverUrl reuses the running server on later calls", async (t) => {
  const h = await harness(t);
  const first = await h.api.serverUrl();
  const second = await h.api.serverUrl();
  assert.equal(second, first);
  assert.equal(startCount(h.fake), 1);
});

test("a server that exits before it is ready rejects with its exit code, and the next call starts it again", async (t) => {
  const h = await harness(t, { mode: "exit" });
  await assert.rejects(h.api.serverUrl(), /helicon-server exited before it was ready \(code 3\)/);
  await assert.rejects(h.api.serverUrl(), /helicon-server exited before it was ready \(code 3\)/);
  assert.equal(startCount(h.fake), 2);
  assert.match(h.fake.log.output, /helicon-server exited \(code 3\)/);
  assert.match(h.fake.log.output, /boom/);
});

test("a missing server bundle is reported as an exit before ready", async (t) => {
  const h = await harness(t, { withServer: false });
  await assert.rejects(h.api.serverUrl(), /helicon-server exited before it was ready \(code 1\)/);
  assert.match(h.fake.log.output, /Cannot find module/);
});

test("deactivate stops the server, and the next serverUrl call starts a fresh one", async (t) => {
  const h = await harness(t);
  const first = await h.api.serverUrl();
  h.mod.deactivate();
  await until(async () => !(await reachable(first)), "the old server to stop");
  const second = await h.api.serverUrl();
  assert.equal(startCount(h.fake), 2);
  assert.equal(await reachable(second), true);
});

test("the side panel loads the server page for the workspace folder, with the editor host and theme", async (t) => {
  const h = await harness(t, { workspaceFolders: folder("/work/app") });
  const view = await resolve(h);
  const loaded = new URL(h.api.panelLoaded());
  assert.equal(loaded.origin, await h.api.serverUrl());
  assert.equal(loaded.pathname, "/");
  assert.equal(loaded.searchParams.get("view"), "panel");
  assert.equal(loaded.searchParams.get("host"), "editor");
  assert.equal(loaded.searchParams.get("theme"), "dark");
  assert.equal(loaded.searchParams.get("cwd"), "/work/app");
  assert.ok(view.webview.html.includes(`src="${h.api.panelLoaded()}"`), "the frame points at the loaded page");
  assert.ok(view.webview.htmlHistory[0].includes("Starting Helicon"), "the panel shows a starting message first");
});

test("the workspace folder reaches the panel with a Windows drive letter uppercased", async (t) => {
  const h = await harness(t, { workspaceFolders: folder("c:/work/app") });
  await resolve(h);
  assert.equal(new URL(h.api.panelLoaded()).searchParams.get("cwd"), "C:/work/app");
});

test("the panel theme is light for light and high-contrast-light editors, and dark otherwise", async (t) => {
  const cases = [
    [ColorThemeKind.Light, "light"],
    [ColorThemeKind.HighContrastLight, "light"],
    [ColorThemeKind.Dark, "dark"],
    [ColorThemeKind.HighContrast, "dark"],
  ];
  for (const [kind, expected] of cases) {
    await t.test(`theme kind ${kind} gives ${expected}`, async (st) => {
      const h = await harness(st, { themeKind: kind });
      await resolve(h);
      assert.equal(new URL(h.api.panelLoaded()).searchParams.get("theme"), expected);
    });
  }
});

test("the panel divider follows the side bar location unless helicon.panelBorder picks an edge", async (t) => {
  const cases = [
    ["auto with the side bar on the left puts the divider on the right", {}, "right"],
    ["auto with the side bar on the right puts the divider on the left", { "workbench.sideBar.location": "right" }, "left"],
    ["an explicit left edge wins over the side bar location", { "helicon.panelBorder": "left" }, "left"],
    ["an unknown value falls back to the side bar location", { "helicon.panelBorder": "bogus", "workbench.sideBar.location": "right" }, "left"],
    ["none draws no divider", { "helicon.panelBorder": "none" }, null],
  ];
  for (const [name, config, side] of cases) {
    await t.test(name, async (st) => {
      const h = await harness(st, { config });
      const view = await resolve(h);
      const match = /body \{ border-(left|right): 1px solid/.exec(view.webview.html);
      if (side === null) {
        assert.equal(match, null);
      } else {
        assert.equal(match?.[1], side);
      }
    });
  }
});

test("with no workspace folder the panel loads without a cwd and adds no project", async (t) => {
  const h = await harness(t);
  await resolve(h);
  assert.equal(new URL(h.api.panelLoaded()).searchParams.has("cwd"), false);
  assert.equal((await h.serverLog()).filter((entry) => entry.method === "POST").length, 0);
});

test("the panel adds its folder as a project on the server, and logs a refused add", async (t) => {
  const h = await harness(t, { mode: "reject", workspaceFolders: folder("/work/app") });
  await resolve(h);
  await until(() => h.fake.log.output.includes("Adding /work/app as a project failed: 500 no project"), "the refused add to be logged");
  const posts = (await h.serverLog()).filter((entry) => entry.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/projects");
  assert.deepEqual(JSON.parse(posts[0].body), { cwd: "/work/app" });
});

test("a server that cannot start shows the reason inside the panel and loads no page", async (t) => {
  const h = await harness(t, { withServer: false });
  const view = await resolve(h);
  assert.equal(h.api.panelLoaded(), null);
  assert.ok(view.webview.html.includes("Helicon could not start: helicon-server exited before it was ready (code 1). Run"), view.webview.html);
  assert.ok(view.webview.html.includes("Helicon: Show Log"), view.webview.html);
});

test("helicon.open focuses the panel, and helicon.showLog shows the output channel", async (t) => {
  const h = await harness(t);
  await h.run("helicon.open");
  await h.run("helicon.showLog");
  assert.deepEqual(
    h.fake.log.executed.map((entry) => entry.id),
    ["helicon.panel.focus"],
  );
  assert.deepEqual(h.fake.log.shown, ["output"]);
});

test("helicon.newThread navigates the panel to a new thread in the workspace folder", async (t) => {
  const h = await harness(t, { workspaceFolders: folder("/work/app") });
  const view = await resolve(h);
  await h.run("helicon.newThread");
  assert.deepEqual(h.fake.log.executed.map((entry) => entry.id), ["helicon.panel.focus"]);
  assert.deepEqual(view.webview.posted.at(-1), newThread("/work/app"));
});

test("helicon.newThread during a cold start opens the panel on the new thread once it loads", async (t) => {
  const h = await harness(t, { workspaceFolders: folder("/work/app") });
  const view = new FakeView();
  const resolving = h.fake.viewProviders.get(PANEL).provider.resolveWebviewView(view);
  await h.run("helicon.newThread");
  await resolving;
  assert.equal(view.webview.posted.some((message) => message.type === "navigate-hash"), false);
  assert.ok(h.api.panelLoaded()?.endsWith(newThread("/work/app").hash), h.api.panelLoaded());
  await h.run("helicon.newThread");
  assert.deepEqual(view.webview.posted.at(-1), newThread("/work/app"));
});

test("a reload that overlaps a cold start keeps the new thread asked for during it", async (t) => {
  const h = await harness(t, { workspaceFolders: folder("/work/app") });
  const view = new FakeView();
  const resolving = h.fake.viewProviders.get(PANEL).provider.resolveWebviewView(view);
  h.fake.events.folders.fire();
  await h.run("helicon.newThread");
  await resolving;
  await until(() => view.webview.html.includes("<iframe"), "the panel to load");
  // Give the other load time to finish too: whichever ends last must not drop the page.
  await new Promise((done) => setTimeout(done, 50));
  assert.ok(h.api.panelLoaded()?.endsWith(newThread("/work/app").hash), h.api.panelLoaded());
});

test("helicon.newThread without a workspace folder navigates to a bare new thread", async (t) => {
  const h = await harness(t);
  const view = await resolve(h);
  await h.run("helicon.newThread");
  assert.deepEqual(view.webview.posted.at(-1), { type: "navigate-hash", hash: "#/new" });
});

test("helicon.openInEditor opens one editor tab, and reveals it when it is already open", async (t) => {
  const h = await harness(t);
  await h.run("helicon.openInEditor");
  await h.run("helicon.openInEditor");
  assert.equal(h.fake.log.panels.length, 1);
  const [{ viewType, title, column, options, panel }] = h.fake.log.panels;
  assert.equal(viewType, "helicon");
  assert.equal(title, "Helicon");
  assert.equal(column, ViewColumn.Active);
  assert.deepEqual(options, { enableScripts: true, retainContextWhenHidden: true });
  assert.deepEqual(panel.revealed, [ViewColumn.Active]);
  assert.ok(panel.webview.html.includes(`src="${await h.api.serverUrl()}/?host=editor&theme=dark"`));
});

test("closing the editor tab lets helicon.openInEditor open a new one", async (t) => {
  const h = await harness(t);
  await h.run("helicon.openInEditor");
  h.fake.log.panels[0].panel.dispose();
  await h.run("helicon.openInEditor");
  assert.equal(h.fake.log.panels.length, 2);
});

test("helicon.openForFolder on the workspace folder navigates the side panel and opens no tab", async (t) => {
  const h = await harness(t, { workspaceFolders: folder("/work/app") });
  const view = await resolve(h);
  await h.run("helicon.openForFolder");
  await h.run("helicon.openForFolder", Uri.file("/work/app"));
  assert.equal(h.fake.log.panels.length, 0);
  assert.deepEqual(view.webview.posted, [newThread("/work/app"), newThread("/work/app")]);
});

test("helicon.openForFolder on another folder adds it as a project and opens its new thread in an editor tab", async (t) => {
  const h = await harness(t, { workspaceFolders: folder("/work/app") });
  await resolve(h);
  await h.run("helicon.openForFolder", Uri.file("/other/repo"));
  const posts = (await h.serverLog()).filter((entry) => entry.method === "POST" && JSON.parse(entry.body).cwd === "/other/repo");
  assert.equal(posts.length, 1);
  assert.equal(h.fake.log.panels.length, 1);
  assert.ok(h.fake.log.panels[0].panel.webview.html.includes("#/new/%2Fother%2Frepo"));
});

test("helicon.openInBrowser opens the server page in the browser", async (t) => {
  const h = await harness(t);
  await h.run("helicon.openInBrowser");
  assert.deepEqual(h.fake.log.opened, [await h.api.serverUrl()]);
});

test("helicon.restart stops the server, closes the editor tab, and reloads the panel on a fresh server", async (t) => {
  const h = await harness(t);
  const view = await resolve(h);
  await h.run("helicon.openInEditor");
  await h.run("helicon.restart");
  assert.equal(startCount(h.fake), 2);
  assert.notEqual(h.api.panelLoaded(), null);
  assert.ok(view.webview.html.includes(`src="${h.api.panelLoaded()}"`));
  await h.run("helicon.openInEditor");
  assert.equal(h.fake.log.panels.length, 2, "the old editor tab was closed, so a new one opens");
});

test("a theme change is sent to the side panel and to an open editor tab", async (t) => {
  const h = await harness(t);
  const view = await resolve(h);
  await h.run("helicon.openInEditor");
  h.fake.window.activeColorTheme.kind = ColorThemeKind.Light;
  h.fake.events.theme.fire();
  const message = { type: "helicon-theme", theme: "light" };
  assert.deepEqual(view.webview.posted.at(-1), message);
  assert.deepEqual(h.fake.log.panels[0].panel.webview.posted.at(-1), message);
});

test("a panelBorder change reloads the panel, an unrelated setting does not, and a folder change reloads it", async (t) => {
  const h = await harness(t);
  const view = await resolve(h);
  const before = view.webview.htmlHistory.length;
  h.fake.events.config.fire({ affectsConfiguration: (key) => key === "helicon.panelBorder" });
  await until(() => view.webview.htmlHistory.length > before && view.webview.html.includes("<iframe"), "the panel to reload");
  const reloaded = view.webview.htmlHistory.length;
  h.fake.events.config.fire({ affectsConfiguration: (key) => key === "editor.fontSize" });
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  assert.equal(view.webview.htmlHistory.length, reloaded);
  h.fake.events.folders.fire();
  await until(() => view.webview.htmlHistory.length > reloaded && view.webview.html.includes("<iframe"), "the panel to reload on a folder change");
});

test("commands from the framed page: copy writes the clipboard and openFolder runs the open-folder command, others are ignored", async (t) => {
  const h = await harness(t);
  h.api.frameMessage({ type: "command", command: "copy", args: { text: "hello" } });
  h.api.frameMessage({ type: "command", command: "copy", args: { text: 5 } });
  h.api.frameMessage({ type: "command", command: "openFolder" });
  h.api.frameMessage({ type: "command", command: "deleteEverything", args: {} });
  h.api.frameMessage({ type: "navigate", command: "copy", args: { text: "x" } });
  h.api.frameMessage(null);
  assert.deepEqual(h.fake.log.clipboardWritten, ["hello"]);
  assert.deepEqual(
    h.fake.log.executed.map((entry) => entry.id),
    ["vscode.openFolder"],
  );
});

test("openExternal opens web and mail links from a reply, and ignores other schemes", async (t) => {
  const h = await harness(t);
  h.api.frameMessage({ type: "command", command: "openExternal", args: { url: "https://t.me/helicon" } });
  h.api.frameMessage({ type: "command", command: "openExternal", args: { url: "http://example.com/a" } });
  h.api.frameMessage({ type: "command", command: "openExternal", args: { url: "mailto:hello@helicon.sh" } });
  h.api.frameMessage({ type: "command", command: "openExternal", args: { url: "javascript:alert(1)" } });
  h.api.frameMessage({ type: "command", command: "openExternal", args: { url: "file:///etc/passwd" } });
  h.api.frameMessage({ type: "command", command: "openExternal", args: { url: "not a url" } });
  h.api.frameMessage({ type: "command", command: "openExternal", args: {} });
  await until(() => h.fake.log.opened.length >= 3, "the links to open");
  assert.deepEqual(h.fake.log.opened, ["https://t.me/helicon", "http://example.com/a", "mailto:hello@helicon.sh"]);
});

test("paste reads the clipboard and answers the view that asked, and does nothing without a view", async (t) => {
  const h = await harness(t);
  const view = await resolve(h);
  h.fake.clipboardText = "pasted text";
  view.webview.receive({ type: "command", command: "paste", args: { id: 7 } });
  await until(() => view.webview.posted.some((message) => message.type === "helicon-paste"), "the paste reply");
  assert.deepEqual(view.webview.posted.at(-1), { type: "helicon-paste", id: 7, text: "pasted text" });
  h.api.frameMessage({ type: "command", command: "paste", args: { id: 8 } });
  assert.equal(h.fake.log.clipboardReads, 1);
});

test("helicon.openFile opens a reply's file at its line, and says why it cannot", async (t) => {
  const h = await harness(t, { existingFiles: ["/work/app/src/a.ts", "/work/app/src/b.ts"] });
  const opens = () => h.fake.log.executed.filter((entry) => entry.id === "vscode.open");
  const openFile = (args) => h.api.frameMessage({ type: "command", command: "openFile", args });

  openFile({ cwd: "/work/app", path: "/work/app/src/a.ts", line: { start: 10, end: 12 } });
  await until(() => opens().length === 1, "the first file to open");
  assert.equal(opens()[0].args[0].fsPath, "/work/app/src/a.ts");
  assert.deepEqual(opens()[0].args[1], {
    preview: false,
    viewColumn: ViewColumn.Active,
    selection: new Range(9, 0, 11, 0),
  });

  openFile({ cwd: "/work/app", path: "src/b.ts", line: { start: 0 } });
  await until(() => opens().length === 2, "the relative file to open");
  assert.equal(opens()[1].args[0].fsPath.replaceAll("\\", "/"), "/work/app/src/b.ts");
  assert.equal("selection" in opens()[1].args[1], false, "a line of 0 selects nothing");

  openFile({ cwd: "/work/app", path: "src/missing.ts" });
  await until(() => h.fake.log.messages.length === 1, "the missing-file warning");
  assert.deepEqual(h.fake.log.messages[0], {
    level: "warning",
    message: "Helicon: src/missing.ts was not found in /work/app.",
  });

  openFile({ cwd: "ssh://box/home/me/app", path: "src/a.ts" });
  await until(() => h.fake.log.messages.length === 2, "the SSH notice");
  assert.equal(h.fake.log.messages[1].level, "info");
  assert.deepEqual(h.fake.log.statted, ["/work/app/src/a.ts", "/work/app/src/b.ts", "/work/app/src/missing.ts"], "SSH files are not stat'd");

  openFile({ cwd: "/work/app", path: "" });
  openFile({ cwd: 3, path: "src/a.ts" });
  assert.equal(opens().length, 2);
  assert.equal(h.fake.log.messages.length, 2);
});
