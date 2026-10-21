/** A release as listed in "What's new" (Settings → About). */
export interface Release {
  version: string;
  /** ISO date it was published. */
  date: string;
  /** Its release notes, as written on GitHub. */
  notes: string;
}

export interface Changelog {
  /** "owner/repo" on GitHub; empty when the build has no changelog. */
  repo: string;
  releases: Release[];
}

/**
 * The releases baked into this build by scripts/changelog.mjs (see vite.config.ts). Local builds have none
 * unless that script was run first.
 */
export function bundledChangelog(raw: unknown = __CHANGELOG__): Changelog {
  const c = (raw ?? {}) as Partial<Changelog>;
  const releases = Array.isArray(c.releases) ? c.releases : [];
  return {
    repo: typeof c.repo === 'string' ? c.repo : '',
    releases: releases
      .filter((r) => r && typeof r.version === 'string')
      .map((r) => ({ version: r.version, date: typeof r.date === 'string' ? r.date : '', notes: typeof r.notes === 'string' ? r.notes : '' })),
  };
}

/**
 * The changes a release lists, one per line of its notes. GitHub's generated notes become just the pull
 * request titles: headings, "Full Changelog" links and the new contributors list are left out.
 */
export function releaseNotes(body: string): string[] {
  const out: string[] = [];
  let contributors = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      contributors = /new contributors/i.test(line);
      continue;
    }
    if (contributors || line.startsWith('**Full Changelog**')) continue;
    out.push(line.replace(/^[*-]\s+/, '').replace(/\s+by @[\w-]+ in https:\/\/\S+$/, ''));
  }
  return out;
}

/** "21 Oct 2026"; empty for a missing or broken date. */
export function releaseDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
