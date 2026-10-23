//! The Files pane: a read-only look at a folder (a session's project). Folders are listed one at a
//! time as they are opened, and files are read only by paths relative to the folder that are checked
//! first, so no name can reach outside it (`..`, a junction or a symlink that leads elsewhere).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Larger text files aren't shown (the viewer would stall); they can be opened in an editor.
const MAX_TEXT: u64 = 8 << 20;
const MAX_IMAGE: u64 = 16 << 20;
/// Entries of one folder; a folder with more shows the first ones and says so.
const MAX_ENTRIES: usize = 10_000;
/// Files offered by "Go to file" in a folder outside git.
const MAX_ALL: usize = 50_000;
const MAX_DEPTH: usize = 24;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    /// A symlink or junction (shown, but not followed out of the folder).
    pub link: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Content {
    Text { text: String, size: u64 },
    Image { data_url: String, size: u64 },
    Binary { size: u64 },
    TooLarge { size: u64 },
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllFiles {
    pub files: Vec<String>,
    pub truncated: bool,
}

/// `rel` (`src/main.ts`, '' for the folder itself) as a path in `root`, checked to stay inside it.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let invalid = || format!("Invalid path: {rel}");
    if rel.len() > 2048 {
        return Err(invalid());
    }
    let mut path = root.to_path_buf();
    if !rel.is_empty() {
        for part in rel.split('/') {
            if part.is_empty() || part == "." || part == ".." || part.chars().any(|c| c.is_control() || "\\:*?\"<>|".contains(c)) {
                return Err(invalid());
            }
            path.push(part);
        }
    }
    // The real location decides: a junction or symlink inside could lead anywhere.
    let real_root = fs::canonicalize(root).map_err(|e| format!("Folder not found: {} ({e})", root.display()))?;
    let real = fs::canonicalize(&path).map_err(|e| format!("{rel}: {e}"))?;
    if real.starts_with(&real_root) {
        Ok(path)
    } else {
        Err(format!("{rel} leads outside the folder"))
    }
}

/// The entries of the folder `rel` in `root`. git's own folder is left out.
pub fn list(root: &Path, rel: &str) -> Result<Listing, String> {
    let dir = resolve(root, rel)?;
    let read = fs::read_dir(&dir).map_err(|e| format!("Could not read {}: {e}", dir.display()))?;
    let mut listing = Listing { entries: Vec::new(), truncated: false };
    for entry in read.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(".git") {
            continue;
        }
        if listing.entries.len() >= MAX_ENTRIES {
            listing.truncated = true;
            break;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let link = kind.is_symlink();
        // A link to a folder counts as a folder (opening it checks where it leads).
        let meta = if link { fs::metadata(entry.path()).ok() } else { entry.metadata().ok() };
        let dir = meta.as_ref().is_some_and(|m| m.is_dir());
        let size = meta.as_ref().filter(|m| m.is_file()).map_or(0, |m| m.len());
        listing.entries.push(Entry { name, dir, size, link });
    }
    Ok(listing)
}

/// Text in a file: a byte-order mark says so, otherwise no NUL bytes near the start.
fn is_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    let head = &bytes[..bytes.len().min(8000)];
    // UTF-16 without a mark: ASCII with every second byte zero (see xshell::decode).
    let utf16 = head.len() >= 4 && head.chunks_exact(2).take(32).all(|c| c[0] != 0 && c[1] == 0);
    !utf16 && head.contains(&0)
}

fn image_type(rel: &str) -> Option<&'static str> {
    let ext = rel.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// A file's contents for the viewer.
