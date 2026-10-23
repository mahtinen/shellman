//! git for linked folders that a team shares: what changed, commits of the folder's own files,
//! pull and push. git runs as the user (their credential manager, SSH keys and git config) with
//! an argument list, and never waits for a prompt: a background sync must fail, not hang.

use crate::collection::is_collection_file;
use crate::proc::output_within;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

/// Local commands.
pub(crate) const QUICK: Duration = Duration::from_secs(20);
/// A commit (the repository's hooks may take a while).
const COMMIT: Duration = Duration::from_secs(120);
/// Commands that talk to the remote.
const NETWORK: Duration = Duration::from_secs(120);

pub fn git_client() -> Result<PathBuf, String> {
    crate::shell::find_on_path("git.exe")
        .ok_or_else(|| "git isn't installed. Install Git for Windows (winget install Git.Git) to sync requests.".into())
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Changes inside the folder, relative to it.
    pub changes: Vec<Change>,
    /// A rebase or merge is unfinished (someone stopped one in a terminal).
    pub busy: bool,
    /// Uncommitted changes elsewhere in the repository (a pull would stash them for a moment).
    pub outside_changes: bool,
    /// Unpushed commits that touch files outside the folder (a push would publish them too).
    pub outside_commits: bool,
    /// The repository holds more than the folder (besides a README, a licence and git's own files).
    pub shared_repo: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    pub path: String,
    pub state: ChangeState,
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ChangeState {
    Modified,
    Added,
    Deleted,
    Untracked,
    Conflict,
}

/// Which side wins where a pull conflicts.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Prefer {
    #[default]
    Neither,
    Mine,
    Theirs,
}

/// How a sync (or fetch) went.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Outcome {
    Synced,
    /// The same lines changed here and on the remote. The pull was undone; local commits stay.
    Conflict { files: Vec<String> },
    NeedsLogin { message: String },
    NoUpstream { message: String },
    Offline { message: String },
    Failed { message: String },
}

pub(crate) struct Git {
    exe: PathBuf,
    folder: PathBuf,
    interactive: bool,
}

impl Git {
    pub(crate) fn new(folder: &Path, interactive: bool) -> Result<Git, String> {
        if !folder.is_dir() {
            return Err(format!("Folder not found: {}", folder.display()));
        }
        Ok(Git { exe: git_client()?, folder: folder.to_path_buf(), interactive })
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(&self.exe);
        cmd.arg("-C").arg(&self.folder).args(args);
        // Messages in English, so `classify` can read them; no terminal prompts (there is no terminal).
        cmd.env("LC_ALL", "C").env("LANGUAGE", "C").env("GIT_TERMINAL_PROMPT", "0");
        // Background status checks must not take the index lock from a git command the user runs.
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
        if !self.interactive {
            // Git Credential Manager may show a sign-in window for a sync the user started, not for
            // background ones.
            cmd.env("GCM_INTERACTIVE", "never");
        }
        cmd
    }

    pub(crate) fn run(&self, args: &[&str], limit: Duration) -> Result<Output, String> {
        output_within(self.command(args), limit)?.ok_or_else(|| format!("git {} took too long and was stopped", name(args)))
    }

    /// stdout of a command that must succeed.
    pub(crate) fn ok(&self, args: &[&str], limit: Duration) -> Result<String, String> {
        let out = self.run(args, limit)?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(message(&String::from_utf8_lossy(&out.stderr), name(args)))
        }
    }

    /// Whether a rebase or merge is unfinished.
    fn busy(&self) -> bool {
        ["rebase-merge", "rebase-apply", "MERGE_HEAD"].iter().any(|p| {
            self.ok(&["rev-parse", "--git-path", p], QUICK).is_ok_and(|out| {
                let path = PathBuf::from(out.trim());
                if path.is_absolute() { path } else { self.folder.join(path) }.exists()
            })
        })
    }
}

/// The git command in `args` (after any global options), for messages.
fn name<'a>(args: &[&'a str]) -> &'a str {
    args.iter().find(|a| !a.starts_with('-')).copied().unwrap_or("command")
}

const BUSY: &str = "A rebase or merge is unfinished in this repository. Finish or abort it in a terminal, then sync again.";

/// The useful lines of git's error output.
fn message(stderr: &str, command: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .collect();
    if lines.is_empty() {
        format!("git {command} failed")
    } else {
        lines.join("\n")
    }
}

/// git's error output of a failed command, for a message.
pub(crate) fn stderr_message(stderr: &[u8], command: &str) -> String {
    message(&String::from_utf8_lossy(stderr), command)
}

/// Turns a failed pull or push into what the sidebar shows.
fn classify(stderr: &str, command: &str) -> Outcome {
    let lower = stderr.to_lowercase();
    let message = message(stderr, command);
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    if has(&["authentication failed", "could not read username", "terminal prompts disabled", "permission denied (publickey", "access denied", "error: 403", "returned error: 401"]) {
        Outcome::NeedsLogin { message }
    } else if has(&["no tracking information", "has no upstream branch", "no upstream configured", "does not appear to be a git repository"]) {
        Outcome::NoUpstream { message }
    } else if has(&["could not resolve host", "could not resolve hostname", "failed to connect", "connection timed out", "network is unreachable", "took too long"]) {
        Outcome::Offline { message }
    } else {
        Outcome::Failed { message }
    }
}

