/**
 * Git sync of linked folders. Per group: off, manual (a Sync button commits the folder's changes,
 * pulls and pushes) or automatic (saves are committed together a little later, and pushed unless
 * the group waits for Sync; teammates' changes are pulled while Shellman is in front).
 *
 * Git runs as the user, with their own credentials. Only the folder's files are committed, never
 * the personal `.env*.local` ones. Automatic sync stays out of the way of other work in the same
 * repository: it pauses rather than push someone's unrelated commits or stash their changes.
 */
import { api, type GitOutcome, type GitStatus } from './api';
import { collections } from './collections';
import { choiceDialog, toast } from './dialogs';
import { isLocalEnvFile } from './dotenv';
import { requestName } from './requestFile';
import { store } from './store';
import type { Group } from './types';

export type Problem =
  | { kind: 'conflict'; files: string[]; message: string }
  | { kind: 'needsLogin' | 'noUpstream' | 'offline' | 'failed' | 'branch' | 'busy' | 'noGit' | 'outside'; message: string };

export interface SyncState {
  /** null until known; false when the folder isn't in a git repository. */
  repo: boolean | null;
  status: GitStatus | null;
  running: 'sync' | 'fetch' | 'commit' | null;
  problem: Problem | null;
  lastFetch: number;
}

/** Changes that would be committed: the folder's, without the personal files. */
export function syncChanges(status: GitStatus | null): GitStatus['changes'] {
  return (status?.changes ?? []).filter((c) => !isLocalEnvFile(c.path.split('/').pop() ?? ''));
}

/**
 * Why syncing now would touch work outside the folder ('' = it wouldn't): unpushed commits there
 * would be pushed along, and uncommitted changes there stashed during the pull.
 */
export function outsideWork(status: GitStatus | null): string {
  if (!status) return '';
  const what = [status.outsideCommits ? 'commits outside the requests folder that are not pushed yet' : '', status.outsideChanges ? 'uncommitted changes outside it' : ''].filter(Boolean);
  return what.length ? `The repository has ${what.join(' and ')}.` : '';
}