pub fn read(root: &Path, rel: &str) -> Result<Content, String> {
    let path = resolve(root, rel)?;
    let meta = fs::metadata(&path).map_err(|e| format!("{rel}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{rel} isn't a file"));
    }
    let size = meta.len();
    if let Some(mime) = image_type(rel) {
        if size > MAX_IMAGE {
            return Ok(Content::TooLarge { size });
        }
        use base64::Engine;
        let bytes = fs::read(&path).map_err(|e| format!("Could not read {rel}: {e}"))?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(Content::Image { data_url: format!("data:{mime};base64,{data}"), size });
    }
    if size > MAX_TEXT {
        return Ok(Content::TooLarge { size });
    }
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {rel}: {e}"))?;
    Ok(text_content(&bytes))
}

/// Text (decoded) or binary, for file contents from disk or from git.
pub fn text_content(bytes: &[u8]) -> Content {
    let size = bytes.len() as u64;
    if size > MAX_TEXT {
        Content::TooLarge { size }
    } else if is_binary(bytes) {
        Content::Binary { size }
    } else {
        Content::Text { text: crate::xshell::decode(bytes), size }
    }
}

/// Every file in `root` for "Go to file": git's list (tracked, and new files it doesn't ignore), or
/// outside a repository a walk that skips git's and package folders.
pub fn all(root: &Path) -> Result<AllFiles, String> {
    if let Some(files) = crate::git::list_files(root)? {
        let truncated = files.len() > MAX_ALL;
        return Ok(AllFiles { files: files.into_iter().take(MAX_ALL).collect(), truncated });
    }
    let mut out = AllFiles { files: Vec::new(), truncated: false };
    walk(&resolve(root, "")?, &mut Vec::new(), &mut out);
    Ok(out)
}

fn walk(dir: &Path, rel: &mut Vec<String>, out: &mut AllFiles) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.filter_map(Result::ok) {
        if out.files.len() >= MAX_ALL {
            out.truncated = true;
            return;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        // Links aren't followed: they can loop or lead out of the folder.
        if kind.is_dir() {
            if name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case("node_modules") || rel.len() >= MAX_DEPTH {
                continue;
            }
            rel.push(name);
            walk(&entry.path(), rel, out);
            rel.pop();
        } else if kind.is_file() {
            out.files.push(rel.iter().cloned().chain([name]).collect::<Vec<_>>().join("/"));
        }
    }
}

/// Whether a change at `path` can change what the pane shows: half-written files don't, and of git's
/// own files only those that move HEAD or the index (a commit, a checkout, staging).
pub fn relevant(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if name.ends_with(".tmp") || name.ends_with(".lock") {
        return false;
    }
    let parts: Vec<String> = path.components().map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase()).collect();
    match parts.iter().position(|p| p == ".git") {
        None => true,
        Some(i) => matches!(parts.get(i + 1).map(String::as_str), Some("head" | "index" | "refs" | "packed-refs")),
    }
}

