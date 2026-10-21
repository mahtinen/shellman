// Writes changelog.json: the latest releases with their dates and notes, which Settings → About shows as
// "What's new". The Release workflow runs it before the build with the version being released; vite.config.ts
// bakes the file into the app, so the list needs no network.
//
//   node scripts/changelog.mjs [X.Y.Z] [--notes "What changed"]
//
// Without a version it lists the latest published releases (for trying it in a local build).
// Without notes, the new version gets the notes GitHub generates for its release. Needs the GitHub CLI.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubRepo } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHANGELOG_FILE = path.join(ROOT, 'changelog.json');
const KEEP = 5;

function gh(args) {
  const r = spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return JSON.parse(r.stdout);
}

/** Newest first, by version number. */
const byVersion = (a, b) => {
  const pa = a.version.split('.').map(Number);
  const pb = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
};

export function writeChangelog({ version = '', notes = '' } = {}) {
  const repo = githubRepo();
  const releases = gh(['api', `repos/${repo}/releases?per_page=30`])
    .filter((r) => !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => ({ version: r.tag_name.replace(/^v/, ''), date: r.published_at, notes: r.body ?? '' }));
  if (version && !releases.some((r) => r.version === version)) {
    // The release itself is created after the build, so ask GitHub for the notes it will generate. Name
    // the previous release: left to guess, GitHub may compare with an older one.
    const args = ['api', '-X', 'POST', `repos/${repo}/releases/generate-notes`, '-f', `tag_name=v${version}`, '-f', `target_commitish=${process.env.GITHUB_SHA || 'main'}`];
    const previous = [...releases].sort(byVersion)[0];
    if (previous) args.push('-f', `previous_tag_name=v${previous.version}`);
    const text = notes || gh(args).body;
    releases.push({ version, date: new Date().toISOString(), notes: text });
  }
  const changelog = { repo, releases: releases.sort(byVersion).slice(0, KEEP) };
  fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(changelog, null, 2) + '\n');
  return changelog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] ?? '').startsWith('--') ? '' : (process.argv[2] ?? '').replace(/^v/, '');
  const i = process.argv.indexOf('--notes');
  try {
    const { releases } = writeChangelog({ version, notes: i > 0 ? (process.argv[i + 1] ?? '') : '' });
    console.log(`Wrote ${CHANGELOG_FILE}: ${releases.map((r) => r.version).join(', ')}`);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
