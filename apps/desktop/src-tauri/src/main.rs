// GUI subsystem in every build: a debug build would otherwise open a stray console window.
// Nothing is lost, the server's output goes to server.log.
#![windows_subsystem = "windows"]

#[cfg(windows)]
mod redraw;

use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::Emitter;

struct ServerChild(Arc<Mutex<Option<Child>>>);

/// Stops the local server when Tauri clears its resources, which the updater does right before it
/// quits the app to run the installer; a normal close stops it in the window's Destroyed handler.
struct ServerGuard(Arc<Mutex<Option<Child>>>);

impl tauri::Resource for ServerGuard {}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

/// Windows gets Helicon's own title bar, drawn by the UI; macOS keeps the native traffic
/// lights overlaid on the UI, so the sidebar runs the full height of the window; other
/// platforms keep the native frame.
const CUSTOM_FRAME: bool = cfg!(windows);

/// Tells the UI, before it loads, to draw the window controls and drag regions.
const FRAME_SCRIPT: &str = "window.__HELICON_FRAME__ = 'custom';";

/// Tells the UI, before it loads, that the macOS traffic lights float over the sidebar.
#[cfg(target_os = "macos")]
const OVERLAY_SCRIPT: &str = "window.__HELICON_TITLEBAR__ = 'overlay';";

/// Where the server's port is remembered between launches, inside the app's data folder.
const PORT_FILE: &str = "server-port";

/// Shown the instant the window opens, while the local server starts. System colors follow the OS theme.
const SPLASH_PAGE: &str = "data:text/html,<!doctype html><meta charset=utf-8><title>Helicon</title><style>html{color-scheme:light dark;background:Canvas;color:GrayText;font:13px system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}</style><body>Starting Helicon</body>";

const MISSING_NODE_PAGE: &str = "data:text/html,<!doctype html><meta charset=utf-8><title>Helicon</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Helicon needs Node.js</h1><p>Helicon could not start its local server because its bundled Node.js is missing and Node.js 22 or newer was not found on this computer. Reinstall Helicon, or install Node.js 22 or newer, then open Helicon again.</p></main>";

const MISSING_SERVER_PAGE: &str = "data:text/html,<!doctype html><meta charset=utf-8><title>Helicon</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Helicon is missing files</h1><p>The bundled Helicon server was not found next to the app. Reinstall Helicon to restore it.</p></main>";

const SERVER_FAILED_PAGE: &str = "data:text/html,<!doctype html><meta charset=utf-8><title>Helicon</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Helicon could not start</h1><p>Its local server did not come up. The server log in the Helicon app log folder has the details. Close Helicon and open it again to retry.</p></main>";

enum BootError {
    NodeMissing,
    ServerMissing,
    ServerFailed,
}

impl BootError {
    fn page(&self) -> &'static str {
        match self {
            BootError::NodeMissing => MISSING_NODE_PAGE,
            BootError::ServerMissing => MISSING_SERVER_PAGE,
            BootError::ServerFailed => SERVER_FAILED_PAGE,
        }
    }
}

/// Why one server start produced no URL. A server that exits at once may have lost its port to another
/// process between the check and its own bind; one that never answers or never spawned would not be
/// helped by another port.
enum StartFailure {
    Exited,
    Failed,
}

/// Tauri hands out `\\?\` verbatim paths on Windows; Node cannot load a main module from one.
fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// Bundled resources keep their relative path (`resources/server.cjs`); older layouts put them at the root.
fn find_resource(resource_dir: &Path, name: &str) -> Option<PathBuf> {
    [resource_dir.join("resources").join(name), resource_dir.join(name)]
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|found| plain_path(&found))
}

fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The port the local server had last time, while it is still free. The window's origin includes the
/// port and the UI keeps its settings in that origin's storage, so a new port each launch would forget
/// them, automatic updates switched off included.
fn stable_port(data_dir: Option<&Path>) -> u16 {
    let saved = data_dir
        .and_then(|dir| std::fs::read_to_string(dir.join(PORT_FILE)).ok())
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port != 0);
    match saved {
        Some(port) if port_free(port) => port,
        _ => fresh_port(data_dir),
    }
}

