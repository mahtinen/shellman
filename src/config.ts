import type { Config, Group, SavedSession, Settings, ShellProfile } from './types';

export const DEFAULT_FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace";

export function defaultSettings(): Settings {
  return {
    theme: 'shellman-dark',
    fontFamily: DEFAULT_FONT,
    fontSize: 14,
    lineHeight: 1.15,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 10000,
    gpuAcceleration: true,
    defaultShellId: '',
    defaultCwd: '',
    copyOnSelect: false,
    rightClick: 'paste',
    shiftEnterNewline: true,
    shellIntegration: true,
    closeOnExit: 'graceful',
    confirmClose: true,
    sidebarVisible: true,
    sidebarWidth: 260,
    otherTerminalsCollapsed: false,
    customShells: [],
    updates: 'auto',
    restoreTerminals: 'all',
  };
}

export function defaultConfig(): Config {
  return { version: 1, sessions: [], groups: [], settings: defaultSettings() };
}

let counter = 0;
export function uid(prefix = ''): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${rand}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const oneOf = <T extends string>(v: unknown, options: readonly T[], d: T): T =>
  options.includes(v as T) ? (v as T) : d;

function strRecord(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (k && typeof val === 'string') out[k] = val;
  return out;
}

function normalizeShell(v: unknown): ShellProfile | null {
  if (!isObj(v) || !str(v.path)) return null;
  return {
    id: str(v.id) || uid('shell-'),
    name: str(v.name) || str(v.path),
    path: str(v.path),
    args: Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [],
    kind: oneOf(v.kind, ['powershell', 'cmd', 'bash', 'wsl', 'other'] as const, 'other'),
  };
}

/**
 * Turns whatever was on disk (possibly hand-edited, older or partial) into a
 * valid Config without throwing away anything that can be kept.
 */
export function normalizeConfig(raw: unknown): Config {
  const base = defaultConfig();
  if (!isObj(raw)) return base;
  const d = base.settings;
  const s = isObj(raw.settings) ? raw.settings : {};

  const settings: Settings = {
    theme: str(s.theme, d.theme),
    fontFamily: str(s.fontFamily).trim() || d.fontFamily,
    fontSize: num(s.fontSize, d.fontSize, 6, 48),
    lineHeight: num(s.lineHeight, d.lineHeight, 0.8, 2.5),
    cursorStyle: oneOf(s.cursorStyle, ['block', 'bar', 'underline'] as const, d.cursorStyle),
    cursorBlink: bool(s.cursorBlink, d.cursorBlink),
    scrollback: Math.round(num(s.scrollback, d.scrollback, 0, 1_000_000)),
    gpuAcceleration: bool(s.gpuAcceleration, d.gpuAcceleration),
    defaultShellId: str(s.defaultShellId, d.defaultShellId),
    defaultCwd: str(s.defaultCwd, d.defaultCwd),
    copyOnSelect: bool(s.copyOnSelect, d.copyOnSelect),
    rightClick: oneOf(s.rightClick, ['paste', 'copyPaste', 'menu'] as const, d.rightClick),
    shiftEnterNewline: bool(s.shiftEnterNewline, d.shiftEnterNewline),
    shellIntegration: bool(s.shellIntegration, d.shellIntegration),
    closeOnExit: oneOf(s.closeOnExit, ['graceful', 'always', 'never'] as const, d.closeOnExit),
    confirmClose: bool(s.confirmClose, d.confirmClose),
    sidebarVisible: bool(s.sidebarVisible, d.sidebarVisible),
    sidebarWidth: num(s.sidebarWidth, d.sidebarWidth, 160, 700),
    otherTerminalsCollapsed: bool(s.otherTerminalsCollapsed, d.otherTerminalsCollapsed),
    customShells: Array.isArray(s.customShells)
      ? s.customShells.map(normalizeShell).filter((x): x is ShellProfile => x !== null)
      : [],
    updates: oneOf(s.updates, ['auto', 'notify', 'off'] as const, d.updates),
    restoreTerminals: oneOf(s.restoreTerminals, ['all', 'shells', 'off'] as const, d.restoreTerminals),
  };

  const groups: Group[] = [];
  const groupIds = new Set<string>();
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      if (!isObj(g)) continue;
      const id = str(g.id) || uid('g-');
      if (groupIds.has(id)) continue;
      groupIds.add(id);
      groups.push({ id, name: str(g.name) || 'Group', collapsed: bool(g.collapsed, false) });
    }
  }

  const sessions: SavedSession[] = [];
  const sessionIds = new Set<string>();
  if (Array.isArray(raw.sessions)) {
    for (const x of raw.sessions) {
      if (!isObj(x)) continue;
      let id = str(x.id) || uid('s-');
      if (sessionIds.has(id)) id = uid('s-');
      sessionIds.add(id);
      const groupId = str(x.groupId);
      sessions.push({
        id,
        name: str(x.name) || str(x.cwd) || 'Session',
        groupId: groupId && groupIds.has(groupId) ? groupId : null,
        cwd: str(x.cwd),
        command: str(x.command),
        shellId: str(x.shellId),
        color: str(x.color),
        env: strRecord(x.env),
        collapsed: bool(x.collapsed, false),
      });
    }
  }

  return { version: 1, sessions, groups, settings };
}

/** "C:\Projects\my-api\" -> "my-api" */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Comparison key for Windows paths: "C:/Foo/" and "c:\foo" are the same directory. */
export function pathKey(path: string): string {
  return path.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * The saved session a terminal belongs to: the one whose directory contains the terminal's
 * current directory (the deepest one; the session it was opened from wins a tie). Outside every
 * session directory it stays with the session it was opened from.
 */
export function ownerSession(sessions: SavedSession[], cwd: string, openedFrom: string | null): SavedSession | undefined {
  const dir = pathKey(cwd);
  let best: SavedSession | undefined;
  let bestLen = -1;
  for (const s of sessions) {
    const k = pathKey(s.cwd);
    if (!k || !(dir === k || dir.startsWith(`${k}\\`))) continue;
    if (k.length > bestLen || (k.length === bestLen && s.id === openedFrom)) {
      best = s;
      bestLen = k.length;
    }
  }
  return best ?? (openedFrom ? sessions.find((s) => s.id === openedFrom) : undefined);
}

/** Parses "KEY=value" lines; blank lines and lines starting with # are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** Guesses the shell kind from an executable path. */
export function guessShellKind(path: string): ShellProfile['kind'] {
  const exe = baseName(path).toLowerCase();
  if (exe === 'pwsh.exe' || exe === 'powershell.exe' || exe === 'pwsh' || exe === 'powershell') return 'powershell';
  if (exe === 'cmd.exe' || exe === 'cmd') return 'cmd';
  if (exe === 'wsl.exe' || exe === 'wsl') return 'wsl';
  if (exe.includes('bash') || exe === 'zsh.exe' || exe === 'sh.exe') return 'bash';
  return 'other';
}
