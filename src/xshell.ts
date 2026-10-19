/**
 * XShell as an import source: its `.xsh` files are INI text with the host, port, protocol and user.
 * Saved passwords and keys from XShell's own key store are left behind: Shellman never stores
 * passwords, and ssh.exe can't use XShell's keys (agent keys and ~/.ssh key files work as always).
 */
import { connectionError, emptyConnection } from './connection';
import type { ImportCandidate } from './importers';
import type { Connection } from './types';

/** One session file, as the backend read it (src-tauri/src/xshell.rs). */
export interface XshFile {
  /** Folders it is in, below the folder that was chosen. */
  folder: string[];
  /** The file name without `.xsh`, which XShell shows as the session name. */
  name: string;
  text: string;
}

/** Sections and keys, both lower-cased; later duplicates win. */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let section = new Map<string, string>();
  out.set('', section);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const head = /^\[(.*)\]$/.exec(line);
    if (head) {
      const name = head[1].trim().toLowerCase();
      section = out.get(name) ?? new Map();
      out.set(name, section);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) section.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return out;
}

const DEFAULT_PORT = { ssh: 22, telnet: 23 } as const;

/** The connection in an .xsh file, or why it can't be imported. */
export function xshConnection(text: string): Connection | { skip: string } {
  const ini = parseIni(text);
  const conn = ini.get('connection') ?? new Map<string, string>();
  const protocol = (conn.get('protocol') || 'SSH').toUpperCase();
  if (protocol !== 'SSH' && protocol !== 'TELNET') return { skip: `${protocol} isn't supported` };
  const c = emptyConnection(protocol === 'SSH' ? 'ssh' : 'telnet');
  c.host = conn.get('host') ?? '';
  const port = Number(conn.get('port'));
  // The protocol's own port is left out, so ~/.ssh/config can still set one.
  c.port = Number.isInteger(port) && port >= 1 && port <= 65535 && port !== DEFAULT_PORT[c.kind] ? port : null;
  if (c.kind === 'ssh') c.user = ini.get('connection:authentication')?.get('username') ?? '';
  return connectionError(c) ? { skip: c.host ? 'Unusable host or user' : 'No host' } : c;
}

export function xshellCandidates(files: XshFile[]): ImportCandidate[] {
  return files.map((f) => {
    const c = xshConnection(f.text);
    return 'skip' in c ? { folder: f.folder, name: f.name, connection: null, skip: c.skip } : { folder: f.folder, name: f.name, connection: c, skip: '' };
  });
}
