import { describe, expect, it } from 'vitest';
import { fileUriPath, findPathLinks, resolvePath } from './fileLinks';

const links = (text: string) => findPathLinks(text).map((l) => [text.slice(l.start, l.end), l.path, l.line, l.column]);

describe('findPathLinks', () => {
  it('finds paths with their line and column', () => {
    expect(links('Edited src/routes/users.ts:42 and README.md')).toEqual([
      ['src/routes/users.ts:42', 'src/routes/users.ts', 42, null],
      ['README.md', 'README.md', null, null],
    ]);
    expect(links('  ./web/page.tsx:8:3 - error')).toEqual([['./web/page.tsx:8:3', './web/page.tsx', 8, 3]]);
    expect(links('C:\\Projects\\Shop\\Api\\Program.cs(12,5): error CS1002')).toEqual([
      ['C:\\Projects\\Shop\\Api\\Program.cs(12,5)', 'C:\\Projects\\Shop\\Api\\Program.cs', 12, 5],
    ]);
    expect(links('see `lib.rs#L10`')).toEqual([['lib.rs#L10', 'lib.rs', 10, null]]);
    expect(links('  File "app/main.py", line 7, in run')).toEqual([['app/main.py', 'app/main.py', 7, null]]);
    expect(links('/c/Projects/app/x.rs:3')).toEqual([['/c/Projects/app/x.rs:3', '/c/Projects/app/x.rs', 3, null]]);
  });

  it('leaves out URLs, versions and words with dots', () => {
    expect(links('https://example.com/docs/index.html')).toEqual([]);
    expect(links('version 1.2.3 and e.g. this')).toEqual([]);
    expect(links('node v20.11')).toEqual([]);
  });
});

describe('resolvePath', () => {
  it('makes a Windows path from what the terminal printed', () => {
    expect(resolvePath('src/app.ts', 'C:\\Projects\\app')).toBe('C:\\Projects\\app\\src\\app.ts');
    expect(resolvePath('./src/../lib/x.ts', 'C:\\Projects\\app\\')).toBe('C:\\Projects\\app\\lib\\x.ts');
    expect(resolvePath('C:/Projects/app/x.cs', 'D:\\other')).toBe('C:\\Projects\\app\\x.cs');
    expect(resolvePath('/c/Projects/x.rs', '')).toBe('C:\\Projects\\x.rs');
    expect(resolvePath('/mnt/d/data/a.json', '')).toBe('D:\\data\\a.json');
    expect(resolvePath('/home/me/a.ts', 'C:\\x')).toBeNull();
    expect(resolvePath('a.ts', '\\\\wsl.localhost\\Ubuntu\\home\\me\\app')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\a.ts');
  });
});

describe('fileUriPath', () => {
  it('reads file:// links', () => {
    expect(fileUriPath('file:///C:/Projects/My%20App/a.ts')).toBe('C:\\Projects\\My App\\a.ts');
    expect(fileUriPath('https://example.com')).toBeNull();
    expect(fileUriPath('file:///etc/passwd')).toBeNull();
  });
});
