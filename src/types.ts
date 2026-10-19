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
  color: string;
  env: Record<string, string>;
  /** Its open terminals are folded away in the sidebar. */
  collapsed: boolean;
}

export interface Group {
  id: string;
  name: string;
  /** The group it is in; null = top level. */
  parentId: string | null;
  collapsed: boolean;
}

export type CloseOnExit = 'graceful' | 'always' | 'never';

/** What happens to the terminals that were open when Shellman last closed. */
export type RestoreMode = 'all' | 'shells' | 'off';

/** auto = download in the background and install on restart; notify = only say a new version exists. */
export type UpdateMode = 'auto' | 'notify' | 'off';

/** What a right-click inside a terminal does. Shift+right-click always opens the menu. */
export type RightClick = 'paste' | 'copyPaste' | 'menu';

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
}

export type SplitPlacement = 'tab' | 'right' | 'down';

export interface SystemInfo {
  homeDir: string;
  configDir: string;
  windowsBuild: number;
  version: string;
}
