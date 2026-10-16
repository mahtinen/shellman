// Starts the Release workflow on GitHub (the same as Actions → Release → Run workflow).
// The build, signing and publishing all happen in GitHub Actions; see .github/workflows/release.yml.
//
//   npm run release -- 0.2.0 [--notes "What changed"]
//
// Needs the GitHub CLI (`gh auth login`). Releases are built from main as it is on GitHub,
// so push your commits and let CI pass first.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubRepo } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const version = (process.argv[2] ?? '').replace(/^v/, '');
const ni = process.argv.indexOf('--notes');
const notes = ni > 0 ? (process.argv[ni + 1] ?? '') : '';
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Usage: npm run release -- <major.minor.patch> [--notes "What changed"]');

const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
git(['fetch', '--quiet', 'origin', 'main']);
const ahead = git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim();
if (ahead && ahead !== '0') console.warn(`Note: ${ahead} local commit(s) aren't on GitHub yet and won't be in this release.`);

const repo = githubRepo();
const r = spawnSync('gh', ['workflow', 'run', 'release.yml', '--repo', repo, '--ref', 'main', '-f', `version=${version}`, '-f', `notes=${notes}`], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (r.status !== 0) fail('Could not start the Release workflow.');
console.log(`Started the release of ${version}. Follow it at https://github.com/${repo}/actions/workflows/release.yml`);
