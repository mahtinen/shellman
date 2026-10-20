/**
 * The request files a linked folder holds (`<name>.request.json`), which a team shares through
 * git. Written with a fixed key order and without defaults, so a change shows as a small diff;
 * nothing that changes by itself (ids, times, history) goes in them.
 */

export const REQUEST_EXT = '.request.json';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export interface KeyValue {
  name: string;
  value: string;
  enabled: boolean;
}

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; name: string; value: string; in: 'header' | 'query' };

export type BodyType = 'none' | 'json' | 'text' | 'xml' | 'form' | 'multipart' | 'file';

export interface Body {
  type: BodyType;
  /** json, text, xml */
  text: string;
  /** form, multipart; a multipart field with `file` sends the file at `value`. */
  fields: (KeyValue & { file?: boolean })[];
  /** file: relative to the folder, or absolute. */
  path: string;
}

/** Unset options follow Settings → Requests. */
export interface RequestOptions {
  followRedirects?: boolean;
  timeoutSeconds?: number;
  insecure?: boolean;
}

export interface RequestDoc {
  method: string;
  url: string;
  headers: KeyValue[];
  auth: Auth;
  body: Body;
  options: RequestOptions;
  notes: string;
}

export function emptyBody(type: BodyType = 'none'): Body {
  return { type, text: '', fields: [], path: '' };
}

export function newRequest(): RequestDoc {
  return { method: 'GET', url: '', headers: [], auth: { type: 'none' }, body: emptyBody(), options: {}, notes: '' };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function keyValues(v: unknown): KeyValue[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((x) => ({ name: str(x.name), value: str(x.value), enabled: x.enabled !== false }));
}

function normalizeAuth(v: unknown): Auth {
  if (!isObj(v)) return { type: 'none' };
  switch (v.type) {
    case 'bearer':
      return { type: 'bearer', token: str(v.token) };
    case 'basic':
      return { type: 'basic', username: str(v.username), password: str(v.password) };
    case 'apikey':
      return { type: 'apikey', name: str(v.name), value: str(v.value), in: v.in === 'query' ? 'query' : 'header' };
    default:
      return { type: 'none' };
  }
}

function normalizeBody(v: unknown): Body {
  if (!isObj(v)) return emptyBody();
  const types: BodyType[] = ['none', 'json', 'text', 'xml', 'form', 'multipart', 'file'];
  const type = types.includes(v.type as BodyType) ? (v.type as BodyType) : 'none';
  const fields = Array.isArray(v.fields)
    ? v.fields.filter(isObj).map((x) => ({ name: str(x.name), value: str(x.value), enabled: x.enabled !== false, ...(x.file === true ? { file: true } : {}) }))
    : [];
  return { type, text: str(v.text), fields, path: str(v.path) };
}

/** A request file's text as a request; whatever is missing or invalid gets its default. */
export function parseRequest(text: string): RequestDoc {
  return readRequest(text) ?? newRequest();
}

/** Like parseRequest, but null when the text isn't a JSON object at all (a merge conflict, a typo). */
export function readRequest(text: string): RequestDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    raw = null;
  }
  if (!isObj(raw)) return null;
  const method = str(raw.method).trim().toUpperCase();
  const o = isObj(raw.options) ? raw.options : {};
  const options: RequestOptions = {};
  if (typeof o.followRedirects === 'boolean') options.followRedirects = o.followRedirects;
  if (typeof o.timeoutSeconds === 'number' && o.timeoutSeconds > 0) options.timeoutSeconds = Math.min(3600, Math.round(o.timeoutSeconds));
  if (typeof o.insecure === 'boolean') options.insecure = o.insecure;
  return {
    method: /^[A-Z][A-Z0-9_-]{0,19}$/.test(method) ? method : 'GET',
    url: str(raw.url),
    headers: keyValues(raw.headers),
    auth: normalizeAuth(raw.auth),
    body: normalizeBody(raw.body),
    options,
    notes: str(raw.notes),
  };
}

const kv = (x: KeyValue) => (x.enabled ? { name: x.name, value: x.value } : { name: x.name, value: x.value, enabled: false });

/** The file's text: fixed key order, defaults left out, two-space indent and a final newline. */
export function serializeRequest(doc: RequestDoc): string {
  const out: Record<string, unknown> = { method: doc.method, url: doc.url };
  if (doc.headers.length) out.headers = doc.headers.map(kv);
  if (doc.auth.type !== 'none') out.auth = doc.auth;
  const b = doc.body;
  if (b.type === 'json' || b.type === 'text' || b.type === 'xml') out.body = { type: b.type, text: b.text };
  else if (b.type === 'form' || b.type === 'multipart') out.body = { type: b.type, fields: b.fields.map((f) => ({ ...kv(f), ...(f.file ? { file: true } : {}) })) };
  else if (b.type === 'file') out.body = { type: 'file', path: b.path };
  const o: RequestOptions = {};
  if (doc.options.followRedirects !== undefined) o.followRedirects = doc.options.followRedirects;
  if (doc.options.timeoutSeconds !== undefined) o.timeoutSeconds = doc.options.timeoutSeconds;
  if (doc.options.insecure !== undefined) o.insecure = doc.options.insecure;
  if (Object.keys(o).length) out.options = o;
  if (doc.notes) out.notes = doc.notes;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** `environments/<name>.json`: values for one environment (shared; secrets go in `.env.<name>.local`). */
export interface EnvironmentDoc {
  variables: Record<string, string>;
  /** Shown in red, and asks before sending anything but GET. */
  protected: boolean;
  /** '' = the default for its kind. */
  color: string;
}

export function parseEnvironment(text: string): EnvironmentDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    raw = null;
  }
  const o = isObj(raw) ? raw : {};
  const variables: Record<string, string> = {};
  if (isObj(o.variables)) for (const [k, v] of Object.entries(o.variables)) if (k && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) variables[k] = String(v);
  return { variables, protected: o.protected === true, color: str(o.color) };
}

export function serializeEnvironment(env: EnvironmentDoc): string {
  const out: Record<string, unknown> = { variables: env.variables };
  if (env.protected) out.protected = true;
  if (env.color) out.color = env.color;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** A name usable as a file name for an environment ("Production EU" → "production-eu"). */
export function environmentFileName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'environment'
  );
}

/** The query of a URL as rows (for the Params table); `{{variables}}` are kept as they are. */
export function splitUrl(url: string): { base: string; params: KeyValue[]; hash: string } {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const rest = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = rest.indexOf('?');
  if (q < 0) return { base: rest, params: [], hash };
  const params = rest
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const i = p.indexOf('=');
      return { name: i < 0 ? p : p.slice(0, i), value: i < 0 ? '' : p.slice(i + 1), enabled: true };
    });
  return { base: rest.slice(0, q), params, hash };
}

/** The URL with `params` as its query (rows without a name are left out). */
export function joinUrl(base: string, params: KeyValue[], hash = ''): string {
  const query = params.filter((p) => p.enabled && p.name).map((p) => (p.value === '' ? p.name : `${p.name}=${p.value}`));
  return `${base}${query.length ? `?${query.join('&')}` : ''}${hash}`;
}

/** "users/list-users.request.json" → "list-users" */
export function requestName(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.toLowerCase().endsWith(REQUEST_EXT) ? file.slice(0, -REQUEST_EXT.length) : file;
}

/** The folder part of a request path ('' at the top). */
export function requestFolder(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** A file name for a request called `name` (characters Windows forbids become '-'). */
export function requestFileName(name: string): string {
  const clean = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/, '');
  return `${clean || 'request'}${REQUEST_EXT}`;
}
