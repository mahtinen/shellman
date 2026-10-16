export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'wsl' | 'other';

export interface ShellProfile {
  id: string;
  name: string;
  path: string;
  args: string[];
  kind: ShellKind;
}

/** A saved entry in the sidebar: "open a terminal here and run this". */
export interface SavedSession {
  id: string;
  name: string;
  groupId: string | null;
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
