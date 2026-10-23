import { describe, expect, it } from 'vitest';
import { branchProblem, defaultWorktreeName, folderInWorktree, isInside, worktreeFolder } from './worktrees';

describe('worktreeFolder', () => {
  it('goes next to the repository, or in the folder chosen', () => {
    expect(worktreeFolder('C:\\Projects\\shop', '', 'fix-login')).toBe('C:\\Projects\\shop.worktrees\\fix-login');
    expect(worktreeFolder('C:/Projects/shop/', '', 'a b:c')).toBe('C:/Projects\\shop.worktrees\\a-b-c');
    expect(worktreeFolder('C:\\Projects\\shop', 'D:\\trees\\', 'claude/fix')).toBe('D:\\trees\\claude-fix');
    expect(worktreeFolder('C:\\Projects\\shop', '', '...')).toBe('C:\\Projects\\shop.worktrees\\worktree');
  });
});

describe('branchProblem', () => {
  it('accepts ordinary names and explains the others', () => {
    expect(branchProblem('claude/fix-login')).toBeNull();
    expect(branchProblem('fix login')).toMatch(/spaces/);
    expect(branchProblem('-x')).not.toBeNull();
    expect(branchProblem('a..b')).not.toBeNull();
    expect(branchProblem('a:b')).not.toBeNull();
    expect(branchProblem('x.lock')).not.toBeNull();
    expect(branchProblem('')).not.toBeNull();
  });
});

describe('defaultWorktreeName', () => {
  it('numbers the next free name after the session', () => {
    expect(defaultWorktreeName('Shop API', 'claude/', [])).toBe('shop-api-1');
    expect(defaultWorktreeName('Shop API', 'claude/', ['main', 'claude/shop-api-1', 'claude/Shop-API-2'])).toBe('shop-api-3');
    expect(defaultWorktreeName('ääkköset', '', [])).toBe('aakkoset-1');
    expect(defaultWorktreeName('***', '', [])).toBe('work-1');
  });
});

describe('folderInWorktree and isInside', () => {
  it('opens in the same folder of the repository', () => {
    expect(folderInWorktree('C:\\t\\fix', 'api/web/')).toBe('C:\\t\\fix\\api\\web');
    expect(folderInWorktree('C:\\t\\fix\\', '')).toBe('C:\\t\\fix');
    expect(isInside('C:\\T\\Fix\\api', 'c:/t/fix')).toBe(true);
    expect(isInside('C:\\t\\fix2', 'C:\\t\\fix')).toBe(false);
  });
});
