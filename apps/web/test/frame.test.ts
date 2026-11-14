import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { bindDesktopZoom, desktopFrame, titlebarOverlay } from "../src/frame.js";
import { captureConsoleError, stubGlobal, tauriWindow, tick } from "./stubs.js";

describe("window titlebar", () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    while (restores.length) restores.pop()?.();
  });

  it("overlays the traffic lights only when the shell says so", () => {
    restores.push(stubGlobal("window", { __HELICON_TITLEBAR__: "overlay" }));
    assert.equal(titlebarOverlay(), true);
    restores.pop()?.();

    restores.push(stubGlobal("window", { __HELICON_TITLEBAR__: "none" }));
    assert.equal(titlebarOverlay(), false);
    restores.pop()?.();

    restores.push(stubGlobal("window", {}));
    assert.equal(titlebarOverlay(), false);
  });
});

describe("desktop zoom", () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    while (restores.length) restores.pop()?.();
  });

  it("does nothing in a browser", () => {
    restores.push(
      stubGlobal("window", {
        addEventListener() {
          throw new Error("a browser must not listen for desktop zoom");
        },
      }),
    );
    assert.doesNotThrow(() => bindDesktopZoom());
  });

  it("sets the webview zoom from helicon-zoom, and relays the menu's zoom steps", async () => {
    const tauri = tauriWindow((cmd, args) => (cmd === "plugin:event|listen" ? (args.event === "helicon://zoom" ? 1 : 2) : undefined));
    restores.push(stubGlobal("window", tauri.window));
    const steps: unknown[] = [];
    const menus: unknown[] = [];
    tauri.window.addEventListener("helicon-zoom-step", (event: Event) => steps.push((event as CustomEvent).detail));
    tauri.window.addEventListener("helicon-menu", (event: Event) => menus.push((event as CustomEvent).detail));

    bindDesktopZoom();
    await tick();
    const listened = tauri.calls.filter((call) => call.cmd === "plugin:event|listen").map((call) => call.args.event);
    assert.deepEqual(listened, ["helicon://zoom", "helicon://menu"]);

    tauri.window.dispatchEvent(new CustomEvent("helicon-zoom", { detail: 1.25 }));
    await tick();
    const zoom = tauri.calls.find((call) => call.cmd === "plugin:webview|set_webview_zoom");
    assert.deepEqual(zoom?.args, { label: "main", value: 1.25 });

    const zoomListen = tauri.calls.find((call) => call.cmd === "plugin:event|listen" && call.args.event === "helicon://zoom");
    const menuListen = tauri.calls.find((call) => call.cmd === "plugin:event|listen" && call.args.event === "helicon://menu");
    tauri.fire(zoomListen?.args.handler, { event: "helicon://zoom", id: 1, payload: "in" });
    tauri.fire(menuListen?.args.handler, { event: "helicon://menu", id: 2, payload: "settings" });
    assert.deepEqual(steps, ["in"]);
    assert.deepEqual(menus, ["settings"]);
  });

  it("logs a failed zoom or a failed listener, and keeps the app running", async () => {
    const logs = captureConsoleError();
    try {
      const tauri = tauriWindow((cmd, args) => {
        if (cmd === "plugin:webview|set_webview_zoom") throw new Error("no webview");
        if (cmd === "plugin:event|listen" && args.event === "helicon://menu") throw new Error("no menu");
        return cmd === "plugin:event|listen" ? 1 : undefined;
      });
      restores.push(stubGlobal("window", tauri.window));
      bindDesktopZoom();
      tauri.window.dispatchEvent(new CustomEvent("helicon-zoom", { detail: 2 }));
      await tick();
      await tick();
      const messages = logs.messages.map((args) => args[0]);
      assert.ok(messages.includes("Helicon: webview zoom failed"));
      assert.ok(messages.includes("Helicon: menu listen failed"));
    } finally {
      logs.restore();
    }
  });
});