/// `git status --porcelain=v2 --branch -z` → status. `prefix` is the folder within the repository
/// (`api/`); paths outside it are left out, the rest made relative to it.
pub fn parse_status(out: &str, prefix: &str) -> Status {
    let mut st = Status::default();
    let mut records = out.split('\0');
    let state_of = |xy: &str| {
        if xy.contains('D') {
            ChangeState::Deleted
        } else if xy.starts_with('A') {
            ChangeState::Added
        } else {
            ChangeState::Modified
        }
    };
    while let Some(r) = records.next() {
        if let Some(h) = r.strip_prefix("# ") {
            if let Some(b) = h.strip_prefix("branch.head ") {
                st.branch = Some(b.to_string()).filter(|b| b != "(detached)");
            } else if let Some(u) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(u.to_string());
            } else if let Some(ab) = h.strip_prefix("branch.ab ") {
                for n in ab.split_whitespace() {
                    if let Some(a) = n.strip_prefix('+') {
                        st.ahead = a.parse().unwrap_or(0);
                    } else if let Some(b) = n.strip_prefix('-') {
                        st.behind = b.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let fields: Vec<&str>;
        let (state, path) = match r.as_bytes().first() {
            Some(b'1') => {
                fields = r.splitn(9, ' ').collect();
                (state_of(fields.get(1).copied().unwrap_or("")), fields.get(8).copied())
            }
            Some(b'2') => {
                fields = r.splitn(10, ' ').collect();
                records.next(); // the old path of a rename
                (state_of(fields.get(1).copied().unwrap_or("")), fields.get(9).copied())
            }
            Some(b'u') => {
                fields = r.splitn(11, ' ').collect();
                (ChangeState::Conflict, fields.get(10).copied())
            }
            Some(b'?') => (ChangeState::Untracked, r.get(2..)),
            _ => continue,
        };
        if let Some(rel) = path.and_then(|p| p.strip_prefix(prefix)) {
            st.changes.push(Change { path: rel.to_string(), state });
        }
    }
    st
}

/// The folder's state in its repository; None when it isn't in one.
pub fn status(folder: &Path) -> Result<Option<Status>, String> {
    let g = Git::new(folder, false)?;
    let prefix = g.run(&["rev-parse", "--show-prefix"], QUICK)?;
    if !prefix.status.success() {
        return Ok(None);
    }
    let prefix = String::from_utf8_lossy(&prefix.stdout).trim().to_string();
    let out = g.ok(&["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."], QUICK)?;
    let mut st = parse_status(&out, &prefix);
    st.busy = g.busy();
    // Only Shellman's files are synced. Other tracked changes in the folder (it may be a project's
    // own folder) are other work, like changes elsewhere in the repository.
    let (ours, others): (Vec<Change>, Vec<Change>) = st.changes.into_iter().partition(|c| is_collection_file(&c.path));
    st.changes = ours;
    st.outside_changes = others.iter().any(|c| c.state != ChangeState::Untracked);
    let ours = |top: &str| top.strip_prefix(prefix.as_str()).is_some_and(is_collection_file);
    let names = |args: &[&str]| -> Vec<String> {
        g.ok(&[args, &[":(top)"]].concat(), QUICK)
            .map(|o| o.split(['\0', '\n']).filter(|f| !f.is_empty()).map(str::to_string).collect())
            .unwrap_or_default()
    };
    if !prefix.is_empty() && !st.outside_changes {
        let exclude = format!(":(top,exclude){prefix}");
        st.outside_changes = !names(&["status", "--porcelain", "-z", "--untracked-files=no", "--", exclude.as_str()]).is_empty();
    }
    if st.upstream.is_some() {
        st.outside_commits = names(&["log", "@{upstream}..HEAD", "--name-only", "--format=", "-z", "--"]).iter().any(|f| !ours(f));
    }
    st.shared_repo = names(&["ls-files", "--full-name", "-z", "--"]).iter().any(|f| !ours(f) && !is_repo_file(f));
    Ok(Some(st))
}

/// Files a repository of requests has besides the requests: a README, a licence, git's own.
fn is_repo_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    !lower.contains('/') && (lower.starts_with("readme") || lower.starts_with("license") || lower.starts_with("licence") || lower.starts_with(".git"))
}

/// Whether git ignores `rel` (e.g. `.env.local`); None outside a repository or without git.
pub fn is_ignored(folder: &Path, rel: &str) -> Option<bool> {
    let g = Git::new(folder, false).ok()?;
    match g.run(&["check-ignore", "-q", "--", rel], QUICK).ok()?.status.code() {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

/// Fetches, so `status` can tell what is incoming.
pub fn fetch(folder: &Path) -> Outcome {
    let g = match Git::new(folder, false) {
        Ok(g) => g,
        Err(message) => return Outcome::Failed { message },
    };
    match g.run(&["fetch", "--quiet"], NETWORK) {
        Ok(out) if out.status.success() => Outcome::Synced,
        Ok(out) => classify(&String::from_utf8_lossy(&out.stderr), "fetch"),
        Err(message) => classify(&message, "fetch"),
    }
}

/// Commits `paths` (relative to the folder, and only them) with `message`. Returns false when
/// they had nothing to commit. `.env.local` (and `.env.<environment>.local`) is never committed:
/// it holds personal secrets.
pub fn commit(folder: &Path, paths: &[String], message: &str) -> Result<bool, String> {
    if paths.is_empty() {
        return Ok(false);
    }
    for p in paths {
        let parts = crate::collection::check_rel(p)?;
        if parts.last().is_some_and(|n| crate::collection::is_local_env(n)) {
            return Err(format!("{p} holds personal values and is never committed"));
        }
        if !is_collection_file(p) {
            return Err(format!("{p} isn't a request or environment file, so Shellman doesn't commit it"));
        }
    }
    let message = message.trim();
    if message.is_empty() || message.contains('\0') {
        return Err("Invalid commit message".into());
    }
    let g = Git::new(folder, false)?;
    if g.busy() {
        return Err(BUSY.into());
    }
    // Literal paths: a name with `*` or `[` isn't a pattern for other files.
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    let literal = |args: &[&'static str]| -> Vec<&str> { [&["--literal-pathspecs"], args, paths.as_slice()].concat() };
    // --all with paths: deleted files are committed as deletions.
    g.ok(&literal(&["add", "--all", "--"]), QUICK)?;
    let staged = g.run(&literal(&["diff", "--cached", "--quiet", "--"]), QUICK)?;
    if staged.status.success() {
        return Ok(false);
    }
    g.ok(&[&["--literal-pathspecs", "commit", "--quiet", "-m", message, "--"], paths.as_slice()].concat(), COMMIT)?;
    Ok(true)
}

/// Pulls (rebasing local commits on top) and pushes local commits. A conflict undoes the pull and
/// keeps the local commits; `prefer` then settles it on the next sync.
pub fn sync(folder: &Path, prefer: Prefer, interactive: bool) -> Outcome {
    let g = match Git::new(folder, interactive) {
        Ok(g) => g,
        Err(message) => return Outcome::Failed { message },
    };
    // A rebase left unfinished is someone's work in progress: never abort it for them.
    if g.busy() {
        return Outcome::Failed { message: BUSY.into() };
    }
    let prefix = g.ok(&["rev-parse", "--show-prefix"], QUICK).map(|p| p.trim().to_string()).unwrap_or_default();
    for attempt in 0..2 {
        if let Err(outcome) = g.pull(prefer, &prefix) {
            return outcome;
        }
        let ahead = g.ok(&["rev-list", "--count", "@{upstream}..HEAD"], QUICK).map(|c| c.trim() != "0").unwrap_or(true);
        if !ahead {
            return Outcome::Synced;
        }
        match g.run(&["push", "--quiet"], NETWORK) {
            Ok(out) if out.status.success() => return Outcome::Synced,
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                // Someone pushed in between: pull their commits and push again, once.
                let rejected = stderr.contains("[rejected]") || stderr.contains("fetch first") || stderr.contains("non-fast-forward");
                if !rejected || attempt == 1 {
                    return classify(&stderr, "push");
                }
            }
            Err(message) => return classify(&message, "push"),
        }
    }
    Outcome::Synced
}

enum Pull {
    /// Conflicting files, relative to the repository.
    Conflict(Vec<String>),
    Failed(Outcome),
}

impl Git {
    /// Pulls with rebase. On a conflict the pull is undone; `prefer` then settles it, but only when
    /// all conflicting files are the folder's own: elsewhere in the repository it isn't Shellman's
    /// to choose a side.
    fn pull(&self, prefer: Prefer, prefix: &str) -> Result<(), Outcome> {
        let files = match self.pull_with(&[]) {
            Ok(()) => return Ok(()),
            Err(Pull::Conflict(files)) => files,
            Err(Pull::Failed(outcome)) => return Err(outcome),
        };
        let ours: Option<Vec<String>> = files.iter().map(|f| f.strip_prefix(prefix).filter(|r| is_collection_file(r)).map(str::to_string)).collect();
        let Some(ours) = ours else {
            return Err(Outcome::Failed {
                message: format!("Pulling conflicts with changes outside the requests ({}). Settle it in a terminal: git pull --rebase.", files.join(", ")),
            });
        };
        // In a rebase, "ours" is the remote side and "theirs" the local commits being replayed.
        let strategy = match prefer {
            Prefer::Neither => return Err(Outcome::Conflict { files: ours }),
            Prefer::Mine => "theirs",
            Prefer::Theirs => "ours",
        };
        match self.pull_with(&["-X", strategy]) {
            Ok(()) => Ok(()),
            // Not every conflict has lines to choose from (one side deleted the file).
            Err(Pull::Conflict(files)) => Err(Outcome::Conflict { files: files.iter().map(|f| f.strip_prefix(prefix).unwrap_or(f).to_string()).collect() }),
            Err(Pull::Failed(outcome)) => Err(outcome),
        }
    }

    /// Entries in `git stash list`.
    fn stashes(&self) -> usize {
        self.ok(&["stash", "list", "--format=%H"], QUICK).map(|o| o.lines().filter(|l| !l.is_empty()).count()).unwrap_or(0)
    }

    fn pull_with(&self, extra: &[&str]) -> Result<(), Pull> {
        let stashes = self.stashes();
        let out = self.run(&[&["pull", "--rebase", "--autostash", "--quiet"], extra].concat(), NETWORK).map_err(|m| Pull::Failed(classify(&m, "pull")))?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        if out.status.success() {
            // The pull went in, but changes set aside for it clash with it: git keeps them in a new
            // stash entry (or leaves the clash in the files). Git versions word this differently.
            let unmerged = self.ok(&["diff", "--name-only", "--diff-filter=U"], QUICK).is_ok_and(|o| !o.trim().is_empty());
            if stderr.contains("Applying autostash resulted in conflicts") || self.stashes() > stashes || unmerged {
                return Err(Pull::Failed(Outcome::Failed {
                    message: "Teammates' changes came in, but they clash with uncommitted changes in the repository. Those are safe in git's stash: settle them in a terminal (git status, git stash pop).".into(),
                }));
            }
            return Ok(());
        }
        if self.busy() {
            // This pull started the rebase (sync checks there was none before): undo it.
            let files = self
                .ok(&["diff", "--name-only", "--no-relative", "--diff-filter=U", "-z"], QUICK)
                .map(|o| o.split('\0').filter(|f| !f.is_empty()).map(str::to_string).collect())
                .unwrap_or_default();
            let _ = self.run(&["rebase", "--abort"], QUICK);
            return Err(Pull::Conflict(files));
        }
        Err(Pull::Failed(classify(&stderr, "pull")))
    }
}

// ---- read-only views for the Files pane ------------------------------------------------------

/// What a repository with no commits yet is compared with.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// What changed in a folder since `base`, for the Files pane.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub branch: Option<String>,
    /// The commit compared with ('' before the first commit).
    pub base: String,
    pub files: Vec<FileChange>,
    /// Paths git ignores, relative to the folder; folders end with `/`.
    pub ignored: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Relative to the folder, with `/`.
    pub path: String,
    /// Where a renamed file was.
    pub old_path: Option<String>,
    pub state: FileState,
    /// Lines added and removed; None for a binary file.
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflict,
}

/// A run of changed lines: `old_count` lines from `old_start` became `new_count` lines from
/// `new_start` (1-based; a count of 0 means the run is inserted or removed after that line).
#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
}

/// Paths of `-z` output, split.
fn nul_list(out: &str) -> Vec<String> {
    out.split('\0').filter(|f| !f.is_empty()).map(str::to_string).collect()
}

/// `git diff -z --name-status` → changes (paths as git printed them).
pub fn parse_name_status(out: &str) -> Vec<FileChange> {
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    let mut changes = Vec::new();
    while let Some(code) = fields.next() {
        let (state, old_path) = match code.as_bytes().first() {
            Some(b'R') => (FileState::Renamed, fields.next().map(str::to_string)),
            // A copy leaves the original where it was: the copy is a new file.
            Some(b'C') => {
                fields.next();
                (FileState::Added, None)
            }
            Some(b'A') => (FileState::Added, None),
            Some(b'D') => (FileState::Deleted, None),
            Some(b'U') => (FileState::Conflict, None),
            _ => (FileState::Modified, None),
        };
        let Some(path) = fields.next() else { break };
        changes.push(FileChange { path: path.to_string(), old_path, state, added: None, removed: None });
    }
    changes
}

/// `git diff -z --numstat` → (path, added, removed); None counts for a binary file.
pub fn parse_numstat(out: &str) -> Vec<(String, Option<u32>, Option<u32>)> {
    let mut fields = out.split('\0');
    let mut stats = Vec::new();
    while let Some(record) = fields.next() {
        let mut parts = record.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        // A rename has an empty path here, then the old and the new path.
        let path = if path.is_empty() {
            fields.next();
            fields.next().unwrap_or_default().to_string()
        } else {
            path.to_string()
        };
        stats.push((path, a.parse().ok(), r.parse().ok()));
    }
    stats
}

/// `git diff -U0` → its hunks.
pub fn parse_hunks(out: &str) -> Vec<Hunk> {
    let range = |s: &str| -> Option<(u32, u32)> {
        let (start, count) = s.split_once(',').unwrap_or((s, "1"));
        Some((start.parse().ok()?, count.parse().ok()?))
    };
    out.lines()
        .filter_map(|line| {
            let mut parts = line.strip_prefix("@@ ")?.split(' ');
            let (old_start, old_count) = range(parts.next()?.strip_prefix('-')?)?;
            let (new_start, new_count) = range(parts.next()?.strip_prefix('+')?)?;
            Some(Hunk { old_start, old_count, new_start, new_count })
        })
        .collect()
}

/// Read-only git for the Files pane. Diffs leave out the user's external diff tools, text
/// conversions and colours, so the output is git's own and can be read.
const DIFF: &[&str] = &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--relative", "-M"];

impl Git {
    /// The folder's place in its repository (`api/`), or None outside one.
    pub(crate) fn prefix(&self) -> Result<Option<String>, String> {
        let out = self.run(&["rev-parse", "--show-prefix"], QUICK)?;
        Ok(out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()))
    }

    /// `base` as a commit id: HEAD (or the empty tree before the first commit), or a commit given.
    ///
    /// `merge-base:<branch>` is where this branch left `<branch>` (so the diff is everything done on
    /// this branch, like a pull request), worked out again each time. `<commit>^` is the commit before
    /// one ("from this commit on"); before the first commit that is the empty tree.
    pub(crate) fn base(&self, base: &str) -> Result<String, String> {
        if let Some(branch) = base.strip_prefix("merge-base:") {
            if branch.is_empty() || branch.starts_with('-') || branch.contains(['\0', ' ', ':']) {
                return Err(format!("Invalid branch: {branch}"));
            }
            let out = self.run(&["merge-base", "HEAD", branch], QUICK)?;
            if !out.status.success() {
                return Err(format!("This branch has nothing in common with {branch}"));
            }
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        if base.is_empty() || base.starts_with('-') || base.contains(['\0', ' ', ':']) {
            return Err(format!("Invalid base: {base}"));
        }
        let spec = format!("{base}^{{commit}}");
        let out = self.run(&["rev-parse", "--verify", "--quiet", &spec], QUICK)?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else if base == "HEAD" {
            Ok(EMPTY_TREE.to_string())
        } else if base.strip_suffix('^').is_some_and(|c| self.run(&["rev-parse", "--verify", "--quiet", &format!("{c}^{{commit}}")], QUICK).is_ok_and(|o| o.status.success())) {
            // The parent of the first commit.
            Ok(EMPTY_TREE.to_string())
        } else {
            Err(format!("{base} isn't a commit in this repository"))
        }
    }
}

/// A commit for "Compare with".
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    /// Unix time.
    pub time: i64,
}

/// What a folder's changes can be compared with: recent commits of this branch, and other branches.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompareTargets {
    pub branch: Option<String>,
    /// The repository's main branch first (from origin/HEAD, or main/master), then recently used ones.
    pub branches: Vec<String>,
    pub commits: Vec<Commit>,
}