/** The commit message for `paths`, from the group's template. */
export function commitMessage(template: string, paths: string[], env: string): string {
  const names = [...new Set(paths.map((p) => (p.toLowerCase().endsWith('.request.json') ? requestName(p) : p)))];
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  const folders = [...new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')).filter(Boolean))];
  const text = (template.trim() || 'Update {request}').replace(/\{request\}/g, list).replace(/\{folder\}/g, folders.join(', ')).replace(/\{env\}/g, env);
  return text.trim() || `Update ${list}`;
}

type Listener = (groupId: string) => void;

/** Problems that stop background work until the user syncs (asking again would only nag). */
const STOPS_BACKGROUND = new Set<Problem['kind']>(['needsLogin', 'conflict', 'branch', 'busy', 'noUpstream']);

class GitSync {
  private readonly states = new Map<string, SyncState>();
  private readonly listeners = new Set<Listener>();
  /** Saved paths waiting to be committed together, per group. */
  private readonly pending = new Map<string, Set<string>>();
  private readonly flushTimers = new Map<string, number>();
  private readonly statusTimers = new Map<string, number>();
  /** The git work queued per group: one thing at a time, so a save's commit never runs into a sync. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Opens a terminal in a folder (to sign in to git, or to look into a problem). */
  openTerminal: (folder: string) => void = () => undefined;

  /** Starts the background checks (once, from the app). */
  start(): void {
    window.setInterval(() => this.tick(false), 10_000);
    window.addEventListener('focus', () => this.tick(true));
    // A save, a pull or an edit elsewhere changes the folder: its git state too.
    collections.on((groupId) => this.queueStatus(groupId));
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(groupId: string): void {
    for (const fn of this.listeners) fn(groupId);
  }

  get(groupId: string): SyncState | undefined {
    return this.states.get(groupId);
  }

  private state(groupId: string): SyncState {
    let s = this.states.get(groupId);
    if (!s) {
      s = { repo: null, status: null, running: null, problem: null, lastFetch: 0 };
      this.states.set(groupId, s);
    }
    return s;
  }

  private group(groupId: string): Group | undefined {
    return store.config.groups.find((g) => g.id === groupId && g.folder);
  }

  private queueStatus(groupId: string): void {
    clearTimeout(this.statusTimers.get(groupId));
    this.statusTimers.set(groupId, window.setTimeout(() => void this.refresh(groupId), 400));
  }

  /** Reads the folder's git state. */
  async refresh(groupId: string): Promise<void> {
    const g = this.group(groupId);
    if (!g) return;
    const s = this.state(groupId);
    try {
      s.status = await api.gitStatus(g.folder);
      s.repo = s.status !== null;
      if (s.problem?.kind === 'noGit') s.problem = null;
      // Sync stays on the branch it was turned on in, and out of a rebase or merge someone is doing.
      if (s.status && g.sync !== 'off' && !s.status.branch)
        s.problem = { kind: 'branch', message: 'Sync is paused: the repository is not on a branch (detached HEAD).' };
      else if (s.status && g.syncBranch && s.status.branch && s.status.branch !== g.syncBranch && g.sync !== 'off')
        s.problem = { kind: 'branch', message: `Sync is paused: the folder is on branch "${s.status.branch}", not "${g.syncBranch}".` };
      else if (s.problem?.kind === 'branch') s.problem = null;
      if (s.status?.busy && g.sync !== 'off')
        s.problem = { kind: 'busy', message: 'Sync is paused: a rebase or merge is unfinished in this repository. Finish it in a terminal.' };
      else if (s.problem?.kind === 'busy') s.problem = null;
      if (s.problem?.kind === 'outside' && !outsideWork(s.status)) s.problem = null;
    } catch (e) {
      s.repo = false;
      s.status = null;
      s.problem = { kind: 'noGit', message: String(e) };
    }
    this.emit(groupId);
  }

  /**
   * Background checks, each group at its own pace, only while Shellman is in front: then a git
   * sign-in (or a 1Password prompt for an SSH key) never comes up out of nowhere.
   */
  private tick(focus: boolean): void {
    if (!focus && !document.hasFocus()) return;
    const now = Date.now();
    for (const g of store.config.groups) {
      if (!g.folder || g.sync === 'off') continue;
      const s = this.state(g.id);
      if (s.running || s.repo === false || (s.problem && STOPS_BACKGROUND.has(s.problem.kind))) continue;
      const every = g.syncCheck;
      const due = focus ? every !== 0 && now - s.lastFetch > 30_000 : every > 0 && now - s.lastFetch > every * 1000;
      if (due) void this.fetch(g);
    }
  }

  /** Runs `work` after the group's earlier git work. */
  private queue(groupId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(groupId) ?? Promise.resolve()).then(work, work);
    this.queues.set(groupId, next.catch(() => undefined));
    return next;
  }

  /** Looks for teammates' changes; an automatic group takes them in (and sends its own). */
  fetch(g: Group): Promise<void> {
    if (this.state(g.id).running) return Promise.resolve();
    return this.queue(g.id, () => this.fetchNow(g));
  }

  private async fetchNow(g: Group): Promise<void> {
    const s = this.state(g.id);
    s.running = 'fetch';
    s.lastFetch = Date.now();
    this.emit(g.id);
    const outcome = await api.gitFetch(g.folder).catch((e): GitOutcome => ({ state: 'failed', message: String(e) }));
    s.running = null;
    if (outcome.state === 'offline' || outcome.state === 'needsLogin') s.problem = { kind: outcome.state, message: outcome.message };
    else if (s.problem?.kind === 'offline') s.problem = null;
    await this.refresh(g.id);
    if (g.sync !== 'auto' || s.problem) return;
    // Saves from before a restart (or made elsewhere) go up like new ones.
    const waiting = syncChanges(s.status).map((c) => c.path);
    if (waiting.length && !this.pending.get(g.id)?.size) this.changed(g.id, waiting);
    const behind = s.status?.behind ?? 0;
    const ahead = g.syncPush === 'push' ? (s.status?.ahead ?? 0) : 0;
    if (behind > 0 || ahead > 0) await this.autoSync(g);
  }

  /**
   * Files Shellman just wrote in the folder. An automatic group commits them together once no
   * save has come for the group's delay, and then pushes (unless it waits for Sync).
   */
  changed(groupId: string, paths: string[]): void {
    const g = this.group(groupId);
    if (!g || g.sync !== 'auto' || !paths.length) return;
    const set = this.pending.get(groupId) ?? new Set<string>();
    for (const p of paths) set.add(p);
    this.pending.set(groupId, set);
    clearTimeout(this.flushTimers.get(groupId));
    this.flushTimers.set(groupId, window.setTimeout(() => void this.flush(groupId), g.syncDelay * 1000));
    this.emit(groupId);
  }

  /** Paths saved but not committed yet (automatic sync waits a little to group them). */
  waiting(groupId: string): number {
    return this.pending.get(groupId)?.size ?? 0;
  }

  private flush(groupId: string): Promise<void> {
    const paths = [...(this.pending.get(groupId) ?? [])];
    this.pending.delete(groupId);
    return this.queue(groupId, () => this.flushNow(groupId, paths));
  }

  private async flushNow(groupId: string, paths: string[]): Promise<void> {
    const g = this.group(groupId);
    if (!g || g.sync !== 'auto' || !paths.length) return;
    const s = this.state(g.id);
    await this.refresh(g.id);
    if (!s.repo || (s.problem && STOPS_BACKGROUND.has(s.problem.kind))) return;
    if (g.syncPush === 'push') return this.autoSync(g);
    // Commit only; Sync pushes. The files git sees as changed under these paths (a folder, a
    // renamed or deleted file).
    const files = syncChanges(s.status)
      .filter((c) => c.state !== 'conflict' && paths.some((p) => c.path === p || c.path.startsWith(`${p}/`)))
      .map((c) => c.path);
    if (!files.length) return;
    s.running = 'commit';
    this.emit(g.id);
    try {
      await api.gitCommit(g.folder, files, commitMessage(g.commitTemplate, files, collections.env(g)));
    } catch (e) {
      s.problem = { kind: 'failed', message: String(e) };
    }
    s.running = null;
    await this.refresh(g.id);
  }

  /** Automatic push and pull: only when that touches nothing but the folder. */
  private async autoSync(g: Group): Promise<void> {
    const s = this.state(g.id);
    await this.refresh(g.id);
    const outside = outsideWork(s.status);
    if (outside) {
      s.problem = { kind: 'outside', message: `Automatic sync is paused: ${outside} Commit and push those yourself, or press Sync to send everything.` };
      this.emit(g.id);
      return;
    }
    await this.syncNow(g, 'neither', false);
  }

  /**
   * Commits the folder's changes, pulls teammates' changes and pushes. `interactive`: started by the
   * user, so git may show a sign-in window, other work in the repository is asked about, and the
   * result is reported.
   */
  sync(g: Group, prefer: 'neither' | 'mine' | 'theirs' = 'neither', interactive = true): Promise<void> {
    return this.queue(g.id, () => this.syncNow(g, prefer, interactive));
  }

  private async syncNow(g: Group, prefer: 'neither' | 'mine' | 'theirs', interactive: boolean): Promise<void> {
    const s = this.state(g.id);
    clearTimeout(this.flushTimers.get(g.id));
    this.pending.delete(g.id);
    await this.refresh(g.id);
    if (!s.repo) {
      if (interactive) toast(s.problem?.message ?? `${g.folder} isn't in a git repository.`, 'error', 8000);
      return;
    }
    if (s.problem?.kind === 'branch' || s.problem?.kind === 'busy') {
      if (interactive) toast(s.problem.message, 'error', 8000);
      return;
    }
    const outside = outsideWork(s.status);
    if (outside && interactive) {
      const go = await choiceDialog(
        'Sync other work too?',
        `${outside} Syncing pushes those commits along with the requests, and sets uncommitted changes aside during the pull (they come back right after).`,
        [
          { label: 'Cancel', value: false },
          { label: 'Sync anyway', value: true, kind: 'primary' },
        ],
      );
      if (!go) return;
    }
    s.running = 'sync';
    s.problem = null;
    this.emit(g.id);
    let outcome: GitOutcome;
    try {
      const changes = syncChanges(s.status).filter((c) => c.state !== 'conflict');
      if (changes.length) {
        const paths = changes.map((c) => c.path);
        await api.gitCommit(g.folder, paths, commitMessage(g.commitTemplate, paths, collections.env(g)));
      }
      outcome = await api.gitSync(g.folder, prefer, interactive);
    } catch (e) {
      outcome = { state: 'failed', message: String(e) };
    }
    s.running = null;
    s.lastFetch = Date.now();
    s.problem =
      outcome.state === 'synced'
        ? null
        : outcome.state === 'conflict'
          ? { kind: 'conflict', files: outcome.files, message: `${outcome.files.join(', ')} changed here and on the server.` }
          : { kind: outcome.state, message: outcome.message };
    await this.refresh(g.id);
    if (interactive || outcome.state === 'conflict' || outcome.state === 'needsLogin') this.report(g, outcome);
  }

  private report(g: Group, outcome: GitOutcome): void {
    switch (outcome.state) {
      case 'synced':
        toast(`${g.name}: synced`);
        break;
      case 'conflict':
        void this.resolve(g, outcome.files);
        break;
      case 'needsLogin':
        toast(`${g.name}: git needs you to sign in. Click to open a terminal in the folder, then run git pull or git push once.`, 'error', 12000, () => this.openTerminal(g.folder));
        break;
      case 'noUpstream':
        toast(`${g.name}: this branch isn't on the server yet. Click to open a terminal and push it once (git push -u origin <branch>).`, 'error', 12000, () =>
          this.openTerminal(g.folder),
        );
        break;
      case 'offline':
        toast(`${g.name}: the git server can't be reached. Sync tries again later.`, 'error', 6000);
        break;
      default:
        toast(`${g.name}: sync failed: ${outcome.message}`, 'error', 12000, () => this.openTerminal(g.folder));
    }
  }

  /** Both sides changed the same request: keep this computer's version or the team's. */
  async resolve(g: Group, files: string[]): Promise<void> {
    const names = files.map((f) => (f.toLowerCase().endsWith('.request.json') ? requestName(f) : f)).join(', ');
    const answer = await choiceDialog(
      `${names} changed on both sides`,
      `Someone else changed ${files.length > 1 ? 'these' : 'this'} too, in the same place. Your changes are still committed here; nothing is lost yet. Which version should stay?`,
      [
        { label: 'Later', value: 'later' as const },
        { label: 'Use theirs', value: 'theirs' as const },
        { label: 'Keep mine', value: 'mine' as const, kind: 'primary' },
      ],
    );
    if (answer === 'mine' || answer === 'theirs') await this.sync(g, answer, true);
  }

  /** What the group row shows: a short label, its tooltip, and a look. */
  badge(g: Group): { text: string; title: string; kind: 'ok' | 'busy' | 'pending' | 'problem' | 'muted' } | null {
    if (!g.folder || g.sync === 'off') return null;
    const s = this.states.get(g.id);
    if (!s || s.repo === null) return { text: '…', title: 'Reading the git state…', kind: 'muted' };
    if (!s.repo) return { text: 'no git', title: s.problem?.message ?? `${g.folder} isn't in a git repository, so it can't sync.`, kind: 'muted' };
    if (s.running) return { text: s.running === 'fetch' ? '⟳' : 'syncing', title: s.running === 'fetch' ? 'Looking for changes…' : 'Syncing…', kind: 'busy' };
    if (s.problem) {
      const label = { conflict: 'conflict', needsLogin: 'sign in', noUpstream: 'no upstream', offline: 'offline', failed: 'failed', branch: 'paused', busy: 'paused', noGit: 'no git', outside: 'paused' }[s.problem.kind];
      return { text: label, title: `${s.problem.message}\n\nClick to sync.`, kind: s.problem.kind === 'offline' ? 'muted' : 'problem' };
    }
    const changes = syncChanges(s.status).length;
    const ahead = s.status?.ahead ?? 0;
    const behind = s.status?.behind ?? 0;
    const waiting = this.waiting(g.id);
    const parts = [changes ? `●${changes}` : '', ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean);
    const lines = [
      changes ? `${changes} change${changes > 1 ? 's' : ''} not committed yet${waiting ? ` (going up within ${g.syncDelay < 60 ? `${g.syncDelay} seconds` : `${g.syncDelay / 60} minute${g.syncDelay > 60 ? 's' : ''}`})` : ''}` : '',
      ahead ? `${ahead} commit${ahead > 1 ? 's' : ''} to push` : '',
      behind ? `${behind} commit${behind > 1 ? 's' : ''} from teammates to pull` : '',
    ].filter(Boolean);
    return {
      text: parts.join(' ') || '✓',
      title: `${lines.join('\n') || 'In sync'}${s.status?.branch ? `\nBranch: ${s.status.branch}` : ''}\n\nClick to sync now.`,
      kind: parts.length ? 'pending' : 'ok',
    };
  }
}

export const gitSync = new GitSync();
