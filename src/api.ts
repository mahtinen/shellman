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
  listShells: () => invoke<ShellProfile[]>('list_shells'),
  /** The WSL home folder as a Windows path (\\wsl.localhost\Ubuntu\home\me). May start WSL. */
  wslHome: (shell: ShellProfile) => invoke<string>('wsl_home', { shell }),
  sshAgentKeys: (sshPath: string) => invoke<AgentKeys>('ssh_agent_keys', { sshPath }),
  sshPublicKeyFile: (key: string) => invoke<string>('ssh_public_key_file', { key }),
  loadConfig: () => invoke<Loaded<Partial<Config>>>('config_load'),
  saveConfig: (config: Config) => invoke<void>('config_save', { config }),
  loadWorkspace: () => invoke<Loaded<unknown>>('workspace_load'),
  saveWorkspace: (workspace: WorkspaceSnapshot) => invoke<void>('workspace_save', { workspace }),
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
  readJsonFile: (path: string) => invoke<string>('read_json_file', { path }),
  /** The 1Password CLI's path, or null when it isn't installed. */
  opPath: (custom: string) => invoke<string | null>('op_path', { custom }),
  /** The 1Password accounts op knows on this computer. */
  opAccounts: (custom: string) => invoke<{ url: string; email: string; account_uuid: string }[]>('op_accounts', { custom }),
};
