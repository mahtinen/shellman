/**
 * "Copy as curl" (a request as a command for PowerShell 7, cmd or bash) and "Paste curl command"
 * (a curl command, e.g. from a browser's "Copy as cURL", as a request).
 */
import type { HttpRequest } from './api';
import { emptyBody, newRequest, type KeyValue, type RequestDoc } from './requestFile';

export type CurlShell = 'powershell' | 'cmd' | 'bash';

const PLAIN = /^[A-Za-z0-9_%+=:,./-]+$/;

function quote(arg: string, shell: CurlShell): string {
  if (PLAIN.test(arg)) return arg;
  if (shell === 'bash') return `'${arg.replace(/'/g, `'\\''`)}'`;
  // PowerShell takes the typographic single quotes (‘ ’ ‚ ‛) as quotes too.
  if (shell === 'powershell') return `'${arg.replace(/['‘-‛]/g, '$&$&')}'`;
  // cmd: "" is a quote inside a quoted argument, and keeps cmd's own quoting in step.
  return `"${arg.replace(/"/g, '""')}"`;
}

const CONTINUE: Record<CurlShell, string> = { bash: ' \\\n  ', powershell: ' `\n  ', cmd: ' ^\n  ' };

/**
 * The command for `req` (as prepared for sending). Secrets stay `{{NAME}}`, read by curl from the
 * environment (`--variable %NAME`); `opRefs` maps such names to their 1Password references, which
 * aren't secret, so the command sets them and runs curl through `op run`. Throws for cmd when a
 * value has a line break: cmd can't pass one in an argument.
 */
export function curlCommand(req: HttpRequest, shell: CurlShell, opRefs: Record<string, string> = {}, opAccount = ''): string {
  const secretNames = (req.secrets ?? []).map((s) => s.name);
  const usesSecret = (v: string) => secretNames.some((n) => v.includes(`{{${n}}}`) || v.includes(`{{${n}:`));
  const parts: string[][] = [];
  const opt = (name: string, value: string) => parts.push([usesSecret(value) ? `--expand-${name.replace(/^--/, '')}` : name, value]);

  const exe = shell === 'bash' ? 'curl' : 'curl.exe';
  const first: string[] = [exe];
  // curl sends GET, or POST when there is a body; any other method is named.
  const b = req.body ?? { type: 'none' };
  const hasBody = b.type === 'form' || b.type === 'multipart' ? b.fields.length > 0 : b.type !== 'none';
  if (req.method === 'HEAD') first.push('-I');
  else if (hasBody ? req.method !== 'POST' : req.method !== 'GET') first.push('-X', req.method);
  parts.push(first);
  for (const n of secretNames) parts.push(['--variable', `%${n}`]);
  opt('--url', req.url);
  for (const h of req.headers ?? []) opt('--header', h.value ? `${h.name}: ${h.value}` : `${h.name};`);
  if (req.user) opt('--user', req.user);
  if (b.type === 'raw') opt('--data-raw', b.text);
  else if (b.type === 'form') for (const f of b.fields) opt('--data-urlencode', `${f.name}=${f.value}`);
  else if (b.type === 'multipart') for (const f of b.fields) opt(f.file ? '--form' : '--form-string', f.file ? `${f.name}=@${f.value}` : `${f.name}=${f.value}`);
  else if (b.type === 'file') opt('--data-binary', `@${b.path}`);
  if (req.followRedirects) parts.push(['-L']);
  if (req.insecure) parts.push(['-k']);

  if (shell === 'cmd' && parts.some((p) => p.some((a) => /[\r\n]/.test(a))))
    throw new Error('cmd can\'t pass a value with line breaks (the body?). Choose PowerShell 7 or bash for Copy as curl in Settings → Requests.');
  const command = parts.map((p) => p.map((a, i) => (i === 0 && a.startsWith('-') ? a : i === 0 ? a : quote(a, shell))).join(' ')).join(CONTINUE[shell]);
  const refs = Object.entries(opRefs);
  if (!refs.length) return command;
  const op = `${shell === 'bash' ? 'op' : 'op.exe'} run${opAccount ? ` --account ${quote(opAccount, shell)}` : ''} --`;
  if (shell === 'bash') return `${refs.map(([n, r]) => `${n}=${quote(r, shell)}`).join(' ')} ${op} ${command}`;
  if (shell === 'powershell') return `${refs.map(([n, r]) => `$env:${n} = ${quote(r, shell)}`).join('; ')}; ${op} ${command}`;
  return `${refs.map(([n, r]) => `set "${n}=${r}"`).join(' && ')} && ${op} ${command}`;
}

