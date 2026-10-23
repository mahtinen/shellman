import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, slug } from './markdown';

describe('parseInline', () => {
  it('reads emphasis, code and line breaks', () => {
    expect(parseInline('a **b** *c* _d_ ~~e~~ `f*g`')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'strong', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'e' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'f*g' },
    ]);
    expect(parseInline('one  \ntwo\nthree')).toEqual([{ t: 'text', v: 'one' }, { t: 'br' }, { t: 'text', v: 'two three' }]);
    expect(parseInline('snake_case_name and a * b * c')).toEqual([{ t: 'text', v: 'snake_case_name and a * b * c' }]);
    expect(parseInline('\\*not em\\*')).toEqual([{ t: 'text', v: '*not em*' }]);
  });

  it('reads links, images and autolinks', () => {
    expect(parseInline('[docs](docs/setup.md "Setup") and ![logo](img/logo.png)')).toEqual([
      { t: 'link', href: 'docs/setup.md', title: 'Setup', c: [{ t: 'text', v: 'docs' }] },
      { t: 'text', v: ' and ' },
      { t: 'img', src: 'img/logo.png', alt: 'logo', title: '' },
    ]);
    expect(parseInline('see https://example.com/a_b. or <https://example.com>')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://example.com/a_b', title: '', c: [{ t: 'text', v: 'https://example.com/a_b' }] },
      { t: 'text', v: '. or ' },
      { t: 'link', href: 'https://example.com', title: '', c: [{ t: 'text', v: 'https://example.com' }] },
    ]);
  });

  it('keeps HTML as text, except simple inline tags', () => {
    expect(parseInline('<kbd>Ctrl</kbd>+C<br><script>x</script>')).toEqual([
      { t: 'kbd', c: [{ t: 'text', v: 'Ctrl' }] },
      { t: 'text', v: '+C' },
      { t: 'br' },
      { t: 'text', v: '<script>x</script>' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('reads headings, paragraphs, code and rules', () => {
    const md = '# Shop API\n\nSmall *example*.\nSecond line.\n\nSetup\n-----\n\n```ts\nconst a = 1;\n\nexport {};\n```\n\n---\n\n    indented code\n';
    expect(parseMarkdown(md)).toEqual([
      { t: 'h', level: 1, c: [{ t: 'text', v: 'Shop API' }], id: 'shop-api' },
      { t: 'p', c: [{ t: 'text', v: 'Small ' }, { t: 'em', c: [{ t: 'text', v: 'example' }] }, { t: 'text', v: '. Second line.' }] },
      { t: 'h', level: 2, c: [{ t: 'text', v: 'Setup' }], id: 'setup' },
      { t: 'code', lang: 'ts', v: 'const a = 1;\n\nexport {};' },
      { t: 'hr' },
      { t: 'code', lang: '', v: 'indented code' },
    ]);
  });

  it('reads nested lists, task lists and loose lists', () => {
    const blocks = parseMarkdown('- [x] done\n- [ ] todo\n  - nested\n\n1. one\n\n2. two\n');
    expect(blocks[0]).toMatchObject({ t: 'list', ordered: false, tight: true });
    const items = (blocks[0] as { items: { task: boolean | null; c: unknown[] }[] }).items;
    expect(items.map((i) => i.task)).toEqual([true, false]);
    expect(items[1].c[1]).toMatchObject({ t: 'list', items: [{ task: null, c: [{ t: 'p', c: [{ t: 'text', v: 'nested' }] }] }] });
    expect(blocks[1]).toMatchObject({ t: 'list', ordered: true, start: 1, tight: false });
    expect((blocks[1] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('reads tables with alignment', () => {
    const [table] = parseMarkdown('| Name | Size |\n|:-----|-----:|\n| `a\\|b` | 1 |\n| c |\n');
    expect(table).toEqual({
      t: 'table',
      align: ['left', 'right'],
      head: [[{ t: 'text', v: 'Name' }], [{ t: 'text', v: 'Size' }]],
      rows: [
        [[{ t: 'code', v: 'a|b' }], [{ t: 'text', v: '1' }]],
        [[{ t: 'text', v: 'c' }], []],
      ],
    });
  });

  it('reads quotes, HTML blocks and reference links', () => {
    const blocks = parseMarkdown('> Note: read [the docs][d].\n\n<p align="center">\n  <img src="logo.png">\n</p>\n\n[d]: https://example.com/docs\n');
    expect(blocks).toEqual([
      {
        t: 'quote',
        c: [{ t: 'p', c: [{ t: 'text', v: 'Note: read ' }, { t: 'link', href: 'https://example.com/docs', title: '', c: [{ t: 'text', v: 'the docs' }] }, { t: 'text', v: '.' }] }],
      },
      { t: 'html', v: '<p align="center">\n  <img src="logo.png">\n</p>' },
    ]);
  });

  it('gives headings unique anchors like GitHub', () => {
    const ids = parseMarkdown('# Run it!\n## Run it!\n## API: `GET /users`\n').map((b) => (b.t === 'h' ? b.id : ''));
    expect(ids).toEqual(['run-it', 'run-it-1', 'api-get-users']);
    expect(slug('Hello, World')).toBe('hello-world');
  });
});
