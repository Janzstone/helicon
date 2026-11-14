import { createContext, forwardRef, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../components/ui/primitives.js";

/** Window chrome a desktop shell hands to the UI when the UI draws the title bar itself. */
export interface WindowFrame {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  startDragging(): void;
  isMaximized(): Promise<boolean>;
  /** Calls back after every resize, and returns an unsubscribe. */
  onResized(callback: () => void): () => void;
  /**
   * Native hit areas the shell lays over the caption buttons, so Windows 11 offers Snap Layouts on
   * maximize and the buttons work while the page is busy. The page never sees the pointer there,
   * so the shell reports hover and press instead.
   */
  captionHitAreas?: CaptionHitAreas;
}

export type CaptionButtonName = "minimize" | "maximize" | "close";

/** A drawn caption button in physical pixels; `right` runs from the window's right edge to the button's left edge. */
export interface CaptionRect {
  right: number;
  top: number;
  width: number;
  height: number;
}

export interface CaptionState {
  hovered: CaptionButtonName | null;
  pressed: CaptionButtonName | null;
}

export interface CaptionHitAreas {
  /** Minimize, maximize and close, in that order; null takes the hit areas away. */
  place(rects: [CaptionRect, CaptionRect, CaptionRect] | null): void;
  /** Calls back when hover or press changes, and returns an unsubscribe. */
  onState(callback: (state: CaptionState) => void): () => void;
}

const NO_CAPTION_STATE: CaptionState = { hovered: null, pressed: null };

/** Where a button sits in physical pixels, from its CSS box, the viewport width and devicePixelRatio (which includes zoom). */
export function captionRect(box: { left: number; top: number; width: number; height: number }, viewportWidth: number, ratio: number): CaptionRect {
  const left = Math.round(box.left * ratio);
  const right = Math.round((box.left + box.width) * ratio);
  return {
    right: Math.round(viewportWidth * ratio) - left,
    top: Math.round(box.top * ratio),
    width: right - left,
    height: Math.round((box.top + box.height) * ratio) - Math.round(box.top * ratio),
  };
}

const FrameContext = createContext<WindowFrame | null>(null);

/** True when the shell overlays macOS traffic lights on the UI instead of a title bar. */
const OverlayContext = createContext(false);

// Presses on these never move the window, even inside a drag region.
const INTERACTIVE =
  'button, a, input, textarea, select, label, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [contenteditable="true"], [data-no-drag]';

export function FrameProvider(props: { frame: WindowFrame | undefined; overlay?: boolean; children: ReactNode }) {
  const frame = props.frame ?? null;
  useEffect(() => {
    if (!frame) {
      return;
    }
    // Any `data-drag-region` surface moves the window, and a double press toggles maximize, like a native title bar.
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (event.button !== 0 || !(target instanceof Element)) {
        return;
      }
      if (!target.closest("[data-drag-region]") || target.closest(INTERACTIVE)) {
        return;
      }
      event.preventDefault();
      if (event.detail === 2) {
        frame.toggleMaximize();
      } else {
        frame.startDragging();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [frame]);
  return (
    <FrameContext.Provider value={frame}>
      <OverlayContext.Provider value={props.overlay ?? false}>{props.children}</OverlayContext.Provider>
    </FrameContext.Provider>
  );
}

export function useFrame(): WindowFrame | null {
  return useContext(FrameContext);
}

export function useTitlebarOverlay(): boolean {
  return useContext(OverlayContext);
}

/**
 * Native drag-region props on macOS overlay windows, empty elsewhere: the Windows shell drags
 * through its own handler, and firing both would double-toggle maximize. `deep` drags from
 * anywhere in the subtree except clickable elements, `self` only from the element itself,
 * and `off` opts one element out so e.g. double-click to rename keeps working.
 */
export function useOverlayDragProps(mode: "deep" | "self" | "off" = "deep"): { "data-tauri-drag-region"?: string } {
  if (!useTitlebarOverlay()) {
    return {};
  }
  return { "data-tauri-drag-region": mode === "deep" ? "deep" : mode === "self" ? "true" : "false" };
}

/** Reserves the caption buttons' width at the end of a `px-3` header, so its own actions never sit under them. */
export function CaptionSpacer() {
  return useFrame() ? <span aria-hidden="true" className="-mr-3 ml-auto w-[138px] shrink-0 self-stretch" /> : null;
}

/** A drag strip for full-window screens that have no header. */
export function FrameStrip() {
  const frame = useFrame();
  const overlay = useTitlebarOverlay();
  const drag = useOverlayDragProps("self");
  if (!frame && !overlay) {
    return null;
  }
  return (
    <div data-drag-region {...drag} aria-hidden="true" className="fixed inset-x-0 top-0 z-[var(--z-sticky)] h-12" />
  );
}

/** Minimize, maximize and close, drawn to match Windows 11 caption buttons. */
export function WindowControls() {
  const frame = useFrame();
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [caption, setCaption] = useState<CaptionState>(NO_CAPTION_STATE);
  const minimizeRef = useRef<HTMLButtonElement>(null);
  const maximizeRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!frame) {
      return;
    }
    let alive = true;
    const sync = () => {
      frame.isMaximized().then(
        (value) => {
          if (alive) {
            setMaximized(value);
          }
        },
        () => undefined,
      );
    };
    sync();
    const unsubscribe = frame.onResized(sync);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [frame]);
  // Keeps the shell's native hit areas over the buttons as the window resizes, zooms or changes monitors.
  const hitAreas = frame?.captionHitAreas;
  useEffect(() => {
    if (!hitAreas) {
      return;
    }
    const buttons = [minimizeRef.current, maximizeRef.current, closeRef.current];
    let last = "";
    const report = () => {
      const rects = buttons.map((button) =>
        button ? captionRect(button.getBoundingClientRect(), window.innerWidth, window.devicePixelRatio) : null,
      );
      if (rects.some((rect) => !rect || rect.width <= 0 || rect.height <= 0)) {
        return;
      }
      const key = JSON.stringify(rects);
      if (key !== last) {
        last = key;
        hitAreas.place(rects as [CaptionRect, CaptionRect, CaptionRect]);
      }
    };
    report();
    window.addEventListener("resize", report);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(report);
    for (const button of buttons) {
      if (button) {
        observer?.observe(button);
      }
    }
    // devicePixelRatio moves with zoom and monitor DPI, and a resize event does not always follow.
    let ratio: MediaQueryList | undefined;
    const watchRatio = () => {
      ratio?.removeEventListener("change", onRatio);
      ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      ratio.addEventListener("change", onRatio);
    };
    const onRatio = () => {
      watchRatio();
      report();
    };
    watchRatio();
    const stopState = hitAreas.onState(setCaption);
    return () => {
      window.removeEventListener("resize", report);
      observer?.disconnect();
      ratio?.removeEventListener("change", onRatio);
      stopState();
      setCaption(NO_CAPTION_STATE);
      hitAreas.place(null);
    };
  }, [hitAreas]);
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  if (!frame) {
    return null;
  }
  return (
    <div
      role="group"
      aria-label="Window"
      // Stays clickable while a dialog has disabled pointer events on the page, like native caption buttons.
      className={cn(
        "pointer-events-auto fixed top-0 right-0 z-[var(--z-titlebar)] flex h-12 transition-colors duration-100",
        focused ? "text-fg" : "text-subtle",
      )}
    >
      <CaptionButton
        ref={minimizeRef}
        label="Minimize"
        glyph={"\uE921"}
        state={caption}
        name="minimize"
        onClick={() => frame.minimize()}
      />
      <CaptionButton
        ref={maximizeRef}
        label={maximized ? "Restore" : "Maximize"}
        glyph={maximized ? "\uE923" : "\uE922"}
        state={caption}
        name="maximize"
        onClick={() => frame.toggleMaximize()}
      />
      <CaptionButton
        ref={closeRef}
        label="Close"
        glyph={"\uE8BB"}
        state={caption}
        name="close"
        onClick={() => frame.close()}
        close
      />
    </div>
  );
}

const CaptionButton = forwardRef<
  HTMLButtonElement,
  { label: string; glyph: string; name: CaptionButtonName; state: CaptionState; onClick: () => void; close?: boolean }
>(function CaptionButton(props, ref) {
  // With native hit areas on top, the page gets no pointer events here and draws hover and press from `state`.
  const hovered = props.state.hovered === props.name;
  const pressed = props.state.pressed === props.name;
  return (
    <button
      ref={ref}
      type="button"
      data-hover={hovered ? "" : undefined}
      data-pressed={pressed ? "" : undefined}
      tabIndex={-1}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={cn(
        "flex h-full w-[46px] items-center justify-center font-caption text-[10px] leading-none transition-colors duration-100 select-none",
        props.close
          ? "hover:bg-caption-close hover:text-white active:bg-caption-close/90 data-hover:bg-caption-close data-hover:text-white data-pressed:bg-caption-close/90"
          : "hover:bg-hover active:bg-active data-hover:bg-hover data-pressed:bg-active",
      )}
    >
      <span aria-hidden="true">{props.glyph}</span>
    </button>
  );
});
