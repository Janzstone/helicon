import { Suspense, useEffect, useRef, useState, type ReactElement } from "react";
import type { HeliconClient } from "../client.js";
import { AddProjectDialog } from "../components/sidebar/AddProjectDialog.js";
import { BootError, BootScreen, NewThread, Onboarding, Welcome } from "../components/home/Home.js";
import { SettingsPage, UsagePage, WhatsNew } from "./lazy.js";
import { CommandPalette } from "../components/palette/CommandPalette.js";
import { isTyping } from "../components/requests/Requests.js";
import { Sidebar } from "../components/sidebar/Sidebar.js";
import { ThreadView } from "../components/thread/ThreadView.js";
import { TooltipProvider } from "../components/ui/overlays.js";
import { cn, isMac } from "../components/ui/primitives.js";
import { Toasts } from "../components/ui/Toasts.js";
import { HeliconController, type Platform } from "../model/controller.js";
import type { Notifier } from "../model/notify.js";
import type { AppUpdater } from "../model/updates.js";
import { zoomStepFromKey, type ZoomStep } from "../model/zoom-shortcut.js";
import { ControllerProvider, useApp, useController } from "./context.js";
import { PanelContext, type PanelMode } from "./panel.js";
import { installEditorClipboard, postToHost, setEditorHosted, useHostTheme } from "./host.js";
import { catchOutsideLinks } from "./links.js";
import { PanelShell } from "../components/panel/Panel.js";
import { FrameProvider, FrameStrip, WindowControls, type WindowFrame } from "./frame.js";
import { FocusKeeper, LiveAnnouncer, announce } from "./a11y.js";

declare global {
  interface WindowEventMap {
    "helicon-zoom-step": CustomEvent<ZoomStep>;
    /** A command from the desktop shell's native menu. */
    "helicon-menu": CustomEvent<MenuCommand>;
  }
}

export interface HeliconAppProps {
  client: HeliconClient;
  platform?: Platform;
  /** Present when a desktop shell wants the UI to draw the window's title bar. */
  frame?: WindowFrame;
  /** Present when the shell overlays macOS traffic lights on the UI instead of a title bar. */
  titlebarOverlay?: boolean;
  /** Present when the shell can update itself. */
  updater?: AppUpdater;
  /** How this shell raises a system notification; absent where it cannot. */
  notifier?: Notifier;
  /** The compact layout for a narrow host, such as an editor extension's side panel. */
  panel?: PanelMode;
  /** The host's color scheme, when it has its own (an editor theme); overrides the system one. */
  hostTheme?: "light" | "dark";
  /** The page is framed by an editor, which opens files a reply names in its own tabs. */
  editorHost?: boolean;
}

export type MenuCommand = "new-thread" | "settings";

/** The whole Helicon interface. Web and desktop shells mount this with their transport. */
export function HeliconApp(props: HeliconAppProps) {
  const [controller] = useState(() => {
    const created = new HeliconController(props.client, props.platform);
    if (props.updater) {
      created.attachUpdater(props.updater);
    }
    if (props.notifier) {
      created.attachNotifier(props.notifier);
    }
    if (props.editorHost) {
      setEditorHosted(true);
      created.setExternalFileOpener((cwd, path, line) => postToHost({ type: "helicon-command", command: "openFile", args: { cwd, path, line } }));
    }
    return created;
  });
  useEffect(() => controller.start(), [controller]);
  useEffect(() => (props.editorHost ? installEditorClipboard(isMac) : undefined), [props.editorHost]);
  // The editor's webview drops link clicks from a framed page, so outside links go through the editor instead.
  useEffect(
    () => (props.editorHost ? catchOutsideLinks((url) => postToHost({ type: "helicon-command", command: "openExternal", args: { url } })) : undefined),
    [props.editorHost],
  );
  const hostTheme = useHostTheme(props.hostTheme);
  const panel = props.panel ?? null;
  return (
    <ControllerProvider controller={controller}>
      <PanelContext.Provider value={panel}>
        <FrameProvider frame={props.frame} overlay={props.titlebarOverlay}>
          <TooltipProvider>
            <ThemeSync hostTheme={hostTheme} />
            <ZoomSync />
            <GlobalShortcuts panel={panel !== null} />
            {panel ? <PanelShell /> : <Shell />}
            {panel ? null : <CommandPalette />}
            {panel ? null : <AddProjectDialog />}
            <Toasts
              leading={
                <Suspense fallback={null}>
                  <WhatsNew />
                </Suspense>
              }
            />
            <WindowControls />
            <LiveAnnouncer />
            <RouteAnnouncer />
            <FocusKeeper />
          </TooltipProvider>
        </FrameProvider>
      </PanelContext.Provider>
    </ControllerProvider>
  );
}

/**
 * Says where the user landed whenever the open thread or page changes, however it changed: a sidebar row,
 * the palette, Option+Arrow, a notification. Nothing is said for the page the app opens on.
 */
