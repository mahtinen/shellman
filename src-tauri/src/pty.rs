//! Pseudo-terminal sessions backed by Windows ConPTY (via `portable-pty`).
//!
//! Each session has:
//! - a reader thread that streams decoded UTF-8 output to the frontend over a
//!   Tauri channel, followed by a final `{"exit": code}` message;
//! - a waiter thread that blocks on the child and, once it exits, closes the
//!   pseudoconsole. On Windows the output pipe only reports EOF after the
//!   pseudoconsole is closed, so this is what lets the reader finish.

use crate::connect::{self, Connection};
use crate::shell::{build_launch, ShellKind, ShellProfile};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};

struct Session {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// Input queue drained by a dedicated writer thread, so a full input pipe
    /// never blocks the caller and writes stay ordered.
    input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    busy_check: BusyCheck,
    /// Git Bash's `ps.exe`, which still knows a program's parent when Windows doesn't.
    msys_ps: Option<PathBuf>,
}

/// How to tell whether a terminal's shell is running a program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BusyCheck {
    /// Any child process of the shell.
    Children,
    /// Git Bash's `bin\bash.exe` is a launcher for `usr\bin\bash.exe` (and `exec` leaves a stub
    /// bash behind), so look through bash children with the same name first.
    ThroughLauncher,
    /// WSL: programs run inside Linux and aren't Windows processes.
    Unknown,
}

impl Session {
    /// Closes the pseudoconsole. Console clients still attached to it are
    /// sent CTRL_CLOSE_EVENT by conhost.
    fn close(&self) {
        self.input.lock().unwrap().take();
        self.master.lock().unwrap().take();
    }
}

#[derive(Default)]
pub struct PtyManager {
    /// Shared with the reader threads, which remove their session once it has ended.
    sessions: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
    next_id: AtomicU32,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    /// The shell to start; ignored when `connection` is set.
    #[serde(default)]
    pub shell: Option<ShellProfile>,
    /// Connect to a remote host with ssh.exe / telnet.exe instead of starting a shell.
    #[serde(default)]
    pub connection: Option<Connection>,
    /// ssh.exe from Settings; empty = Windows OpenSSH.
    #[serde(default)]
    pub ssh_path: String,
    /// Where chosen agent keys' public key files are kept (set by the app, not the frontend).
    #[serde(skip)]
    pub key_dir: Option<PathBuf>,
    pub cwd: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub shell_integration: bool,
    pub cols: u16,
    pub rows: u16,
}

fn default_true() -> bool {
    true
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(2),
        rows: rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Incremental UTF-8 decoder that never splits a multi-byte character across
/// two messages. Invalid sequences become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::with_capacity(self.pending.len());
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    rest = &[];
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    // SAFETY: `valid_up_to` guarantees this prefix is valid UTF-8.
                    out.push_str(unsafe { std::str::from_utf8_unchecked(valid) });
                    match e.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &after[len..];
                        }
                        // Incomplete trailing sequence: keep it for the next read.
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        out
    }
}

impl PtyManager {
    pub fn spawn(&self, req: SpawnRequest, output: Channel<InvokeResponseBody>) -> Result<u32, String> {
        if !Path::new(&req.cwd).is_dir() {
            return Err(format!("Directory not found: {}", req.cwd));
        }

        let launch = match (&req.connection, &req.shell) {
            (Some(c), _) => {
                let key_dir = req.key_dir.clone().unwrap_or_else(|| std::env::temp_dir().join("shellman-ssh-keys"));
                connect::launch(c, &req.ssh_path, &key_dir)?
            }
            (None, Some(shell)) => build_launch(shell, &req.cwd, req.command.as_deref(), req.shell_integration),
            (None, None) => return Err("Nothing to start: no shell or connection given".into()),
        };
        let busy_check = match (&req.connection, &req.shell) {
            (None, Some(shell)) if shell.kind == ShellKind::Bash => BusyCheck::ThroughLauncher,
            (None, Some(shell)) if shell.kind == ShellKind::Wsl => BusyCheck::Unknown,
            _ => BusyCheck::Children,
        };

        let pair = native_pty_system()
            .openpty(size(req.cols, req.rows))
            .map_err(|e| format!("Could not create pseudo console: {e}"))?;

        let mut cmd = CommandBuilder::new(&launch.program);
        cmd.args(&launch.args);
        cmd.cwd(&req.cwd);
        cmd.env("TERM_PROGRAM", "Shellman");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in &launch.env {
            cmd.env(k, v);
        }
        for (k, v) in &req.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Could not start {}: {e}", launch.program))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        if let Some(text) = &launch.typed_input {
            let _ = input_tx.send(text.as_bytes().to_vec());
        }

