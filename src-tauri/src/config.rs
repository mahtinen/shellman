//! Persistence of the user's configuration (saved sessions, settings) as JSON.
//!
//! The frontend owns the schema; this module only guarantees that writes are
//! atomic, that the previous version is kept as `config.json.bak`, and that a
//! corrupt file is moved aside (and the backup loaded instead) rather than being
//! silently replaced by defaults.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// What was loaded, and what the user should be told about it.
#[derive(Serialize, Debug, PartialEq)]
pub struct Loaded {
    pub value: Option<Value>,
    /// Set when the file was corrupt: where it went, and whether the backup was used.
    pub notice: Option<String>,
}

pub const FILE_NAME: &str = "config.json";
/// Open tabs and splits, so they can be reopened on the next start.
pub const WORKSPACE_FILE: &str = "workspace.json";

pub fn load(dir: &Path) -> Result<Loaded, String> {
    load_file(dir, FILE_NAME)
}

pub fn save(dir: &Path, value: &Value) -> Result<(), String> {
    save_file(dir, FILE_NAME, value)
}

fn parse(text: &str) -> Option<Value> {
    // Editors like Notepad may add a UTF-8 byte-order mark, which JSON parsers reject.
    serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok()
}

/// Loads `name`. A file that can't be read is an error (the caller must not overwrite it). A
/// corrupt one is moved aside and its `.bak` is loaded instead; the backup stays as it is until
/// the next save, so a good version is never lost.
pub fn load_file(dir: &Path, name: &str) -> Result<Loaded, String> {
    let path = dir.join(name);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded { value: None, notice: None }),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    if let Some(v) = parse(&text) {
        return Ok(Loaded { value: Some(v), notice: None });
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let aside = dir.join(format!("{name}.corrupt-{stamp}"));
    let moved = match fs::rename(&path, &aside) {
        Ok(()) => format!("{name} could not be read and was moved to {}.", aside.display()),
        Err(_) => format!("{name} could not be read."),
    };
    let backup = fs::read_to_string(dir.join(format!("{name}.bak"))).ok().and_then(|t| parse(&t));
    let notice = if backup.is_some() {
        format!("{moved} The previous version ({name}.bak) was loaded instead.")
    } else {
        format!("{moved} There was no usable backup, so Shellman started without it.")
    };
    Ok(Loaded { value: backup, notice: Some(notice) })
}

/// Distinguishes the temporary files of saves that overlap.
static NEXT_TMP: AtomicU32 = AtomicU32::new(0);

pub fn save_file(dir: &Path, name: &str, value: &Value) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let path = dir.join(name);
    // Unique per process and save, so overlapping saves never rename each other's half-written file.
    let tmp: PathBuf = dir.join(format!("{name}.{}-{}.tmp", std::process::id(), NEXT_TMP.fetch_add(1, Ordering::Relaxed)));
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let written = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not save {}: {e}", path.display()));
    }
    if path.exists() {
        let _ = fs::copy(&path, dir.join(format!("{name}.bak")));
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not save {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shellman-config-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn missing_file_loads_as_none() {
        let d = temp_dir("missing");
        assert_eq!(load(&d).unwrap(), Loaded { value: None, notice: None });
    }

    #[test]
    fn save_then_load_roundtrips_and_keeps_backup() {
        let d = temp_dir("roundtrip");
        save(&d, &json!({"v": 1})).unwrap();
        save(&d, &json!({"v": 2})).unwrap();
        assert_eq!(load(&d).unwrap().value, Some(json!({"v": 2})));
        let bak: Value = serde_json::from_str(&fs::read_to_string(d.join("config.json.bak")).unwrap()).unwrap();
        assert_eq!(bak, json!({"v": 1}));
        let leftovers = fs::read_dir(&d).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn file_with_byte_order_mark_loads() {
        let d = temp_dir("bom");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(FILE_NAME), "\u{feff}{\"v\": 3}").unwrap();
        assert_eq!(load(&d).unwrap().value, Some(json!({"v": 3})));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let d = temp_dir("corrupt");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(FILE_NAME), "{not json").unwrap();
        let loaded = load(&d).unwrap();
        assert_eq!(loaded.value, None);
        assert!(loaded.notice.unwrap().contains("no usable backup"));
        assert!(!d.join(FILE_NAME).exists());
        let moved = fs::read_dir(&d)
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("config.json.corrupt-"));
        assert!(moved);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_file_falls_back_to_the_backup_and_keeps_it() {
        let d = temp_dir("corrupt-bak");
        save(&d, &json!({"v": "good"})).unwrap();
        save(&d, &json!({"v": "newer"})).unwrap();
        fs::write(d.join(FILE_NAME), "{\"v\": \"newer\",}").unwrap(); // a hand edit with a trailing comma
        let loaded = load(&d).unwrap();
        assert_eq!(loaded.value, Some(json!({"v": "good"})));
        assert!(loaded.notice.unwrap().contains("config.json.bak"));
        // The next save must not replace the backup with the corrupt file or with defaults.
        save(&d, &json!({"v": "after"})).unwrap();
        let bak: Value = serde_json::from_str(&fs::read_to_string(d.join("config.json.bak")).unwrap()).unwrap();
        assert_eq!(bak, json!({"v": "good"}));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn overlapping_saves_do_not_collide() {
        let d = temp_dir("overlap");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let d = d.clone();
                std::thread::spawn(move || save(&d, &json!({ "v": i })))
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        assert!(load(&d).unwrap().value.is_some());
        let _ = fs::remove_dir_all(&d);
    }
}
