/**
 * Imports Postman exports: a collection (v2.0 or v2.1) becomes request files, an environment an
 * `environments/<name>.json`, and the workspace's globals go to `.env` (for every environment). Values that are secret (marked so in Postman, or looking like
 * tokens and passwords) go to the personal `.env.local` / `.env.<name>.local` instead of the
 * files the team shares, and requests refer to them as `{{NAME}}`.
 */
import type { DotenvEntry } from './dotenv';
import { emptyBody, environmentFileName, newRequest, requestFileName, REQUEST_EXT, type Auth, type EnvironmentDoc, type KeyValue, type RequestDoc } from './requestFile';
import { looksSecretName } from './variables';

export interface CollectionImport {
  name: string;
  /** Paths relative to where the collection is imported. */
  requests: { path: string; doc: RequestDoc }[];
  /** For the shared `.env`. */
  shared: DotenvEntry[];
  /** For the personal `.env.local`. */
  personal: DotenvEntry[];
  warnings: string[];
}

export interface EnvironmentImport {
  /** File name: `environments/<file>.json`. */
  file: string;
  name: string;
  doc: EnvironmentDoc;
  /** For `.env.<file>.local`. */
  personal: DotenvEntry[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);

export function isPostmanCollection(raw: unknown): boolean {
  return isObj(raw) && isObj(raw.info) && Array.isArray(raw.item);
}

export function isPostmanGlobals(raw: unknown): boolean {
  return isObj(raw) && Array.isArray(raw.values) && raw._postman_variable_scope === 'globals';
}

export function isPostmanEnvironment(raw: unknown): boolean {
  return isObj(raw) && Array.isArray(raw.values) && !Array.isArray(raw.item) && !isPostmanGlobals(raw);
}

export interface GlobalsImport {
  /** For the shared `.env`. */
  shared: DotenvEntry[];
  /** For the personal `.env.local`. */
  personal: DotenvEntry[];
}

/**
 * A Postman globals export: workspace-wide values with the lowest priority, like `.env`. Secret
 * ones (marked so, or with secret-looking names) go to `.env.local` instead.
 */
export function importGlobals(raw: unknown): GlobalsImport {
  if (!isPostmanGlobals(raw)) throw new Error("That isn't a Postman globals export.");
  const out: GlobalsImport = { shared: [], personal: [] };
  for (const v of list((raw as Record<string, unknown>).values)) {
    const key = str(v.key);
    if (!key || v.enabled === false) continue;
    (v.type === 'secret' || looksSecretName(key) ? out.personal : out.shared).push({ name: key, value: str(v.value) });
  }
  return out;
}

/** Auth parameters, as v2.1 lists them ([{ key, value }]) or v2.0 objects. */
function authParams(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) for (const p of list(v)) out[str(p.key)] = str(p.value);
  else if (isObj(v)) for (const [k, val] of Object.entries(v)) out[k] = str(val);
  return out;
}

/** null = inherit from the folder or collection. */
function auth(v: unknown, warnings: string[], where: string): Auth | null {
  if (!isObj(v) || v.type === 'inherit') return null;
  const p = authParams(v[str(v.type)]);
  switch (v.type) {
    case 'noauth':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: p.token ?? '' };
    case 'basic':
      return { type: 'basic', username: p.username ?? '', password: p.password ?? '' };
    case 'apikey':
      return { type: 'apikey', name: p.key ?? '', value: p.value ?? '', in: p.in === 'query' ? 'query' : 'header' };
    default:
      warnings.push(`${where}: ${str(v.type)} authentication isn't imported`);
      return { type: 'none' };
  }
}

function url(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  if (str(v.raw)) return str(v.raw);
  const host = Array.isArray(v.host) ? v.host.map(str).join('.') : str(v.host);
  const path = Array.isArray(v.path) ? v.path.map(str).join('/') : str(v.path);
  const query = list(v.query).filter((q) => !q.disabled);
  return `${str(v.protocol) ? `${str(v.protocol)}://` : ''}${host}${path ? `/${path}` : ''}${query.length ? `?${query.map((q) => `${str(q.key)}=${str(q.value)}`).join('&')}` : ''}`;
}

function request(r: Record<string, unknown>, inherited: Auth, warnings: string[], where: string): RequestDoc {
  const doc = newRequest();
  doc.method = str(r.method).toUpperCase() || 'GET';
  doc.url = url(r.url);
  doc.headers = list(r.header).map((h): KeyValue => ({ name: str(h.key), value: str(h.value), enabled: h.disabled !== true }));
  doc.auth = auth(r.auth, warnings, where) ?? inherited;
  doc.notes = str(r.description) || (isObj(r.description) ? str(r.description.content) : '');
  const b = isObj(r.body) ? r.body : null;
  if (b && b.disabled !== true) {
    switch (b.mode) {
      case 'raw': {
        const options = isObj(b.options) && isObj(b.options.raw) ? b.options.raw : {};
        const lang = str(options.language);
        const contentType = doc.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
        const type = lang === 'json' || contentType.includes('json') ? 'json' : lang === 'xml' || contentType.includes('xml') ? 'xml' : 'text';
        doc.body = { ...emptyBody(type), text: str(b.raw) };
        break;
      }
      case 'urlencoded':
        doc.body = { ...emptyBody('form'), fields: list(b.urlencoded).map((f) => ({ name: str(f.key), value: str(f.value), enabled: f.disabled !== true })) };
        break;
      case 'formdata':
        doc.body = {
          ...emptyBody('multipart'),
          fields: list(b.formdata).map((f) => {
            const file = f.type === 'file';
            const src = Array.isArray(f.src) ? str(f.src[0]) : str(f.src);
            return { name: str(f.key), value: file ? src : str(f.value), enabled: f.disabled !== true, ...(file ? { file: true } : {}) };
          }),
        };
        break;
      case 'file':
        doc.body = { ...emptyBody('file'), path: isObj(b.file) ? str(b.file.src) : '' };
        break;
      case 'graphql': {
        const g = isObj(b.graphql) ? b.graphql : {};
        let variables: unknown = {};
        try {
          variables = str(g.variables) ? JSON.parse(str(g.variables)) : {};
        } catch {
          variables = {};
        }
        doc.body = { ...emptyBody('json'), text: JSON.stringify({ query: str(g.query), variables }, null, 2) };
        break;
      }
    }
  }
  if (/\{\{\$\w+\}\}/.test(JSON.stringify(doc))) warnings.push(`${where}: Postman's dynamic variables ({{$guid}}, {{$timestamp}}, …) aren't supported`);
  return doc;
}