/// `git log --format=%H%x00%s%x00%an%x00%ct -z` → commits.
pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\0')
        .collect::<Vec<_>>()
        .chunks(4)
        .filter_map(|c| match c {
            [sha, subject, author, time] if sha.trim().len() >= 7 => {
                Some(Commit { sha: sha.trim().to_string(), subject: subject.to_string(), author: author.to_string(), time: time.trim().parse().unwrap_or(0) })
            }
            _ => None,
        })
        .collect()
}

pub fn compare_targets(folder: &Path) -> Result<Option<CompareTargets>, String> {
    let g = Git::new(folder, false)?;
    if g.prefix()?.is_none() {
        return Ok(None);
    }
    let branch = g.ok(&["symbolic-ref", "--short", "-q", "HEAD"], QUICK).ok().map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    let exists = |name: &str| g.run(&["rev-parse", "--verify", "--quiet", &format!("{name}^{{commit}}")], QUICK).is_ok_and(|o| o.status.success());
    let mut branches: Vec<String> = Vec::new();
    // The main branch: what origin/HEAD points at (local if there is one), else main or master.
    let origin_head = g.ok(&["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], QUICK).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let main = origin_head
        .map(|o| o.strip_prefix("origin/").filter(|l| exists(l)).map_or(o.clone(), str::to_string))
        .or_else(|| ["main", "master"].into_iter().find(|b| exists(b)).map(str::to_string));
    branches.extend(main);
    let recent = g.ok(&["for-each-ref", "--sort=-committerdate", "--count=12", "--format=%(refname:short)", "refs/heads"], QUICK).unwrap_or_default();
    for b in recent.lines().map(str::trim).filter(|b| !b.is_empty()) {
        if !branches.iter().any(|x| x == b) {
            branches.push(b.to_string());
        }
    }
    branches.retain(|b| Some(b) != branch.as_ref() && !b.starts_with('-'));
    let commits = g.ok(&["log", "-n", "20", "-z", "--format=%H%x00%s%x00%an%x00%ct"], QUICK).map(|o| parse_log(&o)).unwrap_or_default();
    Ok(Some(CompareTargets { branch, branches, commits }))
}

/// Every file git knows in the folder, tracked or new and not ignored; None outside a repository.
pub fn list_files(folder: &Path) -> Result<Option<Vec<String>>, String> {
    let g = Git::new(folder, false)?;
    if g.prefix()?.is_none() {
        return Ok(None);
    }
    let mut files = nul_list(&g.ok(&["ls-files", "-z", "--cached", "--others", "--exclude-standard"], QUICK)?);
    // A file with a conflict is listed once per side.
    files.dedup();
    Ok(Some(files))
}

/// The folder's changes since `base` (HEAD: what isn't committed), new files included; None
/// outside a repository.
pub fn changes(folder: &Path, base: &str) -> Result<Option<Changes>, String> {
    let g = Git::new(folder, false)?;
    if g.prefix()?.is_none() {
        return Ok(None);
    }
    let sha = g.base(base)?;
    let mut files = parse_name_status(&g.ok(&[DIFF, &["-z", "--name-status", sha.as_str(), "--"]].concat(), QUICK)?);
    let stats = parse_numstat(&g.ok(&[DIFF, &["-z", "--numstat", sha.as_str(), "--"]].concat(), QUICK)?);
    for f in &mut files {
        if let Some((_, a, r)) = stats.iter().find(|(p, ..)| *p == f.path) {
            (f.added, f.removed) = (*a, *r);
        }
    }
    for (i, path) in nul_list(&g.ok(&["ls-files", "-z", "--others", "--exclude-standard"], QUICK)?).into_iter().enumerate() {
        // Lines of new files are counted while that stays quick.
        let small = |p: &Path| i < 2000 && std::fs::metadata(p).is_ok_and(|m| m.len() <= 1 << 20);
        let file = folder.join(&path);
        let lines = small(&file).then(|| std::fs::read(&file).ok()).flatten().filter(|b| !b.contains(&0)).map(|b| String::from_utf8_lossy(&b).lines().count() as u32);
        files.push(FileChange { path, old_path: None, state: FileState::Untracked, added: lines, removed: lines.map(|_| 0) });
    }
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    let ignored = nul_list(&g.ok(&["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], QUICK)?);
    let branch = g.ok(&["symbolic-ref", "--short", "-q", "HEAD"], QUICK).ok().map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    Ok(Some(Changes { branch, base: if sha == EMPTY_TREE { String::new() } else { sha }, files, ignored }))
}

/// A file's contents at `base` (None when it wasn't there).
pub fn file_at(folder: &Path, path: &str, base: &str) -> Result<Option<crate::files::Content>, String> {
    crate::files::resolve(folder, "")?;
    if path.is_empty() || path.split('/').any(|p| p.is_empty() || p == "." || p == "..") || path.contains(['\0', '\\']) {
        return Err(format!("Invalid path: {path}"));
    }
    let g = Git::new(folder, false)?;
    let sha = g.base(base)?;
    if sha == EMPTY_TREE {
        return Ok(None);
    }
    let out = g.run(&["show", "--no-textconv", &format!("{sha}:./{path}")], QUICK)?;
    Ok(out.status.success().then(|| crate::files::text_content(&out.stdout)))
}

/// Where `path` differs from `base` (a rename compares with `old_path`).
pub fn hunks(folder: &Path, path: &str, old_path: Option<&str>, base: &str) -> Result<Vec<Hunk>, String> {
    let g = Git::new(folder, false)?;
    let sha = g.base(base)?;
    let paths: Vec<&str> = old_path.into_iter().chain([path]).collect();
    // Literal paths: a name with `*` or `[` isn't a pattern for other files.
    let out = g.ok(&[&["--literal-pathspecs"], DIFF, &["-U0", "--histogram", sha.as_str(), "--"], paths.as_slice()].concat(), QUICK)?;
    Ok(parse_hunks(&out))
}

/// A search in the Files pane.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    pub case_sensitive: bool,
    /// Whole words only.
    pub word: bool,
    /// The query is a regular expression (git's extended syntax).
    pub regex: bool,
    /// Globs separated by commas; `!` in front leaves those files out (`*.cs, !tests/**`).
    pub include: String,
    pub max: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    /// 1-based.
    pub line: u32,
    pub text: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    /// Stopped at `max` matches.
    pub truncated: bool,
}

/// Longest line kept of a match (minified code has very long ones).
const MAX_MATCH_TEXT: usize = 400;
const SEARCH: Duration = Duration::from_secs(30);

/// `include` as git pathspecs. A glob without `/` matches in every folder, as in VS Code.
pub fn include_pathspecs(include: &str) -> Vec<String> {
    include
        .split(',')
        .map(str::trim)
        .filter(|g| !g.is_empty() && !g.contains('\0'))
        .map(|g| {
            let (exclude, glob) = g.strip_prefix('!').map_or((false, g), |rest| (true, rest.trim()));
            let glob = glob.trim_start_matches("./").replace('\\', "/");
            let glob = if glob.contains('/') { glob } else { format!("**/{glob}") };
            let glob = if glob.ends_with('/') { format!("{glob}**") } else { glob };
            format!(":({}glob){glob}", if exclude { "exclude," } else { "" })
        })
        .collect()
}

/// One record of `git grep -n -z`: `path\0line\0text`.
fn parse_grep_record(record: &[u8]) -> Option<SearchMatch> {
    let mut parts = record.splitn(3, |b| *b == 0);
    let path = String::from_utf8_lossy(parts.next()?).into_owned();
    let line = std::str::from_utf8(parts.next()?).ok()?.parse().ok()?;
    let raw = String::from_utf8_lossy(parts.next()?);
    let raw = raw.strip_suffix('\r').unwrap_or(&raw);
    let text = match raw.char_indices().nth(MAX_MATCH_TEXT) {
        Some((cut, _)) => &raw[..cut],
        None => raw,
    };
    Some(SearchMatch { path, line, text: text.to_string() })
}

/// Searches the files in a folder with git: tracked ones and new ones git doesn't ignore, or (outside
/// a repository) every file that no `.gitignore` leaves out. Binary files are skipped. Stops at
/// `q.max` matches.
pub fn search(folder: &Path, q: &SearchQuery) -> Result<SearchResult, String> {
    use std::io::{BufRead, Read};
    if q.query.is_empty() || q.query.len() > 1000 || q.query.contains(['\0', '\n', '\r']) {
        return Err("Type what to search for (one line).".into());
    }
    let g = Git::new(folder, false)?;
    let in_repo = g.prefix()?.is_some();
    let mut args = vec!["grep", "-n", "-z", "-I", "--no-color"];
    args.extend(if in_repo { ["--untracked"].as_slice() } else { ["--no-index", "--exclude-standard"].as_slice() });
    if !q.case_sensitive {
        args.push("-i");
    }
    if q.word {
        args.push("-w");
    }
    // Explicit, so a grep.patternType in the user's git config doesn't change what the query means.
    args.push(if q.regex { "-E" } else { "-F" });
    let paths = include_pathspecs(&q.include);
    args.extend(["-e", q.query.as_str(), "--"]);
    args.extend(paths.iter().map(String::as_str));

    let mut cmd = g.command(&args);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::proc::no_window(&mut cmd);
    let job = std::sync::Arc::new(crate::proc::Job::new().ok_or("Could not start git")?);
    let mut child = cmd.spawn().map_err(|e| format!("Could not run git: {e}"))?;
    job.assign(&child);
    // A search that runs too long is stopped (with what it found so far).
    let (done, timeout) = std::sync::mpsc::channel::<()>();
    let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watchdog = {
        let (job, timed_out) = (job.clone(), timed_out.clone());
        std::thread::spawn(move || {
            if timeout.recv_timeout(SEARCH).is_err() {
                timed_out.store(true, std::sync::atomic::Ordering::Relaxed);
                job.kill();
            }
        })
    };
    let mut stderr = child.stderr.take().ok_or("git has no error output")?;
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let mut result = SearchResult { matches: Vec::new(), truncated: false };
    let stdout = std::io::BufReader::new(child.stdout.take().ok_or("git has no output")?);
    for record in stdout.split(b'\n') {
        let Ok(record) = record else { break };
        if result.matches.len() >= q.max.max(1) {
            result.truncated = true;
            job.kill();
            break;
        }
        if let Some(m) = parse_grep_record(&record) {
            result.matches.push(m);
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = done.send(());
    let _ = watchdog.join();
    let stderr = errors.join().unwrap_or_default();
    result.truncated |= timed_out.load(std::sync::atomic::Ordering::Relaxed);
    // 1: nothing found. Anything else (a bad regular expression) is git's message.
    if !result.truncated && !status.success() && status.code() != Some(1) {
        return Err(message(&stderr, "grep"));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_porcelain_status() {
        let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
                   1 .M N... 100644 100644 100644 a b api/users/list users.request.json\0\
                   1 A. N... 000000 100644 100644 0 b api/new.request.json\0\
                   1 .D N... 100644 100644 000000 a b api/gone.request.json\0\
                   2 R. N... 100644 100644 100644 a b R100 api/renamed.request.json\0api/old.request.json\0\
                   u UU N... 100644 100644 100644 100644 a b c api/conflict.request.json\0\
                   ? api/environments/dev.json\0\
                   1 .M N... 100644 100644 100644 a b README.md\0";
        let st = parse_status(out, "api/");
        assert_eq!((st.branch.as_deref(), st.upstream.as_deref(), st.ahead, st.behind), (Some("main"), Some("origin/main"), 2, 1));
        let changes: Vec<(&str, ChangeState)> = st.changes.iter().map(|c| (c.path.as_str(), c.state)).collect();
        assert_eq!(
            changes,
            [
                ("users/list users.request.json", ChangeState::Modified),
                ("new.request.json", ChangeState::Added),
                ("gone.request.json", ChangeState::Deleted),
                ("renamed.request.json", ChangeState::Modified),
                ("conflict.request.json", ChangeState::Conflict),
                ("environments/dev.json", ChangeState::Untracked),
            ]
        );
        assert_eq!(parse_status("# branch.head (detached)\0", "").branch, None);
    }

    #[test]
    fn classifies_failures() {
        assert!(matches!(classify("fatal: Authentication failed for 'https://example.com/x.git/'", "push"), Outcome::NeedsLogin { .. }));
        assert!(matches!(classify("fatal: could not read Username for 'https://example.com': terminal prompts disabled", "pull"), Outcome::NeedsLogin { .. }));
        assert!(matches!(classify("There is no tracking information for the current branch.", "pull"), Outcome::NoUpstream { .. }));
        assert!(matches!(classify("fatal: unable to access 'https://example.com/x.git/': Could not resolve host: example.com", "fetch"), Outcome::Offline { .. }));
        assert_eq!(classify("hint: use --force\nerror: something odd\n", "push"), Outcome::Failed { message: "error: something odd".into() });
    }

    // ---- real git: a bare repository as the remote and two clones ---------------------------

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new(git_client().unwrap()).arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// `remote.git` plus clones `a` and `b`, with an `api` folder holding one request.
    fn repos(name: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
        if git_client().is_err() {
            eprintln!("git not found, skipped");
            return None;
        }
        let root = std::env::temp_dir().join(format!("shellman-git-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "--quiet", "--bare", "-b", "main", "remote.git"]);
        for clone in ["a", "b"] {
            git(&root, &["clone", "--quiet", "remote.git", clone]);
            let dir = root.join(clone);
            for (k, v) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
                git(&dir, &["config", k, v]);
            }
        }
        let (a, b) = (root.join("a"), root.join("b"));
        fs::create_dir_all(a.join("api/users")).unwrap();
        fs::write(a.join("api/users/list.request.json"), "{\n  \"method\": \"GET\"\n}\n").unwrap();
        fs::write(a.join("api/.gitignore"), ".env.local\n").unwrap();
        git(&a, &["add", "."]);
        git(&a, &["commit", "--quiet", "-m", "init"]);
        git(&a, &["push", "--quiet", "-u", "origin", "main"]);
        git(&b, &["pull", "--quiet", "origin", "main"]);
        git(&b, &["branch", "--quiet", "--set-upstream-to=origin/main"]);
        Some((root, a.join("api"), b.join("api")))
    }

    #[test]
    fn real_commit_only_the_folder() {
        let Some((root, a, _)) = repos("commit") else { return };
        fs::write(a.join("users/list.request.json"), "{\n  \"method\": \"POST\"\n}\n").unwrap();
        fs::write(a.join("users/new.request.json"), "{}\n").unwrap();
        fs::write(a.join(".env.local"), "TOKEN=x\n").unwrap();
        fs::write(root.join("a/README.md"), "outside the folder\n").unwrap();
        assert_eq!(is_ignored(&a, ".env.local"), Some(true));
        assert_eq!(is_ignored(&a, "users/new.request.json"), Some(false));

        let st = status(&a).unwrap().unwrap();
        let changes: Vec<(&str, ChangeState)> = st.changes.iter().map(|c| (c.path.as_str(), c.state)).collect();
        assert_eq!(changes, [("users/list.request.json", ChangeState::Modified), ("users/new.request.json", ChangeState::Untracked)]);

        assert!(commit(&a, &[".env.local".into()], "x").is_err());
        assert!(commit(&a, &[".env.Prod.local".into()], "x").is_err());
        assert!(commit(&a, &["../README.md".into()], "x").is_err());
        let paths = vec!["users/list.request.json".to_string(), "users/new.request.json".to_string()];
        assert!(commit(&a, &paths, "Update users").unwrap());
        assert!(!commit(&a, &paths, "Update users").unwrap(), "nothing left to commit");
        let st = status(&a).unwrap().unwrap();
        assert_eq!((st.ahead, st.changes.len()), (1, 0));
        assert!(git(&root.join("a"), &["status", "--porcelain"]).contains("README.md"), "files outside the folder are left alone");

        fs::remove_file(a.join("users/new.request.json")).unwrap();
        assert!(commit(&a, &["users/new.request.json".into()], "Delete new").unwrap());
        assert_eq!(status(&std::env::temp_dir()).ok().flatten(), None, "not a repository");

        // Work elsewhere in the repository is seen, so automatic sync can stay out of its way.
        let repo = root.join("a");
        assert!(!status(&a).unwrap().unwrap().outside_changes, "a new file outside isn't in the way of a pull");
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "--quiet", "-m", "readme"]);
        let st = status(&a).unwrap().unwrap();
        assert!(!st.outside_changes && st.outside_commits && !st.shared_repo, "a README isn't other work: {st:?}");
        fs::write(repo.join("README.md"), "changed\n").unwrap();
        assert!(status(&a).unwrap().unwrap().outside_changes);
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(repo.join("src/main.rs"), "fn main() {}\n").unwrap();
        git(&repo, &["add", "src"]);
        git(&repo, &["commit", "--quiet", "-m", "code"]);
        assert!(status(&a).unwrap().unwrap().shared_repo);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn real_sync_between_two_clones() {
        let Some((root, a, b)) = repos("sync") else { return };
        fs::write(a.join("users/list.request.json"), "{\n  \"method\": \"PUT\"\n}\n").unwrap();
        commit(&a, &["users/list.request.json".into()], "Update list").unwrap();
        assert_eq!(sync(&a, Prefer::Neither, false), Outcome::Synced);

        assert_eq!(fetch(&b), Outcome::Synced);
        assert_eq!(status(&b).unwrap().unwrap().behind, 1);
        assert_eq!(sync(&b, Prefer::Neither, false), Outcome::Synced);
        assert!(fs::read_to_string(b.join("users/list.request.json")).unwrap().contains("PUT"));

        // Both change the same line: the pull is undone and the local commit kept.
        fs::write(a.join("users/list.request.json"), "{\n  \"method\": \"PATCH\"\n}\n").unwrap();
        commit(&a, &["users/list.request.json".into()], "A").unwrap();
        assert_eq!(sync(&a, Prefer::Neither, false), Outcome::Synced);
        fs::write(b.join("users/list.request.json"), "{\n  \"method\": \"DELETE\"\n}\n").unwrap();
        commit(&b, &["users/list.request.json".into()], "B").unwrap();
        assert_eq!(sync(&b, Prefer::Neither, false), Outcome::Conflict { files: vec!["users/list.request.json".into()] });
        let st = status(&b).unwrap().unwrap();
        assert!(!st.busy && st.ahead == 1 && st.changes.is_empty());
        assert!(fs::read_to_string(b.join("users/list.request.json")).unwrap().contains("DELETE"));

        assert_eq!(sync(&b, Prefer::Mine, false), Outcome::Synced);
        assert!(fs::read_to_string(b.join("users/list.request.json")).unwrap().contains("DELETE"));
        assert_eq!(sync(&a, Prefer::Neither, false), Outcome::Synced);
        assert!(fs::read_to_string(a.join("users/list.request.json")).unwrap().contains("DELETE"));

        // And the other way round: take the remote's version.
        fs::write(a.join("users/list.request.json"), "{\n  \"method\": \"GET\"\n}\n").unwrap();
        commit(&a, &["users/list.request.json".into()], "A2").unwrap();
        assert_eq!(sync(&a, Prefer::Neither, false), Outcome::Synced);
        fs::write(b.join("users/list.request.json"), "{\n  \"method\": \"HEAD\"\n}\n").unwrap();
        commit(&b, &["users/list.request.json".into()], "B2").unwrap();
        assert!(matches!(sync(&b, Prefer::Neither, false), Outcome::Conflict { .. }));
        assert_eq!(sync(&b, Prefer::Theirs, false), Outcome::Synced);
        assert!(fs::read_to_string(b.join("users/list.request.json")).unwrap().contains("GET"));

        git(&root.join("b"), &["checkout", "--quiet", "-b", "local-only"]);
        assert!(matches!(sync(&b, Prefer::Neither, false), Outcome::NoUpstream { .. }));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn real_sync_leaves_other_work_alone() {
        let Some((root, a, b)) = repos("other") else { return };
        let (repo_a, repo_b) = (root.join("a"), root.join("b"));
        fs::write(repo_a.join("README.md"), "one\n").unwrap();
        git(&repo_a, &["add", "README.md"]);
        git(&repo_a, &["commit", "--quiet", "-m", "readme"]);
        assert_eq!(sync(&a, Prefer::Neither, false), Outcome::Synced);
        assert_eq!(sync(&b, Prefer::Neither, false), Outcome::Synced);

        // Both changed the README: not Shellman's to settle, not even with a side chosen.
        fs::write(repo_a.join("README.md"), "two\n").unwrap();
        git(&repo_a, &["commit", "--quiet", "-am", "a"]);
        assert_eq!(sync(&a, Prefer::Neither, false), Outcome::Synced);
        fs::write(repo_b.join("README.md"), "three\n").unwrap();
        git(&repo_b, &["commit", "--quiet", "-am", "b"]);
        for prefer in [Prefer::Neither, Prefer::Mine] {
            let Outcome::Failed { message } = sync(&b, prefer, false) else { panic!("{prefer:?}") };
            assert!(message.contains("README.md"), "{message}");
            assert_eq!(fs::read_to_string(repo_b.join("README.md")).unwrap(), "three\n");
        }
        git(&repo_b, &["reset", "--quiet", "--hard", "origin/main"]);

        // An uncommitted change that clashes with the pull stays in git's stash, and is reported.
        fs::write(repo_a.join("README.md"), "four\n").unwrap();
        git(&repo_a, &["commit", "--quiet", "-am", "a2"]);
        assert_eq!(sync(&a, Prefer::Neither, false), Outcome::Synced);
        fs::write(repo_b.join("README.md"), "five\n").unwrap();
        let outcome = sync(&b, Prefer::Neither, false);
        let Outcome::Failed { message } = outcome else { panic!("{outcome:?}") };
        assert!(message.contains("stash"), "{message}");
        git(&repo_b, &["reset", "--quiet", "--hard"]);

        // A rebase someone left unfinished is theirs: sync and commit don't touch it.
        let rebase = PathBuf::from(git(&repo_b, &["rev-parse", "--git-path", "rebase-merge"]).trim());
        let rebase = if rebase.is_absolute() { rebase } else { repo_b.join(rebase) };
        fs::create_dir_all(&rebase).unwrap();
        assert!(status(&b).unwrap().unwrap().busy);
        assert_eq!(sync(&b, Prefer::Neither, false), Outcome::Failed { message: BUSY.into() });
        fs::write(b.join("users/list.request.json"), "{}\n").unwrap();
        assert_eq!(commit(&b, &["users/list.request.json".into()], "x"), Err(BUSY.into()));
        assert!(rebase.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn real_folder_with_other_files() {
        // The linked folder is a project's own: only Shellman's files are synced.
        let Some((root, a, _)) = repos("project") else { return };
        let repo = root.join("a");
        fs::write(a.join("main.rs"), "fn main() {}\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "--quiet", "-m", "code"]);
        assert!(status(&a).unwrap().unwrap().shared_repo);
        fs::write(a.join("main.rs"), "fn main() { }\n").unwrap();
        fs::write(a.join("notes.txt"), "untracked\n").unwrap();
        fs::write(a.join("users/list.request.json"), "{}\n").unwrap();
        let st = status(&a).unwrap().unwrap();
        let changes: Vec<&str> = st.changes.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(changes, ["users/list.request.json"]);
        assert!(st.outside_changes && st.outside_commits);
        assert!(commit(&a, &["main.rs".into()], "x").is_err());
        assert!(commit(&a, &["users/list.request.json".into()], "x").unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    // ---- the Files pane ---------------------------------------------------------------------

    #[test]
    fn reads_name_status_numstat_and_hunks() {
        let changes = parse_name_status("M\0src/a.ts\0R087\0old name.ts\0src/new name.ts\0A\0b.ts\0D\0c.ts\0UU\0d.ts\0C100\0e.ts\0f.ts\0");
        let got: Vec<(&str, Option<&str>, FileState)> = changes.iter().map(|c| (c.path.as_str(), c.old_path.as_deref(), c.state)).collect();
        assert_eq!(
            got,
            [
                ("src/a.ts", None, FileState::Modified),
                ("src/new name.ts", Some("old name.ts"), FileState::Renamed),
                ("b.ts", None, FileState::Added),
                ("c.ts", None, FileState::Deleted),
                ("d.ts", None, FileState::Conflict),
                ("f.ts", None, FileState::Added),
            ]
        );
        assert_eq!(
            parse_numstat("3\t1\tsrc/a.ts\0-\t-\tlogo.png\0\x32\t0\t\0old.ts\0new.ts\0"),
            [("src/a.ts".into(), Some(3), Some(1)), ("logo.png".into(), None, None), ("new.ts".into(), Some(2), Some(0))]
        );
        let diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3 +3 @@ fn x\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n+d\n@@ -20,3 +22,0 @@\n";
        let h = |a, b, c, d| Hunk { old_start: a, old_count: b, new_start: c, new_count: d };
        assert_eq!(parse_hunks(diff), [h(3, 1, 3, 1), h(10, 0, 11, 2), h(20, 3, 22, 0)]);
    }

    #[test]
    fn real_changes_of_a_project() {
        if git_client().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!("shellman-git-test-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("app/src")).unwrap();
        git(&root, &["init", "--quiet", "-b", "main"]);
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            git(&root, &["config", k, v]);
        }
        let app = root.join("app");
        fs::write(app.join("src/a.ts"), "one\ntwo\nthree\n").unwrap();
        fs::write(app.join("gone.ts"), "x\n").unwrap();
        fs::write(app.join(".gitignore"), "dist/\n").unwrap();
        fs::write(root.join("outside.txt"), "x\n").unwrap();

        // Before the first commit everything is new.
        let before = changes(&app, "HEAD").unwrap().unwrap();
        assert_eq!(before.base, "");
        assert_eq!(before.files.len(), 3);
        assert!(file_at(&app, "src/a.ts", "HEAD").unwrap().is_none());

        git(&root, &["add", "."]);
        git(&root, &["commit", "--quiet", "-m", "init"]);
        fs::write(app.join("src/a.ts"), "one\n2\nthree\nfour\n").unwrap();
        fs::remove_file(app.join("gone.ts")).unwrap();
        fs::write(app.join("new.ts"), "a\nb\n").unwrap();
        fs::create_dir_all(app.join("dist")).unwrap();
        fs::write(app.join("dist/out.js"), "x\n").unwrap();
        fs::write(root.join("outside.txt"), "changed\n").unwrap();

        let c = changes(&app, "HEAD").unwrap().unwrap();
        assert_eq!(c.branch.as_deref(), Some("main"));
        assert_eq!(c.base.len(), 40);
        let got: Vec<(&str, FileState, Option<u32>, Option<u32>)> = c.files.iter().map(|f| (f.path.as_str(), f.state, f.added, f.removed)).collect();
        assert_eq!(
            got,
            [("gone.ts", FileState::Deleted, Some(0), Some(1)), ("new.ts", FileState::Untracked, Some(2), Some(0)), ("src/a.ts", FileState::Modified, Some(2), Some(1))]
        );
        assert_eq!(c.ignored, ["dist/"]);
        let h = |a, b, c, d| Hunk { old_start: a, old_count: b, new_start: c, new_count: d };
        assert_eq!(hunks(&app, "src/a.ts", None, "HEAD").unwrap(), [h(2, 1, 2, 1), h(3, 0, 4, 1)]);
        assert_eq!(file_at(&app, "src/a.ts", "HEAD").unwrap(), Some(crate::files::Content::Text { text: "one\ntwo\nthree\n".into(), size: 14 }));
        assert!(file_at(&app, "../outside.txt", "HEAD").is_err());
        assert!(changes(&app, "--output=x").is_err());

        let mut all = list_files(&app).unwrap().unwrap();
        all.sort();
        assert_eq!(all, [".gitignore", "gone.ts", "new.ts", "src/a.ts"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn real_compare_with_a_branch_or_a_commit() {
        if git_client().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!("shellman-git-test-compare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "--quiet", "-b", "main"]);
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            git(&root, &["config", k, v]);
        }
        let commit = |file: &str, text: &str, msg: &str| {
            fs::write(root.join(file), text).unwrap();
            git(&root, &["add", "."]);
            git(&root, &["commit", "--quiet", "-m", msg]);
            git(&root, &["rev-parse", "HEAD"]).trim().to_string()
        };
        let first = commit("a.txt", "a\n", "first");
        git(&root, &["switch", "--quiet", "-c", "feature"]);
        let second = commit("b.txt", "b\n", "add b");
        commit("c.txt", "c\n", "add c");
        fs::write(root.join("d.txt"), "d\n").unwrap();
        let paths = |base: &str| changes(&root, base).unwrap().unwrap().files.into_iter().map(|f| f.path).collect::<Vec<_>>();

        assert_eq!(paths("HEAD"), ["d.txt"]);
        // Everything on this branch since it left main, committed or not.
        assert_eq!(paths("merge-base:main"), ["b.txt", "c.txt", "d.txt"]);
        assert_eq!(changes(&root, "merge-base:main").unwrap().unwrap().base, first);
        // From a commit on: that commit and everything after it.
        assert_eq!(paths(&format!("{second}^")), ["b.txt", "c.txt", "d.txt"]);
        assert_eq!(paths(&format!("{first}^")), ["a.txt", "b.txt", "c.txt", "d.txt"]);
        assert_eq!(hunks(&root, "b.txt", None, "merge-base:main").unwrap(), [Hunk { old_start: 0, old_count: 0, new_start: 1, new_count: 1 }]);
        assert!(changes(&root, "merge-base:-x").is_err());
        assert!(changes(&root, "merge-base:nope").is_err());

        let t = compare_targets(&root).unwrap().unwrap();
        assert_eq!(t.branch.as_deref(), Some("feature"));
        assert_eq!(t.branches, ["main"]);
        assert_eq!(t.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["add c", "add b", "first"]);
        assert!(t.commits[0].time > 0 && t.commits[0].author == "Test");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn include_globs_become_pathspecs() {
        assert_eq!(include_pathspecs(""), Vec::<String>::new());
        assert_eq!(
            include_pathspecs("*.cs, src/**/*.ts ,!tests/, ! *.min.js"),
            [":(glob)**/*.cs", ":(glob)src/**/*.ts", ":(exclude,glob)tests/**", ":(exclude,glob)**/*.min.js"]
        );
        assert_eq!(include_pathspecs(r"src\api\*.ts"), [":(glob)src/api/*.ts"]);
    }

    #[test]
    fn reads_grep_records() {
        assert_eq!(
            parse_grep_record(b"src/a b.ts\x0012\x00  let x = 1;\r"),
            Some(SearchMatch { path: "src/a b.ts".into(), line: 12, text: "  let x = 1;".into() })
        );
        assert_eq!(parse_grep_record(b"no line number"), None);
        let long = format!("a.js\x001\x00{}", "x".repeat(5000));
        assert_eq!(parse_grep_record(long.as_bytes()).unwrap().text.len(), MAX_MATCH_TEXT);
    }

    #[test]
    fn real_search() {
        if git_client().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!("shellman-git-test-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/user.cs"), "class UserService : IUserService {\r\n  public User GetById(int id) => null;\r\n}\r\n").unwrap();
        fs::write(root.join("src/app.ts"), "const userService = new UserService();\nuserService.getById(1);\n").unwrap();
        fs::write(root.join("logo.png"), b"\x89PNG\0\0UserService").unwrap();
        let q = |query: &str, case_sensitive: bool, word: bool, regex: bool, include: &str| SearchQuery {
            query: query.into(),
            case_sensitive,
            word,
            regex,
            include: include.into(),
            max: 100,
        };
        let found = |r: SearchResult| r.matches.iter().map(|m| format!("{}:{}", m.path, m.line)).collect::<Vec<_>>();

        // Outside a repository: every file, binaries skipped.
        assert_eq!(found(search(&root, &q("UserService", true, true, false, "")).unwrap()), ["src/app.ts:1", "src/user.cs:1"]);

        git(&root, &["init", "--quiet", "-b", "main"]);
        fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/out.js"), "UserService\n").unwrap();
        // In a repository: new files too (nothing is committed yet), ignored ones not.
        assert_eq!(found(search(&root, &q("userservice", false, false, false, "")).unwrap()), ["src/app.ts:1", "src/app.ts:2", "src/user.cs:1"]);
        assert_eq!(found(search(&root, &q("UserService", true, true, false, "*.cs")).unwrap()), ["src/user.cs:1"]);
        assert_eq!(found(search(&root, &q("UserService", true, true, false, "!*.cs")).unwrap()), ["src/app.ts:1"]);
        let r = search(&root, &q("Get[A-Z]\\w*\\(", true, false, true, "")).unwrap();
        assert_eq!(r.matches, [SearchMatch { path: "src/user.cs".into(), line: 2, text: "  public User GetById(int id) => null;".into() }]);
        assert!(search(&root, &q("--output=x", true, false, false, "")).unwrap().matches.is_empty());
        assert!(search(&root, &q("(unclosed", true, false, true, "")).is_err());
        assert!(search(&root, &q("", true, false, false, "")).is_err());
        let capped = search(&root, &SearchQuery { max: 1, ..q("user", false, false, false, "") }).unwrap();
        assert!(capped.truncated && capped.matches.len() == 1);
        let _ = fs::remove_dir_all(&root);
    }
}
