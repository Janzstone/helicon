//! Native hit areas over the minimize, maximize and close buttons that the UI draws on Windows.
//!
//! The page covers the whole client area with WebView2's child windows, so Windows never asks
//! Helicon's own window what sits under the cursor and never learns where the maximize button is.
//! Windows 11 only opens the Snap Layouts flyout when a window answers `WM_NCHITTEST` with
//! `HTMAXBUTTON`, and WebView2's own caption-button regions only work in composition hosting,
//! which Tauri does not use.
//!
//! So three small child windows sit above the webview, one over each drawn button. They never
//! paint, so the UI's buttons show through, and they answer the hit test as the matching caption
//! button. Clicks are handled here, natively, which also keeps the window closable while the page
//! is busy or frozen. Hover and press can no longer reach the page, so they go back to it as an
//! event and the UI draws them from that.
//!
//! The page reports where its buttons are with the `helicon://caption-layout` event, in physical
//! pixels measured from the client area's top-right corner; the windows are moved on every resize.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, NULL_BRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, GetWindowLongPtrW, IsZoomed, LoadCursorW, PostMessageW,
    RegisterClassW, SetWindowPos, ShowWindow, GWLP_ID, HMENU, HTCLOSE, HTMAXBUTTON, HTMINBUTTON, HWND_TOP,
    IDC_ARROW, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WINDOW_EX_STYLE,
    WM_CLOSE, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE,
    WM_NCMOUSEMOVE, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS,
};

/// The event the page sends with its buttons' rectangles, or with none when it stops drawing them.
pub const LAYOUT_EVENT: &str = "helicon://caption-layout";

/// The event that tells the page which button the pointer is over and whether it is pressed.
pub const STATE_EVENT: &str = "helicon://caption-state";

/// Minimize, maximize, close: the child window id of each, and its index in the page's layout.
const BUTTONS: [&str; 3] = ["minimize", "maximize", "close"];

/// One drawn button, in physical pixels: `right` is from the client area's right edge to the button's left edge.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub struct ButtonRect {
    pub right: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Deserialize)]
