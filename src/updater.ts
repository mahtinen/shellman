import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { api } from './api';
import { toast } from './dialogs';
import { store } from './store';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Background updates from GitHub Releases. With automatic updates, a new version is downloaded as
 * soon as it is found and installed on the next restart (or when Shellman is closed).
 */
class Updater {
  state: UpdateState = { kind: 'idle' };
  private update: Update | null = null;
  private checking = false;
  private readonly listeners = new Set<() => void>();

  start(): void {
    // Only builds made by the Release workflow update themselves in the background. A local or test
    // build carries an older version number and would otherwise replace the installed Shellman.
    // "Check now" in Settings still works everywhere.
    if (!import.meta.env.VITE_SHELLMAN_RELEASE) return;
    const tick = () => {
      if (store.settings.updates !== 'off') void this.check(false);
    };
    window.setTimeout(tick, FIRST_CHECK_MS);
    window.setInterval(tick, CHECK_EVERY_MS);
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get ready(): boolean {
    return this.state.kind === 'ready';
  }

  /** Looks for a newer release. With automatic updates on, downloads it straight away. */
  async check(manual: boolean): Promise<void> {
    if (this.checking || this.state.kind === 'downloading' || this.state.kind === 'ready') return;
    this.checking = true;
    if (manual) this.set({ kind: 'checking' });
    try {
      const update = await check({ timeout: 30_000 });
      if (!update) {
        this.set({ kind: 'current' });
        return;
      }
      void this.update?.close();
      this.update = update;
      this.set({ kind: 'available', version: update.version });
      if (store.settings.updates === 'auto') await this.download();
    } catch (e) {
      // Offline or no release published yet: stay quiet unless the user asked.
      console.warn('Update check failed:', e);
      if (manual) this.set({ kind: 'error', message: `Could not check for updates: ${e}` });
      else if (this.state.kind === 'checking') this.set({ kind: 'idle' });
    } finally {
      this.checking = false;
    }
  }

  async download(): Promise<void> {
    const update = this.update;
    if (!update || this.state.kind === 'downloading' || this.state.kind === 'ready') return;
    let total = 0;
    let received = 0;
    this.set({ kind: 'downloading', version: update.version, percent: null });
    try {
      await update.download((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
        else if (ev.event === 'Progress') {
          received += ev.data.chunkLength;
          const percent = total ? Math.min(100, Math.round((received * 100) / total)) : null;
          if (this.state.kind === 'downloading' && this.state.percent !== percent) this.set({ kind: 'downloading', version: update.version, percent });
        }
      });
      this.set({ kind: 'ready', version: update.version });
      toast(`Shellman ${update.version} is ready. It will be installed when you restart Shellman.`, 'info', 10000);
    } catch (e) {
      console.warn('Update download failed:', e);
      this.set({ kind: 'error', message: `Could not download ${update.version}: ${e}` });
    }
  }

  /**
   * Installs the downloaded update. On Windows this starts the installer and exits Shellman;
   * `restart` starts the new version once it is installed. False when it couldn't be installed
   * (the terminals have been ended by then).
   */
  async install(restart: boolean): Promise<boolean> {
    if (!this.update || this.state.kind !== 'ready') return false;
    try {
      // The installer replaces Shellman's files, so end the terminals first instead of orphaning them.
      await api.killAll();
      await this.update.install({ restartAfterInstall: restart });
      if (restart) await relaunch();
      return true;
    } catch (e) {
      this.set({ kind: 'error', message: `Could not install the update: ${e}` });
      toast(`Could not install the update: ${e}`, 'error', 10000);
      return false;
    }
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.listeners.forEach((l) => l());
  }
}

export const updater = new Updater();
