/**
 * `.env` files: `NAME=value` lines, as most tools read them. A linked folder has a shared `.env`
 * (committed: names, values that aren't secret, and `op://` references) and personal ones,
 * `.env.local` and `.env.<environment>.local`, which stay out of git.
 */

export interface DotenvEntry {
  name: string;
  value: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** A variable in a `.env` file and the lines it takes (a quoted value can span several). */
interface Block {
  name: string;
  value: string;
  /** First line, and the line after its last. */
  start: number;
  end: number;
}

function lines(text: string): string[] {
  return text ? text.replace(/^\uFEFF/, '').replace(/\r?\n$/, '').split(/\r?\n/) : [];
}

function blocks(all: string[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < all.length; i++) {
    const start = i;
    const line = all[i].trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !NAME.test(m[1])) continue;
    let value = m[2];
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // A quoted value may go on over several lines; inside "…", \" doesn't end it.
      let rest = value.slice(1);
      const close = () => {
        for (let j = 0; j < rest.length; j++) {
          if (quote === '"' && rest[j] === '\\') j++;
          else if (rest[j] === quote) return j;
        }
        return -1;
      };
      while (close() < 0 && i + 1 < all.length) rest += `\n${all[++i]}`;
      const end = close();
      value = end >= 0 ? rest.slice(0, end) : rest;
      if (quote === '"') value = value.replace(/\\([nrt"\\])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
    } else {
      // An unquoted value ends at a comment.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out.push({ name: m[1], value, start, end: i + 1 });
  }
  return out;
}

/** The entries of a `.env` file, in order (a later one with the same name wins when read as a map). */
export function parseDotenv(text: string): DotenvEntry[] {
  return blocks(lines(text)).map(({ name, value }) => ({ name, value }));
}

/** One `NAME=value` line, quoted when the value needs it. */
export function dotenvLine(name: string, value: string): string {
  const plain = /^[^\s"'`#\\]*$/.test(value);
  return `${name}=${plain ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`}`;
}

/** Rewrites `text`: each variable's lines are replaced by what `edit` returns (null drops them). */
function rewrite(text: string, edit: (b: Block, original: string) => string | null): string[] {
  const all = lines(text);
  const out: string[] = [];
  let at = 0;
  for (const b of blocks(all)) {
    out.push(...all.slice(at, b.start));
    const line = edit(b, all.slice(b.start, b.end).join('\n'));
    if (line !== null) out.push(line);
    at = b.end;
  }
  out.push(...all.slice(at));
  return out;
}

const finish = (out: string[]) => (out.length ? `${out.join('\n')}\n` : '');

/**
 * `text` with `entries` set: an existing variable is replaced where it is, others are added at the
 * end. Comments and other lines stay as they are.
 */
export function setDotenv(text: string, entries: DotenvEntry[]): string {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const done = new Set<string>();
  const out = rewrite(text, (b, original) => {
    const e = byName.get(b.name);
    if (!e) return original;
    // A name set twice in the file keeps only the first, now with the new value.
    if (done.has(b.name)) return null;
    done.add(b.name);
    return dotenvLine(e.name, e.value);
  });
  for (const e of entries) if (!done.has(e.name)) out.push(dotenvLine(e.name, e.value));
  return finish(out);
}

/** `text` without the variables in `names`. */
export function removeDotenv(text: string, names: string[]): string {
  return finish(rewrite(text, (b, original) => (names.includes(b.name) ? null : original)));
}

/** Personal files: `.env.local` and `.env.<environment>.local`. */
export function isLocalEnvFile(name: string): boolean {
  return /^\.env(\.[A-Za-z0-9_-]+)?\.local$/i.test(name) && name.toLowerCase() !== '.env..local';
}

/** The personal file for one environment (characters a file name of this kind can't have become `_`). */
export function localEnvFile(env: string): string {
  return `.env.${env.replace(/[^A-Za-z0-9_-]/g, '_')}.local`;
}
