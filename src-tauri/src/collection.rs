//! The folder a sidebar group is linked to: its request files, environments and `.env` files,
//! which a team shares through git. Shellman reads and writes only these files, and only by paths
//! relative to the folder that are checked first, so no name (typed, imported or pulled from the
//! repo) can reach outside the folder.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

pub const REQUEST_EXT: &str = ".request.json";
const ENV_DIR: &str = "environments";
/// Personal values: `.env.local`, or `.env.<environment>.local` for one environment. They are
/// never committed (git.rs refuses them) and should be in `.gitignore`.
pub fn is_local_env(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env.local"
        || lower
            .strip_prefix(".env.")
            .and_then(|r| r.strip_suffix(".local"))
            .is_some_and(|env| !env.is_empty() && env.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)))
}

/// The files at the top of the folder that Shellman reads or writes besides requests and
/// environments: the `.env` files, and `.gitignore` (to add the local ones to it).
fn is_root_file(name: &str) -> bool {
    name == ".env" || name == ".gitignore" || is_local_env(name)
}

/// Whether `rel` (relative to the folder) is one of Shellman's files: a request, an environment or
/// a file at the top that it uses. Sync commits only these, so a folder that holds other work
/// (a project's own code) never has that committed along.
pub fn is_collection_file(rel: &str) -> bool {
    match rel.split('/').collect::<Vec<_>>().as_slice() {
        [name] => is_root_file(name) || is_request_file(name),
        [dir, name] if dir.eq_ignore_ascii_case(ENV_DIR) => name.len() > 5 && name.to_ascii_lowercase().ends_with(".json"),
        [dirs @ .., name] => !dirs[0].eq_ignore_ascii_case(ENV_DIR) && !dirs.iter().any(|d| skipped_dir(d)) && is_request_file(name),
        [] => false,
    }
}

/// Limits so a wrongly chosen folder (a whole drive) can't stall the app or flood it.
const MAX_FILES: usize = 5000;
const MAX_FOLDERS: usize = 2000;
const MAX_DEPTH: usize = 16;
const MAX_FILE_SIZE: u64 = 1 << 20;

#[derive(Serialize, Debug, PartialEq)]
pub struct TextFile {
    /// Relative to the folder, with `/`.
    pub path: String,
    pub text: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub requests: Vec<TextFile>,
    /// Every folder that can hold requests, also empty ones.
    pub folders: Vec<String>,
    /// `environments/<name>.json`, as `<name>`.
    pub environments: Vec<TextFile>,
    /// `.env` and the personal `.env.local` / `.env.<environment>.local`, by file name.
    pub dotenv: Vec<TextFile>,
    pub gitignore: Option<String>,
}

/// What a relative path may name.
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Request,
    Folder,
    Environment,
    RootFile,
}

fn skipped_dir(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("node_modules")
}

fn is_request_file(name: &str) -> bool {
    name.len() > REQUEST_EXT.len() && name.to_ascii_lowercase().ends_with(REQUEST_EXT)
}

fn read_text(path: &Path) -> Option<String> {
    fs::metadata(path).ok().filter(|m| m.is_file() && m.len() <= MAX_FILE_SIZE)?;
    fs::read(path).ok().map(|b| crate::xshell::decode(&b))
}

/// Everything Shellman uses in `folder`.
pub fn scan(folder: &Path) -> Result<Scan, String> {
    if !folder.is_dir() {
        return Err(format!("Folder not found: {}", folder.display()));
    }
    let mut scan = Scan { requests: Vec::new(), folders: Vec::new(), environments: Vec::new(), dotenv: Vec::new(), gitignore: None };
    walk(folder, &mut Vec::new(), &mut scan)?;
    scan.requests.sort_by_key(|f| f.path.to_lowercase());
    scan.folders.sort_by_key(|f| f.to_lowercase());
    // Not through a symlink or junction: that could lead out of the folder.
    let env_dir = folder.join(ENV_DIR);
    let real_dir = fs::symlink_metadata(&env_dir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink());
    if let Some(entries) = real_dir.then(|| fs::read_dir(&env_dir).ok()).flatten() {
        for e in entries.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".json").filter(|s| !s.is_empty()) else { continue };
            if e.file_type().is_ok_and(|t| t.is_file()) {
                if let Some(text) = read_text(&e.path()) {
                    scan.environments.push(TextFile { path: stem.to_string(), text });
                }
            }
        }
    }
    scan.environments.sort_by_key(|f| f.path.to_lowercase());
    if let Ok(entries) = fs::read_dir(folder) {
        for e in entries.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            if (name == ".env" || is_local_env(&name)) && e.file_type().is_ok_and(|t| t.is_file()) {
                if let Some(text) = read_text(&e.path()) {
                    scan.dotenv.push(TextFile { path: name, text });
                }
            }
        }
    }
    scan.dotenv.sort_by(|a, b| a.path.cmp(&b.path));
    scan.gitignore = read_text(&folder.join(".gitignore"));
    Ok(scan)
}

