/**
 * `{{name}}` variables of a linked folder, and turning a request file into what curl is given.
 *
 * Lookup, lowest first (a later source wins): `.env` (shared), `environments/<env>.json` (shared,
 * per environment), `.env.local` and `.env.<env>.local` (personal). Values from the personal files
 * and `op://` references are secret: Shellman leaves `{{NAME}}` in place and curl fills it in from
 * its environment (1Password's `op run` resolves the references), so their values never pass
 * through the request text, the command line or Shellman's logs.
 */
import type { HttpBody, HttpHeader, HttpRequest } from './api';
import { isLocalEnvFile, localEnvFile, parseDotenv, removeDotenv, setDotenv } from './dotenv';
import { serializeEnvironment, type EnvironmentDoc, type RequestDoc } from './requestFile';

export interface Variable {
  name: string;
  value: string;
  /** The file it comes from: `.env`, `environments/dev.json`, `.env.local`, … */
  source: string;
  secret: boolean;
}

export interface VariableFiles {
  /** The active environment ('' = none). */
  env: string;
  /** Variables of `environments/<env>.json`. */
  environment: Record<string, string>;
  /** `.env`, `.env.local`, `.env.<environment>.local` (all of them; the right ones are picked here). */
  dotenv: { path: string; text: string }[];
}

/**
 * The 1Password reference in `value`, or null. Spaces, quotes and invisible characters around it
 * are ignored: a reference pasted as "op://…" (with its quotes) still is one.
 */
