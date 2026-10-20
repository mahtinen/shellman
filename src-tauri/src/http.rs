//! Runs the HTTP requests of request panes with Windows' own curl.exe (Schannel: the system's
//! certificate store), the way connect.rs runs ssh.exe.
//!
//! A request never becomes a command line: curl reads its options as a config file on stdin
//! (`curl --config -`), each value quoted by `quote`. Secret values are not in that text either.
//! They reach curl as environment variables that curl expands itself (`variable %NAME` plus the
//! `expand-` form of each option that uses `{{NAME}}`), and `op://` references are swapped for
//! the real values by 1Password's `op run`, so Shellman never sees them.

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use crate::proc::{no_window, Job};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// One request, as the request pane sends it. Variables that aren't secret are already filled in;
/// `{{NAME}}` left in a value refers to one of `secrets`.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    /// Basic authentication, `name:password`.
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub body: Body,
    #[serde(default = "yes")]
    pub follow_redirects: bool,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u32,
    #[serde(default)]
    pub insecure: bool,
    #[serde(default)]
    pub proxy: Proxy,
    /// Values from `.env` / `.env.local`; an `op://` reference is resolved by 1Password.
    #[serde(default)]
    pub secrets: Vec<Secret>,
    /// Requests with the same key share their cookies (e.g. a group and its environment).
    #[serde(default)]
    pub cookie_jar: Option<String>,
    /// curl.exe and op.exe from Settings ('' = the default ones).
    #[serde(default)]
    pub curl_path: String,
    #[serde(default)]
    pub op_path: String,
    /// The 1Password account to use when there are several ('' = 1Password's default).
    #[serde(default)]
    pub op_account: String,
    /// Bodies up to this size come back as text; larger ones stay in a file.
    #[serde(default = "default_max_body")]
    pub max_body_bytes: u64,
}

