//! Keeps the Windows window drawing when the display layout changes.
//!
//! When a monitor comes online, goes away or changes resolution, Windows resizes and re-scales the
//! window and the graphics adapter can reset under WebView2. WebView2 recovers its GPU process on its
//! own, but the composition surface it presents into often stays stale: the window keeps the last
//! frame (or goes blank) and nothing draws again until the window is hidden and shown. wry only
//! re-applies the webview's bounds on WM_SIZE and WM_MOVE, so nothing nudges it after WM_DISPLAYCHANGE
//! or WM_DPICHANGED, and nothing listens for a crashed GPU or render process.
//!
//! This watches those messages on the main window and, once the layout settles, re-applies the
//! webview's bounds and cycles its visibility, which makes WebView2 rebuild the surface. A GPU process
//! that exits gets the same nudge; a render process that exits gets the page reloaded, since there is
//! nothing left to draw it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC, COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
};
use webview2_com::ProcessFailedEventHandler;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetForegroundWindow, IsIconic, IsWindowVisible, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
    WM_DISPLAYCHANGE, WM_DPICHANGED, WM_NCDESTROY, WM_USER,
};

/// Distinct from wry's own subclass ids (WM_USER + 0x64..0x66).
const SUBCLASS_ID: usize = (WM_USER + 0x1e1) as usize;

/// A layout change arrives as a burst of messages while Windows moves things around, and the adapter
/// can reset a moment after the last one, so the webview is nudged once the burst is over and once
/// more a little later.
const SETTLE_DELAYS: [Duration; 2] = [Duration::from_millis(300), Duration::from_millis(1500)];

/// Starts watching `window` for display changes and webview process failures. Call it on the main
/// thread, once, right after the window is built.
pub fn keep_drawing<R: Runtime>(window: &WebviewWindow<R>) {
    watch_process_failures(window);
    watch_display_changes(window);
}

/// Re-applies the webview's bounds and cycles its visibility, so WebView2 rebuilds the surface it
/// presents into. Runs on the main thread.
fn redraw<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as isize;
    let _ = window.with_webview(move |webview| unsafe { nudge(&webview.controller(), HWND(hwnd as _)) });
}

unsafe fn nudge(controller: &ICoreWebView2Controller, window: HWND) {
    // A minimized or hidden window draws nothing anyway, and showing the webview there would be
    // wrong; the next restore resizes it and wry re-applies the bounds then.
    if IsIconic(window).as_bool() || !IsWindowVisible(window).as_bool() {
        return;
    }
    let mut client = RECT::default();
    if GetClientRect(window, &mut client).is_err() {
        return;
    }
    let (width, height) = (client.right - client.left, client.bottom - client.top);
    if width <= 0 || height <= 0 {
        return;
    }
    // wry hosts the controller in a container window that fills the main window; size both to the
    // client area as it is now, in case the last WM_SIZE raced the scale change.
    let mut container = HWND::default();
    if controller.ParentWindow(&mut container).is_ok() && !container.is_invalid() {
        let _ = SetWindowPos(container, None, 0, 0, width, height, SWP_NOACTIVATE | SWP_NOZORDER);
    }
    let _ = controller.SetBounds(RECT { left: 0, top: 0, right: width, bottom: height });
    let _ = controller.NotifyParentWindowPositionChanged();
    let _ = controller.SetIsVisible(false);
    let _ = controller.SetIsVisible(true);
    // Hiding the webview takes keyboard focus from it; give it back if the user was in the window.
    if GetForegroundWindow() == window {
        let _ = controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    }
}

fn watch_process_failures<R: Runtime>(window: &WebviewWindow<R>) {
    let owner = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED {
                // WebView2 starts a new GPU process by itself; give it a moment, then rebuild the surface.
                settle_then_redraw(owner.clone(), None);
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                if let Some(sender) = sender {
                    sender.Reload()?;
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

/// Redraws after each settle delay, unless a newer change has been seen by then (`latest` moved on
/// from `ticket`), in which case that change's own redraws take over.
fn settle_then_redraw<R: Runtime>(window: WebviewWindow<R>, latest: Option<(Arc<AtomicU64>, u64)>) {
    std::thread::spawn(move || {
        let mut waited = Duration::ZERO;
        for delay in SETTLE_DELAYS {
            std::thread::sleep(delay - waited);
            waited = delay;
            if let Some((latest, ticket)) = &latest {
                if latest.load(Ordering::SeqCst) != *ticket {
                    return;
                }
            }
            redraw(&window);
        }
    });
}

/// What the subclass hands back to its window procedure.
struct DisplayWatch {
    changed: Box<dyn Fn()>,
}

fn watch_display_changes<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let latest = Arc::new(AtomicU64::new(0));
    let owner = window.clone();
    let watch = Box::new(DisplayWatch {
        changed: Box::new(move || {
            let ticket = latest.fetch_add(1, Ordering::SeqCst) + 1;
            settle_then_redraw(owner.clone(), Some((latest.clone(), ticket)));
        }),
    });
    let data = Box::into_raw(watch) as usize;
    unsafe {
        if !SetWindowSubclass(hwnd, Some(display_proc), SUBCLASS_ID, data).as_bool() {
            drop(Box::from_raw(data as *mut DisplayWatch));
        }
    }
}

unsafe extern "system" fn display_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    // Let tao resize and re-scale the window first; the redraw is scheduled for after that anyway.
    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
    match msg {
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            if let Some(watch) = (data as *const DisplayWatch).as_ref() {
                (watch.changed)();
            }
        }
        WM_NCDESTROY => {
            let _ = RemoveWindowSubclass(hwnd, Some(display_proc), SUBCLASS_ID);
            if data != 0 {
                drop(Box::from_raw(data as *mut DisplayWatch));
            }
        }
        _ => {}
    }
    result
}
