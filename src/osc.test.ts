import { describe, expect, it } from 'vitest';
import { isWindowsPath, parseOsc7, parseOsc777, parseOsc9 } from './osc';

describe('parseOsc9', () => {
  it('parses quoted and unquoted cwd', () => {
    expect(parseOsc9('9;"C:\\Projects\\my api"')).toEqual({ kind: 'cwd', path: 'C:\\Projects\\my api' });
    expect(parseOsc9('9;C:\\Projects')).toEqual({ kind: 'cwd', path: 'C:\\Projects' });
    expect(parseOsc9('9;')).toBeNull();
  });

  it('parses progress', () => {
    expect(parseOsc9('4;3;0')).toEqual({ kind: 'progress', state: 3, value: 0 });
    expect(parseOsc9('4;1;42')).toEqual({ kind: 'progress', state: 1, value: 42 });
    expect(parseOsc9('4;0')).toEqual({ kind: 'progress', state: 0, value: 0 });
    expect(parseOsc9('4')).toEqual({ kind: 'progress', state: 0, value: 0 });
  });

  it('treats free text as a notification', () => {
    expect(parseOsc9('Claude is waiting for your input')).toEqual({
      kind: 'notify',
      title: '',
      body: 'Claude is waiting for your input',
    });
  });

  it('ignores other ConEmu sub-commands', () => {
    expect(parseOsc9('1;100')).toBeNull();
    expect(parseOsc9('12')).toBeNull();
  });
});

describe('parseOsc777', () => {
  it('parses notify', () => {
    expect(parseOsc777('notify;Claude Code;Task done; really')).toEqual({
      kind: 'notify',
      title: 'Claude Code',
      body: 'Task done; really',
    });
    expect(parseOsc777('other;x')).toBeNull();
  });
});

describe('parseOsc7', () => {
  it('converts file URLs to Windows paths', () => {
    expect(parseOsc7('file://host/C:/Projects/my%20api')).toBe('C:\\Projects\\my api');
    expect(parseOsc7('file:///c:/')).toBe('C:\\');
    expect(parseOsc7('file://host/c/Users/me')).toBe('C:\\Users\\me');
    expect(parseOsc7('file://host/home/me/proj')).toBe('/home/me/proj');
    expect(parseOsc7('not a url')).toBeNull();
  });
});

describe('isWindowsPath', () => {
  it('recognises drive and UNC paths', () => {
    expect(isWindowsPath('C:\\x')).toBe(true);
    expect(isWindowsPath('c:/x')).toBe(true);
    expect(isWindowsPath('\\\\server\\share\\x')).toBe(true);
    expect(isWindowsPath('/home/me')).toBe(false);
    expect(isWindowsPath('relative')).toBe(false);
  });
});
