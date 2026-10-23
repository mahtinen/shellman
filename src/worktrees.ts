/**
 * Git worktrees for sessions: where a new one goes, what its branch is called, and which folder in it a
 * terminal opens in. Pure functions; worktreeDialog.ts asks and worktree.rs does the git work.
 */
import { baseName, pathKey } from './config';

/** Characters a folder name can't have, and spaces (kept out of paths that shells see). */
const BAD_FOLDER = /[\\/:*?"<>|\s]+/g;

/** The folder for a worktree named `name` of the repository at `top`: in `dir`, or next to the repository. */
export function worktreeFolder(top: string, dir: string, name: string): string {
  const repo = top.replace(/[\\/]+$/, '');
  const base = dir.trim().replace(/[\\/]+$/, '') || `${repo.slice(0, Math.max(repo.lastIndexOf('\\'), repo.lastIndexOf('/')))}\\${baseName(repo)}.worktrees`;
  const folder = name.replace(BAD_FOLDER, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'worktree';
  return `${base}\\${folder}`;
}

/** Why `name` can't be a git branch, or null when it can (git checks again). */
export function branchProblem(name: string): string | null {
  if (!name.trim()) return 'Give it a name.';
  if (/\s/.test(name)) return 'No spaces in a branch name (use - instead).';
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return 'That can\'t be a branch name.';
  if (/[~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|\/\./.test(name) || name === '@') return 'No ~ ^ : ? * [ \\ or .. in a branch name.';
  return null;
}

/** A short, free name for the next worktree of a session: `shop-1`, `shop-2` … */
export function defaultWorktreeName(sessionName: string, prefix: string, branches: string[]): string {
  const stem =
    sessionName
      // ä → a, é → e: letters git and every shell are happy with.
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'work';
  const taken = new Set(branches.map((b) => b.toLowerCase()));
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${stem}-${n}`.toLowerCase())) return `${stem}-${n}`;
}

/** Where a terminal of a session opens in a worktree: the same folder of the repository (`api/`). */
export function folderInWorktree(worktree: string, prefix: string): string {
  const sub = prefix.replace(/\/+$/, '').replace(/\//g, '\\');
  return sub ? `${worktree.replace(/[\\/]+$/, '')}\\${sub}` : worktree.replace(/[\\/]+$/, '');
}

/** `path` is `folder` or inside it. */
export function isInside(path: string, folder: string): boolean {
  const p = pathKey(path);
  const f = pathKey(folder);
  return !!f && (p === f || p.startsWith(`${f}\\`));
}
