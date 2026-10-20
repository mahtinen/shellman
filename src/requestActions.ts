/**
 * What can be done with the requests of a linked folder from the sidebar and menus: new, rename,
 * duplicate, delete, paste a curl command, import from Postman, environments.
 */
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api } from './api';
import { collections, type Collection } from './collections';
import { parseCurl } from './curl';
import { confirmDialog, dialog, promptDialog, toast } from './dialogs';
import { h } from './dom';
import { localEnvFile, parseDotenv, setDotenv, type DotenvEntry } from './dotenv';
import type { MenuEntry } from './menu';
import { importCollection, importEnvironment, importGlobals, isPostmanCollection, isPostmanEnvironment, isPostmanGlobals } from './postman';
import {
  environmentFileName,
  newRequest,
  requestFileName,
  requestFolder,
  requestName,
  REQUEST_EXT,
  serializeEnvironment,
  serializeRequest,
  type RequestDoc,
} from './requestFile';
import type { RequestPane } from './requestPane';
import { store } from './store';
import { editVariables } from './variablesDialog';
import { gitSync } from './gitSync';
import type { Group, SplitPlacement } from './types';
import type { Workspace } from './workspace';

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** How a click on a request opens it. */
export type OpenHow = 'click' | 'pin' | 'right' | 'down';

export function openRequest(ws: Workspace, group: Group, path: string, how: OpenHow): void {
  const s = store.settings;
  const active = ws.activePane();
  const placement: SplitPlacement = how === 'right' || how === 'down' ? how : s.requestOpenIn === 'split' && active ? 'right' : 'tab';
  ws.openRequest({ groupId: group.id, path }, { preview: how === 'click' && s.requestPreviewTabs, placement, targetPaneId: placement === 'tab' ? undefined : active?.id });
}

async function writeRequest(group: Group, path: string, doc: RequestDoc): Promise<boolean> {
  const c = collections.get(group.id);
  if (!c) return false;
  if (collections.request(group.id, path)) {
    toast(`${path} already exists`, 'error');
    return false;
  }
  try {
    await api.collectionWrite(c.folder, path, 'request', serializeRequest(doc));
    await collections.reload(group.id);
    void gitSync.changed(group.id, [path]);
    return true;
  } catch (e) {
    toast(String(e), 'error', 8000);
    return false;
  }
}

/** Asks for a name and creates the request in `folder` ('' = the top), then opens it. */
export async function createRequest(ws: Workspace, group: Group, folder = '', doc?: RequestDoc, suggested = 'new-request'): Promise<void> {
  const name = await promptDialog('New request', 'Name', suggested);
  if (!name?.trim()) return;
  const path = join(folder, requestFileName(name));
  const initial = doc ?? { ...newRequest(), url: collections.variables(group).has('baseUrl') ? '{{baseUrl}}/' : '' };
  if (await writeRequest(group, path, initial)) openRequest(ws, group, path, 'pin');
}

