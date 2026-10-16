/**
 * Parsers for the OSC sequences Shellman understands:
 * - OSC 7 `file://host/path`            current directory (bash, zsh, fish ...)
 * - OSC 9;9;"path"                      current directory (Windows Terminal style)
 * - OSC 9;4;state;progress              taskbar-style progress (ConEmu)
 * - OSC 9;message                       desktop notification (iTerm2 style)
 * - OSC 777;notify;title;body           desktop notification (rxvt / Ghostty style)
 */

export type Osc9 =
  | { kind: 'cwd'; path: string }
  | { kind: 'progress'; state: number; value: number }
  | { kind: 'notify'; title: string; body: string }
  | null;

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

export function parseOsc9(data: string): Osc9 {
  if (data.startsWith('9;')) {
    const path = unquote(data.slice(2));
    return path ? { kind: 'cwd', path } : null;
  }
  if (data === '4' || data.startsWith('4;')) {
    const [, state = '0', value = '0'] = data.split(';');
    const st = Number.parseInt(state, 10);
    const val = Number.parseInt(value, 10);
    return { kind: 'progress', state: Number.isFinite(st) ? st : 0, value: Number.isFinite(val) ? val : 0 };
  }
  // Other numeric ConEmu sub-commands (OSC 9;1 sleep, 9;2 message box ...) are ignored.
  if (/^\d+(;|$)/.test(data)) return null;
  return data ? { kind: 'notify', title: '', body: data } : null;
}

export function parseOsc777(data: string): Osc9 {
  const parts = data.split(';');
  if (parts[0] !== 'notify') return null;
  return { kind: 'notify', title: parts[1] ?? '', body: parts.slice(2).join(';') };
}

/** `file://host/C:/x%20y` -> `C:\x y`; `file://host/home/u` -> `/home/u`. */
export function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!m) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[1]);
  } catch {
    path = m[1];
  }
  const win = /^\/([a-zA-Z]):(\/.*)?$/.exec(path);
  if (win) return `${win[1].toUpperCase()}:${(win[2] ?? '/').replace(/\//g, '\\')}`;
  // MSYS style /c/Users/... -> C:\Users\...
  const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(path);
  if (msys) return `${msys[1].toUpperCase()}:${(msys[2] ?? '/').replace(/\//g, '\\')}`;
  return path;
}

/** True if a path is something a Windows process can be started in. */
export function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) || /^[a-zA-Z]:$/.test(path);
}
