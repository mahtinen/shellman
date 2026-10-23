/**
 * Laying out a diff for the Files pane. git decides what changed (its hunks, from `git diff -U0`);
 * this lines up the two versions' full texts with them, inline or side by side, folds the unchanged
 * runs, and finds the words that changed inside a changed line. Pure functions.
 */
import type { Hunk } from './api';

/** A file's text as lines (a final newline doesn't start another line). */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** One row of an inline diff: line indexes (0-based) in the old and the new text. */
export interface InlineRow {
  kind: 'same' | 'del' | 'add';
  old: number | null;
  new: number | null;
}

/** One row of a side-by-side diff; a changed line pairs the old with the new one. */
export interface PairRow {
  kind: 'same' | 'mod' | 'del' | 'add';
  old: number | null;
  new: number | null;
}

/** Where a hunk's lines start (0-based): a count of 0 means "after line start". */
const from = (start: number, count: number) => (count ? start - 1 : start);

/** Calls `same` for the unchanged runs and `hunk` for each hunk, in order. */
function walk(hunks: Hunk[], oldLen: number, same: (o: number, n: number) => void, hunk: (h: Hunk, o: number, n: number) => void): void {
  let o = 0;
  let n = 0;
  for (const h of hunks) {
    const oStart = Math.min(from(h.oldStart, h.oldCount), oldLen);
    for (; o < oStart; o++, n++) same(o, n);
    n = from(h.newStart, h.newCount);
    hunk(h, o, n);
    o += h.oldCount;
    n += h.newCount;
  }
  for (; o < oldLen; o++, n++) same(o, n);
}

export function inlineRows(hunks: Hunk[], oldLen: number): InlineRow[] {
  const rows: InlineRow[] = [];
  walk(
    hunks,
    oldLen,
    (o, n) => rows.push({ kind: 'same', old: o, new: n }),
    (h, o, n) => {
      for (let i = 0; i < h.oldCount; i++) rows.push({ kind: 'del', old: o + i, new: null });
      for (let i = 0; i < h.newCount; i++) rows.push({ kind: 'add', old: null, new: n + i });
    },
  );
  return rows;
}

export function pairRows(hunks: Hunk[], oldLen: number): PairRow[] {
  const rows: PairRow[] = [];
  walk(
    hunks,
    oldLen,
    (o, n) => rows.push({ kind: 'same', old: o, new: n }),
    (h, o, n) => {
      for (let i = 0; i < Math.max(h.oldCount, h.newCount); i++) {
        const old = i < h.oldCount ? o + i : null;
        const nw = i < h.newCount ? n + i : null;
        rows.push({ kind: old === null ? 'add' : nw === null ? 'del' : 'mod', old, new: nw });
      }
    },
  );
  return rows;
}

/** Hunks for a file that is new (`oldLen` 0) or gone (`newLen` 0). */
export function wholeFileHunks(oldLen: number, newLen: number): Hunk[] {
  if (!oldLen && !newLen) return [];
  return [{ oldStart: oldLen ? 1 : 0, oldCount: oldLen, newStart: newLen ? 1 : 0, newCount: newLen }];
}

/** A run of unchanged rows folded away; `key` (its first row's index) keeps it open once clicked. */
export interface Fold {
  fold: number;
  key: number;
}

/**
 * Leaves `context` unchanged rows around each change and folds longer runs into one row. Folds
 * whose key is in `open` stay unfolded; a run of fewer than `min` rows isn't worth folding.
 */
export function foldRows<T extends { kind: string }>(rows: T[], context: number, open: ReadonlySet<number>, min = 4): (T | Fold)[] {
  const out: (T | Fold)[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'same') {
      out.push(rows[i++]);
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].kind === 'same') end++;
    const keepBefore = i === 0 ? 0 : context;
    const keepAfter = end === rows.length ? 0 : context;
    const hidden = end - i - keepBefore - keepAfter;
    const key = i + keepBefore;
    if (hidden >= min && !open.has(key)) {
      out.push(...rows.slice(i, key));
      out.push({ fold: hidden, key });
      out.push(...rows.slice(key + hidden, end));
    } else {
      out.push(...rows.slice(i, end));
    }
    i = end;
  }
  return out;
}

export const isFold = (r: object): r is Fold => 'fold' in r;

/** Indexes of the rows where a run of changes starts (for next / previous change). */
export function changeStarts(rows: ({ kind: string } | Fold)[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    const changed = !isFold(r) && r.kind !== 'same';
    const prev = rows[i - 1];
    if (changed && (!prev || isFold(prev) || prev.kind === 'same')) out.push(i);
  });
  return out;
}

/** How a line of the new text changed, for the marks next to it in the file view. */
export type LineMark = 'add' | 'mod' | 'del';

/** Marks for the lines of the new text (0-based): added, changed, or lines were removed below it. */
export function lineMarks(hunks: Hunk[]): Map<number, LineMark> {
  const marks = new Map<number, LineMark>();
  for (const h of hunks) {
    if (!h.newCount) {
      // Removed lines sit between new lines `newStart` and `newStart + 1`: mark the one above.
      marks.set(Math.max(0, h.newStart - 1), marks.get(Math.max(0, h.newStart - 1)) ?? 'del');
      continue;
    }
    for (let i = 0; i < h.newCount; i++) marks.set(h.newStart - 1 + i, h.oldCount ? 'mod' : 'add');
  }
  return marks;
}

/** Character ranges [start, end) that changed within a line. */
export type Ranges = [number, number][];

const TOKEN = /\w+|\s+|[^\w\s]/g;
/** Above this many token pairs, finding the changed words costs more than it shows. */
const MAX_CELLS = 250_000;

/**
 * The words that differ between an old and a new version of a line, or null when the lines have
 * too little in common for that to help (then the whole line counts as changed).
 */
export function wordDiff(a: string, b: string): { old: Ranges; new: Ranges } | null {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  if (ta.length * tb.length > MAX_CELLS) return null;
  // Longest common subsequence of tokens, from the end.
  const w = tb.length + 1;
  const lcs = new Uint32Array((ta.length + 1) * w);
  for (let i = ta.length - 1; i >= 0; i--) {
    for (let j = tb.length - 1; j >= 0; j--) {
      lcs[i * w + j] = ta[i] === tb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const old: Ranges = [];
  const nw: Ranges = [];
  const add = (r: Ranges, start: number, len: number) => {
    const last = r[r.length - 1];
    if (last && last[1] === start) last[1] = start + len;
    else r.push([start, start + len]);
  };
  let i = 0;
  let j = 0;
  let pa = 0;
  let pb = 0;
  let commonWords = 0;
  while (i < ta.length || j < tb.length) {
    if (i < ta.length && j < tb.length && ta[i] === tb[j]) {
      if (ta[i].trim()) commonWords++;
      pa += ta[i++].length;
      pb += tb[j++].length;
    } else if (j < tb.length && (i === ta.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      add(nw, pb, tb[j].length);
      pb += tb[j++].length;
    } else {
      add(old, pa, ta[i].length);
      pa += ta[i++].length;
    }
  }
  // Mostly different lines: marking nearly every word would only be noise.
  const words = (t: string[]) => t.filter((x) => x.trim()).length;
  if (commonWords * 2 < Math.min(words(ta), words(tb))) return null;
  return { old, new: nw };
}
