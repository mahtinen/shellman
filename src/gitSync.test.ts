import { describe, expect, it } from 'vitest';
import type { GitStatus } from './api';
import { commitMessage, outsideWork, syncChanges } from './gitSync';

const clean: GitStatus = { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, busy: false, changes: [], outsideChanges: false, outsideCommits: false, sharedRepo: false };

describe('git sync', () => {
  it('names the requests in the commit message', () => {
    expect(commitMessage('Update {request}', ['users/list.request.json'], 'dev')).toBe('Update list');
    expect(commitMessage('', ['a.request.json', 'b.request.json'], '')).toBe('Update a, b');
    expect(commitMessage('{folder}: {request} ({env})', ['users/a.request.json', 'orders/b.request.json', 'c.request.json', 'environments/dev.json'], 'staging')).toBe(
      'users, orders, environments: a, b, c and 1 more (staging)',
    );
  });

  it('leaves the personal files out', () => {
    const status: GitStatus = {
      ...clean,
      changes: [
        { path: 'users/list.request.json', state: 'modified' as const },
        { path: '.env.local', state: 'untracked' as const },
        { path: '.env.dev.local', state: 'untracked' as const },
        { path: '.env', state: 'modified' as const },
      ],
    };
    expect(syncChanges(status).map((c) => c.path)).toEqual(['users/list.request.json', '.env']);
    expect(syncChanges(null)).toEqual([]);
  });

  it('says what automatic sync would touch outside the folder', () => {
    expect(outsideWork(clean)).toBe('');
    expect(outsideWork(null)).toBe('');
    expect(outsideWork({ ...clean, sharedRepo: true })).toBe('');
    expect(outsideWork({ ...clean, outsideCommits: true })).toMatch(/commits outside the requests folder/);
    expect(outsideWork({ ...clean, outsideCommits: true, outsideChanges: true })).toMatch(/not pushed yet and uncommitted changes/);
  });
});
