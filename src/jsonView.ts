/**
 * Pretty-printed JSON for the response view, as lines of coloured tokens with the ranges that can
 * be folded. Formatted from the original text rather than through JSON.parse, so numbers too large
 * for JavaScript keep every digit.
 */

export type TokenKind = 'key' | 'str' | 'num' | 'lit' | 'punct';

export interface Token {
  text: string;
  kind: TokenKind;
}

export interface JsonLine {
  /** Indentation level. */
  depth: number;
  tokens: Token[];
  /** For a line that opens an object or array: the line that closes it. */
  closes?: number;
}

const TOKEN = /\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:])/y;

function tokenize(text: string): string[] | null {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (TOKEN.lastIndex < text.length && (m = TOKEN.exec(text))) out.push(m[1]);
  return /^\s*$/.test(text.slice(TOKEN.lastIndex)) ? out : null;
}

const kindOf = (t: string, isKey: boolean): TokenKind =>
  t.startsWith('"') ? (isKey ? 'key' : 'str') : /^[-\d]/.test(t) ? 'num' : /^[a-z]/.test(t) ? 'lit' : 'punct';

/** The lines of `text` pretty-printed, or null when it isn't JSON. */
export function jsonLines(text: string): JsonLine[] | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  const tokens = tokenize(text);
  if (!tokens) return null;
  const lines: JsonLine[] = [];
  const open: number[] = [];
  let line: JsonLine = { depth: 0, tokens: [] };
  const newLine = (depth: number) => {
    lines.push(line);
    line = { depth, tokens: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t === '{' || t === '[') {
      line.tokens.push({ text: t, kind: 'punct' });
      // An empty object or array stays on one line.
      if (next === (t === '{' ? '}' : ']')) {
        line.tokens.push({ text: next, kind: 'punct' });
        i++;
        continue;
      }
      open.push(lines.length);
      newLine(open.length);
    } else if (t === '}' || t === ']') {
      newLine(open.length - 1);
      line.tokens.push({ text: t, kind: 'punct' });
      const start = open.pop();
      if (start !== undefined) lines[start].closes = lines.length;
    } else if (t === ',') {
      line.tokens.push({ text: ',', kind: 'punct' });
      newLine(open.length);
    } else if (t === ':') {
      line.tokens.push({ text: ': ', kind: 'punct' });
    } else {
      line.tokens.push({ text: t, kind: kindOf(t, next === ':') });
    }
  }
  lines.push(line);
  return lines;
}

/** The text of a line, indented two spaces per level. */
export function lineText(l: JsonLine): string {
  return '  '.repeat(l.depth) + l.tokens.map((t) => t.text).join('');
}
