//! Remote sessions through Windows' own clients: OpenSSH's `ssh.exe` and the optional Telnet
//! Client (`telnet.exe`). Shellman only starts the client in a pseudoconsole, so keys, agents
//! (the Windows ssh-agent or 1Password's), `~/.ssh/config` and `known_hosts` work exactly as in
//! any other terminal, and the clients are kept up to date by Windows.
//!
//! Arguments are passed as a list, never spliced into a command line. Host, user and jump host
//! must not start with `-`, and the destination follows `--`, so nothing typed or imported as a
//! host name can turn into an ssh option such as `-oProxyCommand=...`.
//!
//! A session can name the one key to use. Servers stop after `MaxAuthTries` (usually 6) offered
//! keys, so with many keys in an agent such as 1Password the right one may never be tried. The
//! chosen key's *public* half is written to a file and passed as `-i` with `IdentitiesOnly=yes`:
//! ssh then offers only that key, and the agent still does the signing.

use crate::shell::Launch;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    Ssh,
    Telnet,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub kind: ConnectionKind,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub identity_file: String,
    /// Public key (`type base64 [comment]`) of an agent key to use instead of `identity_file`.
    #[serde(default)]
    pub identity_key: String,
    /// Log in with a password (typed into ssh's prompt) and offer no keys at all, so a server
    /// doesn't give up after the agent's keys before asking for the password.
    #[serde(default)]
    pub password_auth: bool,
    /// Also allow algorithms OpenSSH turned off for being weak (ssh-rsa/SHA-1, DSA, SHA-1 key
    /// exchange, CBC ciphers), for old servers that offer nothing newer.
    #[serde(default)]
    pub legacy_algorithms: bool,
    #[serde(default)]
    pub jump_host: String,
    /// More ssh options, already split into arguments.
    #[serde(default)]
    pub extra_args: Vec<String>,
}

/// A host, user or jump host: no whitespace or control characters, and not an option.
fn check_word(what: &str, value: &str) -> Result<(), String> {
    if value.starts_with('-') || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("The {what} can't contain spaces or start with \"-\": {value}"));
    }
    Ok(())
}

fn check(c: &Connection) -> Result<(), String> {
    if c.host.is_empty() {
        return Err("No host given".into());
    }
    check_word("host", &c.host)?;
    if c.port == Some(0) {
        return Err("The port must be a number from 1 to 65535".into());
    }
    if c.kind == ConnectionKind::Ssh {
        if !c.user.is_empty() {
            check_word("user name", &c.user)?;
        }
        if !c.jump_host.is_empty() {
            check_word("jump host", &c.jump_host)?;
        }
        if c.identity_file.chars().any(char::is_control) {
            return Err("The key file path contains invalid characters".into());
        }
        if !c.identity_key.is_empty() && key_blob(&c.identity_key).is_none() {
            return Err("The chosen SSH key isn't a valid public key".into());
        }
    }
    Ok(())
}

/// "type base64" of a one-line public key, or None if it isn't one.
fn key_blob(key: &str) -> Option<String> {
    if key.chars().any(char::is_control) {
        return None;
    }
    let mut parts = key.split_whitespace();
    let (kind, blob) = (parts.next()?, parts.next()?);
    let kind_ok = kind.len() <= 64
        && (kind.starts_with("ssh-") || kind.starts_with("ecdsa-") || kind.starts_with("sk-"))
        && kind.chars().all(|c| c.is_ascii_alphanumeric() || "-@.".contains(c));
    let blob_ok = !blob.is_empty() && blob.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c));
    (kind_ok && blob_ok).then(|| format!("{kind} {blob}"))
}

/// A key the SSH agent holds (from `ssh-add -L`). 1Password puts the item's name in `comment`.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentKey {
    pub kind: String,
    pub comment: String,
    pub public_key: String,
}

pub fn parse_agent_keys(out: &str) -> Vec<AgentKey> {
    out.lines()
        .filter_map(|line| {
            let line = line.trim();
            let blob = key_blob(line)?;
            let kind = blob.split(' ').next().unwrap_or_default().to_string();
            let comment = line.splitn(3, char::is_whitespace).nth(2).unwrap_or("").trim().to_string();
            Some(AgentKey { kind, comment, public_key: line.to_string() })
        })
        .collect()
}

