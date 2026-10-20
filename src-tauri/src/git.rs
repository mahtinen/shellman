//! git for linked folders that a team shares: what changed, commits of the folder's own files,
//! pull and push. git runs as the user (their credential manager, SSH keys and git config) with
//! an argument list, and never waits for a prompt: a background sync must fail, not hang.

use crate::collection::is_collection_file;
use crate::proc::output_within;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;

/// Local commands.
const QUICK: Duration = Duration::from_secs(20);
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

struct Git {
    exe: PathBuf,
    folder: PathBuf,
    interactive: bool,
}

impl Git {
    fn new(folder: &Path, interactive: bool) -> Result<Git, String> {
        if !folder.is_dir() {
            return Err(format!("Folder not found: {}", folder.display()));
        }
        Ok(Git { exe: git_client()?, folder: folder.to_path_buf(), interactive })
    }

    fn run(&self, args: &[&str], limit: Duration) -> Result<Output, String> {
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
        output_within(cmd, limit)?.ok_or_else(|| format!("git {} took too long and was stopped", name(args)))
    }

    /// stdout of a command that must succeed.
    fn ok(&self, args: &[&str], limit: Duration) -> Result<String, String> {
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
}
