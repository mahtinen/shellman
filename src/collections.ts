/**
 * The folders sidebar groups are linked to, as read from disk: their requests, environments and
 * `.env` files. Each folder is watched, so a save, an edit in another program or a `git pull`
 * shows up by itself.
 */
import { api } from './api';
import { isLocalEnvFile, localEnvFile, parseDotenv, setDotenv, type DotenvEntry } from './dotenv';
import { parseEnvironment, parseRequest, requestFolder, type EnvironmentDoc, type RequestDoc } from './requestFile';
import type { Group } from './types';
import { collectVariables, type Variable } from './variables';

export interface RequestEntry {
  /** Relative to the folder, with '/'. */
  path: string;
  text: string;
  doc: RequestDoc;
}

export interface Collection {
  groupId: string;
  folder: string;
  requests: RequestEntry[];
  /** Every folder that can hold requests (also empty ones), relative, with '/'. */
  folders: string[];
  /** By name, sorted. */
  environments: Map<string, EnvironmentDoc>;
  dotenv: { path: string; text: string }[];
  gitignore: string | null;
  /** Personal `.env` files that git doesn't ignore (they would be committed). */
  notIgnored: string[];
  /** Why the folder couldn't be read. */
  error: string | null;
}

type Listener = (groupId: string) => void;

class Collections {
  private readonly byGroup = new Map<string, Collection>();
  private readonly watching = new Map<string, { folder: string; id: Promise<number | null> }>();
  /** Bumped per load, so a slow older read never replaces a newer one. */
  private readonly generation = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly loading = new Map<string, Promise<void>>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(groupId: string): void {
    for (const fn of this.listeners) fn(groupId);
  }

  get(groupId: string): Collection | undefined {
    return this.byGroup.get(groupId);
  }

  /** Follows the config: loads and watches newly linked folders, forgets unlinked ones. */
  sync(groups: Group[]): void {
    const linked = new Map(groups.filter((g) => g.folder).map((g) => [g.id, g.folder]));
    for (const [id, w] of this.watching) {
      if (linked.get(id) === w.folder) continue;
      void w.id.then((wid) => {
        if (wid !== null) void api.collectionUnwatch(wid);
      });
      this.watching.delete(id);
      this.byGroup.delete(id);
      this.emit(id);
    }
    for (const [id, folder] of linked) {
      if (this.watching.has(id)) continue;
      const watch = api.collectionWatch(folder, () => void this.reload(id)).catch(() => null);
      this.watching.set(id, { folder, id: watch });
      void this.reload(id);
    }
  }

  /** Resolves once the linked folders have been read (at most a few seconds: a network drive may hang). */
  ready(): Promise<void> {
    const all = Promise.all([...this.loading.values()]).then(() => undefined);
    return Promise.race([all, new Promise<void>((r) => setTimeout(r, 5000))]);
  }

  /** Reads the folder again. */
  reload(groupId: string): Promise<void> {
    const p = this.read(groupId).finally(() => {
      if (this.loading.get(groupId) === p) this.loading.delete(groupId);
    });
    this.loading.set(groupId, p);
    return p;
  }

  private async read(groupId: string): Promise<void> {
    const folder = this.watching.get(groupId)?.folder;
    if (!folder) return;
    const gen = (this.generation.get(groupId) ?? 0) + 1;
    this.generation.set(groupId, gen);
    let c: Collection;
    try {
      const scan = await api.collectionScan(folder);
      const environments = new Map(scan.environments.map((e) => [e.path, parseEnvironment(e.text)]));
      c = {
        groupId,
        folder,
        requests: scan.requests.map((r) => ({ path: r.path, text: r.text, doc: parseRequest(r.text) })),
        folders: scan.folders,
        environments,
        dotenv: scan.dotenv,
        gitignore: scan.gitignore,
        notIgnored: this.byGroup.get(groupId)?.notIgnored ?? [],
        error: null,
      };
    } catch (e) {
      c = { groupId, folder, requests: [], folders: [], environments: new Map(), dotenv: [], gitignore: null, notIgnored: [], error: String(e) };
    }
    if (this.generation.get(groupId) !== gen || this.watching.get(groupId)?.folder !== folder) return;
    this.byGroup.set(groupId, c);
    this.emit(groupId);
    void this.checkIgnored(c);
  }

