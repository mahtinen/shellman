import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, type AgentKey } from './api';
import { baseName, formatEnv, parseEnv, uid } from './config';
import { connectionError, connectionTarget, emptyConnection, keyLabel, parseDestination, parsePort, sameKey } from './connection';
import { dialog, promptDialog } from './dialogs';
import { h } from './dom';
import type { MenuEntry } from './menu';
import { store } from './store';
import { SESSION_COLORS } from './themes';
import type { Connection, ConnectionKind, SavedSession } from './types';

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
    const conn = initial.connection ?? emptyConnection('ssh');

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
    const extra = h('input', { class: 'input mono', value: conn.extraArgs, placeholder: 'Optional, e.g. -A -o ServerAliveInterval=30', spellcheck: false });
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
        groupId: group.value && group.value !== NEW_GROUP ? group.value : null,
        color,
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
      { class: 'advanced', open: !!(conn.jumpHost || conn.extraArgs || conn.legacyAlgorithms) },
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
    const colorField = h('div', { class: 'field' }, h('span', null, 'Color'), swatches);
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
