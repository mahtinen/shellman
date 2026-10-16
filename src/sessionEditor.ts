import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api } from './api';
import { baseName, formatEnv, parseEnv, uid } from './config';
import { dialog, promptDialog } from './dialogs';
import { h } from './dom';
import type { MenuEntry } from './menu';
import { store } from './store';
import { SESSION_COLORS } from './themes';
import type { SavedSession } from './types';

export const COMMAND_SUGGESTIONS = [
  'claude',
  'claude --continue',
  'claude --resume',
  'claude --dangerously-skip-permissions',
  'npm run dev',
  'npm test -- --watch',
  'git status',
  'code .',
];

export async function pickDirectory(current: string): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false, defaultPath: current || store.defaultCwd() });
  return typeof picked === 'string' ? picked : null;
}

export function shellOptions(selected: string): HTMLSelectElement {
  const def = store.resolveShell('');
  const select = h(
    'select',
    { class: 'input' },
    h('option', { value: '' }, `Default${def ? ` (${def.name})` : ''}`),
    ...store.shells.map((s) => h('option', { value: s.id }, s.name)),
  );
  select.value = store.shells.some((s) => s.id === selected) ? selected : '';
  return select;
}

/** One menu entry per installed shell; `current` is shown disabled. */
export function shellEntries(run: (shellId: string) => void, current?: string, prefix = ''): MenuEntry[] {
  return store.shells.map((s) => ({
    label: `${prefix}${s.name}${s.id === current ? ' (current)' : ''}`,
    icon: 'terminal',
    disabled: s.id === current,
    action: () => run(s.id),
  }));
}

/**
 * Create or edit a saved session. Resolves with the saved session, or null
 * when cancelled. `openAfter` is true when "Save & open" was chosen.
 */
export function editSession(
  initial: Partial<SavedSession> & { id?: string },
  isNew: boolean,
): Promise<{ session: SavedSession; openAfter: boolean } | null> {
  return new Promise((resolve) => {
    let result: { session: SavedSession; openAfter: boolean } | null = null;

    const name = h('input', { class: 'input', value: initial.name ?? '', placeholder: 'e.g. My API', spellcheck: false });
    const cwd = h('input', { class: 'input mono', value: initial.cwd || store.defaultCwd(), placeholder: 'C:\\Projects\\my-project', spellcheck: false });
    const command = h('input', { class: 'input mono', value: initial.command ?? '', placeholder: 'Optional, e.g. claude', spellcheck: false, list: 'shellman-cmds' });
    const datalist = h('datalist', { id: 'shellman-cmds' }, ...COMMAND_SUGGESTIONS.map((c) => h('option', { value: c })));
    const shell = shellOptions(initial.shellId ?? '');
    const env = h('textarea', { class: 'input mono', rows: 3, placeholder: 'KEY=value (one per line)', spellcheck: false });
    env.value = formatEnv(initial.env ?? {});
    const error = h('div', { class: 'field-error' });

    const NEW_GROUP = '__new__';
    const group = h('select', { class: 'input' });
    const fillGroups = (selected: string | null) => {
      group.replaceChildren(
        h('option', { value: '' }, '(No group)'),
        ...store.config.groups.map((g) => h('option', { value: g.id }, g.name)),
        h('option', { value: NEW_GROUP }, 'New group…'),
      );
      group.value = selected ?? '';
    };
    fillGroups(initial.groupId ?? null);
    let lastGroup = group.value;
    group.addEventListener('change', async () => {
      if (group.value !== NEW_GROUP) {
        lastGroup = group.value;
        return;
      }
      const n = await promptDialog('New group', 'Group name');
      if (n?.trim()) {
        const id = uid('g-');
        store.update((c) => c.groups.push({ id, name: n.trim(), collapsed: false }));
        fillGroups(id);
        lastGroup = id;
      } else group.value = lastGroup;
    });

    let color = initial.color ?? '';
    const swatches = h('div', { class: 'swatches' });
    const renderSwatches = () =>
      swatches.replaceChildren(
        ...SESSION_COLORS.map((c) =>
          h('button', {
            class: `swatch${c === color ? ' selected' : ''}${c ? '' : ' none'}`,
            style: c ? `background:${c}` : undefined,
            title: c || 'No color',
            type: 'button',
            onclick: () => {
              color = c;
              renderSwatches();
            },
          }),
        ),
      );
    renderSwatches();

    const browse = h('button', { class: 'btn', type: 'button' }, 'Browse…');
    browse.addEventListener('click', async () => {
      const dir = await pickDirectory(cwd.value);
      if (!dir) return;
      cwd.value = dir;
      if (!name.value.trim()) name.value = baseName(dir);
    });

    const validate = async (): Promise<SavedSession | null> => {
      error.textContent = '';
      const dir = cwd.value.trim().replace(/^"(.*)"$/, '$1');
      if (!dir) {
        error.textContent = 'Choose a directory.';
        cwd.focus();
        return null;
      }
      if (!(await api.dirExists(dir))) {
        error.textContent = `Directory not found: ${dir}`;
        cwd.focus();
        return null;
      }
      return {
        id: initial.id ?? uid('s-'),
        name: name.value.trim() || baseName(dir),
        groupId: group.value && group.value !== NEW_GROUP ? group.value : null,
        cwd: dir,
        command: command.value.trim(),
        shellId: shell.value,
        color,
        env: parseEnv(env.value),
        collapsed: initial.collapsed ?? false,
      };
    };

    const save = async (openAfter: boolean) => {
      const s = await validate();
      if (!s) return false;
      result = { session: s, openAfter };
      return true;
    };

    const advanced = h(
      'details',
      { class: 'advanced', open: Object.keys(initial.env ?? {}).length > 0 },
      h('summary', null, 'Environment variables'),
      h('label', { class: 'field' }, env),
    );

    dialog({
      title: isNew ? 'New session' : 'Edit session',
      width: 520,
      body: [
        h('label', { class: 'field' }, h('span', null, 'Name'), name),
        h('label', { class: 'field' }, h('span', null, 'Directory'), h('div', { class: 'row' }, cwd, browse)),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Startup command'),
          command,
          datalist,
          h('small', { class: 'hint' }, 'Runs when the terminal opens; you get the shell back when it exits.'),
        ),
        h('div', { class: 'row two' }, h('label', { class: 'field' }, h('span', null, 'Shell'), shell), h('label', { class: 'field' }, h('span', null, 'Group'), group)),
        h('div', { class: 'field' }, h('span', null, 'Color'), swatches),
        advanced,
        error,
      ],
      buttons: isNew
        ? [{ label: 'Cancel' }, { label: 'Save', onClick: () => save(false) }, { label: 'Save & open', kind: 'primary', onClick: () => save(true) }]
        : [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: () => save(false) }],
      focus: initial.cwd ? name : cwd,
      onClose: () => resolve(result),
    });
  });
}