fn yes() -> bool {
    true
}
fn default_timeout() -> u32 {
    30
}
fn default_max_body() -> u64 {
    10 << 20
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Secret {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Body {
    #[default]
    None,
    /// JSON, XML or text, sent as it is (the pane sets Content-Type).
    Raw { text: String },
    /// application/x-www-form-urlencoded
    Form { fields: Vec<Field> },
    /// multipart/form-data; a part with `file` sends the file at `value`.
    Multipart { fields: Vec<Part> },
    /// The file's bytes as the body.
    File { path: String },
}

#[derive(Deserialize, Debug, Clone)]
pub struct Field {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Part {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub file: bool,
}

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Proxy {
    /// No proxy, even if HTTPS_PROXY is set.
    #[default]
    None,
    /// HTTPS_PROXY / HTTP_PROXY / NO_PROXY, as curl reads them.
    Environment,
    Custom { url: String },
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HttpResult {
    /// curl's exit code: 0 when a response arrived (whatever its status), else e.g. 6, 7, 28, 60.
    pub curl_exit: i32,
    /// Why there is no response ("Failed to connect to ...").
    pub error: Option<String>,
    pub status: u16,
    pub http_version: String,
    pub headers: Vec<Header>,
    /// The final URL; left out when the URL contained a secret.
    pub url: Option<String>,
    pub redirects: u32,
    pub remote_ip: String,
    pub timing: Timing,
    pub body: Option<String>,
    pub body_size: u64,
    pub body_kind: BodyKind,
    pub console: Console,
}

/// What ran, for the request pane's console: the command, the options curl read (secrets still
/// as `{{NAME}}`) and curl's own log of the exchange (with secret values hidden).
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Console {
    pub command: String,
    pub config: String,
    pub log: String,
}

/// The console log is cut off after this much.
const MAX_LOG: usize = 1 << 20;

/// Milliseconds from the start, as curl measures them (each includes the ones before).
#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub dns: f64,
    pub connect: f64,
    pub tls: f64,
    pub first_byte: f64,
    pub total: f64,
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub enum BodyKind {
    #[default]
    None,
    Text,
    /// Not text: only its size is returned; it can be saved with `save_body`.
    Binary,
    /// Over `max_body_bytes`: likewise.
    TooLarge,
}

/// One cookie of a cookie jar.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: String,
    pub secure: bool,
    pub http_only: bool,
    /// Unix time; 0 = until the session ends.
    pub expires: u64,
}

/// Separates `%{json}` from `%{header_json}` in curl's output.
const MARKER: &str = "@@SHELLMAN-HEADERS@@";

pub const CANCELLED: &str = "Cancelled";

/// Quotes a value for a curl config file. Escapes are curl's own; a backslash before any other
/// character would be dropped, so backslashes are always doubled.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x0b' => out.push_str("\\v"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// RFC 9110 token characters (methods and header names).
fn is_token(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// curl variable names; the same rule as environment variable names Shellman accepts.
fn is_var_name(s: &str) -> bool {
    let mut b = s.bytes();
    matches!(b.next(), Some(c) if c.is_ascii_alphabetic() || c == b'_')
        && s.len() <= 64
        && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Environment variables curl, op or Windows read (a proxy, a CA file, the TLS key log, where
/// programs are): a secret handed over under one of these names would change how curl runs.
/// variables.ts gives such secrets another name.
fn is_reserved_env(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    const EXACT: [&str; 19] = [
        "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "HOMEDRIVE", "HOMEPATH",
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "ALLUSERSPROFILE", "USERNAME", "USERDOMAIN",
    ];
    EXACT.contains(&n.as_str()) || n.starts_with("CURL_") || n.starts_with("OP_") || n.starts_with("SSL") || n.ends_with("_PROXY")
}

/// A line break in a header, URL or name would start a new header (or option) on the wire.
fn single_line(what: &str, s: &str) -> Result<(), String> {
    if s.chars().any(|c| matches!(c, '\r' | '\n' | '\0')) {
        Err(format!("{what} can't contain line breaks"))
    } else {
        Ok(())
    }
}

fn existing_file(what: &str, path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() || !p.is_file() {
        return Err(format!("{what} not found: {path}"));
    }
    if path.contains('"') {
        return Err(format!("{what} has an invalid name: {path}"));
    }
    Ok(())
}

/// The 1Password reference in `value`: spaces, quotes and invisible characters around it are
/// ignored (a reference pasted with its quotes still is one). The same rule as `opRef` in variables.ts.
fn op_ref(value: &str) -> Option<&str> {
    let v = value.trim_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '\u{feff}' | '\u{200b}'));
    v.get(..5).filter(|p| p.eq_ignore_ascii_case("op://")).map(|_| v)
}

fn is_op_ref(value: &str) -> bool {
    op_ref(value).is_some()
}

/// Writes curl options, switching an option to its `expand-` form when its value uses a secret.
struct Config<'a> {
    text: String,
    secrets: &'a [&'a str],
    /// Secrets handed over in base64 (see `in_base64`): curl decodes them where they are used.
    decoded: Vec<&'a str>,
}

impl Config<'_> {
    fn flag(&mut self, name: &str) {
        self.text.push_str(name);
        self.text.push('\n');
    }

    fn opt(&mut self, name: &str, value: &str) {
        let mut value = value.to_string();
        for n in &self.decoded {
            value = value.replace(&format!("{{{{{n}:"), &format!("{{{{{n}:64dec:")).replace(&format!("{{{{{n}}}}}"), &format!("{{{{{n}:64dec}}}}"));
        }
        let value = value.as_str();
        let expand = self.secrets.iter().any(|s| value.contains(&format!("{{{{{s}}}}}")) || value.contains(&format!("{{{{{s}:")));
        if expand {
            self.text.push_str("expand-");
        }
        self.text.push_str(name);
        self.text.push_str(" = ");
        self.text.push_str(&quote(value));
        self.text.push('\n');
    }
}

/// Percent-encodes a form field name (curl encodes only the value of `name=value`).
fn encode_name(name: &str) -> String {
    name.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// The curl config for `req`: the response body goes to `out`, cookies to and from `jar`.
pub fn build_config(req: &HttpRequest, out: &Path, jar: Option<&Path>) -> Result<String, String> {
    let method = req.method.trim().to_ascii_uppercase();
    if !is_token(&method) || method.len() > 20 {
        return Err(format!("Invalid method: {}", req.method));
    }
    let url = req.url.trim();
    single_line("The URL", url)?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || url.starts_with("{{")) {
        return Err("The URL must start with http:// or https://".into());
    }
    let mut names: Vec<&str> = Vec::new();
    for s in &req.secrets {
        if !is_var_name(&s.name) || is_reserved_env(&s.name) {
            return Err(format!("Invalid variable name: {}", s.name));
        }
        // Windows' environment doesn't tell `token` from `TOKEN`.
        if names.iter().any(|n| n.eq_ignore_ascii_case(&s.name)) {
            return Err(format!("Variable {} is given twice", s.name));
        }
        if s.value.contains('\0') {
            return Err(format!("Variable {} has an invalid value", s.name));
        }
        names.push(&s.name);
    }
    let decoded = req.secrets.iter().filter(|s| in_base64(&s.value)).map(|s| s.name.as_str()).collect();
    let mut c = Config { text: String::new(), secrets: &names, decoded };
    // verbose: curl's log of the exchange, for the console (stderr; the response goes to `out`).
    for flag in ["silent", "show-error", "compressed", "verbose"] {
        c.flag(flag);
    }
    // Only HTTP: a shared request file must not read local files (file://) or talk other protocols.
    c.opt("proto", "=http,https");
    c.opt("proto-redir", "=http,https");
    for name in &names {
        // "=" adds an empty default: Windows leaves empty environment variables out entirely.
        c.text.push_str(&format!("variable = {}\n", quote(&format!("%{name}="))));
    }
    // Whether a data or form option is written below (curl then sends POST by itself).
    let has_body = match &req.body {
        Body::None => false,
        Body::Form { fields } => !fields.is_empty(),
        Body::Multipart { fields } => !fields.is_empty(),
        Body::Raw { .. } | Body::File { .. } => true,
    };
    if method == "HEAD" {
        // `request = HEAD` would wait for a body that never comes.
        c.flag("head");
    } else if method != if has_body { "POST" } else { "GET" } {
        // Only a method curl wouldn't pick by itself (it warns about naming GET or POST).
        c.opt("request", &method);
    }
    c.opt("url", url);
    for h in &req.headers {
        let name = h.name.trim();
        if !is_token(name) {
            return Err(format!("Invalid header name: {}", h.name));
        }
        single_line(&format!("Header {name}"), &h.value)?;
        // "Name;" is curl's way to send a header with an empty value.
        if h.value.is_empty() {
            c.opt("header", &format!("{name};"));
        } else {
            c.opt("header", &format!("{name}: {}", h.value));
        }
    }
    if let Some(user) = &req.user {
        single_line("The user name", user)?;
        c.opt("user", user);
    }
    match &req.body {
        Body::None => {}
        Body::Raw { text } => {
            if text.contains('\0') {
                return Err("The body can't contain NUL characters; send binary data as a file".into());
            }
            // data-raw: unlike data-binary, a leading @ isn't a file name.
            c.opt("data-raw", text);
        }
        Body::Form { fields } => {
            for f in fields {
                if f.name.is_empty() {
                    return Err("A form field has no name".into());
                }
                c.opt("data-urlencode", &format!("{}={}", encode_name(&f.name), f.value));
            }
        }
        Body::Multipart { fields } => {
            for p in fields {
                if p.name.is_empty() || p.name.contains(['=', '"', ';']) {
                    return Err(format!("Invalid form field name: {}", p.name));
                }
                if p.file {
                    existing_file("File", &p.value)?;
                    c.opt("form", &format!("{}=@\"{}\"", p.name, p.value));
                } else {
                    c.opt("form-string", &format!("{}={}", p.name, p.value));
                }
            }
        }
        Body::File { path } => {
            existing_file("File", path)?;
            c.opt("data-binary", &format!("@{path}"));
        }
    }
    if req.follow_redirects {
        c.flag("location");
        c.opt("max-redirs", "10");
    }
    c.opt("max-time", &req.timeout_seconds.clamp(1, 3600).to_string());
    if req.insecure {
        c.flag("insecure");
    }
    match &req.proxy {
        Proxy::None => c.opt("noproxy", "*"),
        Proxy::Environment => {}
        Proxy::Custom { url } => {
            single_line("The proxy", url)?;
            c.opt("proxy", url.trim());
        }
    }
    if let Some(jar) = jar {
        let jar = jar.to_string_lossy();
        // `cookie` treats a value with '=' as cookies rather than a file name.
        if jar.contains('=') {
            return Err(format!("Unusable cookie file path: {jar}"));
        }
        c.opt("cookie", &jar);
        c.opt("cookie-jar", &jar);
    }
    c.opt("output", &out.to_string_lossy());
    c.opt("write-out", &format!("%{{json}}\n{MARKER}\n%{{header_json}}"));
    // curl reads no longer line from its config (10 MB in curl 8).
    if c.text.len() > MAX_CONFIG {
        return Err(format!("The request is larger than {} MB. Send a big body from a file (Body → File).", MAX_CONFIG >> 20));
    }
    Ok(c.text)
}

const MAX_CONFIG: usize = 8 << 20;

/// curl on Windows reads its environment in the ANSI code page, which can't hold every character:
/// such a secret is handed over in base64 and decoded by curl (`64dec`, curl 8.13).
fn in_base64(value: &str) -> bool {
    !is_op_ref(value) && !value.trim().is_ascii()
}

/// The value of a secret's environment variable for curl (or for op run to resolve).
fn env_value(value: &str) -> String {
    use base64::Engine;
    match op_ref(value) {
        Some(r) => r.to_string(),
        None if in_base64(value) => base64::engine::general_purpose::STANDARD.encode(value.trim()),
        None => value.trim().to_string(),
    }
}

/// `%{header_json}`'s object in its own order (serde_json's map would sort it).
struct OrderedHeaders(Vec<(String, Vec<String>)>);

impl<'de> Deserialize<'de> for OrderedHeaders {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = OrderedHeaders;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object of header lists")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<OrderedHeaders, A::Error> {
                let mut out = Vec::new();
                while let Some(entry) = map.next_entry::<String, Vec<String>>()? {
                    out.push(entry);
                }
                Ok(OrderedHeaders(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// What the response file holds, as text when it is text and not too large.
fn read_body(path: &Path, content_type: &str, max: u64) -> (Option<String>, u64, BodyKind) {
    let Ok(meta) = std::fs::metadata(path) else { return (None, 0, BodyKind::None) };
    let size = meta.len();
    if size == 0 {
        return (None, 0, BodyKind::None);
    }
    if size > max {
        return (None, size, BodyKind::TooLarge);
    }
    let Ok(bytes) = std::fs::read(path) else { return (None, size, BodyKind::None) };
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let ct = content_type.to_ascii_lowercase();
    let textual = ct.starts_with("text/") || ["json", "xml", "javascript", "html", "x-www-form-urlencoded"].iter().any(|t| ct.contains(t));
    match std::str::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => (Some(text.to_string()), size, BodyKind::Text),
        _ if textual => (Some(String::from_utf8_lossy(bytes).into_owned()), size, BodyKind::Text),
        _ => (None, size, BodyKind::Binary),
    }
}

/// Reads curl's output (`write-out` on stdout) into a result. Without it, curl never got to the
/// transfer (a bad option, a missing variable, or op failing), and stderr says why.
pub fn parse_output(stdout: &str, stderr: &str, code: Option<i32>, req: &HttpRequest, body_file: &Path) -> Result<HttpResult, String> {
    let Some((json, headers)) = stdout.split_once(MARKER) else {
        // The error lines, not the verbose log around them.
        let msg: Vec<&str> = stderr
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with(['*', '>', '<', '{', '}']) && !l.contains("try 'curl --help'"))
            .collect();
        let error = if msg.is_empty() {
            format!("curl failed (exit code {})", code.map_or("unknown".into(), |c| c.to_string()))
        } else {
            msg.join("\n")
        };
        return Ok(HttpResult { curl_exit: code.filter(|c| *c != 0).unwrap_or(-1), error: Some(error), ..Default::default() });
    };
    let info: Value = serde_json::from_str(json.trim()).map_err(|e| format!("Unexpected output from curl: {e}"))?;
    let num = |k: &str| info.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let text = |k: &str| info.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let headers: Vec<Header> = serde_json::from_str::<OrderedHeaders>(headers.trim())
        .map(|h| h.0)
        .unwrap_or_default()
        .into_iter()
        .flat_map(|(name, values)| values.into_iter().map(move |value| Header { name: name.clone(), value }))
        .collect();
    let curl_exit = info.get("exitcode").and_then(Value::as_i64).unwrap_or(code.unwrap_or(-1) as i64) as i32;
    let error = info.get("errormsg").and_then(Value::as_str).filter(|e| !e.is_empty()).map(str::to_string);
    let secret_in_url = req.secrets.iter().any(|s| req.url.contains(&format!("{{{{{}", s.name)));
    let url = Some(text("url_effective")).filter(|u| !u.is_empty() && !secret_in_url);
    let content_type = text("content_type");
    let (body, body_size, body_kind) = if req.method.eq_ignore_ascii_case("HEAD") {
        (None, 0, BodyKind::None)
    } else {
        read_body(body_file, &content_type, req.max_body_bytes)
    };
    let ms = |k: &str| (num(k) * 1000.0 * 1000.0).round() / 1000.0;
    Ok(HttpResult {
        curl_exit,
        error,
        status: num("http_code") as u16,
        http_version: text("http_version"),
        headers,
        url,
        redirects: num("num_redirects") as u32,
        remote_ip: text("remote_ip"),
        timing: Timing {
            dns: ms("time_namelookup"),
            connect: ms("time_connect"),
            tls: ms("time_appconnect"),
            first_byte: ms("time_starttransfer"),
            total: ms("time_total"),
        },
        body,
        body_size,
        body_kind,
        console: Console::default(),
    })
}

/// Hides secret values (the ones from .env files; op run hides its own) in curl's log.
fn mask(text: &str, req: &HttpRequest) -> String {
    if req.secrets.is_empty() {
        return text.to_string();
    }
    // The credentials of sent Authorization headers, whatever form a secret took in them (Basic is
    // base64 of user:password; 1Password's values are never known here).
    let mut out: String = text
        .split_inclusive('\n')
        .map(|line| {
            let Some(header) = line.strip_prefix("> ") else { return line.to_string() };
            let Some((name, value)) = header.split_once(':') else { return line.to_string() };
            if !(name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("proxy-authorization")) {
                return line.to_string();
            }
            let words: Vec<&str> = value.split_whitespace().collect();
            let scheme = if words.len() > 1 { format!("{} ", words[0]) } else { String::new() };
            let end = &line[line.trim_end_matches(['\r', '\n']).len()..];
            format!("> {name}: {scheme}••••••{end}")
        })
        .collect();
    for s in &req.secrets {
        let v = s.value.trim();
        // A very short value would hide every match of it, not the secret.
        if v.chars().count() >= 4 && !is_op_ref(v) {
            out = out.replace(v, "••••••").replace(&encode_name(v), "••••••");
        }
    }
    out
}

/// A command line as it would be typed, for the console (never run).
fn shown_command(cmd: &Command) -> String {
    let arg = |a: &std::ffi::OsStr| {
        let a = a.to_string_lossy();
        if a.contains(' ') { format!("\"{a}\"") } else { a.into_owned() }
    };
    std::iter::once(arg(cmd.get_program())).chain(cmd.get_args().map(arg)).collect::<Vec<_>>().join(" ")
}

/// Reads a Netscape cookie file (what curl's cookie jar writes).
pub fn parse_cookies(text: &str) -> Vec<Cookie> {
    text.lines()
        .filter_map(|line| {
            let (http_only, line) = match line.strip_prefix("#HttpOnly_") {
                Some(rest) => (true, rest),
                None if line.starts_with('#') => return None,
                None => (false, line),
            };
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 7 {
                return None;
            }
            Some(Cookie {
                domain: f[0].to_string(),
                path: f[2].to_string(),
                secure: f[3] == "TRUE",
                expires: f[4].parse().unwrap_or(0),
                name: f[5].to_string(),
                value: f[6..].join("\t"),
                http_only,
            })
        })
        .collect()
}

/// `custom` if set, otherwise Windows' curl (Schannel, the system's certificates), otherwise any on PATH.
pub fn curl_client(custom: &str) -> Result<PathBuf, String> {
    let custom = custom.trim();
    if !custom.is_empty() {
        let p = PathBuf::from(custom);
        return if p.is_file() { Ok(p) } else { Err(format!("curl not found: {custom} (Settings → Requests)")) };
    }
    let builtin = crate::connect::system32().join("curl.exe");
    if builtin.is_file() {
        return Ok(builtin);
    }
    crate::shell::find_on_path("curl.exe").ok_or_else(|| "curl.exe not found. It comes with Windows 10 (1803) and later.".into())
}

/// 1Password's CLI: `custom`, otherwise PATH, otherwise where WinGet links it.
pub fn op_client(custom: &str) -> Result<PathBuf, String> {
    let custom = custom.trim();
    if !custom.is_empty() {
        let p = PathBuf::from(custom);
        return if p.is_file() { Ok(p) } else { Err(format!("1Password CLI not found: {custom} (Settings → Requests)")) };
    }
    let winget = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"Microsoft\WinGet\Links\op.exe"));
    crate::shell::find_on_path("op.exe").or(winget.filter(|p| p.is_file())).ok_or_else(|| {
        "A variable refers to 1Password (op://), but the 1Password CLI isn't installed. Install it \
         (winget install AgileBits.1Password.CLI) and turn on Settings → Developer → \
         \"Integrate with 1Password CLI\" in the 1Password app."
            .into()
    })
}