fn walk(dir: &Path, rel: &mut Vec<String>, scan: &mut Scan) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // A folder inside that can't be read (no access) is left out, not the whole collection.
        Err(_) if !rel.is_empty() => return Ok(()),
        Err(e) => return Err(format!("Could not read {}: {e}", dir.display())),
    };
    for entry in entries.filter_map(Result::ok) {
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        // Symlinks and junctions are skipped: they can loop or lead out of the folder.
        if kind.is_dir() {
            if skipped_dir(&name) || (rel.is_empty() && name.eq_ignore_ascii_case(ENV_DIR)) || rel.len() >= MAX_DEPTH {
                continue;
            }
            if scan.folders.len() >= MAX_FOLDERS {
                return Err(format!("More than {MAX_FOLDERS} folders: choose the folder of one collection."));
            }
            rel.push(name);
            scan.folders.push(rel.join("/"));
            walk(&entry.path(), rel, scan)?;
            rel.pop();
        } else if kind.is_file() && is_request_file(&name) {
            if scan.requests.len() >= MAX_FILES {
                return Err(format!("More than {MAX_FILES} request files: choose the folder of one collection."));
            }
            if let Some(text) = read_text(&entry.path()) {
                let path = rel.iter().cloned().chain([name]).collect::<Vec<_>>().join("/");
                scan.requests.push(TextFile { path, text });
            }
        }
    }
    Ok(())
}

/// Splits a relative path (`a/b/c.request.json`) and checks every part is an ordinary name.
pub fn check_rel(rel: &str) -> Result<Vec<&str>, String> {
    let invalid = || format!("Invalid name: {rel}");
    if rel.is_empty() || rel.len() > 1024 {
        return Err(invalid());
    }
    let parts: Vec<&str> = rel.split('/').collect();
    for part in &parts {
        let stem = part.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
        // A short 8.3 name (`ENVIRO~1`) can stand for another folder, e.g. `environments`.
        let short_name = part.find('~').is_some_and(|i| part[i + 1..].starts_with(|c: char| c.is_ascii_digit()));
        if part.is_empty()
            || *part == "."
            || *part == ".."
            || part.len() > 255
            || part.ends_with(['.', ' '])
            || part.chars().any(|c| c.is_control() || "<>:\"\\|?*".contains(c))
            || reserved
            || short_name
        {
            return Err(invalid());
        }
    }
    Ok(parts)
}

/// The file or folder `rel` names in `folder`, if it may name a `kind`.
pub fn resolve(folder: &Path, rel: &str, kind: Kind) -> Result<PathBuf, String> {
    let parts = check_rel(rel)?;
    let first = parts[0];
    let last = parts[parts.len() - 1];
    let in_tree = !first.eq_ignore_ascii_case(ENV_DIR) && parts.iter().all(|p| !skipped_dir(p));
    let ok = match kind {
        Kind::Request => in_tree && is_request_file(last),
        Kind::Folder => in_tree,
        Kind::Environment => parts.len() == 2 && first == ENV_DIR && last.len() > 5 && last.ends_with(".json"),
        Kind::RootFile => parts.len() == 1 && is_root_file(last),
    };
    if !ok {
        return Err(format!("Invalid name: {rel}"));
    }
    let path = parts.iter().fold(folder.to_path_buf(), |p, part| p.join(part));
    inside(folder, &path)?;
    Ok(path)
}

