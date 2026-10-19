import { describe, expect, it } from 'vitest';
import {
  baseName,
  defaultConfig,
  deleteGroup,
  formatEnv,
  groupAndDescendants,
  groupOptions,
  groupPath,
  groupTree,
  guessShellKind,
  moveGroup,
  normalizeConfig,
  ownerSession,
  parseEnv,
  pathKey,
} from './config';
import type { Group } from './types';

describe('normalizeConfig', () => {
  it('returns defaults for garbage', () => {
    expect(normalizeConfig(null)).toEqual(defaultConfig());
    expect(normalizeConfig('x')).toEqual(defaultConfig());
    expect(normalizeConfig([])).toEqual(defaultConfig());
  });

  it('keeps valid sessions and fills in missing fields', () => {
    const c = normalizeConfig({ sessions: [{ id: 's1', name: 'My API', cwd: 'C:\\Projects\\my-api', command: 'claude' }] });
    expect(c.sessions).toEqual([
      { id: 's1', name: 'My API', groupId: null, connection: null, cwd: 'C:\\Projects\\my-api', command: 'claude', shellId: '', color: '', env: {}, collapsed: false },
    ]);
  });

  it('keeps SSH and Telnet sessions and drops invalid connections', () => {
    const c = normalizeConfig({
      sessions: [
        { id: 'a', connection: { kind: 'ssh', host: ' web1 ', port: 2222, user: 'bob' }, cwd: 'C:\\ignored' },
        { id: 'b', connection: { kind: 'telnet', host: 'router', port: 99999 } },
        { id: 'c', connection: { kind: 'rdp', host: 'x' }, cwd: 'C:\\x' },
      ],
    });
    expect(c.sessions[0]).toMatchObject({
      name: 'web1',
      cwd: '',
      connection: { kind: 'ssh', host: 'web1', port: 2222, user: 'bob', identityFile: '', jumpHost: '', extraArgs: '' },
    });
    expect(c.sessions[1].connection).toMatchObject({ kind: 'telnet', host: 'router', port: null });
    expect(c.sessions[2]).toMatchObject({ connection: null, cwd: 'C:\\x' });
  });

  it('defaults connection settings', () => {
    expect(normalizeConfig({}).settings).toMatchObject({ reconnectOnStart: false, sshPath: '' });
    expect(normalizeConfig({ settings: { reconnectOnStart: true, sshPath: ' C:\\ssh.exe ' } }).settings).toMatchObject({ reconnectOnStart: true, sshPath: 'C:\\ssh.exe' });
  });

  it('drops references to groups that do not exist', () => {
    const c = normalizeConfig({ groups: [{ id: 'g1', name: 'Work' }], sessions: [{ id: 'a', groupId: 'g1' }, { id: 'b', groupId: 'nope' }] });
    expect(c.sessions.map((s) => s.groupId)).toEqual(['g1', null]);
  });

  it('loads groups saved before subgroups existed as top-level groups', () => {
    const c = normalizeConfig({ groups: [{ id: 'g1', name: 'Work', collapsed: true }] });
    expect(c.groups).toEqual([{ id: 'g1', name: 'Work', parentId: null, collapsed: true }]);
  });

  it('keeps subgroups and moves groups with a missing parent to the top level', () => {
    const c = normalizeConfig({ groups: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'gone' }] });
    expect(c.groups.map((g) => g.parentId)).toEqual([null, 'a', null]);
  });

  it('breaks loops in group parents', () => {
    const c = normalizeConfig({
      groups: [
        { id: 'top', name: 'Top' },
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
        { id: 'c', name: 'C', parentId: 'a' },
        { id: 'self', name: 'Self', parentId: 'self' },
      ],
    });
    expect(c.groups.map((g) => [g.id, g.parentId])).toEqual([
      ['top', null],
      ['a', null],
      ['b', 'a'],
      ['c', 'a'],
      ['self', null],
    ]);
  });

  it('dedupes ids', () => {
    const c = normalizeConfig({ sessions: [{ id: 'a', name: '1' }, { id: 'a', name: '2' }], groups: [{ id: 'g' }, { id: 'g' }] });
    expect(new Set(c.sessions.map((s) => s.id)).size).toBe(2);
    expect(c.groups).toHaveLength(1);
  });

  it('clamps and validates settings', () => {
    const c = normalizeConfig({ settings: { fontSize: 1000, cursorStyle: 'weird', closeOnExit: 'never', copyOnSelect: true, scrollback: -5 } });
    expect(c.settings.fontSize).toBe(48);
    expect(c.settings.cursorStyle).toBe('block');
    expect(c.settings.closeOnExit).toBe('never');
    expect(c.settings.copyOnSelect).toBe(true);
    expect(c.settings.scrollback).toBe(0);
  });

  it('defaults right-click to paste and keeps valid choices', () => {
    expect(normalizeConfig({}).settings.rightClick).toBe('paste');
    expect(normalizeConfig({ settings: { rightClick: 'menu' } }).settings.rightClick).toBe('menu');
    expect(normalizeConfig({ settings: { rightClick: 'copyPaste' } }).settings.rightClick).toBe('copyPaste');
    expect(normalizeConfig({ settings: { rightClick: 'bogus' } }).settings.rightClick).toBe('paste');
  });

  it('keeps only valid env entries and custom shells', () => {
    const c = normalizeConfig({
      sessions: [{ id: 'a', env: { A: '1', B: 2, '': 'x' } }],
      settings: { customShells: [{ path: 'C:\\x\\nu.exe', kind: 'other' }, { name: 'no path' }] },
    });
    expect(c.sessions[0].env).toEqual({ A: '1' });
    expect(c.settings.customShells).toHaveLength(1);
    expect(c.settings.customShells[0].name).toBe('C:\\x\\nu.exe');
  });

  it('is idempotent', () => {
    const once = normalizeConfig({ groups: [{ id: 'g', name: 'G' }], sessions: [{ id: 's', name: 'S', groupId: 'g' }] });
    expect(normalizeConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe('group tree', () => {
  const g = (id: string, parentId: string | null = null): Group => ({ id, name: id.toUpperCase(), parentId, collapsed: false });
  // a > (b > c), d
  const groups = [g('a'), g('d'), g('b', 'a'), g('c', 'b')];

  it('lists groups in sidebar order with their depth and path', () => {
    expect(groupTree(groups).map((x) => [x.group.id, x.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 0],
    ]);
    expect(groupPath(groups, 'c')).toBe('A / B / C');
    expect(groupPath(groups, null)).toBe('');
    expect(groupOptions(groups).map((o) => o.label)).toEqual(['A', 'A / B', 'A / B / C', 'D']);
  });

  it('finds a group and everything inside it', () => {
    expect([...groupAndDescendants(groups, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...groupAndDescendants(groups, 'd')]).toEqual(['d']);
  });

  it('moves a group into another, or next to one', () => {
    expect(moveGroup(groups, 'd', 'c').find((x) => x.id === 'd')?.parentId).toBe('c');
    const before = moveGroup(groups, 'd', 'a', 'b', true);
    expect(groupTree(before).map((x) => x.group.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveGroup(groups, 'c', null).map((x) => [x.id, x.parentId])).toContainEqual(['c', null]);
  });

  it('never moves a group into itself or a group inside it', () => {
    expect(moveGroup(groups, 'a', 'a')).toBe(groups);
    expect(moveGroup(groups, 'a', 'c')).toBe(groups);
  });

  it('deleting a group moves its sessions and subgroups up one level', () => {
    const c = normalizeConfig({ groups, sessions: [{ id: 's1', groupId: 'b' }, { id: 's2', groupId: 'c' }] });
    deleteGroup(c, 'b');
    expect(c.groups.map((x) => [x.id, x.parentId])).toEqual([
      ['a', null],
      ['d', null],
      ['c', 'a'],
    ]);
    expect(c.sessions.map((s) => s.groupId)).toEqual(['a', 'c']);
    deleteGroup(c, 'a');
    expect(c.groups.find((x) => x.id === 'c')?.parentId).toBeNull();
    expect(c.sessions.map((s) => s.groupId)).toEqual([null, 'c']);
  });
});

describe('helpers', () => {
  it('baseName', () => {
    expect(baseName('C:\\Projects\\my-api')).toBe('my-api');
    expect(baseName('C:\\Projects\\my-api\\')).toBe('my-api');
    expect(baseName('/home/x/proj')).toBe('proj');
    expect(baseName('C:\\')).toBe('C:');
  });

  it('ownerSession never gives a local terminal to an SSH session', () => {
    const { sessions } = normalizeConfig({
      sessions: [
        { id: 'web', connection: { kind: 'ssh', host: 'web1' } },
        { id: 'home', cwd: 'C:\\Users\\me' },
      ],
    });
    expect(ownerSession(sessions, 'C:\\Users\\me', 'web')?.id).toBe('home');
    expect(ownerSession(sessions, 'C:\\Temp', 'web')).toBeUndefined();
  });

  it('ownerSession follows the current directory', () => {
    const { sessions } = normalizeConfig({
      sessions: [
        { id: 'api', cwd: 'C:\\Projects\\api' },
        { id: 'web', cwd: 'C:\\Projects\\web' },
        { id: 'web-ui', cwd: 'C:\\Projects\\web\\ui' },
        { id: 'web-2', cwd: 'c:/projects/web/' },
        { id: 'wsl', cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj' },
      ],
    });
    const owner = (cwd: string, from: string | null = null) => ownerSession(sessions, cwd, from)?.id;
    expect(owner('C:\\Projects\\api', 'web')).toBe('api'); // moved into another session's folder
    expect(owner('C:\\Projects\\api\\src\\lib')).toBe('api'); // a subfolder stays with its session
    expect(owner('C:\\Projects\\web\\ui\\components', 'api')).toBe('web-ui'); // the deepest session wins
    expect(owner('C:\\Projects\\apis')).toBeUndefined(); // not a subfolder, just a similar name
    expect(owner('C:\\', 'api')).toBe('api'); // outside every session: stays where it was opened
    expect(owner('C:\\')).toBeUndefined();
    expect(owner('C:\\Projects\\web', 'web-2')).toBe('web-2'); // same folder twice: opened-from wins
    expect(owner('C:\\Projects\\web')).toBe('web');
    expect(owner('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\src')).toBe('wsl');
  });

  it('pathKey', () => {
    expect(pathKey('C:/Projects/My-API/')).toBe(pathKey('c:\\projects\\my-api'));
    expect(pathKey('C:\\a')).not.toBe(pathKey('C:\\ab'));
    expect(pathKey('')).toBe('');
  });

  it('parseEnv / formatEnv', () => {
    const env = parseEnv('# comment\nA=1\n\n B = two=2 \nbad\n=x');
    expect(env).toEqual({ A: '1', B: ' two=2' });
    expect(parseEnv(formatEnv({ X: 'y', Z: 'a=b' }))).toEqual({ X: 'y', Z: 'a=b' });
  });

  it('guessShellKind', () => {
    expect(guessShellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(guessShellKind('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(guessShellKind('C:\\msys64\\usr\\bin\\bash.exe')).toBe('bash');
    expect(guessShellKind('C:\\Windows\\System32\\wsl.exe')).toBe('wsl');
    expect(guessShellKind('nu.exe')).toBe('other');
  });
});
