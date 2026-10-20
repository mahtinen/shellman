import { describe, expect, it } from 'vitest';
import { jsonLines, lineText } from './jsonView';

describe('JSON view', () => {
  it('pretty-prints with fold ranges', () => {
    const lines = jsonLines('{"data":[{"id":1,"ok":true}],"next":null,"empty":{},"e":[]}')!;
    expect(lines.map(lineText)).toEqual([
      '{',
      '  "data": [',
      '    {',
      '      "id": 1,',
      '      "ok": true',
      '    }',
      '  ],',
      '  "next": null,',
      '  "empty": {},',
      '  "e": []',
      '}',
    ]);
    expect(lines.map((l) => l.closes)).toEqual([10, 6, 5, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(lines[1].tokens.map((t) => t.kind)).toEqual(['key', 'punct', 'punct']);
    expect(lines[3].tokens.map((t) => t.kind)).toEqual(['key', 'punct', 'num', 'punct']);
  });

  it('keeps large numbers and escapes as they were', () => {
    const lines = jsonLines('{"id": 12345678901234567890, "s": "a\\"b\\u00e4"}')!;
    expect(lines.map(lineText)).toEqual(['{', '  "id": 12345678901234567890,', '  "s": "a\\"b\\u00e4"', '}']);
  });

  it('returns null for anything else', () => {
    expect(jsonLines('<html></html>')).toBeNull();
    expect(jsonLines('')).toBeNull();
    expect(jsonLines('{"a":1} trailing')).toBeNull();
    expect(jsonLines('42')!.map(lineText)).toEqual(['42']);
  });
});
