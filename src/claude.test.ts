import { describe, expect, it } from 'vitest';
import { claudeCommand, isTrackableClaude, isUuid } from './claude';

describe('claude conversations', () => {
  it('tracks interactive claude started with options only', () => {
    for (const c of [
      'claude',
      '  claude  ',
      'claude --dangerously-skip-permissions',
      'claude --model opus',
      'claude --model=opus --add-dir ../lib',
      'claude.exe',
      'CLAUDE.cmd --verbose',
      'claude --add-dir ../a ../b --model opus',
      'claude --permission-mode plan --verbose',
      'claude -n reviewer --effort high',
    ]) {
      expect(isTrackableClaude(c), c).toBe(true);
    }
  });

  it('leaves other commands alone', () => {
    for (const c of [
      '',
      'npm run dev',
      'claudette',
      'claude --continue',
      'claude -c',
      'claude --resume',
      'claude -r 1234',
      'claude --session-id abc',
      'claude -p "summarize"',
      'claude --print hi',
      'claude mcp list',
      'claude update',
      'claude "fix the login bug"',
      "claude 'explain'",
      'claude --version',
      // A flag without a value followed by a word: the word is a startup prompt.
      'claude --verbose fix',
      'claude --dangerously-skip-permissions refactor',
      'claude --model opus fix',
      'claude --model=opus fix',
    ]) {
      expect(isTrackableClaude(c), c).toBe(false);
    }
  });

  it('starts a new conversation the first time and resumes it afterwards', () => {
    const id = '0b3f6c1e-6a52-4c9b-9d0e-2f3a4b5c6d7e';
    expect(claudeCommand('claude --model opus', id, false, 'powershell')).toBe(`claude --model opus --session-id ${id}`);
    expect(claudeCommand('claude', id, true, 'powershell')).toBe(`claude --resume ${id}; if ($LASTEXITCODE -ne 0) { claude --session-id ${id} }`);
    expect(claudeCommand('claude', id, true, 'cmd')).toBe(`claude --resume ${id} || claude --session-id ${id}`);
    expect(claudeCommand('claude', id, true, 'wsl')).toBe(`claude --resume ${id} || claude --session-id ${id}`);
    expect(claudeCommand('claude', id, true, 'other')).toBe(`claude --resume ${id}`);
  });

  it('isUuid', () => {
    expect(isUuid('0b3f6c1e-6a52-4c9b-9d0e-2f3a4b5c6d7e')).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