  /** Personal files must stay out of git; finds the ones git would pick up. */
  private async checkIgnored(c: Collection): Promise<void> {
    const local = c.dotenv.map((f) => f.path).filter(isLocalEnvFile);
    const flags = await Promise.all(local.map((f) => api.gitIsIgnored(c.folder, f).catch(() => null)));
    const notIgnored = local.filter((_, i) => flags[i] === false);
    if (notIgnored.join() === c.notIgnored.join()) return;
    c.notIgnored = notIgnored;
    if (this.byGroup.get(c.groupId) === c) this.emit(c.groupId);
  }

  /** The group's environment: the chosen one if it still exists, else the first. */
  env(group: Group): string {
    const envs = this.get(group.id)?.environments;
    if (!envs?.size) return '';
    return envs.has(group.env) ? group.env : [...envs.keys()][0];
  }

  environment(group: Group): EnvironmentDoc | undefined {
    return this.get(group.id)?.environments.get(this.env(group));
  }

  variables(group: Group): Map<string, Variable> {
    const c = this.get(group.id);
    if (!c) return new Map();
    const env = this.env(group);
    return collectVariables({ env, environment: c.environments.get(env)?.variables ?? {}, dotenv: c.dotenv });
  }

  /** The request at `path`; case doesn't matter, as on Windows' disks. */
  request(groupId: string, path: string): RequestEntry | undefined {
    const lower = path.toLowerCase();
    return this.get(groupId)?.requests.find((r) => r.path === path) ?? this.get(groupId)?.requests.find((r) => r.path.toLowerCase() === lower);
  }

  /** Folders and requests directly in `folder` ('' = the top). */
  children(groupId: string, folder: string): { folders: string[]; requests: RequestEntry[] } {
    const c = this.get(groupId);
    if (!c) return { folders: [], requests: [] };
    const depth = folder ? folder.split('/').length + 1 : 1;
    return {
      folders: c.folders.filter((f) => f.split('/').length === depth && requestFolder(f) === folder),
      requests: c.requests.filter((r) => requestFolder(r.path) === folder),
    };
  }

  /** Adds or replaces values in a personal file (`.env.local`, or one environment's). */
  async setPersonal(group: Group, entries: DotenvEntry[], env = '', keepMine = false): Promise<string> {
    const c = this.get(group.id);
    if (!c || !entries.length) return '';
    const file = env ? localEnvFile(env) : '.env.local';
    const current = c.dotenv.find((f) => f.path.toLowerCase() === file.toLowerCase())?.text ?? '';
    // keepMine (an import): a value someone already has stays; the import only adds names.
    const mine = new Set(parseDotenv(current).map((e) => e.name));
    const add = keepMine ? entries.filter((e) => !mine.has(e.name)) : entries;
    if (!add.length) return file;
    await api.collectionWrite(c.folder, file, 'rootFile', setDotenv(current, add));
    await this.reload(group.id);
    return file;
  }

  /** Adds `.env*.local` to the folder's `.gitignore`. */
  async ignoreLocalFiles(groupId: string): Promise<void> {
    const c = this.get(groupId);
    if (!c) return;
    const text = c.gitignore ?? '';
    const sep = text && !text.endsWith('\n') ? '\n' : '';
    await api.collectionWrite(c.folder, '.gitignore', 'rootFile', `${text}${sep}# Personal values for Shellman requests\n.env*.local\n`);
    await this.reload(groupId);
  }
}

export const collections = new Collections();
