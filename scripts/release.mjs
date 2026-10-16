// Publishes a new version to GitHub Releases, where installed copies of Shellman pick it up.
//
//   npm run release -- 0.2.0 [--notes "What changed"]
//
// Bumps the version in package.json, tauri.conf.json and Cargo.toml, makes a signed build
// (scripts/build.mjs) and creates the GitHub release v<version> with the installer, its
// signature and latest.json. Needs the GitHub CLI (`gh auth login`) and a public repository.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, githubRepo, readConf } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const version = process.argv[2];
const ni = process.argv.indexOf('--notes');
const notes = ni > 0 ? (process.argv[ni + 1] ?? '') : '';
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('Usage: npm run release -- <major.minor.patch> [--notes "What changed"]');

const current = readConf().version;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
// The current version is fine too, as long as it hasn't been released (the first release).
if (version !== current && !newer(version, current)) fail(`${version} is not newer than the current version ${current}.`);
const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
if (git(['status', '--porcelain']).stdout.trim()) fail('Commit or stash your changes first, so the release matches the repository.');

const repo = githubRepo();
const gh = (args, opts = {}) => spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8', ...opts });
if (gh(['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility']).stdout.trim() !== 'PUBLIC') {
  fail(`github.com/${repo} doesn't exist or isn't public; installed copies couldn't download updates from it.`);
}
if (gh(['release', 'view', `v${version}`, '--repo', repo]).status === 0) fail(`Release v${version} already exists.`);

// Bump the version everywhere it is recorded.
const edit = (file, fn) => {
  const p = path.join(ROOT, file);
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
};
edit('package.json', (s) => s.replace(/("version":\s*")[^"]+"/, `$1${version}"`));
edit('src-tauri/tauri.conf.json', (s) => s.replace(/("version":\s*")[^"]+"/, `$1${version}"`));
edit('src-tauri/Cargo.toml', (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));
// The website's structured data names the current version.
edit('docs/index.html', (s) => s.replace(/("softwareVersion":\s*")[^"]+"/, `$1${version}"`));
console.log(`Version ${current} -> ${version}`);

let files;
try {
  ({ files } = build({ notes }));
} catch (e) {
  fail(String(e.message ?? e));
}

// Commit the bump after building, so Cargo.lock's new version is included.
if (git(['status', '--porcelain']).stdout.trim()) {
  const r = git(['commit', '-am', `Release v${version}`]);
  if (r.status !== 0) fail(r.stderr || r.stdout);
}
if (git(['push']).status !== 0) fail('git push failed.');

const r = gh(['release', 'create', `v${version}`, ...files, '--repo', repo, '--target', git(['rev-parse', 'HEAD']).stdout.trim(), '--title', `Shellman ${version}`, '--notes', notes || `Shellman ${version}`], {
  stdio: 'inherit',
});
if (r.status !== 0) fail('gh release create failed; the build is in src-tauri/target/release/bundle/nsis.');
console.log(`\nPublished https://github.com/${repo}/releases/tag/v${version}`);
