import { describe, expect, it } from 'vitest';
import { appendText, editorText, fileEol, fileText, findAll, nearestMatch, nextNoteName } from './note';

describe('notes', () => {
  it('names new notes with the lowest free number', () => {
    expect(nextNoteName([])).toBe('Note 1');
    expect(nextNoteName(['Note 1', 'todo.txt', 'Note 3'])).toBe('Note 2');
  });

  it('keeps a file\'s line endings, and uses CRLF for new files', () => {
    const crlf = 'a\r\nb\r\n';
    expect(editorText(crlf)).toBe('a\nb\n');
    expect(fileEol(crlf)).toBe('crlf');
    expect(fileEol('a\nb')).toBe('lf');
    expect(fileEol('one line')).toBe('crlf');
    expect(fileText(editorText(crlf), fileEol(crlf))).toBe(crlf);
    expect(fileText('a\nb', 'lf')).toBe('a\nb');
    expect(editorText('old\rmac')).toBe('old\nmac');
  });

  it('appends on lines of their own', () => {
    expect(appendText('', 'ls -la\r\n')).toBe('ls -la\n');
    expect(appendText('first', 'second')).toBe('first\nsecond\n');
    expect(appendText('first\n', 'second\n\n')).toBe('first\nsecond\n');
  });

  it('finds text ignoring case', () => {
    expect(findAll('Error error ERROR', 'error')).toEqual([0, 6, 12]);
    expect(findAll('aaaa', 'aa')).toEqual([0, 2]);
    expect(findAll('abc', '')).toEqual([]);
    // Lower-casing "İ" makes it longer: offsets must still point into the text as it is.
    expect(findAll('İx x', 'x')).toEqual([1, 3]);
  });

  it('goes to the match nearest the caret, wrapping around', () => {
    const m = [2, 10, 20];
    expect(nearestMatch(m, 0, false)).toBe(0);
    expect(nearestMatch(m, 10, false)).toBe(1);
    expect(nearestMatch(m, 21, false)).toBe(0);
    expect(nearestMatch(m, 10, true)).toBe(0);
    expect(nearestMatch(m, 1, true)).toBe(2);
    expect(nearestMatch([], 0, false)).toBe(-1);
  });
});
