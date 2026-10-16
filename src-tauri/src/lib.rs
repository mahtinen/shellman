mod config;
mod connect;
mod pty;
mod shell;

use pty::{PtyManager, SpawnRequest};
use serde::Serialize;
use serde_json::Value;
use shell::ShellProfile;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, RunEvent, State};

#[tauri::command]
async fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    mut request: SpawnRequest,
    output: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    request.key_dir = Some(ssh_key_dir(&app)?);
    state.spawn(request, output)
}

/// Public key files of the agent keys chosen for SSH sessions.
fn ssh_key_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(config_dir(app)?.join("ssh-keys"))
}

/// The keys the SSH agent (Windows ssh-agent or 1Password) offers.
#[tauri::command]
async fn ssh_agent_keys(ssh_path: String) -> Result<connect::AgentKeys, String> {
    connect::agent_keys(&ssh_path)
}

/// The file `ssh -i` can use for a chosen agent key (for "Copy SSH command").
#[tauri::command]
async fn ssh_public_key_file(app: tauri::AppHandle, key: String) -> Result<String, String> {
    connect::public_key_file(&ssh_key_dir(&app)?, &key).map(|p| p.to_string_lossy().into_owned())
}

// Writes stay synchronous so keystrokes are delivered in order; the actual
// pipe write happens on the session's writer thread.
#[tauri::command]
fn pty_write(state: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    state.write(id, data.as_bytes())
}

#[tauri::command]
fn pty_write_bytes(state: State<'_, PtyManager>, id: u32, data: Vec<u8>) -> Result<(), String> {
    state.write(id, &data)
}

#[tauri::command]
fn pty_resize(state: State<'_, PtyManager>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: State<'_, PtyManager>, id: u32) {
    state.kill(id);
}

/// Ends every terminal. Used before the updater exits the app, which skips `RunEvent::Exit`.
/// Async: closing pseudoconsoles can block, and must not freeze the window.
#[tauri::command]
async fn pty_kill_all(state: State<'_, PtyManager>) -> Result<(), String> {
    state.kill_all();
    Ok(())
}

#[tauri::command]
async fn pty_has_children(state: State<'_, PtyManager>, id: u32) -> Result<bool, String> {
    state.has_children(id)
}

#[tauri::command]
async fn list_shells() -> Vec<ShellProfile> {
    shell::detect_shells()
}

/// Set to keep a separate profile (config, open tabs), e.g. so the end-to-end tests can run
/// next to a Shellman that is in use.
const CONFIG_DIR_VAR: &str = "SHELLMAN_CONFIG_DIR";

fn config_dir_override() -> Option<std::path::PathBuf> {
    std::env::var_os(CONFIG_DIR_VAR).filter(|d| !d.is_empty()).map(Into::into)
}

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match config_dir_override() {
        Some(dir) => Ok(dir),
        None => app.path().app_config_dir().map_err(|e| e.to_string()),
    }
}

#[tauri::command]
async fn config_load(app: tauri::AppHandle) -> Result<config::Loaded, String> {
    config::load(&config_dir(&app)?)
}

#[tauri::command]
async fn config_save(app: tauri::AppHandle, config: Value) -> Result<(), String> {
    config::save(&config_dir(&app)?, &config)
}

#[tauri::command]
async fn workspace_load(app: tauri::AppHandle) -> Result<config::Loaded, String> {
    config::load_file(&config_dir(&app)?, config::WORKSPACE_FILE)
}

#[tauri::command]
async fn workspace_save(app: tauri::AppHandle, workspace: Value) -> Result<(), String> {
    config::save_file(&config_dir(&app)?, config::WORKSPACE_FILE, &workspace)
}

#[tauri::command]
async fn clipboard_read() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .or_else(|e| match e {
            arboard::Error::ContentNotAvailable => Ok(String::new()),
            e => Err(e),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn clipboard_write(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

#[tauri::command]
// Async (off the main thread): a folder on an offline network drive can take many seconds.
async fn dir_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Opens an http(s) link in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Only http(s) links can be opened".into());
    }
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens a directory in Explorer.
#[tauri::command]
async fn open_dir(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("Directory not found: {path}"));
    }
    std::process::Command::new("explorer.exe")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    home_dir: String,
    config_dir: String,
    windows_build: u32,
    version: String,
}

fn windows_build() -> u32 {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .and_then(|k| k.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

#[tauri::command]
fn system_info(app: tauri::AppHandle) -> SystemInfo {
    let home = app
        .path()
        .home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "C:\\".into());
    SystemInfo {
        home_dir: home,
        config_dir: config_dir(&app)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        windows_build: windows_build(),
        // The version the updater compares against (tauri.conf.json).
        version: app.package_info().version.to_string(),
    }
}

/// Per-session markers that Claude Code sets for its own child processes. When
/// Shellman is launched from inside a Claude Code session they would leak into
/// every terminal and make a fresh `claude` think it is a nested child session.
const INHERITED_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SSE_PORT",
];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Runs before any other thread exists. Values the user set globally are
    // re-read from the registry when each terminal's environment is built.
    for var in INHERITED_SESSION_VARS {
        std::env::remove_var(var);
    }

    let mut builder = tauri::Builder::default();
    // The window-state plugin always writes to the real profile; a separate profile must not
    // overwrite the window position of the Shellman that is in use.
    if config_dir_override().is_none() {
        // One Shellman per profile: a second one would reopen the same tabs (and Claude
        // conversations) and overwrite the other's settings. Starting it again focuses this one.
        // A separate profile (the e2e tests) may run next to it.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_write_bytes,
            pty_resize,
            pty_kill,
            pty_kill_all,
            pty_has_children,
            list_shells,
            ssh_agent_keys,
            ssh_public_key_file,
            config_load,
            config_save,
            workspace_load,
            workspace_save,
            clipboard_read,
            clipboard_write,
            dir_exists,
            open_url,
            open_dir,
            system_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Shellman");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<PtyManager>().kill_all();
        }
    });
}
