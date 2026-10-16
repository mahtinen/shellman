// Sets the app version everywhere it is recorded. The release workflow runs this on its own
// checkout, so the version comes from the release tag rather than from a commit.
//
//   node scripts/set-version.mjs 0.2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/set-version.mjs <major.minor.patch>');
  process.exit(1);
}

const edit = (file, re, replacement) => {
  const p = path.join(ROOT, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = before.replace(re, replacement);
  if (after === before && !before.includes(version)) throw new Error(`No version found in ${file}`);
  fs.writeFileSync(p, after);
};

edit('package.json', /("version":\s*")[^"]+"/, `$1${version}"`);
edit('src-tauri/tauri.conf.json', /("version":\s*")[^"]+"/, `$1${version}"`);
edit('src-tauri/Cargo.toml', /^version = "[^"]+"/m, `version = "${version}"`);
console.log(`Version set to ${version}`);
