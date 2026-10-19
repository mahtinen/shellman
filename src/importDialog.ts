import { api } from './api';
import { groupOptions, newGroup } from './config';
import { connectionLabel } from './connection';
import { dialog, toast } from './dialogs';
import { h } from './dom';
import { importInto, markDuplicates, sessionCount, type FolderMode, type ImportCandidate } from './importers';
import { pickDirectory } from './sessionEditor';
import { store } from './store';
import { xshellCandidates } from './xshell';

/** A program whose saved sessions can be imported. */
interface ImportSource {
  name: string;
  /** Label of the location field. */
  locationLabel: string;
  /** Shown when `find` comes back empty. */
  notFound: string;
  /** Where the program keeps its sessions, if it has saved any. */
  find(): Promise<string | null>;
  browse(current: string): Promise<string | null>;
  read(location: string): Promise<ImportCandidate[]>;
}

const SOURCES: ImportSource[] = [
  {
    name: 'XShell',
    locationLabel: 'XShell sessions folder',
    notFound: "XShell's sessions folder wasn't found in Documents. Choose the folder with its .xsh files.",
    find: () => api.xshellDir(),
    browse: (current) => pickDirectory(current || store.sys.homeDir),
    read: async (dir) => xshellCandidates(await api.xshellSessions(dir)),
  },
];

const NEW_GROUP = '__new__';