        let session = Arc::new(Session {
            master: Mutex::new(Some(pair.master)),
            input: Mutex::new(Some(input_tx)),
            killer: Mutex::new(child.clone_killer()),
            pid: child.process_id(),
            busy_check,
            msys_ps: if busy_check == BusyCheck::ThroughLauncher { msys_ps(Path::new(&launch.program)) } else { None },
        });

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(id, session.clone());
        let sessions = self.sessions.clone();

        std::thread::Builder::new()
            .name(format!("pty-{id}-write"))
            .spawn(move || {
                for data in input_rx {
                    if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        let (exit_tx, exit_rx) = mpsc::channel::<u32>();

        std::thread::Builder::new()
            .name(format!("pty-{id}-wait"))
            .spawn(move || {
                let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
                let _ = exit_tx.send(code);
                session.close();
            })
            .map_err(|e| e.to_string())?;

        std::thread::Builder::new()
            .name(format!("pty-{id}-read"))
            .spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                let mut decoder = Utf8Stream::default();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = decoder.push(&buf[..n]);
                            if text.is_empty() {
                                continue;
                            }
                            let json = serde_json::to_string(&text).unwrap_or_default();
                            if output.send(InvokeResponseBody::Json(json)).is_err() {
                                break;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let code = exit_rx.recv_timeout(Duration::from_secs(10)).ok();
                let msg = serde_json::json!({ "exit": code }).to_string();
                let _ = output.send(InvokeResponseBody::Json(msg));
                // The terminal has ended: drop it here, or it stays (with its process handle)
                // until the pane is closed.
                sessions.lock().unwrap().remove(&id);
            })
            .map_err(|e| e.to_string())?;

        Ok(id)
    }

    fn get(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&id).cloned()
    }

    /// Writing to a terminal that has just ended is not an error: the frontend learns about the
    /// exit a moment later.
    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let Some(session) = self.get(id) else { return Ok(()) };
        if let Some(tx) = session.input.lock().unwrap().as_ref() {
            let _ = tx.send(data.to_vec());
        }
        Ok(())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let Some(session) = self.get(id) else { return Ok(()) };
        let guard = session.master.lock().unwrap();
        match guard.as_ref() {
            Some(m) => m.resize(size(cols, rows)).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// True when the terminal's shell has started programs that are still
    /// running (e.g. `claude` or a dev server), i.e. closing it would lose work.
    /// An error means it can't be told (WSL); the caller decides.
    pub fn has_children(&self, id: u32) -> Result<bool, String> {
        let Some(session) = self.get(id) else { return Ok(false) };
        let Some(pid) = session.pid else { return Ok(false) };
        match session.busy_check {
            BusyCheck::Unknown => Err("Programs running inside WSL can't be seen from Windows".into()),
            BusyCheck::Children => Ok(busy(&processes(), pid, false)),
            BusyCheck::ThroughLauncher => {
                let procs = processes();
                let (shell, kids) = shell_and_children(&procs, pid, true);
                if !kids.is_empty() {
                    return Ok(true);
                }
                Ok(session.msys_ps.as_deref().and_then(run_ps).is_some_and(|out| msys_busy(&out, &shell)))
            }
        }
    }

    /// Closes the terminal and terminates its process. Returns immediately.
    pub fn kill(&self, id: u32) {
        let Some(session) = self.sessions.lock().unwrap().remove(&id) else {
            return;
        };
        // ClosePseudoConsole can block while conhost flushes, so do it off the
        // IPC thread.
        std::thread::spawn(move || {
            session.close();
            let _ = session.killer.lock().unwrap().kill();
        });
    }

    pub fn kill_all(&self) {
        let sessions: Vec<_> = self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for s in sessions {
            s.close();
            let _ = s.killer.lock().unwrap().kill();
        }
    }
}

/// One running process.
#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub exe: String,
    /// Creation time (FILETIME ticks); 0 when it couldn't be read.
    pub start: u64,
}

