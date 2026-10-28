/**
 * Pure helpers for note panes: names, line endings and finding text. The editor (a textarea) always
 * holds `\n` line endings; a file keeps the ones it had, and a new file gets Windows' CRLF.
 */

export type Eol = 'crlf' | 'lf';

/** "Note 1", or the lowest number no open note uses. */
export function nextNoteName(taken: string[]): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`Note ${n}`)) return `Note ${n}`;
}

/** The text as the editor holds it. */
export function editorText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The line endings a file uses (CRLF when it has none yet). */
export function fileEol(text: string): Eol {
  return !text.includes('\r\n') && text.includes('\n') ? 'lf' : 'crlf';
}

/** The editor's text as it is written to a file. */
export function fileText(text: string, eol: Eol): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}

/** `text` with `added` on lines of its own after it. */
export function appendText(text: string, added: string): string {
  const clean = editorText(added).replace(/\n+$/, '');
  if (!text) return `${clean}\n`;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${clean}\n`;
}

/** Where `query` occurs in `text` (ignoring case), as start offsets. */
export function findAll(text: string, query: string): number[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const q = query.toLowerCase();
  // Lower-casing can change a string's length (e.g. "İ"); then offsets wouldn't match the text.
  if (hay.length !== text.length || q.length !== query.length) return findExact(text, query);
  return findExact(hay, q);
}

function findExact(text: string, q: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push(i);
  return out;
}

/** The match to go to from the caret: the first at or after it, or the last before it (wrapping). */
export function nearestMatch(matches: number[], caret: number, backwards: boolean): number {
  if (!matches.length) return -1;
  if (backwards) {
    for (let i = matches.length - 1; i >= 0; i--) if (matches[i] < caret) return i;
    return matches.length - 1;
  }
  const i = matches.findIndex((m) => m >= caret);
  return i >= 0 ? i : 0;
}