describe("desktop window frame", () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    while (restores.length) restores.pop()?.();
  });

  it("is undefined unless the shell asked for a custom frame", () => {
    restores.push(stubGlobal("window", {}));
    assert.equal(desktopFrame(), undefined);
    restores.pop()?.();

    restores.push(stubGlobal("window", { __HELICON_FRAME__: "native" }));
    assert.equal(desktopFrame(), undefined);
  });

  it("drives the main window through its controls", async () => {
    const tauri = tauriWindow((cmd) => (cmd === "plugin:window|is_maximized" ? true : undefined));
    tauri.window.__HELICON_FRAME__ = "custom";
    restores.push(stubGlobal("window", tauri.window));
    const frame = desktopFrame();
    assert.ok(frame);
    frame.minimize();
    frame.toggleMaximize();
    frame.startDragging();
    frame.close();
    assert.equal(await frame.isMaximized(), true);
    await tick();
    assert.deepEqual(
      tauri.calls.map((call) => call.cmd),
      [
        "plugin:window|minimize",
        "plugin:window|toggle_maximize",
        "plugin:window|start_dragging",
        "plugin:window|close",
        "plugin:window|is_maximized",
      ],
    );
    assert.deepEqual(tauri.calls[0]?.args, { label: "main" });
  });

  it("logs a failed window control without throwing", async () => {
    const logs = captureConsoleError();
    try {
      const tauri = tauriWindow(() => {
        throw new Error("no window");
      });
      tauri.window.__HELICON_FRAME__ = "custom";
      restores.push(stubGlobal("window", tauri.window));
      const frame = desktopFrame();
      assert.ok(frame);
      frame.minimize();
      await tick();
      await tick();
      assert.equal(logs.messages[0]?.[0], "Helicon: window control failed");
    } finally {
      logs.restore();
    }
  });

  it("logs a resize listener that fails to start instead of leaving it unhandled", async () => {
    const tauri = tauriWindow((cmd) => {
      if (cmd === "plugin:event|listen") throw new Error("no event plugin");
      return undefined;
    });
    tauri.window.__HELICON_FRAME__ = "custom";
    restores.push(stubGlobal("window", tauri.window));
    const logs = captureConsoleError();
    try {
      const frame = desktopFrame();
      assert.ok(frame);
      frame.onResized(() => {});
      await tick();
      await tick();
      assert.equal(logs.messages[0]?.[0], "Helicon: resize listener failed");
    } finally {
      logs.restore();
    }
  });

  it("calls back on resize until the returned cleanup stops listening", async () => {
    const tauri = tauriWindow((cmd) => (cmd === "plugin:event|listen" ? 3 : undefined));
    tauri.window.__HELICON_FRAME__ = "custom";
    restores.push(stubGlobal("window", tauri.window));
    const frame = desktopFrame();
    assert.ok(frame);
    let resized = 0;
    const stop = frame.onResized(() => {
      resized += 1;
    });
    assert.ok(stop);
    await tick();
    const listen = tauri.calls.find((call) => call.cmd === "plugin:event|listen");
    assert.equal(listen?.args.event, "tauri://resize");
    tauri.fire(listen?.args.handler, { event: "tauri://resize", id: 1, payload: { Physical: { width: 800, height: 600 } } });
    assert.equal(resized, 1);

    stop();
    await tick();
    assert.deepEqual(
      tauri.calls.filter((call) => call.cmd === "plugin:event|unlisten").map((call) => call.args),
      [{ event: "tauri://resize", eventId: 3 }],
    );
  });
});

describe("caption hit areas", () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    while (restores.length) restores.pop()?.();
  });

  it("sends the buttons' layout to the shell, and an empty one to take the hit areas away", async () => {
    const tauri = tauriWindow(() => undefined);
    tauri.window.__HELICON_FRAME__ = "custom";
    restores.push(stubGlobal("window", tauri.window));
    const hitAreas = desktopFrame()?.captionHitAreas;
    assert.ok(hitAreas);
    const rect = { right: 69, top: 0, width: 69, height: 72 };
    hitAreas.place([rect, rect, rect]);
    hitAreas.place(null);
    await tick();
    const emits = tauri.calls.filter((call) => call.cmd === "plugin:event|emit").map((call) => call.args);
    assert.deepEqual(emits, [
      { event: "helicon://caption-layout", payload: { buttons: [rect, rect, rect] } },
      { event: "helicon://caption-layout", payload: { buttons: [] } },
    ]);
  });

  it("relays hover and press from the shell until the returned cleanup stops listening", async () => {
    const tauri = tauriWindow((cmd) => (cmd === "plugin:event|listen" ? 4 : undefined));
    tauri.window.__HELICON_FRAME__ = "custom";
    restores.push(stubGlobal("window", tauri.window));
    const hitAreas = desktopFrame()?.captionHitAreas;
    assert.ok(hitAreas);
    const states: unknown[] = [];
    const stop = hitAreas.onState((state) => states.push(state));
    await tick();
    const listen = tauri.calls.find((call) => call.cmd === "plugin:event|listen");
    assert.equal(listen?.args.event, "helicon://caption-state");
    tauri.fire(listen?.args.handler, { event: "helicon://caption-state", id: 1, payload: { hovered: "maximize", pressed: null } });
    assert.deepEqual(states, [{ hovered: "maximize", pressed: null }]);

    stop();
    await tick();
    assert.deepEqual(
      tauri.calls.filter((call) => call.cmd === "plugin:event|unlisten").map((call) => call.args),
      [{ event: "helicon://caption-state", eventId: 4 }],
    );
  });
});
