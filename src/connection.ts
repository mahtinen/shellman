/**
 * SSH and Telnet connections: validation, display, and parsing what is typed in quick open.
 * Shellman only starts Windows' own client (ssh.exe / telnet.exe); the backend builds its
 * arguments again from these fields and checks them too (src-tauri/src/connect.rs).
 */
import type { Connection, ConnectionKind } from './types';

export function emptyConnection(kind: ConnectionKind = 'ssh'): Connection {
  return { kind, host: '', port: null, user: '', identityFile: '', identityKey: '', passwordAuth: false, legacyAlgorithms: false, jumpHost: '', extraArgs: '' };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function normalizeConnection(v: unknown): Connection | null {
  if (!isObj(v) || (v.kind !== 'ssh' && v.kind !== 'telnet')) return null;
  const port = typeof v.port === 'number' && Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535 ? v.port : null;
  return {
    kind: v.kind,
    host: str(v.host),
    port,
    user: str(v.user),
    identityFile: str(v.identityFile),
    identityKey: str(v.identityKey),
    passwordAuth: v.passwordAuth === true,
    legacyAlgorithms: v.legacyAlgorithms === true,
    jumpHost: str(v.jumpHost),
    extraArgs: str(v.extraArgs),
  };
}

// Whitespace or control characters; a leading '-' would be read as an option by the client.
const UNSAFE = /[\s\x00-\x1f\x7f]/;
const unsafeWord = (s: string) => UNSAFE.test(s) || s.startsWith('-');

/** Why the connection can't be used, or null when it can. */
export function connectionError(c: Connection): string | null {
  if (!c.host) return 'Enter a host name or address.';
  if (unsafeWord(c.host)) return 'The host can\'t contain spaces or start with "-".';
  if (c.host.includes('@')) return 'Put the user name in the User field.';
  if (c.port !== null && !(Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535)) return 'The port must be a number from 1 to 65535.';
  if (c.kind === 'ssh') {
    if (c.user && unsafeWord(c.user)) return 'The user name can\'t contain spaces or start with "-".';
    if (c.jumpHost && unsafeWord(c.jumpHost)) return 'The jump host can\'t contain spaces or start with "-".';
    if (/[\x00-\x1f\x7f]/.test(c.identityFile)) return 'The key file path contains invalid characters.';
    if (c.identityKey && !keyBlob(c.identityKey)) return 'The chosen SSH key is not a valid public key.';
  }
  return null;
}

/** "bob@host:2222" (the port only when it isn't the default). */
export function connectionTarget(c: Connection): string {
  const host = c.port !== null && c.host.includes(':') ? `[${c.host}]` : c.host;
  const user = c.kind === 'ssh' && c.user ? `${c.user}@` : '';
  return `${user}${host}${c.port !== null ? `:${c.port}` : ''}`;
}

export const connectionKindName = (kind: ConnectionKind) => (kind === 'ssh' ? 'SSH' : 'Telnet');

/** "ssh bob@host:2222", "telnet router". */
export function connectionLabel(c: Connection): string {
  return `${c.kind} ${connectionTarget(c)}`;
}

/** Splits options the way they are typed: whitespace separates, quotes group (and are removed). */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

const quoteArg = (a: string) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * What "allow old algorithms" adds (the backend leaves out any the installed ssh.exe no longer has;
 * see connect.rs).
 */
const LEGACY_OPTIONS = [
  'HostKeyAlgorithms=+ssh-rsa,ssh-dss',
  'PubkeyAcceptedAlgorithms=+ssh-rsa,ssh-dss',
  'KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1,diffie-hellman-group1-sha1',
  'Ciphers=+aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc',
];

/** ssh's "Unable to negotiate ..." for an old server that "allow old algorithms" can reach. */
export function needsLegacyAlgorithms(output: string): boolean {
  return /Unable to negotiate with .*: no matching (host key type|key exchange method|cipher) found/.test(output);
}

/** "type base64" of a one-line public key (what identifies the key), or null. */
export function keyBlob(key: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(key)) return null;
  const [kind, blob] = key.trim().split(/\s+/);
  if (!kind || !blob || !/^(ssh-|ecdsa-|sk-)[\w@.-]+$/.test(kind) || !/^[A-Za-z0-9+/=]+$/.test(blob)) return null;
  return `${kind} ${blob}`;
}

/** Same key, even if it was renamed (the name is only a comment). */
export const sameKey = (a: string, b: string) => !!a && keyBlob(a) !== null && keyBlob(a) === keyBlob(b);

/** "Work laptop key (rsa)": the name 1Password gives the key, and its type. */
export function keyLabel(key: string): string {
  const [kind = '', , ...name] = key.trim().split(/\s+/);
  const type = kind.replace(/^ssh-/, '').replace(/^ecdsa-sha2-/, 'ecdsa-');
  return `${name.join(' ') || 'Unnamed key'} (${type})`;
}

/**
 * The same connection as a command to paste into another terminal. `keyFile` is the public key
 * file of the chosen agent key (the backend writes it).
 */
