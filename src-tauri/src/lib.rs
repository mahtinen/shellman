mod collection;
mod config;
mod connect;
mod files;
mod git;
mod http;
mod proc;
mod pty;
mod shell;
mod worktree;
mod xshell;

use http::HttpManager;
use pty::{PtyManager, SpawnRequest};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
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

/// The Linux home folder of a WSL shell, as a Windows path.
#[tauri::command]
async fn wsl_home(shell: ShellProfile) -> Result<String, String> {
    blocking(move || shell::wsl_home(&shell)).await
}

/// Sends one request pane's request with curl. Waiting for curl happens on a blocking thread, so
/// slow requests don't hold up other commands.
#[tauri::command]
async fn http_send(state: State<'_, Arc<HttpManager>>, id: u32, request: http::HttpRequest) -> Result<http::HttpResult, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.send(id, &request))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn http_cancel(state: State<'_, Arc<HttpManager>>, id: u32) {
    state.cancel(id);
}

/// Copies a response body to a file the user chose.
#[tauri::command]
async fn http_save_body(state: State<'_, Arc<HttpManager>>, id: u32, path: String) -> Result<(), String> {
    state.save_body(id, std::path::Path::new(&path))
}

#[tauri::command]
async fn http_discard(state: State<'_, Arc<HttpManager>>, id: u32) -> Result<(), String> {
    state.discard(id);
    Ok(())
}

#[tauri::command]
async fn http_cookies(state: State<'_, Arc<HttpManager>>, key: String) -> Result<Vec<http::Cookie>, String> {
    Ok(state.cookies(&key))
}

#[tauri::command]
async fn http_clear_cookies(state: State<'_, Arc<HttpManager>>, key: String) -> Result<(), String> {
    state.clear_cookies(&key);
    Ok(())
}

/// Runs blocking work (git, folder scans) off the async runtime's threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Request files, environments and `.env` files of a linked folder.
#[tauri::command]
async fn collection_scan(folder: String) -> Result<collection::Scan, String> {
    blocking(move || collection::scan(std::path::Path::new(&folder))).await
}

#[tauri::command]
async fn collection_write(folder: String, path: String, kind: collection::Kind, text: String) -> Result<(), String> {
    collection::write(std::path::Path::new(&folder), &path, kind, &text)
}

#[tauri::command]
async fn collection_create_folder(folder: String, path: String) -> Result<(), String> {
    collection::create_folder(std::path::Path::new(&folder), &path)
}

#[tauri::command]
async fn collection_rename(folder: String, from: String, to: String, kind: collection::Kind) -> Result<(), String> {
    collection::rename(std::path::Path::new(&folder), &from, &to, kind)
}

#[tauri::command]
async fn collection_delete(folder: String, path: String, kind: collection::Kind) -> Result<(), String> {
    collection::delete(std::path::Path::new(&folder), &path, kind)
}

/// Reports (debounced) when files in a linked folder change, e.g. after a git pull.
#[tauri::command]
fn collection_watch(state: State<'_, collection::Watches>, folder: String, on_change: Channel<()>) -> Result<u32, String> {
    state.watch(std::path::Path::new(&folder), move || on_change.send(()).is_ok())
}

#[tauri::command]
fn collection_unwatch(state: State<'_, collection::Watches>, id: u32) {
    state.unwatch(id);
}

/// The linked folder's git state; null when it isn't in a repository.
#[tauri::command]
async fn git_status(folder: String) -> Result<Option<git::Status>, String> {
    blocking(move || git::status(std::path::Path::new(&folder))).await
}

#[tauri::command]
async fn git_is_ignored(folder: String, path: String) -> Result<Option<bool>, String> {
    blocking(move || Ok(git::is_ignored(std::path::Path::new(&folder), &path))).await
}

#[tauri::command]
async fn git_fetch(folder: String) -> Result<git::Outcome, String> {
    blocking(move || Ok(git::fetch(std::path::Path::new(&folder)))).await
}

#[tauri::command]
async fn git_commit(folder: String, paths: Vec<String>, message: String) -> Result<bool, String> {
    blocking(move || git::commit(std::path::Path::new(&folder), &paths, &message)).await
}

#[tauri::command]
async fn git_sync(folder: String, prefer: git::Prefer, interactive: bool) -> Result<git::Outcome, String> {
    blocking(move || Ok(git::sync(std::path::Path::new(&folder), prefer, interactive))).await
}

/// One folder's entries in the Files pane (`dir` relative to `root`, '' for the root).
#[tauri::command]
async fn files_list(root: String, dir: String) -> Result<files::Listing, String> {
    blocking(move || files::list(std::path::Path::new(&root), &dir)).await
}

#[tauri::command]
async fn files_read(root: String, path: String) -> Result<files::Content, String> {
    blocking(move || files::read(std::path::Path::new(&root), &path)).await
}

/// Every file in the folder, for "Go to file".
#[tauri::command]
async fn files_all(root: String) -> Result<files::AllFiles, String> {
    blocking(move || files::all(std::path::Path::new(&root))).await
}

/// Which of `paths` are files, so paths printed in a terminal can become links to them.
#[tauri::command]
async fn files_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    blocking(move || Ok(paths.iter().take(50).map(|p| std::path::Path::new(p).is_file()).collect())).await
}

/// Reports (debounced) when something in the folder changes, including commits and checkouts.
#[tauri::command]
fn files_watch(state: State<'_, collection::Watches>, root: String, on_change: Channel<()>) -> Result<u32, String> {
    state.watch_with(std::path::Path::new(&root), files::relevant, move || on_change.send(()).is_ok())
}

