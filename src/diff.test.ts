import { describe, expect, it } from 'vitest';
import type { Hunk } from './api';
import { changeStarts, foldRows, inlineRows, lineMarks, pairRows, splitLines, wholeFileHunks, wordDiff } from './diff';

const h = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({ oldStart, oldCount, newStart, newCount });

describe('splitLines', () => {
  it('splits on LF and CRLF without an empty last line', () => {
    expect(splitLines('a\r\nb\nc\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('x')).toEqual(['x']);
  });
});

// old: one two three        new: one 2 three four
const hunks = [h(2, 1, 2, 1), h(3, 0, 4, 1)];

describe('inlineRows', () => {
  it('lines up both texts with the hunks', () => {
    expect(inlineRows(hunks, 3).map((r) => [r.kind, r.old, r.new])).toEqual([
      ['same', 0, 0],
      ['del', 1, null],
      ['add', null, 1],
      ['same', 2, 2],
      ['add', null, 3],
    ]);
  });

  it('handles insertions at the top and removals at the end', () => {
    expect(inlineRows([h(0, 0, 1, 1), h(2, 1, 2, 0)], 2).map((r) => [r.kind, r.old, r.new])).toEqual([
      ['add', null, 0],
      ['same', 0, 1],
      ['del', 1, null],
    ]);
  });

  it('shows new and deleted files whole', () => {
    expect(inlineRows(wholeFileHunks(0, 2), 0).map((r) => r.kind)).toEqual(['add', 'add']);
    expect(inlineRows(wholeFileHunks(2, 0), 2).map((r) => r.kind)).toEqual(['del', 'del']);
    expect(wholeFileHunks(0, 0)).toEqual([]);
  });
});

describe('pairRows', () => {
  it('pairs changed lines and leaves the rest one-sided', () => {
    expect(pairRows([h(2, 2, 2, 1), h(5, 0, 5, 1)], 5).map((r) => [r.kind, r.old, r.new])).toEqual([
      ['same', 0, 0],
      ['mod', 1, 1],
      ['del', 2, null],
      ['same', 3, 2],
      ['same', 4, 3],
      ['add', null, 4],
    ]);
  });
});

describe('foldRows', () => {
  const rows = (kinds: string) => [...kinds].map((k) => ({ kind: k === '.' ? 'same' : 'add' }));

  it('keeps context around changes and folds the rest', () => {
    const out = foldRows(rows('..........+..........'), 2, new Set());
    expect(out.map((r) => ('fold' in r ? `fold${r.fold}@${r.key}` : r.kind === 'same' ? '.' : '+'))).toEqual(['fold8@0', '.', '.', '+', '.', '.', 'fold8@13']);
  });

  it('leaves short runs and opened folds alone', () => {
    expect(foldRows(rows('...+...'), 2, new Set()).length).toBe(7);
    expect(foldRows(rows('..........+'), 2, new Set([0])).length).toBe(11);
  });

  it('finds where changes start', () => {
    const out = foldRows(rows('++.....++..........+'), 1, new Set());
    expect(changeStarts(out)).toEqual([0, 7, 12]);
  });
});

describe('lineMarks', () => {
  it('marks added, changed and removed-below lines of the new text', () => {
    const marks = lineMarks([h(2, 1, 2, 1), h(3, 0, 4, 2), h(9, 2, 9, 0)]);
    expect([...marks.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 'mod'],
      [3, 'add'],
      [4, 'add'],
      [8, 'del'],
    ]);
  });
});

describe('wordDiff', () => {
  it('finds the words that changed', () => {
    const d = wordDiff('const total = price * 2;', 'const total = price * qty;');
    expect(d).toEqual({ old: [[22, 23]], new: [[22, 25]] });
  });

  it('marks inserted words only on the new side', () => {
    expect(wordDiff('a(b)', 'a(b, c)')).toEqual({ old: [], new: [[3, 6]] });
  });

  it('gives up on lines with little in common', () => {
    expect(wordDiff('import { x } from "y";', 'return totally + different * stuff;')).toBeNull();
  });
});