/// The keys the agent offers, listed with the `ssh-add.exe` next to the SSH client.
/// What the SSH agent pipe answered. `running` is false when no agent serves it (the Windows
/// ssh-agent service is disabled by default, and not everyone uses 1Password); ssh then simply
/// uses the key files in ~/.ssh.
#[derive(Serialize, Debug, PartialEq)]
pub struct AgentKeys {
    pub running: bool,
    pub keys: Vec<AgentKey>,
}

/// Reads `ssh-add -L`'s exit code and output.
fn agent_result(code: Option<i32>, stdout: &str, stderr: &str) -> Result<AgentKeys, String> {
    match code {
        Some(0) => Ok(AgentKeys { running: true, keys: parse_agent_keys(stdout) }),
        // "The agent has no identities."
        Some(1) => Ok(AgentKeys { running: true, keys: Vec::new() }),
        // "Error connecting to agent: No such file or directory"
        _ if stderr.contains("connecting to agent") || stderr.contains("Could not open a connection") => {
            Ok(AgentKeys { running: false, keys: Vec::new() })
        }
        _ => Err(if stderr.trim().is_empty() { "ssh-add failed".into() } else { stderr.trim().to_string() }),
    }
}

pub fn agent_keys(ssh_path: &str) -> Result<AgentKeys, String> {
    let ssh_add = ssh_client(ssh_path)?.with_file_name("ssh-add.exe");
    if !ssh_add.is_file() {
        return Err(format!("{} not found", ssh_add.display()));
    }
    let mut cmd = std::process::Command::new(&ssh_add);
    cmd.arg("-L");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("Could not run ssh-add: {e}"))?;
    agent_result(out.status.code(), &String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr))
}

/// 64-bit FNV-1a, for stable file names.
fn fnv1a(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

/// Writes the public key to `dir` (if it isn't there yet) and returns the file, for `ssh -i`.
pub fn public_key_file(dir: &Path, key: &str) -> Result<PathBuf, String> {
    let blob = key_blob(key).ok_or("The chosen SSH key isn't a valid public key")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let file = dir.join(format!("{:016x}.pub", fnv1a(&blob)));
    let content = format!("{}\n", key.trim());
    if std::fs::read_to_string(&file).ok().as_deref() != Some(content.as_str()) {
        std::fs::write(&file, content).map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    }
    Ok(file)
}

/// What "allow old algorithms" adds, per ssh option: (option, `ssh -Q` query, algorithms).
const LEGACY: [(&str, &str, &[&str]); 4] = [
    ("HostKeyAlgorithms", "HostKeyAlgorithms", &["ssh-rsa", "ssh-dss"]),
    ("PubkeyAcceptedAlgorithms", "PubkeyAcceptedAlgorithms", &["ssh-rsa", "ssh-dss"]),
    (
        "KexAlgorithms",
        "kex",
        &["diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1", "diffie-hellman-group1-sha1"],
    ),
    ("Ciphers", "cipher", &["aes128-cbc", "aes192-cbc", "aes256-cbc", "3des-cbc"]),
];

/// `-o Option=+old,...` for the old algorithms `supported` (an `ssh -Q` query) says the client
/// still has; newer clients refuse names they were built without. An empty answer keeps them all.
pub fn legacy_args(supported: impl Fn(&str) -> Vec<String>) -> Vec<String> {
    let mut args = Vec::new();
    for (option, query, wanted) in LEGACY {
        let have = supported(query);
        let list: Vec<&str> = wanted.iter().copied().filter(|a| have.is_empty() || have.iter().any(|h| h == a)).collect();
        if !list.is_empty() {
            args.extend(["-o".into(), format!("{option}=+{}", list.join(","))]);
        }
    }
    args
}

/// `ssh -Q <query>` for `client`, remembered per client.
fn ssh_query(client: &Path, query: &str) -> Vec<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, String), Vec<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = (client.to_path_buf(), query.to_string());
    if let Some(v) = cache.lock().unwrap().get(&key) {
        return v.clone();
    }
    let mut cmd = std::process::Command::new(client);
    cmd.args(["-Q", query]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let list: Vec<String> = cmd
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();
    cache.lock().unwrap().insert(key, list.clone());
    list
}

