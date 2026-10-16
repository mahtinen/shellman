import { describe, expect, it } from 'vitest';
import { baseName, defaultConfig, formatEnv, guessShellKind, normalizeConfig, ownerSession, parseEnv, pathKey } from './config';

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
