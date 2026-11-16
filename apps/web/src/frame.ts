import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CaptionHitAreas, CaptionState, WindowFrame } from "@helicon/ui";

declare global {
  interface Window {
    /** Set by the desktop shell before the page loads when the window has no native title bar. */
    __HELICON_FRAME__?: string;
    /** Set by the desktop shell before the page loads when macOS traffic lights float over the UI. */
    __HELICON_TITLEBAR__?: string;
  }
  interface WindowEventMap {
    "helicon-zoom": CustomEvent<number>;
    "helicon-zoom-step": CustomEvent<"in" | "out" | "reset">;
    "helicon-menu": CustomEvent<"new-thread" | "settings">;
  }
}

/** True on macOS, where the desktop shell overlays the traffic lights on the sidebar. */
export function titlebarOverlay(): boolean {
  return window.__HELICON_TITLEBAR__ === "overlay";
}

/**
 * Desktop zoom must go through the webview, not CSS `zoom` on <html>: WKWebView then mis-places
 * every Radix `position: fixed` menu. No-op in a browser. Call once at startup.
 */
export function bindDesktopZoom(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }
  const apply = (zoom: number) => {
    getCurrentWebview()
      .setZoom(zoom)
      .catch((error: unknown) => console.error("Helicon: webview zoom failed", error));
  };
  window.addEventListener("helicon-zoom", (event) => apply(event.detail));
  void listen<"in" | "out" | "reset">("helicon://zoom", (event) => {
    window.dispatchEvent(new CustomEvent("helicon-zoom-step", { detail: event.payload }));
  }).catch((error: unknown) => console.error("Helicon: zoom menu listen failed", error));
  // New Thread (Cmd+N) and Settings (Cmd+,) in the native menu bar, where macOS users and VoiceOver look for them.
  void listen<"new-thread" | "settings">("helicon://menu", (event) => {
    window.dispatchEvent(new CustomEvent("helicon-menu", { detail: event.payload }));
  }).catch((error: unknown) => console.error("Helicon: menu listen failed", error));
}

/**
 * The Windows shell's native hit areas over the caption buttons: the page says where its buttons are,
 * and the shell says which one the pointer is over, since the page no longer sees it there.
 */
function captionHitAreas(): CaptionHitAreas {
  return {
    place: (rects) => {
      emit("helicon://caption-layout", { buttons: rects ?? [] }).catch((error: unknown) =>
        console.error("Helicon: caption layout failed", error),
      );
    },
    onState: (callback) => {
      const pending = listen<CaptionState>("helicon://caption-state", (event) => callback(event.payload));
      pending.catch((error: unknown) => console.error("Helicon: caption state listener failed", error));
      return () => {
        pending.then(
          (unlisten) => unlisten(),
          () => undefined,
        );
      };
    },
  };
}

/** Window controls for the desktop shell's frameless window; undefined in a browser. */
export function desktopFrame(): WindowFrame | undefined {
  if (window.__HELICON_FRAME__ !== "custom") {
    return undefined;
  }
  const win = getCurrentWindow();
  const run = (action: Promise<unknown>) => {
    action.catch((error: unknown) => console.error("Helicon: window control failed", error));
  };
  return {
    minimize: () => run(win.minimize()),
    toggleMaximize: () => run(win.toggleMaximize()),
    close: () => run(win.close()),
    startDragging: () => run(win.startDragging()),
    isMaximized: () => win.isMaximized(),
    onResized: (callback) => {
      const pending = win.onResized(() => callback());
      pending.catch((error: unknown) => console.error("Helicon: resize listener failed", error));
      return () => {
        pending.then(
          (unlisten) => unlisten(),
          () => undefined,
        );
      };
    },
    captionHitAreas: captionHitAreas(),
  };
}
