/**
 * Editing helpers for the request body: colours for JSON as it is typed (valid or not, with
 * {{variables}}), and the small code-editor keys (indent on Enter, closing brackets and quotes).
 * Each key returns a TextEdit for the textarea to apply, so the browser's undo keeps working.
 */

import type { TokenKind } from './jsonView';

export interface Span {
  text: string;
  /** null = plain text (spaces, or something that isn't JSON). */
  kind: TokenKind | 'var' | null;
}

export interface TextEdit {
  /** Replace text[from, to) with `insert`, then select [selStart, selEnd). */
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

const UNIT = '  ';
const LEXEME = /\{\{[^}\n]*\}\}|"(?:[^"\\\n]|\\.)*"?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]|\s+|[^\s{}[\],:"]+|./y;
const VAR = /(\{\{[^}\n]*\}\})/;

/** `text` cut into coloured pieces; joined they give `text` back. Strings may be unfinished. */
export function jsonSpans(text: string): Span[] {
  const out: Span[] = [];
  LEXEME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (LEXEME.lastIndex < text.length && (m = LEXEME.exec(text))) {
    const t = m[0];
    const c = t[0];
    if (t.startsWith('{{') && t.length > 2) out.push({ text: t, kind: 'var' });
    else if (c === '"') {
      const kind = /^\s*:/.test(text.slice(LEXEME.lastIndex, LEXEME.lastIndex + 200)) ? 'key' : 'str';
      for (const part of t.split(VAR)) if (part) out.push({ text: part, kind: VAR.test(part) ? 'var' : kind });
    } else if (/^-?\d/.test(t)) out.push({ text: t, kind: 'num' });
    else if (t === 'true' || t === 'false' || t === 'null') out.push({ text: t, kind: 'lit' });
    else if (t.length === 1 && '{}[],:'.includes(c)) out.push({ text: t, kind: 'punct' });
    else out.push({ text: t, kind: null });
  }
  return out;
}

const lineStart = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1;
const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];
const PAIRS: Record<string, string> = { '{': '}', '[': ']', '"': '"' };

/** Enter: the new line keeps the indentation, one level more after `{` or `[`. */
export function enterEdit(text: string, start: number, end: number, json: boolean): TextEdit {
  const ls = lineStart(text, start);
  const before = text.slice(ls, start);
  const indent = indentOf(before);
  // Spaces after the caret would only push the next line's content right.
  const to = end + /^[ \t]*/.exec(text.slice(end))![0].length;
  const prev = before.trimEnd().slice(-1);
  const next = text[to];
  if (json && (prev === '{' || prev === '[')) {
    const inner = indent + UNIT;
    // Between a pair ({|}): the closer goes to its own line below.
    const insert = next === PAIRS[prev] ? `\n${inner}\n${indent}` : `\n${inner}`;
    const caret = start + 1 + inner.length;
    return { from: start, to, insert, selStart: caret, selEnd: caret };
  }
  const insert = `\n${indent}`;
  return { from: start, to, insert, selStart: start + insert.length, selEnd: start + insert.length };
}

/** A typed character that the editor handles itself, or null to let the textarea take it. */
export function charEdit(text: string, start: number, end: number, ch: string): TextEdit | null {
  const next = text[end] ?? '';
  const prev = text[start - 1] ?? '';
  // Typing the closer that is already there steps over it.
  if (start === end && (ch === '}' || ch === ']' || ch === '"') && next === ch && !(ch === '"' && prev === '\\')) {
    return { from: start, to: start, insert: '', selStart: start + 1, selEnd: start + 1 };
  }
  if (ch === '}' || ch === ']') {
    // On a line of only spaces the closer moves back a level, under its opening line.
    const ls = lineStart(text, start);
    const before = text.slice(ls, start);
    if (start === end && before.length > 0 && !before.trim()) {
      const indent = before.slice(0, Math.max(0, before.length - UNIT.length));
      return { from: ls, to: start, insert: indent + ch, selStart: ls + indent.length + 1, selEnd: ls + indent.length + 1 };
    }
    return null;
  }
  if (!(ch in PAIRS)) return null;
  const close = PAIRS[ch];
  // A selection gets wrapped: "selected" or [selected].
  if (start !== end) {
    const inner = text.slice(start, end);
    return { from: start, to: end, insert: ch + inner + close, selStart: start + 1, selEnd: end + 1 };
  }
  // Pair only where nothing follows that the new value would run into.
  if (next && !/[\s}\],:]/.test(next)) return null;
  if (ch === '"' && (/[\w\\"]/.test(prev) || inString(text, start))) return null;
  return { from: start, to: start, insert: ch + close, selStart: start + 1, selEnd: start + 1 };
}

/** Whether `pos` is inside a string on its line (an odd number of unescaped quotes before it). */
function inString(text: string, pos: number): boolean {
  const before = text.slice(lineStart(text, pos), pos).replace(/\\./g, '');
  return (before.split('"').length - 1) % 2 === 1;
}

/** Backspace: removes an empty pair ({|}) at once, and one indent level in leading spaces. */
export function backspaceEdit(text: string, start: number, end: number, json: boolean): TextEdit | null {
  if (start !== end || start === 0) return null;
  const prev = text[start - 1];
  if (json && PAIRS[prev] && text[start] === PAIRS[prev]) return { from: start - 1, to: start + 1, insert: '', selStart: start - 1, selEnd: start - 1 };
  const before = text.slice(lineStart(text, start), start);
  if (before.length >= 2 && /^ +$/.test(before)) {
    const n = before.length % UNIT.length || UNIT.length;
    return { from: start - n, to: start, insert: '', selStart: start - n, selEnd: start - n };
  }
  return null;
}

/** Tab / Shift+Tab: indents or outdents the selected lines; Tab without a selection inserts spaces. */
export function tabEdit(text: string, start: number, end: number, outdent: boolean): TextEdit | null {
  if (!outdent && !text.slice(start, end).includes('\n')) {
    return { from: start, to: end, insert: UNIT, selStart: start + UNIT.length, selEnd: start + UNIT.length };
  }
  const from = lineStart(text, start);
  // A selection ending at the start of a line doesn't take that line with it.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const lineEnd = text.indexOf('\n', last);
  const to = lineEnd < 0 ? text.length : lineEnd;
  const lines = text.slice(from, to).split('\n');
  let firstShift = 0;
  let total = 0;
  const changed = lines.map((l, i) => {
    const cut = outdent ? Math.min(indentOf(l).length, UNIT.length) : 0;
    const shift = outdent ? -cut : UNIT.length;
    if (i === 0) firstShift = shift;
    total += shift;
    return outdent ? l.slice(cut) : UNIT + l;
  });
  if (outdent && total === 0) return null;
  const insert = changed.join('\n');
  return {
    from,
    to,
    insert,
    selStart: Math.max(from, start + firstShift),
    selEnd: start === end ? Math.max(from, start + firstShift) : end + total,
  };
}