/// VS Code's own program (not the `code.cmd` script, which would need cmd.exe to run).
fn vscode() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    // <VS Code>\bin\code.cmd -> <VS Code>\Code.exe
    if let Some(dir) = crate::shell::find_on_path("code.cmd").and_then(|p| p.parent()?.parent().map(Path::to_path_buf)) {
        candidates.push(dir.join("Code.exe"));
    }
    for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramW6432"] {
        if let Some(base) = std::env::var_os(var) {
            let base = PathBuf::from(base);
            candidates.push(base.join("Programs").join("Microsoft VS Code").join("Code.exe"));
            candidates.push(base.join("Microsoft VS Code").join("Code.exe"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Opens the folder in VS Code, and `file` in it (at `line`) when one is given.
pub fn open_in_editor(root: &Path, file: Option<&str>, line: Option<u32>) -> Result<(), String> {
    let folder = resolve(root, "")?;
    let exe = vscode().ok_or("VS Code wasn't found. Install it from code.visualstudio.com (or with winget install Microsoft.VisualStudioCode).")?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(&folder);
    if let Some(rel) = file.filter(|f| !f.is_empty()) {
        let path = resolve(root, rel)?;
        cmd.arg("--goto").arg(format!("{}:{}", path.display(), line.unwrap_or(1).max(1)));
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start VS Code: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shellman-files-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    #[test]
    fn paths_stay_inside_the_folder() {
        let d = temp_dir("resolve");
        put(&d, "src/a.ts", b"x");
        assert!(resolve(&d, "src/a.ts").is_ok());
        assert!(resolve(&d, "").is_ok());
        for bad in ["../x", "src/../../x", "src//a.ts", "./src", "C:/Windows", "src\\a.ts", "a\0b", "/src"] {
            assert!(resolve(&d, bad).is_err(), "{bad}");
        }
        assert!(resolve(&d, "missing.txt").is_err());
    }

    #[test]
    fn a_junction_out_of_the_folder_is_refused() {
        let d = temp_dir("junction");
        let outside = temp_dir("junction-outside");
        put(&outside, "secret.txt", b"x");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(d.join("out"))
            .arg(&outside)
            .output()
            .is_ok_and(|o| o.status.success());
        if !ok {
            eprintln!("mklink /J failed, skipped");
            return;
        }
        let listing = list(&d, "").unwrap();
        assert_eq!(listing.entries, vec![Entry { name: "out".into(), dir: true, size: 0, link: true }]);
        assert!(list(&d, "out").is_err());
        assert!(read(&d, "out/secret.txt").is_err());
    }

    #[test]
    fn lists_a_folder_without_git() {
        let d = temp_dir("list");
        put(&d, "README.md", b"hello");
        put(&d, "src/a.ts", b"x");
        put(&d, ".git/config", b"[core]");
        let mut entries = list(&d, "").unwrap().entries;
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(
            entries,
            vec![Entry { name: "README.md".into(), dir: false, size: 5, link: false }, Entry { name: "src".into(), dir: true, size: 0, link: false }]
        );
    }

    #[test]
    fn reads_text_images_and_binaries() {
        let d = temp_dir("read");
        put(&d, "a.txt", b"\xEF\xBB\xBFline 1\r\nline 2");
        put(&d, "b.bin", b"MZ\x90\0\x03\0\0\0");
        put(&d, "c.png", b"\x89PNG");
        put(&d, "u16.txt", &"ab".encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<_>>());
        assert_eq!(read(&d, "a.txt").unwrap(), Content::Text { text: "line 1\r\nline 2".into(), size: 17 });
        assert_eq!(read(&d, "b.bin").unwrap(), Content::Binary { size: 8 });
        assert_eq!(read(&d, "c.png").unwrap(), Content::Image { data_url: "data:image/png;base64,iVBORw==".into(), size: 4 });
        assert_eq!(read(&d, "u16.txt").unwrap(), Content::Text { text: "ab".into(), size: 4 });
        assert!(read(&d, "").is_err());
    }

    #[test]
    fn walks_a_folder_outside_git() {
        let d = temp_dir("walk");
        put(&d, "a.txt", b"");
        put(&d, "src/b.ts", b"");
        put(&d, "node_modules/x/index.js", b"");
        let mut out = AllFiles { files: Vec::new(), truncated: false };
        walk(&d, &mut Vec::new(), &mut out);
        out.files.sort();
        assert_eq!(out.files, ["a.txt", "src/b.ts"]);
    }

    #[test]
    fn notices_only_relevant_changes() {
        assert!(relevant(Path::new(r"C:\p\src\a.ts")));
        assert!(relevant(Path::new(r"C:\p\.git\HEAD")));
        assert!(relevant(Path::new(r"C:\p\.git\index")));
        assert!(relevant(Path::new(r"C:\p\.git\refs\heads\main")));
        assert!(!relevant(Path::new(r"C:\p\.git\objects\ab\cdef")));
        assert!(!relevant(Path::new(r"C:\p\.git\index.lock")));
        assert!(!relevant(Path::new(r"C:\p\src\a.ts.tmp")));
    }
}
