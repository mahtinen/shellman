//! Git worktrees for sessions: a folder (and branch) of its own for each Claude terminal, so several
//! can work on one repository without changing each other's files. Each runs git as the user, with an
//! argument list, and a worktree is only removed after the person was told what it would lose.

use crate::git::{Git, QUICK};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Creating a worktree checks out every file.
const ADD: Duration = Duration::from_secs(180);
/// Ignored files copied into a new worktree, at most (and each up to this size).
const MAX_COPIES: usize = 500;
const MAX_COPY_SIZE: u64 = 20 << 20;

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// A Windows path.
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    /// The repository's own folder (not a linked worktree).
    pub main: bool,
    pub locked: bool,
    /// Its folder is gone; `git worktree prune` forgets it.
    pub prunable: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// The top of the working tree the folder is in.
    pub top: String,
    /// The folder within it (`api/`), so a worktree opens at the same place.
    pub prefix: String,
    pub branch: Option<String>,
    pub worktrees: Vec<Worktree>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub path: String,
    pub branch: String,
    /// The commit it started from.
    pub base: String,
    /// Ignored files copied in.
    pub copied: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    /// Uncommitted changes, new files included.
    pub changes: u32,
    /// Commits on no other branch: deleting the branch loses them.
    pub only_here: u32,
}

fn windows(path: &str) -> String {
    path.trim().replace('/', "\\")
}

/// A folder's full, real path (no 8.3 short names like RUNNER~1, no `\\?\`), as git and shells write it.
fn full_path(path: &Path) -> Option<String> {
    let real = fs::canonicalize(path).ok()?.to_string_lossy().into_owned();
    Some(match real.strip_prefix(r"\\?\UNC\") {
        Some(unc) => format!(r"\\{unc}"),
        None => real.strip_prefix(r"\\?\").unwrap_or(&real).to_string(),
    })
}

/// The same folder, however it is written (case, / or \, a short name); a folder that is gone by its text.
fn same_folder(a: &str, b: &str) -> bool {
    let key = |p: &str| windows(p).trim_end_matches('\\').to_lowercase();
    match (full_path(Path::new(a)), full_path(Path::new(b))) {
        (Some(x), Some(y)) => key(&x) == key(&y),
        _ => key(a) == key(b),
    }
}

/// `git worktree list --porcelain` → worktrees (the first is the main one).
pub fn parse_worktrees(out: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for line in out.lines().chain([""]) {
        if line.is_empty() {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "worktree" => cur = Some(Worktree { path: windows(value), branch: None, head: String::new(), main: list.is_empty(), locked: false, prunable: false }),
            "HEAD" => cur.iter_mut().for_each(|w| w.head = value.to_string()),
            "branch" => cur.iter_mut().for_each(|w| w.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string())),
            "locked" => cur.iter_mut().for_each(|w| w.locked = true),
            "prunable" => cur.iter_mut().for_each(|w| w.prunable = true),
            _ => {}
        }
    }
    list
}

/// The repository `folder` is in, and its worktrees; None outside a repository.
pub fn info(folder: &Path) -> Result<Option<RepoInfo>, String> {
    let g = Git::new(folder, false)?;
    let Some(prefix) = g.prefix()? else { return Ok(None) };
    let top = windows(&g.ok(&["rev-parse", "--show-toplevel"], QUICK)?);
    let worktrees = parse_worktrees(&g.ok(&["worktree", "list", "--porcelain"], QUICK)?);
    let branch = g.ok(&["symbolic-ref", "--short", "-q", "HEAD"], QUICK).ok().map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    Ok(Some(RepoInfo { top, prefix, branch, worktrees }))
}

/// A name git takes for a new branch (and that can't be read as an option).
fn check_branch(g: &Git, branch: &str) -> Result<(), String> {
    let ok = !branch.is_empty() && !branch.starts_with('-') && branch.len() <= 200 && g.run(&["check-ref-format", "--branch", branch], QUICK).is_ok_and(|o| o.status.success());
    if !ok {
        return Err(format!("\"{branch}\" can't be a branch name (no spaces, ~ ^ : ? * [ \\ or ..)."));
    }
    let exists = g.run(&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], QUICK).is_ok_and(|o| o.status.success());
    if exists {
        return Err(format!("A branch {branch} exists already: choose another name."));
    }
    Ok(())
}