/// A port nothing is using right now, remembered for the next launch. Returns 0, any free port, only
/// when none can be found.
fn fresh_port(data_dir: Option<&Path>) -> u16 {
    let port = TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(0);
    if port != 0 {
        if let Some(dir) = data_dir {
            let _ = std::fs::write(dir.join(PORT_FILE), port.to_string());
        }
    }
    port
}

/// Starts the server on `port`, and once more on a fresh port if it exits at once.
fn start_with_retry<T>(
    port: u16,
    fresh: impl FnOnce() -> u16,
    mut spawn: impl FnMut(u16) -> Result<T, StartFailure>,
) -> Result<T, BootError> {
    match spawn(port) {
        Ok(started) => Ok(started),
        Err(StartFailure::Exited) => spawn(fresh()).map_err(|_| BootError::ServerFailed),
        Err(StartFailure::Failed) => Err(BootError::ServerFailed),
    }
}

/// A child process that never flashes a console window on Windows.
fn command<S: AsRef<OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn node_runs(program: &Path) -> bool {
    command(program)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// The Node.js runtime that ships next to the app executable as a Tauri sidecar, when this build has one.
fn bundled_node() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    bundled_node_in(exe.parent()?)
}

fn bundled_node_in(dir: &Path) -> Option<PathBuf> {
    Some(dir.join(SIDECAR_NODE)).filter(|path| path.is_file()).map(|path| plain_path(&path))
}

/// The sidecar's file name next to the executable. A .deb or .rpm installs the app to /usr/bin, where a
/// sidecar called `node` would collide with the distro's nodejs package and shadow the user's own Node.js,
/// so Linux builds name it `helicon-node` (see tauri.linux.conf.json and scripts/fetch-node.mjs).
const SIDECAR_NODE: &str = if cfg!(windows) {
    "node.exe"
} else if cfg!(target_os = "linux") {
    "helicon-node"
} else {
    "node"
};

/// The bundled Node.js first, so users need nothing installed. Without it (a source build, or a damaged
/// install), Node.js the way a terminal sees it. GUI apps on macOS start with a minimal PATH that misses
/// Homebrew, ~/.local/bin and everything a version manager adds through the shell's rc files, so
/// plain `node` fails for most users when Helicon is opened from the Finder rather than a terminal.
fn find_node() -> Option<PathBuf> {
    if let Some(bundled) = bundled_node().filter(|node| node_runs(node)) {
        return Some(bundled);
    }
    let mut candidates = vec![PathBuf::from("node")];
    #[cfg(unix)]
    {
        if let Some(found) = shell_probe("/bin/sh", &["-lc", "command -v node"]) {
            candidates.push(found);
        }
        if let Ok(shell) = std::env::var("SHELL") {
            if shell != "/bin/sh" {
                // Login plus interactive, so .zshrc-style rc files run and managers like fnm, nvm,
                // volta and mise put their node on PATH.
                let probe = if shell.ends_with("csh") {
                    "which node"
                } else {
                    "command -v node"
                };
                if let Some(found) = shell_probe(&shell, &["-li", "-c", probe]) {
                    candidates.push(found);
                }
            }
        }
        candidates.extend(well_known_nodes());
    }
    candidates.into_iter().find(|candidate| node_runs(candidate))
}

/// Runs one shell probe with a timeout: rc files can hang, and boot must not hang with them.
#[cfg(unix)]
fn shell_probe(shell: &str, args: &[&str]) -> Option<PathBuf> {
    let shell = shell.to_string();
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let output = command(&shell).args(&args).output().ok();
        let _ = tx.send(output);
    });
    let output = rx.recv_timeout(Duration::from_secs(10)).ok()??;
    if !output.status.success() {
        return None;
    }
    // The probe runs after the rc files, so its answer is the last path-like line; anything the
    // rc files printed above it is ignored.
    select_probe_path(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(unix)]
fn select_probe_path(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_absolute() && path.is_file())
}

/// Node binaries in their usual homes, for when the shells above do not know them.
#[cfg(unix)]
fn well_known_nodes() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    well_known_nodes_in(&home)
}

