//! Shell detection and launch-command construction.
//!
//! Startup commands are never spliced into a command line, because every shell
//! on Windows has different (and lossy) quoting rules. Instead:
//! - PowerShell receives a script via `-EncodedCommand` (base64 UTF-16LE).
//! - cmd receives `/K %SHELLMAN_CMD%` and expands the variable itself.
//! - bash / WSL receive `eval "$SHELLMAN_CMD"` and read the variable themselves.
//!
//! "Shell integration" makes each shell report its working directory after every
//! prompt using the `OSC 9;9` sequence (the same one Windows Terminal uses), so
//! "new terminal here" follows `cd`.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const CMD_ENV: &str = "SHELLMAN_CMD";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Powershell,
    Cmd,
    Bash,
    Wsl,
    Other,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub kind: ShellKind,
}

/// A fully resolved process launch.
#[derive(Debug, Clone, PartialEq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Text to type into the terminal after start (only for unknown shells).
    pub typed_input: Option<String>,
}

const PS_INTEGRATION: &str = r#"$global:__ShellmanPrompt = $function:prompt
function global:prompt {
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $osc = ''
  if ($loc.Provider.Name -eq 'FileSystem') { $osc = "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]27)\" }
  $osc + (& $global:__ShellmanPrompt)
}"#;

const CMD_INTEGRATION_PROMPT: &str = "$E]9;9;$P$E\\$P$G";

// Git Bash: report the Windows-style path. Kept as one line for PROMPT_COMMAND.
const BASH_INTEGRATION: &str =
    r#"printf '\033]9;9;%s\033\\' "$(cygpath -w "$PWD" 2>/dev/null || pwd)""#;

// Inside WSL report a Windows path when possible, so "new terminal here" works
// from Windows shells too; wslpath fails for Linux-only paths, so fall back.
const WSL_INTEGRATION: &str =
    r#"printf '\033]9;9;%s\033\\' "$(wslpath -w "$PWD" 2>/dev/null || pwd)""#;

fn non_empty(cmd: Option<&str>) -> Option<&str> {
    cmd.map(str::trim).filter(|c| !c.is_empty())
}

fn encode_ps(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Builds the launch for `profile`, optionally running `command` first and
/// leaving an interactive shell behind when it finishes.
pub fn build_launch(
    profile: &ShellProfile,
    cwd: &str,
    command: Option<&str>,
    integration: bool,
) -> Launch {
    let command = non_empty(command);
    let mut args = profile.args.clone();
    let mut env: Vec<(String, String)> = Vec::new();
    let mut typed_input = None;

    match profile.kind {
        ShellKind::Powershell => {
            if !args.iter().any(|a| a.eq_ignore_ascii_case("-nologo")) {
                args.push("-NoLogo".into());
            }
            let mut script = String::new();
            if integration {
                script.push_str(PS_INTEGRATION);
                script.push('\n');
            }
            if let Some(c) = command {
                script.push_str(c);
                script.push('\n');
            }
            if !script.is_empty() {
                args.push("-NoExit".into());
                args.push("-EncodedCommand".into());
                args.push(encode_ps(&script));
            }
        }
        ShellKind::Cmd => {
            if integration {
                env.push(("PROMPT".into(), CMD_INTEGRATION_PROMPT.into()));
            }
            if let Some(c) = command {
                env.push((CMD_ENV.into(), c.into()));
                args.push("/K".into());
                args.push(format!("%{CMD_ENV}%"));
            }
        }
        ShellKind::Bash => {
            if integration {
                env.push(("PROMPT_COMMAND".into(), BASH_INTEGRATION.into()));
            }
            if let Some(c) = command {
                env.push((CMD_ENV.into(), c.into()));
                args.extend([
                    "--login".into(),
                    "-i".into(),
                    "-c".into(),
                    format!("eval \"${CMD_ENV}\"; unset {CMD_ENV}; exec bash --login -i"),
                ]);
            } else if args.is_empty() {
                args.extend(["--login".into(), "-i".into()]);
            }
        }
        ShellKind::Wsl => {
            // wsl.exe starts the default distribution; a folder inside another one needs `-d`.
            let picks_distro = args.iter().any(|a| matches!(a.as_str(), "-d" | "--distribution" | "--distribution-id"));
            if let Some(distro) = wsl_distro(cwd).filter(|_| !picks_distro) {
                args.push("-d".into());
                args.push(distro);
            }
            // `--cd` understands Windows paths and translates them.
            args.push("--cd".into());
            args.push(cwd.into());
            let mut wslenv: Vec<&str> = Vec::new();
            if integration {
                env.push(("PROMPT_COMMAND".into(), WSL_INTEGRATION.into()));
                wslenv.push("PROMPT_COMMAND/u");
            }
            if let Some(c) = command {
                env.push((CMD_ENV.into(), c.into()));
                wslenv.push("SHELLMAN_CMD/u");
                args.extend([
                    "-e".into(),
                    "bash".into(),
                    "-lic".into(),
                    format!("eval \"${CMD_ENV}\"; unset {CMD_ENV}; exec bash -li"),
                ]);
            }
            if !wslenv.is_empty() {
                env.push(("WSLENV".into(), with_wslenv(&wslenv)));
            }
        }
        ShellKind::Other => {
            typed_input = command.map(|c| format!("{c}\r"));
        }
    }

    Launch {
        program: profile.path.clone(),
        args,
        env,
        typed_input,
    }
}

/// The distribution a folder inside WSL belongs to: `Ubuntu` for `\\wsl.localhost\Ubuntu\home`
/// (or `\\wsl$\Ubuntu\…`). None for other folders and for names that could pass as an option.
pub fn wsl_distro(path: &str) -> Option<String> {
    let path = path.trim().replace('/', "\\");
    let lower = path.to_ascii_lowercase();
    let start = [r"\\wsl.localhost\", r"\\wsl$\"].iter().find(|p| lower.starts_with(*p))?.len();
    let name = path[start..].split('\\').next()?;
    let valid = !name.is_empty()
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    valid.then(|| name.to_string())
}

/// WSLENV with `names` added to what is set already, so those variables reach Linux.
pub(crate) fn with_wslenv(names: &[&str]) -> String {
    let mut value = names.join(":");
    if let Ok(existing) = std::env::var("WSLENV") {
        if !existing.is_empty() {
            value = format!("{existing}:{value}");
        }
    }
    value
}

pub(crate) fn wsl_exe() -> PathBuf {
    system_root().join("System32").join("wsl.exe")
}

/// A folder inside WSL, and how paths are written on each side.
#[derive(Debug, PartialEq, Clone)]
pub(crate) struct WslFolder {
    pub distro: String,
    /// The distribution's share as the folder writes it: `\\wsl.localhost\Ubuntu`.
    share: String,
    /// The folder as Linux sees it: `/home/me/project`.
    pub linux: String,
}

impl WslFolder {
    pub fn of(path: &str) -> Option<WslFolder> {
        let distro = wsl_distro(path)?;
        let path = path.trim().replace('/', "\\");
        // "", "", "wsl.localhost", "Ubuntu", then the Linux path.
        let parts: Vec<&str> = path.split('\\').collect();
        let rest: Vec<&str> = parts[4..].iter().copied().filter(|p| !p.is_empty()).collect();
        Some(WslFolder { distro, share: parts[..4].join("\\"), linux: format!("/{}", rest.join("/")) })
    }

    /// A path Linux printed, as Windows writes it: `/home/me` is `\\wsl.localhost\Ubuntu\home\me`,
    /// `/mnt/c/x` is `C:\x`.
    pub fn windows_path(&self, linux: &str) -> String {
        if let Some(rest) = linux.strip_prefix("/mnt/") {
            let (drive, tail) = rest.split_once('/').unwrap_or((rest, ""));
            if drive.len() == 1 && drive.chars().all(|c| c.is_ascii_alphabetic()) {
                return format!("{}:\\{}", drive.to_ascii_uppercase(), tail.replace('/', "\\"));
            }
        }
        if linux.starts_with('/') {
            format!("{}{}", self.share, linux.replace('/', "\\"))
        } else {
            linux.replace('/', "\\")
        }
    }

    /// A Windows path as Linux sees it; None where Linux can't reach it (another distribution, a
    /// network share).
    pub fn linux_path(&self, windows: &str) -> Option<String> {
        if let Some(other) = WslFolder::of(windows) {
            return other.distro.eq_ignore_ascii_case(&self.distro).then_some(other.linux);
        }
        let w = windows.trim().replace('/', "\\");
        let b = w.as_bytes();
        if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' || (b.len() > 2 && b[2] != b'\\') {
            return None;
        }
        let rest = w[2..].trim_matches('\\').replace('\\', "/");
        let drive = (b[0] as char).to_ascii_lowercase();
        Some(if rest.is_empty() { format!("/mnt/{drive}") } else { format!("/mnt/{drive}/{rest}") })
    }
}

/// The Linux home folder of a WSL shell as a Windows path (`\\wsl.localhost\Ubuntu\home\me`),
/// so the folder picker can start there. Starts WSL when it isn't running, which takes a while.
pub fn wsl_home(profile: &ShellProfile) -> Result<String, String> {
    let mut cmd = std::process::Command::new(&profile.path);
    cmd.args(&profile.args).args(["--cd", "~", "-e", "wslpath", "-w", "."]);
    // wsl.exe writes its own messages in UTF-16 unless asked for UTF-8.
    cmd.env("WSL_UTF8", "1");
    let out = crate::proc::output_within(cmd, std::time::Duration::from_secs(60))?
        .ok_or("WSL did not start within a minute")?;
    let text = |b: &[u8]| String::from_utf8_lossy(b).replace('\0', "").trim().to_string();
    let home = text(&out.stdout);
    if out.status.success() && home.starts_with(r"\\") {
        return Ok(home);
    }
    let err = text(&out.stderr);
    Err(if !err.is_empty() {
        err
    } else if !home.is_empty() {
        home
    } else {
        "WSL did not report its home folder".into()
    })
}

pub(crate) fn find_on_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

fn git_bash() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(git) = find_on_path("git.exe") {
        // <Git>\cmd\git.exe or <Git>\bin\git.exe  ->  <Git>\bin\bash.exe
        if let Some(root) = git.parent().and_then(Path::parent) {
            candidates.push(root.join("bin").join("bash.exe"));
        }
    }
    for var in ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let base = PathBuf::from(base);
            candidates.push(base.join("Git").join("bin").join("bash.exe"));
            candidates.push(base.join("Programs").join("Git").join("bin").join("bash.exe"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn profile(id: &str, name: &str, path: PathBuf, kind: ShellKind) -> ShellProfile {
    ShellProfile {
        id: id.into(),
        name: name.into(),
        path: path.to_string_lossy().into_owned(),
        args: Vec::new(),
        kind,
    }
}

/// Lists the shells installed on this machine, most preferred first.
pub fn detect_shells() -> Vec<ShellProfile> {
    let mut shells = Vec::new();
    let root = system_root();

    let pwsh = find_on_path("pwsh.exe").or_else(|| {
        std::env::var_os("ProgramFiles")
            .map(|p| PathBuf::from(p).join("PowerShell").join("7").join("pwsh.exe"))
            .filter(|p| p.is_file())
    });
    if let Some(p) = pwsh {
        shells.push(profile("pwsh", "PowerShell 7", p, ShellKind::Powershell));
    }

    let winps = root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if winps.is_file() {
        shells.push(profile("powershell", "Windows PowerShell", winps, ShellKind::Powershell));
    }

    let cmd = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(|| root.join("System32").join("cmd.exe"));
    if cmd.is_file() {
        shells.push(profile("cmd", "Command Prompt", cmd, ShellKind::Cmd));
    }

    if let Some(bash) = git_bash() {
        shells.push(profile("gitbash", "Git Bash", bash, ShellKind::Bash));
    }

    let wsl = wsl_exe();
    if wsl.is_file() {
        shells.push(profile("wsl", "WSL", wsl, ShellKind::Wsl));
    }

    shells
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(kind: ShellKind) -> ShellProfile {
        ShellProfile {
            id: "x".into(),
            name: "x".into(),
            path: "shell.exe".into(),
            args: Vec::new(),
            kind,
        }
    }

    fn decode_ps(b64: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn powershell_plain_has_no_encoded_command() {
        let l = build_launch(&p(ShellKind::Powershell), "C:\\", None, false);
        assert_eq!(l.args, vec!["-NoLogo"]);
        assert!(l.env.is_empty());
    }

    #[test]
    fn powershell_command_roundtrips_through_encoding() {
        let cmd = r#"claude --model "opus" 'x' $env:FOO; echo "ä€""#;
        let l = build_launch(&p(ShellKind::Powershell), "C:\\", Some(cmd), false);
        assert_eq!(&l.args[..3], &["-NoLogo", "-NoExit", "-EncodedCommand"]);
        assert_eq!(decode_ps(&l.args[3]), format!("{cmd}\n"));
    }

    #[test]
    fn powershell_integration_precedes_command() {
        let l = build_launch(&p(ShellKind::Powershell), "C:\\", Some("claude"), true);
        let script = decode_ps(l.args.last().unwrap());
        assert!(script.starts_with("$global:__ShellmanPrompt"));
        assert!(script.ends_with("\nclaude\n"));
    }

    #[test]
    fn powershell_does_not_duplicate_nologo() {
        let mut prof = p(ShellKind::Powershell);
        prof.args = vec!["-nologo".into()];
        let l = build_launch(&prof, "C:\\", None, false);
        assert_eq!(l.args, vec!["-nologo"]);
    }

    #[test]
    fn whitespace_command_is_ignored() {
        let l = build_launch(&p(ShellKind::Cmd), "C:\\", Some("   "), false);
        assert!(l.args.is_empty());
        assert!(l.env.is_empty());
    }

    #[test]
    fn cmd_passes_command_through_env() {
        let l = build_launch(&p(ShellKind::Cmd), "C:\\", Some("dir \"a b\" && echo hi"), true);
        assert_eq!(l.args, vec!["/K", "%SHELLMAN_CMD%"]);
        assert!(l.env.contains(&(CMD_ENV.into(), "dir \"a b\" && echo hi".into())));
        assert!(l.env.iter().any(|(k, v)| k == "PROMPT" && v.contains("]9;9;")));
    }

    #[test]
    fn bash_defaults_to_login_interactive() {
        let l = build_launch(&p(ShellKind::Bash), "C:\\", None, false);
        assert_eq!(l.args, vec!["--login", "-i"]);
    }

    #[test]
    fn bash_command_evals_env_then_execs_shell() {
        let l = build_launch(&p(ShellKind::Bash), "C:\\", Some("claude"), true);
        assert_eq!(l.args[..3], ["--login", "-i", "-c"]);
        assert!(l.args[3].starts_with("eval \"$SHELLMAN_CMD\""));
        assert!(l.args[3].ends_with("exec bash --login -i"));
        assert!(l.env.iter().any(|(k, _)| k == "PROMPT_COMMAND"));
    }

    #[test]
    fn wsl_uses_cd_and_forwards_env() {
        let l = build_launch(&p(ShellKind::Wsl), "C:\\Projects\\x", Some("ls"), true);
        assert_eq!(l.args[..2], ["--cd", "C:\\Projects\\x"]);
        assert!(l.args.contains(&"-lic".to_string()));
        let wslenv = &l.env.iter().find(|(k, _)| k == "WSLENV").unwrap().1;
        assert!(wslenv.ends_with("PROMPT_COMMAND/u:SHELLMAN_CMD/u"));
    }

    #[test]
    fn wsl_folder_picks_its_distribution() {
        let l = build_launch(&p(ShellKind::Wsl), r"\\wsl.localhost\Debian\home\me", None, false);
        assert_eq!(l.args, ["-d", "Debian", "--cd", r"\\wsl.localhost\Debian\home\me"]);
        let l = build_launch(&p(ShellKind::Wsl), r"\\wsl$\Ubuntu-22.04", None, false);
        assert_eq!(l.args[..2], ["-d", "Ubuntu-22.04"]);
        // A Windows folder opens in the default distribution.
        let l = build_launch(&p(ShellKind::Wsl), "C:\\Projects\\x", None, false);
        assert_eq!(l.args[0], "--cd");
        // A profile that names its distribution keeps it.
        let mut prof = p(ShellKind::Wsl);
        prof.args = vec!["-d".into(), "Ubuntu".into()];
        let l = build_launch(&prof, r"\\wsl.localhost\Debian\home", None, false);
        assert_eq!(l.args[..3], ["-d", "Ubuntu", "--cd"]);
    }

    #[test]
    fn wsl_distro_from_path() {
        assert_eq!(wsl_distro(r"\\WSL.localhost\Ubuntu\home\me").as_deref(), Some("Ubuntu"));
        assert_eq!(wsl_distro("//wsl$/docker-desktop/tmp").as_deref(), Some("docker-desktop"));
        assert_eq!(wsl_distro(r"\\wsl.localhost\Ubuntu").as_deref(), Some("Ubuntu"));
        assert_eq!(wsl_distro(r"\\wsl.localhost\-e\x"), None);
        assert_eq!(wsl_distro(r"\\wsl.localhost\a b\x"), None);
        assert_eq!(wsl_distro(r"\\wsl.localhost\"), None);
        assert_eq!(wsl_distro(r"\\server\share"), None);
        assert_eq!(wsl_distro("C:\\Projects"), None);
    }

    #[test]
    fn wsl_paths_both_ways() {
        let f = WslFolder::of(r"\\wsl.localhost\Ubuntu\home\me\my project\").unwrap();
        assert_eq!((f.distro.as_str(), f.linux.as_str()), ("Ubuntu", "/home/me/my project"));
        assert_eq!(WslFolder::of("//wsl$/Debian").unwrap().linux, "/");
        assert_eq!(WslFolder::of(r"C:\Projects"), None);

        assert_eq!(f.windows_path("/home/me/wt/fix"), r"\\wsl.localhost\Ubuntu\home\me\wt\fix");
        assert_eq!(WslFolder::of(r"\\wsl$\Ubuntu\x").unwrap().windows_path("/tmp"), r"\\wsl$\Ubuntu\tmp");
        assert_eq!(f.windows_path("/mnt/c/Projects/shop"), r"C:\Projects\shop");
        assert_eq!(f.windows_path("/mnt/d"), r"D:\");
        assert_eq!(f.windows_path("/mnt/wsl/x"), r"\\wsl.localhost\Ubuntu\mnt\wsl\x");
        assert_eq!(f.windows_path(".git/rebase-merge"), r".git\rebase-merge");

        assert_eq!(f.linux_path(r"\\WSL$\ubuntu\home\me\wt").as_deref(), Some("/home/me/wt"));
        assert_eq!(f.linux_path(r"C:\Projects\shop").as_deref(), Some("/mnt/c/Projects/shop"));
        assert_eq!(f.linux_path("D:/").as_deref(), Some("/mnt/d"));
        assert_eq!(f.linux_path(r"\\wsl.localhost\Debian\home"), None);
        assert_eq!(f.linux_path(r"\\server\share\x"), None);
        assert_eq!(f.linux_path(r"C:relative"), None);
    }

    #[test]
    fn wsl_home_is_a_windows_path_or_a_readable_error() {
        let Some(wsl) = detect_shells().into_iter().find(|s| s.kind == ShellKind::Wsl) else { return };
        match wsl_home(&wsl) {
            Ok(home) => assert!(wsl_distro(&home).is_some(), "{home}"),
            // No distribution installed: wsl.exe's message, not UTF-16 noise.
            Err(e) => assert!(!e.is_empty() && !e.contains('\0'), "{e:?}"),
        }
    }

    #[test]
    fn other_shell_types_command() {
        let l = build_launch(&p(ShellKind::Other), "C:\\", Some("ssh host"), true);
        assert!(l.args.is_empty());
        assert_eq!(l.typed_input.as_deref(), Some("ssh host\r"));
    }

    #[test]
    fn detects_at_least_cmd_on_windows() {
        let shells = detect_shells();
        assert!(shells.iter().any(|s| s.kind == ShellKind::Cmd));
    }
}
