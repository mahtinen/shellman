import { describe, expect, it } from 'vitest';
import { emptyConnection } from './connection';
import { parseIni, xshConnection, xshellCandidates } from './xshell';

const xsh = (host: string, opts: { port?: number; protocol?: string; user?: string } = {}) =>
  [
    '[SessionInfo]',
    'Version=7.0',
    '[CONNECTION]',
    `Host=${host}`,
    `Port=${opts.port ?? 22}`,
    `Protocol=${opts.protocol ?? 'SSH'}`,
    '[CONNECTION:AUTHENTICATION]',
    `UserName=${opts.user ?? ''}`,
    'Password=c2VjcmV0',
    'UserKey=id_rsa_2048',
  ].join('\r\n');

describe('parseIni', () => {
  it('reads sections and keys without caring about case or spaces', () => {
    const ini = parseIni('top=1\n[Connection]\n Host = web1.example.com \n; comment\nnot a pair\n[CONNECTION]\nPort=2222');
    expect(ini.get('')?.get('top')).toBe('1');
    expect(ini.get('connection')).toEqual(new Map([['host', 'web1.example.com'], ['port', '2222']]));
  });

  it('keeps "=" inside values', () => {
    expect(parseIni('[a]\nk=x=y').get('a')?.get('k')).toBe('x=y');
  });
});

describe('xshConnection', () => {
  it('reads SSH host, port and user, and nothing secret', () => {
    expect(xshConnection(xsh('web1.example.com', { port: 2222, user: 'deploy' }))).toEqual({
      ...emptyConnection('ssh'),
      host: 'web1.example.com',
      port: 2222,
      user: 'deploy',
    });
  });

  it('leaves the default port out', () => {
    expect(xshConnection(xsh('203.0.113.5'))).toMatchObject({ port: null });
    expect(xshConnection(xsh('203.0.113.5', { protocol: 'TELNET', port: 23 }))).toMatchObject({ kind: 'telnet', port: null });
    expect(xshConnection(xsh('203.0.113.5', { protocol: 'TELNET', port: 22 }))).toMatchObject({ kind: 'telnet', port: 22 });
  });

  it('ignores the user for Telnet', () => {
    expect(xshConnection(xsh('router', { protocol: 'Telnet', user: 'admin' }))).toMatchObject({ kind: 'telnet', user: '' });
  });

  it('treats a file without a protocol as SSH', () => {
    expect(xshConnection('[CONNECTION]\nHost=web1.example.com')).toMatchObject({ kind: 'ssh', host: 'web1.example.com', port: null });
  });

  it('says which protocols are not supported', () => {
    expect(xshConnection(xsh('x', { protocol: 'SFTP' }))).toEqual({ skip: "SFTP isn't supported" });
    expect(xshConnection(xsh('x', { protocol: 'serial' }))).toEqual({ skip: "SERIAL isn't supported" });
  });

  it('skips what would not be safe or usable', () => {
    expect(xshConnection(xsh(''))).toEqual({ skip: 'No host' });
    expect(xshConnection(xsh('-oProxyCommand=calc'))).toEqual({ skip: 'Unusable host or user' });
    expect(xshConnection(xsh('web1.example.com', { user: '-x' }))).toEqual({ skip: 'Unusable host or user' });
    expect(xshConnection(xsh('web 1'))).toEqual({ skip: 'Unusable host or user' });
  });

  it('ignores a port it cannot use', () => {
    expect(xshConnection(xsh('x', { port: 0 }))).toMatchObject({ port: null });
    expect(xshConnection(xsh('x', { port: 70000 }))).toMatchObject({ port: null });
  });
});

describe('xshellCandidates', () => {
  it('keeps each file’s folder and name', () => {
    const [ok, sftp] = xshellCandidates([
      { folder: ['Prod', 'Web'], name: 'web1', text: xsh('web1.example.com') },
      { folder: [], name: 'files', text: xsh('web1.example.com', { protocol: 'SFTP' }) },
    ]);
    expect(ok).toMatchObject({ folder: ['Prod', 'Web'], name: 'web1', skip: '', connection: { host: 'web1.example.com' } });
    expect(sftp).toEqual({ folder: [], name: 'files', connection: null, skip: "SFTP isn't supported" });
  });
});