pub struct Layout {
    /// Exactly three, in `BUTTONS` order, or empty when the page draws no buttons.
    pub buttons: Vec<ButtonRect>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct CaptionState {
    pub hovered: Option<&'static str>,
    pub pressed: Option<&'static str>,
}

type Notify = Arc<dyn Fn(CaptionState) + Send + Sync>;

struct Caption {
    /// Window handles as integers: an `HWND` is not `Send`.
    parent: isize,
    buttons: Option<[isize; 3]>,
    layout: Vec<ButtonRect>,
    hovered: Option<usize>,
    pressed: Option<usize>,
    notify: Notify,
}

static CAPTION: Mutex<Option<Caption>> = Mutex::new(None);

fn hwnd(value: isize) -> HWND {
    HWND(value as *mut core::ffi::c_void)
}

/// Remembers the main window and how to tell the page about hover and press. Call on the main thread.
pub fn install(parent: HWND, notify: impl Fn(CaptionState) + Send + Sync + 'static) {
    if let Ok(mut caption) = CAPTION.lock() {
        *caption = Some(Caption {
            parent: parent.0 as isize,
            buttons: None,
            layout: Vec::new(),
            hovered: None,
            pressed: None,
            notify: Arc::new(notify),
        });
    }
}

/// Takes the page's latest button rectangles and moves the hit areas there. Call on the main thread.
pub fn set_layout(layout: Layout) {
    let valid = layout.buttons.len() == BUTTONS.len() && layout.buttons.iter().all(|b| b.width > 0 && b.height > 0);
    let Ok(mut guard) = CAPTION.lock() else { return };
    let Some(caption) = guard.as_mut() else { return };
    caption.layout = if valid { layout.buttons } else { Vec::new() };
    if !caption.layout.is_empty() && caption.buttons.is_none() {
        caption.buttons = create_buttons(hwnd(caption.parent));
    }
    place(caption);
}

/// Hides the hit areas, e.g. when an error page takes the native frame back. Call on the main thread.
pub fn clear() {
    set_layout(Layout { buttons: Vec::new() });
}

/// Moves the hit areas after the window changes size; they are anchored to its right edge. Call on the main thread.
pub fn reposition() {
    let Ok(mut guard) = CAPTION.lock() else { return };
    if let Some(caption) = guard.as_mut() {
        place(caption);
    }
}

/// Where each hit area goes in a client area `client_width` pixels wide.
pub fn button_bounds(layout: &[ButtonRect], client_width: i32) -> Vec<(i32, i32, i32, i32)> {
    layout.iter().map(|b| (client_width - b.right, b.top, b.width, b.height)).collect()
}

fn place(caption: &Caption) {
    let Some(buttons) = caption.buttons else { return };
    if caption.layout.is_empty() {
        for button in buttons {
            unsafe {
                let _ = ShowWindow(hwnd(button), SW_HIDE);
            }
        }
        return;
    }
    let mut client = RECT::default();
    if unsafe { GetClientRect(hwnd(caption.parent), &mut client) }.is_err() {
        return;
    }
    for (button, (x, y, width, height)) in buttons.iter().zip(button_bounds(&caption.layout, client.right)) {
        // HWND_TOP every time: the webview's own windows must never end up above the hit areas.
        unsafe {
            let _ = SetWindowPos(hwnd(*button), Some(HWND_TOP), x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }
}

fn create_buttons(parent: HWND) -> Option<[isize; 3]> {
    unsafe {
        let instance = GetModuleHandleW(None).ok()?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(button_proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).ok()?,
            // Never paints: the button the UI drew stays visible underneath.
            hbrBackground: HBRUSH(GetStockObject(NULL_BRUSH).0),
            lpszClassName: w!("HeliconCaptionButton"),
            ..Default::default()
        };
        // Fails harmlessly if the class is already registered.
        RegisterClassW(&class);
        let mut handles = [0isize; 3];
        for (id, handle) in handles.iter_mut().enumerate() {
            // No WS_EX_LAYERED or WS_EX_TRANSPARENT: either one stops the window from getting the hit test.
            let button = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("HeliconCaptionButton"),
                None,
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                Some(parent),
                Some(HMENU(id as *mut core::ffi::c_void)),
                Some(instance.into()),
                None,
            )
            .ok()?;
            *handle = button.0 as isize;
        }
        Some(handles)
    }
}

/// The caption hit-test code each hit area answers with.
fn hit_code(id: usize) -> u32 {
    match id {
        0 => HTMINBUTTON,
        1 => HTMAXBUTTON,
        _ => HTCLOSE,
    }
}

/// Updates hover and press under the lock, and tells the page afterwards if anything changed.
fn update(change: impl FnOnce(&mut Caption)) {
    let notify = {
        let Ok(mut guard) = CAPTION.lock() else { return };
        let Some(caption) = guard.as_mut() else { return };
        let before = (caption.hovered, caption.pressed);
        change(caption);
        if before == (caption.hovered, caption.pressed) {
            return;
        }
        let state = CaptionState {
            hovered: caption.hovered.map(|id| BUTTONS[id]),
            pressed: caption.pressed.map(|id| BUTTONS[id]),
        };
        let notify = caption.notify.clone();
        move || notify(state)
    };
    notify();
}

fn parent_of() -> Option<HWND> {
    CAPTION.lock().ok()?.as_ref().map(|caption| hwnd(caption.parent))
}

/// Does what a native caption button does when it is clicked.
fn activate(id: usize) {
    let Some(parent) = parent_of() else { return };
    unsafe {
        match id {
            0 => {
                let _ = ShowWindow(parent, SW_MINIMIZE);
            }
            1 => {
                let _ = ShowWindow(parent, if IsZoomed(parent).as_bool() { SW_RESTORE } else { SW_MAXIMIZE });
            }
            // A close request, like Alt+F4, so Tauri's close handling runs.
            _ => {
                let _ = PostMessageW(Some(parent), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
}

unsafe extern "system" fn button_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let id = (GetWindowLongPtrW(window, GWLP_ID) as usize).min(BUTTONS.len() - 1);
    match message {
        // HTMAXBUTTON is what makes Windows 11 offer Snap Layouts on hover.
        WM_NCHITTEST => LRESULT(hit_code(id) as isize),
        WM_NCMOUSEMOVE => {
            let mut track = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE | TME_NONCLIENT,
                hwndTrack: window,
                dwHoverTime: 0,
            };
            let _ = TrackMouseEvent(&mut track);
            update(|caption| caption.hovered = Some(id));
            LRESULT(0)
        }
        WM_NCMOUSELEAVE => {
            update(|caption| {
                if caption.hovered == Some(id) {
                    caption.hovered = None;
                    caption.pressed = None;
                }
            });
            LRESULT(0)
        }
        // Handled here rather than by DefWindowProc, which would run its own caption-button tracking.
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
            update(|caption| caption.pressed = Some(id));
            LRESULT(0)
        }
        WM_NCLBUTTONUP => {
            let mut clicked = false;
            update(|caption| {
                clicked = caption.pressed == Some(id);
                caption.pressed = None;
            });
            if clicked {
                activate(id);
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}

#[cfg(test)]
mod tests {
    use super::{button_bounds, ButtonRect};

    #[test]
    fn anchors_buttons_to_the_right_edge() {
        let layout = [
            ButtonRect { right: 207, top: 0, width: 69, height: 72 },
            ButtonRect { right: 138, top: 0, width: 69, height: 72 },
            ButtonRect { right: 69, top: 0, width: 69, height: 72 },
        ];
        assert_eq!(
            button_bounds(&layout, 1920),
            vec![(1713, 0, 69, 72), (1782, 0, 69, 72), (1851, 0, 69, 72)]
        );
    }
}
