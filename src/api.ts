import { Channel, invoke } from '@tauri-apps/api/core';
import type { ConnectionRequest } from './connection';
import type { WorkspaceSnapshot } from './snapshot';
import type { Config, ShellProfile, SystemInfo } from './types';
import type { XshFile } from './xshell';

export type PtyMessage = string | { exit: number | null };

/** A loaded file. `notice` says it was corrupt (and whether its backup was used instead). */
export interface Loaded<T> {
  value: T | null;
  notice: string | null;
}

export interface SpawnRequest {
  /** Null when connecting to a remote host. */
  shell: ShellProfile | null;
  connection?: ConnectionRequest;
  /** ssh.exe to use for SSH connections; '' = Windows OpenSSH. */
  sshPath?: string;
  cwd: string;
  command: string | null;
  env: Record<string, string>;
  shellIntegration: boolean;
  cols: number;
  rows: number;
}

/** A key the SSH agent offers; 1Password puts the item's name in `comment`. */
export interface AgentKey {
  kind: string;
  comment: string;
  publicKey: string;
}

/** `running` is false when no SSH agent (1Password, Windows ssh-agent) is serving the pipe. */
export interface AgentKeys {
  running: boolean;
  keys: AgentKey[];
}

export interface HttpHeader {
  name: string;
  value: string;
}

export type HttpBody =
  | { type: 'none' }
  | { type: 'raw'; text: string }
  | { type: 'form'; fields: { name: string; value: string }[] }
  | { type: 'multipart'; fields: { name: string; value: string; file?: boolean }[] }
  | { type: 'file'; path: string };

/**
 * A request for curl. Variables that aren't secret are already filled in; `{{NAME}}` left in a
 * value refers to one of `secrets`, which curl fills in itself (an `op://` value via 1Password).
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers?: HttpHeader[];
  /** Basic authentication, `name:password`. */
  user?: string | null;
  body?: HttpBody;
  followRedirects?: boolean;
  timeoutSeconds?: number;
  insecure?: boolean;
  proxy?: { mode: 'none' } | { mode: 'environment' } | { mode: 'custom'; url: string };
  secrets?: { name: string; value: string }[];
  /** Requests with the same key share their cookies. */
  cookieJar?: string | null;
  curlPath?: string;
  opPath?: string;
  /** The 1Password account ('' = 1Password's default). */
  opAccount?: string;
  maxBodyBytes?: number;
}

export interface HttpResult {
  /** 0 when a response arrived (whatever its status); else curl's error code. */
  curlExit: number;
  error: string | null;
  status: number;
  httpVersion: string;
  headers: HttpHeader[];
  /** The final URL; null when it contained a secret. */
  url: string | null;
  redirects: number;
  remoteIp: string;
  /** Milliseconds from the start; each includes the ones before. */
  timing: { dns: number; connect: number; tls: number; firstByte: number; total: number };
  body: string | null;
  bodySize: number;
  bodyKind: 'none' | 'text' | 'binary' | 'tooLarge';
  /** What ran: the command, the options curl read (secrets as {{NAME}}) and curl's log (secrets hidden). */
  console: { command: string; config: string; log: string };
}

export interface Cookie {
  domain: string;
  path: string;
  name: string;
  value: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix time; 0 = until the session ends. */
  expires: number;
}

/** What a path in a linked folder names. */
export type CollectionKind = 'request' | 'folder' | 'environment' | 'rootFile';

export interface CollectionScan {
  requests: { path: string; text: string }[];
  folders: string[];
  /** `environments/<name>.json` as `{ path: name }`. */
  environments: { path: string; text: string }[];
  /** `.env`, `.env.local` and `.env.<environment>.local`, by file name. */
  dotenv: { path: string; text: string }[];
  gitignore: string | null;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: { path: string; state: 'modified' | 'added' | 'deleted' | 'untracked' | 'conflict' }[];
  busy: boolean;
  /** Uncommitted changes elsewhere in the repository. */
  outsideChanges: boolean;
  /** Unpushed commits that touch files outside the folder. */
  outsideCommits: boolean;
  /** The repository holds more than the folder. */
  sharedRepo: boolean;
}

export type GitOutcome =
  | { state: 'synced' }
  | { state: 'conflict'; files: string[] }
  | { state: 'needsLogin' | 'noUpstream' | 'offline' | 'failed'; message: string };

/** One entry of a folder in the Files pane. */
export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  /** A symlink or junction. */
  link: boolean;
}

export type FileContent =
  | { kind: 'text'; text: string; size: number }
  | { kind: 'image'; dataUrl: string; size: number }
  | { kind: 'binary' | 'tooLarge'; size: number };

export type FileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface FileChange {
  /** Relative to the folder, with `/`. */
  path: string;
  oldPath: string | null;
  state: FileState;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}