/// A 1Password account signed in on this computer (`op account list`).
#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct OpAccount {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub account_uuid: String,
}

/// The 1Password accounts op knows (none when op is missing or fails).
pub fn op_accounts(custom: &str) -> Vec<OpAccount> {
    let Ok(op) = op_client(custom) else { return Vec::new() };
    let mut cmd = Command::new(op);
    cmd.args(["account", "list", "--format", "json"]);
    match crate::proc::output_within(cmd, Duration::from_secs(20)) {
        Ok(Some(out)) if out.status.success() => serde_json::from_slice(&out.stdout).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// op's error made actionable: with several accounts it can't ask which one without a terminal.
pub fn explain_op_error(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("account") && (lower.contains("multiple") || lower.contains("--account") || lower.contains("op_account")) {
        format!("{message}\n\nThere are several 1Password accounts on this computer: choose the one to use in Settings → Requests → 1Password account.")
    } else {
        message.to_string()
    }
}

/// curl's version (major, minor), remembered per program.
fn curl_version(curl: &Path) -> Option<(u32, u32)> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<(u32, u32)>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache.lock().unwrap().get(curl) {
        return *v;
    }
    let mut cmd = Command::new(curl);
    cmd.arg("--version");
    no_window(&mut cmd);
    let version = cmd.output().ok().and_then(|o| parse_version(&String::from_utf8_lossy(&o.stdout)));
    cache.lock().unwrap().insert(curl.to_path_buf(), version);
    version
}

/// "curl 8.21.0 (Windows) libcurl/..." → (8, 21)
fn parse_version(text: &str) -> Option<(u32, u32)> {
    let v = text.split_whitespace().nth(1)?;
    let mut parts = v.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// `%{header_json}` needs curl 7.83, secret variables (`--variable`) 8.3.
/// The curl version `req` needs: 8.3 for variables, 8.13 for `64dec`.
fn needed_version(req: &HttpRequest) -> (u32, u32) {
    if req.secrets.iter().any(|s| in_base64(&s.value)) {
        (8, 13)
    } else if !req.secrets.is_empty() {
        (8, 3)
    } else {
        (7, 83)
    }
}

fn check_version(version: Option<(u32, u32)>, need: (u32, u32)) -> Result<(), String> {
    let Some(v) = version else { return Ok(()) };
    if v < need {
        return Err(format!(
            "curl {}.{} is too old: Shellman needs {}.{} or newer. Update Windows, or choose a newer curl.exe in Settings → Requests.",
            v.0, v.1, need.0, need.1
        ));
    }
    Ok(())
}

struct Running {
    job: Job,
    cancelled: AtomicBool,
}

/// Requests in flight (for cancelling) and this run's response bodies and cookie jars.
pub struct HttpManager {
    running: Mutex<HashMap<u32, Arc<Running>>>,
    dir: PathBuf,
}

impl Default for HttpManager {
    fn default() -> Self {
        HttpManager::new(std::env::temp_dir().join(format!("shellman-http-{}", std::process::id())))
    }
}

/// Drops a finished request from the list of running ones.
struct Unregister<'a>(&'a HttpManager, u32);

impl Drop for Unregister<'_> {
    fn drop(&mut self) {
        self.0.running.lock().unwrap().remove(&self.1);
    }
}

