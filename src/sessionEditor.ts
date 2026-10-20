import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, type AgentKey } from './api';
import { baseName, formatEnv, groupColor, groupOptions, newGroup, parseEnv, uid } from './config';
import { connectionError, connectionTarget, DEFAULT_SSH_ARGS, keyLabel, newSshConnection, parseDestination, parsePort, sameKey } from './connection';
import { dialog, promptDialog } from './dialogs';
import { h } from './dom';
import type { MenuEntry } from './menu';
import { store } from './store';
import { SESSION_COLORS } from './themes';
import type { Connection, ConnectionKind, Group, SavedSession } from './types';

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
 * Colour swatches. The first one means "no colour of its own": it shows the colour inherited from
 * the group (`inherited`, re-read on refresh), striped, and says so with `inheritTitle`.
 */
function colorPicker(initial: string, inherited: () => string, inheritTitle: string): { el: HTMLElement; value: () => string; refresh: () => void } {
  let color = initial;
  const el = h('div', { class: 'swatches' });
  const refresh = () => {
    const from = inherited();
    el.replaceChildren(
      ...SESSION_COLORS.map((c) =>
        h('button', {
          class: `swatch${c === color ? ' selected' : ''}${c ? '' : ' none'}`,
          style: c ? `background:${c}` : from ? `--inherited:${from}` : undefined,
          title: c || (from ? inheritTitle : 'No color'),
          type: 'button',
          onclick: () => {
            color = c;
            refresh();
          },
        }),
      ),
    );
  };
  refresh();
  return { el, value: () => color, refresh };
}

/** The group dialog: name and colour. Resolves with them, or null when cancelled. */
/** What the group editor edits. */
export type GroupFields = Pick<Group, 'name' | 'color' | 'folder' | 'sync' | 'syncPush' | 'syncCheck' | 'syncDelay' | 'commitTemplate'>;

