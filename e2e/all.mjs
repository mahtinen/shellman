// Runs every e2e phase against the release build, in a throwaway profile (SHELLMAN_CONFIG_DIR), so a
// Shellman you have open keeps its settings, tabs and window position.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXE } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

if (!fs.existsSync(EXE)) {
  console.error(`Build the app first (npm run app:build or npx tauri build --no-bundle): ${EXE} not found`);
  process.exit(2);
}

const profile = path.join(os.tmpdir(), 'shellman-e2e-profile');
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
// No update checks: a local build is older than the latest release and must not install it.
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ version: 1, settings: { updates: 'off' } }));
process.env.SHELLMAN_CONFIG_DIR = profile;

let failed = false;
try {
  for (const phase of ['main', 'restart', 'quit']) {
    console.log(`\n== ${phase}`);
    const r = spawnSync(process.execPath, [path.join(here, 'run.mjs'), phase], { stdio: 'inherit' });
    if (r.status !== 0) failed = true;
  }
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