impl HttpManager {
    pub fn new(dir: PathBuf) -> Self {
        HttpManager { running: Mutex::default(), dir }
    }

    fn body_file(&self, id: u32) -> PathBuf {
        self.dir.join(format!("{id}.body"))
    }

    fn jar_file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("cookies-{:016x}.txt", crate::connect::fnv1a(key)))
    }

    /// Sends `req`; `id` (chosen by the frontend) is for `cancel` and the body file.
    pub fn send(&self, id: u32, req: &HttpRequest) -> Result<HttpResult, String> {
        let curl = curl_client(&req.curl_path)?;
        check_version(curl_version(&curl), needed_version(req))?;
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("Could not create {}: {e}", self.dir.display()))?;
        let out = self.body_file(id);
        let _ = std::fs::remove_file(&out);
        let jar = req.cookie_jar.as_deref().map(|k| self.jar_file(k));
        // An empty jar to start with: curl warns about one it can't open.
        if let Some(j) = &jar {
            if !j.exists() {
                let _ = std::fs::write(j, "");
            }
        }
        let config = build_config(req, &out, jar.as_deref())?;
        let uses_op = req.secrets.iter().any(|s| is_op_ref(&s.value));
        let mut cmd = if uses_op {
            let mut cmd = Command::new(op_client(&req.op_path)?);
            cmd.arg("run");
            // With several accounts op would ask which one, and there is no terminal to ask in.
            let account = req.op_account.trim();
            if !account.is_empty() {
                if account.starts_with('-') || account.chars().any(|c| c.is_whitespace() || c.is_control()) {
                    return Err(format!("Invalid 1Password account: {account}"));
                }
                cmd.args(["--account", account]);
            }
            cmd.arg("--").arg(&curl);
            cmd
        } else {
            Command::new(&curl)
        };
        // -q first: no personal .curlrc changes what a shared request does.
        cmd.args(["-q", "--config", "-"]);
        for s in &req.secrets {
            cmd.env(&s.name, env_value(&s.value));
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        no_window(&mut cmd);

        let console = Console { command: shown_command(&cmd), config: config.clone(), log: String::new() };
        let job = Job::new().ok_or("Could not start the request")?;
        let running = Arc::new(Running { job, cancelled: AtomicBool::new(false) });
        {
            let mut map = self.running.lock().unwrap();
            if map.contains_key(&id) {
                return Err("This request is already running".into());
            }
            map.insert(id, running.clone());
        }
        let _unregister = Unregister(self, id);
        let mut child = cmd.spawn().map_err(|e| format!("Could not run {}: {e}", curl.display()))?;
        if !running.job.assign(&child) {
            let _ = child.kill();
            return Err("Could not start the request".into());
        }
        // Written on its own thread: a large body must not block while curl's output pipes fill.
        if let Some(mut stdin) = child.stdin.take() {
            std::thread::spawn(move || {
                let _ = stdin.write_all(config.as_bytes());
            });
        }
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        // curl stops itself at max-time; this is for a curl or op that hangs. The first op run may
        // wait for Windows Hello.
        let grace = if uses_op { 120 } else { 15 };
        let limit = Duration::from_secs(u64::from(req.timeout_seconds.clamp(1, 3600)) + grace);
        let output = match rx.recv_timeout(limit) {
            Ok(r) => r,
            Err(_) => {
                running.job.kill();
                let _ = rx.recv();
                return Err("The request didn't finish in time and was stopped.".into());
            }
        }
        .map_err(|e| format!("Could not run curl: {e}"))?;
        if running.cancelled.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        let stderr = mask(&String::from_utf8_lossy(&output.stderr), req);
        let mut result = parse_output(&String::from_utf8_lossy(&output.stdout), &stderr, output.status.code(), req, &out)?;
        if uses_op {
            result.error = result.error.map(|e| explain_op_error(&e));
        }
        let mut log = stderr;
        if log.len() > MAX_LOG {
            let cut = (0..=MAX_LOG).rev().find(|&i| log.is_char_boundary(i)).unwrap_or(0);
            log.truncate(cut);
            log.push_str("\n… (cut off)");
        }
        result.console = Console { log, ..console };
        Ok(result)
    }

    pub fn cancel(&self, id: u32) {
        if let Some(r) = self.running.lock().unwrap().get(&id) {
            r.cancelled.store(true, Ordering::SeqCst);
            r.job.kill();
        }
    }

    /// Copies the response body of request `id` to `dest` ("Save response").
    pub fn save_body(&self, id: u32, dest: &Path) -> Result<(), String> {
        std::fs::copy(self.body_file(id), dest)
            .map(|_| ())
            .map_err(|e| format!("Could not save {}: {e}", dest.display()))
    }

    /// Forgets the response body of request `id`.
    pub fn discard(&self, id: u32) {
        let _ = std::fs::remove_file(self.body_file(id));
    }

    pub fn cookies(&self, key: &str) -> Vec<Cookie> {
        std::fs::read_to_string(self.jar_file(key)).map(|t| parse_cookies(&t)).unwrap_or_default()
    }

    pub fn clear_cookies(&self, key: &str) {
        let _ = std::fs::remove_file(self.jar_file(key));
    }

    /// Stops every request and removes this run's files (bodies, cookies).
    pub fn shutdown(&self) {
        for r in self.running.lock().unwrap().values() {
            r.job.kill();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Removes what earlier runs left behind if they ended without cleaning up (a crash, a kill).
pub fn remove_stale_dirs(alive: impl Fn(u32) -> bool) {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for e in entries.filter_map(Result::ok) {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_prefix("shellman-http-").and_then(|p| p.parse::<u32>().ok()) else { continue };
        if pid != std::process::id() && !alive(pid) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::net::{TcpListener, TcpStream};

    fn req(method: &str, url: &str) -> HttpRequest {
        serde_json::from_value(serde_json::json!({ "method": method, "url": url })).unwrap()
    }

    fn lines(text: &str) -> Vec<&str> {
        text.lines().collect()
    }

    #[test]
    fn quotes_config_values() {
        assert_eq!(quote(r#"a "b" C:\x"#), r#""a \"b\" C:\\x""#);
        assert_eq!(quote("1\n2\r\t"), r#""1\n2\r\t""#);
        assert_eq!(quote("äö {{x}}"), "\"äö {{x}}\"");
    }

    #[test]
    fn builds_a_post() {
        let mut r = req("post", "https://api.example.com/users");
        r.headers = vec![
            Header { name: "Content-Type".into(), value: "application/json".into() },
            Header { name: "X-Empty".into(), value: "".into() },
        ];
        r.body = Body::Raw { text: "{\"name\": \"@me\"}".into() };
        let c = build_config(&r, Path::new(r"C:\Temp\1.body"), None).unwrap();
        assert_eq!(
            lines(&c),
            [
                "silent",
                "show-error",
                "compressed",
                "verbose",
                r#"proto = "=http,https""#,
                r#"proto-redir = "=http,https""#,
                r#"url = "https://api.example.com/users""#,
                r#"header = "Content-Type: application/json""#,
                r#"header = "X-Empty;""#,
                r#"data-raw = "{\"name\": \"@me\"}""#,
                "location",
                r#"max-redirs = "10""#,
                r#"max-time = "30""#,
                r#"noproxy = "*""#,
                r#"output = "C:\\Temp\\1.body""#,
                r#"write-out = "%{json}\n@@SHELLMAN-HEADERS@@\n%{header_json}""#,
            ]
        );
    }

    #[test]
    fn finds_1password_references() {
        assert_eq!(op_ref("op://Vault/Item/field"), Some("op://Vault/Item/field"));
        assert_eq!(op_ref(" \"op://Vault/My item/field\" "), Some("op://Vault/My item/field"));
        assert_eq!(op_ref("\u{feff}'OP://Vault/Item/field'"), Some("OP://Vault/Item/field"));
        assert_eq!(op_ref("token op://x"), None);
        assert_eq!(op_ref("op:/"), None);
        assert_eq!(op_ref("ä"), None);
    }

    #[test]
    fn explains_op_account_errors() {
        let e = explain_op_error("[ERROR] multiple accounts found; use the --account flag or set the OP_ACCOUNT environment variable");
        assert!(e.contains("Settings → Requests → 1Password account"));
        assert_eq!(explain_op_error("[ERROR] could not find item"), "[ERROR] could not find item");
        let accounts: Vec<OpAccount> = serde_json::from_str(r#"[{"url":"example.1password.com","email":"me@example.com","user_uuid":"U1","account_uuid":"A1"}]"#).unwrap();
        assert_eq!(accounts[0], OpAccount { url: "example.1password.com".into(), email: "me@example.com".into(), account_uuid: "A1".into() });
    }

    #[test]
    fn names_only_methods_curl_would_not_pick() {
        let method = |m: &str, body: bool| {
            let mut r = req(m, "https://example.com/");
            if body {
                r.body = Body::Raw { text: "x".into() };
            }
            build_config(&r, Path::new("out"), None).unwrap().lines().find(|l| l.starts_with("request")).map(str::to_string)
        };
        assert_eq!(method("GET", false), None);
        assert_eq!(method("POST", true), None);
        assert_eq!(method("GET", true).as_deref(), Some(r#"request = "GET""#));
        assert_eq!(method("POST", false).as_deref(), Some(r#"request = "POST""#));
        assert_eq!(method("DELETE", false).as_deref(), Some(r#"request = "DELETE""#));
    }

    #[test]
    fn secrets_out_of_ascii_go_in_base64() {
        let mut r = req("GET", "https://example.com/?q={{PASS:url}}");
        r.headers = vec![Header { name: "X-Pass".into(), value: "{{PASS}}".into() }];
        r.secrets = vec![Secret { name: "PASS".into(), value: "pässwörd".into() }];
        let c = build_config(&r, Path::new("out"), None).unwrap();
        assert!(c.contains("expand-url = \"https://example.com/?q={{PASS:64dec:url}}\""), "{c}");
        assert!(c.contains("expand-header = \"X-Pass: {{PASS:64dec}}\""), "{c}");
        assert_eq!(env_value(" pässwörd "), "cMOkc3N3w7ZyZA==");
        assert_eq!(env_value("plain"), "plain");
        assert_eq!(env_value("\"op://Vault/Item/field\""), "op://Vault/Item/field");
    }

    #[test]
    fn empty_forms_are_not_posts() {
        // No field, no data option: curl would send GET, so POST must be named.
        let mut r = req("POST", "https://example.com");
        r.body = Body::Form { fields: vec![] };
        assert!(lines(&build_config(&r, Path::new("out"), None).unwrap()).contains(&"request = \"POST\""));
        r.body = Body::Raw { text: "x".repeat(MAX_CONFIG) };
        assert!(build_config(&r, Path::new("out"), None).unwrap_err().contains("from a file"));
    }

    #[test]
    fn masks_secrets_in_the_log() {
        let mut r = req("GET", "https://example.com");
        let log = "> GET /?k=a%2Fb%3Dc HTTP/1.1\r\n> Authorization: Basic dXNlcjpwYXNz\r\n> X-Key: a/b=c\r\n< HTTP/1.1 200 OK\r\n> Proxy-Authorization: token\n";
        assert_eq!(mask(log, &r), log, "nothing secret, nothing hidden");
        r.secrets = vec![Secret { name: "K".into(), value: "a/b=c".into() }, Secret { name: "S".into(), value: "1".into() }];
        assert_eq!(
            mask(log, &r),
            "> GET /?k=•••••• HTTP/1.1\r\n> Authorization: Basic ••••••\r\n> X-Key: ••••••\r\n< HTTP/1.1 200 OK\r\n> Proxy-Authorization: ••••••\n"
        );
    }

    #[test]
    fn secrets_are_expanded_by_curl_not_written() {
        let mut r = req("GET", "https://api.example.com/x?key={{API_KEY}}");
        r.headers = vec![Header { name: "Authorization".into(), value: "Bearer {{API_TOKEN}}".into() }];
        r.user = Some("me:{{PASSWORD:url}}".into());
        r.secrets = vec![
            Secret { name: "API_TOKEN".into(), value: "s3cret".into() },
            Secret { name: "API_KEY".into(), value: "op://Example Vault/Example API/credential".into() },
            Secret { name: "PASSWORD".into(), value: "hunter2".into() },
        ];
        let c = build_config(&r, Path::new("out"), None).unwrap();
        assert!(c.contains("variable = \"%API_TOKEN=\"\nvariable = \"%API_KEY=\"\nvariable = \"%PASSWORD=\"\n"));
        assert!(c.contains(r#"expand-url = "https://api.example.com/x?key={{API_KEY}}""#));
        assert!(c.contains(r#"expand-header = "Authorization: Bearer {{API_TOKEN}}""#));
        assert!(c.contains(r#"expand-user = "me:{{PASSWORD:url}}""#));
        assert!(!c.contains("s3cret") && !c.contains("hunter2") && !c.contains("op://"));
    }

    #[test]
    fn rejects_injection() {
        let bad = |f: &dyn Fn(&mut HttpRequest)| {
            let mut r = req("GET", "https://example.com/");
            f(&mut r);
            build_config(&r, Path::new("out"), None).unwrap_err()
        };
        bad(&|r| r.method = "GET /x".into());
        bad(&|r| r.url = "https://example.com/\r\nX: y".into());
        bad(&|r| r.url = "file:///C:/Windows/win.ini".into());
        bad(&|r| r.headers = vec![Header { name: "X: y".into(), value: "z".into() }]);
        bad(&|r| r.headers = vec![Header { name: "X".into(), value: "a\nInjected: 1".into() }]);
        bad(&|r| r.secrets = vec![Secret { name: "BAD-NAME".into(), value: "x".into() }]);
        bad(&|r| r.secrets = vec![Secret { name: "A".into(), value: "1".into() }, Secret { name: "A".into(), value: "2".into() }]);
        bad(&|r| r.secrets = vec![Secret { name: "a".into(), value: "1".into() }, Secret { name: "A".into(), value: "2".into() }]);
        for name in ["PATH", "Https_Proxy", "SSLKEYLOGFILE", "CURL_CA_BUNDLE", "OP_ACCOUNT"] {
            bad(&|r| r.secrets = vec![Secret { name: name.into(), value: "x".into() }]);
        }
        bad(&|r| r.body = Body::Raw { text: "a\0b".into() });
        bad(&|r| r.body = Body::File { path: r"C:\no\such\file.bin".into() });
        bad(&|r| r.body = Body::Multipart { fields: vec![Part { name: "a=b".into(), value: "x".into(), file: false }] });
    }

    #[test]
    fn form_and_multipart_bodies() {
        let mut r = req("POST", "https://example.com/");
        r.body = Body::Form { fields: vec![Field { name: "a b".into(), value: "1&2".into() }] };
        assert!(build_config(&r, Path::new("out"), None).unwrap().contains(r#"data-urlencode = "a%20b=1&2""#));
        let file = std::env::current_exe().unwrap();
        r.body = Body::Multipart {
            fields: vec![
                Part { name: "note".into(), value: "@not-a-file".into(), file: false },
                Part { name: "upload".into(), value: file.to_string_lossy().into(), file: true },
            ],
        };
        let c = build_config(&r, Path::new("out"), None).unwrap();
        assert!(c.contains(r#"form-string = "note=@not-a-file""#));
        assert!(c.contains(&format!("form = {}", quote(&format!("upload=@\"{}\"", file.display())))));
    }

    #[test]
    fn options_and_proxies() {
        let mut r = req("HEAD", "https://example.com/");
        r.follow_redirects = false;
        r.insecure = true;
        r.timeout_seconds = 0;
        r.proxy = Proxy::Custom { url: "http://proxy.example.com:8080".into() };
        let c = build_config(&r, Path::new("out"), Some(Path::new(r"C:\Temp\jar.txt"))).unwrap();
        assert!(c.contains("\nhead\n") && !c.contains("request ="));
        assert!(!c.contains("location") && c.contains("\ninsecure\n"));
        assert!(c.contains(r#"max-time = "1""#));
        assert!(c.contains(r#"proxy = "http://proxy.example.com:8080""#) && !c.contains("noproxy"));
        assert!(c.contains(r#"cookie = "C:\\Temp\\jar.txt""#) && c.contains(r#"cookie-jar = "C:\\Temp\\jar.txt""#));
        r.proxy = Proxy::Environment;
        assert!(!build_config(&r, Path::new("out"), None).unwrap().contains("proxy"));
    }

    const SAMPLE_JSON: &str = r#"{"http_code":201,"http_version":"2","exitcode":0,"errormsg":null,"num_redirects":1,"remote_ip":"203.0.113.5","content_type":"application/json","url_effective":"https://api.example.com/users?key=s3cret","time_namelookup":0.004,"time_connect":0.0221,"time_appconnect":0.0532,"time_starttransfer":0.1651,"time_total":0.171}"#;

    #[test]
    fn reads_curl_output() {
        let stdout = format!("{SAMPLE_JSON}\n{MARKER}\n{{\"content-type\":[\"application/json\"],\n\"x-b\":[\"2\"],\n\"set-cookie\":[\"a=1\",\"b=2\"]\n}}");
        let mut r = req("POST", "https://api.example.com/users");
        let res = parse_output(&stdout, "", Some(0), &r, Path::new("missing.body")).unwrap();
        assert_eq!(res.status, 201);
        assert_eq!(res.http_version, "2");
        assert_eq!(res.redirects, 1);
        assert_eq!(res.timing, Timing { dns: 4.0, connect: 22.1, tls: 53.2, first_byte: 165.1, total: 171.0 });
        let names: Vec<&str> = res.headers.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["content-type", "x-b", "set-cookie", "set-cookie"]);
        assert_eq!(res.url.as_deref(), Some("https://api.example.com/users?key=s3cret"));
        assert_eq!(res.body_kind, BodyKind::None);

        r.url = "https://api.example.com/users?key={{KEY}}".into();
        r.secrets = vec![Secret { name: "KEY".into(), value: "s3cret".into() }];
        assert_eq!(parse_output(&stdout, "", Some(0), &r, Path::new("x")).unwrap().url, None);
    }

    #[test]
    fn explains_when_curl_did_not_run() {
        let r = req("GET", "https://example.com/");
        let res = parse_output(
            "",
            "* verbose line\ncurl: Variable 'X' import fail, not set\ncurl: try 'curl --help' for more information\n",
            Some(2),
            &r,
            Path::new("x"),
        )
        .unwrap();
        assert_eq!((res.curl_exit, res.error.as_deref()), (2, Some("curl: Variable 'X' import fail, not set")));
        assert_eq!(parse_output("", "", Some(26), &r, Path::new("x")).unwrap().error.as_deref(), Some("curl failed (exit code 26)"));
        assert_eq!(parse_output("", "", Some(0), &r, Path::new("x")).unwrap().curl_exit, -1, "no response is never a success");
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("curl 8.21.0 (Windows) libcurl/8.21.0 Schannel"), Some((8, 21)));
        assert_eq!(parse_version("nonsense"), None);
        let mut r = req("GET", "https://example.com");
        assert!(check_version(Some((8, 2)), needed_version(&r)).is_ok());
        assert!(check_version(Some((7, 55)), needed_version(&r)).is_err());
        r.secrets = vec![Secret { name: "A".into(), value: "x".into() }];
        assert!(check_version(Some((8, 2)), needed_version(&r)).unwrap_err().contains("8.3"));
        assert!(check_version(None, needed_version(&r)).is_ok());
        r.secrets = vec![Secret { name: "A".into(), value: "pässword".into() }];
        assert!(check_version(Some((8, 12)), needed_version(&r)).unwrap_err().contains("8.13"));
    }

    #[test]
    fn reads_cookie_jars() {
        let jar = "# Netscape HTTP Cookie File\n#HttpOnly_203.0.113.5\tFALSE\t/\tFALSE\t0\tsid\tabc\n.example.com\tTRUE\t/api\tTRUE\t1893456000\ttheme\tdark\n\n";
        assert_eq!(
            parse_cookies(jar),
            [
                Cookie { domain: "203.0.113.5".into(), path: "/".into(), name: "sid".into(), value: "abc".into(), secure: false, http_only: true, expires: 0 },
                Cookie {
                    domain: ".example.com".into(),
                    path: "/api".into(),
                    name: "theme".into(),
                    value: "dark".into(),
                    secure: true,
                    http_only: false,
                    expires: 1893456000
                },
            ]
        );
    }

    // ---- real curl against a small HTTP server on 127.0.0.1 -------------------------------

    /// Answers each connection by path: /json, /echo (the request back as text), /login (sets a
    /// cookie), /me (the cookie it got), /redirect, /slow, /binary.
    fn server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || handle(stream));
            }
        });
        port
    }

    fn handle(mut stream: TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            head.push_str(&line);
        }
        let len: usize = head
            .lines()
            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
            .unwrap_or(0);
        let mut body = vec![0; len];
        let _ = reader.read_exact(&mut body);
        let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
        let cookie = head.lines().find_map(|l| l.strip_prefix("Cookie: ")).unwrap_or("").to_string();
        let (status, extra, content_type, out): (&str, String, &str, Vec<u8>) = match path.as_str() {
            "/json" => ("200 OK", "X-First: 1\r\nX-Second: 2\r\n".into(), "application/json", br#"{"ok":true}"#.to_vec()),
            "/echo" => ("200 OK", String::new(), "text/plain", format!("{head}\n{}", String::from_utf8_lossy(&body)).into_bytes()),
            "/login" => ("204 No Content", "Set-Cookie: sid=abc123; HttpOnly; Path=/\r\n".into(), "text/plain", Vec::new()),
            "/me" => ("200 OK", String::new(), "text/plain", cookie.into_bytes()),
            "/redirect" => ("302 Found", "Location: /json\r\n".into(), "text/plain", Vec::new()),
            "/slow" => {
                std::thread::sleep(Duration::from_secs(5));
                ("200 OK", String::new(), "text/plain", b"late".to_vec())
            }
            "/binary" => ("200 OK", String::new(), "application/octet-stream", vec![0, 159, 146, 150, 0, 1]),
            _ => ("404 Not Found", String::new(), "text/plain", b"nope".to_vec()),
        };
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
            out.len()
        );
        let _ = stream.write_all(&out);
    }

    fn manager(name: &str) -> HttpManager {
        HttpManager::new(std::env::temp_dir().join(format!("shellman-http-test-{name}-{}", std::process::id())))
    }

    /// Real curl, or None (with a note) where it is missing or too old for these tests.
    fn curl_ok() -> bool {
        match curl_client("") {
            Ok(c) if curl_version(&c).is_some_and(|v| v >= (8, 3)) => true,
            _ => {
                eprintln!("curl 8.3+ not found, skipped");
                false
            }
        }
    }

    #[test]
    fn real_get_json() {
        if !curl_ok() {
            return;
        }
        let port = server();
        let m = manager("json");
        let res = m.send(1, &req("GET", &format!("http://127.0.0.1:{port}/json"))).unwrap();
        assert_eq!((res.curl_exit, res.status), (0, 200));
        assert_eq!(res.body.as_deref(), Some(r#"{"ok":true}"#));
        assert_eq!(res.body_kind, BodyKind::Text);
        let names: Vec<&str> = res.headers.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["content-type", "content-length", "connection", "x-first", "x-second"]);
        assert!(res.timing.total > 0.0);
        m.shutdown();
    }

    #[test]
    fn real_post_with_secret_header() {
        if !curl_ok() {
            return;
        }
        let port = server();
        let m = manager("post");
        let mut r = req("PUT", &format!("http://127.0.0.1:{port}/echo"));
        r.headers = vec![Header { name: "Authorization".into(), value: "Bearer {{API_TOKEN}}".into() }];
        r.secrets = vec![Secret { name: "API_TOKEN".into(), value: "t0ken \"quoted\"".into() }];
        r.body = Body::Raw { text: "line 1\nline 2 ä".into() };
        let res = m.send(2, &r).unwrap();
        let echo = res.body.unwrap();
        assert!(echo.starts_with("PUT /echo HTTP/1.1"), "{echo}");
        assert!(echo.contains("Authorization: Bearer t0ken \"quoted\""), "{echo}");
        assert!(echo.ends_with("\nline 1\nline 2 ä"), "{echo}");
        // The console shows what ran, without the secret.
        assert!(res.console.command.contains("curl.exe") && res.console.command.ends_with("--config -"), "{}", res.console.command);
        assert!(res.console.config.contains("expand-header = \"Authorization: Bearer {{API_TOKEN}}\""));
        assert!(res.console.log.contains("> PUT /echo HTTP/1.1"), "{}", res.console.log);
        assert!(res.console.log.contains("Authorization: Bearer ••••••") && !res.console.log.contains("t0ken"), "{}", res.console.log);
        assert!(res.console.command.contains(" -q --config -"), "a personal .curlrc isn't read");

        // Characters the ANSI code page doesn't have arrive as they are (curl 8.13 and newer).
        if curl_version(&curl_client("").unwrap()).is_some_and(|v| v >= (8, 13)) {
            r.secrets = vec![Secret { name: "API_TOKEN".into(), value: "pä€漢".into() }];
            let echo = m.send(3, &r).unwrap().body.unwrap();
            assert!(echo.contains("Authorization: Bearer pä€漢"), "{echo}");
        }
        m.shutdown();
    }

    #[test]
    fn real_cookies_and_redirects() {
        if !curl_ok() {
            return;
        }
        let port = server();
        let m = manager("cookies");
        let mut login = req("POST", &format!("http://127.0.0.1:{port}/login"));
        login.cookie_jar = Some("group/dev".into());
        assert_eq!(m.send(3, &login).unwrap().status, 204);
        let cookies = m.cookies("group/dev");
        assert_eq!(cookies.len(), 1);
        assert!(cookies[0].http_only && cookies[0].name == "sid");

        let mut me = req("GET", &format!("http://127.0.0.1:{port}/me"));
        me.cookie_jar = Some("group/dev".into());
        assert_eq!(m.send(4, &me).unwrap().body.as_deref(), Some("sid=abc123"));
        me.cookie_jar = Some("group/prod".into());
        assert_eq!(m.send(5, &me).unwrap().body, None);
        m.clear_cookies("group/dev");
        assert!(m.cookies("group/dev").is_empty());

        let res = m.send(6, &req("GET", &format!("http://127.0.0.1:{port}/redirect"))).unwrap();
        assert_eq!((res.status, res.redirects), (200, 1));
        assert!(res.url.unwrap().ends_with("/json"));
        m.shutdown();
    }

    #[test]
    fn real_binary_and_too_large_bodies() {
        if !curl_ok() {
            return;
        }
        let port = server();
        let m = manager("binary");
        let res = m.send(7, &req("GET", &format!("http://127.0.0.1:{port}/binary"))).unwrap();
        assert_eq!((res.body_kind, res.body_size, res.body), (BodyKind::Binary, 6, None));
        let dest = m.dir.join("saved.bin");
        m.save_body(7, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), [0, 159, 146, 150, 0, 1]);
        let mut r = req("GET", &format!("http://127.0.0.1:{port}/json"));
        r.max_body_bytes = 4;
        assert_eq!(m.send(8, &r).unwrap().body_kind, BodyKind::TooLarge);
        m.shutdown();
    }

    #[test]
    fn real_failures_are_results() {
        if !curl_ok() {
            return;
        }
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let m = manager("fail");
        let res = m.send(9, &req("GET", &format!("http://127.0.0.1:{closed}/"))).unwrap();
        assert_eq!((res.curl_exit, res.status), (7, 0));
        assert!(res.error.unwrap().contains("Failed to connect"));

        let port = server();
        let mut slow = req("GET", &format!("http://127.0.0.1:{port}/slow"));
        slow.timeout_seconds = 1;
        assert_eq!(m.send(10, &slow).unwrap().curl_exit, 28);

        let mut missing = req("GET", &format!("http://127.0.0.1:{port}/json"));
        missing.headers = vec![Header { name: "X".into(), value: "{{NOT_SET_ANYWHERE}}".into() }];
        missing.secrets = vec![Secret { name: "NOT_SET_ANYWHERE".into(), value: "".into() }];
        assert!(m.send(11, &missing).is_ok(), "an empty value is still a value");
        m.shutdown();
    }

    #[test]
    fn real_cancel() {
        if !curl_ok() {
            return;
        }
        let port = server();
        let m = Arc::new(manager("cancel"));
        let sender = m.clone();
        let started = std::time::Instant::now();
        let t = std::thread::spawn(move || sender.send(12, &req("GET", &format!("http://127.0.0.1:{port}/slow"))));
        std::thread::sleep(Duration::from_millis(500));
        m.cancel(12);
        assert_eq!(t.join().unwrap().unwrap_err(), CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(4));
        m.shutdown();
    }
}