export interface SearchMatch {
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  /** The repository's own folder. */
  main: boolean;
  locked: boolean;
  /** Its folder is gone. */
  prunable: boolean;
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  /** Unix time. */
  time: number;
}

export interface GitChanges {
  branch: string | null;
  /** The commit compared with ('' before the first commit). */
  base: string;
  files: FileChange[];
  /** Ignored paths relative to the folder; folders end with `/`. */
  ignored: string[];
}

/** 1-based line runs, as in git's `@@ -old +new @@` (a count of 0: inserted or removed after that line). */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export const api = {
  spawn(request: SpawnRequest, onMessage: (msg: PtyMessage) => void): Promise<number> {
    const output = new Channel<PtyMessage>();
    output.onmessage = onMessage;
    return invoke<number>('pty_spawn', { request, output });
  },
  write: (id: number, data: string) => invoke<void>('pty_write', { id, data }),
  writeBytes: (id: number, data: number[]) => invoke<void>('pty_write_bytes', { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows }),
  kill: (id: number) => invoke<void>('pty_kill', { id }),
  killAll: () => invoke<void>('pty_kill_all'),
  hasChildren: (id: number) => invoke<boolean>('pty_has_children', { id }),
  /** The conversation the Claude Code in the terminal shows now (`known` is the one it was started with). */
  claudeSession: (id: number, known: string) => invoke<string | null>('pty_claude_session', { id, known }),
  listShells: () => invoke<ShellProfile[]>('list_shells'),
  /** The WSL home folder as a Windows path (\\wsl.localhost\Ubuntu\home\me). May start WSL. */
  wslHome: (shell: ShellProfile) => invoke<string>('wsl_home', { shell }),
  sshAgentKeys: (sshPath: string) => invoke<AgentKeys>('ssh_agent_keys', { sshPath }),
  sshPublicKeyFile: (key: string) => invoke<string>('ssh_public_key_file', { key }),
  loadConfig: () => invoke<Loaded<Partial<Config>>>('config_load'),
  saveConfig: (config: Config) => invoke<void>('config_save', { config }),
  loadWorkspace: () => invoke<Loaded<unknown>>('workspace_load'),
  saveWorkspace: (workspace: WorkspaceSnapshot) => invoke<void>('workspace_save', { workspace }),
  /** A note's kept text (null: nothing unsaved). */
  noteBackupRead: (id: string) => invoke<string | null>('note_backup_read', { id }),
  noteBackupWrite: (id: string, text: string) => invoke<void>('note_backup_write', { id, text }),
  noteBackupDelete: (id: string) => invoke<void>('note_backup_delete', { id }),
  /** Deletes the kept text of notes that aren't open (`keep` lists the open ones). */
  noteBackupPrune: (keep: string[]) => invoke<void>('note_backup_prune', { keep }),
  noteFileRead: (path: string) => invoke<string>('note_file_read', { path }),
  noteFileWrite: (path: string, text: string) => invoke<void>('note_file_write', { path, text }),
  clipboardRead: () => invoke<string>('clipboard_read'),
  clipboardWrite: (text: string) => invoke<void>('clipboard_write', { text }),
  dirExists: (path: string) => invoke<boolean>('dir_exists', { path }),
  systemInfo: () => invoke<SystemInfo>('system_info'),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  openDir: (path: string) => invoke<void>('open_dir', { path }),
  /** XShell's sessions folder, or null when there is none. */
  xshellDir: () => invoke<string | null>('xshell_dir'),
  xshellSessions: (dir: string) => invoke<XshFile[]>('xshell_sessions', { dir }),
  /** Sends a request; `id` (unique per send) is for `httpCancel` and the response body file. */
  httpSend: (id: number, request: HttpRequest) => invoke<HttpResult>('http_send', { id, request }),
  httpCancel: (id: number) => invoke<void>('http_cancel', { id }),
  httpSaveBody: (id: number, path: string) => invoke<void>('http_save_body', { id, path }),
  httpDiscard: (id: number) => invoke<void>('http_discard', { id }),
  httpCookies: (key: string) => invoke<Cookie[]>('http_cookies', { key }),
  httpClearCookies: (key: string) => invoke<void>('http_clear_cookies', { key }),
  collectionScan: (folder: string) => invoke<CollectionScan>('collection_scan', { folder }),
  collectionWrite: (folder: string, path: string, kind: CollectionKind, text: string) =>
    invoke<void>('collection_write', { folder, path, kind, text }),
  collectionCreateFolder: (folder: string, path: string) => invoke<void>('collection_create_folder', { folder, path }),
  collectionRename: (folder: string, from: string, to: string, kind: CollectionKind) =>
    invoke<void>('collection_rename', { folder, from, to, kind }),
  collectionDelete: (folder: string, path: string, kind: CollectionKind) => invoke<void>('collection_delete', { folder, path, kind }),
  /** Calls `onChange` (debounced) when files in `folder` change; returns the id for `collectionUnwatch`. */
  collectionWatch(folder: string, onChange: () => void): Promise<number> {
    const channel = new Channel<null>();
    channel.onmessage = onChange;
    return invoke<number>('collection_watch', { folder, onChange: channel });
  },
  collectionUnwatch: (id: number) => invoke<void>('collection_unwatch', { id }),
  /** Null when the folder isn't in a git repository. */
  gitStatus: (folder: string) => invoke<GitStatus | null>('git_status', { folder }),
  /** Null outside a repository or without git. */
  gitIsIgnored: (folder: string, path: string) => invoke<boolean | null>('git_is_ignored', { folder, path }),
  gitFetch: (folder: string) => invoke<GitOutcome>('git_fetch', { folder }),
  /** False when the paths had nothing to commit. */
  gitCommit: (folder: string, paths: string[], message: string) => invoke<boolean>('git_commit', { folder, paths, message }),
  gitSync: (folder: string, prefer: 'neither' | 'mine' | 'theirs', interactive: boolean) =>
    invoke<GitOutcome>('git_sync', { folder, prefer, interactive }),
  /** Null outside a repository. `base` is a commit, or HEAD for what isn't committed. */
  gitChanges: (root: string, base: string) => invoke<GitChanges | null>('git_changes', { root, base }),
  /** Null when the file wasn't there at `base`. */
  gitFileAt: (root: string, path: string, base: string) => invoke<FileContent | null>('git_file_at', { root, path, base }),
  /** Recent commits and other branches, for "Compare with"; null outside a repository. */
  /** The repository a folder is in and its worktrees; null outside a repository. */
  worktreeInfo: (folder: string) =>
    invoke<{ top: string; prefix: string; branch: string | null; worktrees: Worktree[] } | null>('worktree_info', { folder }),
  /** A new worktree at `path` on a new `branch` from `from`; `copy` lists ignored files to copy in. */
  worktreeAdd: (folder: string, path: string, branch: string, from: string, copy: string) =>
    invoke<{ path: string; branch: string; base: string; copied: number }>('worktree_add', { folder, path, branch, from, copy }),
  /** What removing a worktree would lose. */
  worktreeStatus: (path: string) => invoke<{ branch: string | null; changes: number; onlyHere: number }>('worktree_status', { path }),
  worktreeRemove: (folder: string, path: string, deleteBranch: boolean, force: boolean) => invoke<void>('worktree_remove', { folder, path, deleteBranch, force }),
  gitCompareTargets: (root: string) => invoke<{ branch: string | null; branches: string[]; commits: Commit[] } | null>('git_compare_targets', { root }),
  gitHunks: (root: string, path: string, oldPath: string | null, base: string) => invoke<Hunk[]>('git_hunks', { root, path, oldPath, base }),
  filesList: (root: string, dir: string) => invoke<{ entries: FileEntry[]; truncated: boolean }>('files_list', { root, dir }),
  filesRead: (root: string, path: string) => invoke<FileContent>('files_read', { root, path }),
  /** Which of `paths` (absolute) are files. */
  filesExist: (paths: string[]) => invoke<boolean[]>('files_exist', { paths }),
  filesAll: (root: string) => invoke<{ files: string[]; truncated: boolean }>('files_all', { root }),
  /** Calls `onChange` (debounced) when something in `root` changes; stop with `collectionUnwatch`. */
  filesWatch(root: string, onChange: () => void): Promise<number> {
    const channel = new Channel<null>();
    channel.onmessage = onChange;
    return invoke<number>('files_watch', { root, onChange: channel });
  },
  /** Opens the folder in VS Code, with `file` open at `line`. */
  /** Finds text in the folder's files (git grep); stops at `max` matches. */
  filesSearch: (root: string, query: { query: string; caseSensitive: boolean; word: boolean; regex: boolean; include: string; max: number }) =>
    invoke<{ matches: SearchMatch[]; truncated: boolean }>('files_search', { root, query }),
  openInEditor: (root: string, file: string | null, line: number | null) => invoke<void>('open_in_editor', { root, file, line }),
  readJsonFile: (path: string) => invoke<string>('read_json_file', { path }),
  /** The 1Password CLI's path, or null when it isn't installed. */
  opPath: (custom: string) => invoke<string | null>('op_path', { custom }),
  /** The 1Password accounts op knows on this computer. */
  opAccounts: (custom: string) => invoke<{ url: string; email: string; account_uuid: string }[]>('op_accounts', { custom }),
};
