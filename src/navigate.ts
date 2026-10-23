/**
 * Search-based code navigation for the Files pane: "go to definition", "implementations" and the
 * symbols of a file, found by recognising declarations in a line's text (no language server). It
 * covers the common shapes in C#, Java, TypeScript/JavaScript, Rust, Go, Python, C/C++, shell,
 * PowerShell and SQL; a name declared in several places gives a list to choose from. Pure functions.
 */
import type { Ranges } from './diff';

export interface QueryOptions {
  query: string;
  caseSensitive: boolean;
  word: boolean;
  regex: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The query as a JavaScript pattern, to mark the matches in a line (null: not a valid pattern). */
export function queryRegExp(q: QueryOptions): RegExp | null {
  if (!q.query) return null;
  let source = q.regex ? q.query : escape(q.query);
  if (q.word) source = `(?<![\\w])(?:${source})(?![\\w])`;
  try {
    return new RegExp(source, q.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/** Where `re` matches in `text`. */
export function matchRanges(text: string, re: RegExp | null): Ranges {
  if (!re) return [];
  const out: Ranges = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m && out.length < 200; m = re.exec(text)) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** The name (identifier) at `offset` in `text`, or touching it from the left. */
export function wordAt(text: string, offset: number): { word: string; start: number; end: number } | null {
  const isWord = (c: string | undefined) => !!c && /[\w$]/.test(c);
  let at = Math.max(0, Math.min(offset, text.length));
  if (!isWord(text[at]) && isWord(text[at - 1])) at--;
  if (!isWord(text[at])) return null;
  let start = at;
  let end = at;
  while (isWord(text[start - 1])) start--;
  while (isWord(text[end])) end++;
  const word = text.slice(start, end);
  return /^[\d$]+$/.test(word) ? null : { word, start, end };
}

/** Words in front of a name that make it a use, not a declaration (`return x(`, `new X(`). */
const NOT_A_TYPE = new Set(
  'return new await throw yield else case goto delete typeof sizeof nameof in of is as not and or using import from echo print if for foreach while switch catch lock when do extends implements class struct interface enum record trait impl throws where'.split(' '),
);
/** Names that look like a call in a declaration's place: control flow. */
const KEYWORD_CALLS = new Set('if for foreach while switch catch using lock return when sizeof typeof nameof function else new await'.split(' '));

const MODS =
  '(?:(?:export|default|public|private|protected|internal|static|async|override|virtual|abstract|sealed|partial|extern|unsafe|readonly|final|synchronized|inline|constexpr|declare|pub(?:\\([^)]*\\))?|open|data|suspend|operator|const|required|file|implicit|explicit|event|fixed)\\s+)*';
const DECL_KEYWORDS =
  'function\\*?|class|interface|type|enum|struct|union|trait|record|module|namespace|object|protocol|typedef|mod|def|fn|func|fun|macro_rules!|let|const|var|val|static|alias';
const TYPE_WORD = '[\\w$.]+(?:<[^;=()]*>)?(?:\\[[^\\]]*\\])*[?*&]*';

/** A comment line (where a name is mentioned, not declared). */
function isComment(line: string): boolean {
  const t = line.trimStart();
  return /^(\/\/|\/\*|\*|--|<!--|')/.test(t) || (t.startsWith('#') && !/^#\s*(define|\[)/.test(t));
}

/** How strongly `line` looks like it declares `name` (0: it doesn't). */
export function declarationScore(line: string, name: string): number {
  if (!name || isComment(line)) return 0;
  const n = escape(name);
  // class Foo, fn foo, def foo, const foo, interface IFoo, let mut foo, enum class Foo …
  if (new RegExp(`\\b(?:${DECL_KEYWORDS})\\s+(?:[\\w$]+\\s+)?${n}(?![\\w$])`).test(line)) return 30;
  if (new RegExp(`^\\s*#\\s*define\\s+${n}\\b`).test(line)) return 30;
  // Go: func (s *Server) Name(
  if (new RegExp(`\\bfunc\\s*\\([^)]*\\)\\s*${n}\\s*[(\\[]`).test(line)) return 30;
  // PowerShell, SQL, VB: any case.
  if (new RegExp(`\\b(?:function|filter|sub|procedure|create\\s+(?:or\\s+replace\\s+)?(?:table|view|function|procedure|trigger|type|index))\\s+(?:[\\w.\\[\\]"]*\\.)?["\\[]?${n}\\b`, 'i').test(line)) return 25;
  // Typed declarations (C#, Java, C, C++): public Task<User> GetById(…), int count = 0;, string Name { get; }
  const typed = new RegExp(`^\\s*${MODS}((?:${TYPE_WORD}\\s+)+)${n}\\s*(?:<[^>]*>)?\\s*(?:\\(|\\{|=>|;|=(?!=)|$)`).exec(line);
  if (typed && !typed[1].trim().split(/\s+/).some((w) => NOT_A_TYPE.has(w))) return 20;
  // Class members (TypeScript, JavaScript): foo(a: string): void {, get foo() {, foo = (e) => {
  if (new RegExp(`^\\s*${MODS}(?:get\\s+|set\\s+|\\*\\s*)?#?${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^=;{]*)?\\{\\s*$`).test(line)) return 15;
  if (new RegExp(`^\\s*${MODS}#?${n}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]*)?=>|[\\w$]+\\s*=>)`).test(line)) return 15;
  // Object literal methods: foo: function (, foo: (x) =>
  if (new RegExp(`^\\s*['"]?${n}['"]?\\s*:\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)`).test(line)) return 10;
  // Shell functions: name() {
  if (new RegExp(`^\\s*${n}\\s*\\(\\)\\s*\\{?\\s*$`).test(line)) return 10;
  return 0;
}

/** Whether `line` declares a type that implements or extends `name`, or (Rust) an impl of it. */
export function implementsName(line: string, name: string): boolean {
  if (!name || isComment(line)) return false;
  const n = escape(name);
  return [
    // C#, Kotlin, Swift, C++: class UserService : IUserService, class X : public Base
    `\\b(?:class|struct|record|object|enum|interface)\\s+[\\w$]+(?:<[^>]*>)?(?:\\([^)]*\\))?\\s*:\\s*[^{]*\\b${n}\\b`,
    // TypeScript, Java: class X extends Base implements IFoo
    `\\b(?:class|interface)\\s+[\\w$]+[^{]*\\b(?:extends|implements)\\s+[^{]*\\b${n}\\b`,
    // Rust: impl Trait for Type, impl Type
    `\\bimpl(?:<[^>]*>)?\\s+(?:[\\w$]+::)*${n}\\b`,
    `\\bimpl(?:<[^>]*>)?\\s+[^{]*\\bfor\\s+(?:[\\w$]+::)*${n}\\b`,
    // Python: class X(Base)
    `\\bclass\\s+\\w+\\s*\\([^)]*\\b${n}\\b`,
  ].some((p) => new RegExp(p).test(line));
}

export interface Located {
  path: string;
  line: number;
  text: string;
}

/**
 * The declarations of `name` among search results (a whole-word search for it), best first: in the
 * file you are reading, then files of the same kind, then the rest.
 */
export function definitions<T extends Located>(matches: T[], name: string, currentPath: string): T[] {
  const ext = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const scored = matches
    .map((m) => ({ m, score: declarationScore(m.text, name) }))
    .filter((x) => x.score > 0)
    .map((x) => ({ ...x, score: x.score + (x.m.path === currentPath ? 100 : 0) + (ext(x.m.path) === ext(currentPath) ? 20 : 0) }));
  scored.sort((a, b) => b.score - a.score || a.m.path.localeCompare(b.m.path) || a.m.line - b.m.line);
  return scored.map((x) => x.m);
}

/**
 * Where `name` is implemented: types that implement or extend it, or else (a method) its
 * declarations that have a body, not the ones in an interface (`Task Save();`).
 */
export function implementations<T extends Located>(matches: T[], name: string, currentPath: string): T[] {
  const types = matches.filter((m) => implementsName(m.text, name));
  if (types.length) return types;
  return definitions(matches, name, currentPath).filter((m) => !/;\s*$/.test(m.text) && !/\babstract\b/.test(m.text));
}

export interface FileSymbol {
  name: string;
  /** 0-based. */
  line: number;
  kind: string;
  /** Indentation, for showing nesting. */
  depth: number;
}

const SYMBOL_PATTERNS: [RegExp, string | null][] = [
  [new RegExp(`^\\s*${MODS}(function\\*?|class|interface|type|enum|struct|union|trait|record|module|namespace|object|protocol|mod|def|fn|func|fun|impl|macro_rules!)\\s+(?:[\\w$]+\\s+(?=[\\w$]+\\s*[<({:=\\[]|[\\w$]+\\s*$))?([\\w$]+)`), null],
  [/^\s*func\s*\([^)]*\)\s*([\w$]+)\s*[(\[]/, 'method'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[\w$]+\s*=>)/, 'function'],
  [new RegExp(`^\\s*${MODS}(?:${TYPE_WORD}\\s+)+([\\w$]+)\\s*(?:<[^>]*>)?\\s*\\([^;]*$`), 'method'],
  [new RegExp(`^\\s*${MODS}(?:get\\s+|set\\s+|\\*\\s*)?#?([\\w$]+)\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^=;{]*)?\\{\\s*$`), 'method'],
  [/^\s*(?:function|filter)\s+([\w-]+)/i, 'function'],
];

/** The functions, classes and other declarations in a file, for "go to symbol" (`@` in Go to file). */
export function fileSymbols(lines: readonly string[], markdown = false): FileSymbol[] {
  const out: FileSymbol[] = [];
  lines.forEach((line, i) => {
    if (line.length > 400) return;
    if (markdown) {
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) out.push({ name: h[2], line: i, kind: `h${h[1].length}`, depth: h[1].length - 1 });
      return;
    }
    if (isComment(line)) return;
    for (const [re, kind] of SYMBOL_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const name = kind === null ? m[2] : m[1];
      const k = kind ?? m[1].replace(/\*$/, '');
      // After a keyword any name goes (Rust's `fn new`); elsewhere control flow looks like a call.
      if (!name || (kind !== null && (KEYWORD_CALLS.has(name) || NOT_A_TYPE.has(name)))) break;
      // A typed "method" whose type words include a keyword is a statement (`return foo(`).
      if (kind === 'method' && re === SYMBOL_PATTERNS[3][0] && line.trim().split(/\s+/).some((w) => NOT_A_TYPE.has(w))) break;
      out.push({ name, line: i, kind: k, depth: Math.floor((line.length - line.trimStart().length) / 2) });
      break;
    }
  });
  return out;
}