/// A junction inside the folder could still lead out of it: the nearest part of `path` that
/// exists must really be inside `folder`.
fn inside(folder: &Path, path: &Path) -> Result<(), String> {
    let root = fs::canonicalize(folder).map_err(|e| format!("Folder not found: {} ({e})", folder.display()))?;
    let mut existing = path;
    while !existing.exists() {
        existing = existing.parent().ok_or("Invalid path")?;
    }
    let real = fs::canonicalize(existing).map_err(|e| e.to_string())?;
    if real.starts_with(&root) {
        Ok(())
    } else {
        Err(format!("{} is outside the linked folder", path.display()))
    }
}

/// Saves a request, environment or top-level file (creating its folders), atomically and
/// without a `.bak` next to it: the folder is a git working tree.
pub fn write(folder: &Path, rel: &str, kind: Kind, text: &str) -> Result<(), String> {
    if kind == Kind::Folder {
        return Err("Invalid name".into());
    }
    // Larger files aren't read back (`read_text`), so they would seem to vanish.
    if text.len() as u64 > MAX_FILE_SIZE {
        return Err(format!("{rel} would be larger than {} MB; keep big bodies in a file of their own.", MAX_FILE_SIZE >> 20));
    }
    let path = resolve(folder, rel, kind)?;
    let dir = path.parent().ok_or("Invalid path")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    crate::config::write_atomic(&path, text.as_bytes(), false)
}

pub fn create_folder(folder: &Path, rel: &str) -> Result<(), String> {
    let path = resolve(folder, rel, Kind::Folder)?;
    fs::create_dir_all(&path).map_err(|e| format!("Could not create {}: {e}", path.display()))
}

