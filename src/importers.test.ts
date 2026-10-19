import { describe, expect, it } from 'vitest';
import { emptyConnection } from './connection';
import { candidateName, importInto, markDuplicates, sessionCount, type ImportCandidate } from './importers';
import type { Connection, Group, SavedSession } from './types';

const ssh = (host: string, port: number | null = null, user = ''): Connection => ({ ...emptyConnection('ssh'), host, port, user });
const candidate = (name: string, connection: Connection | null, folder: string[] = [], skip = ''): ImportCandidate => ({ folder, name, connection, skip });
const saved = (connection: Connection): SavedSession => ({
  id: `s-${connection.host}`,
  name: connection.host,
  groupId: null,
  connection,
  cwd: '',
  command: '',
  shellId: '',
  color: '',
  env: {},
  collapsed: false,
});

describe('candidateName', () => {
  it('puts the folders in front, or leaves them out', () => {
    const c = candidate('web1', ssh('web1.example.com'), ['Prod', 'Web']);
    expect(candidateName(c, true)).toBe('Prod / Web / web1');
    expect(candidateName(c, false)).toBe('web1');
  });

  it('falls back to the host for a blank name', () => {
    expect(candidateName(candidate(' ', ssh('web2.example.com')), true)).toBe('web2.example.com');
  });
});

describe('markDuplicates', () => {
  it('marks servers that are already saved', () => {
    const list = [candidate('web1', ssh('WEB1.example.com', 22, 'deploy')), candidate('web1 root', ssh('web1.example.com', null, 'root'))];
    const marked = markDuplicates(list, [saved(ssh('web1.example.com', null, 'deploy'))]);
    expect(marked.map((c) => c.skip)).toEqual(['Already saved', '']);
  });

  it('keeps the first of two sessions for the same server', () => {
    const list = [candidate('web1', ssh('web1.example.com'), ['Prod']), candidate('web1 again', ssh('web1.example.com', 22))];
    expect(markDuplicates(list, []).map((c) => c.skip)).toEqual(['', 'Same host as Prod / web1']);
  });

  it('tells SSH and Telnet to the same host apart, and leaves skipped ones alone', () => {
    const telnet: Connection = { ...emptyConnection('telnet'), host: '10.0.0.1' };
    const list = [candidate('router', telnet), candidate('files', null, [], "SFTP isn't supported")];
    expect(markDuplicates(list, [saved(ssh('10.0.0.1'))]).map((c) => c.skip)).toEqual(['', "SFTP isn't supported"]);
  });
});

describe('importInto', () => {
  const target: Group = { id: 'g1', name: 'XShell', parentId: null, color: '', collapsed: false };

  it('makes the folders subgroups of the group', () => {
    const list = [
      candidate('router', ssh('10.0.0.1')),
      candidate('web1', ssh('web1.example.com'), ['Prod', 'Web']),
      candidate('web2', ssh('web2.example.com'), ['Prod', 'Web']),
      candidate('db1', ssh('db1.example.com'), ['Prod']),
    ];
    const { groups, sessions } = importInto(list, [target], 'g1', 'subgroups');
    expect(groups.map((g) => [g.name, g.parentId])).toEqual([
      ['Prod', 'g1'],
      ['Web', groups[0].id],
    ]);
    expect(sessions.map((s) => [s.name, s.groupId])).toEqual([
      ['router', 'g1'],
      ['web1', groups[1].id],
      ['web2', groups[1].id],
      ['db1', groups[0].id],
    ]);
  });

  it('reuses subgroups that are already there (any case)', () => {
    const prod: Group = { id: 'p', name: 'prod', parentId: 'g1', color: '', collapsed: true };
    const elsewhere: Group = { id: 'x', name: 'Web', parentId: null, color: '', collapsed: false };
    const { groups, sessions } = importInto([candidate('web1', ssh('web1.example.com'), ['Prod', 'Web'])], [target, prod, elsewhere], 'g1', 'subgroups');
    expect(groups.map((g) => [g.name, g.parentId])).toEqual([['Web', 'p']]);
    expect(sessions[0].groupId).toBe(groups[0].id);
  });

  it('can put the folders in the names instead', () => {
    const { groups, sessions } = importInto([candidate('web1', ssh('web1.example.com'), ['Prod', 'Web'])], [target], 'g1', 'names');
    expect(groups).toEqual([]);
    expect(sessions.map((s) => [s.name, s.groupId])).toEqual([['Prod / Web / web1', 'g1']]);
  });

  it('makes sessions, skipping what cannot be imported', () => {
    const list = [candidate('web1', ssh('web1.example.com', 2222, 'deploy'), ['Prod']), candidate('files', null, [], "SFTP isn't supported")];
    const out = importInto(list, [target], 'g1', 'names').sessions;
    expect(out).toEqual([
      {
        id: expect.any(String),
        name: 'Prod / web1',
        groupId: 'g1',
        connection: ssh('web1.example.com', 2222, 'deploy'),
        cwd: '',
        command: '',
        shellId: '',
        color: '',
        env: {},
        collapsed: false,
      },
    ]);
    // A copy: editing the session later doesn't change the candidate.
    expect(out[0].connection).not.toBe(list[0].connection);
  });

  it('counts sessions', () => {
    expect(sessionCount(1)).toBe('1 session');
    expect(sessionCount(3)).toBe('3 sessions');
  });
});
