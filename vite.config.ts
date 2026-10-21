/// <reference types="vitest/config" />
import fs from 'node:fs';
import { defineConfig } from 'vite';

/** "What's new" in Settings → About: written by scripts/changelog.mjs before release builds. */
function changelog(): unknown {
  try {
    return JSON.parse(fs.readFileSync(new URL('./changelog.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  clearScreen: false,
  define: {
    __CHANGELOG__: JSON.stringify(changelog()),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