#[cfg(unix)]
fn well_known_nodes_in(home: &Path) -> Vec<PathBuf> {
    let mut nodes = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/opt/local/bin/node"),
        home.join(".local/bin/node"),
        home.join(".volta/bin/node"),
        home.join(".asdf/shims/node"),
        home.join(".local/share/mise/shims/node"),
        home.join(".fnm/aliases/default/bin/node"),
    ];
    if let Some(nvm) = latest_nvm_node(home) {
        nodes.push(nvm);
    }
    nodes.into_iter().filter(|node| node.is_file()).collect()
}

/// The newest node nvm has installed, by version number.
#[cfg(unix)]
fn latest_nvm_node(home: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(home.join(".nvm/versions/node")).ok()?;
    let mut versions: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(number) = name.strip_prefix('v') else {
            continue;
        };
        let parts: Option<Vec<u64>> = number.split('.').map(|part| part.parse::<u64>().ok()).collect();
        let node = entry.path().join("bin/node");
        if let (Some(parts), true) = (parts, node.is_file()) {
            versions.push((parts, node));
        }
    }
    versions.sort_by(|a, b| a.0.cmp(&b.0));
    versions.pop().map(|(_, node)| node)
}

/// A PATH for the server that sees what a terminal sees: the node that was found, plus the user
/// bin folders, in front of whatever the app inherited. The server's own probes (`muse`, skills)
/// and the user's `!` commands all run under it.
#[cfg(unix)]
fn augmented_path(node: &Path) -> Option<OsString> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut prepend: Vec<PathBuf> = Vec::new();
    // The bundled node sits beside the app executable; putting that folder first would shadow the
    // user's own node for their `!` commands.
    if node.is_absolute() && bundled_node().as_deref() != Some(node) {
        if let Some(dir) = node.parent() {
            prepend.push(dir.to_path_buf());
        }
    }
    let mut folders = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
    ];
    if let Some(home) = &home {
        folders.extend([home.join(".volta/bin"), home.join(".asdf/shims")]);
    }
    prepend.extend(folders.into_iter().filter(|dir| dir.is_dir()));
    // The Muse installer creates ~/.local/bin, often after Helicon is already open, so keep it even when missing.
    if let Some(home) = &home {
        prepend.push(home.join(".local/bin"));
    }
    if prepend.is_empty() {
        return None;
    }
    Some(prepend_to_path(&prepend, std::env::var_os("PATH")))
}

#[cfg(unix)]
fn prepend_to_path(prepend: &[PathBuf], current: Option<OsString>) -> OsString {
    let mut parts: Vec<OsString> = prepend.iter().map(|dir| dir.as_os_str().to_os_string()).collect();
    let already: Vec<PathBuf> = current
        .as_ref()
        .map(|path| std::env::split_paths(path).collect())
        .unwrap_or_default();
    parts.retain(|dir| !already.iter().any(|have| have.as_os_str() == dir));
    if let Some(current) = current {
        if !current.is_empty() {
            parts.push(current);
        }
    }
    let mut joined = OsString::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            joined.push(":");
        }
        joined.push(part);
    }
    joined
}

fn wait_for_url(child: &mut Child) -> Option<String> {
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        if reader.read_line(&mut line).is_ok() {
            let _ = tx.send(line);
        }
    });
    let line = rx.recv_timeout(Duration::from_secs(25)).ok()?;
    parse_listening_url(&line)
}

fn parse_listening_url(line: &str) -> Option<String> {
    let rest = line.split("http://").nth(1)?;
    Some(format!("http://{}", rest.trim()))
}