export function editGroup(title: string, initial: Partial<GroupFields> & { name: string; color: string; parentId: string | null }): Promise<GroupFields | null> {
  return new Promise((resolve) => {
    let result: GroupFields | null = null;
    const name = h('input', { class: 'input', value: initial.name, placeholder: 'Group name', spellcheck: false });
    const folder = h('input', { class: 'input', value: initial.folder ?? '', placeholder: 'None', spellcheck: false });
    const browse = h('button', {
      class: 'btn',
      onclick: async () => {
        const dir = await pickDirectory(folder.value || store.defaultCwd());
        if (dir) folder.value = dir;
        showSync();
      },
    }, 'Browse…');
    const colors = colorPicker(initial.color, () => groupColor(store.config.groups, initial.parentId), 'Same as the group it is in');
    const error = h('div', { class: 'field-error' });

    // Git sync of the folder.
    const select = <T extends string>(value: T, options: [T, string][], field: string) => {
      const el = h('select', { class: 'input', dataset: { field } }, ...options.map(([v, label]) => h('option', { value: v }, label)));
      el.value = value;
      return el;
    };
    const sync = select(initial.sync ?? 'manual', [
      ['off', 'Off'],
      ['manual', 'With the Sync button'],
      ['auto', 'Automatically'],
    ], 'sync');
    const push = select(initial.syncPush ?? 'push', [
      ['push', 'Commit and push each save'],
      ['commit', 'Commit saves, push with Sync'],
    ], 'push');
    const check = select(String(initial.syncCheck ?? 180), [
      ['60', 'Every minute'],
      ['180', 'Every 3 minutes'],
      ['300', 'Every 5 minutes'],
      ['600', 'Every 10 minutes'],
      ['-1', 'Only when Shellman gets focus'],
      ['0', 'Never (only with Sync)'],
    ], 'check');
    const delay = select(String(initial.syncDelay ?? 60), [
      ['10', '10 seconds'],
      ['60', '1 minute'],
      ['300', '5 minutes'],
    ], 'delay');
    // Automatic sync is meant for a repository (or branch) of requests only.
    const repoNote = h('small', { class: 'hint err-text' });
    let noteFor = '';
    const checkRepo = () => {
      const dir = folder.value.trim();
      if (!dir || dir === noteFor) return;
      noteFor = dir;
      repoNote.textContent = '';
      void api.gitStatus(dir).then(
        (st) => {
          if (folder.value.trim() !== dir) return;
          repoNote.textContent = !st
            ? "This folder isn't in a git repository, so it can't sync."
            : st.sharedRepo
              ? 'This repository has other work in it. Automatic sync pauses whenever it would push or set aside that work; the Sync button may suit better.'
              : '';
        },
        () => undefined,
      );
    };
    const template = h('input', { class: 'input', value: initial.commitTemplate ?? 'Update {request}', spellcheck: false });
    const pushField = h('div', { class: 'row two' }, h('label', { class: 'field' }, h('span', null, 'Saving'), push), h('label', { class: 'field' }, h('span', null, 'Group saves made within'), delay));
    const syncBox = h(
      'details',
      { class: 'advanced', open: !!initial.folder },
      h('summary', null, 'Git sync'),
      h('label', { class: 'field' }, h('span', null, 'Sync the folder'), sync),
      pushField,
      h('div', { class: 'row two' }, h('label', { class: 'field' }, h('span', null, "Look for teammates' changes"), check), h('label', { class: 'field' }, h('span', null, 'Commit message'), template)),
      h(
        'small',
        { class: 'hint' },
        "Uses your own git and sign-in. Only request files are committed, never your secret .env.local files. Automatically: saves go up together as one commit, and teammates' changes come in while Shellman is in front. {request} in the message becomes the request names. Best for a repository of requests without CI or required pull requests.",
      ),
      repoNote,
    );
    const showSync = () => {
      syncBox.hidden = !folder.value.trim();
      pushField.hidden = sync.value !== 'auto';
      checkRepo();
    };
    folder.addEventListener('input', showSync);
    sync.addEventListener('change', showSync);
    showSync();

    dialog({
      title,
      width: 520,
      body: [
        h('label', { class: 'field' }, h('span', null, 'Name'), name),
        h('div', { class: 'field' }, h('span', null, 'Color'), colors.el, h('small', { class: 'hint' }, 'Sessions in the group and its subgroups get this color unless they have their own.')),
        h(
          'div',
          { class: 'field' },
          h('span', null, 'Requests folder'),
          h('div', { class: 'row' }, folder, browse),
          h('small', { class: 'hint' }, 'A folder of API requests, often a git repository the team shares. Its requests show in the group. Leave empty for sessions only.'),
        ),
        syncBox,
        error,
      ],
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Save',
          kind: 'primary',
          onClick: () => {
            if (!name.value.trim()) {
              error.textContent = 'Give the group a name.';
              name.focus();
              return false;
            }
            result = {
              name: name.value.trim(),
              color: colors.value(),
              folder: folder.value.trim(),
              sync: sync.value as Group['sync'],
              syncPush: push.value as Group['syncPush'],
              syncCheck: Number(check.value),
              syncDelay: Number(delay.value),
              commitTemplate: template.value.trim() || 'Update {request}',
            };
          },
        },
      ],
      focus: name,
      onClose: () => resolve(result),
    });
  });
}

export interface EditResult {
  session: SavedSession;
  /** Add it to the sidebar ("new" only when "Remember" was ticked). */
  save: boolean;
}

type SessionType = 'local' | ConnectionKind;

/**
 * - new: open a terminal or connection; it is only saved when "Remember" is ticked (`remember`
 *   ticks it to start with).
 * - save: save an open terminal as a session.
 * - edit: change a saved session.
 */
export type EditMode = 'new' | 'save' | 'edit';

/**
 * The session dialog: a local folder, or an SSH/Telnet host. Resolves with the result, or null
 * when cancelled.
 */