function RouteAnnouncer() {
  const controller = useController();
  // Only a change of place is said, not a thread's title changing while it is open.
  const key = useApp((s) => (s.route.kind === "thread" ? `thread:${s.route.sessionId}` : s.route.kind === "new" ? `new:${s.route.cwd ?? ""}` : s.route.kind));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const state = controller.store.get();
    const route = state.route;
    if (route.kind === "thread") {
      announce(`Opened thread ${state.sessions[route.sessionId]?.title ?? ""}`.trim());
    } else if (route.kind === "settings") {
      announce("Settings");
    } else if (route.kind === "usage") {
      announce("Usage");
    } else {
      announce("New thread");
    }
  }, [controller, key]);
  return null;
}

function ThemeSync(props: { hostTheme: "light" | "dark" | null }) {
  const pref = useApp((s) => s.prefs.theme);
  // A host theme stands in for "system": an explicit light or dark choice in Settings still wins.
  const theme = pref === "system" && props.hostTheme ? props.hostTheme : pref;
  const codeTheme = useApp((s) => s.prefs.codeTheme);
  useEffect(() => {
    document.documentElement.dataset["codeTheme"] = codeTheme;
  }, [codeTheme]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset["theme"] = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    if (theme !== "system") {
      return;
    }
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return null;
}

function ZoomSync() {
  const zoom = useApp((s) => s.prefs.zoom);
  useEffect(() => {
    // CSS `zoom` on <html> breaks Radix `position: fixed` menus in WKWebView (the desktop
    // shell). The desktop page listens for `helicon-zoom` and uses the webview's own zoom
    // instead. Browsers keep CSS zoom; engines that lack it fall back to the root font size.
    // The pre-paint script in index.html applies the same split so a reload never flashes 100%.
    const root = document.documentElement;
    const style = root.style as CSSStyleDeclaration & { zoom?: unknown };
    const desktop = "__TAURI_INTERNALS__" in window;
    if (desktop) {
      if ("zoom" in style) {
        style.zoom = "";
      }
      root.style.fontSize = "";
      root.style.removeProperty("--app-zoom");
      window.dispatchEvent(new CustomEvent("helicon-zoom", { detail: zoom }));
      return;
    }
    if ("zoom" in style) {
      style.zoom = zoom === 1 ? "" : String(zoom);
      // Chromium scales a fixed element's transform by the page zoom a second time, so every Radix
      // menu lands down and to the right of its trigger. theme.css cancels the zoom on the popper
      // wrapper and puts it back on the menu itself, using this variable.
      if (zoom === 1) {
        root.style.removeProperty("--app-zoom");
      } else {
        root.style.setProperty("--app-zoom", String(zoom));
      }
      root.style.fontSize = "";
    } else {
      root.style.removeProperty("--app-zoom");
      root.style.fontSize = zoom === 1 ? "" : `${Math.round(16 * zoom * 100) / 100}px`;
    }
  }, [zoom]);
  return null;
}

function applyZoomStep(controller: HeliconController, step: ZoomStep) {
  if (step === "in") {
    controller.zoomIn();
  } else if (step === "out") {
    controller.zoomOut();
  } else {
    controller.resetZoom();
  }
}

function GlobalShortcuts(props: { panel: boolean }) {
  const controller = useController();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Inside an editor the editor owns these chords (Cmd+B, Cmd+K, Cmd+Shift+E...); only zoom stays.
      if (props.panel && !zoomStepFromKey(event, isMac)) {
        return;
      }
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      const zoom = zoomStepFromKey(event, isMac);
      if (zoom) {
        event.preventDefault();
        applyZoomStep(controller, zoom);
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && key === "k") {
        event.preventDefault();
        controller.setPaletteOpen(!controller.store.get().paletteOpen);
      } else if (mod && event.shiftKey && key === "o") {
        event.preventDefault();
        controller.newThread();
      } else if (mod && !event.shiftKey && !event.altKey && key === "n") {
        // The macOS convention, with Cmd+Shift+O kept for those used to it. A browser keeps Cmd+N for itself.
        event.preventDefault();
        controller.newThread();
      } else if (mod && !event.shiftKey && !event.altKey && key === ",") {
        event.preventDefault();
        controller.navigate({ kind: "settings" });
      } else if (mod && !event.shiftKey && key === "b") {
        event.preventDefault();
        controller.toggleSidebar();
      } else if (mod && event.shiftKey && !event.altKey && key === "e") {
        event.preventDefault();
        controller.toggleFiles();
      } else if (
        event.altKey &&
        !mod &&
        // Control+Option is VoiceOver's own modifier: its arrow keys move the reading cursor, never the thread.
        !event.ctrlKey &&
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        !isTyping(event.target)
      ) {
        const state = controller.store.get();
        const ordered = Object.values(state.sessions).sort((a, b) => (a.activityAt < b.activityAt ? 1 : -1));
        if (ordered.length === 0) {
          return;
        }
        event.preventDefault();
        const current = state.route.kind === "thread" ? ordered.findIndex((s) => s.sessionId === (state.route as { sessionId: string }).sessionId) : -1;
        const next = event.key === "ArrowDown" ? Math.min(ordered.length - 1, current + 1) : Math.max(0, current - 1);
        const target = ordered[next];
        if (target && target.sessionId !== (state.route.kind === "thread" ? state.route.sessionId : null)) {
          controller.openThread(target.sessionId);
        }
      }
    };
    const onMenuZoom = (event: Event) => {
      const step = (event as CustomEvent<ZoomStep>).detail;
      if (step === "in" || step === "out" || step === "reset") {
        applyZoomStep(controller, step);
      }
    };
    const onMenu = (event: Event) => {
      const command = (event as CustomEvent<MenuCommand>).detail;
      if (command === "new-thread") {
        controller.newThread();
      } else if (command === "settings") {
        controller.navigate({ kind: "settings" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("helicon-zoom-step", onMenuZoom);
    window.addEventListener("helicon-menu", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("helicon-zoom-step", onMenuZoom);
      window.removeEventListener("helicon-menu", onMenu);
    };
  }, [controller, props.panel]);
  return null;
}

/** Below this width (phones, a narrow browser tab) the sidebar floats over the page instead of squeezing it. */
const NARROW_QUERY = "(max-width: 767px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return narrow;
}

function Shell() {
  const controller = useController();
  const boot = useApp((s) => s.boot);
  const env = useApp((s) => s.env);
  const collapsed = useApp((s) => s.prefs.sidebarCollapsed);
  const routeKey = useApp((s) => JSON.stringify(s.route));
  const narrow = useNarrow();
  // A narrow window starts with the sidebar hidden, and gets it back on widening if Helicon was the one that hid it.
  const autoHidden = useRef(false);
  useEffect(() => {
    if (narrow && !collapsed) {
      autoHidden.current = true;
      controller.setSidebarCollapsed(true);
    } else if (!narrow && autoHidden.current) {
      autoHidden.current = false;
      controller.setSidebarCollapsed(false);
    }
    // Only crossing the width should act; the person's own toggles are left alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);
  // On a narrow window the sidebar covers the page, so picking a thread or page closes it.
  useEffect(() => {
    if (narrow) {
      controller.setSidebarCollapsed(true);
    }
    // Only a route change should close it, not opening it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);
  // Boot, setup and error screens fill the window with no header, so they get a bare drag strip.
  let screen: ReactElement | null = null;
  if (!env) {
    screen = boot === "error" ? <BootError /> : <BootScreen />;
  } else if (!env.museFound) {
    screen = <Onboarding />;
  } else if (boot === "error") {
    screen = <BootError />;
  }
  if (screen) {
    return (
      <>
        {screen}
        <FrameStrip />
      </>
    );
  }
  return (
    <div className="flex h-full w-full bg-bg text-fg">
      {narrow && !collapsed ? (
        <button
          type="button"
          aria-label="Hide sidebar"
          tabIndex={-1}
          className="fixed inset-0 z-30 bg-black/30"
          onClick={() => controller.setSidebarCollapsed(true)}
        />
      ) : null}
      {/* The sidebar stays mounted and wipes open/closed via the 0fr/1fr
          disclosure trick; visibility flips at the end of the close so the
          clipped panel leaves the tab order only once it is gone. */}
      <div
        className={cn(
          "grid h-full transition-[grid-template-columns,visibility] duration-200 ease-drawer motion-reduce:transition-none",
          collapsed ? "grid-cols-[0fr] invisible" : "grid-cols-[1fr] visible",
          narrow && "fixed inset-y-0 left-0 z-40 max-w-[85vw] shadow-xl",
        )}
      >
        <div className="min-w-0 overflow-hidden">
          <Sidebar />
        </div>
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        <Main />
      </main>
    </div>
  );
}

function Main() {
  const route = useApp((s) => s.route);
  const loaded = useApp((s) => s.sessionsLoaded);
  const hasProjects = useApp((s) => s.projects.length > 0);
  const lastProject = useApp((s) => s.prefs.lastProject);
  if (!loaded) {
    return null;
  }
  if (route.kind === "usage") {
    return (
      <Suspense fallback={null}>
        <UsagePage />
      </Suspense>
    );
  }
  if (route.kind === "settings") {
    return (
      <Suspense fallback={null}>
        <SettingsPage />
      </Suspense>
    );
  }
  if (route.kind === "thread") {
    return <ThreadView key={route.sessionId} sessionId={route.sessionId} />;
  }
  if (!hasProjects) {
    return <Welcome />;
  }
  return <NewThread cwd={route.kind === "new" ? route.cwd : lastProject} />;
}
