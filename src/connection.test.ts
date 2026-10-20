import { describe, expect, it } from 'vitest';
import {
  connectionCommand,
  connectionError,
  connectionRequest,
  connectionTarget,
  emptyConnection,
  keyBlob,
  keyLabel,
  needsLegacyAlgorithms,
  newSshConnection,
  normalizeConnection,
  parseQuickConnect,
  sameKey,
  splitArgs,
} from './connection';
import type { Connection } from './types';

const ssh = (extra: Partial<Connection> = {}): Connection => ({ ...emptyConnection('ssh'), host: 'web1', ...extra });

describe('connectionError', () => {
  it('accepts plain hosts, IPs and IPv6', () => {
    expect(connectionError(ssh())).toBeNull();
    expect(connectionError(ssh({ host: '10.0.0.5', port: 2222, user: 'bob' }))).toBeNull();
    expect(connectionError(ssh({ host: 'fe80::1' }))).toBeNull();
    expect(connectionError(ssh({ user: 'DOMAIN\\bob', jumpHost: 'me@bastion:2200' }))).toBeNull();
  });

  it('rejects anything ssh could read as an option', () => {
    expect(connectionError(ssh({ host: '-oProxyCommand=calc' }))).toMatch(/host/);
    expect(connectionError(ssh({ user: '-oProxyCommand=calc' }))).toMatch(/user/);
    expect(connectionError(ssh({ jumpHost: '-oProxyCommand=calc' }))).toMatch(/jump/);
    expect(connectionError(ssh({ host: 'web1 -v' }))).toMatch(/host/);
    expect(connectionError(ssh({ host: '' }))).toMatch(/host/);
    expect(connectionError(ssh({ host: 'bob@web1' }))).toMatch(/User field/);
    expect(connectionError(ssh({ port: 0 }))).toMatch(/port/);
    expect(connectionError(ssh({ port: 70000 }))).toMatch(/port/);
  });
});

describe('display', () => {
  it('shows user, host and a non-default port', () => {
    expect(connectionTarget(ssh())).toBe('web1');
    expect(connectionTarget(ssh({ user: 'bob', port: 2222 }))).toBe('bob@web1:2222');
    expect(connectionTarget(ssh({ host: 'fe80::1', port: 22 }))).toBe('[fe80::1]:22');
    expect(connectionTarget({ ...emptyConnection('telnet'), host: 'router', user: 'ignored' })).toBe('router');
  });

  it('builds a command to paste elsewhere', () => {
    expect(connectionCommand(ssh({ user: 'bob', port: 2222, identityFile: 'C:\\Users\\me\\.ssh\\my key', extraArgs: '-A' }))).toBe(
      'ssh -p 2222 -i "C:\\Users\\me\\.ssh\\my key" -o IdentitiesOnly=yes -A bob@web1',
    );
    expect(connectionCommand({ ...emptyConnection('telnet'), host: 'router', port: 2323 })).toBe('telnet router 2323');
  });
});

describe('splitArgs', () => {
  it('splits on whitespace and groups quotes', () => {
    expect(splitArgs('  -A  -o "ProxyCommand=ssh -W %h:%p jump" \'x y\' ""')).toEqual(['-A', '-o', 'ProxyCommand=ssh -W %h:%p jump', 'x y', '']);
    expect(splitArgs('')).toEqual([]);
  });
});

describe('connectionRequest', () => {
  it('sends ssh-only fields only for SSH', () => {
    expect(connectionRequest(ssh({ extraArgs: '-A -o X=1' })).extraArgs).toEqual(['-A', '-o', 'X=1']);
    const t = connectionRequest({ ...emptyConnection('telnet'), host: 'r', user: 'u', extraArgs: '-x' });
    expect(t).toMatchObject({ kind: 'telnet', host: 'r', user: '', extraArgs: [] });
  });

  it('sends keepalives for a new SSH session unless they are removed', () => {
    expect(connectionRequest({ ...newSshConnection(), host: 'web1' }).extraArgs).toEqual(['-o', 'ServerAliveInterval=30']);
    expect(connectionRequest({ ...newSshConnection(), host: 'web1', extraArgs: '' }).extraArgs).toEqual([]);
    // Saved sessions keep what they had.
    expect(normalizeConnection({ kind: 'ssh', host: 'web1' })?.extraArgs).toBe('');
  });
});

describe('normalizeConnection', () => {
  it('drops unknown kinds and bad ports', () => {
    expect(normalizeConnection({ kind: 'rdp', host: 'x' })).toBeNull();
    expect(normalizeConnection(null)).toBeNull();
    expect(normalizeConnection({ kind: 'ssh', host: 'x', port: '22' })?.port).toBeNull();
  });
});

