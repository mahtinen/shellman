//! Note panes. While a note has text that isn't saved to a file, that text is kept in
//! `<config dir>\notes\<id>.txt`, so every note reopens after a restart as it was, saved or not.
//! Saving writes the file the user chose in a save dialog.

use std::fs;
use std::path::{Path, PathBuf};

use crate::config::write_atomic;
use crate::files::{text_content, Content};

const NOTES_DIR: &str = "notes";

/// Ids come from the frontend; they only ever name a file inside the notes folder.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn backup_path(config_dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("Invalid note id: {id}"));
    }
    Ok(config_dir.join(NOTES_DIR).join(format!("{id}.txt")))
}

/// The kept text of a note; None when it has none (nothing unsaved).
pub fn read_backup(config_dir: &Path, id: &str) -> Result<Option<String>, String> {
    let path = backup_path(config_dir, id)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

pub fn write_backup(config_dir: &Path, id: &str, text: &str) -> Result<(), String> {
    let path = backup_path(config_dir, id)?;
    let dir = config_dir.join(NOTES_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    write_atomic(&path, text.as_bytes(), false)
}

pub fn delete_backup(config_dir: &Path, id: &str) -> Result<(), String> {
    let path = backup_path(config_dir, id)?;
    match fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not delete {}: {e}", path.display())),
        _ => Ok(()),
    }
}

/// Deletes the kept text of notes that are no longer open (closed while Shellman wasn't saving).
pub fn prune(config_dir: &Path, keep: &[String]) {
    let Ok(entries) = fs::read_dir(config_dir.join(NOTES_DIR)) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".txt") else { continue };
        if valid_id(id) && !keep.iter().any(|k| k == id) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// A text file opened in a note.
pub fn read_text(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("Not a full path: {path}"));
    }
    let bytes = fs::read(p).map_err(|e| format!("Could not read {path}: {e}"))?;
    match text_content(&bytes) {
        Content::Text { text, .. } => Ok(text),
        Content::TooLarge { .. } => Err(format!("{path} is too large to open as a note")),
        _ => Err(format!("{path} isn't a text file")),
    }
}

/// Saves a note to a file the user chose (UTF-8, without a byte-order mark).
pub fn write_text(path: &str, text: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() || p.is_dir() {
        return Err(format!("Not a file path: {path}"));
    }
    write_atomic(p, text.as_bytes(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shellman-notes-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn backups_round_trip_and_are_deleted() {
        let d = temp_dir("backup");
        assert_eq!(read_backup(&d, "n-1").unwrap(), None);
        write_backup(&d, "n-1", "ls -la\r\nä").unwrap();
        assert_eq!(read_backup(&d, "n-1").unwrap().as_deref(), Some("ls -la\r\nä"));
        write_backup(&d, "n-1", "").unwrap();
        assert_eq!(read_backup(&d, "n-1").unwrap().as_deref(), Some(""));
        delete_backup(&d, "n-1").unwrap();
        delete_backup(&d, "n-1").unwrap();
        assert_eq!(read_backup(&d, "n-1").unwrap(), None);
    }

    #[test]
    fn ids_cannot_leave_the_notes_folder() {
        let d = temp_dir("ids");
        for id in ["", "..", "../config", "a\\b", "a/b", "C:x", &"a".repeat(65)] {
            assert!(write_backup(&d, id, "x").is_err(), "{id}");
            assert!(read_backup(&d, id).is_err(), "{id}");
            assert!(delete_backup(&d, id).is_err(), "{id}");
        }
    }

    #[test]
    fn prune_keeps_open_notes_only() {
        let d = temp_dir("prune");
        write_backup(&d, "keep", "a").unwrap();
        write_backup(&d, "gone", "b").unwrap();
        fs::write(d.join(NOTES_DIR).join("other.log"), "c").unwrap();
        prune(&d, &["keep".into()]);
        assert!(read_backup(&d, "keep").unwrap().is_some());
        assert!(read_backup(&d, "gone").unwrap().is_none());
        assert!(d.join(NOTES_DIR).join("other.log").exists());
    }

    #[test]
    fn text_files_are_written_and_read() {
        let d = temp_dir("text");
        let file = d.join("todo.txt");
        let path = file.to_string_lossy().into_owned();
        write_text(&path, "one\r\ntwo").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"one\r\ntwo");
        assert_eq!(read_text(&path).unwrap(), "one\r\ntwo");
        fs::write(&file, b"\xEF\xBB\xBFbom").unwrap();
        assert_eq!(read_text(&path).unwrap(), "bom");
        fs::write(&file, b"a\0b\0\0\0").unwrap();
        assert!(read_text(&path).is_err());
        assert!(write_text("relative.txt", "x").is_err());
        assert!(write_text(&d.to_string_lossy(), "x").is_err());
        assert!(read_text(&d.join("missing.txt").to_string_lossy()).is_err());
    }
}
