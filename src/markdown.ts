/**
 * A small Markdown parser for the Files pane's preview: the CommonMark and GitHub shapes that
 * documentation uses (headings, lists and task lists, tables, code blocks, quotes, links, images,
 * emphasis). It produces a tree that markdownView.ts turns into elements one by one; raw HTML is
 * kept as text here and only an allowlist of it is ever rebuilt there. Pure functions.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'em' | 'strong' | 'del' | 'kbd' | 'sup' | 'sub' | 'u' | 'mark'; c: Inline[] }
  | { t: 'link'; href: string; title: string; c: Inline[] }
  | { t: 'img'; src: string; alt: string; title: string }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** null: not a task; true/false: [x] / [ ]. */
  task: boolean | null;
  c: Block[];
}

export type Block =
  | { t: 'h'; level: number; c: Inline[]; id: string }
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }
  | { t: 'html'; v: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+(.*)|[ \t]*$)/;
const HTML_START = /^ {0,3}<(?:!--|\/?[A-Za-z][\w-]*(?:\s|\/?>|$))/;
const TABLE_DELIM = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const REF_DEF = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(](.*)["')])?\s*$/;

/** Link targets defined as `[name]: url`, by lower-case name. */
type Refs = Map<string, { href: string; title: string }>;

const isBlank = (l: string) => /^\s*$/.test(l);
const indentOf = (l: string) => l.replace(/\t/g, '    ').search(/\S|$/);

/** GitHub's anchor for a heading: `## Run it!` → `run-it`. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const refs: Refs = new Map();
  // Reference definitions can be used before they appear: collect them first.
  for (const l of lines) {
    const m = REF_DEF.exec(l);
    if (m && !refs.has(m[1].toLowerCase())) refs.set(m[1].toLowerCase(), { href: m[2], title: m[3] ?? '' });
  }
  const blocks = parseBlocks(lines, refs);
  // Unique heading ids, as GitHub makes them (run, run-1, run-2).
  const seen = new Map<string, number>();
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === 'h') {
        const n = seen.get(b.id) ?? 0;
        seen.set(b.id, n + 1);
        if (n) b.id = `${b.id}-${n}`;
      } else if (b.t === 'quote') walk(b.c);
      else if (b.t === 'list') for (const it of b.items) walk(it.c);
    }
  };
  walk(blocks);
  return blocks;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      code = !code;
      cur += ch;
    } else if (ch === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Whether `line` starts a block other than a paragraph (so it ends a paragraph before it). */
function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || HTML_START.test(line) || (line.includes('|') && !!next && TABLE_DELIM.test(next) && next.includes('-'));
}

function parseBlocks(lines: string[], refs: Refs): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (REF_DEF.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      i++;
      out.push({ t: 'code', lang: fence[2].toLowerCase(), v: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const textOf = heading[2] ?? '';
      out.push({ t: 'h', level: heading[1].length, c: parseInline(textOf, refs), id: slug(plainText(textOf)) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const q = QUOTE.exec(lines[i]);
        // A line without > continues the quote's paragraph (lazy continuation).
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push({ t: 'quote', c: parseBlocks(body, refs) });
      continue;
    }
    if (ITEM.test(line)) {
      const [block, next] = parseList(lines, i, refs);
      out.push(block);
      i = next;
      continue;
    }
    if (HTML_START.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]);
      out.push({ t: 'html', v: body.join('\n') });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? '', refs)));
        i++;
      }
      out.push({ t: 'table', align: head.map((_, k) => align[k] ?? null), head: head.map((c) => parseInline(c, refs)), rows });
      continue;
    }
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || isBlank(lines[i]))) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      out.push({ t: 'code', lang: '', v: body.join('\n') });
      continue;
    }
    // A paragraph, or a setext heading (text underlined with === or ---).
    const para: string[] = [line.trim()];
    i++;
    let level = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      if (/^ {0,3}=+\s*$/.test(lines[i])) level = 1;
      else if (/^ {0,3}-+\s*$/.test(lines[i])) level = 2;
      if (level) {
        i++;
        break;
      }
      if (startsBlock(lines[i], lines[i + 1])) break;
      para.push(lines[i].replace(/^\s+/, ''));
      i++;
    }
    const text = para.join('\n');
    out.push(level ? { t: 'h', level, c: parseInline(text, refs), id: slug(plainText(text)) } : { t: 'p', c: parseInline(text, refs) });
  }
  return out;
}

