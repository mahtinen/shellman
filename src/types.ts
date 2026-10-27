export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'wsl' | 'other';

export interface ShellProfile {
  id: string;
  name: string;
  path: string;
  args: string[];
  kind: ShellKind;
}

export type ConnectionKind = 'ssh' | 'telnet';

/**
 * A remote host, reached through Windows' own client (OpenSSH's ssh.exe or the Telnet Client).
 * Keys and agents (Windows ssh-agent, 1Password) work as they do in any other terminal.
 */
export interface Connection {
  kind: ConnectionKind;
  host: string;
  /** null = the protocol's default (or, for SSH, what ~/.ssh/config says). */
  port: number | null;
  /** SSH only; '' = ssh's own default. */
  user: string;
  /** SSH only: -i (a key file on disk). */
  identityFile: string;
  /**
   * SSH only: public key ("type base64 name") of the agent key to use, e.g. one in 1Password.
   * Only that key is offered (IdentitiesOnly), so servers don't give up after 6 other keys.
   */
  identityKey: string;
  /** SSH only: log in with a password typed at ssh's prompt; no keys are offered. Never stored. */
  passwordAuth: boolean;
  /** SSH only: also allow weak algorithms (ssh-rsa/SHA-1, DSA, CBC) for old servers. */
  legacyAlgorithms: boolean;
  /** SSH only: -J. */
  jumpHost: string;
  /** SSH only: more options as typed, e.g. `-A -o ServerAliveInterval=30`. */
  extraArgs: string;
}

/** A saved entry in the sidebar: "open a terminal here and run this", or a remote host. */
export interface SavedSession {
  id: string;
  name: string;
  groupId: string | null;
  /** Remote host; null = a local terminal in `cwd`. */
  connection: Connection | null;
  /** Unused ('') for connections. */
  cwd: string;
  /** Command run when the terminal starts (empty = plain shell). */
  command: string;
  /** Shell profile id ('' = the default shell). */
  shellId: string;
  /** '' = its group's colour (see sessionColor). */
  color: string;
  env: Record<string, string>;
  /** Its open terminals are folded away in the sidebar. */
  collapsed: boolean;
  /** Each terminal opened from it gets a git worktree of its own (when worktrees are on in Settings). */
  newWorktree: boolean;
}

export interface Group {
  id: string;
  name: string;
  /** The group it is in; null = top level. */
  parentId: string | null;
  /** Colour of the sessions inside, unless they have their own; '' = the parent group's. */
  color: string;
  collapsed: boolean;
  /** Request folders (paths inside `folder`) folded in the sidebar. */
  folded: string[];
  /** A folder of request files (often a git repository the team shares); '' = none. */
  folder: string;
  /** The environment its requests use (`environments/<env>.json`); '' = the first one. */
  env: string;
  /**
   * The value chosen for each variable that has choices (by name). Personal, so switching never
   * changes the files the team shares; a value that is no longer one of the choices is ignored.
   */
  picks: Record<string, string>;
  /** Git sync of the folder: off, a Sync button, or automatic (commit on save, pull in the background). */
  sync: SyncMode;
  /** Automatic sync: push each save (after a few seconds), or only commit and push with Sync. */
  syncPush: 'push' | 'commit';
  /** How often to look for teammates' changes while Shellman is in front: seconds; 0 = never, -1 = only when it gets focus. */
  syncCheck: number;
  /** Automatic sync: saves within this many seconds go up together, as one commit. */
  syncDelay: number;
  /** The branch sync works on (set when it is turned on); '' = whichever is checked out. */
  syncBranch: string;
  /** Commit message; {request}, {folder} and {env} are filled in. */
  commitTemplate: string;
}

export type SyncMode = 'off' | 'manual' | 'auto';

export type CloseOnExit = 'graceful' | 'always' | 'never';

/** What happens to the terminals that were open when Shellman last closed. */
export type RestoreMode = 'all' | 'shells' | 'off';

/** auto = download in the background and install on restart; notify = only say a new version exists. */
export type UpdateMode = 'auto' | 'notify' | 'off';

/** What a right-click inside a terminal does. Shift+right-click always opens the menu. */
export type RightClick = 'paste' | 'copyPaste' | 'menu';

export type CurlShell = 'powershell' | 'cmd' | 'bash';