/// The processes whose parent is `pid`. Windows reuses process ids, and a process keeps the id
/// of its parent after that parent has exited, so a long-running process can name an id that
/// now belongs to someone else (e.g. csrss.exe "under" a new shell). A real child can't have
/// started before its parent.
fn children(procs: &[Proc], pid: u32) -> Vec<&Proc> {
    let parent_start = procs.iter().find(|p| p.pid == pid).map_or(0, |p| p.start);
    procs
        .iter()
        .filter(|p| p.ppid == pid && p.pid != pid)
        .filter(|p| parent_start == 0 || (p.start != 0 && p.start >= parent_start))
        .collect()
}

/// The shell's own processes and the processes it runs. With `through_launcher`, a chain of
/// single children with the shell's own executable name (a launcher, or the stub `exec` leaves)
/// is the shell itself, so only what runs below it counts.
fn shell_and_children(procs: &[Proc], pid: u32, through_launcher: bool) -> (Vec<u32>, Vec<&Proc>) {
    let mut chain = vec![pid];
    let mut kids = children(procs, pid);
    if through_launcher {
        let name = procs.iter().find(|p| p.pid == pid).map(|p| p.exe.as_str()).unwrap_or("");
        // Bounded, in case process ids were reused into a loop.
        for _ in 0..8 {
            match kids.as_slice() {
                [only] if !name.is_empty() && only.exe.eq_ignore_ascii_case(name) => {
                    chain.push(only.pid);
                    kids = children(procs, only.pid);
                }
                _ => break,
            }
        }
    }
    (chain, kids)
}

/// Whether the shell `pid` runs a program, judged by Windows' parent links.
pub fn busy(procs: &[Proc], pid: u32, through_launcher: bool) -> bool {
    !shell_and_children(procs, pid, through_launcher).1.is_empty()
}

/// Git Bash's `ps.exe` next to (or below) the given bash.
fn msys_ps(program: &Path) -> Option<PathBuf> {
    let dir = program.parent()?;
    [dir.join("ps.exe"), dir.parent()?.join("usr").join("bin").join("ps.exe")]
        .into_iter()
        .find(|p| p.is_file())
}

/// Whether, in MSYS `ps` output, a process runs below the shell whose Windows pids are `shell`.
///
/// Newer Git for Windows starts programs through a short-lived process, so Windows' parent links
/// lose them (the program's Windows parent no longer exists), while MSYS keeps its own parent ids.
/// Columns: an optional status letter, then PID PPID PGID WINPID TTY UID STIME COMMAND.
pub fn msys_busy(ps_output: &str, shell: &[u32]) -> bool {
    let rows: Vec<(u32, u32, u32)> = ps_output
        .lines()
        .filter_map(|line| {
            let mut cols = line.trim_start_matches(|c: char| c.is_ascii_alphabetic()).split_whitespace();
            let pid = cols.next()?.parse().ok()?;
            let ppid = cols.next()?.parse().ok()?;
            let _pgid: u32 = cols.next()?.parse().ok()?;
            let winpid = cols.next()?.parse().ok()?;
            Some((pid, ppid, winpid))
        })
        .collect();
    let shell_pids: Vec<u32> = rows.iter().filter(|(_, _, w)| shell.contains(w)).map(|(p, _, _)| *p).collect();
    rows.iter().any(|(pid, ppid, _)| shell_pids.contains(ppid) && !shell_pids.contains(pid))
}