/** A list starting at line `start`; returns it and the line after it. */
function parseList(lines: string[], start: number, refs: Refs): [Block, number] {
  const first = ITEM.exec(lines[start])!;
  const ordered = /\d/.test(first[2]);
  const marker = ordered ? first[2].slice(-1) : first[2];
  const items: ListItem[] = [];
  let tight = true;
  let i = start;
  /** An item of this list (same kind of marker, about the same indent), not of another one. */
  const sibling = (line: string | undefined) => {
    const m = line === undefined ? null : ITEM.exec(line);
    return !!m && /\d/.test(m[2]) === ordered && (ordered ? m[2].slice(-1) : m[2]) === marker && m[1].length <= first[1].length + 1 ? m : null;
  };
  while (i < lines.length) {
    const m = sibling(lines[i]);
    if (!m) break;
    // Where the item's text starts; continuation lines indented that far belong to it.
    const content = m[1].length + m[2].length + Math.max(1, Math.min(4, (m[3] ?? '').length - (m[4] ?? '').length));
    const body: string[] = [m[4] ?? ''];
    i++;
    let blankBefore = false;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        blankBefore = true;
        body.push('');
        i++;
        continue;
      }
      if (indentOf(l) >= content) {
        if (blankBefore) tight = false;
        body.push(l.replace(/\t/g, '    ').slice(content));
        blankBefore = false;
        i++;
        continue;
      }
      // An unindented line right after text continues it (lazy continuation), unless it starts something.
      if (!blankBefore && !startsBlock(l, lines[i + 1])) {
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    // A blank line between items makes the list loose (paragraphs in each item).
    if (blankBefore && sibling(lines[i])) tight = false;
    let task: boolean | null = null;
    const t = /^\[([ xX])\]\s+/.exec(body[0]);
    if (t) {
      task = t[1] !== ' ';
      body[0] = body[0].slice(t[0].length);
    }
    items.push({ task, c: parseBlocks(body, refs) });
    if (blankBefore && !sibling(lines[i])) break;
  }
  return [{ t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, tight, items }, i];
}

/** The text of inline Markdown without its marks (for heading anchors). */
export function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '');
}

const INLINE_TAGS = new Set(['kbd', 'sup', 'sub', 'u', 'mark', 'b', 'i', 'em', 'strong', 's', 'del', 'code']);