/// Renames or moves a request or folder; never over an existing one.
pub fn rename(folder: &Path, from: &str, to: &str, kind: Kind) -> Result<(), String> {
    if !matches!(kind, Kind::Request | Kind::Folder) {
        return Err("Invalid name".into());
    }
    let src = resolve(folder, from, kind)?;
    let dest = resolve(folder, to, kind)?;
    if !src.exists() {
        return Err(format!("{from} no longer exists"));
    }
    // A change of case only (on a case-insensitive disk) is the same file.
    if dest.exists() && !from.eq_ignore_ascii_case(to) {
        return Err(format!("{to} already exists"));
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    fs::rename(&src, &dest).map_err(|e| format!("Could not rename {from}: {e}"))
}

/// Deletes a request, or a folder with everything in it.
pub fn delete(folder: &Path, rel: &str, kind: Kind) -> Result<(), String> {
    let path = resolve(folder, rel, kind)?;
    let result = match kind {
        Kind::Request => fs::remove_file(&path),
        Kind::Folder => fs::remove_dir_all(&path),
        _ => return Err("Invalid name".into()),
    };
    match result {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not delete {rel}: {e}")),
        _ => Ok(()),
    }
}

/// Whether a change at `path` matters to the sidebar: git's own files and half-written files don't.
fn relevant(path: &Path) -> bool {
    let tmp = path.extension().is_some_and(|x| x.eq_ignore_ascii_case("tmp"));
    !tmp && !path.components().any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
}

/// Watches linked folders; `changed` runs (debounced) after files in one change.
#[derive(Default)]
pub struct Watches {
    next: Mutex<u32>,
    active: Mutex<std::collections::HashMap<u32, notify::RecommendedWatcher>>,
}

impl Watches {
    /// Starts watching `folder`; `changed` returning false (its listener is gone) stops it.
    pub fn watch(&self, folder: &Path, changed: impl Fn() -> bool + Send + 'static) -> Result<u32, String> {
        self.watch_with(folder, relevant, changed)
    }

    /// Like `watch`, with `relevant` deciding which changed paths count.
    pub fn watch_with(&self, folder: &Path, relevant: fn(&Path) -> bool, changed: impl Fn() -> bool + Send + 'static) -> Result<u32, String> {
        use notify::Watcher;
        let (tx, rx) = mpsc::channel::<()>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(e) = res {
                if !matches!(e.kind, notify::EventKind::Access(_)) && e.paths.iter().any(|p| relevant(p)) {
                    let _ = tx.send(());
                }
            }
        })
        .map_err(|e| format!("Could not watch {}: {e}", folder.display()))?;
        watcher
            .watch(folder, notify::RecursiveMode::Recursive)
            .map_err(|e| format!("Could not watch {}: {e}", folder.display()))?;
        // A save or a git pull touches many files at once: report once, when it has settled.
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
                if !changed() {
                    break;
                }
            }
        });
        let id = {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            *next
        };
        self.active.lock().unwrap().insert(id, watcher);
        Ok(id)
    }

    /// Stops a watch; its thread ends with the watcher.
    pub fn unwatch(&self, id: u32) {
        self.active.lock().unwrap().remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shellman-collection-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn scans_a_collection() {
        let d = temp_dir("scan");
        put(&d, "users/list-users.request.json", "{\"method\":\"GET\"}");
        put(&d, "users/admin/Create.REQUEST.JSON", "\u{feff}{}");
        put(&d, "orders/.gitkeep", "");
        put(&d, "empty/x.txt", "not a request");
        put(&d, "notes.json", "{}");
        put(&d, ".git/config", "[core]");
        put(&d, "node_modules/a/b.request.json", "{}");
        put(&d, ".hidden/c.request.json", "{}");
        put(&d, "environments/dev.json", "{\"variables\":{}}");
        put(&d, "environments/old.json.bak", "");
        put(&d, "environments/nested/x.json", "{}");
        put(&d, ".env", "BASE=1\n");
        put(&d, ".env.dev.local", "TOKEN=x\n");
        put(&d, ".env.example", "not read");
        put(&d, "big.request.json", &"x".repeat(MAX_FILE_SIZE as usize + 1));
        let s = scan(&d).unwrap();
        let paths: Vec<&str> = s.requests.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["users/admin/Create.REQUEST.JSON", "users/list-users.request.json"]);
        assert_eq!(s.requests[0].text, "{}", "the byte-order mark is dropped");
        assert_eq!(s.folders, ["empty", "orders", "users", "users/admin"]);
        assert_eq!(s.environments, [TextFile { path: "dev".into(), text: "{\"variables\":{}}".into() }]);
        assert_eq!(
            s.dotenv,
            [TextFile { path: ".env".into(), text: "BASE=1\n".into() }, TextFile { path: ".env.dev.local".into(), text: "TOKEN=x\n".into() }]
        );
        assert_eq!(s.gitignore, None);
        assert!(scan(&d.join("missing")).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rejects_paths_that_leave_the_folder() {
        let d = temp_dir("paths");
        for bad in [
            "",
            "..",
            "../x.request.json",
            "a/../../x.request.json",
            "C:/Windows/x.request.json",
            "/x.request.json",
            r"a\..\x.request.json",
            "a//x.request.json",
            "con.request.json",
            "a/lpt1/x.request.json",
            "a./x.request.json",
            "x .request.json ",
            "x.json",
            ".request.json",
            "environments/x.request.json",
            ".git/x.request.json",
            "a/.hidden.request.json",
            "a/node_modules/x.request.json",
        ] {
            assert!(resolve(&d, bad, Kind::Request).is_err(), "{bad:?}");
        }
        assert!(resolve(&d, "users/x.request.json", Kind::Request).is_ok());
        assert!(resolve(&d, "environments/dev.json", Kind::Environment).is_ok());
        assert!(resolve(&d, "environments/a/dev.json", Kind::Environment).is_err());
        assert!(resolve(&d, "dev.json", Kind::Environment).is_err());
        assert!(resolve(&d, ".env.local", Kind::RootFile).is_ok());
        assert!(resolve(&d, ".env.prod.local", Kind::RootFile).is_ok());
        assert!(resolve(&d, ".env..local", Kind::RootFile).is_err());
        assert!(resolve(&d, ".env.a b.local", Kind::RootFile).is_err());
        assert!(resolve(&d, ".bashrc", Kind::RootFile).is_err());
        assert!(resolve(&d, "users/.env", Kind::RootFile).is_err());
        assert!(resolve(&d, "users/admin", Kind::Folder).is_ok());
        assert!(resolve(&d, "environments", Kind::Folder).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn junctions_out_of_the_folder_are_refused() {
        let d = temp_dir("junction");
        let outside = temp_dir("junction-outside");
        let link = d.join("linked");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .is_ok_and(|o| o.status.success());
        if made {
            assert!(write(&d, "linked/x.request.json", Kind::Request, "{}").unwrap_err().contains("outside"));
            assert!(!outside.join("x.request.json").exists());
            assert!(scan(&d).unwrap().folders.is_empty(), "junctions aren't followed");
        } else {
            eprintln!("mklink /J failed, skipped");
        }
        let _ = fs::remove_dir_all(&link);
        let _ = fs::remove_dir_all(&d);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn knows_its_own_files() {
        for f in ["a.request.json", "users/b.REQUEST.json", ".env", ".env.local", ".env.dev.local", ".gitignore", "environments/dev.json", "Environments/Dev.JSON"] {
            assert!(is_collection_file(f), "{f}");
        }
        for f in ["main.rs", "README.md", "src/lib.rs", "notes.json", "environments/a/b.json", "environments/x.request.json/..", "node_modules/a.request.json", ".git/x.request.json", "a/.env", ".env.example"] {
            assert!(!is_collection_file(f), "{f}");
        }
        assert!(check_rel("ENVIRO~1/dev.json").is_err() && check_rel("a~b.request.json").is_ok());
    }

    #[test]
    fn writes_renames_and_deletes() {
        let d = temp_dir("write");
        write(&d, "a/b/new.request.json", Kind::Request, "{\n  \"method\": \"GET\"\n}\n").unwrap();
        assert_eq!(fs::read_to_string(d.join("a/b/new.request.json")).unwrap(), "{\n  \"method\": \"GET\"\n}\n");
        write(&d, "a/b/new.request.json", Kind::Request, "{}\n").unwrap();
        let names: Vec<String> = fs::read_dir(d.join("a/b")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["new.request.json"], "no temporary or backup files are left");
        write(&d, "environments/dev.json", Kind::Environment, "{}").unwrap();
        write(&d, ".gitignore", Kind::RootFile, ".env.local\n").unwrap();
        assert!(write(&d, "a", Kind::Folder, "").is_err());

        rename(&d, "a/b/new.request.json", "c/renamed.request.json", Kind::Request).unwrap();
        assert!(d.join("c/renamed.request.json").is_file() && !d.join("a/b/new.request.json").exists());
        write(&d, "c/other.request.json", Kind::Request, "{}").unwrap();
        assert!(rename(&d, "c/other.request.json", "c/renamed.request.json", Kind::Request).unwrap_err().contains("exists"));
        rename(&d, "c/other.request.json", "c/Other.request.json", Kind::Request).unwrap();
        rename(&d, "c", "d", Kind::Folder).unwrap();
        create_folder(&d, "e/f").unwrap();
        assert!(d.join("e/f").is_dir());

        delete(&d, "d/renamed.request.json", Kind::Request).unwrap();
        delete(&d, "d/renamed.request.json", Kind::Request).unwrap();
        delete(&d, "d", Kind::Folder).unwrap();
        assert!(!d.join("d").exists());
        assert!(delete(&d, "environments/dev.json", Kind::Environment).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn watches_for_changes() {
        let d = temp_dir("watch");
        put(&d, ".git/HEAD", "ref: refs/heads/main");
        let watches = Watches::default();
        let (tx, rx) = mpsc::channel();
        let id = watches.watch(&d, move || tx.send(()).is_ok()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        put(&d, ".git/FETCH_HEAD", "abc");
        put(&d, "x.request.json.123-0.tmp", "{}");
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err(), "git's files and temporary files are ignored");
        put(&d, "users/x.request.json", "{}");
        put(&d, "users/y.request.json", "{}");
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(rx.recv_timeout(Duration::from_millis(800)).is_err(), "one report for changes close together");
        watches.unwatch(id);
        std::thread::sleep(Duration::from_millis(200));
        put(&d, "users/z.request.json", "{}");
        assert!(rx.recv_timeout(Duration::from_millis(1000)).is_err());
        let _ = fs::remove_dir_all(&d);
    }
}
