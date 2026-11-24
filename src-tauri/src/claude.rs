//! Recent Claude Code conversations of a folder, read from Claude's own transcripts
//! (`<claude dir>\projects\<folder>\<id>.jsonl`). The format is Claude's and undocumented, so
//! everything here is read loosely: what can't be read is left out, never an error.

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// One conversation, as the menu shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// Last written, in milliseconds since 1970.
    pub modified: u64,
    /// Where it ran, relative to the folder that was asked about ("" for that folder itself),
    /// with `\` between names: a subfolder or a worktree (`.claude\worktrees\x`).
    pub subfolder: String,
}

/// How many transcripts are read at most. Folders next to this one (`app-old` next to `app`) share
/// the name's start, so some read files may turn out to be theirs.
const MAX_READ: usize = 40;
/// Claude writes the title again every few dozen lines, so the end of the file has it.
const TAIL: u64 = 256 * 1024;
const TAIL_MORE: u64 = 4 * 1024 * 1024;
/// The first records carry the folder Claude ran in.
const HEAD: u64 = 64 * 1024;
/// Claude shortens longer folder names and adds a hash.
const MAX_DIR_NAME: usize = 200;

/// The newest `limit` conversations started in `cwd` or a folder inside it, newest first.
/// `cwd` is as Claude writes it: a Windows path, or a Linux one for Claude inside WSL (`linux`).
pub fn recent(claude_dir: &Path, cwd: &str, linux: bool, limit: usize) -> Vec<Conversation> {
    let cwd = if linux { cwd.trim_end_matches('/') } else { cwd.trim_end_matches(['\\', '/']) };
    let name = project_dir_name(cwd);
    let prefix = &name[..name.len().min(MAX_DIR_NAME)];
    let Ok(dirs) = std::fs::read_dir(claude_dir.join("projects")) else { return Vec::new() };
    let mut files: Vec<(u64, std::path::PathBuf)> = dirs
        .flatten()
        .filter(|d| d.file_name().to_str().is_some_and(|n| n == name || n.starts_with(&format!("{prefix}-"))))
        .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
        .filter(|f| f.path().extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|f| {
            let modified = f.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            Some((modified, f.path()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .into_iter()
        .take(MAX_READ)
        .filter_map(|(modified, path)| {
            // The id goes on a command line (`--resume <id>`): only Claude's own uuids.
            let id = path.file_stem()?.to_str().filter(|s| is_uuid(s))?.to_string();
            let (title, ran_in) = read_transcript(&path)?;
            // Claude files a conversation under the folder it started in, and resumes it only there.
            let dir = path.parent()?.file_name()?.to_str()?;
            let started = project_dir_name(ran_in.trim_end_matches(['\\', '/']));
            (dir == started || started.len() > MAX_DIR_NAME && dir.starts_with(&started[..MAX_DIR_NAME])).then_some(())?;
            let subfolder = subfolder(&ran_in, cwd, linux)?;
            Some(Conversation { id, title, modified, subfolder })
        })
        .take(limit)
        .collect()
}

/// Claude's folder name for a project: every character but a letter or digit becomes `-`
/// (`C:\Projects\app` → `C--Projects-app`), counted in UTF-16 like Claude does.
pub fn project_dir_name(cwd: &str) -> String {
    cwd.chars().flat_map(|c| if c.is_ascii_alphanumeric() { vec![c] } else { vec!['-'; c.len_utf16()] }).collect()
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// `ran_in` relative to `cwd`, or None when it is somewhere else.
fn subfolder(ran_in: &str, cwd: &str, linux: bool) -> Option<String> {
    if linux {
        let ran_in = ran_in.trim_end_matches('/');
        if ran_in == cwd {
            return Some(String::new());
        }
        return ran_in.strip_prefix(&format!("{cwd}/")).and_then(|rest| inside(rest.replace('/', "\\")));
    }
    // Windows names are the same in any case; Claude may write either slash.
    let norm = |p: &str| p.replace('/', "\\").trim_end_matches('\\').to_string();
    let (ran_in, cwd) = (norm(ran_in), norm(cwd));
    if ran_in.eq_ignore_ascii_case(&cwd) {
        return Some(String::new());
    }
    let head = ran_in.get(..cwd.len() + 1)?;
    head.eq_ignore_ascii_case(&format!("{cwd}\\")).then(|| ran_in[cwd.len() + 1..].to_string()).and_then(inside)
}

/// A relative path that stays inside its folder: no empty, `.` or `..` steps.
fn inside(rest: String) -> Option<String> {
    rest.split('\\').all(|p| !p.is_empty() && p != "." && p != "..").then_some(rest)
}

/// The title of one transcript and the folder it started in (`cd` in Claude's shell changes the
/// folder later records name). None when it has neither a title nor a prompt (opened and closed
/// again: nothing to resume).
fn read_transcript(path: &Path) -> Option<(String, String)> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let started = first_cwd(&read_range(&mut file, 0, HEAD.min(len))?)?;
    let tail = read_range(&mut file, len.saturating_sub(TAIL), len)?;
    let mut info = Info::default();
    info.read(&tail, len > TAIL);
    if info.title().is_none() && len > TAIL {
        let more = read_range(&mut file, len.saturating_sub(TAIL_MORE), len.saturating_sub(TAIL))?;
        info.read(&more, len > TAIL_MORE);
    }
    Some((info.title()?, started))
}

/// The folder the first record that names one gives.
fn first_cwd(head: &[u8]) -> Option<String> {
    String::from_utf8_lossy(head).lines().find_map(|line| {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        v.get("cwd")?.as_str().filter(|s| !s.is_empty()).map(str::to_string)
    })
}

fn read_range(file: &mut File, from: u64, to: u64) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity((to - from) as usize);
    file.take(to - from).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// What the read parts of a transcript said. Later lines win, as they are the newer ones; parts
/// are read from the end backwards, so a value already found is kept.
#[derive(Default, Debug)]
struct Info {
    custom: Option<String>,
    name: Option<String>,
    ai: Option<String>,
    summary: Option<String>,
    prompt: Option<String>,
}

impl Info {
    /// What Claude's own `/resume` list would show: a name given by hand before a generated one.
    fn title(&self) -> Option<String> {
        [&self.custom, &self.name, &self.ai, &self.summary, &self.prompt].into_iter().flatten().next().cloned()
    }

    /// `cut`: the part starts within a line, so its first line is only the end of one.
    fn read(&mut self, part: &[u8], cut: bool) {
        let text = String::from_utf8_lossy(part);
        let mut lines: Vec<&str> = text.lines().collect();
        if cut && !lines.is_empty() {
            lines.remove(0);
        }
        for line in lines.into_iter().rev() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let text = |key: &str| v.get(key).and_then(|s| s.as_str()).map(one_line).filter(|s| !s.is_empty());
            let slot = match v.get("type").and_then(|t| t.as_str()) {
                Some("custom-title") => Some((&mut self.custom, text("customTitle"))),
                Some("agent-name") => Some((&mut self.name, text("agentName"))),
                Some("ai-title") => Some((&mut self.ai, text("aiTitle"))),
                Some("summary") => Some((&mut self.summary, text("summary"))),
                // A `!` command typed in Claude is a prompt too, but says little.
                Some("last-prompt") => Some((&mut self.prompt, text("lastPrompt").filter(|p| !p.starts_with('!')))),
                _ => None,
            };
            if let Some((slot, Some(value))) = slot {
                slot.get_or_insert(value);
            }
        }
    }
}

/// A title for one menu line: whitespace collapsed, at most 80 characters.
fn one_line(s: &str) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    match s.char_indices().nth(80) {
        Some((at, _)) => format!("{}…", s[..at].trim_end()),
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shellman-claude-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, project: &str, id: &str, lines: &[&str]) {
        let folder = dir.join("projects").join(project);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(format!("{id}.jsonl")), lines.join("\n") + "\n").unwrap();
        // Distinct times, in the order written.
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    #[test]
    fn folder_names_like_claude() {
        assert_eq!(project_dir_name(r"C:\Projects\app"), "C--Projects-app");
        assert_eq!(project_dir_name("/home/me/my_app.v2"), "-home-me-my-app-v2");
        assert_eq!(project_dir_name(r"C:\Työ"), "C--Ty-");
    }

    #[test]
    fn subfolders() {
        assert_eq!(subfolder(r"C:\Projects\app", r"C:\Projects\app", false), Some(String::new()));
        assert_eq!(subfolder(r"c:\projects\APP\", r"C:\Projects\app", false), Some(String::new()));
        assert_eq!(subfolder("C:/Projects/app/.claude/worktrees/x", r"C:\Projects\app", false), Some(r".claude\worktrees\x".into()));
        assert_eq!(subfolder(r"C:\Projects\app-old", r"C:\Projects\app", false), None);
        assert_eq!(subfolder("/home/me/app/sub/dir", "/home/me/app", true), Some(r"sub\dir".into()));
        assert_eq!(subfolder("/home/me/App", "/home/me/app", true), None);
        assert_eq!(subfolder("/home/me/app2", "/home/me/app", true), None);
        assert_eq!(subfolder("/home/me/app/../etc", "/home/me/app", true), None);
        assert_eq!(subfolder(r"C:\Projects\app\..\x", r"C:\Projects\app", false), None);
    }

    #[test]
    fn titles_by_preference_newest_first() {
        let mut info = Info::default();
        info.read(
            br#"{"type":"ai-title","aiTitle":"Old title"}
{"type":"user","cwd":"C:\\Projects\\app","message":{}}
{"type":"last-prompt","lastPrompt":"fix the   bug\nplease"}
{"type":"ai-title","aiTitle":"New title"}
{"type":"last-prompt","lastPrompt":"! git status"}
not json"#,
            false,
        );
        assert_eq!(info.title().as_deref(), Some("New title"));
        assert_eq!(info.prompt.as_deref(), Some("fix the bug please"));
        assert_eq!(first_cwd(b"{\"type\":\"summary\"}\nhalf a li\n{\"cwd\":\"/home/me/app\"}\n{\"cwd\":\"/home/me/app/sub\"}").as_deref(), Some("/home/me/app"));
        info.read(br#"{"type":"agent-name","agentName":"Named"}"#, false);
        assert_eq!(info.title().as_deref(), Some("Named"));
        info.read(br#"{"type":"custom-title","customTitle":"Renamed"}"#, false);
        assert_eq!(info.title().as_deref(), Some("Renamed"));
    }

    #[test]
    fn cut_first_line_is_skipped() {
        let mut info = Info::default();
        info.read(b"Title\":\"Half\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"Whole\"}", true);
        assert_eq!(info.title().as_deref(), Some("Whole"));
    }

    #[test]
    fn long_titles_are_shortened() {
        let t = one_line(&"word ".repeat(40));
        assert!(t.ends_with('…') && t.chars().count() <= 81);
    }

    #[test]
    fn recent_lists_this_folder_and_inside_it() {
        let dir = temp_dir("recent");
        let cwd = r"C:\Projects\app";
        let user = |cwd: &str| format!(r#"{{"type":"user","cwd":{}}}"#, serde_json::to_string(cwd).unwrap());
        write(&dir, "C--Projects-app", "00000000-0000-4000-8000-00000000000a", &[&user(cwd), r#"{"type":"ai-title","aiTitle":"First"}"#]);
        // Opened and closed: nothing to show.
        write(&dir, "C--Projects-app", "00000000-0000-4000-8000-0000000000ee", &[&user(cwd)]);
        write(&dir, "C--Projects-app--claude-worktrees-x", "00000000-0000-4000-8000-00000000000b", &[&user(r"C:\Projects\app\.claude\worktrees\x"), r#"{"type":"last-prompt","lastPrompt":"hello"}"#]);
        write(&dir, "C--Projects-app-old", "00000000-0000-4000-8000-00000000000c", &[&user(r"C:\Projects\app-old"), r#"{"type":"ai-title","aiTitle":"Other"}"#]);
        write(&dir, "C--Projects-other", "00000000-0000-4000-8000-00000000000d", &[&user(r"C:\Projects\other"), r#"{"type":"ai-title","aiTitle":"Other"}"#]);
        // Claude's shell went into a subfolder later: it still resumes where it started.
        write(&dir, "C--Projects-app", "00000000-0000-4000-8000-00000000000f", &[&user(cwd), &user(r"C:\Projects\app\src"), r#"{"type":"ai-title","aiTitle":"Moved"}"#]);
        // Not filed under the folder it started in: Claude couldn't resume it from there.
        write(&dir, "C--Projects-app", "00000000-0000-4000-8000-000000000001", &[&user(r"C:\Projects\app\src"), r#"{"type":"ai-title","aiTitle":"Odd"}"#]);
        let got: Vec<_> = recent(&dir, cwd, false, 10).into_iter().map(|c| (c.id, c.title, c.subfolder)).collect();
        assert_eq!(got, [("00000000-0000-4000-8000-00000000000f".into(), "Moved".into(), String::new()), ("00000000-0000-4000-8000-00000000000b".into(), "hello".into(), r".claude\worktrees\x".into()), ("00000000-0000-4000-8000-00000000000a".into(), "First".into(), String::new())]);
        assert_eq!(recent(&dir, cwd, false, 1).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_finds_titles_far_from_the_end() {
        let dir = temp_dir("far");
        let filler = format!(r#"{{"type":"assistant","text":"{}"}}"#, "x".repeat(1000));
        let mut lines = vec![r#"{"type":"user","cwd":"/home/me/app"}"#.to_string(), r#"{"type":"ai-title","aiTitle":"Far"}"#.to_string()];
        lines.extend(std::iter::repeat_n(filler, 400));
        let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
        write(&dir, "-home-me-app", "00000000-0000-4000-8000-00000000000a", &lines);
        write(&dir, "-home-me-app", "not-a-uuid", &lines);
        let got = recent(&dir, "/home/me/app/", true, 10);
        assert_eq!(got.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["Far"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