/// Creates a worktree at `path` on a new branch `branch` from `from` (a branch or commit), then copies
/// the files git ignores that match `copy` (globs, like `.env.local`) from the repository into it.
pub fn add(folder: &Path, path: &str, branch: &str, from: &str, copy: &str) -> Result<Added, String> {
    let g = Git::new(folder, false)?;
    let top = PathBuf::from(windows(&g.ok(&["rev-parse", "--show-toplevel"], QUICK)?));
    check_branch(&g, branch)?;
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err(format!("Not a full path: {path}"));
    }
    if target.exists() {
        return Err(format!("{path} exists already: choose another name or folder."));
    }
    let base = g.base(from).map_err(|_| format!("{from} isn't a branch or commit here"))?;
    if base.len() != 40 {
        return Err("The repository has no commits yet: commit something first.".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let path_arg = target.to_string_lossy().into_owned();
    let out = g.run(&["worktree", "add", "-b", branch, "--", &path_arg, &base], ADD)?;
    if !out.status.success() {
        return Err(crate::git::stderr_message(&out.stderr, "worktree add"));
    }
    let copied = copy_ignored(&top, &target, copy);
    // As git and the shell will report it, so terminals in it are known to be in it.
    let path = full_path(&target).unwrap_or(path_arg);
    Ok(Added { path, branch: branch.to_string(), base, copied })
}

/// Copies the ignored files matching `globs` from the repository at `top` into the worktree at `to`.
fn copy_ignored(top: &Path, to: &Path, globs: &str) -> usize {
    let specs = crate::git::include_pathspecs(globs);
    if specs.iter().all(|s| s.starts_with(":(exclude")) {
        return 0;
    }
    let Ok(g) = Git::new(top, false) else { return 0 };
    let args: Vec<&str> = ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--"].into_iter().chain(specs.iter().map(String::as_str)).collect();
    let Ok(out) = g.ok(&args, QUICK) else { return 0 };
    let mut copied = 0;
    for rel in out.split('\0').filter(|f| !f.is_empty()).take(MAX_COPIES) {
        // Only ordinary names inside the repository.
        if rel.split('/').any(|p| p.is_empty() || p == "." || p == "..") {
            continue;
        }
        let from = top.join(rel);
        let dest = to.join(rel);
        let small = fs::symlink_metadata(&from).is_ok_and(|m| m.is_file() && m.len() <= MAX_COPY_SIZE);
        if small && !dest.exists() && dest.parent().is_some_and(|d| fs::create_dir_all(d).is_ok()) && fs::copy(&from, &dest).is_ok() {
            copied += 1;
        }
    }
    copied
}

/// What removing the worktree at `path` would lose.
pub fn status(path: &Path) -> Result<Status, String> {
    let g = Git::new(path, false)?;
    let changes = g.ok(&["status", "--porcelain", "-z", "--untracked-files=all"], QUICK)?;
    // A rename takes two entries; close enough for "n changes".
    let changes = changes.split('\0').filter(|r| r.len() > 3).count() as u32;
    let branch = g.ok(&["symbolic-ref", "--short", "-q", "HEAD"], QUICK).ok().map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    // For --branches the pattern is the name without refs/heads/.
    let exclude = branch.as_ref().map(|b| format!("--exclude={b}"));
    let mut args = vec!["rev-list", "--count", "HEAD", "--not"];
    args.extend(exclude.as_deref());
    args.extend(["--branches", "--remotes"]);
    let only_here = g.ok(&args, QUICK).ok().and_then(|n| n.trim().parse().ok()).unwrap_or(0);
    Ok(Status { branch, changes, only_here })
}

/// Removes the linked worktree at `path` (`force`: with its uncommitted changes), and its branch when
/// `delete_branch` (`force`: also with commits that are on no other branch).
pub fn remove(folder: &Path, path: &str, delete_branch: bool, force: bool) -> Result<(), String> {
    let g = Git::new(folder, false)?;
    let list = parse_worktrees(&g.ok(&["worktree", "list", "--porcelain"], QUICK)?);
    let Some(wt) = list.iter().find(|w| same_folder(&w.path, path)) else {
        return Err(format!("{path} isn't a worktree of this repository"));
    };
    if wt.main {
        return Err("That is the repository's own folder, not a worktree.".into());
    }
    // From the main folder: a worktree can't remove itself.
    let main = Git::new(Path::new(&list[0].path), false)?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    let path_arg = wt.path.clone();
    args.extend(["--", path_arg.as_str()]);
    let out = main.run(&args, ADD)?;
    if !out.status.success() && !wt.prunable {
        let msg = crate::git::stderr_message(&out.stderr, "worktree remove");
        return Err(if msg.to_lowercase().contains("permission denied") || msg.contains("Invalid argument") {
            format!("{msg}\nA program may still be using a file in it (a terminal or an editor). Close it and try again.")
        } else {
            msg
        });
    }
    let _ = main.run(&["worktree", "prune"], QUICK);
    if let (true, Some(branch)) = (delete_branch, wt.branch.as_deref()) {
        if branch.starts_with('-') {
            return Err(format!("Invalid branch: {branch}"));
        }
        main.ok(&["branch", if force { "-D" } else { "-d" }, "--", branch], QUICK)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn reads_worktree_list() {
        let out = "worktree C:/Projects/shop\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/Projects/shop.worktrees/fix\nHEAD def\nbranch refs/heads/claude/fix\nlocked\n\nworktree C:/gone\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n";
        let list = parse_worktrees(out);
        assert_eq!(list.len(), 3);
        assert_eq!(
            list[0],
            Worktree { path: r"C:\Projects\shop".into(), branch: Some("main".into()), head: "abc".into(), main: true, locked: false, prunable: false }
        );
        assert_eq!((list[1].branch.as_deref(), list[1].locked, list[1].main), (Some("claude/fix"), true, false));
        assert_eq!((list[2].branch.as_deref(), list[2].prunable), (None, true));
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new(crate::git::git_client().unwrap()).arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// The 8.3 short form of a folder's path (the path itself when the disk has none).
    fn short_name(dir: &Path) -> String {
        use std::os::windows::process::CommandExt;
        // Raw: cmd reads its own quotes, which Rust's argument quoting would escape.
        let out = Command::new("cmd").raw_arg(format!("/C for %I in (\"{}\") do @echo %~sI", dir.display())).output().unwrap();
        let short = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if short.is_empty() { dir.to_string_lossy().into_owned() } else { short }
    }

    #[test]
    fn real_worktree_add_status_remove() {
        if crate::git::git_client().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!("shellman-worktree-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let repo = root.join("shop");
        fs::create_dir_all(repo.join("api")).unwrap();
        git(&repo, &["init", "--quiet", "-b", "main"]);
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            git(&repo, &["config", k, v]);
        }
        fs::write(repo.join("api/app.ts"), "export {};\n").unwrap();
        fs::write(repo.join(".gitignore"), ".env.local\ndist/\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "--quiet", "-m", "init"]);
        fs::write(repo.join(".env.local"), "TOKEN=x\n").unwrap();
        fs::create_dir_all(repo.join("dist")).unwrap();
        fs::write(repo.join("dist/out.js"), "x\n").unwrap();

        let i = info(&repo.join("api")).unwrap().unwrap();
        assert_eq!((i.prefix.as_str(), i.branch.as_deref(), i.worktrees.len()), ("api/", Some("main"), 1));

        let path = root.join("shop.worktrees").join("fix");
        // Written with the 8.3 short name of the temp folder where there is one (C:\Users\RUNNER~1 on
        // CI): git reports the long name, and both must be known as the same worktree.
        let path_s = format!(r"{}\shop.worktrees\fix", short_name(&root));
        assert!(add(&repo, &path_s, "bad name", "main", "").is_err());
        assert!(add(&repo, &path_s, "-x", "main", "").is_err());
        assert!(add(&repo, &path_s, "main", "main", "").is_err(), "an existing branch");
        assert!(add(&repo, &path_s, "claude/fix", "--output=x", "").is_err());
        let added = add(&repo.join("api"), &path_s, "claude/fix", "main", ".env.local").unwrap();
        assert_eq!((added.branch.as_str(), added.base.len(), added.copied), ("claude/fix", 40, 1));
        assert_eq!(added.path.to_lowercase(), full_path(&path).unwrap().to_lowercase(), "the full path, not a short name");
        assert!(!added.path.contains('~'));
        assert_eq!(fs::read_to_string(path.join(".env.local")).unwrap(), "TOKEN=x\n");
        assert!(!path.join("dist").exists());
        assert!(path.join("api/app.ts").is_file());
        assert!(add(&repo, &path_s, "claude/other", "main", "").is_err(), "the folder exists");
        assert_eq!(info(&repo).unwrap().unwrap().worktrees.len(), 2);

        // Work in it: a commit only on this branch, and an uncommitted change.
        fs::write(path.join("api/app.ts"), "export const x = 1;\n").unwrap();
        git(&path, &["commit", "--quiet", "-am", "work"]);
        fs::write(path.join("api/new.ts"), "export {};\n").unwrap();
        assert_eq!(status(&path).unwrap(), Status { branch: Some("claude/fix".into()), changes: 1, only_here: 1 });

        // Without force, git keeps uncommitted work; with it, the folder and branch go.
        assert!(remove(&repo, &path_s, true, false).is_err());
        assert!(path.exists());
        assert!(remove(&repo, &repo.to_string_lossy(), false, true).is_err(), "the main folder");
        remove(&repo, &path_s, true, true).unwrap();
        assert!(!path.exists());
        assert!(git(&repo, &["branch", "--list", "claude/fix"]).trim().is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
