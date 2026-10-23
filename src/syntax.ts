/**
 * Syntax colours for the Files pane: a small line-by-line tokenizer that knows comments, strings,
 * numbers, keywords, types and function names for common languages (chosen by file name). It
 * carries what is still open (a block comment, a multi-line string) from one line to the next, so
 * any line can be coloured without the ones after it. Pure functions.
 */

export type TokenKind = 'kw' | 'str' | 'com' | 'num' | 'type' | 'fn' | 'key' | 'meta' | 'var' | 'tag' | 'attr' | 'head' | 'add' | 'del';

export interface Token {
  text: string;
  kind: TokenKind | null;
}

/** What is still open at the end of a line. */
export type State = null | { kind: 'com' | 'str' | 'tag'; end: string; escape: boolean };

interface StringSpec {
  open: string;
  close: string;
  multiline?: boolean;
  /** Backslash escapes the next character. */
  escape?: boolean;
}

export interface Lang {
  id: string;
  mode?: 'code' | 'markup' | 'markdown' | 'patch';
  line?: string[];
  /** A line comment only after a space or at the start (shell: `a#b` isn't one). */
  lineAtWord?: boolean;
  block?: [string, string][];
  strings?: StringSpec[];
  keywords?: Set<string>;
  types?: Set<string>;
  /** Capitalised names are types (most C-like languages). */
  caps?: boolean;
  /** Keywords in any case (SQL, PowerShell). */
  ci?: boolean;
  /** `"name":` and `name:` are keys (JSON, YAML). */
  keys?: boolean;
  /** `name!(` is a macro call (Rust). */
  macros?: boolean;
  /** Extra patterns tried at every position, before names. */
  rules?: [RegExp, TokenKind][];
  /** Patterns tried at the start of a line (after its indent). */
  lineRules?: [RegExp, TokenKind][];
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const DQ: StringSpec = { open: '"', close: '"', escape: true };
const SQ: StringSpec = { open: "'", close: "'", escape: true };
const BT: StringSpec = { open: '`', close: '`', escape: true, multiline: true };
const C_COMMENTS = { line: ['//'], block: [['/*', '*/']] as [string, string][] };
const NUM_HEX: [RegExp, TokenKind] = [/0[xX][0-9a-fA-F_]+\b/y, 'num'];

const JS_KW = words(`break case catch class const continue debugger default delete do else enum export extends false finally for from function
  if implements import in instanceof interface let new null of package private protected public readonly return static super switch this throw
  true try type typeof undefined var void while with yield async await as declare namespace abstract keyof infer is satisfies get set override`);
const JS_TYPES = words('string number boolean any unknown never object symbol bigint');

const LANGS: Record<string, Lang> = {
  js: { id: 'js', ...C_COMMENTS, strings: [DQ, SQ, BT], keywords: JS_KW, types: JS_TYPES, caps: true, rules: [[/@[\w.]+/y, 'meta'], NUM_HEX] },
  rust: {
    id: 'rust',
    ...C_COMMENTS,
    strings: [{ open: 'r#"', close: '"#', multiline: true }, { open: '"', close: '"', escape: true, multiline: true }],
    keywords: words(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref
      return self Self static struct super trait true type unsafe use where while`),
    types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str'),
    caps: true,
    macros: true,
    rules: [[/#!?\[[^\]]*\]?/y, 'meta'], [/'(?:\\.|[^\\'])'/y, 'str'], [/'\w+/y, 'meta'], NUM_HEX],
  },
  csharp: {
    id: 'csharp',
    ...C_COMMENTS,
    strings: [{ open: '@"', close: '"', multiline: true }, { open: '"""', close: '"""', multiline: true }, DQ, { open: "'", close: "'", escape: true }],
    keywords: words(`abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double
      else enum event explicit extern false finally fixed float for foreach get goto if implicit in init int interface internal is lock long
      namespace new null object operator out override params partial private protected public readonly record ref required return sbyte sealed
      set short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile
      when where while with yield nameof value`),
    caps: true,
    rules: [[/^\s*#\s*\w+/y, 'meta'], [/\[[A-Z]\w*(?=[\](])/y, 'meta'], NUM_HEX],
  },
  java: {
    id: 'java',
    ...C_COMMENTS,
    strings: [{ open: '"""', close: '"""', multiline: true }, DQ, SQ],
    keywords: words(`abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally
      float for if implements import instanceof int interface long native new null package private protected public return short static super
      switch synchronized this throw throws transient true false try void volatile while var val fun when object companion data sealed open
      override lateinit suspend in is internal record yield`),
    caps: true,
    rules: [[/@[\w.]+/y, 'meta'], NUM_HEX],
  },
  go: {
    id: 'go',
    ...C_COMMENTS,
    strings: [DQ, { open: '`', close: '`', multiline: true }, SQ],
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range
      return select struct switch type var true false nil iota`),
    types: words(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64
      uintptr any`),
    caps: false,
    rules: [NUM_HEX],
  },
  c: {
    id: 'c',
    ...C_COMMENTS,
    strings: [DQ, SQ],
    keywords: words(`auto break case char const continue default do double else enum extern float for goto if inline int long register
      restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool class namespace template typename
      public private protected virtual override new delete this true false nullptr using try catch throw constexpr noexcept operator friend
      explicit mutable static_cast dynamic_cast const_cast reinterpret_cast`),
    caps: true,
    rules: [[/^\s*#\s*\w+/y, 'meta'], NUM_HEX],
  },
  swift: { id: 'swift', ...C_COMMENTS, strings: [{ open: '"""', close: '"""', multiline: true }, DQ], keywords: words(`associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self Self throw throws true try async await`), caps: true, rules: [[/@\w+/y, 'meta']] },
  php: { id: 'php', line: ['//', '#'], block: [['/*', '*/']], strings: [DQ, SQ], keywords: words(`abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while xor yield true false null`), ci: true, caps: true, rules: [[/\$\w+/y, 'var']] },
  python: {
    id: 'python',
    line: ['#'],
    strings: [
      { open: '"""', close: '"""', multiline: true, escape: true },
      { open: "'''", close: "'''", multiline: true, escape: true },
      DQ,
      SQ,
    ],
    keywords: words(`False None True and as assert async await break class continue def del elif else except finally for from global if import in
      is lambda nonlocal not or pass raise return try while with yield match case self cls`),
    types: words('int float str bool list dict set tuple bytes object'),
    caps: true,
    rules: [[/@[\w.]+/y, 'meta']],
  },
  ruby: { id: 'ruby', line: ['#'], strings: [DQ, SQ], keywords: words(`alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor attr_reader private protected public`), caps: true, rules: [[/:\w+/y, 'str'], [/@{1,2}\w+/y, 'var']] },
  shell: {
    id: 'shell',
    line: ['#'],
    lineAtWord: true,
    strings: [DQ, { open: "'", close: "'" }],
    keywords: words(`if then else elif fi case esac for while until do done in function return exit local export readonly declare unset shift
      break continue source alias echo cd set trap eval exec true false`),
    rules: [[/\$\{[^}]*\}|\$[\w@#?*!$-]+/y, 'var']],
  },
  powershell: {
    id: 'powershell',
    line: ['#'],
    block: [['<#', '#>']],
    strings: [{ open: '@"', close: '"@', multiline: true }, { open: "@'", close: "'@", multiline: true }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    keywords: words(`begin break catch class continue data default do dynamicparam else elseif end enum exit filter finally for foreach function
      if in param process return switch throw trap try until using var while workflow`),
    ci: true,
    rules: [
      [/\$(?:\{[^}]*\}|[\w:?]+)/y, 'var'],
      [/-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|and|or|not|xor|replace|split|join|is|isnot|as|f)\b/iy, 'kw'],
      [/[A-Za-z]+-[A-Za-z]\w*/y, 'fn'],
      [/\[[\w.]+\]/y, 'type'],
    ],
  },
  batch: {
    id: 'batch',
    line: ['::'],
    strings: [{ open: '"', close: '"' }],
    keywords: words(`echo set if else goto call exit for in do not exist defined errorlevel setlocal endlocal pushd popd shift start`),
    ci: true,
    rules: [[/%%\w|%~?\w*%?|![\w]+!/y, 'var']],
    lineRules: [[/@?rem\b.*/iy, 'com'], [/:\w+/y, 'fn']],
  },
  sql: {
    id: 'sql',
    line: ['--'],
    block: [['/*', '*/']],
    strings: [{ open: "'", close: "'" }, { open: '"', close: '"' }],
    keywords: words(`select from where and or not insert into values update set delete create table alter drop index view join inner left right
      outer full cross on as group by order having limit offset union all distinct case when then else end is null like ilike in exists between
      primary key foreign references default constraint unique check begin commit rollback transaction with returning if declare procedure
      function trigger asc desc top replace cascade grant revoke schema database true false`),
    types: words('int integer bigint smallint varchar char text boolean bool date timestamp timestamptz numeric decimal float real uuid json jsonb serial'),
    ci: true,
  },
  css: {
    id: 'css',
    ...C_COMMENTS,
    strings: [DQ, SQ],
    rules: [[/@[\w-]+/y, 'meta'], [/#[0-9a-fA-F]{3,8}\b/y, 'num'], [/--[\w-]+/y, 'var'], [/[\w-]+(?=\s*:[^:])/y, 'key'], [/!important/y, 'kw']],
  },
  json: { id: 'json', ...C_COMMENTS, strings: [DQ], keywords: words('true false null'), keys: true },
  yaml: {
    id: 'yaml',
    line: ['#'],
    lineAtWord: true,
    strings: [DQ, { open: "'", close: "'" }],
    keywords: words('true false null yes no on off True False Null'),
    lineRules: [[/(?:-\s+)?[^\s#'"{[][^#:]*?(?=:(?:\s|$))/y, 'key'], [/---|\.\.\./y, 'meta']],
    rules: [[/[&*][\w-]+/y, 'var'], [/![\w!]+/y, 'type']],
  },
  ini: {
    id: 'ini',
    line: ['#', ';'],
    lineAtWord: true,
    strings: [DQ, { open: "'", close: "'" }],
    keywords: words('true false'),
    lineRules: [[/\[[^\]]*\]/y, 'type'], [/[\w.\-"]+(?=\s*=)/y, 'key'], [/export\b/y, 'kw']],
  },
  docker: {
    id: 'docker',
    line: ['#'],
    lineAtWord: true,
    strings: [DQ, SQ],
    ci: true,
    lineRules: [[/(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|MAINTAINER)\b/iy, 'kw']],
    rules: [[/\$\{[^}]*\}|\$\w+/y, 'var'], [/\bAS\b/y, 'kw']],
  },
  make: {
    id: 'make',
    line: ['#'],
    strings: [DQ, SQ],
    lineRules: [[/[\w.%/-]+(?=\s*:(?!=))/y, 'fn'], [/(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|define|endef|export)\b/y, 'kw']],
    rules: [[/\$[({][^)}]*[)}]|\$[@<^*?%]/y, 'var']],
  },
  lua: { id: 'lua', line: ['--'], block: [['--[[', ']]']], strings: [DQ, SQ, { open: '[[', close: ']]', multiline: true }], keywords: words('and break do else elseif end false for function goto if in local nil not or repeat return then true until while') },
  markup: { id: 'markup', mode: 'markup' },
  markdown: { id: 'markdown', mode: 'markdown' },
  patch: { id: 'patch', mode: 'patch' },
  hash: { id: 'hash', line: ['#'], lineAtWord: true },
};

const BY_EXT: Record<string, string> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js',
  rs: 'rust', cs: 'csharp', csx: 'csharp', java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java', gradle: 'java', dart: 'java',
  go: 'go', c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', m: 'c', mm: 'c', swift: 'swift', php: 'php',
  py: 'python', pyi: 'python', pyw: 'python', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', lua: 'lua',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'batch', cmd: 'batch',
  sql: 'sql', css: 'css', scss: 'css', less: 'css', sass: 'css',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', ipynb: 'json', har: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini', env: 'ini',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', xaml: 'markup', csproj: 'markup', fsproj: 'markup',
  vbproj: 'markup', props: 'markup', targets: 'markup', resx: 'markup', config: 'markup', plist: 'markup', xsd: 'markup', xsl: 'markup', wxs: 'markup',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', diff: 'patch', patch: 'patch',
  gitignore: 'hash', gitattributes: 'hash', dockerignore: 'hash', npmrc: 'ini', tf: 'hash', hcl: 'hash', r: 'hash', pl: 'hash', cmake: 'hash',
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'docker', containerfile: 'docker', makefile: 'make', gnumakefile: 'make', 'cmakelists.txt': 'hash', gemfile: 'ruby', rakefile: 'ruby',
  '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell', '.env': 'ini', 'cargo.lock': 'ini', 'go.mod': 'hash',
};

/** The language of a file, by its name; null for plain text. */
export function langFor(path: string): Lang | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const byName = BY_NAME[name] ?? (name.startsWith('dockerfile') ? 'docker' : name.startsWith('.env') ? 'ini' : undefined);
  if (byName) return LANGS[byName];
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  return LANGS[BY_EXT[ext] ?? ''] ?? null;
}

/** Beyond this, the rest of a line (minified code) stays plain. */
const MAX_LINE = 3000;
const NAME = /[A-Za-z_$][\w$]*/y;
const NUMBER = /\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z%]*/y;

class Line {
  tokens: Token[] = [];
  constructor(private readonly text: string) {}
  push(text: string, kind: TokenKind | null): void {
    if (!text) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.tokens.push({ text, kind });
  }
  /** `kind` for text[from, to). */
  span(from: number, to: number, kind: TokenKind | null): void {
    this.push(this.text.slice(from, to), kind);
  }
}

const at = (re: RegExp, text: string, i: number): string | null => {
  re.lastIndex = i;
  const m = re.exec(text);
  return m && m.index === i && m[0] ? m[0] : null;
};

/** Where `close` ends a string or comment that is open at `from`; -1 when it doesn't on this line. */
function closeAt(text: string, from: number, close: string, escape: boolean): number {
  for (let i = from; i < text.length; i++) {
    if (escape && text[i] === '\\') {
      i++;
      continue;
    }
    if (text.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

/** Colours one line; `state` is what the previous line left open. */
export function tokenizeLine(text: string, lang: Lang, state: State): { tokens: Token[]; state: State } {
  const mode = lang.mode ?? 'code';
  if (mode === 'markdown') return markdownLine(text, state);
  if (mode === 'patch') {
    const kind = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : text.startsWith('@@') ? 'meta' : /^(diff|index) /.test(text) ? 'kw' : null;
    return { tokens: text ? [{ text, kind }] : [], state: null };
  }
  const line = new Line(text);
  const limit = Math.min(text.length, MAX_LINE);
  let i = 0;
  // What the previous line left open.
  if (state && state.kind !== 'tag') {
    const end = closeAt(text, 0, state.end, state.escape);
    if (end < 0) return { tokens: text ? [{ text, kind: state.kind }] : [], state };
    line.span(0, end, state.kind);
    i = end;
    state = null;
  }
  if (mode === 'markup') return markupLine(text, line, i, state);
  const firstWord = text.search(/\S/);
  if (lang.lineRules && firstWord >= 0 && i <= firstWord) {
    line.span(i, firstWord, null);
    i = firstWord;
    for (const [re, kind] of lang.lineRules) {
      const m = at(re, text, i);
      if (m) {
        line.push(m, kind);
        i += m.length;
        break;
      }
    }
  }
  let plain = i;
  const flush = (to: number) => {
    line.span(plain, to, null);
  };
  while (i < limit) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : ' ';
    // Comments.
    const lc = lang.line?.find((s) => text.startsWith(s, i) && (!lang.lineAtWord || /\s/.test(prev)));
    if (lc) {
      flush(i);
      line.span(i, text.length, 'com');
      return { tokens: line.tokens, state: null };
    }
    const bc = lang.block?.find(([open]) => text.startsWith(open, i));
    if (bc) {
      flush(i);
      const end = closeAt(text, i + bc[0].length, bc[1], false);
      if (end < 0) {
        line.span(i, text.length, 'com');
        return { tokens: line.tokens, state: { kind: 'com', end: bc[1], escape: false } };
      }
      line.span(i, end, 'com');
      i = plain = end;
      continue;
    }
    // Patterns of the language, then strings.
    let rule: [string, TokenKind] | null = null;
    for (const [re, kind] of lang.rules ?? []) {
      const m = at(re, text, i);
      if (m) {
        rule = [m, kind];
        break;
      }
    }
    if (rule) {
      flush(i);
      line.push(rule[0], rule[1]);
      i = plain = i + rule[0].length;
      continue;
    }
    const str = lang.strings?.find((s) => text.startsWith(s.open, i));
    if (str) {
      flush(i);
      const end = closeAt(text, i + str.open.length, str.close, !!str.escape);
      if (end < 0) {
        line.span(i, text.length, 'str');
        return { tokens: line.tokens, state: str.multiline ? { kind: 'str', end: str.close, escape: !!str.escape } : null };
      }
      const key = lang.keys && /^\s*:/.test(text.slice(end));
      line.span(i, end, key ? 'key' : 'str');
      i = plain = end;
      continue;
    }
    // Numbers and names.
    if (/\d/.test(ch) && !/[\w$]/.test(prev)) {
      const m = at(NUMBER, text, i)!;
      flush(i);
      line.push(m, 'num');
      i = plain = i + m.length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch) && !/[\w$]/.test(prev)) {
      const name = at(NAME, text, i)!;
      const kind = nameKind(name, lang, text, i + name.length);
      if (kind) {
        flush(i);
        line.push(name, kind);
        plain = i + name.length;
      }
      i += name.length;
      continue;
    }
    i++;
  }
  flush(text.length);
  return { tokens: line.tokens, state: null };
}

function nameKind(name: string, lang: Lang, text: string, end: number): TokenKind | null {
  const key = lang.ci ? name.toLowerCase() : name;
  if (lang.keywords?.has(key)) return 'kw';
  if (lang.types?.has(key)) return 'type';
  if (lang.macros && text[end] === '!' && text[end + 1] !== '=') return 'fn';
  if (/^\s*\(/.test(text.slice(end, end + 20))) return 'fn';
  if (lang.caps && /^[A-Z]/.test(name) && /[a-z]/.test(name)) return 'type';
  return null;
}

/** HTML and XML: tags, attributes, their values and comments. */
function markupLine(text: string, line: Line, i: number, state: State): { tokens: Token[]; state: State } {
  let inTag = state?.kind === 'tag';
  let plain = i;
  const flush = (to: number) => line.span(plain, to, null);
  while (i < text.length) {
    if (!inTag && text.startsWith('<!--', i)) {
      flush(i);
      const end = closeAt(text, i + 4, '-->', false);
      if (end < 0) {
        line.span(i, text.length, 'com');
        return { tokens: line.tokens, state: { kind: 'com', end: '-->', escape: false } };
      }
      line.span(i, end, 'com');
      i = plain = end;
      continue;
    }
    if (!inTag) {
      const tag = at(/<\/?[A-Za-z_!?][\w:.-]*/y, text, i);
      if (tag) {
        flush(i);
        line.push(tag, 'tag');
        i = plain = i + tag.length;
        inTag = true;
        continue;
      }
      const entity = at(/&[#\w]+;/y, text, i);
      if (entity) {
        flush(i);
        line.push(entity, 'meta');
        i = plain = i + entity.length;
        continue;
      }
      i++;
      continue;
    }
    const close = at(/\/?\??>/y, text, i);
    if (close) {
      flush(i);
      line.push(close, 'tag');
      i = plain = i + close.length;
      inTag = false;
      continue;
    }
    const q = text[i];
    if (q === '"' || q === "'") {
      flush(i);
      const end = closeAt(text, i + 1, q, false);
      line.span(i, end < 0 ? text.length : end, 'str');
      i = plain = end < 0 ? text.length : end;
      continue;
    }
    const attr = at(/[\w:@.#-]+/y, text, i);
    if (attr) {
      flush(i);
      line.push(attr, 'attr');
      i = plain = i + attr.length;
      continue;
    }
    i++;
  }
  flush(text.length);
  return { tokens: line.tokens, state: inTag ? { kind: 'tag', end: '>', escape: false } : null };
}

/** Markdown: headings, code (fenced and inline), quotes, list marks and link targets. */
function markdownLine(text: string, state: State): { tokens: Token[]; state: State } {
  const fence = /^\s*(```|~~~)/.exec(text);
  if (state) return { tokens: text ? [{ text, kind: 'str' }] : [], state: fence ? null : state };
  if (fence) return { tokens: [{ text, kind: 'str' }], state: { kind: 'str', end: fence[1], escape: false } };
  if (/^\s{0,3}#{1,6}(\s|$)/.test(text)) return { tokens: [{ text, kind: 'head' }], state: null };
  if (/^\s*>/.test(text)) return { tokens: [{ text, kind: 'com' }], state: null };
  const line = new Line(text);
  let i = 0;
  const mark = /^\s*(?:[-*+]|\d+[.)])\s/.exec(text);
  if (mark) {
    line.push(mark[0], 'kw');
    i = mark[0].length;
  }
  const re = /`[^`]*`|\]\([^)]*\)|\*\*[^*]+\*\*/g;
  re.lastIndex = i;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    line.span(i, m.index, null);
    if (m[0].startsWith(']')) {
      line.push(']', null);
      line.push(m[0].slice(1), 'var');
    } else line.push(m[0], m[0].startsWith('`') ? 'str' : 'kw');
    i = m.index + m[0].length;
  }
  line.span(i, text.length, null);
  return { tokens: line.tokens, state: null };
}

/** Colours the lines of one text as they are needed (only the ones before are tokenized first). */
export class Highlighter {
  /** The state at the start of each line tokenized so far. */
  private readonly states: State[] = [null];
  private readonly cache: (Token[] | undefined)[] = [];

  constructor(
    private readonly lines: string[],
    private readonly lang: Lang | null,
  ) {}

  tokens(index: number): Token[] {
    const text = this.lines[index] ?? '';
    if (!this.lang) return text ? [{ text, kind: null }] : [];
    const cached = this.cache[index];
    if (cached) return cached;
    for (let k = this.states.length - 1; k <= index; k++) {
      const r = tokenizeLine(this.lines[k] ?? '', this.lang, this.states[k]);
      this.cache[k] = r.tokens;
      if (this.states.length === k + 1) this.states.push(r.state);
    }
    return this.cache[index]!;
  }
}
