import { describe, expect, it } from 'vitest';
import { backspaceEdit, charEdit, enterEdit, jsonSpans, tabEdit, type TextEdit } from './codeEdit';

/** Applies an edit to `text` with the caret (or selection) marked by | (or [ … ]); returns the same notation. */
function run(marked: string, edit: (text: string, start: number, end: number) => TextEdit | null): string | null {
  const sel = marked.indexOf('«');
  const text = marked.replace(/[|«»]/g, '');
  const start = sel >= 0 ? sel : marked.indexOf('|');
  const end = sel >= 0 ? marked.indexOf('»') - 1 : start;
  const e = edit(text, start, end);
  if (!e) return null;
  const out = text.slice(0, e.from) + e.insert + text.slice(e.to);
  return e.selStart === e.selEnd ? out.slice(0, e.selStart) + '|' + out.slice(e.selStart) : out.slice(0, e.selStart) + '«' + out.slice(e.selStart, e.selEnd) + '»' + out.slice(e.selEnd);
}

describe('jsonSpans', () => {
  it('gives the text back and colours keys, values and variables', () => {
    const text = '{\n  "id": {{userId}},\n  "name": "Hi {{who}}", "n": -1.5e3, "ok": true\n}';
    const spans = jsonSpans(text);
    expect(spans.map((s) => s.text).join('')).toBe(text);
    const kinds = (k: string) => spans.filter((s) => s.kind === k).map((s) => s.text);
    expect(kinds('key')).toEqual(['"id"', '"name"', '"n"', '"ok"']);
    expect(kinds('var')).toEqual(['{{userId}}', '{{who}}']);
    expect(kinds('str')).toEqual(['"Hi ', '"']);
    expect(kinds('num')).toEqual(['-1.5e3']);
    expect(kinds('lit')).toEqual(['true']);
  });

  it('copes with text that is not (yet) JSON', () => {
    for (const text of ['{"a": "unfinished\n}', '{{', 'hello world', '{"a" : 1,,]}}}', '"\\"', '']) {
      expect(jsonSpans(text).map((s) => s.text).join('')).toBe(text);
    }
    expect(jsonSpans('{"a" : 1}').find((s) => s.text === '"a"')?.kind).toBe('key');
  });
});

describe('enterEdit', () => {
  const enter = (m: string, json = true) => run(m, (t, s, e) => enterEdit(t, s, e, json));

  it('keeps the indentation of the line', () => {
    expect(enter('{\n  "a": 1,|\n}')).toBe('{\n  "a": 1,\n  |\n}');
    expect(enter('    text|', false)).toBe('    text\n    |');
  });

  it('indents one level after an opening bracket', () => {
    expect(enter('{|')).toBe('{\n  |');
    expect(enter('  "a": [|')).toBe('  "a": [\n    |');
    expect(enter('{ |', false)).toBe('{ \n|');
  });

  it('puts the closer of an empty pair on its own line', () => {
    expect(enter('{|}')).toBe('{\n  |\n}');
    expect(enter('  "a": [|  ]')).toBe('  "a": [\n    |\n  ]');
  });

  it('replaces a selection', () => {
    expect(enter('  «abc»def')).toBe('  \n  |def');
  });
});

describe('charEdit', () => {
  const type = (m: string, ch: string) => run(m, (t, s, e) => charEdit(t, s, e, ch));

  it('closes brackets and quotes where a value goes', () => {
    expect(type('|', '{')).toBe('{|}');
    expect(type('{"a": |}', '[')).toBe('{"a": [|]}');
    expect(type('{|}', '"')).toBe('{"|"}');
    expect(type('|abc', '{')).toBeNull();
    expect(type('{"ab|', '"')).toBeNull();
    expect(type('"it\'s |', '"')).toBeNull();
  });

  it('steps over the closer that is already there', () => {
    expect(type('{"a|"}', '"')).toBe('{"a"|}');
    expect(type('[1|]', ']')).toBe('[1]|');
    expect(type('"a\\|"', '"')).toBeNull();
  });

  it('wraps a selection', () => {
    expect(type('«abc»', '"')).toBe('"«abc»"');
    expect(type('«1, 2»', '[')).toBe('[«1, 2»]');
  });

  it('moves a closer on an empty line back a level', () => {
    expect(type('{\n  "a": {\n    |', '}')).toBe('{\n  "a": {\n  }|');
    expect(type('[1, |', ']')).toBeNull();
    expect(type('|', 'x')).toBeNull();
  });
});

describe('backspaceEdit', () => {
  const back = (m: string) => run(m, (t, s, e) => backspaceEdit(t, s, e, true));

  it('removes an empty pair and one indent level', () => {
    expect(back('{|}')).toBe('|');
    expect(back('""|')).toBeNull();
    expect(back('{\n    |')).toBe('{\n  |');
    expect(back('{\n   |')).toBe('{\n  |');
    expect(back(' |')).toBeNull();
    expect(back('ab|')).toBeNull();
  });
});

describe('tabEdit', () => {
  const tab = (m: string, out = false) => run(m, (t, s, e) => tabEdit(t, s, e, out));

  it('inserts spaces without a selection', () => {
    expect(tab('a|b')).toBe('a  |b');
  });

  it('indents and outdents the selected lines', () => {
    expect(tab('«a\nb»')).toBe('  «a\n  b»');
    expect(tab('  «a\n    b»', true)).toBe('«a\n  b»');
    expect(tab('«a\nb\n»c')).toBe('  «a\n  b\n»c');
  });

  it('outdents the current line with Shift+Tab', () => {
    expect(tab('    a|b', true)).toBe('  a|b');
    expect(tab('ab|', true)).toBeNull();
  });
});
