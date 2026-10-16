import { api } from './api';
import { defaultConfig, normalizeConfig } from './config';
import { toast } from './dialogs';
import type { Config, SavedSession, Settings, ShellProfile, SystemInfo } from './types';

type Listener = () => void;

/** Application state: config (persisted), detected shells and system info. */
class Store {
  config: Config = defaultConfig();
  detectedShells: ShellProfile[] = [];
  sys: SystemInfo = { homeDir: 'C:\\', configDir: '', windowsBuild: 0, version: '' };
  private listeners = new Set<Listener>();
  private saveTimer: number | undefined;
  private saving: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    const [sys, shells, raw] = await Promise.all([
      api.systemInfo(),
      api.listShells(),
      api.loadConfig().catch((e) => {
        toast(`Could not load settings: ${e}`, 'error', 8000);
        return null;
      }),
    ]);
    this.sys = sys;
    this.detectedShells = shells;
    this.config = normalizeConfig(raw);
  }

  get settings(): Settings {
    return this.config.settings;
  }

  get shells(): ShellProfile[] {
    return [...this.detectedShells, ...this.config.settings.customShells];
  }

  /** Resolves a shell id ('' = default) to an installed profile. */
  resolveShell(id: string): ShellProfile | null {
    const all = this.shells;
    return (
      all.find((s) => s.id === id) ??
      all.find((s) => s.id === this.settings.defaultShellId) ??
      all[0] ??
      null
    );
  }

  defaultCwd(): string {
    return this.settings.defaultCwd || this.sys.homeDir;
  }

  session(id: string | null | undefined): SavedSession | undefined {
    return id ? this.config.sessions.find((s) => s.id === id) : undefined;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Mutates the config, notifies listeners and schedules a save. */
  update(mutate: (c: Config) => void): void {
    mutate(this.config);
    this.config = normalizeConfig(this.config);
    this.listeners.forEach((l) => l());
    this.scheduleSave();
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 300);
  }

  /** Writes pending changes now (used before the window closes). */
  flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    const snapshot = JSON.parse(JSON.stringify(this.config)) as Config;
    this.saving = this.saving.then(() =>
      api.saveConfig(snapshot).catch((e) => toast(`Could not save settings: ${e}`, 'error', 8000)),
    );
    return this.saving;
  }
}

export const store = new Store();