/// Runs `ps` (MSYS) without a console window.
fn run_ps(ps: &Path) -> Option<String> {
    let mut cmd = std::process::Command::new(ps);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// All running processes.
#[cfg(windows)]
pub fn processes() -> Vec<Proc> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: plain Win32 calls; the snapshot handle is closed before returning.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                out.push(Proc {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
                    start: start_time(entry.th32ProcessID),
                });
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

/// When process `pid` was created, or 0 if that can't be read.
#[cfg(windows)]
fn start_time(pid: u32) -> u64 {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: plain Win32 calls on a handle that is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return 0;
        }
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0;
        CloseHandle(handle);
        if ok {
            (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)
        } else {
            0
        }
    }
}

#[cfg(not(windows))]
pub fn processes() -> Vec<Proc> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::detect_shells;
    use std::time::Instant;

    #[test]
    fn utf8_stream_handles_split_characters() {
        let mut d = Utf8Stream::default();
        let bytes = "aä€😀b".as_bytes();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.push(std::slice::from_ref(b)));
        }
        assert_eq!(out, "aä€😀b");
    }

    #[test]
    fn utf8_stream_replaces_invalid_bytes() {
        let mut d = Utf8Stream::default();
        assert_eq!(d.push(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(d.push(b"\xe2\x82"), "");
        assert_eq!(d.push(b"\xac"), "€");
    }

    /// Spawns each detected shell through a real ConPTY and checks that the
    /// startup command runs in the requested directory and that shell
    /// integration reports the directory with OSC 9;9.
    #[test]
    fn real_shells_run_startup_command() {
        let dir = std::env::temp_dir().join("shellman test dir ä");
        std::fs::create_dir_all(&dir).unwrap();
        let dir_s = dir.to_string_lossy().to_string();

        for shell in detect_shells() {
            let (command, expect) = match shell.kind {
                crate::shell::ShellKind::Powershell => ("Write-Output \"ok-$((Get-Location).Path)\"", "ok-"),
                crate::shell::ShellKind::Cmd => ("echo ok-%CD% & echo \"quoted & stuff\"", "\"quoted & stuff\""),
                crate::shell::ShellKind::Bash => ("echo \"ok-$(pwd)\" 'single'", "single"),
                _ => continue,
            };

            let out = Arc::new(Mutex::new(String::new()));
            let sink = out.clone();
            let channel = Channel::new(move |body| {
                if let InvokeResponseBody::Json(s) = body {
                    if let Ok(serde_json::Value::String(text)) = serde_json::from_str(&s) {
                        sink.lock().unwrap().push_str(&text);
                    }
                }
                Ok(())
            });

            let mgr = PtyManager::default();
            let id = mgr
                .spawn(
                    SpawnRequest {
                        shell: Some(shell.clone()),
                        connection: None,
                        ssh_path: String::new(),
                    key_dir: None,
                        cwd: dir_s.clone(),
                        command: Some(command.into()),
                        env: HashMap::new(),
                        shell_integration: true,
                        cols: 200,
                        rows: 40,
                    },
                    channel,
                )
                .unwrap();

            let deadline = Instant::now() + Duration::from_secs(20);
            let mut ok = false;
            let mut answered_dsr = false;
            while Instant::now() < deadline {
                let text = out.lock().unwrap().clone();
                // ConPTY asks for the cursor position on start-up and waits
                // for the reply; xterm.js answers this in the real app.
                if !answered_dsr && text.contains("\x1b[6n") {
                    mgr.write(id, b"\x1b[1;1R").unwrap();
                    answered_dsr = true;
                }
                if text.contains(expect) && text.contains("]9;9;") {
                    ok = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let text = out.lock().unwrap().clone();
            mgr.kill(id);
            assert!(ok, "{}: expected {expect:?} and OSC 9;9 in output:\n{text}", shell.name);
            assert!(
                text.contains("shellman test dir"),
                "{}: cwd not reported:\n{text}",
                shell.name
            );
        }
    }

    #[test]
    fn detects_running_child_programs() {
        let cmd = detect_shells()
            .into_iter()
            .find(|s| s.kind == crate::shell::ShellKind::Cmd)
            .expect("cmd.exe");
        let mgr = Arc::new(PtyManager::default());
        let answered = Arc::new(Mutex::new(false));
        let (mgr2, answered2) = (mgr.clone(), answered.clone());
        let id_cell = Arc::new(Mutex::new(0u32));
        let id_cell2 = id_cell.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                let mut a = answered2.lock().unwrap();
                let id = *id_cell2.lock().unwrap();
                if !*a && id != 0 && s.contains("[6n") {
                    let _ = mgr2.write(id, b"[1;1R");
                    *a = true;
                }
            }
            Ok(())
        });
        let id = mgr
            .spawn(
                SpawnRequest {
                    shell: Some(cmd),
                    connection: None,
                    ssh_path: String::new(),
                    key_dir: None,
                    cwd: std::env::temp_dir().to_string_lossy().into(),
                    command: Some("ping -n 30 127.0.0.1".into()),
                    env: HashMap::new(),
                    shell_integration: false,
                    cols: 80,
                    rows: 24,
                },
                channel,
            )
            .unwrap();
        *id_cell.lock().unwrap() = id;
        // The DSR may have arrived before the id was known; answer it anyway.
        let _ = mgr.write(id, b"[1;1R");

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut found = false;
        while Instant::now() < deadline {
            if mgr.has_children(id).unwrap() {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        mgr.kill(id);
        assert!(found, "ping was not detected as a child of cmd.exe");
        assert!(!mgr.has_children(id).unwrap(), "killed session must report no children");
    }

    /// Runs the real Windows ssh.exe through ConPTY against a closed local port: its error
    /// shows up in the terminal and the session ends with ssh's exit code.
    #[test]
    fn ssh_connection_runs_the_client() {
        if connect::ssh_client("").is_err() {
            eprintln!("ssh.exe not installed; skipped");
            return;
        }
        let out = Arc::new(Mutex::new(String::new()));
        let sink = out.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                match serde_json::from_str(&s) {
                    Ok(serde_json::Value::String(text)) => sink.lock().unwrap().push_str(&text),
                    Ok(other) => sink.lock().unwrap().push_str(&format!("\n<<{other}>>")),
                    Err(_) => {}
                }
            }
            Ok(())
        });
        let mgr = PtyManager::default();
        let id = mgr
            .spawn(
                SpawnRequest {
                    shell: None,
                    connection: Some(Connection {
                        kind: connect::ConnectionKind::Ssh,
                        host: "127.0.0.1".into(),
                        port: Some(1),
                        user: "nobody".into(),
                        identity_file: String::new(),
                        identity_key: String::new(),
                        password_auth: false,
                        legacy_algorithms: false,
                        jump_host: String::new(),
                        extra_args: vec!["-o".into(), "BatchMode=yes".into(), "-o".into(), "ConnectTimeout=5".into()],
                    }),
                    ssh_path: String::new(),
                    key_dir: None,
                    cwd: std::env::temp_dir().to_string_lossy().into(),
                    command: None,
                    env: HashMap::new(),
                    shell_integration: false,
                    cols: 120,
                    rows: 30,
                },
                channel,
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut answered_dsr = false;
        while Instant::now() < deadline {
            let text = out.lock().unwrap().clone();
            if !answered_dsr && text.contains("\x1b[6n") {
                let _ = mgr.write(id, b"\x1b[1;1R");
                answered_dsr = true;
            }
            if text.contains("<<{\"exit\"") {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let text = out.lock().unwrap().clone();
        mgr.kill(id);
        // e.g. "connect to host 127.0.0.1 port 1: Connection refused" (wording varies by version)
        assert!(text.contains("Connection"), "ssh error not shown:\n{text:?}");
        assert!(text.contains("<<{\"exit\":255}>>"), "expected ssh's exit code 255:\n{text}");
    }

    /// A process started at "time" `pid`, so higher ids started later.
    fn proc(pid: u32, ppid: u32, exe: &str) -> Proc {
        Proc { pid, ppid, exe: exe.into(), start: u64::from(pid) }
    }

    #[test]
    fn reused_parent_ids_are_not_children() {
        // csrss.exe still names its long-gone parent's id, which Windows has given to a new shell.
        let procs = [proc(5, 50, "csrss.exe"), proc(50, 1, "bash.exe"), proc(51, 50, "bash.exe")];
        assert!(!busy(&procs, 50, true), "an older process with a reused parent id counted");
        assert!(busy(&[proc(5, 50, "csrss.exe"), proc(50, 1, "pwsh.exe"), proc(60, 50, "node.exe")], 50, false));
        // A child whose start time can't be read is left out; an unknown parent time keeps the old behaviour.
        assert!(!busy(&[proc(50, 1, "pwsh.exe"), Proc { start: 0, ..proc(60, 50, "x.exe") }], 50, false));
        assert!(busy(&[Proc { start: 0, ..proc(50, 1, "pwsh.exe") }, proc(5, 50, "x.exe")], 50, false));
    }

    #[test]
    fn busy_looks_through_the_git_bash_launcher() {
        // bin\bash.exe (10) -> usr\bin\bash.exe (11) [-> stub after exec -> bash (12)]
        let idle = [proc(10, 1, "bash.exe"), proc(11, 10, "bash.exe")];
        assert!(!busy(&idle, 10, true));
        assert!(busy(&idle, 10, false), "without looking through, the launcher's child counts");
        let after_exec = [proc(10, 1, "bash.exe"), proc(11, 10, "bash.exe"), proc(12, 11, "bash.exe")];
        assert!(!busy(&after_exec, 10, true));
        let running = [proc(10, 1, "bash.exe"), proc(11, 10, "bash.exe"), proc(13, 11, "node.exe")];
        assert!(busy(&running, 10, true));
        // A shell that isn't a launcher: its only child is a real program.
        let cmd = [proc(20, 1, "cmd.exe"), proc(21, 20, "ping.exe")];
        assert!(busy(&cmd, 20, true));
        assert!(!busy(&[proc(30, 1, "pwsh.exe")], 30, false));
    }

    #[test]
    fn msys_ps_knows_parents_windows_lost() {
        // Shell: Windows pids 7492 (launcher) and 2480 (bash, MSYS pid 6013). `sleep` (MSYS 6023,
        // parent 6013) was started through a process that has exited, so Windows can't link it.
        let ps = "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
     6013       1    6013       2480  cons0      4096 17:21:30 /usr/bin/bash
     6023    6013    6023       1652  cons0      4096 17:21:32 /usr/bin/sleep
     6024       1    6024      28432  ?          4096 17:21:34 /usr/bin/ps
I    7000       1    7000       9999  ?          4096 17:00:00 /usr/bin/bash
";
        assert!(msys_busy(ps, &[7492, 2480]));
        // Idle: nothing has the shell as its parent (another bash elsewhere doesn't count).
        let idle = "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
     6013       1    6013       2480  cons0      4096 17:21:30 /usr/bin/bash
I    7000       1    7000       9999  ?          4096 17:00:00 /usr/bin/bash
     7001    7000    7001       9998  ?          4096 17:00:01 /usr/bin/sleep
";
        assert!(!msys_busy(idle, &[7492, 2480]));
        assert!(!msys_busy("", &[1]));
    }

    /// Spawns `shell` with `command`, answers ConPTY's start-up cursor query and waits until
    /// `ready` appears in the output.
    fn spawn_ready(mgr: &Arc<PtyManager>, shell: ShellProfile, command: Option<&str>, ready: &str) -> u32 {
        let out = Arc::new(Mutex::new(String::new()));
        let sink = out.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                if let Ok(serde_json::Value::String(text)) = serde_json::from_str(&s) {
                    sink.lock().unwrap().push_str(&text);
                }
            }
            Ok(())
        });
        let id = mgr
            .spawn(
                SpawnRequest {
                    shell: Some(shell),
                    connection: None,
                    ssh_path: String::new(),
                    key_dir: None,
                    cwd: std::env::temp_dir().to_string_lossy().into(),
                    command: command.map(Into::into),
                    env: HashMap::new(),
                    shell_integration: false,
                    cols: 120,
                    rows: 30,
                },
                channel,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut answered = false;
        while Instant::now() < deadline {
            let text = out.lock().unwrap().clone();
            if !answered && text.contains("\x1b[6n") {
                mgr.write(id, b"\x1b[1;1R").unwrap();
                answered = true;
            }
            if text.contains(ready) {
                return id;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("{ready:?} never appeared:\n{}", out.lock().unwrap());
    }

    /// An idle Git Bash is not busy (its launcher and the `exec` stub are bash itself), one
    /// running a program is.
    #[test]
    fn git_bash_busy_only_when_running_a_program() {
        let Some(bash) = detect_shells().into_iter().find(|s| s.kind == crate::shell::ShellKind::Bash) else {
            eprintln!("Git Bash not installed; skipped");
            return;
        };
        let mgr = Arc::new(PtyManager::default());
        // What Git Bash's own `ps` says, checked separately: newer Git for Windows needs it
        // because Windows loses the program's parent (see `msys_busy`).
        let ps_says = |id: u32| -> Option<bool> {
            let session = mgr.get(id)?;
            let (shell, _) = shell_and_children(&processes(), session.pid?, true);
            Some(msys_busy(&run_ps(session.msys_ps.as_deref()?)?, &shell))
        };
        // A startup command makes bash `exec` a new shell afterwards, which leaves a stub process.
        let idle = spawn_ready(&mgr, bash.clone(), Some("echo idle-$((40+2))"), "idle-42");
        std::thread::sleep(Duration::from_millis(1500));
        let tree = process_tree(mgr.get(idle).and_then(|s| s.pid).unwrap_or(0));
        assert!(!mgr.has_children(idle).unwrap(), "idle Git Bash reported as busy; process tree:\n{tree}");
        assert_eq!(ps_says(idle), Some(false), "ps: idle Git Bash reported as busy; process tree:\n{tree}");
        mgr.kill(idle);

        let running = spawn_ready(&mgr, bash, Some("echo running-$((40+2)); sleep 30"), "running-42");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut found = false;
        while Instant::now() < deadline && !found {
            found = mgr.has_children(running).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        let by_ps = ps_says(running);
        let tree = process_tree(mgr.get(running).and_then(|s| s.pid).unwrap_or(0));
        mgr.kill(running);
        assert!(found, "sleep in Git Bash was not detected; process tree:\n{tree}");
        assert_eq!(by_ps, Some(true), "ps: sleep in Git Bash was not detected; process tree:\n{tree}");
    }

    /// `pid` and everything below it, for failure messages.
    fn process_tree(pid: u32) -> String {
        fn walk(procs: &[Proc], pid: u32, depth: usize, out: &mut String) {
            if depth > 10 {
                return;
            }
            for p in children(procs, pid) {
                out.push_str(&format!("{}{} {}\n", "  ".repeat(depth), p.pid, p.exe));
                walk(procs, p.pid, depth + 1, out);
            }
        }
        let procs = processes();
        let mut out = format!("{pid} {}\n", procs.iter().find(|p| p.pid == pid).map(|p| p.exe.as_str()).unwrap_or("?"));
        walk(&procs, pid, 1, &mut out);
        out
    }

    #[test]
    fn ended_terminals_are_removed() {
        let cmd = detect_shells().into_iter().find(|s| s.kind == crate::shell::ShellKind::Cmd).expect("cmd.exe");
        let mgr = Arc::new(PtyManager::default());
        let id = spawn_ready(&mgr, cmd, Some("echo bye-%NUMBER_OF_PROCESSORS%& exit"), "bye-");
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && mgr.get(id).is_some() {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(mgr.get(id).is_none(), "the ended terminal is still registered");
        // Input or a resize that races with the exit is ignored, not an error.
        assert!(mgr.write(id, b"x").is_ok() && mgr.resize(id, 80, 24).is_ok());
    }

    #[test]
    fn spawn_needs_a_shell_or_connection() {
        let err = PtyManager::default()
            .spawn(
                SpawnRequest {
                    shell: None,
                    connection: None,
                    ssh_path: String::new(),
                    key_dir: None,
                    cwd: std::env::temp_dir().to_string_lossy().into(),
                    command: None,
                    env: HashMap::new(),
                    shell_integration: false,
                    cols: 80,
                    rows: 24,
                },
                Channel::new(|_| Ok(())),
            )
            .unwrap_err();
        assert!(err.contains("no shell or connection"), "{err}");
    }
}