describe('parseQuickConnect', () => {
  it('reads user@host[:port]', () => {
    expect(parseQuickConnect('bob@web1')).toMatchObject({ kind: 'ssh', user: 'bob', host: 'web1', port: null });
    expect(parseQuickConnect('bob@10.0.0.5:2222')).toMatchObject({ host: '10.0.0.5', port: 2222 });
    expect(parseQuickConnect('bob@[fe80::1]:22')).toMatchObject({ host: 'fe80::1', port: 22 });
  });

  it('reads ssh commands with options', () => {
    expect(parseQuickConnect('ssh web1')).toMatchObject({ host: 'web1', user: '' });
    expect(parseQuickConnect('ssh -p 2222 -l bob -i key.pem -J jump web1')).toMatchObject({
      host: 'web1',
      port: 2222,
      user: 'bob',
      identityFile: 'key.pem',
      jumpHost: 'jump',
      extraArgs: '',
    });
    expect(parseQuickConnect('ssh -A -o ServerAliveInterval=30 -p2200 ssh://bob@web1')).toMatchObject({
      host: 'web1',
      port: 2200,
      user: 'bob',
      extraArgs: '-A -o ServerAliveInterval=30',
    });
    expect(parseQuickConnect('ssh -- web1')).toMatchObject({ host: 'web1' });
    // Options may also follow the host.
    expect(parseQuickConnect('ssh web1 -p 2222')).toMatchObject({ host: 'web1', port: 2222 });
    expect(parseQuickConnect('ssh bob@web1 -A')).toMatchObject({ host: 'web1', user: 'bob', extraArgs: '-A' });
    // -o User= names the user, so "login as:" isn't asked.
    expect(parseQuickConnect('ssh -o User=bob web1')).toMatchObject({ host: 'web1', user: 'bob', extraArgs: '' });
    expect(parseQuickConnect('ssh -l alice -o User=bob web1')).toMatchObject({ user: 'alice' });
  });

  it('reads telnet commands', () => {
    expect(parseQuickConnect('telnet router')).toMatchObject({ kind: 'telnet', host: 'router', port: null });
    expect(parseQuickConnect('telnet 10.0.0.1 2323')).toMatchObject({ kind: 'telnet', host: '10.0.0.1', port: 2323 });
  });

  it('ignores searches and unsupported commands', () => {
    for (const q of ['', 'web1', 'my api', 'ssh', 'ssh web1 uptime', 'ssh web1 -p 22 uptime', 'ssh -- web1 -p 22', 'ssh -p', 'ssh -p x web1', 'ssh -oProxyCommand=calc', 'ssh -- -oProxyCommand=calc', 'telnet', 'telnet a b c', 'telnet bob@r', 'bob@', '@web1', 'bob@web1:0']) {
      expect(parseQuickConnect(q), q).toBeNull();
    }
  });
});

describe('agent keys', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample+/= Work laptop key';

  it('identifies a key by type and data, not by its name', () => {
    expect(keyBlob(KEY)).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample+/=');
    expect(sameKey(KEY, KEY.replace('Work laptop key', 'renamed'))).toBe(true);
    expect(sameKey(KEY, 'ssh-ed25519 AAAAother x')).toBe(false);
    expect(sameKey('', '')).toBe(false);
    for (const bad of ['', 'ssh-ed25519', 'rm -rf /', 'ssh-rsa not*base64', 'ssh-ed25519 AAAA\nssh-rsa BBBB']) expect(keyBlob(bad), bad).toBeNull();
  });

  it('labels keys by their 1Password name', () => {
    expect(keyLabel(KEY)).toBe('Work laptop key (ed25519)');
    expect(keyLabel('ecdsa-sha2-nistp256 AAAA')).toBe('Unnamed key (ecdsa-nistp256)');
  });

  it('offers only the chosen key', () => {
    expect(connectionError(ssh({ identityKey: 'nonsense' }))).toMatch(/key/);
    expect(connectionError(ssh({ identityKey: KEY }))).toBeNull();
    expect(connectionCommand(ssh({ identityKey: KEY }), 'C:\\keys\\a.pub')).toBe('ssh -i C:\\keys\\a.pub -o IdentitiesOnly=yes web1');
    expect(connectionCommand(ssh({ identityFile: 'C:\\k' }))).toBe('ssh -i C:\\k -o IdentitiesOnly=yes web1');
    expect(connectionRequest(ssh({ identityKey: KEY })).identityKey).toBe(KEY);
    expect(connectionRequest({ ...emptyConnection('telnet'), host: 'r', identityKey: KEY }).identityKey).toBe('');
  });

  it('allows old algorithms only when asked', () => {
    expect(connectionCommand(ssh({ legacyAlgorithms: true }))).toBe(
      'ssh -o HostKeyAlgorithms=+ssh-rsa,ssh-dss -o PubkeyAcceptedAlgorithms=+ssh-rsa,ssh-dss' +
        ' -o KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1,diffie-hellman-group1-sha1' +
        ' -o Ciphers=+aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc web1',
    );
    expect(connectionRequest(ssh({ legacyAlgorithms: true })).legacyAlgorithms).toBe(true);
    expect(connectionRequest({ ...emptyConnection('telnet'), host: 'r', legacyAlgorithms: true }).legacyAlgorithms).toBe(false);
    expect(needsLegacyAlgorithms('Unable to negotiate with 203.0.113.10 port 2222: no matching host key type found. Their offer: ssh-rsa,ssh-dss')).toBe(true);
    expect(needsLegacyAlgorithms('Unable to negotiate with 10.0.0.1 port 22: no matching key exchange method found. Their offer: diffie-hellman-group1-sha1')).toBe(true);
    expect(needsLegacyAlgorithms('Permission denied (publickey).')).toBe(false);
  });

  it('logs in with a password instead of any key', () => {
    const c = ssh({ user: 'bob', identityKey: KEY, passwordAuth: true });
    expect(connectionCommand(c, 'C:\\keys\\a.pub')).toBe(
      'ssh -o PubkeyAuthentication=no -o PreferredAuthentications=keyboard-interactive,password bob@web1',
    );
    expect(connectionRequest(c).passwordAuth).toBe(true);
    expect(connectionRequest({ ...emptyConnection('telnet'), host: 'r', passwordAuth: true }).passwordAuth).toBe(false);
    expect(normalizeConnection({ kind: 'ssh', host: 'x', passwordAuth: 'yes' })?.passwordAuth).toBe(false);
    expect(normalizeConnection({ kind: 'ssh', host: 'x', passwordAuth: true })?.passwordAuth).toBe(true);
  });
});
