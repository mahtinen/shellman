import { describe, expect, it } from 'vitest';
import { dotenvLine, isLocalEnvFile, parseDotenv, removeDotenv, setDotenv } from './dotenv';

describe('.env files', () => {
  it('reads the usual forms', () => {
    const text = [
      '﻿# a comment',
      'BASE_URL=https://api.example.com # trailing comment',
      'export TENANT = acme',
      'EMPTY=',
      'DOUBLE="line 1\\nline \\"2\\""',
      "SINGLE='no \\n escapes # here'",
      'MULTI="first',
      'second"',
      'API_TOKEN=op://Example Vault/Example API/credential',
      'not a line',
      '1BAD=x',
    ].join('\r\n');
    expect(parseDotenv(text)).toEqual([
      { name: 'BASE_URL', value: 'https://api.example.com' },
      { name: 'TENANT', value: 'acme' },
      { name: 'EMPTY', value: '' },
      { name: 'DOUBLE', value: 'line 1\nline "2"' },
      { name: 'SINGLE', value: 'no \\n escapes # here' },
      { name: 'MULTI', value: 'first\nsecond' },
      { name: 'API_TOKEN', value: 'op://Example Vault/Example API/credential' },
    ]);
  });

  it('writes values back so they read the same', () => {
    for (const value of ['plain', '', 'with space', 'a"b', 'x\\y', 'two\nlines', '#hash']) {
      expect(parseDotenv(dotenvLine('V', value))).toEqual([{ name: 'V', value }]);
    }
  });

  it('updates lines in place and adds new ones at the end', () => {
    const text = '# shared\nA=1\nexport B=2\n';
    expect(setDotenv(text, [{ name: 'B', value: 'two words' }, { name: 'C', value: '3' }])).toBe('# shared\nA=1\nB="two words"\nC=3\n');
    expect(setDotenv('', [{ name: 'A', value: '1' }])).toBe('A=1\n');
  });

  it('replaces and removes multi-line values whole', () => {
    const text = '# keys\nA=1\nCERT="line 1\nline 2"\nB=2\nA=dup\n';
    expect(setDotenv(text, [{ name: 'CERT', value: 'x' }, { name: 'A', value: '9' }])).toBe('# keys\nA=9\nCERT=x\nB=2\n');
    expect(removeDotenv(text, ['CERT', 'A'])).toBe('# keys\nB=2\n');
    expect(removeDotenv('A=1\n', ['A'])).toBe('');
  });

  it('reads the choices right above a variable', () => {
    const text = [
      '# Which tenant to test with',
      '# @choice acme -- Demos and screenshots',
      '#@choice "globex eu" -- EU data -- for GDPR tests',
      '# @choice ""',
      'TENANT=acme',
      '# @choice orphan -- a blank line comes after it',
      '',
      'OTHER=1',
    ].join('\n');
    expect(parseDotenv(text)).toEqual([
      {
        name: 'TENANT',
        value: 'acme',
        choices: [
          { value: 'acme', description: 'Demos and screenshots' },
          { value: 'globex eu', description: 'EU data -- for GDPR tests' },
          { value: '', description: '' },
        ],
      },
      { name: 'OTHER', value: '1' },
    ]);
  });

  it('writes choices so they read the same, and keeps them when only the value changes', () => {
    const choices = [
      { value: 'plain', description: 'first' },
      { value: 'with space', description: '' },
      { value: 'a"b\\c', description: 'two\nlines' },
      { value: '--', description: 'dashes' },
      { value: '', description: 'empty' },
    ];
    const text = setDotenv('# top\nA=1\n', [{ name: 'T', value: 'plain', choices }]);
    expect(text).toBe(
      '# top\nA=1\n# @choice plain -- first\n# @choice "with space"\n# @choice "a\\"b\\\\c" -- two lines\n# @choice -- -- dashes\n# @choice "" -- empty\nT=plain\n',
    );
    expect(parseDotenv(text)[1]).toEqual({ name: 'T', value: 'plain', choices: choices.map((c) => ({ ...c, description: c.description.replace('\n', ' ') })) });
    // A new value alone keeps the choices; new choices replace them; [] removes them.
    expect(parseDotenv(setDotenv(text, [{ name: 'T', value: '--' }]))[1]).toMatchObject({ value: '--', choices: { length: 5 } });
    expect(setDotenv(text, [{ name: 'T', value: 'x', choices: [{ value: 'x', description: '' }] }])).toBe('# top\nA=1\n# @choice x\nT=x\n');
    expect(setDotenv(text, [{ name: 'T', value: 'x', choices: [] }])).toBe('# top\nA=1\nT=x\n');
    expect(removeDotenv(text, ['T'])).toBe('# top\nA=1\n');
  });

  it('knows the personal files', () => {
    expect(['.env.local', '.env.dev.local', '.env.Prod-EU.local'].every(isLocalEnvFile)).toBe(true);
    expect(['.env', '.env.example', '.env..local', 'x.env.local'].some(isLocalEnvFile)).toBe(false);
  });
});