export function editSession(
  initial: Partial<SavedSession> & { id?: string },
  mode: EditMode,
  opts: { remember?: boolean } = {},
): Promise<EditResult | null> {
  return new Promise((resolve) => {
    let result: EditResult | null = null;
    const conn = initial.connection ?? newSshConnection();

    const name = h('input', { class: 'input', value: initial.name ?? '', placeholder: 'e.g. My API', spellcheck: false });
    const cwd = h('input', { class: 'input mono', value: initial.cwd || store.defaultCwd(), placeholder: 'C:\\Projects\\my-project', spellcheck: false });
    const command = h('input', { class: 'input mono', value: initial.command ?? '', placeholder: 'Optional, e.g. claude', spellcheck: false, list: 'shellman-cmds' });
    const datalist = h('datalist', { id: 'shellman-cmds' }, ...COMMAND_SUGGESTIONS.map((c) => h('option', { value: c })));
    const shell = shellOptions(initial.shellId ?? '');
    const env = h('textarea', { class: 'input mono', rows: 3, placeholder: 'KEY=value (one per line)', spellcheck: false });
    env.value = formatEnv(initial.env ?? {});
    const error = h('div', { class: 'field-error' });

    // Connection fields. They come after the local ones so the inputs keep their order.
    const host = h('input', { class: 'input mono', value: conn.host, placeholder: 'host.example.com or 10.0.0.5', spellcheck: false });
    const port = h('input', { class: 'input mono', value: conn.port === null ? '' : String(conn.port), placeholder: '22', inputMode: 'numeric', spellcheck: false });
    const user = h('input', { class: 'input mono', value: conn.user, placeholder: 'Asked when connecting', spellcheck: false });
    const identity = h('input', { class: 'input mono', value: conn.identityFile, placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519', spellcheck: false });
    const jump = h('input', { class: 'input mono', value: conn.jumpHost, placeholder: 'Optional, e.g. user@bastion', spellcheck: false });
    const legacy = h('input', { type: 'checkbox', checked: conn.legacyAlgorithms });
    const extra = h('input', { class: 'input mono', value: conn.extraArgs, placeholder: 'Optional, e.g. -A', spellcheck: false });
    // "user@host:port" typed or pasted into Host is split into the fields.
    host.addEventListener('change', () => {
      const d = parseDestination(host.value.trim());
      if (!d || (!d.user && d.port === null)) return;
      host.value = d.host;
      if (d.user && type.value === 'ssh') user.value = d.user;
      if (d.port !== null) port.value = String(d.port);
    });

    const type = h(
      'select',
      { class: 'input' },
      h('option', { value: 'local' }, 'Local terminal'),
      h('option', { value: 'ssh' }, 'SSH'),
      h('option', { value: 'telnet' }, 'Telnet'),
    );
    type.value = initial.connection ? initial.connection.kind : 'local';

    const NEW_GROUP = '__new__';
    const group = h('select', { class: 'input' });
    const fillGroups = (selected: string | null) => {
      group.replaceChildren(
        h('option', { value: '' }, '(No group)'),
        ...groupOptions(store.config.groups).map((g) => h('option', { value: g.id }, g.label)),
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
        const g = newGroup(n.trim());
        const id = g.id;
        store.update((c) => c.groups.push(g));
        fillGroups(id);
        lastGroup = id;
      } else group.value = lastGroup;
    });

    const selectedGroup = () => (group.value && group.value !== NEW_GROUP ? group.value : null);
    const colors = colorPicker(initial.color ?? '', () => groupColor(store.config.groups, selectedGroup()), 'Same as its group');
    group.addEventListener('change', () => colors.refresh());

    const browse = h('button', { class: 'btn', type: 'button' }, 'Browse…');
    browse.addEventListener('click', async () => {
      const dir = await pickDirectory(cwd.value);
      if (!dir) return;
      cwd.value = dir;
      if (!name.value.trim()) name.value = baseName(dir);
    });
    const browseKey = h('button', { class: 'btn', type: 'button' }, 'Browse…');
    browseKey.addEventListener('click', async () => {
      const picked = await openDialog({ multiple: false, directory: false, defaultPath: identity.value || `${store.sys.homeDir}\\.ssh` });
      if (typeof picked === 'string') identity.value = picked;
    });

    // Which key to offer. Servers give up after MaxAuthTries (usually 6) keys, so with many keys
    // in the agent (1Password) the session should name its key.
    let agentKeys: AgentKey[] = [];
    let agentRunning = true;
    let agentError = '';
    let keysLoaded = false;
    let keysKnown = false;
    let chosenKey = conn.identityKey;
    let useFile = !conn.identityKey && !!conn.identityFile;
    let usePassword = conn.passwordAuth;
    const keySelect = h('select', { class: 'input' });
    const keyHint = h('small', { class: 'hint' });
    const keyFileRow = h('div', { class: 'row' }, identity, browseKey);
    const renderKeys = () => {
      const idx = agentKeys.findIndex((k) => sameKey(k.publicKey, chosenKey));
      const savedMissing = !!chosenKey && idx < 0;
      keySelect.replaceChildren(
        h('option', { value: '' }, 'Default: SSH agent keys and ~/.ssh key files'),
        ...agentKeys.map((k, i) => h('option', { value: `a${i}` }, keyLabel(k.publicKey))),
        ...(savedMissing ? [h('option', { value: 'saved' }, `${keyLabel(chosenKey)}${keysKnown && !agentError ? ', not in the agent now' : ''}`)] : []),
        h('option', { value: 'file' }, 'Key file on disk…'),
        h('option', { value: 'password' }, 'Password'),
      );
      keySelect.value = usePassword ? 'password' : useFile ? 'file' : chosenKey ? (idx >= 0 ? `a${idx}` : 'saved') : '';
      keyFileRow.hidden = !useFile || usePassword;
      keyHint.textContent = usePassword
        ? "ssh asks for the password in the terminal; Shellman doesn't store it. No keys are offered, so the server doesn't give up before asking."
        : agentError
          ? `Could not list the SSH agent's keys: ${agentError}`
          : chosenKey
            ? 'Only this key is offered (IdentitiesOnly). Its private key stays in the agent.'
            : useFile
              ? 'Only this key is offered (IdentitiesOnly). A .pub file works too when the private key is in the agent.'
              : !agentRunning && keysKnown
                ? 'No SSH agent is running, so ssh tries your key files in ~/.ssh. To pick a key here, turn on the SSH agent in 1Password, or start the Windows "OpenSSH Authentication Agent" service and add keys with ssh-add.'
                : agentKeys.length > 5
                ? `The agent has ${agentKeys.length} keys. Servers usually stop after 6 tries ("Too many authentication failures"), so choose this host's key, or Password.`
                : '';
      keyHint.hidden = !keyHint.textContent;
    };
    keySelect.addEventListener('change', () => {
      const v = keySelect.value;
      usePassword = v === 'password';
      useFile = v === 'file';
      chosenKey = v.startsWith('a') ? agentKeys[Number(v.slice(1))].publicKey : v === 'saved' ? chosenKey : '';
      renderKeys();
      if (useFile) identity.focus();
    });
    const loadKeys = () => {
      if (keysLoaded) return;
      keysLoaded = true;
      api.sshAgentKeys(store.settings.sshPath).then(
        (r) => {
          agentKeys = r.keys;
          agentRunning = r.running;
          keysKnown = true;
          renderKeys();
        },
        (e) => {
          agentError = String(e);
          keysKnown = true;
          renderKeys();
        },
      );
    };
    renderKeys();

    const connection = (): Connection | null => {
      if (type.value === 'local') return null;
      const kind = type.value as ConnectionKind;
      const p = port.value.trim();
      const ssh = kind === 'ssh';
      return {
        kind,
        host: host.value.trim(),
        port: p ? (parsePort(p) ?? -1) : null,
        user: ssh ? user.value.trim() : '',
        identityFile: ssh && useFile && !usePassword ? identity.value.trim().replace(/^"(.*)"$/, '$1') : '',
        identityKey: ssh && !useFile && !usePassword ? chosenKey : '',
        passwordAuth: ssh && usePassword,
        legacyAlgorithms: ssh && legacy.checked,
        jumpHost: ssh ? jump.value.trim() : '',
        extraArgs: ssh ? extra.value.trim() : '',
      };
    };

    const validate = async (): Promise<SavedSession | null> => {
      error.textContent = '';
      const base = {
        id: initial.id ?? uid('s-'),
        groupId: selectedGroup(),
        color: colors.value(),
        env: parseEnv(env.value),
        collapsed: initial.collapsed ?? false,
      };
      const c = connection();
      if (c) {
        const problem = connectionError(c);
        if (problem) {
          error.textContent = problem;
          (/port/i.test(problem) ? port : /user/i.test(problem) ? user : /jump/i.test(problem) ? jump : /key file/i.test(problem) ? identity : /key/i.test(problem) ? keySelect : host).focus();
          return null;
        }
        return { ...base, name: name.value.trim() || connectionTarget(c), connection: c, cwd: '', command: '', shellId: '' };
      }
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
      return { ...base, name: name.value.trim() || baseName(dir), connection: null, cwd: dir, command: command.value.trim(), shellId: shell.value };
    };

    const finish = async (save: boolean) => {
      const s = await validate();
      if (!s) return false;
      result = { session: s, save };
      return true;
    };

    const advanced = h(
      'details',
      { class: 'advanced', open: Object.keys(initial.env ?? {}).length > 0 },
      h('summary', null, 'Environment variables'),
      h('label', { class: 'field' }, env),
    );
    const sshAdvanced = h(
      'details',
      { class: 'advanced', open: !!(conn.jumpHost || (conn.extraArgs && conn.extraArgs !== DEFAULT_SSH_ARGS) || conn.legacyAlgorithms) },
      h('summary', null, 'SSH options'),
      h(
        'label',
        { class: 'check' },
        legacy,
        h(
          'span',
          null,
          'Allow old algorithms',
          h('small', { class: 'hint' }, 'For old servers that only offer ssh-rsa (SHA-1), DSA or CBC ciphers ("Unable to negotiate"). Weaker, so only for this host.'),
        ),
      ),
      h('label', { class: 'field' }, h('span', null, 'Jump host'), jump),
      h('label', { class: 'field' }, h('span', null, 'More ssh options'), extra),
    );

    const userField = h('label', { class: 'field' }, h('span', null, 'User'), user);
    const keyField = h('div', { class: 'field' }, h('span', null, 'Log in with'), keySelect, keyFileRow, keyHint);
    const localFields = h(
      'div',
      { class: 'type-fields' },
      h('label', { class: 'field' }, h('span', null, 'Directory'), h('div', { class: 'row' }, cwd, browse)),
      h(
        'label',
        { class: 'field' },
        h('span', null, 'Startup command'),
        command,
        datalist,
        h('small', { class: 'hint' }, 'Runs when the terminal opens; you get the shell back when it exits.'),
      ),
      h('label', { class: 'field' }, h('span', null, 'Shell'), shell),
    );
    const connectionHint = h('small', { class: 'hint' });
    const connectionFields = h(
      'div',
      { class: 'type-fields' },
      h('div', { class: 'row host-port' }, h('label', { class: 'field' }, h('span', null, 'Host'), host), h('label', { class: 'field' }, h('span', null, 'Port'), port)),
      userField,
      keyField,
      connectionHint,
      sshAdvanced,
    );
    const showType = () => {
      const t = type.value as SessionType;
      localFields.hidden = t !== 'local';
      connectionFields.hidden = t === 'local';
      userField.hidden = keyField.hidden = sshAdvanced.hidden = t !== 'ssh';
      if (t === 'ssh') loadKeys();
      if (openBtn) openBtn.textContent = t === 'local' ? 'Open' : 'Connect';
      port.placeholder = t === 'telnet' ? '23' : '22';
      connectionHint.textContent =
        t === 'ssh'
          ? 'Runs Windows OpenSSH (ssh.exe): your keys, SSH agent or 1Password, and ~/.ssh/config work as in any terminal.'
          : 'Runs the Windows Telnet Client (telnet.exe). Telnet is not encrypted.';
    };
    let openBtn: HTMLElement | null = null;
    type.addEventListener('change', showType);
    showType();

    // A new terminal or connection is temporary unless "Remember" is ticked; group and colour only matter then.
    const isNew = mode === 'new';
    const groupField = h('label', { class: 'field' }, h('span', null, 'Group'), group);
    const colorField = h('div', { class: 'field' }, h('span', null, 'Color'), colors.el);
    const remember = h('input', { type: 'checkbox', checked: !!opts.remember });
    const rememberEl = h(
      'label',
      { class: 'check' },
      remember,
      h('span', null, 'Remember this session', h('small', { class: 'hint' }, 'Adds it to the sidebar. Otherwise it is gone when its tab closes (Ctrl+Shift+S saves it later).')),
    );
    const showRemember = () => {
      groupField.hidden = colorField.hidden = isNew && !remember.checked;
    };
    remember.addEventListener('change', showRemember);
    showRemember();
    if (isNew) name.placeholder = 'Optional';
    const d = dialog({
      title: mode === 'new' ? (initial.connection ? 'New connection' : 'New session') : mode === 'save' ? 'Save as session' : 'Edit session',
      width: 520,
      body: [
        h('label', { class: 'field' }, h('span', null, 'Name'), name),
        h('div', { class: 'row two' }, h('label', { class: 'field' }, h('span', null, 'Type'), type), groupField),
        localFields,
        connectionFields,
        colorField,
        advanced,
        isNew ? rememberEl : null,
        error,
      ],
      buttons: isNew
        ? [{ label: 'Cancel' }, { label: 'Open', kind: 'primary', onClick: () => finish(remember.checked) }]
        : [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: () => finish(true) }],
      focus: type.value !== 'local' ? host : initial.cwd ? name : cwd,
      onClose: () => resolve(result),
    });
    if (isNew) {
      openBtn = d.el.querySelector('.dialog-footer .btn.primary');
      showType();
    }
  });
}