/// Opens the folder in VS Code, with `file` (relative) open at `line`.
#[tauri::command]
async fn open_in_editor(root: String, file: Option<String>, line: Option<u32>) -> Result<(), String> {
    blocking(move || files::open_in_editor(std::path::Path::new(&root), file.as_deref(), line)).await
}

/// The folder's changes since `base` (`HEAD` = not committed); null outside a repository.
#[tauri::command]
async fn git_changes(root: String, base: String) -> Result<Option<git::Changes>, String> {
    blocking(move || git::changes(std::path::Path::new(&root), &base)).await
}

/// A file as it was at `base`; null when it didn't exist there.
#[tauri::command]
async fn git_file_at(root: String, path: String, base: String) -> Result<Option<files::Content>, String> {
    blocking(move || git::file_at(std::path::Path::new(&root), &path, &base)).await
}

/// Finds text in the folder's files (git grep).
#[tauri::command]
async fn files_search(root: String, query: git::SearchQuery) -> Result<git::SearchResult, String> {
    blocking(move || git::search(std::path::Path::new(&root), &query)).await
}

/// The repository a folder is in and its worktrees; null outside a repository.
#[tauri::command]
async fn worktree_info(folder: String) -> Result<Option<worktree::RepoInfo>, String> {
    blocking(move || worktree::info(std::path::Path::new(&folder))).await
}

/// A new worktree at `path` on a new branch from `from`, with the ignored files matching `copy`.
#[tauri::command]
async fn worktree_add(folder: String, path: String, branch: String, from: String, copy: String) -> Result<worktree::Added, String> {
    blocking(move || worktree::add(std::path::Path::new(&folder), &path, &branch, &from, &copy)).await
}

/// What removing a worktree would lose.
#[tauri::command]
async fn worktree_status(path: String) -> Result<worktree::Status, String> {
    blocking(move || worktree::status(std::path::Path::new(&path))).await
}

#[tauri::command]
async fn worktree_remove(folder: String, path: String, delete_branch: bool, force: bool) -> Result<(), String> {
    blocking(move || worktree::remove(std::path::Path::new(&folder), &path, delete_branch, force)).await
}

/// Recent commits and other branches, for "Compare with"; null outside a repository.
#[tauri::command]
async fn git_compare_targets(root: String) -> Result<Option<git::CompareTargets>, String> {
    blocking(move || git::compare_targets(std::path::Path::new(&root))).await
}

#[tauri::command]
async fn git_hunks(root: String, path: String, old_path: Option<String>, base: String) -> Result<Vec<git::Hunk>, String> {
    blocking(move || git::hunks(std::path::Path::new(&root), &path, old_path.as_deref(), &base)).await
}

/// Where the 1Password CLI is (`custom` from Settings, else found), or null when it isn't installed.
#[tauri::command]
async fn op_path(custom: String) -> Option<String> {
    http::op_client(&custom).ok().map(|p| p.to_string_lossy().into_owned())
}

/// The 1Password accounts on this computer, to choose the one requests use.
#[tauri::command]
async fn op_accounts(custom: String) -> Result<Vec<http::OpAccount>, String> {
    blocking(move || Ok(http::op_accounts(&custom))).await
}

/// A JSON file the user picked to import (a Postman collection or environment export).
#[tauri::command]
async fn read_json_file(path: String) -> Result<String, String> {
    const MAX: u64 = 50 << 20;
    let p = std::path::Path::new(&path);
    if !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("json")) {
        return Err("Choose a .json file".into());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("Could not read {path}: {e}"))?;
    if meta.len() > MAX {
        return Err(format!("{path} is too large to import"));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(xshell::decode(&bytes))
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

/// XShell's sessions folder, if XShell has saved any here.
#[tauri::command]
async fn xshell_dir(app: tauri::AppHandle) -> Option<String> {
    let docs = app.path().document_dir().ok()?;
    xshell::default_dir(&docs).map(|p| p.to_string_lossy().into_owned())
}

/// The `.xsh` session files under `dir`, for importing them.
#[tauri::command]
async fn xshell_sessions(dir: String) -> Result<Vec<xshell::XshFile>, String> {
    xshell::read_sessions(std::path::Path::new(&dir))
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

    // Response bodies and cookies of runs that crashed or were killed.
    std::thread::spawn(|| {
        let alive: Vec<u32> = pty::processes().iter().map(|p| p.pid).collect();
        http::remove_stale_dirs(|pid| alive.contains(&pid));
    });

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
        .manage(Arc::new(HttpManager::default()))
        .manage(collection::Watches::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_write_bytes,
            pty_resize,
            pty_kill,
            pty_kill_all,
            pty_has_children,
            list_shells,
            wsl_home,
            ssh_agent_keys,
            ssh_public_key_file,
            config_load,
            config_save,
            workspace_load,
            workspace_save,
            clipboard_read,
            clipboard_write,
            dir_exists,
            xshell_dir,
            xshell_sessions,
            open_url,
            open_dir,
            system_info,
            http_send,
            http_cancel,
            http_save_body,
            http_discard,
            http_cookies,
            http_clear_cookies,
            collection_scan,
            collection_write,
            collection_create_folder,
            collection_rename,
            collection_delete,
            collection_watch,
            collection_unwatch,
            git_status,
            git_is_ignored,
            git_fetch,
            git_commit,
            git_sync,
            git_changes,
            git_file_at,
            git_hunks,
            files_list,
            files_read,
            files_all,
            files_search,
            files_exist,
            git_compare_targets,
            worktree_info,
            worktree_add,
            worktree_status,
            worktree_remove,
            files_watch,
            open_in_editor,
            read_json_file,
            op_path,
            op_accounts,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Shellman");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<PtyManager>().kill_all();
            handle.state::<Arc<HttpManager>>().shutdown();
        }
    });
}