/// One attempt to run the bundled server on `port`, returning it with the URL it announced.
#[allow(clippy::too_many_arguments)]
fn spawn_server(
    app: &tauri::AppHandle,
    node: &Path,
    server: &Path,
    frontend: Option<&Path>,
    data: Option<&Path>,
    port: u16,
) -> Result<(Child, String), StartFailure> {
    let mut cmd = command(node);
    #[cfg(unix)]
    if let Some(path) = augmented_path(node) {
        cmd.env("PATH", path);
    }
    cmd.arg(server).arg("--port").arg(port.to_string());
    if let Some(frontend) = frontend {
        cmd.arg("--static").arg(frontend);
    }
    if let Some(data) = data {
        cmd.arg("--data-dir").arg(data);
    }
    let log = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| plain_path(&dir))
        .and_then(|dir| std::fs::create_dir_all(&dir).ok().map(|_| dir.join("server.log")))
        .and_then(|path| OpenOptions::new().create(true).append(true).open(path).ok());
    cmd.stdout(Stdio::piped())
        .stderr(log.map(Stdio::from).unwrap_or_else(Stdio::null));
    let mut child = cmd.spawn().map_err(|_| StartFailure::Failed)?;
    if let Some(url) = wait_for_url(&mut child) {
        return Ok((child, url));
    }
    // Its output can end a moment before the exit is reported, so give the exit up to a second to show.
    let exited = (0..20).any(|_| {
        let done = matches!(child.try_wait(), Ok(Some(_)));
        if !done {
            std::thread::sleep(Duration::from_millis(50));
        }
        done
    });
    let _ = child.kill();
    let _ = child.wait();
    Err(if exited { StartFailure::Exited } else { StartFailure::Failed })
}

fn boot_server(app: &tauri::AppHandle) -> Result<String, BootError> {
    let node = find_node().ok_or(BootError::NodeMissing)?;
    let resource_dir = app.path().resource_dir().map_err(|_| BootError::ServerMissing)?;
    let server = find_resource(&resource_dir, "server.cjs").ok_or(BootError::ServerMissing)?;
    let frontend = find_resource(&resource_dir, "frontend");
    // Projects, pins and thread titles persist per user, next to the app's other data.
    let data = app
        .path()
        .app_data_dir()
        .ok()
        .filter(|dir| std::fs::create_dir_all(dir).is_ok())
        .map(|dir| plain_path(&dir));
    let (child, url) = start_with_retry(
        stable_port(data.as_deref()),
        || fresh_port(data.as_deref()),
        |port| spawn_server(app, &node, &server, frontend.as_deref(), data.as_deref(), port),
    )?;
    if let Some(state) = app.try_state::<ServerChild>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(child);
        }
        app.resources_table().add(ServerGuard(state.0.clone()));
    }
    Ok(url)
}

/// WKWebView swallows Cmd+/− for its own page zoom before JS sees them. A native View menu
/// takes those keys and emits `helicon://zoom` so the UI can step Helicon's zoom instead.
/// New Thread (Cmd+N) and Settings (Cmd+,) sit where macOS apps keep them and emit `helicon://menu`.
#[cfg(target_os = "macos")]
fn install_zoom_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let new_thread = MenuItemBuilder::with_id("new-thread", "New Thread")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;

    let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Helicon")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File").item(&new_thread).build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        if matches!(id, "new-thread" | "settings") {
            let _ = app.emit("helicon://menu", id);
            return;
        }
        let step = match id {
            "zoom-in" => "in",
            "zoom-out" => "out",
            "zoom-reset" => "reset",
            _ => return,
        };
        let _ = app.emit("helicon://zoom", step);
    });
    Ok(())
}

