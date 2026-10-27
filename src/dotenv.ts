/**
 * `.env` files: `NAME=value` lines, as most tools read them. A linked folder has a shared `.env`
 * (committed: names, values that aren't secret, and `op://` references) and personal ones,
 * `.env.local` and `.env.<environment>.local`, which stay out of git.
 */

/** One of the values a variable can be switched between; the description only shows on screen. */
export interface Choice {
  value: string;
  description: string;
}

export interface DotenvEntry {
  name: string;
  value: string;
  /**
   * Values to choose from, kept as `# @choice value -- description` lines right above the
   * variable, so other tools still read it as a plain variable. When writing, undefined keeps the
   * lines that are there.
   */
  choices?: Choice[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** A variable in a `.env` file and the lines it takes (its choices; a quoted value can span several). */
interface Block {
  name: string;
  value: string;
  choices: Choice[];
  /** First line (of its choices), its `NAME=` line, and the line after its last. */
  start: number;
  line: number;
  end: number;
}

const CHOICE = /^#\s*@choice(?:\s(.*))?$/;

function lines(text: string): string[] {
  return text ? text.replace(/^\uFEFF/, '').replace(/\r?\n$/, '').split(/\r?\n/) : [];
}

/** Undoes the escapes of a "…" value. */
const unescape = (s: string) => s.replace(/\\([nrt"\\])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);

/** Where the closing `"` of a "…" value is in `rest` (the text after the opening one), or -1. */
function closingQuote(rest: string): number {
  for (let j = 0; j < rest.length; j++) {
    if (rest[j] === '\\') j++;
    else if (rest[j] === '"') return j;
  }
  return -1;
}

/** `value -- description` of a `# @choice` line; the value is written as in `NAME=value`. */
function parseChoice(text: string): Choice {
  const t = text.trim();
  const end = t.startsWith('"') ? closingQuote(t.slice(1)) : -1;
  const value = end >= 0 ? unescape(t.slice(1, end + 1)) : /^\S*/.exec(t)![0];
  const rest = t.slice(end >= 0 ? end + 2 : value.length).trim();
  return { value, description: rest.replace(/^--(\s+|$)/, '').trim() };
}

function blocks(all: string[]): Block[] {
  const out: Block[] = [];
  /** `# @choice` lines just read: they belong to the variable right under them. */
  let choices: Choice[] = [];
  for (let i = 0; i < all.length; i++) {
    const start = i - choices.length;
    const line = all[i].trim();
    const c = CHOICE.exec(line);
    if (c) {
      choices.push(parseChoice(c[1] ?? ''));
      continue;
    }
    const own = choices;
    choices = [];
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !NAME.test(m[1])) continue;
    let value = m[2];
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // A quoted value may go on over several lines; inside "…", \" doesn't end it.
      let rest = value.slice(1);
      const close = () => {
        if (quote === '"') return closingQuote(rest);
        return rest.indexOf(quote);
      };
      while (close() < 0 && i + 1 < all.length) rest += `\n${all[++i]}`;
      const end = close();
      value = end >= 0 ? rest.slice(0, end) : rest;
      if (quote === '"') value = unescape(value);
    } else {
      // An unquoted value ends at a comment.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out.push({ name: m[1], value, choices: own, start, line: start + own.length, end: i + 1 });
  }
  return out;
}

/** The entries of a `.env` file, in order (a later one with the same name wins when read as a map). */
export function parseDotenv(text: string): DotenvEntry[] {
  return blocks(lines(text)).map(({ name, value, choices }) => (choices.length ? { name, value, choices } : { name, value }));
}

/** A value as written after `NAME=`, quoted when it needs it. */
function quoted(value: string): string {
  const plain = /^[^\s"'`#\\]*$/.test(value);
  return plain ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** One `NAME=value` line, quoted when the value needs it. */
export function dotenvLine(name: string, value: string): string {
  return `${name}=${quoted(value)}`;
}

/** The `# @choice value -- description` lines of a variable. */
function choiceLines(choices: Choice[]): string[] {
  return choices.map((c) => {
    const description = c.description.replace(/\s+/g, ' ').trim();
    return `# @choice ${c.value ? quoted(c.value) : '""'}${description ? ` -- ${description}` : ''}`;
  });
}

/** Rewrites `text`: each variable's lines are replaced by what `edit` returns (null drops them). */
function rewrite(text: string, edit: (b: Block, original: string[]) => string[] | null): string[] {
  const all = lines(text);
  const out: string[] = [];
  let at = 0;
  for (const b of blocks(all)) {
    out.push(...all.slice(at, b.start));
    const replaced = edit(b, all.slice(b.start, b.end));
    if (replaced !== null) out.push(...replaced);
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
    return [...(e.choices ? choiceLines(e.choices) : original.slice(0, b.line - b.start)), dotenvLine(e.name, e.value)];
  });
  for (const e of entries) if (!done.has(e.name)) out.push(...choiceLines(e.choices ?? []), dotenvLine(e.name, e.value));
  return finish(out);
}

/** `text` without the variables in `names` (and their choices). */
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