/** Imports saved SSH and Telnet sessions from another program into an existing group or a new one. */
export function importSessions(groupId: string | null = null): void {
  const source = h('select', { class: 'input' }, ...SOURCES.map((s, i) => h('option', { value: String(i) }, s.name)));
  const location = h('input', { class: 'input mono', spellcheck: false });
  const browse = h('button', { class: 'btn', type: 'button' }, 'Browse…');
  const locationLabel = h('span', null, '');
  const status = h('small', { class: 'hint import-status' });
  const list = h('div', { class: 'import-list', hidden: true });

  const group = h(
    'select',
    { class: 'input' },
    h('option', { value: NEW_GROUP }, 'New group'),
    ...groupOptions(store.config.groups).map((g) => h('option', { value: g.id }, g.label)),
  );
  group.value = groupId && store.config.groups.some((g) => g.id === groupId) ? groupId : NEW_GROUP;
  const groupName = h('input', { class: 'input', spellcheck: false });
  const groupNameField = h('label', { class: 'field' }, h('span', null, 'New group name'), groupName);
  const showGroup = () => (groupNameField.hidden = group.value !== NEW_GROUP);
  group.addEventListener('change', showGroup);

  const folderMode = h(
    'select',
    { class: 'input' },
    h('option', { value: 'subgroups' }, 'As subgroups (Prod › Web › web1)'),
    h('option', { value: 'names' }, 'In the session names (Prod / Web / web1)'),
  );
  const folderNamesEl = h('label', { class: 'field' }, h('span', null, 'Folders'), folderMode);
  const error = h('div', { class: 'field-error' });

  let candidates: ImportCandidate[] = [];
  const chosen = new Set<number>();
  /** Keeps the checkboxes in step with `chosen`. */
  let sync = () => {};
  /** The location `candidates` are (being) read from, and that read. */
  let loaded = '';
  let reading: Promise<void> = Promise.resolve();
  let loading = 0;
  const current = () => SOURCES[Number(source.value)];

  const renderList = () => {
    const importable = candidates.flatMap((c, i) => (c.skip ? [] : [i]));
    const all = h('input', { type: 'checkbox' });
    const count = h('span', { class: 'import-count' });
    const rows: HTMLElement[] = [h('label', { class: 'import-all' }, all, h('span', null, 'All sessions'), count)];
    const folders: { box: HTMLInputElement; members: number[] }[] = [];
    const boxes: { box: HTMLInputElement; i: number }[] = [];
    const toggle = (members: number[], on: boolean) => {
      for (const i of members) on ? chosen.add(i) : chosen.delete(i);
      sync();
    };
    let folderKey = '';
    candidates.forEach((c, i) => {
      const key = c.folder.join(' / ');
      if (key && key !== folderKey) {
        const members = candidates.flatMap((x, j) => (!x.skip && x.folder.join(' / ') === key ? [j] : []));
        const box = h('input', { type: 'checkbox', disabled: !members.length });
        box.addEventListener('change', () => toggle(members, box.checked));
        folders.push({ box, members });
        rows.push(h('label', { class: 'import-folder' }, box, h('span', null, key)));
      }
      folderKey = key;
      const box = h('input', { type: 'checkbox', disabled: !!c.skip });
      box.addEventListener('change', () => toggle([i], box.checked));
      if (!c.skip) boxes.push({ box, i });
      rows.push(
        h(
          'label',
          { class: `import-row${key ? ' in-folder' : ''}${c.skip ? ' skipped' : ''}` },
          box,
          h('span', { class: 'import-name' }, c.name),
          h('span', { class: 'import-detail' }, c.skip || (c.connection ? connectionLabel(c.connection) : '')),
        ),
      );
    });
    all.disabled = !importable.length;
    all.addEventListener('change', () => toggle(importable, all.checked));
    const mark = (box: HTMLInputElement, members: number[]) => {
      const n = members.filter((i) => chosen.has(i)).length;
      box.checked = !!members.length && n === members.length;
      box.indeterminate = n > 0 && n < members.length;
    };
    sync = () => {
      for (const b of boxes) b.box.checked = chosen.has(b.i);
      for (const f of folders) mark(f.box, f.members);
      mark(all, importable);
      const skipped = candidates.length - importable.length;
      count.textContent = `${chosen.size} of ${importable.length} chosen${skipped ? `, ${skipped} can't be imported` : ''}`;
    };
    list.replaceChildren(...rows);
    sync();
  };

  const read = async (dir: string, n: number) => {
    try {
      const got = markDuplicates(await current().read(dir), store.config.sessions);
      if (n !== loading) return;
      candidates = got;
      got.forEach((c, i) => !c.skip && chosen.add(i));
      status.textContent = got.length ? '' : 'No sessions in this folder.';
      list.hidden = !got.length;
      folderNamesEl.hidden = !got.some((c) => c.folder.length);
      renderList();
    } catch (e) {
      if (n === loading) status.textContent = String(e);
    }
  };
  const load = () => {
    const dir = location.value.trim();
    const n = ++loading;
    candidates = [];
    chosen.clear();
    loaded = dir;
    error.textContent = '';
    list.hidden = folderNamesEl.hidden = true;
    status.textContent = dir ? 'Reading…' : current().notFound;
    reading = dir ? read(dir, n) : Promise.resolve();
    return reading;
  };
  const useSource = async () => {
    const s = current();
    locationLabel.textContent = s.locationLabel;
    groupName.value = s.name;
    location.value = '';
    candidates = [];
    chosen.clear();
    list.hidden = folderNamesEl.hidden = true;
    status.textContent = `Looking for ${s.name} sessions…`;
    const n = ++loading;
    const found = await s.find().catch(() => null);
    // Another source was chosen, or a location typed, in the meantime.
    if (n !== loading || location.value.trim()) return;
    location.value = found ?? '';
    await load();
  };

  source.addEventListener('change', () => void useSource());
  location.addEventListener('change', () => void load());
  browse.addEventListener('click', async () => {
    const dir = await current().browse(location.value.trim());
    if (!dir) return;
    location.value = dir;
    void load();
  });

  const finish = async (): Promise<boolean> => {
    // A typed location is only read when the field loses focus; Enter or Import can come first.
    await (location.value.trim() !== loaded ? load() : reading);
    error.textContent = '';
    const isNew = group.value === NEW_GROUP;
    const name = groupName.value.trim();
    if (isNew && !name) {
      error.textContent = 'Enter a name for the new group.';
      groupName.focus();
      return false;
    }
    const created = isNew ? newGroup(name) : null;
    const target = created?.id ?? group.value;
    const groups = created ? [...store.config.groups, created] : store.config.groups;
    const { groups: subgroups, sessions } = importInto(candidates.filter((_, i) => chosen.has(i)), groups, target, folderMode.value as FolderMode);
    if (!sessions.length) {
      error.textContent = candidates.some((c) => !c.skip) ? 'Choose the sessions to import.' : 'There is nothing here to import.';
      return false;
    }
    store.update((c) => {
      if (created) c.groups.push(created);
      c.groups.push(...subgroups);
      const g = c.groups.find((x) => x.id === target);
      if (g) g.collapsed = false;
      c.sessions.push(...sessions);
    });
    toast(`Imported ${sessionCount(sessions.length)} into "${store.config.groups.find((g) => g.id === target)?.name ?? name}".`);
    return true;
  };

  dialog({
    title: 'Import sessions',
    width: 600,
    body: [
      h('label', { class: 'field' }, h('span', null, 'Import from'), source),
      h('label', { class: 'field' }, locationLabel, h('div', { class: 'row' }, location, browse), status),
      list,
      h('div', { class: 'row two' }, h('label', { class: 'field' }, h('span', null, 'Import into'), group), groupNameField),
      folderNamesEl,
      h(
        'p',
        { class: 'hint' },
        "SSH and Telnet sessions are imported with their host, port and user. Saved passwords and keys aren't: ssh logs in with your SSH agent or ~/.ssh keys, and asks for a password if needed.",
      ),
      error,
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Import', kind: 'primary', onClick: finish }],
    focus: source,
  });
  showGroup();
  void useSource();
}