/** Where a request pane shows its response: by the pane's shape, or always below / on the right. */
export type ResponseLayout = 'auto' | 'below' | 'right';

export type ProxyMode = 'none' | 'environment' | 'custom';

export interface Settings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  scrollback: number;
  gpuAcceleration: boolean;
  defaultShellId: string;
  /** '' = the user's home directory. */
  defaultCwd: string;
  copyOnSelect: boolean;
  rightClick: RightClick;
  /** Shift+Enter sends ESC+CR, which Claude Code (and readline) treat as a newline. */
  shiftEnterNewline: boolean;
  shellIntegration: boolean;
  closeOnExit: CloseOnExit;
  confirmClose: boolean;
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** The sidebar's "Other terminals" list is folded away. */
  otherTerminalsCollapsed: boolean;
  customShells: ShellProfile[];
  updates: UpdateMode;
  restoreTerminals: RestoreMode;
  /** Restored SSH/Telnet tabs connect right away instead of waiting for Enter. */
  reconnectOnStart: boolean;
  /** ssh.exe to use; '' = Windows OpenSSH. */
  sshPath: string;
  /** Requests: a click opens a preview tab that the next click reuses (until it is edited). */
  requestPreviewTabs: boolean;
  /** Requests open in a new tab, or split to the right of the active pane. */
  requestOpenIn: 'tab' | 'split';
  responseLayout: ResponseLayout;
  responseWrap: boolean;
  /** Files pane: diffs side by side or inline. */
  diffLayout: 'split' | 'inline';
  /** Files pane: files git ignores are listed (dimmed). */
  showIgnoredFiles: boolean;
  /** Files pane: Markdown files open as a preview (or as their source). */
  markdownPreview: boolean;
  /** Git worktrees for sessions are offered (Open in new worktree, Worktrees). */
  worktrees: boolean;
  /** Where new worktrees go; '' = next to the repository, in <repo>.worktrees. */
  worktreeDir: string;
  /** Put in front of a new worktree's branch name. */
  worktreeBranchPrefix: string;
  /** Files git ignores that new worktrees get a copy of (globs, e.g. .env.local). */
  worktreeCopy: string;
  /** Seconds; a request's own timeout wins. */
  requestTimeout: number;
  requestFollowRedirects: boolean;
  /** Responses up to this many MB are shown; larger ones can be saved to a file. */
  responseMaxMb: number;
  /** Ask before sending anything but GET to an environment marked "protected". */
  confirmProtectedSend: boolean;
  /** Secret values (tokens, passwords) show as dots. */
  hideSecrets: boolean;
  /** Saving a request with a typed-in token or password offers to move it to .env.local. */
  warnSecretsOnSave: boolean;
  /** Sending also saves the request. */
  saveOnSend: boolean;
  copyCurlShell: CurlShell;
  proxyMode: ProxyMode;
  proxyUrl: string;
  /** curl.exe and op.exe (1Password CLI) to use; '' = Windows' curl and op on PATH. */
  curlPath: string;
  opPath: string;
  /** The 1Password account (sign-in address) when there are several; '' = 1Password's default. */
  opAccount: string;
}

export interface Config {
  version: 1;
  sessions: SavedSession[];
  groups: Group[];
  settings: Settings;
}

/** Everything needed to start a terminal. */
export interface LaunchSpec {
  name: string;
  cwd: string;
  command: string;
  shellId: string;
  env: Record<string, string>;
  color: string;
  /** Saved session this terminal was opened from, if any. */
  sessionId: string | null;
  /** Connects to a remote host instead of starting a shell (`cwd` is then only where the client runs). */
  connection?: Connection;
  /** This terminal's own Claude Code conversation, when its command starts `claude` (see claude.ts). */
  claudeId?: string;
  /** The conversation has been started once, so later starts resume it. */
  claudeStarted?: boolean;
  /** It was opened in a git worktree of its session's repository. */
  worktree?: WorktreeRef;
}

export interface WorktreeRef {
  /** The worktree's folder. */
  path: string;
  branch: string;
  /** The commit it started from: what its changes are compared with. */
  base: string;
}

export type SplitPlacement = 'tab' | 'right' | 'down';

export interface SystemInfo {
  homeDir: string;
  configDir: string;
  windowsBuild: number;
  version: string;
}
