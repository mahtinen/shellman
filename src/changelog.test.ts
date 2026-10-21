import { describe, expect, it } from 'vitest';
import { bundledChangelog, releaseDate, releaseNotes } from './changelog';

describe('changelog', () => {
  it('turns GitHub generated notes into pull request titles', () => {
    const body = [
      "## What's Changed",
      '* Settings: keep the dialog and its tab list in place by @someone in https://github.com/example/shellman/pull/9',
      '* Faster startup by @other-dev in https://github.com/example/shellman/pull/10',
      '',
      '## New Contributors',
      '* @other-dev made their first contribution in https://github.com/example/shellman/pull/10',
      '',
      '',
      '**Full Changelog**: https://github.com/example/shellman/compare/v0.5.1...v0.5.2',
    ].join('\r\n');
    expect(releaseNotes(body)).toEqual(['Settings: keep the dialog and its tab list in place', 'Faster startup']);
  });

  it('keeps hand-written notes, one change per line', () => {
    expect(releaseNotes('More colours: 15 presets.')).toEqual(['More colours: 15 presets.']);
    expect(releaseNotes('Import from XShell.\nGroups can have subgroups.\n')).toEqual(['Import from XShell.', 'Groups can have subgroups.']);
    expect(releaseNotes('- Dashed item\n* Starred item')).toEqual(['Dashed item', 'Starred item']);
    expect(releaseNotes('')).toEqual([]);
  });

  it('formats release dates', () => {
    expect(releaseDate('2026-10-21T12:00:00Z')).toBe('21 Oct 2026');
    expect(releaseDate('')).toBe('');
    expect(releaseDate('not a date')).toBe('');
  });

  it('reads the bundled changelog defensively', () => {
    expect(bundledChangelog(null)).toEqual({ repo: '', releases: [] });
    expect(bundledChangelog([])).toEqual({ repo: '', releases: [] });
    expect(
      bundledChangelog({
        repo: 'example/shellman',
        releases: [{ version: '0.5.2', date: '2026-10-21T19:33:33Z', notes: 'Fix' }, { version: 3 }, null, { version: '0.5.1' }],
      }),
    ).toEqual({
      repo: 'example/shellman',
      releases: [
        { version: '0.5.2', date: '2026-10-21T19:33:33Z', notes: 'Fix' },
        { version: '0.5.1', date: '', notes: '' },
      ],
    });
  });
});