// ---- paste ------------------------------------------------------------

/**
 * Splits a command line the way bash would. A command for cmd (a browser's "Copy as cURL (cmd)")
 * escapes with ^; once cmd has removed those, curl sees ordinary quotes.
 */
export function splitCommand(text: string): string[] {
  let s = text.replace(/\\\r?\n|`\r?\n/g, ' ');
  // A line break in a value is ^ and two of them (as browsers write it); one ^ ends a line.
  if (/\^\r?\n|\^"/.test(s)) s = s.replace(/\^\r?\n\r?\n/g, '\n').replace(/\^\r?\n/g, ' ').replace(/\^([\s\S])/g, '$1');
  const out: string[] = [];
  let cur = '';
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      // '…' is literal; $'…' (bash ANSI-C quoting, used by browsers) has backslash escapes.
      const ansi = c === '$';
      if (ansi) i++;
      started = true;
      for (i++; i < s.length && s[i] !== "'"; i++) {
        if (ansi && s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          cur += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
        } else cur += s[i];
      }
    } else if (c === '"') {
      started = true;
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i];
        else cur += s[i];
      }
    } else if (c === '\\') {
      started = true;
      if (i + 1 < s.length) cur += s[++i];
    } else {
      started = true;
      cur += c;
    }
  }
  if (started) out.push(cur);
  return out;
}

/** Short options that take a value (`-H x`, or `-Hx`). */
const SHORT_WITH_VALUE = new Set(['X', 'H', 'd', 'u', 'A', 'e', 'b', 'F', 'm', 'o', 'w', 'x', 'c', 'K', 'T', 'E', 'r', 'C', 'Y', 'y', 'z', 'U']);
const LONG_WITH_VALUE = new Set([
  'request', 'header', 'data', 'data-ascii', 'data-raw', 'data-binary', 'data-urlencode', 'json', 'form', 'form-string', 'user', 'user-agent',
  'referer', 'cookie', 'max-time', 'url', 'output', 'write-out', 'proxy', 'cookie-jar', 'config', 'connect-timeout', 'retry', 'cert', 'key',
  'cacert', 'upload-file', 'range', 'resolve', 'connect-to', 'interface', 'variable', 'oauth2-bearer', 'max-redirs',
]);
const SHORT_NAMES: Record<string, string> = {
  X: 'request', H: 'header', d: 'data', u: 'user', A: 'user-agent', e: 'referer', b: 'cookie', F: 'form', m: 'max-time',
  k: 'insecure', L: 'location', I: 'head', G: 'get', o: 'output', w: 'write-out', x: 'proxy', c: 'cookie-jar', K: 'config', T: 'upload-file',
  s: 'silent', S: 'show-error', v: 'verbose', i: 'include', f: 'fail', '#': 'progress-bar',
};
const IGNORED = new Set(['progress-bar', 'compressed', 'silent', 'show-error', 'verbose', 'include', 'fail', 'http1.1', 'http2', 'output', 'write-out', 'connect-timeout', 'retry', 'max-redirs', 'no-progress-meter', 'globoff']);

export interface Parsed {
  doc: RequestDoc;
  /** Options that were left out ("--proxy is not imported"). */
  skipped: string[];
}

/** A pasted curl command as a request; throws when it isn't one. */
export function parseCurl(text: string): Parsed {
  const args = splitCommand(text.trim());
  if (!args.length || !/^curl(\.exe)?$/i.test(args[0].split(/[\\/]/).pop() ?? '')) throw new Error('That is not a curl command.');
  const opts: [string, string | null][] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.length > 2) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      const long = name;
      if (LONG_WITH_VALUE.has(long)) opts.push([long, inline ?? args[++i] ?? '']);
      else opts.push([long, null]);
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        const name = SHORT_NAMES[ch] ?? ch;
        if (SHORT_WITH_VALUE.has(ch)) {
          opts.push([name, j + 1 < a.length ? a.slice(j + 1) : (args[++i] ?? '')]);
          break;
        }
        opts.push([name, null]);
      }
    } else {
      opts.push(['url', a]);
    }
  }

  const doc = newRequest();
  const skipped: string[] = [];
  const headers: KeyValue[] = [];
  const data: string[] = [];
  let dataFile = '';
  let json = false;
  let get = false;
  let method = '';
  for (const [name, value] of opts) {
    const v = value ?? '';
    switch (name) {
      case 'url':
        if (!doc.url) doc.url = v;
        break;
      case 'request':
        method = v.toUpperCase();
        break;
      case 'head':
        method = 'HEAD';
        break;
      case 'get':
        get = true;
        break;
      case 'header': {
        const i = v.indexOf(':');
        if (i > 0) headers.push({ name: v.slice(0, i).trim(), value: v.slice(i + 1).trim(), enabled: true });
        else if (v.endsWith(';')) headers.push({ name: v.slice(0, -1).trim(), value: '', enabled: true });
        break;
      }
      case 'user-agent':
        headers.push({ name: 'User-Agent', value: v, enabled: true });
        break;
      case 'referer':
        headers.push({ name: 'Referer', value: v, enabled: true });
        break;
      case 'cookie':
        if (v.includes('=')) headers.push({ name: 'Cookie', value: v, enabled: true });
        else skipped.push(`--cookie ${v} (a cookie file)`);
        break;
      case 'oauth2-bearer':
        doc.auth = { type: 'bearer', token: v };
        break;
      case 'user': {
        const i = v.indexOf(':');
        doc.auth = { type: 'basic', username: i < 0 ? v : v.slice(0, i), password: i < 0 ? '' : v.slice(i + 1) };
        break;
      }
      case 'data':
      case 'data-ascii':
      case 'data-binary':
        if (v.startsWith('@')) dataFile = v.slice(1);
        else data.push(name === 'data-binary' ? v : v.replace(/[\r\n]/g, ''));
        break;
      case 'data-raw':
        data.push(v);
        break;
      case 'json':
        json = true;
        data.push(v);
        break;
      case 'data-urlencode': {
        if (doc.body.type !== 'form') doc.body = emptyBody('form');
        const i = v.indexOf('=');
        doc.body.fields.push(i < 0 ? { name: v, value: '', enabled: true } : { name: v.slice(0, i), value: v.slice(i + 1), enabled: true });
        break;
      }
      case 'form':
      case 'form-string': {
        if (doc.body.type !== 'multipart') doc.body = emptyBody('multipart');
        const i = v.indexOf('=');
        const fieldName = i < 0 ? v : v.slice(0, i);
        const fieldValue = i < 0 ? '' : v.slice(i + 1);
        const file = name === 'form' && /^[@<]/.test(fieldValue);
        doc.body.fields.push({ name: fieldName, value: file ? fieldValue.slice(1).replace(/;.*$/, '').replace(/^"|"$/g, '') : fieldValue, enabled: true, ...(file ? { file: true } : {}) });
        break;
      }
      case 'insecure':
        doc.options.insecure = true;
        break;
      case 'location':
        doc.options.followRedirects = true;
        break;
      case 'max-time': {
        const n = Number(v);
        if (n > 0) doc.options.timeoutSeconds = Math.min(3600, Math.ceil(n));
        break;
      }
      default:
        if (!IGNORED.has(name)) skipped.push(`--${name}`);
    }
  }
  if (!doc.url) throw new Error('The curl command has no URL.');

  const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (get && data.length) {
    doc.url += (doc.url.includes('?') ? '&' : '?') + data.join('&');
  } else if (data.length) {
    const text = data.join(json ? '' : '&');
    const type = json || contentType.includes('json') ? 'json' : contentType.includes('xml') ? 'xml' : 'text';
    doc.body = { ...emptyBody(type), text };
    // Without a Content-Type curl sends form data; keep that, as curl would.
    if (!json && !contentType) headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
    if (json && !headers.some((h) => h.name.toLowerCase() === 'accept')) headers.push({ name: 'Accept', value: 'application/json', enabled: true });
  } else if (dataFile) {
    doc.body = { ...emptyBody('file'), path: dataFile };
  }
  const hasBody = doc.body.type !== 'none';
  doc.method = method || (hasBody && !get ? 'POST' : 'GET');
  doc.headers = headers;
  return { doc, skipped };
}