/**
 * Turns typed-in secrets (a Bearer token, a password) into `{{NAME}}`, with the value in `personal`.
 * `existing`: the folder's variables, whose names a new one must not take over.
 */
function moveSecrets(doc: RequestDoc, personal: DotenvEntry[], existing: Map<string, string>): void {
  const literal = (s: string) => !!s.trim() && !s.includes('{{');
  const keep = (base: string, value: string) => {
    const known = personal.find((e) => e.value === value);
    if (known) return `{{${known.name}}}`;
    const same = [...existing].find(([, v]) => v === value);
    if (same) return `{{${same[0]}}}`;
    let name = base;
    for (let n = 2; personal.some((e) => e.name === name) || existing.has(name); n++) name = `${base}_${n}`;
    personal.push({ name, value });
    return `{{${name}}}`;
  };
  const a = doc.auth;
  if (a.type === 'bearer' && literal(a.token)) a.token = keep('TOKEN', a.token);
  if (a.type === 'basic' && literal(a.password)) a.password = keep('PASSWORD', a.password);
  if (a.type === 'apikey' && literal(a.value)) a.value = keep('API_KEY', a.value);
  for (const h of doc.headers) {
    if ((looksSecretName(h.name) || /^authorization$/i.test(h.name)) && literal(h.value)) {
      const scheme = /^(Bearer|Basic|Token)\s+/i.exec(h.value)?.[0] ?? '';
      h.value = scheme + keep(h.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), h.value.slice(scheme.length));
    }
  }
}

/** A Postman collection export as request files; `existing` as in moveSecrets. */
export function importCollection(raw: unknown, existing = new Map<string, string>()): CollectionImport {
  if (!isPostmanCollection(raw)) throw new Error("That isn't a Postman collection export (v2.0 or v2.1).");
  const c = raw as Record<string, unknown>;
  const info = c.info as Record<string, unknown>;
  const out: CollectionImport = { name: str(info.name) || 'Collection', requests: [], shared: [], personal: [], warnings: [] };
  for (const v of list(c.variable)) {
    if (v.disabled === true || !str(v.key)) continue;
    const entry = { name: str(v.key), value: str(v.value) };
    (v.type === 'secret' || looksSecretName(entry.name) ? out.personal : out.shared).push(entry);
  }
  if (Array.isArray(c.event) && c.event.length) out.warnings.push("The collection's scripts aren't imported");
  const used = new Set<string>();
  const walk = (items: Record<string, unknown>[], folder: string[], inherited: Auth) => {
    for (const item of items) {
      const name = str(item.name) || 'Untitled';
      const where = [...folder, name].join(' / ');
      const own = auth(item.auth, out.warnings, where) ?? inherited;
      if (Array.isArray(item.item)) {
        walk(list(item.item), [...folder, requestFileName(name).slice(0, -REQUEST_EXT.length)], own);
      } else if (isObj(item.request) || typeof item.request === 'string') {
        const r = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : item.request;
        const doc = request(r, inherited, out.warnings, where);
        if (Array.isArray(item.event) && item.event.length) out.warnings.push(`${where}: scripts aren't imported`);
        moveSecrets(doc, out.personal, existing);
        // Two requests with the same name in a folder get "name (2)".
        const file = requestFileName(name);
        let path = [...folder, file].join('/');
        for (let n = 2; used.has(path.toLowerCase()); n++) path = [...folder, requestFileName(`${name} (${n})`)].join('/');
        used.add(path.toLowerCase());
        out.requests.push({ path, doc });
      }
    }
  };
  walk(list(c.item), [], auth(c.auth, out.warnings, out.name) ?? { type: 'none' });
  return out;
}

/** A Postman environment export as an environment file and its secrets. */
export function importEnvironment(raw: unknown): EnvironmentImport {
  if (!isPostmanEnvironment(raw)) throw new Error("That isn't a Postman environment export.");
  const e = raw as Record<string, unknown>;
  const name = str(e.name) || 'Environment';
  const variables: Record<string, string> = {};
  const personal: DotenvEntry[] = [];
  for (const v of list(e.values)) {
    const key = str(v.key);
    if (!key || v.enabled === false) continue;
    if (v.type === 'secret' || looksSecretName(key)) personal.push({ name: key, value: str(v.value) });
    else variables[key] = str(v.value);
  }
  return { file: environmentFileName(name), name, doc: { variables, protected: /prod/i.test(name), color: '' }, personal };
}
