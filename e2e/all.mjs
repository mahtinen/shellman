// Runs every e2e phase against the release build. Your real Shellman config is
// moved aside first and restored afterwards, whatever happens.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXE } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(process.env.APPDATA, 'app.shellman.desktop');
const backup = `${configDir}.e2e-backup`;

if (!fs.existsSync(EXE)) {
  console.error(`Build the app first (npm run app:build or npx tauri build --no-bundle): ${EXE} not found`);
  process.exit(2);
}
// A running Shellman shares the config folder; moving it aside would lose its saves.
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq shellman.exe', '/NH'], { encoding: 'utf8' }).stdout;
if (/shellman\.exe/i.test(running)) {
  console.error('Shellman is running. Close it before running the e2e tests (they temporarily replace its config).');
  process.exit(2);
}
if (fs.existsSync(backup)) {
  console.error(`A previous run left ${backup}; restore or remove it first.`);
  process.exit(2);
}

const hadConfig = fs.existsSync(configDir);
if (hadConfig) fs.renameSync(configDir, backup);
let failed = false;
try {
  for (const phase of ['main', 'restart', 'quit']) {
    console.log(`\n== ${phase}`);
    const r = spawnSync(process.execPath, [path.join(here, 'run.mjs'), phase], { stdio: 'inherit' });
    if (r.status !== 0) failed = true;
  }
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
  if (hadConfig) fs.renameSync(backup, configDir);
}
process.exit(failed ? 1 : 0);
