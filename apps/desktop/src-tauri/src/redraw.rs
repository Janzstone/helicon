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

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC, COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
};
use webview2_com::ProcessFailedEventHandler;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONULL};
use windows::Win32::UI::Shell::{
    DefSubclassProc, RemoveWindowSubclass, SHAppBarMessage, SetWindowSubclass, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP,
    ABM_GETAUTOHIDEBAR, APPBARDATA,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetForegroundWindow, IsIconic, IsWindowVisible, IsZoomed, SetWindowPos, NCCALCSIZE_PARAMS,
    SWP_NOACTIVATE, SWP_NOZORDER, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_NCCALCSIZE, WM_NCDESTROY, WM_SETTINGCHANGE,
    WM_USER,
};

/// Distinct from wry's own subclass ids (WM_USER + 0x64..0x66).
const SUBCLASS_ID: usize = (WM_USER + 0x1e1) as usize;

/// A layout change arrives as a burst of messages while Windows moves things around, and the adapter
/// can reset a moment after the last one, so the webview is nudged once the burst is over and once
/// more a little later.
const SETTLE_DELAYS: [Duration; 2] = [Duration::from_millis(300), Duration::from_millis(1500)];

/// Starts watching `window` for display changes and webview process failures. Call it on the main
/// thread, once, right after the window is built. `frameless` is true when the window has no native
/// title bar, so its maximized client area is computed here (see [`maximized_client_area`]).
pub fn keep_drawing<R: Runtime>(window: &WebviewWindow<R>, frameless: bool) {
    watch_process_failures(window);
    watch_display_changes(window, frameless);
}

/// Which screen edges have an auto-hide taskbar, as a bit per `ABE_*` edge. Filled off the main thread.
static AUTOHIDE_EDGES: AtomicU8 = AtomicU8::new(0);

/// Asks the shell which edges have an auto-hide taskbar, on a background thread. `SHAppBarMessage`
/// is a synchronous message to Explorer, and while monitors come and go Explorer is busy laying out
/// its taskbars and messaging every window, so on the main thread it can stall the whole app.
fn refresh_autohide_edges() {
    std::thread::spawn(|| {
        let mut edges = 0u8;
        for edge in [ABE_LEFT, ABE_TOP, ABE_RIGHT, ABE_BOTTOM] {
            let mut data = APPBARDATA {
                cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                uEdge: edge,
                ..Default::default()
            };
            if unsafe { SHAppBarMessage(ABM_GETAUTOHIDEBAR, &mut data) } != 0 {
                edges |= 1 << edge;
            }
        }
        AUTOHIDE_EDGES.store(edges, Ordering::SeqCst);
    });
}

/// The client area of the maximized frameless window: the monitor's work area, so it does not cover
/// the taskbar, less one pixel on each auto-hide taskbar's edge so the taskbar can still slide out.
///
/// This is what tao computes for a maximized undecorated window, except that tao asks Explorer for
/// the auto-hide taskbars with `SHAppBarMessage` on every `WM_NCCALCSIZE`, on the main thread. While a
/// monitor comes online that message waits on a busy Explorer for each of the many `WM_NCCALCSIZE`s,
/// and the window stops responding: it neither draws nor closes from the taskbar. Here the answer
/// comes from [`AUTOHIDE_EDGES`] instead, so nothing on the main thread waits on Explorer.
unsafe fn maximized_client_area(lparam: LPARAM) -> bool {
    let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
    let monitor = MonitorFromRect(&params.rgrc[0], MONITOR_DEFAULTTONULL);
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if monitor.is_invalid() || !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return false;
    }
    let mut rect = info.rcWork;
    let edges = AUTOHIDE_EDGES.load(Ordering::SeqCst);
    let has = |edge: u32| edges & (1 << edge) != 0;
    if has(ABE_BOTTOM) {
        rect.bottom -= 1;
    }
    if has(ABE_LEFT) {
        rect.left += 1;
    }
    if has(ABE_TOP) {
        rect.top += 1;
    }
    if has(ABE_RIGHT) {
        rect.right -= 1;
    }
    params.rgrc[0] = rect;
    true
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
    frameless: bool,
}

fn watch_display_changes<R: Runtime>(window: &WebviewWindow<R>, frameless: bool) {
    if frameless {
        refresh_autohide_edges();
    }
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
        frameless,
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
    let watch = (data as *const DisplayWatch).as_ref();
    // This subclass was added after tao's, so it sees each message first. A maximized frameless
    // window's client area is answered here and never reaches tao (see `maximized_client_area`).
    if msg == WM_NCCALCSIZE
        && wparam.0 != 0
        && watch.is_some_and(|watch| watch.frameless)
        && IsZoomed(hwnd).as_bool()
        && maximized_client_area(lparam)
    {
        return LRESULT(0);
    }
    // Let tao resize and re-scale the window first; the redraw is scheduled for after that anyway.
    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
    match msg {
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            if let Some(watch) = watch {
                if watch.frameless {
                    refresh_autohide_edges();
                }
                (watch.changed)();
            }
        }
        // A taskbar switched to or from auto-hide.
        WM_SETTINGCHANGE => {
            if watch.is_some_and(|watch| watch.frameless) {
                refresh_autohide_edges();
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