export async function createFolder(group: Group, parent = ''): Promise<void> {
  const c = collections.get(group.id);
  const name = await promptDialog('New folder', 'Name', '');
  if (!c || !name?.trim()) return;
  await api.collectionCreateFolder(c.folder, join(parent, name.trim().replace(/[<>:"/\\|?*]/g, '-'))).then(
    () => collections.reload(group.id),
    (e) => toast(String(e), 'error'),
  );
}

/** Open panes inside `prefix` (a request path, or a folder followed by '/'). */
function panesUnder(ws: Workspace, group: Group, prefix: string): RequestPane[] {
  return [...ws.panes.values()].filter(
    (p): p is RequestPane => p.kind === 'request' && (p as RequestPane).ref.groupId === group.id && ((p as RequestPane).ref.path === prefix || (p as RequestPane).ref.path.startsWith(prefix)),
  );
}

export async function renameRequest(ws: Workspace, group: Group, path: string): Promise<void> {
  const c = collections.get(group.id);
  const name = await promptDialog('Rename request', 'Name', requestName(path));
  if (!c || !name?.trim() || name.trim() === requestName(path)) return;
  const to = join(requestFolder(path), requestFileName(name));
  try {
    await api.collectionRename(c.folder, path, to, 'request');
  } catch (e) {
    return toast(String(e), 'error');
  }
  for (const p of panesUnder(ws, group, path)) p.moveTo(to);
  await collections.reload(group.id);
  void gitSync.changed(group.id, [path, to]);
}

export async function renameFolder(ws: Workspace, group: Group, folder: string): Promise<void> {
  const c = collections.get(group.id);
  const name = await promptDialog('Rename folder', 'Name', folder.split('/').pop() ?? folder);
  if (!c || !name?.trim()) return;
  const to = join(requestFolder(folder), name.trim().replace(/[<>:"/\\|?*]/g, '-'));
  if (to === folder) return;
  try {
    await api.collectionRename(c.folder, folder, to, 'folder');
  } catch (e) {
    return toast(String(e), 'error');
  }
  for (const p of panesUnder(ws, group, `${folder}/`)) p.moveTo(to + p.ref.path.slice(folder.length));
  await collections.reload(group.id);
  void gitSync.changed(group.id, [folder, to]);
}

/** Moves a request into `folder` ('' = the top), keeping its name. */
export async function moveRequest(ws: Workspace, group: Group, path: string, folder: string): Promise<void> {
  const c = collections.get(group.id);
  const to = join(folder, path.split('/').pop() ?? path);
  if (!c || to === path) return;
  if (collections.request(group.id, to)) return toast(`${to} already exists`, 'error');
  try {
    await api.collectionRename(c.folder, path, to, 'request');
  } catch (e) {
    return toast(String(e), 'error');
  }
  for (const p of panesUnder(ws, group, path)) p.moveTo(to);
  await collections.reload(group.id);
  gitSync.changed(group.id, [path, to]);
}

/** Moves a folder (with everything in it) into `target` ('' = the top). */
export async function moveFolder(ws: Workspace, group: Group, folder: string, target: string): Promise<void> {
  const c = collections.get(group.id);
  const to = join(target, folder.split('/').pop() ?? folder);
  if (!c || to === folder || target === folder || target.startsWith(`${folder}/`)) return;
  try {
    await api.collectionRename(c.folder, folder, to, 'folder');
  } catch (e) {
    return toast(String(e), 'error');
  }
  for (const p of panesUnder(ws, group, `${folder}/`)) p.moveTo(to + p.ref.path.slice(folder.length));
  await collections.reload(group.id);
  gitSync.changed(group.id, [folder, to]);
}

export async function duplicateRequest(ws: Workspace, group: Group, path: string): Promise<void> {
  const entry = collections.request(group.id, path);
  if (!entry) return;
  let to = join(requestFolder(path), requestFileName(`${requestName(path)} copy`));
  for (let n = 2; collections.request(group.id, to); n++) to = join(requestFolder(path), requestFileName(`${requestName(path)} copy ${n}`));
  if (await writeRequest(group, to, entry.doc)) openRequest(ws, group, to, 'pin');
}

export async function deleteRequest(ws: Workspace, group: Group, path: string): Promise<void> {
  const c = collections.get(group.id);
  if (!c || !(await confirmDialog(`Delete "${requestName(path)}"?`, `The file ${path} is deleted from the folder. With git you can still get it back from history.`, 'Delete', true))) return;
  for (const p of panesUnder(ws, group, path)) ws.closePane(p.id);
  await api.collectionDelete(c.folder, path, 'request').then(
    () => collections.reload(group.id).then(() => gitSync.changed(group.id, [path])),
    (e) => toast(String(e), 'error'),
  );
}

export async function deleteFolder(ws: Workspace, group: Group, folder: string): Promise<void> {
  const c = collections.get(group.id);
  if (!c) return;
  const count = c.requests.filter((r) => r.path.startsWith(`${folder}/`)).length;
  const what = count ? `It holds ${count} request${count > 1 ? 's' : ''}, which are deleted too.` : 'It is empty.';
  if (!(await confirmDialog(`Delete folder "${folder}"?`, what, 'Delete', true))) return;
  for (const p of panesUnder(ws, group, `${folder}/`)) ws.closePane(p.id);
  await api.collectionDelete(c.folder, folder, 'folder').then(
    () => collections.reload(group.id).then(() => gitSync.changed(group.id, [folder])),
    (e) => toast(String(e), 'error'),
  );
}

/** A curl command (e.g. a browser's "Copy as cURL") as a new request. */
export function pasteCurl(ws: Workspace, group: Group, folder = ''): void {
  const text = h('textarea', { class: 'input mono', rows: 10, spellcheck: false, placeholder: "curl 'https://api.example.com/users' -H 'accept: application/json'" });
  const error = h('div', { class: 'field-error' });
  void api.clipboardRead().then((t) => {
    if (!text.value && /^\s*curl(\.exe)?\s/i.test(t)) text.value = t;
  });
  dialog({
    title: 'Paste a curl command',
    width: 640,
    body: [h('label', { class: 'field' }, h('span', null, 'curl command (bash or cmd style)'), text), error],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create request',
        kind: 'primary',
        onClick: () => {
          try {
            const { doc, skipped } = parseCurl(text.value);
            if (skipped.length) toast(`Left out: ${skipped.join(', ')}`, 'info', 8000);
            const host = /^[a-z]+:\/\/([^/?#]+)/i.exec(doc.url)?.[1] ?? '';
            const last = doc.url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? '';
            void createRequest(ws, group, folder, doc, `${doc.method.toLowerCase()}-${last && last !== host ? last : 'request'}`);
          } catch (e) {
            error.textContent = (e as Error).message;
            return false;
          }
        },
      },
    ],
    focus: text,
  });
}

/** Postman collection and environment exports, into the linked folder. */
export async function importPostman(group: Group): Promise<void> {
  const c = collections.get(group.id);
  if (!c) return;
  const picked = await openDialog({ multiple: true, directory: false, filters: [{ name: 'Postman export', extensions: ['json'] }] });
  const files = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await api.readJsonFile(file));
    } catch (e) {
      toast(`${file}: ${e instanceof SyntaxError ? 'not valid JSON' : e}`, 'error', 8000);
      continue;
    }
    try {
      if (isPostmanCollection(raw)) await importCollectionInto(group, raw);
      else if (isPostmanGlobals(raw)) await importGlobalsInto(group, raw);
      else if (isPostmanEnvironment(raw)) await importEnvironmentInto(group, raw);
      else toast(`${file} isn't a Postman collection, environment or globals export.`, 'error', 8000);
    } catch (e) {
      toast(String(e), 'error', 8000);
    }
  }
}

/**
 * Whether `entries` may go into the shared `.env`: values the team already shares under the same
 * names are replaced only when asked.
 */
async function replaceShared(c: Collection, entries: DotenvEntry[]): Promise<boolean> {
  const current = new Map(parseDotenv(c.dotenv.find((f) => f.path === '.env')?.text ?? '').map((e) => [e.name, e.value]));
  const differing = entries.filter((e) => current.has(e.name) && current.get(e.name) !== e.value).map((e) => e.name);
  return !differing.length || confirmDialog('Replace shared values?', `.env already has ${differing.join(', ')} with other values. Replace them with the ones from Postman?`, 'Replace', true);
}

async function importCollectionInto(group: Group, raw: unknown): Promise<void> {
  const existing = new Map([...collections.variables(group)].map(([name, v]) => [name, v.value]));
  const r = importCollection(raw, existing);
  const c = collections.get(group.id)!;
  const target = h('input', { class: 'input', value: requestFileName(r.name).slice(0, -REQUEST_EXT.length), spellcheck: false });
  const ok = await new Promise<boolean>((resolve) => {
    let go = false;
    dialog({
      title: `Import "${r.name}"`,
      width: 560,
      body: [
        h('p', { class: 'dialog-text' }, `${r.requests.length} request${r.requests.length === 1 ? '' : 's'}.`),
        h('label', { class: 'field' }, h('span', null, 'Into folder (empty = the top of the linked folder)'), target),
        r.shared.length ? h('p', { class: 'hint' }, `Collection variables for the shared .env: ${r.shared.map((e) => e.name).join(', ')}`) : null,
        r.personal.length
          ? h('p', { class: 'hint' }, `Secrets for your own .env.local (not shared): ${r.personal.map((e) => e.name).join(', ')}. Requests refer to them as {{NAME}}.`)
          : null,
        r.warnings.length ? h('details', { class: 'advanced' }, h('summary', null, `${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''}`), ...r.warnings.map((w) => h('div', { class: 'hint' }, w))) : null,
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Import', kind: 'primary', onClick: () => void (go = true) }],
      onClose: () => resolve(go),
    });
  });
  if (!ok || (r.shared.length && !(await replaceShared(c, r.shared)))) return;
  const base = target.value.trim().replace(/[<>:"\\|?*]/g, '-').replace(/^\/+|\/+$/g, '');
  const written: string[] = [];
  for (const req of r.requests) {
    let path = join(base, req.path);
    for (let n = 2; collections.request(group.id, path); n++) path = path.replace(/( \(\d+\))?\.request\.json$/i, ` (${n})${REQUEST_EXT}`);
    await api.collectionWrite(c.folder, path, 'request', serializeRequest(req.doc));
    written.push(path);
  }
  if (r.shared.length) {
    const current = c.dotenv.find((f) => f.path === '.env')?.text ?? '';
    await api.collectionWrite(c.folder, '.env', 'rootFile', setDotenv(current, r.shared));
  }
  if (r.personal.length) await collections.setPersonal(group, r.personal, '', true);
  await collections.reload(group.id);
  void gitSync.changed(group.id, [...written, ...(r.shared.length ? ['.env'] : [])]);
  toast(`Imported ${written.length} request${written.length === 1 ? '' : 's'} from "${r.name}"`);
}

/** Postman globals: shared values to `.env` (every environment), secret ones to `.env.local`. */
async function importGlobalsInto(group: Group, raw: unknown): Promise<void> {
  const g = importGlobals(raw);
  const c = collections.get(group.id)!;
  if (!g.shared.length && !g.personal.length) return toast('The globals export has no variables.');
  if (!(await replaceShared(c, g.shared))) return;
  if (g.shared.length) {
    await api.collectionWrite(c.folder, '.env', 'rootFile', setDotenv(c.dotenv.find((f) => f.path === '.env')?.text ?? '', g.shared));
  }
  if (g.personal.length) await collections.setPersonal(group, g.personal, '', true);
  await collections.reload(group.id);
  if (g.shared.length) gitSync.changed(group.id, ['.env']);
  toast(
    `Imported ${g.shared.length + g.personal.length} global${g.shared.length + g.personal.length === 1 ? '' : 's'}: ${g.shared.length} to .env${g.personal.length ? `, ${g.personal.length} secret to .env.local` : ''}`,
  );
}

async function importEnvironmentInto(group: Group, raw: unknown): Promise<void> {
  const e = importEnvironment(raw);
  const c = collections.get(group.id)!;
  if (c.environments.has(e.file) && !(await confirmDialog(`Replace environment "${e.file}"?`, `environments/${e.file}.json already exists.`, 'Replace', true))) return;
  await api.collectionWrite(c.folder, `environments/${e.file}.json`, 'environment', serializeEnvironment(e.doc));
  if (e.personal.length) await collections.setPersonal(group, e.personal, e.file, true);
  await collections.reload(group.id);
  void gitSync.changed(group.id, [`environments/${e.file}.json`]);
  toast(`Imported environment "${e.name}"${e.personal.length ? ` (secrets in ${localEnvFile(e.file)})` : ''}${e.doc.protected ? ', marked protected' : ''}`);
}

export async function createEnvironment(group: Group): Promise<void> {
  const c = collections.get(group.id);
  const name = await promptDialog('New environment', 'Name (e.g. dev, staging, prod)', '');
  if (!c || !name?.trim()) return;
  const file = environmentFileName(name);
  if (c.environments.has(file)) return toast(`Environment "${file}" already exists`, 'error');
  const first = c.environments.values().next().value;
  // Same variable names as an existing environment, so the values are easy to fill in.
  const variables = Object.fromEntries(Object.keys(first?.variables ?? { baseUrl: '' }).map((k) => [k, '']));
  await api.collectionWrite(c.folder, `environments/${file}.json`, 'environment', serializeEnvironment({ variables, protected: /prod/i.test(file), color: '' }));
  store.update((cfg) => {
    const g = cfg.groups.find((x) => x.id === group.id);
    if (g) g.env = file;
  });
  await collections.reload(group.id);
  void gitSync.changed(group.id, [`environments/${file}.json`]);
}

export async function toggleProtected(group: Group, env: string): Promise<void> {
  const c = collections.get(group.id);
  const doc = c?.environments.get(env);
  if (!c || !doc) return;
  const text = serializeEnvironment({ ...doc, protected: !doc.protected });
  await api.collectionWrite(c.folder, `environments/${env}.json`, 'environment', text).catch((e) => toast(String(e), 'error'));
  await collections.reload(group.id);
  void gitSync.changed(group.id, [`environments/${env}.json`]);
}

/** The environment choices of a group, for its pill, the status bar and its menu. */
export function environmentEntries(group: Group): MenuEntry[] {
  const c = collections.get(group.id);
  const current = collections.env(group);
  const envs = [...(c?.environments.entries() ?? [])];
  const choose = (name: string) =>
    store.update((cfg) => {
      const g = cfg.groups.find((x) => x.id === group.id);
      if (g) g.env = name;
    });
  return [
    ...envs.map(([name, doc]): MenuEntry => ({ label: `${name === current ? '● ' : ''}${name}${doc.protected ? ' (protected)' : ''}`, action: () => choose(name) })),
    ...(envs.length ? (['separator'] as MenuEntry[]) : []),
    { label: 'Edit variables…', icon: 'edit', disabled: !c, action: () => editVariables(group) },
    { label: 'New environment…', icon: 'plus', action: () => void createEnvironment(group) },
    { label: current ? `Protect "${current}"` : 'Protect', disabled: !current, action: () => void toggleProtected(group, current) },
    { label: 'Open environments folder', icon: 'openExternal', disabled: !c, action: () => c && void api.openDir(`${c.folder}\\environments`).catch(() => api.openDir(c.folder)) },
  ];
}

/** Links a group to a folder of requests. */
export async function linkFolder(group: Group, dir: string): Promise<void> {
  store.update((cfg) => {
    const g = cfg.groups.find((x) => x.id === group.id);
    if (g) {
      g.folder = dir;
      g.collapsed = false;
    }
  });
}