export function opRef(value: string): string | null {
  const v = value.replace(/^[\s\uFEFF\u200B"'`]+|[\s\uFEFF\u200B"'`]+$/g, '');
  return /^op:\/\//i.test(v) ? v : null;
}

export const isOpRef = (value: string) => opRef(value) !== null;

/** Names whose values are usually secret, so they are hidden on screen. */
export const looksSecretName = (name: string) => /token|secret|passw|pwd|api.?key|private|credential|cookie|session|auth|key$/i.test(name);

const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function collectVariables(files: VariableFiles): Map<string, Variable> {
  const vars = new Map<string, Variable>();
  const set = (name: string, value: string, source: string, personal: boolean) => vars.set(name, { name, value, source, secret: personal || isOpRef(value) });
  const file = (name: string) => files.dotenv.find((f) => f.path.toLowerCase() === name.toLowerCase());
  for (const e of parseDotenv(file('.env')?.text ?? '')) set(e.name, e.value, '.env', false);
  for (const [k, v] of Object.entries(files.environment)) set(k, v, `environments/${files.env}.json`, false);
  for (const name of ['.env.local', files.env ? localEnvFile(files.env) : '']) {
    const f = name && isLocalEnvFile(name) ? file(name) : undefined;
    if (f) for (const e of parseDotenv(f.text)) set(e.name, e.value, f.path, true);
  }
  return vars;
}

/** What the screen shows for a value: secrets hidden, `op://` references (just addresses) as they are. */
export function displayValue(v: Variable, hideSecrets: boolean): string {
  const ref = opRef(v.value);
  if (ref) return ref;
  return hideSecrets && v.secret ? '••••••••' : v.value;
}

/** Names of the variables `text` uses. */
export function usedVariables(text: string): string[] {
  return [...text.matchAll(VAR)].map((m) => m[1]);
}

export interface Segment {
  text: string;
  kind: 'text' | 'var' | 'secret' | 'missing';
  name?: string;
}

/** `text` cut into plain parts and `{{variables}}` as written; joined they give `text` back. */
export function splitVariables(text: string): { text: string; name?: string }[] {
  const out: { text: string; name?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(VAR)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], name: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** `text` split into plain parts and variables, with their values (for the URL line under the URL). */
export function segments(text: string, vars: Map<string, Variable>, hideSecrets: boolean): Segment[] {
  return splitVariables(text).map(({ text, name }): Segment => {
    if (!name) return { text, kind: 'text' };
    const v = vars.get(name);
    if (!v) return { text, kind: 'missing', name };
    return { text: displayValue(v, hideSecrets), kind: v.secret ? 'secret' : 'var', name };
  });
}

/** How a `{{variable}}` in a field shows: its colour and what hovering it tells. */
export function describeVariable(name: string, vars: Map<string, Variable>, hideSecrets: boolean): { kind: Segment['kind']; title: string } {
  const v = vars.get(name);
  if (!v) return { kind: 'missing', title: `{{${name}}} isn't defined. Ctrl+click to add it.` };
  const note = isOpRef(v.value) ? ' (1Password, filled in when sending)' : '';
  return { kind: v.secret ? 'secret' : 'var', title: `{{${name}}} = ${displayValue(v, hideSecrets)}${note}\nfrom ${v.source}. Ctrl+click to edit.` };
}

export interface Prepared {
  request: HttpRequest;
  /** Variables used but not defined anywhere; the request must not be sent. */
  missing: string[];
}

export interface PrepareOptions {
  /** The linked folder, for relative file paths. */
  folder: string;
  followRedirects: boolean;
  timeoutSeconds: number;
}

const DEFAULT_CONTENT_TYPE: Record<string, string> = { json: 'application/json', xml: 'application/xml', text: 'text/plain' };

/** How deep variables may refer to variables (`{{url}}` = `https://{{host}}`); deeper is a loop. */
const MAX_NESTING = 8;

/**
 * Environment variables curl, 1Password's op or Windows itself read (a proxy, a CA file, the TLS
 * key log, where programs are). A secret is handed over in curl's environment under its name, so
 * one of these names is given another (same rule as http.rs).
 */
export function reservedEnvName(name: string): boolean {
  const n = name.toUpperCase();
  const exact = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'ALLUSERSPROFILE', 'USERNAME', 'USERDOMAIN'];
  return exact.includes(n) || n.startsWith('CURL_') || n.startsWith('OP_') || n.startsWith('SSL') || n.endsWith('_PROXY');
}

const isAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

/** A request file as curl is given it (see the top of this file for how secrets are passed). */
export function prepareRequest(doc: RequestDoc, vars: Map<string, Variable>, opts: PrepareOptions): Prepared {
  const missing = new Set<string>();
  const secrets = new Map<string, { name: string; value: string }>();
  /** curl's variable names allow only letters, digits and '_'. */
  const alias = (name: string) => {
    let a = name.replace(/[^A-Za-z0-9_]/g, '_');
    if (/^\d/.test(a)) a = `_${a}`;
    if (reservedEnvName(a)) a = `SHELLMAN_${a}`;
    // Windows' environment doesn't tell `token` from `TOKEN`.
    while ([...secrets.values()].some((s) => s.name.toUpperCase() === a.toUpperCase())) a = `${a}_`;
    return a;
  };
  /** `text` with its variables filled in. `encode`: the plain parts (not curl's) go into a URL. */
  const fill = (text: string, suffix = '', encode = false, depth = 0): string => {
    const plain = (s: string) => (encode ? encodeURIComponent(s) : s);
    let out = '';
    let last = 0;
    for (const m of text.matchAll(VAR)) {
      out += plain(text.slice(last, m.index));
      last = m.index! + m[0].length;
      const name = m[1];
      const v = vars.get(name);
      if (!v || depth >= MAX_NESTING) {
        missing.add(name);
        out += m[0];
      } else if (!v.secret) {
        out += fill(v.value, suffix, encode, depth + 1);
      } else {
        const s = secrets.get(name) ?? { name: alias(name), value: opRef(v.value) ?? v.value };
        secrets.set(name, s);
        out += `{{${s.name}${suffix}}}`;
      }
    }
    return out + plain(text.slice(last));
  };
  const file = (p: string) => {
    const path = fill(p);
    return isAbsolute(path) ? path : `${opts.folder.replace(/[\\/]+$/, '')}\\${path.replace(/\//g, '\\')}`;
  };

  let url = fill(doc.url.trim());
  const headers: HttpHeader[] = doc.headers.filter((h) => h.enabled && h.name.trim()).map((h) => ({ name: fill(h.name.trim()), value: fill(h.value) }));
  const has = (name: string) => headers.some((h) => h.name.toLowerCase() === name.toLowerCase());
  let user: string | null = null;
  const a = doc.auth;
  if (a.type === 'bearer' && !has('Authorization')) headers.push({ name: 'Authorization', value: `Bearer ${fill(a.token)}` });
  else if (a.type === 'basic') user = `${fill(a.username)}:${fill(a.password)}`;
  else if (a.type === 'apikey' && a.name.trim()) {
    if (a.in === 'header') headers.push({ name: fill(a.name.trim()), value: fill(a.value) });
    else url += `${url.includes('?') ? '&' : '?'}${fill(a.name.trim(), ':url', true)}=${fill(a.value, ':url', true)}`;
  }

  const b = doc.body;
  let body: HttpBody = { type: 'none' };
  if (b.type === 'json' || b.type === 'text' || b.type === 'xml') {
    body = { type: 'raw', text: fill(b.text) };
    if (!has('Content-Type')) headers.push({ name: 'Content-Type', value: DEFAULT_CONTENT_TYPE[b.type] });
  } else if (b.type === 'form') {
    body = { type: 'form', fields: b.fields.filter((f) => f.enabled && f.name).map((f) => ({ name: fill(f.name), value: fill(f.value) })) };
  } else if (b.type === 'multipart') {
    body = {
      type: 'multipart',
      fields: b.fields.filter((f) => f.enabled && f.name).map((f) => ({ name: fill(f.name), value: f.file ? file(f.value) : fill(f.value), file: !!f.file })),
    };
  } else if (b.type === 'file' && b.path.trim()) {
    body = { type: 'file', path: file(b.path.trim()) };
  }

  return {
    request: {
      method: doc.method,
      url,
      headers,
      user,
      body,
      followRedirects: doc.options.followRedirects ?? opts.followRedirects,
      timeoutSeconds: doc.options.timeoutSeconds ?? opts.timeoutSeconds,
      insecure: doc.options.insecure ?? false,
      secrets: [...secrets.values()],
    },
    missing: [...missing],
  };
}

/** A Windows path with `.` and `..` worked out, for comparing. */
function normalPath(p: string): string {
  const parts: string[] = [];
  for (const part of p.replace(/\//g, '\\').split('\\')) {
    if (part === '..') parts.length > 1 && parts.pop();
    else if (part !== '.' && (part || !parts.length)) parts.push(part);
  }
  return parts.join('\\').toLowerCase();
}

/**
 * Files a prepared request sends that aren't in its folder. A request file is shared, so it could
 * name any file on a teammate's computer (a key, a browser's cookies): those are sent only when
 * the person sending agrees.
 */
export function filesOutside(req: HttpRequest, folder: string): string[] {
  const b = req.body;
  const files = b?.type === 'file' ? [b.path] : b?.type === 'multipart' ? b.fields.filter((f) => f.file).map((f) => f.value) : [];
  const root = `${normalPath(folder).replace(/\\+$/, '')}\\`;
  return files.filter((f) => !normalPath(f).startsWith(root) || f.includes('{{'));
}

/** A value that looks like a real token or password typed into a request (it would be shared through git). */
export interface SecretLiteral {
  /** Where it is, for the warning ("Header Authorization", "Bearer token"). */
  where: string;
  value: string;
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/;
/** Long, random-looking: letters and digits mixed. */
const RANDOM = (s: string) => s.length >= 16 && /\d/.test(s) && /[A-Za-z]/.test(s) && !/\s/.test(s);

export function findSecretLiterals(doc: RequestDoc): SecretLiteral[] {
  const out: SecretLiteral[] = [];
  const literal = (s: string) => s.trim() && !s.includes('{{');
  const check = (where: string, value: string, sensitive: boolean) => {
    const v = value.replace(/^(Bearer|Basic|Token)\s+/i, '').trim();
    if (literal(v) && (JWT.test(v) || (sensitive && (RANDOM(v) || v.length >= 8)))) out.push({ where, value: v });
  };
  // Turned-off headers and fields are saved (and shared) too.
  for (const h of doc.headers) check(`Header ${h.name}`, h.value, looksSecretName(h.name) || /^authorization$/i.test(h.name));
  const a = doc.auth;
  if (a.type === 'bearer') check('Bearer token', a.token, true);
  if (a.type === 'basic') check('Password', a.password, true);
  if (a.type === 'apikey') check(`API key ${a.name}`, a.value, true);
  // Query values as written in the URL (encoded), so they can be replaced as they are.
  const query = doc.url.split('#')[0].split('?').slice(1).join('?');
  for (const part of query ? query.split('&') : []) {
    const i = part.indexOf('=');
    if (i > 0) check(`Query ${part.slice(0, i)}`, part.slice(i + 1), looksSecretName(part.slice(0, i)));
  }
  if (doc.body.type === 'form' || doc.body.type === 'multipart')
    for (const f of doc.body.fields) if (!f.file) check(`Field ${f.name}`, f.value, looksSecretName(f.name));
  if (JWT.test(doc.url)) out.push({ where: 'URL', value: JWT.exec(doc.url)![0] });
  if ((doc.body.type === 'json' || doc.body.type === 'text' || doc.body.type === 'xml') && JWT.test(doc.body.text)) out.push({ where: 'Body', value: JWT.exec(doc.body.text)![0] });
  // Once per value (a token in the query is also one in the URL).
  return out.filter((s, i) => out.findIndex((o) => o.value === s.value) === i);
}

// ---- editing ------------------------------------------------------------

/**
 * The file a variable is kept in: shared (`.env`, `environments/<env>.json`) or, for a secret,
 * personal and git-ignored (`.env.local`, `.env.<env>.local`); for every environment or one.
 */
export type Scope = 'shared' | 'sharedEnv' | 'mine' | 'mineEnv';

/** Lowest first: a later scope wins (see `collectVariables`). */
export const SCOPES: Scope[] = ['shared', 'sharedEnv', 'mine', 'mineEnv'];

export interface VarRow {
  name: string;
  value: string;
  scope: Scope;
}

/** The file a scope is kept in. */
export function scopeFile(scope: Scope, env: string): string {
  return { shared: '.env', sharedEnv: `environments/${env}.json`, mine: '.env.local', mineEnv: localEnvFile(env) }[scope];
}

/** The variables of the four files that apply to `files.env`, as editable rows. */
export function variableRows(files: VariableFiles): VarRow[] {
  const file = (name: string) => files.dotenv.find((f) => f.path.toLowerCase() === name.toLowerCase())?.text ?? '';
  const fromDotenv = (text: string, scope: Scope) => {
    // A name twice in one file: the last one is what counts.
    const map = new Map(parseDotenv(text).map((e) => [e.name, e.value]));
    return [...map].map(([name, value]) => ({ name, value, scope }));
  };
  return [
    ...fromDotenv(file('.env'), 'shared'),
    ...(files.env ? Object.entries(files.environment).map(([name, value]) => ({ name, value, scope: 'sharedEnv' as const })) : []),
    ...fromDotenv(file('.env.local'), 'mine'),
    ...(files.env ? fromDotenv(file(localEnvFile(files.env)), 'mineEnv') : []),
  ];
}

/** Rows whose value isn't used because a later scope has the same name. */
export function overriddenRows(rows: VarRow[]): Set<VarRow> {
  const winner = new Map<string, VarRow>();
  for (const s of SCOPES) for (const r of rows) if (r.scope === s && r.name) winner.set(r.name, r);
  return new Set(rows.filter((r) => r.name && winner.get(r.name) !== r));
}

/** Why the rows can't be saved, or null. */
export function checkRows(rows: VarRow[], env: string): string | null {
  for (const r of rows) {
    if (!r.name) return 'Every variable needs a name.';
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(r.name)) return `"${r.name}" isn't a valid name: use letters, digits, _ . and -, starting with a letter or _.`;
    if (!env && (r.scope === 'sharedEnv' || r.scope === 'mineEnv')) return 'There is no environment yet: add one to keep values per environment.';
    if (rows.some((o) => o !== r && o.name === r.name && o.scope === r.scope)) return `"${r.name}" is twice in ${scopeFile(r.scope, env)}.`;
  }
  return null;
}

export interface FileWrite {
  path: string;
  kind: 'rootFile' | 'environment';
  text: string;
}

/**
 * The files to write so that they hold `after` instead of `before`. `.env` files keep their
 * comments and order; only files that change are written.
 */
export function variableWrites(before: VarRow[], after: VarRow[], files: VariableFiles, environment: EnvironmentDoc | undefined): FileWrite[] {
  const out: FileWrite[] = [];
  const text = (name: string) => files.dotenv.find((f) => f.path.toLowerCase() === name.toLowerCase())?.text ?? '';
  for (const scope of SCOPES) {
    const was = before.filter((r) => r.scope === scope);
    const now = after.filter((r) => r.scope === scope);
    const same = was.length === now.length && was.every((r) => now.some((n) => n.name === r.name && n.value === r.value));
    if (same) continue;
    const path = scopeFile(scope, files.env);
    const removed = was.filter((r) => !now.some((n) => n.name === r.name)).map((r) => r.name);
    if (scope === 'sharedEnv') {
      const doc = environment ?? { variables: {}, protected: false, color: '' };
      const variables = { ...doc.variables };
      for (const name of removed) delete variables[name];
      for (const r of now) variables[r.name] = r.value;
      out.push({ path, kind: 'environment', text: serializeEnvironment({ ...doc, variables }) });
    } else {
      out.push({ path, kind: 'rootFile', text: setDotenv(removeDotenv(text(path), removed), now.map(({ name, value }) => ({ name, value }))) });
    }
  }
  return out;
}

/**
 * A variable as the editor shows it: for every environment or one, and secret or not. Normal
 * values go to the shared files; secret ones to the git-ignored ones, except a 1Password
 * reference, which holds no secret and is shared like a normal value.
 */
export interface EditRow {
  name: string;
  value: string;
  perEnv: boolean;
  secret: boolean;
  /** Read from a personal file: stays there while secret, even as a 1Password reference (someone's
   * own reference, in place of the team's). */
  local?: boolean;
}

export function editRow(r: VarRow): EditRow {
  const personal = r.scope === 'mine' || r.scope === 'mineEnv';
  return { name: r.name, value: r.value, perEnv: r.scope === 'sharedEnv' || r.scope === 'mineEnv', secret: personal || isOpRef(r.value), ...(personal ? { local: true } : {}) };
}

export function rowScope(r: EditRow): Scope {
  const personal = r.secret && (!isOpRef(r.value) || !!r.local);
  return r.perEnv ? (personal ? 'mineEnv' : 'sharedEnv') : personal ? 'mine' : 'shared';
}

export const varRow = (r: EditRow): VarRow => ({ name: r.name, value: r.value, scope: rowScope(r) });