/// Web and mail links that belong in the user's browser or mail app. Helicon's own local server, the inline
/// splash and error pages, and Tauri's internal schemes stay in the window.
fn is_external_link(url: &Url) -> bool {
    match url.scheme() {
        "mailto" => true,
        "http" | "https" => !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "ipc.localhost" | "tauri.localhost")),
        _ => false,
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerChild(Arc::new(Mutex::new(None))))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            install_zoom_menu(app)?;
            // Start the server before the window is built. The first WebView2 start on Windows takes seconds,
            // and the server has no need to wait for it.
            let (booted_tx, booted_rx) = mpsc::channel();
            let boot_handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = booted_tx.send(boot_server(&boot_handle));
            });
            // Open the window at once on a splash page; the server can take a few seconds to probe WSL.
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(SPLASH_PAGE.parse()?))
                .title("Helicon")
                .inner_size(1280.0, 820.0)
                .min_inner_size(880.0, 560.0)
                // Native file-drop consumes HTML5 DnD (sidebar reorder, composer attach) on Windows.
                .disable_drag_drop_handler()
                // A link meant for the browser (`target="_blank"`, or one that would navigate the app away)
                // opens in the user's default browser instead of doing nothing or replacing Helicon.
                .on_new_window(|url, _features| {
                    if is_external_link(&url) {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_navigation(|url| {
                    if is_external_link(url) {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                        return false;
                    }
                    true
                });
            if CUSTOM_FRAME {
                builder = builder.decorations(false).initialization_script(FRAME_SCRIPT);
            }
            // The traffic lights float over the sidebar's top-left corner; the UI leaves room
            // for them and marks its headers as drag regions, like T3 Code.
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0))
                    .initialization_script(OVERLAY_SCRIPT);
            }
            let window = builder.build()?;
            // WebView2 can stop drawing when a monitor comes online or the resolution or scale changes.
            #[cfg(windows)]
            redraw::keep_drawing(&window, CUSTOM_FRAME);
            std::thread::spawn(move || {
                let target = match booted_rx.recv().unwrap_or(Err(BootError::ServerFailed)) {
                    Ok(url) => url,
                    Err(error) => {
                        // Error pages draw no window controls, so they get the native frame back.
                        if CUSTOM_FRAME {
                            let _ = window.set_decorations(true);
                        }
                        error.page().to_string()
                    }
                };
                if let Ok(url) = target.parse::<Url>() {
                    let _ = window.navigate(url);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(state) = window.app_handle().try_state::<ServerChild>() {
                        if let Ok(mut guard) = state.0.lock() {
                            if let Some(mut child) = guard.take() {
                                let _ = child.kill();
                            }
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Helicon failed to start");
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_node_in, find_resource, fresh_port, parse_listening_url, plain_path, stable_port, start_with_retry, BootError, StartFailure,
        PORT_FILE, SIDECAR_NODE, SPLASH_PAGE,
    };
    #[cfg(unix)]
    use super::{latest_nvm_node, prepend_to_path, select_probe_path, well_known_nodes_in};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};

    #[test]
    fn sends_only_outside_links_to_the_browser() {
        let external = |u: &str| super::is_external_link(&u.parse::<tauri::Url>().unwrap());
        assert!(external("https://github.com/HarjjotSinghh/helicon/pull/90"));
        assert!(external("mailto:hi@helicon.sh"));
        assert!(!external("http://127.0.0.1:52314/threads/abc"));
        assert!(!external("http://localhost:5173/"));
        assert!(!external("http://ipc.localhost/plugin"));
        assert!(!external("tauri://localhost/"));
        assert!(!external("data:text/html,hi"));
    }

    #[test]
    fn strips_windows_verbatim_prefixes() {
        assert_eq!(plain_path(Path::new(r"\\?\D:\apps\helicon\server.cjs")), PathBuf::from(r"D:\apps\helicon\server.cjs"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\host\share\x")), PathBuf::from(r"\\host\share\x"));
        assert_eq!(plain_path(Path::new("/usr/lib/helicon")), PathBuf::from("/usr/lib/helicon"));
    }

    #[test]
    fn parses_the_listening_line() {
        assert_eq!(
            parse_listening_url("helicon-server listening on http://127.0.0.1:52314\n"),
            Some("http://127.0.0.1:52314".to_string())
        );
        assert_eq!(parse_listening_url("noise without url"), None);
    }

    #[test]
    fn inline_pages_are_valid_urls() {
        assert!(SPLASH_PAGE.parse::<tauri::Url>().is_ok());
        for error in [BootError::NodeMissing, BootError::ServerMissing, BootError::ServerFailed] {
            assert!(error.page().parse::<tauri::Url>().is_ok());
        }
    }

    #[test]
    fn finds_bundled_resources_under_their_relative_path() {
        let root = std::env::temp_dir().join(format!("helicon-res-{}", std::process::id()));
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join("resources").join("server.cjs"), "").unwrap();
        assert_eq!(find_resource(&root, "server.cjs"), Some(root.join("resources").join("server.cjs")));
        assert_eq!(find_resource(&root, "missing.cjs"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_the_bundled_node_beside_the_executable() {
        let dir = std::env::temp_dir().join(format!("helicon-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(bundled_node_in(&dir), None);
        if cfg!(target_os = "linux") {
            // A system Node.js sharing /usr/bin with a packaged install is not the bundled one.
            std::fs::write(dir.join("node"), "").unwrap();
            assert_eq!(bundled_node_in(&dir), None);
        }
        std::fs::write(dir.join(SIDECAR_NODE), "").unwrap();
        assert_eq!(bundled_node_in(&dir), Some(dir.join(SIDECAR_NODE)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_the_server_port_between_launches_while_it_is_free() {
        let dir = std::env::temp_dir().join(format!("helicon-port-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = stable_port(Some(&dir));
        assert_ne!(first, 0);
        assert_eq!(stable_port(Some(&dir)), first);
        let held = TcpListener::bind(("127.0.0.1", first)).unwrap();
        let moved = stable_port(Some(&dir));
        assert_ne!(moved, first, "a taken port is replaced");
        drop(held);
        assert_eq!(stable_port(Some(&dir)), moved, "and the replacement is remembered");
        let fresh = fresh_port(Some(&dir));
        assert_eq!(std::fs::read_to_string(dir.join(PORT_FILE)).unwrap(), fresh.to_string());
        assert_ne!(stable_port(None), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retries_on_a_fresh_port_only_when_the_server_exits_at_once() {
        // Another process took the checked port before the server bound it: the server exits, the retry lands.
        let mut tried = Vec::new();
        let started = start_with_retry(4100, || 4200, |port| {
            tried.push(port);
            if port == 4100 {
                Err(StartFailure::Exited)
            } else {
                Ok(port)
            }
        });
        assert_eq!(started.ok(), Some(4200));
        assert_eq!(tried, vec![4100, 4200]);

        // A server that never answers is not helped by another port.
        let mut tried = Vec::new();
        let hung = start_with_retry(4100, || 4200, |port| {
            tried.push(port);
            Err::<u16, _>(StartFailure::Failed)
        });
        assert!(matches!(hung, Err(BootError::ServerFailed)));
        assert_eq!(tried, vec![4100]);

        // Two exits in a row give up rather than looping.
        let mut tried = Vec::new();
        let gone = start_with_retry(4100, || 4200, |port| {
            tried.push(port);
            Err::<u16, _>(StartFailure::Exited)
        });
        assert!(gone.is_err());
        assert_eq!(tried, vec![4100, 4200]);
    }

    #[cfg(unix)]
    #[test]
    fn shell_probe_answers_come_from_the_last_path_line() {
        let root = std::env::temp_dir().join(format!("helicon-probe-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let node = root.join("node");
        std::fs::write(&node, "").unwrap();
        // rc files print above the answer; a removed install may linger below nothing.
        let output = format!("Welcome back\n{}\n", node.display());
        assert_eq!(select_probe_path(&output), Some(node.clone()));
        assert_eq!(select_probe_path("Welcome back\n"), None);
        assert_eq!(select_probe_path("/no/such/node-here\n"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn well_known_homes_only_list_installs_that_exist() {
        let home = std::env::temp_dir().join(format!("helicon-home-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".volta/bin")).unwrap();
        std::fs::write(home.join(".volta/bin/node"), "").unwrap();
        let nodes = well_known_nodes_in(&home);
        assert!(nodes.contains(&home.join(".volta/bin/node")));
        assert!(!nodes.contains(&home.join(".asdf/shims/node")));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn nvm_resolves_to_the_newest_installed_version() {
        let home = std::env::temp_dir().join(format!("helicon-nvm-{}", std::process::id()));
        for version in ["v18.20.4", "v20.11.0", "v20.9.0"] {
            let dir = home.join(".nvm/versions/node").join(version).join("bin");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("node"), "").unwrap();
        }
        std::fs::create_dir_all(home.join(".nvm/versions/node/junk")).unwrap();
        let node = latest_nvm_node(&home).unwrap();
        assert!(node.ends_with(".nvm/versions/node/v20.11.0/bin/node"), "got {node:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn path_augmentation_prepends_without_duplicating() {
        use std::ffi::OsString;
        let prepend = [PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
        assert_eq!(
            prepend_to_path(&prepend, Some(OsString::from("/usr/bin:/bin"))),
            OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        );
        assert_eq!(
            prepend_to_path(&prepend, Some(OsString::from("/usr/local/bin:/usr/bin"))),
            OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin")
        );
        assert_eq!(prepend_to_path(&prepend, None), OsString::from("/opt/homebrew/bin:/usr/local/bin"));
    }
}
