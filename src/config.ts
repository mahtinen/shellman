import { normalizeConnection } from './connection';
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
    reconnectOnStart: false,
    sshPath: '',
    requestPreviewTabs: true,
    requestOpenIn: 'tab',
    responseLayout: 'auto',
    responseWrap: false,
    requestTimeout: 30,
    requestFollowRedirects: true,
    responseMaxMb: 10,
    confirmProtectedSend: true,
    hideSecrets: true,
    warnSecretsOnSave: true,
    saveOnSend: false,
    copyCurlShell: 'powershell',
    proxyMode: 'none',
    proxyUrl: '',
    curlPath: '',
    opPath: '',
    opAccount: '',
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
/** A colour as #rrggbb, or ''. Colours go into style attributes, so nothing else gets through. */
export const hexColor = (v: unknown): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '');
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
    reconnectOnStart: bool(s.reconnectOnStart, d.reconnectOnStart),
    sshPath: str(s.sshPath, d.sshPath).trim(),
    requestPreviewTabs: bool(s.requestPreviewTabs, d.requestPreviewTabs),
    requestOpenIn: oneOf(s.requestOpenIn, ['tab', 'split'] as const, d.requestOpenIn),
    responseLayout: oneOf(s.responseLayout, ['auto', 'below', 'right'] as const, d.responseLayout),
    responseWrap: bool(s.responseWrap, d.responseWrap),
    requestTimeout: Math.round(num(s.requestTimeout, d.requestTimeout, 1, 3600)),
    requestFollowRedirects: bool(s.requestFollowRedirects, d.requestFollowRedirects),
    responseMaxMb: Math.round(num(s.responseMaxMb, d.responseMaxMb, 1, 500)),
    confirmProtectedSend: bool(s.confirmProtectedSend, d.confirmProtectedSend),
    hideSecrets: bool(s.hideSecrets, d.hideSecrets),
    warnSecretsOnSave: bool(s.warnSecretsOnSave, d.warnSecretsOnSave),
    saveOnSend: bool(s.saveOnSend, d.saveOnSend),
    copyCurlShell: oneOf(s.copyCurlShell, ['powershell', 'cmd', 'bash'] as const, d.copyCurlShell),
    proxyMode: oneOf(s.proxyMode, ['none', 'environment', 'custom'] as const, d.proxyMode),
    proxyUrl: str(s.proxyUrl, d.proxyUrl).trim(),
    curlPath: str(s.curlPath, d.curlPath).trim(),
    opPath: str(s.opPath, d.opPath).trim(),
    opAccount: str(s.opAccount, d.opAccount).trim(),
  };

  const groups: Group[] = [];
  const groupIds = new Set<string>();
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      if (!isObj(g)) continue;
      const id = str(g.id) || uid('g-');
      if (groupIds.has(id)) continue;
      groupIds.add(id);
      groups.push({
        id,
        name: str(g.name) || 'Group',
        parentId: str(g.parentId) || null,
        color: hexColor(g.color),
        collapsed: bool(g.collapsed, false),
        folder: str(g.folder).trim(),
        env: str(g.env),
        sync: oneOf(g.sync, ['off', 'manual', 'auto'] as const, 'manual'),
        syncPush: oneOf(g.syncPush, ['push', 'commit'] as const, 'push'),
        syncCheck: [-1, 0, 60, 180, 300, 600].includes(g.syncCheck as number) ? (g.syncCheck as number) : 180,
        syncDelay: [10, 60, 300].includes(g.syncDelay as number) ? (g.syncDelay as number) : 60,
        syncBranch: str(g.syncBranch),
        commitTemplate: str(g.commitTemplate) || 'Update {request}',
      });
    }
  }
  fixParents(groups, groupIds);

  const sessions: SavedSession[] = [];
  const sessionIds = new Set<string>();
  if (Array.isArray(raw.sessions)) {
    for (const x of raw.sessions) {
      if (!isObj(x)) continue;
      let id = str(x.id) || uid('s-');
      if (sessionIds.has(id)) id = uid('s-');
      sessionIds.add(id);
      const groupId = str(x.groupId);
      const connection = normalizeConnection(x.connection);
      sessions.push({
        id,
        name: str(x.name) || connection?.host || str(x.cwd) || 'Session',
        groupId: groupId && groupIds.has(groupId) ? groupId : null,
        connection,
        cwd: connection ? '' : str(x.cwd),
        command: str(x.command),
        shellId: str(x.shellId),
        color: hexColor(x.color),
        env: strRecord(x.env),
        collapsed: bool(x.collapsed, false),
      });
    }
  }

  return { version: 1, sessions, groups, settings };
}

