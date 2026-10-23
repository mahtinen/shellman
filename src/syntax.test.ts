import { describe, expect, it } from 'vitest';
import { Highlighter, langFor, tokenizeLine, type Lang, type State, type Token } from './syntax';

/** The coloured parts of a line as "kind:text". */
const parts = (tokens: Token[]) => tokens.filter((t) => t.kind).map((t) => `${t.kind}:${t.text}`);
const line = (path: string, text: string, state: State = null) => tokenizeLine(text, langFor(path) as Lang, state);

describe('langFor', () => {
  it('picks the language by extension or file name', () => {
    expect(langFor('src/main.ts')?.id).toBe('js');
    expect(langFor('src-tauri/src/lib.rs')?.id).toBe('rust');
    expect(langFor('Dockerfile')?.id).toBe('docker');
    expect(langFor('app/.env.local')?.id).toBe('ini');
    expect(langFor('README.md')?.id).toBe('markdown');
    expect(langFor('notes.txt')).toBeNull();
  });
});

describe('tokenizeLine', () => {
  it('colours TypeScript', () => {
    const r = line('a.ts', 'export const total = sum(items, 2) // why');
    expect(parts(r.tokens)).toEqual(['kw:export', 'kw:const', 'fn:sum', 'num:2', 'com:// why']);
    expect(r.tokens.map((t) => t.text).join('')).toBe('export const total = sum(items, 2) // why');
  });

  it('keeps comments and strings open across lines', () => {
    const a = line('a.ts', 'let x = 1; /* starts');
    expect(a.state).toEqual({ kind: 'com', end: '*/', escape: false });
    const b = line('a.ts', 'still */ return `a', a.state);
    expect(parts(b.tokens)).toEqual(['com:still */', 'kw:return', 'str:`a']);
    const c = line('a.ts', 'b` + y', b.state);
    expect(parts(c.tokens)).toEqual(['str:b`']);
    expect(c.state).toBeNull();
  });

  it('ends a one-line string at the end of the line', () => {
    expect(line('a.py', 'x = "open').state).toBeNull();
    expect(line('a.py', 'x = """open').state).toEqual({ kind: 'str', end: '"""', escape: true });
  });

  it('knows escapes, keys and types', () => {
    expect(parts(line('a.json', '  "na\\"me": "v", "n": 1.5e3').tokens)).toEqual(['key:"na\\"me"', 'str:"v"', 'key:"n"', 'num:1.5e3']);
    expect(parts(line('a.rs', 'let v: Vec<u8> = vec![b\'x\'];').tokens)).toEqual(['kw:let', 'type:Vec', 'type:u8', 'fn:vec', "str:'x'"]);
  });

  it('colours shell, PowerShell and YAML', () => {
    expect(parts(line('a.sh', 'echo "$HOME" a#b # note').tokens)).toEqual(['kw:echo', 'str:"$HOME"', 'com:# note']);
    expect(parts(line('a.ps1', 'if ($x -eq 1) { Get-Item $env:TEMP }').tokens)).toEqual(['kw:if', 'var:$x', 'kw:-eq', 'num:1', 'fn:Get-Item', 'var:$env:TEMP']);
    expect(parts(line('a.yml', '  image: node:20 # base').tokens)).toEqual(['key:image', 'num:20', 'com:# base']);
  });

  it('colours markup', () => {
    const r = line('a.html', '<a href="x">link</a> <!-- c');
    expect(parts(r.tokens)).toEqual(['tag:<a', 'attr:href', 'str:"x"', 'tag:>', 'tag:</a>', 'com:<!-- c']);
    expect(r.state?.end).toBe('-->');
    const tag = line('a.xml', '<Project Sdk="x"');
    expect(tag.state?.kind).toBe('tag');
    expect(parts(line('a.xml', '  Version="1">', tag.state).tokens)).toEqual(['attr:Version', 'str:"1"', 'tag:>']);
  });

  it('colours markdown', () => {
    expect(parts(line('a.md', '## Title').tokens)).toEqual(['head:## Title']);
    expect(parts(line('a.md', '- run `npm test` [docs](https://example.com)').tokens)).toEqual(['kw:- ', 'str:`npm test`', 'var:(https://example.com)']);
    const fence = line('a.md', '```ts');
    expect(fence.state).not.toBeNull();
    expect(line('a.md', '```', fence.state).state).toBeNull();
  });
});

describe('Highlighter', () => {
  it('tokenizes lines in order on demand', () => {
    const hl = new Highlighter(['/* a', 'b */ x', 'const y'], langFor('a.ts'));
    expect(parts(hl.tokens(2))).toEqual(['kw:const']);
    expect(parts(hl.tokens(1))).toEqual(['com:b */']);
    expect(new Highlighter(['plain'], null).tokens(0)).toEqual([{ text: 'plain', kind: null }]);
  });
});