export function connectionCommand(c: Connection, keyFile = ''): string {
  if (c.kind === 'telnet') return ['telnet', c.host, ...(c.port !== null ? [String(c.port)] : [])].map(quoteArg).join(' ');
  const args = ['ssh'];
  if (c.port !== null) args.push('-p', String(c.port));
  const identity = (c.identityKey && keyFile) || c.identityFile;
  if (c.passwordAuth) args.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password');
  else if (identity) args.push('-i', identity, '-o', 'IdentitiesOnly=yes');
  if (c.legacyAlgorithms) for (const o of LEGACY_OPTIONS) args.push('-o', o);
  if (c.jumpHost) args.push('-J', c.jumpHost);
  args.push(...splitArgs(c.extraArgs));
  args.push(c.user ? `${c.user}@${c.host}` : c.host);
  return args.map(quoteArg).join(' ');
}

/** What the backend needs to start the client. */
export function connectionRequest(c: Connection) {
  return {
    kind: c.kind,
    host: c.host,
    port: c.port,
    user: c.kind === 'ssh' ? c.user : '',
    identityFile: c.kind === 'ssh' ? c.identityFile : '',
    identityKey: c.kind === 'ssh' ? c.identityKey : '',
    passwordAuth: c.kind === 'ssh' && c.passwordAuth,
    legacyAlgorithms: c.kind === 'ssh' && c.legacyAlgorithms,
    jumpHost: c.kind === 'ssh' ? c.jumpHost : '',
    extraArgs: c.kind === 'ssh' ? splitArgs(c.extraArgs) : [],
  };
}

export type ConnectionRequest = ReturnType<typeof connectionRequest>;

export function parsePort(s: string): number | null {
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/** "[user@]host[:port]" or "ssh://[user@]host[:port]". */
export function parseDestination(s: string): { user: string; host: string; port: number | null } | null {
  const m = /^(?:ssh:\/\/)?(?:([^@\s]+)@)?(\[[^\]\s]+\]|[^@\s:[\]/]+)(?::(\d+))?\/?$/.exec(s);
  if (!m) return null;
  const port = m[3] === undefined ? null : parsePort(m[3]);
  if (m[3] !== undefined && port === null) return null;
  return { user: m[1] ?? '', host: m[2].replace(/^\[(.*)\]$/, '$1'), port };
}

/** ssh options that take a value (from `man ssh`). */
const SSH_VALUE_FLAGS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));

function parseSsh(args: string[]): Connection | null {
  const c = emptyConnection('ssh');
  const extra: string[] = [];
  let dest: string | null = null;
  let optionsDone = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' && !optionsDone) {
      if (dest !== null || i + 1 >= args.length) return null;
      dest = args[++i];
      optionsDone = true;
      continue;
    }
    if (optionsDone || !a.startsWith('-') || a === '-') {
      // ssh takes options after the host too (`ssh host -p 2222`); another word is a remote
      // command, which isn't supported here.
      if (dest !== null) return null;
      dest = a;
      continue;
    }
    const flag = a[1];
    let value: string | undefined;
    if (SSH_VALUE_FLAGS.has(flag)) {
      value = a.length > 2 ? a.slice(2) : args[++i];
      if (value === undefined) return null;
    }
    if (flag === 'p' && value !== undefined) {
      const port = parsePort(value);
      if (port === null) return null;
      c.port = port;
    } else if (flag === 'l' && value !== undefined) c.user = value;
    else if (flag === 'i' && value !== undefined) c.identityFile = value;
    else if (flag === 'J' && value !== undefined) c.jumpHost = value;
    // `-o User=bob` names the user too, so "login as:" isn't asked.
    else if (flag === 'o' && value !== undefined && /^user\s*[= ]\s*\S/i.test(value) && !c.user) c.user = value.replace(/^user\s*[= ]\s*/i, '');
    else extra.push(...(value !== undefined && a.length === 2 ? [a, value] : [a]));
  }
  const d = dest === null ? null : parseDestination(dest);
  if (!d) return null;
  c.host = d.host;
  if (d.user) c.user = d.user;
  if (d.port !== null) c.port = d.port;
  c.extraArgs = extra.map(quoteArg).join(' ');
  return connectionError(c) ? null : c;
}

/**
 * A connection typed in quick open: `ssh [options] [user@]host`, `telnet host [port]`,
 * or just `user@host[:port]`. Null when the text isn't one.
 */
export function parseQuickConnect(text: string): Connection | null {
  const args = splitArgs(text.trim());
  if (!args.length) return null;
  const [first, ...rest] = args;
  const cmd = first.toLowerCase();
  if (cmd === 'ssh' || cmd === 'ssh.exe') return parseSsh(rest);
  if (cmd === 'telnet' || cmd === 'telnet.exe') {
    if (rest.length < 1 || rest.length > 2) return null;
    const d = parseDestination(rest[0]);
    if (!d || d.user) return null;
    const port = rest[1] === undefined ? d.port : parsePort(rest[1]);
    if (rest[1] !== undefined && port === null) return null;
    const c: Connection = { ...emptyConnection('telnet'), host: d.host, port };
    return connectionError(c) ? null : c;
  }
  if (args.length === 1 && first.includes('@')) {
    const d = parseDestination(first);
    if (!d) return null;
    const c: Connection = { ...emptyConnection('ssh'), ...d };
    return connectionError(c) ? null : c;
  }
  return null;
}
