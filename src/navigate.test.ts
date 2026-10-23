import { describe, expect, it } from 'vitest';
import { declarationScore, definitions, fileSymbols, implementations, implementsName, matchRanges, queryRegExp, wordAt } from './navigate';

describe('queryRegExp and matchRanges', () => {
  it('matches plain text, whole words, case and patterns', () => {
    const q = (query: string, o: { caseSensitive?: boolean; word?: boolean; regex?: boolean } = {}) =>
      queryRegExp({ query, caseSensitive: !!o.caseSensitive, word: !!o.word, regex: !!o.regex });
    expect(matchRanges('a.b A.B', q('a.b'))).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(matchRanges('a.b A.B', q('a.b', { caseSensitive: true }))).toEqual([[0, 3]]);
    expect(matchRanges('user users user_id', q('user', { word: true }))).toEqual([[0, 4]]);
    expect(matchRanges('GetById(1) GetAll()', q('Get\\w+\\(', { regex: true }))).toEqual([
      [0, 8],
      [11, 18],
    ]);
    expect(q('(', { regex: true })).toBeNull();
  });
});

describe('wordAt', () => {
  it('finds the name under the caret or just before it', () => {
    expect(wordAt('const userService = x;', 8)).toEqual({ word: 'userService', start: 6, end: 17 });
    expect(wordAt('foo(bar)', 3)?.word).toBe('foo');
    expect(wordAt('a + b', 2)).toBeNull();
    expect(wordAt('x = 42', 5)).toBeNull();
  });
});

describe('declarationScore', () => {
  const declares: [string, string][] = [
    ['export class UserService {', 'UserService'],
    ['public interface IUserService', 'IUserService'],
    ['    public async Task<User?> GetById(int id)', 'GetById'],
    ['    Task<User> GetById(int id);', 'GetById'],
    ['    public string Name { get; set; }', 'Name'],
    ['pub fn new(config: Config) -> Self {', 'new'],
    ['pub(crate) struct Point<T> {', 'Point'],
    ['func (s *Server) Handle(w http.ResponseWriter) {', 'Handle'],
    ['def load_config(path):', 'load_config'],
    ['export const handler = async (event) => {', 'handler'],
    ['  private refresh(full = true): Promise<void> {', 'refresh'],
    ['  onClick = (e: MouseEvent) => {', 'onClick'],
    ['Function Get-Item {', 'Get'],
    ['CREATE OR REPLACE VIEW active_users AS', 'active_users'],
    ['#define MAX_SIZE 10', 'MAX_SIZE'],
    ['deploy() {', 'deploy'],
  ];
  it.each(declares)('sees a declaration in %s', (line, name) => {
    expect(declarationScore(line, name)).toBeGreaterThan(0);
  });

  const uses: [string, string][] = [
    ['    return GetById(id);', 'GetById'],
    ['    var user = await service.GetById(1);', 'GetById'],
    ['    const s = new UserService();', 'UserService'],
    ['// class UserService is old', 'UserService'],
    ['# def load_config(path):', 'load_config'],
    ['  handler(event);', 'handler'],
    ['class Admin extends UserService {', 'UserService'],
    ['    if (user == null) return;', 'user'],
    ['import { UserService } from "./user";', 'UserService'],
  ];
  it.each(uses)('sees a use, not a declaration, in %s', (line, name) => {
    expect(declarationScore(line, name)).toBe(0);
  });
});

describe('implementations', () => {
  it('finds types that implement or extend a name', () => {
    expect(implementsName('public class UserService : IUserService, IDisposable', 'IUserService')).toBe(true);
    expect(implementsName('export class Admin extends User implements Auditable {', 'Auditable')).toBe(true);
    expect(implementsName('impl Display for Point {', 'Display')).toBe(true);
    expect(implementsName('impl<T> Point<T> {', 'Point')).toBe(true);
    expect(implementsName('class Repo(BaseRepo):', 'BaseRepo')).toBe(true);
    expect(implementsName('var s = new UserService();', 'UserService')).toBe(false);
  });

  it('falls back to declarations with a body', () => {
    const m = [
      { path: 'IRepo.cs', line: 3, text: '    Task Save(User u);' },
      { path: 'Repo.cs', line: 9, text: '    public async Task Save(User u)' },
      { path: 'Use.cs', line: 1, text: '    await repo.Save(u);' },
    ];
    expect(implementations(m, 'Save', 'Use.cs').map((x) => x.path)).toEqual(['Repo.cs']);
  });
});

describe('definitions', () => {
  it('ranks the current file and same kind of file first', () => {
    const m = [
      { path: 'b/other.py', line: 1, text: 'def total(x):' },
      { path: 'a/util.ts', line: 4, text: 'export function total(items: Item[]) {' },
      { path: 'a/main.ts', line: 20, text: 'const total = sum(items);' },
      { path: 'a/main.ts', line: 30, text: 'console.log(total);' },
    ];
    expect(definitions(m, 'total', 'a/main.ts').map((x) => `${x.path}:${x.line}`)).toEqual(['a/main.ts:20', 'a/util.ts:4', 'b/other.py:1']);
  });
});

describe('fileSymbols', () => {
  it('lists classes, functions and methods', () => {
    const lines = [
      'export class UserService {',
      '  constructor(private repo: Repo) {}',
      '  async getById(id: number): Promise<User> {',
      '    if (id < 0) {',
      '      return null;',
      '    }',
      '  }',
      '}',
      'export const handler = async (e) => {',
      'function helper() {',
    ];
    expect(fileSymbols(lines).map((s) => `${s.kind}:${s.name}@${s.line}`)).toEqual(['class:UserService@0', 'method:getById@2', 'function:handler@8', 'function:helper@9']);
  });

  it('knows C# and Rust shapes', () => {
    const cs = ['public class Repo : IRepo', '{', '    public async Task<User> GetById(int id)', '    {', '        return await db.Find(id);', '    }', '}'];
    expect(fileSymbols(cs).map((s) => s.name)).toEqual(['Repo', 'GetById']);
    const rs = ['pub struct Point {', '}', 'impl Point {', '    pub fn new() -> Self {', '    }', '}'];
    expect(fileSymbols(rs).map((s) => `${s.kind}:${s.name}`)).toEqual(['struct:Point', 'impl:Point', 'fn:new']);
  });

  it('lists markdown headings', () => {
    expect(fileSymbols(['# Title', 'text', '## Run ##'], true)).toEqual([
      { name: 'Title', line: 0, kind: 'h1', depth: 0 },
      { name: 'Run', line: 2, kind: 'h2', depth: 1 },
    ]);
  });
});