export function parseInline(text: string, refs: Refs = new Map()): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);
    // Escapes, and a backslash at the end of a line (a line break).
    if (ch === '\\') {
      if (text[i + 1] === '\n') {
        flush();
        out.push({ t: 'br' });
        i += 2;
        continue;
      }
      if (/[!-/:-@[-`{-~]/.test(text[i + 1] ?? '')) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        let code = text.slice(i + run.length, end).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out.push({ t: 'code', v: code });
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (ch === '\n') {
      // Two spaces before a line end make a line break; otherwise it's a space.
      if (buf.endsWith('  ')) {
        buf = buf.trimEnd();
        flush();
        out.push({ t: 'br' });
      } else buf = `${buf.trimEnd()} `;
      i++;
      continue;
    }
    if (ch === '!' || ch === '[') {
      const link = linkAt(text, ch === '!' ? i + 1 : i, refs);
      if (link) {
        flush();
        if (ch === '!') out.push({ t: 'img', src: link.href, alt: plainText(link.label), title: link.title });
        else out.push({ t: 'link', href: link.href, title: link.title, c: parseInline(link.label, refs) });
        i = link.end;
        continue;
      }
    }
    if (ch === '<') {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(rest);
      if (auto) {
        flush();
        out.push({ t: 'link', href: auto[1], title: '', c: [{ t: 'text', v: auto[1] }] });
        i += auto[0].length;
        continue;
      }
      if (/^<br\s*\/?>/i.test(rest)) {
        flush();
        out.push({ t: 'br' });
        i += /^<br\s*\/?>/i.exec(rest)![0].length;
        continue;
      }
      const tag = /^<([a-z]+)>([\s\S]*?)<\/\1>/i.exec(rest);
      if (tag && INLINE_TAGS.has(tag[1].toLowerCase())) {
        flush();
        const name = tag[1].toLowerCase();
        const t = name === 'b' ? 'strong' : name === 'i' ? 'em' : name === 's' ? 'del' : name;
        out.push(t === 'code' ? { t: 'code', v: tag[2] } : { t: t as 'kbd', c: parseInline(tag[2], refs) });
        i += tag[0].length;
        continue;
      }
      // Other HTML in a line shows as it is written (never as markup).
    }
    const url = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]/.exec(rest);
    if (url && !/[\w/]$/.test(buf)) {
      flush();
      out.push({ t: 'link', href: url[0], title: '', c: [{ t: 'text', v: url[0] }] });
      i += url[0].length;
      continue;
    }
    const emph = emphasisAt(text, i);
    if (emph) {
      flush();
      out.push({ t: emph.t, c: parseInline(emph.inner, refs) });
      i = emph.end;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** `**strong**`, `*em*`, `_em_`, `~~del~~` starting at `i`. */
function emphasisAt(text: string, i: number): { t: 'em' | 'strong' | 'del'; inner: string; end: number } | null {
  const ch = text[i];
  if (ch !== '*' && ch !== '_' && ch !== '~') return null;
  const prev = text[i - 1] ?? ' ';
  // Underscores inside words (snake_case) aren't emphasis.
  if (ch === '_' && /[\p{L}\p{N}]/u.test(prev)) return null;
  for (const mark of ch === '~' ? ['~~'] : [ch.repeat(3), ch.repeat(2), ch]) {
    if (!text.startsWith(mark, i) || /\s/.test(text[i + mark.length] ?? ' ')) continue;
    let from = i + mark.length;
    while (from < text.length) {
      const end = text.indexOf(mark, from);
      if (end < 0) break;
      const after = text[end + mark.length] ?? ' ';
      const okEnd = !/\s/.test(text[end - 1]) && (ch !== '_' || !/[\p{L}\p{N}]/u.test(after)) && text[end + mark.length] !== ch;
      if (okEnd && end > i + mark.length) {
        const inner = text.slice(i + mark.length, end);
        if (mark.length === 3) return { t: 'strong', inner: `${ch}${inner}${ch}`, end: end + 3 };
        return { t: mark === '~~' ? 'del' : mark.length === 2 ? 'strong' : 'em', inner, end: end + mark.length };
      }
      from = end + 1;
    }
  }
  return null;
}

/** `[label](href "title")` or `[label][ref]` / `[ref]` starting at `i` (the `[`). */
function linkAt(text: string, i: number, refs: Refs): { label: string; href: string; title: string; end: number } | null {
  if (text[i] !== '[') return null;
  let depth = 0;
  let close = -1;
  for (let k = i; k < text.length; k++) {
    if (text[k] === '\\') k++;
    else if (text[k] === '[') depth++;
    else if (text[k] === ']' && --depth === 0) {
      close = k;
      break;
    }
  }
  if (close < 0) return null;
  const label = text.slice(i + 1, close);
  const after = text.slice(close + 1);
  const inline = /^\(\s*<?([^\s<>)]*(?:\([^\s)]*\)[^\s<>)]*)*)>?(?:\s+["'(]([^"')]*)["')])?\s*\)/.exec(after);
  if (inline) return { label, href: inline[1], title: inline[2] ?? '', end: close + 1 + inline[0].length };
  const full = /^\[([^\]]*)\]/.exec(after);
  const key = (full && full[1] ? full[1] : label).toLowerCase();
  const ref = refs.get(key);
  if (ref) return { label, href: ref.href, title: ref.title, end: close + 1 + (full ? full[0].length : 0) };
  return null;
}
