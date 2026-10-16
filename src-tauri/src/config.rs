//! Persistence of the user's configuration (saved sessions, settings) as JSON.
//!
//! The frontend owns the schema; this module only guarantees that writes are
//! atomic, that the previous version is kept as `config.json.bak`, and that a
//! corrupt file is moved aside instead of being silently overwritten.

use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "config.json";
/// Open tabs and splits, so they can be reopened on the next start.
pub const WORKSPACE_FILE: &str = "workspace.json";

pub fn load(dir: &Path) -> Result<Option<Value>, String> {
    load_file(dir, FILE_NAME)
}

pub fn save(dir: &Path, value: &Value) -> Result<(), String> {
    save_file(dir, FILE_NAME, value)
}

pub fn load_file(dir: &Path, name: &str) -> Result<Option<Value>, String> {
    let path = dir.join(name);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    // Editors like Notepad may add a UTF-8 byte-order mark, which JSON parsers reject.
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(v) => Ok(Some(v)),
        Err(_) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let aside = dir.join(format!("{name}.corrupt-{stamp}"));
            let _ = fs::rename(&path, &aside);
            Ok(None)
        }
    }
}

pub fn save_file(dir: &Path, name: &str, value: &Value) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let path = dir.join(name);
    let tmp: PathBuf = dir.join(format!("{name}.tmp"));
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let _ = fs::copy(&path, dir.join(format!("{name}.bak")));
    }
    fs::rename(&tmp, &path).map_err(|e| format!("Could not save {}: {e}", path.display()))
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
        assert_eq!(load(&d).unwrap(), None);
    }

    #[test]
    fn save_then_load_roundtrips_and_keeps_backup() {
        let d = temp_dir("roundtrip");
        save(&d, &json!({"v": 1})).unwrap();
        save(&d, &json!({"v": 2})).unwrap();
        assert_eq!(load(&d).unwrap(), Some(json!({"v": 2})));
        let bak: Value = serde_json::from_str(&fs::read_to_string(d.join("config.json.bak")).unwrap()).unwrap();
        assert_eq!(bak, json!({"v": 1}));
        assert!(!d.join("config.json.tmp").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn file_with_byte_order_mark_loads() {
        let d = temp_dir("bom");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(FILE_NAME), "\u{feff}{\"v\": 3}").unwrap();
        assert_eq!(load(&d).unwrap(), Some(json!({"v": 3})));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let d = temp_dir("corrupt");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(FILE_NAME), "{not json").unwrap();
        assert_eq!(load(&d).unwrap(), None);
        assert!(!d.join(FILE_NAME).exists());
        let moved = fs::read_dir(&d)
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("config.json.corrupt-"));
        assert!(moved);
        let _ = fs::remove_dir_all(&d);
    }
}