/// The launch for `c` with the client at `client`. `key_file` is the chosen agent key's public
/// key file (see `public_key_file`); it wins over `identity_file`. `legacy` is `legacy_args` for
/// this client, used when the connection allows old algorithms.
pub fn build_connection(c: &Connection, client: &Path, key_file: Option<&Path>, legacy: &[String]) -> Result<Launch, String> {
    check(c)?;
    let mut args: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();
    match c.kind {
        ConnectionKind::Ssh => {
            if let Some(port) = c.port {
                args.extend(["-p".into(), port.to_string()]);
            }
            if !c.user.is_empty() {
                args.extend(["-l".into(), c.user.clone()]);
            }
            let identity = key_file.map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| c.identity_file.clone());
            if c.password_auth {
                args.extend([
                    "-o".into(),
                    "PubkeyAuthentication=no".into(),
                    "-o".into(),
                    "PreferredAuthentications=keyboard-interactive,password".into(),
                ]);
            } else if !identity.is_empty() {
                // Only this key: other agent keys would use up the server's MaxAuthTries.
                args.extend(["-i".into(), identity, "-o".into(), "IdentitiesOnly=yes".into()]);
            }
            if c.legacy_algorithms {
                args.extend(legacy.iter().cloned());
            }
            if !c.jump_host.is_empty() {
                args.extend(["-J".into(), c.jump_host.clone()]);
            }
            args.extend(c.extra_args.iter().cloned());
            args.extend(["--".into(), c.host.clone()]);
            // What the remote side should expect from xterm.js.
            env.push(("TERM".into(), "xterm-256color".into()));
        }
        ConnectionKind::Telnet => {
            args.push(c.host.clone());
            if let Some(port) = c.port {
                args.push(port.to_string());
            }
        }
    }
    Ok(Launch {
        program: client.to_string_lossy().into_owned(),
        args,
        env,
        typed_input: None,
    })
}

fn system32() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
}

/// `custom` if set, otherwise Windows OpenSSH (the one that talks to the Windows agent pipe,
/// which 1Password's SSH agent also serves), otherwise any ssh.exe on PATH.
pub fn ssh_client(custom: &str) -> Result<PathBuf, String> {
    let custom = custom.trim();
    if !custom.is_empty() {
        let p = PathBuf::from(custom);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!("SSH client not found: {custom} (Settings → Connections)"))
        };
    }
    let builtin = system32().join("OpenSSH").join("ssh.exe");
    if builtin.is_file() {
        return Ok(builtin);
    }
    crate::shell::find_on_path("ssh.exe").ok_or_else(|| {
        "SSH client not found. Add the Windows feature \"OpenSSH Client\" (Settings → System → Optional features), \
         or set the path of ssh.exe in Shellman's Settings → Connections."
            .into()
    })
}

pub fn telnet_client() -> Result<PathBuf, String> {
    let p = system32().join("telnet.exe");
    if p.is_file() {
        Ok(p)
    } else {
        Err("The Windows Telnet Client isn't installed. Turn it on under \"Turn Windows features on or off\" → \
             Telnet Client, or run as administrator: dism /online /Enable-Feature /FeatureName:TelnetClient"
            .into())
    }
}

