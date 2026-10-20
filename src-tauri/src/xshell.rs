//! Reads XShell's saved sessions (`.xsh` files) for the importer. The files are only read and
//! decoded here; turning them into sessions happens in the frontend (src/xshell.ts).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// One `.xsh` file: the folders it is in (relative to the chosen directory), its name and text.
#[derive(Serialize, Debug, PartialEq)]
pub struct XshFile {
    pub folder: Vec<String>,
    pub name: String,
    pub text: String,
}

/// Limits so a wrongly chosen folder (a whole drive) can't stall the app or flood it.
const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 16;
const MAX_FILE_SIZE: u64 = 1 << 20;

/// XShell's own sessions folder, newest version first: `Documents\NetSarang Computer\<n>\Xshell\Sessions`
/// (XShell 6 and later) or `Documents\NetSarang\Xshell\Sessions` (XShell 5).
pub fn default_dir(documents: &Path) -> Option<PathBuf> {
    let mut versions: Vec<(u32, PathBuf)> = fs::read_dir(documents.join("NetSarang Computer"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|e| Some((e.file_name().to_str()?.parse().ok()?, e.path().join("Xshell").join("Sessions"))))
        .filter(|(_, p): &(u32, PathBuf)| p.is_dir())
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions
        .into_iter()
        .map(|(_, p)| p)
        .next()
        .or_else(|| Some(documents.join("NetSarang").join("Xshell").join("Sessions")).filter(|p| p.is_dir()))
}

/// Every `.xsh` file under `dir`, sorted by folder and name.
pub fn read_sessions(dir: &Path) -> Result<Vec<XshFile>, String> {
    if !dir.is_dir() {
        return Err(format!("Folder not found: {}", dir.display()));
    }
    let mut out = Vec::new();
    walk(dir, &mut Vec::new(), &mut out)?;
    out.sort_by(|a, b| (&a.folder, a.name.to_lowercase()).cmp(&(&b.folder, b.name.to_lowercase())));
    Ok(out)
}

fn walk(dir: &Path, folder: &mut Vec<String>, out: &mut Vec<XshFile>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Could not read {}: {e}", dir.display()))?;
    for entry in entries.filter_map(Result::ok) {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        // Symlinks and junctions are skipped: they can loop or lead out of the folder.
        if kind.is_dir() && folder.len() < MAX_DEPTH {
            folder.push(file_name);
            walk(&path, folder, out)?;
            folder.pop();
        } else if kind.is_file() && path.extension().is_some_and(|x| x.eq_ignore_ascii_case("xsh")) {
            if out.len() >= MAX_FILES {
                return Err(format!("More than {MAX_FILES} session files: choose XShell's Sessions folder."));
            }
            if entry.metadata().map(|m| m.len() > MAX_FILE_SIZE).unwrap_or(true) {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(file_name);
            out.push(XshFile { folder: folder.clone(), name, text: decode(&bytes) });
        }
    }
    Ok(())
}

/// XShell 6 and later write UTF-16 (little endian, with a byte-order mark); older versions UTF-8.
pub(crate) fn decode(bytes: &[u8]) -> String {
    let utf16 = |le: bool, b: &[u8]| {
        let units: Vec<u16> = b
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    match bytes {
        [0xFF, 0xFE, rest @ ..] => utf16(true, rest),
        [0xFE, 0xFF, rest @ ..] => utf16(false, rest),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        // UTF-16 without a byte-order mark: ASCII text with every second byte zero.
        [a, 0, ..] if *a != 0 => utf16(true, bytes),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shellman-xshell-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn utf16le_with_bom(s: &str) -> Vec<u8> {
        let mut b = vec![0xFF, 0xFE];
        b.extend(s.encode_utf16().flat_map(|u| u.to_le_bytes()));
        b
    }

    #[test]
    fn decodes_utf16_and_utf8() {
        assert_eq!(decode(&utf16le_with_bom("[CONNECTION]\r\nHost=ä.example.com")), "[CONNECTION]\r\nHost=ä.example.com");
        let be: Vec<u8> = [0xFE, 0xFF].into_iter().chain("Host=x".encode_utf16().flat_map(|u| u.to_be_bytes())).collect();
        assert_eq!(decode(&be), "Host=x");
        let no_bom: Vec<u8> = "Host=x".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode(&no_bom), "Host=x");
        assert_eq!(decode(b"\xEF\xBB\xBFHost=x"), "Host=x");
        assert_eq!(decode(b"Host=x"), "Host=x");
        assert_eq!(decode(b""), "");
    }

    #[test]
    fn reads_session_files_with_their_folders() {
        let d = temp_dir("read");
        fs::create_dir_all(d.join("Prod").join("Web")).unwrap();
        fs::write(d.join("router.xsh"), b"Host=10.0.0.1").unwrap();
        fs::write(d.join("Prod").join("Web").join("web1.XSH"), utf16le_with_bom("Host=web1.example.com")).unwrap();
        fs::write(d.join("Prod").join("notes.txt"), b"not a session").unwrap();
        let files = read_sessions(&d).unwrap();
        assert_eq!(
            files,
            vec![
                XshFile { folder: vec![], name: "router".into(), text: "Host=10.0.0.1".into() },
                XshFile { folder: vec!["Prod".into(), "Web".into()], name: "web1".into(), text: "Host=web1.example.com".into() },
            ]
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_folder_is_an_error() {
        let d = temp_dir("missing").join("nope");
        assert!(read_sessions(&d).unwrap_err().contains("not found"));
    }

    #[test]
    fn finds_the_newest_xshell_sessions_folder() {
        let docs = temp_dir("docs");
        assert_eq!(default_dir(&docs), None);
        let old = docs.join("NetSarang").join("Xshell").join("Sessions");
        fs::create_dir_all(&old).unwrap();
        assert_eq!(default_dir(&docs), Some(old));
        for v in ["6", "8", "10"] {
            fs::create_dir_all(docs.join("NetSarang Computer").join(v).join("Xshell").join("Sessions")).unwrap();
        }
        // A version folder without sessions (only Xftp, say) is ignored.
        fs::create_dir_all(docs.join("NetSarang Computer").join("11").join("Xftp")).unwrap();
        assert_eq!(default_dir(&docs), Some(docs.join("NetSarang Computer").join("10").join("Xshell").join("Sessions")));
        let _ = fs::remove_dir_all(&docs);
    }
}
