// Signed release build: runs `tauri build` with the updater signing key and writes latest.json
// (the file installed copies of Shellman poll for updates) next to the installer.
//
//   node scripts/build.mjs [--notes "What changed"]
//
// The private key is read from TAURI_SIGNING_PRIVATE_KEY, or from %USERPROFILE%\.tauri\shellman.key.
// Keep that key out of the repository and backed up: without it, installed copies can't be updated.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KEY_FILE = path.join(os.homedir(), '.tauri', 'shellman.key');

export function readConf() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
}

/** "owner/repo" from the updater endpoint in tauri.conf.json. */
export function githubRepo(conf = readConf()) {
  const url = conf.plugins?.updater?.endpoints?.[0] ?? '';
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//.exec(url);
  if (!m) throw new Error(`The updater endpoint is not a GitHub Releases URL: ${url}`);
  return m[1];
}

export function build({ notes = '' } = {}) {
  const env = { ...process.env };
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    if (!fs.existsSync(KEY_FILE)) {
      throw new Error(`No updater signing key. Set TAURI_SIGNING_PRIVATE_KEY or create ${KEY_FILE} with:\n  npx tauri signer generate --ci -w "${KEY_FILE}"\n(and put the new public key in src-tauri/tauri.conf.json)`);
    }
    env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
  }
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';

  const r = spawnSync('npx tauri build', { cwd: ROOT, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error('tauri build failed');

  const conf = readConf();
  const version = conf.version;
  const dir = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const installer = `${conf.productName}_${version}_x64-setup.exe`;
  const sigFile = path.join(dir, `${installer}.sig`);
  if (!fs.existsSync(sigFile)) throw new Error(`Missing ${sigFile}; the installer was not signed.`);

  const latest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: fs.readFileSync(sigFile, 'utf8').trim(),
        url: `https://github.com/${githubRepo(conf)}/releases/download/v${version}/${installer}`,
      },
    },
  };
  const latestFile = path.join(dir, 'latest.json');
  fs.writeFileSync(latestFile, JSON.stringify(latest, null, 2) + '\n');
  // Same installer under a name that never changes, so releases/latest/download/Shellman-setup.exe
  // always gets the newest version (the website links to it).
  const stable = path.join(dir, `${conf.productName}-setup.exe`);
  fs.copyFileSync(path.join(dir, installer), stable);
  return { version, files: [path.join(dir, installer), sigFile, latestFile, stable] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--notes');
  try {
    const { files } = build({ notes: i > 0 ? (process.argv[i + 1] ?? '') : '' });
    console.log(`\nBuilt and signed:\n${files.map((f) => `  ${f}`).join('\n')}`);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