/// The launch for `c`, finding its client. `ssh_path` is the client from Settings ('' = default);
/// a chosen agent key's public key file is kept in `key_dir`.
pub fn launch(c: &Connection, ssh_path: &str, key_dir: &Path) -> Result<Launch, String> {
    let client = match c.kind {
        ConnectionKind::Ssh => ssh_client(ssh_path)?,
        ConnectionKind::Telnet => telnet_client()?,
    };
    let key_file = match c.kind {
        ConnectionKind::Ssh if !c.password_auth && !c.identity_key.is_empty() => Some(public_key_file(key_dir, &c.identity_key)?),
        _ => None,
    };
    let legacy = match c.kind {
        ConnectionKind::Ssh if c.legacy_algorithms => legacy_args(|q| ssh_query(&client, q)),
        _ => Vec::new(),
    };
    build_connection(c, &client, key_file.as_deref(), &legacy)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(host: &str) -> Connection {
        Connection {
            kind: ConnectionKind::Ssh,
            host: host.into(),
            port: None,
            user: String::new(),
            identity_file: String::new(),
            identity_key: String::new(),
            password_auth: false,
            legacy_algorithms: false,
            jump_host: String::new(),
            extra_args: Vec::new(),
        }
    }

    fn args(c: &Connection) -> Vec<String> {
        build_connection(c, Path::new("ssh.exe"), None, &[]).unwrap().args
    }

    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEexampleEXAMPLEexampleEXAMPLEexample0 Work laptop key";

    #[test]
    fn ssh_plain_host() {
        assert_eq!(args(&ssh("web1")), ["--", "web1"]);
    }

    #[test]
    fn ssh_all_fields_in_order() {
        let mut c = ssh("10.0.0.5");
        c.port = Some(2222);
        c.user = "bob".into();
        c.identity_file = r"C:\Users\me\.ssh\my key".into();
        c.jump_host = "me@bastion".into();
        c.extra_args = vec!["-A".into(), "-o".into(), "ServerAliveInterval=30".into()];
        assert_eq!(
            args(&c),
            [
                "-p",
                "2222",
                "-l",
                "bob",
                "-i",
                r"C:\Users\me\.ssh\my key",
                "-o",
                "IdentitiesOnly=yes",
                "-J",
                "me@bastion",
                "-A",
                "-o",
                "ServerAliveInterval=30",
                "--",
                "10.0.0.5"
            ]
        );
        let l = build_connection(&c, Path::new("ssh.exe"), None, &[]).unwrap();
        assert!(l.env.contains(&("TERM".into(), "xterm-256color".into())));
    }

    #[test]
    fn rejects_option_injection() {
        for bad in ["-oProxyCommand=calc", "web1 -v", "web\n1", ""] {
            assert!(build_connection(&ssh(bad), Path::new("ssh.exe"), None, &[]).is_err(), "host {bad:?}");
        }
        let mut c = ssh("web1");
        c.user = "-oProxyCommand=calc".into();
        assert!(build_connection(&c, Path::new("ssh.exe"), None, &[]).is_err());
        let mut c = ssh("web1");
        c.jump_host = "-oProxyCommand=calc".into();
        assert!(build_connection(&c, Path::new("ssh.exe"), None, &[]).is_err());
        let mut c = ssh("web1");
        c.port = Some(0);
        assert!(build_connection(&c, Path::new("ssh.exe"), None, &[]).is_err());
    }

    #[test]
    fn telnet_host_and_port_only() {
        let mut c = ssh("router");
        c.kind = ConnectionKind::Telnet;
        c.user = "ignored".into();
        c.extra_args = vec!["-x".into()];
        assert_eq!(args(&c), ["router"]);
        c.port = Some(2323);
        let l = build_connection(&c, Path::new("telnet.exe"), None, &[]).unwrap();
        assert_eq!(l.args, ["router", "2323"]);
        assert!(l.env.is_empty());
        c.host = "-a".into();
        assert!(build_connection(&c, Path::new("telnet.exe"), None, &[]).is_err());
    }

    #[test]
    fn chosen_agent_key_is_the_only_one_offered() {
        let dir = std::env::temp_dir().join(format!("shellman-keys-test-{}", std::process::id()));
        let mut c = ssh("web1");
        c.identity_file = r"C:\ignored".into();
        c.identity_key = KEY.into();
        let file = public_key_file(&dir, KEY).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{KEY}\n"));
        // Same key (even renamed in 1Password) -> same file.
        let renamed = KEY.replace("Work laptop key", "renamed");
        assert_eq!(public_key_file(&dir, &renamed).unwrap(), file);
        let l = build_connection(&c, Path::new("ssh.exe"), Some(&file), &[]).unwrap();
        assert_eq!(l.args, ["-i", &file.to_string_lossy(), "-o", "IdentitiesOnly=yes", "--", "web1"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn password_login_offers_no_keys() {
        let mut c = ssh("web1");
        c.user = "bob".into();
        c.identity_key = KEY.into();
        c.identity_file = r"C:\ignored".into();
        c.password_auth = true;
        let dir = std::env::temp_dir().join(format!("shellman-keys-pw-{}", std::process::id()));
        let l = launch(&c, "", &dir);
        // Without ssh.exe on the machine there is nothing to check.
        if let Ok(l) = l {
            assert!(!dir.exists(), "no key file is written for password logins");
            assert_eq!(
                l.args,
                [
                    "-l",
                    "bob",
                    "-o",
                    "PubkeyAuthentication=no",
                    "-o",
                    "PreferredAuthentications=keyboard-interactive,password",
                    "--",
                    "web1"
                ]
            );
        }
    }

    #[test]
    fn old_algorithms_only_when_allowed_and_supported() {
        // A client built without DSA and group1: those are left out.
        let have = |q: &str| -> Vec<String> {
            match q {
                "HostKeyAlgorithms" | "PubkeyAcceptedAlgorithms" => vec!["ssh-ed25519".into(), "ssh-rsa".into()],
                "kex" => vec!["diffie-hellman-group14-sha1".into(), "diffie-hellman-group-exchange-sha1".into()],
                _ => Vec::new(),
            }
        };
        let legacy = legacy_args(have);
        assert_eq!(
            legacy,
            [
                "-o",
                "HostKeyAlgorithms=+ssh-rsa",
                "-o",
                "PubkeyAcceptedAlgorithms=+ssh-rsa",
                "-o",
                "KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1",
                "-o",
                // The cipher query answered nothing: keep them all.
                "Ciphers=+aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc"
            ]
        );
        let mut c = ssh("old-box");
        assert_eq!(build_connection(&c, Path::new("ssh.exe"), None, &legacy).unwrap().args, ["--", "old-box"]);
        c.legacy_algorithms = true;
        let args = build_connection(&c, Path::new("ssh.exe"), None, &legacy).unwrap().args;
        assert_eq!(&args[..legacy.len()], &legacy[..]);
        assert_eq!(&args[legacy.len()..], ["--", "old-box"]);
    }

    /// The real Windows ssh.exe still has every old algorithm (OpenSSH 9.5).
    #[test]
    fn real_client_reports_old_algorithms() {
        let Ok(client) = ssh_client("") else { return };
        let legacy = legacy_args(|q| ssh_query(&client, q));
        assert!(legacy.iter().any(|a| a.starts_with("HostKeyAlgorithms=+ssh-rsa")), "{legacy:?}");
    }

    #[test]
    fn invalid_agent_keys_are_rejected() {
        let dir = std::env::temp_dir();
        for bad in ["", "ssh-ed25519", "ssh-ed25519 not*base64", "rm -rf /", "ssh-ed25519 AAAA\nssh-rsa BBBB", "-oProxyCommand=x AAAA"] {
            assert!(public_key_file(&dir, bad).is_err(), "{bad:?}");
        }
        let mut c = ssh("web1");
        c.identity_key = "ssh-ed25519 AAAA\nx".into();
        assert!(build_connection(&c, Path::new("ssh.exe"), None, &[]).is_err());
    }

    #[test]
    fn parses_ssh_add_output() {
        let out = format!("{KEY}\r\nssh-rsa AAAAB3Nza/+= Home desktop\r\nThe agent has no identities.\r\necdsa-sha2-nistp256 AAAAE2 \r\n");
        let keys = parse_agent_keys(&out);
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[0], AgentKey { kind: "ssh-ed25519".into(), comment: "Work laptop key".into(), public_key: KEY.into() });
        assert_eq!(keys[1].comment, "Home desktop");
        assert_eq!(keys[2].comment, "");
    }

    #[test]
    fn no_agent_is_not_an_error() {
        let none = AgentKeys { running: false, keys: Vec::new() };
        assert_eq!(agent_result(Some(2), "", "Error connecting to agent: No such file or directory\r\n"), Ok(none));
        assert_eq!(agent_result(Some(1), "The agent has no identities.\r\n", ""), Ok(AgentKeys { running: true, keys: Vec::new() }));
        let found = agent_result(Some(0), &format!("{KEY}\r\n"), "").unwrap();
        assert!(found.running && found.keys.len() == 1);
        assert_eq!(agent_result(Some(2), "", "something else broke"), Err("something else broke".into()));
    }

    /// The real ssh-add, pointed at a pipe nobody serves.
    #[test]
    fn real_ssh_add_without_an_agent() {
        let Ok(client) = ssh_client("") else { return };
        let out = std::process::Command::new(client.with_file_name("ssh-add.exe"))
            .arg("-L")
            .env("SSH_AUTH_SOCK", r"\\.\pipe\shellman-test-no-agent")
            .output()
            .unwrap();
        let r = agent_result(out.status.code(), &String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr));
        assert_eq!(r, Ok(AgentKeys { running: false, keys: Vec::new() }));
    }

    #[test]
    fn missing_custom_client_is_an_error() {
        assert!(ssh_client(r"C:\does\not\exist\ssh.exe").is_err());
    }
}