/** Parents that don't exist become top level, and so does a group that would end up inside itself. */
function fixParents(groups: Group[], ids: Set<string>): void {
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const g of groups) {
    if (g.parentId && !ids.has(g.parentId)) g.parentId = null;
    const seen = new Set<string>();
    for (let p = g.parentId; p && !seen.has(p); p = byId.get(p)?.parentId ?? null) {
      // A loop above this group is broken when its own groups get here.
      if (p === g.id) {
        g.parentId = null;
        break;
      }
      seen.add(p);
    }
  }
}

export function newGroup(name: string, parentId: string | null = null, color = ''): Group {
  return { id: uid('g-'), name, parentId, color, collapsed: false, folder: '', env: '', sync: 'manual', syncPush: 'push', syncCheck: 180, syncDelay: 60, syncBranch: '', commitTemplate: 'Update {request}' };
}

/** The colour a group gives its sessions: its own, or the nearest one from the groups it is in. */
export function groupColor(groups: Group[], id: string | null): string {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  for (let g = id ? byId.get(id) : undefined; g && !seen.has(g.id); g = g.parentId ? byId.get(g.parentId) : undefined) {
    if (g.color) return g.color;
    seen.add(g.id);
  }
  return '';
}

/** A session's colour: its own, or else its group's. */
export function sessionColor(groups: Group[], s: Pick<SavedSession, 'color' | 'groupId'>): string {
  return s.color || groupColor(groups, s.groupId);
}

/** The groups directly in `parentId` (null = top level), in their order. */
export function childGroups(groups: Group[], parentId: string | null): Group[] {
  return groups.filter((g) => g.parentId === parentId);
}

/** The group and every group inside it, at any depth. */
export function groupAndDescendants(groups: Group[], id: string): Set<string> {
  const out = new Set([id]);
  for (let added = true; added; ) {
    added = false;
    for (const g of groups) {
      if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        added = true;
      }
    }
  }
  return out;
}

/** "Customers / Acme / Prod". */
export function groupPath(groups: Group[], id: string | null): string {
  const names: string[] = [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (let g = id ? byId.get(id) : undefined; g && names.length < groups.length; g = g.parentId ? byId.get(g.parentId) : undefined) names.unshift(g.name);
  return names.join(' / ');
}

/** Every group, each followed by the groups inside it (the sidebar's order), with its depth. */
export function groupTree(groups: Group[]): { group: Group; depth: number }[] {
  const out: { group: Group; depth: number }[] = [];
  const add = (parentId: string | null, depth: number) => {
    for (const g of childGroups(groups, parentId)) {
      out.push({ group: g, depth });
      add(g.id, depth + 1);
    }
  };
  add(null, 0);
  return out;
}

/** Every group with its full path, in the sidebar's order, for choosing one. */
export function groupOptions(groups: Group[]): { id: string; label: string }[] {
  return groupTree(groups).map(({ group }) => ({ id: group.id, label: groupPath(groups, group.id) }));
}

/**
 * Moves a group into `parentId`, before or after `targetId` (a group in that parent) or to the end.
 * A group can't move into itself or a group inside it.
 */
export function moveGroup(groups: Group[], id: string, parentId: string | null, targetId: string | null = null, before = false): Group[] {
  const moving = groups.find((g) => g.id === id);
  if (!moving || (parentId && groupAndDescendants(groups, id).has(parentId))) return groups;
  const rest = groups.filter((g) => g !== moving);
  const moved = { ...moving, parentId };
  const t = targetId ? rest.findIndex((g) => g.id === targetId) : -1;
  if (t < 0) return [...rest, moved];
  rest.splice(t + (before ? 0 : 1), 0, moved);
  return rest;
}

/** Deletes a group; its sessions and the groups in it move up to its parent. */
export function deleteGroup(config: Config, id: string): void {
  const g = config.groups.find((x) => x.id === id);
  if (!g) return;
  for (const x of config.groups) if (x.parentId === id) x.parentId = g.parentId;
  for (const s of config.sessions) if (s.groupId === id) s.groupId = g.parentId;
  config.groups = config.groups.filter((x) => x !== g);
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
 * The saved session a local terminal belongs to: the one whose directory contains the terminal's
 * current directory (the deepest one; the session it was opened from wins a tie). Outside every
 * session directory it stays with the session it was opened from. Remote sessions never own one.
 */
export function ownerSession(sessions: SavedSession[], cwd: string, openedFrom: string | null): SavedSession | undefined {
  const dir = pathKey(cwd);
  let best: SavedSession | undefined;
  let bestLen = -1;
  const local = sessions.filter((s) => !s.connection);
  for (const s of local) {
    const k = pathKey(s.cwd);
    if (!k || !(dir === k || dir.startsWith(`${k}\\`))) continue;
    if (k.length > bestLen || (k.length === bestLen && s.id === openedFrom)) {
      best = s;
      bestLen = k.length;
    }
  }
  return best ?? (openedFrom ? local.find((s) => s.id === openedFrom) : undefined);
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
