import { api } from './api';
import { DEFAULT_FONT, defaultSettings, guessShellKind, uid } from './config';
import { dialog } from './dialogs';
import { h } from './dom';
import { icons } from './icons';
import { ACTION_LABELS, BINDINGS, bindingLabel, type Action } from './keys';
import { pickDirectory, shellOptions } from './sessionEditor';
import { store } from './store';
import { THEMES } from './themes';
import type { Settings, ShellProfile, UpdateMode } from './types';
import { updater } from './updater';

function check(label: string, value: boolean, hint?: string): [HTMLElement, () => boolean] {
  const input = h('input', { type: 'checkbox', checked: value });
  const el = h('label', { class: 'check' }, input, h('span', null, label, hint ? h('small', { class: 'hint' }, hint) : null));
  return [el, () => input.checked];
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
}

export function openSettings(): void {
  const s = store.settings;

  const theme = h('select', { class: 'input' }, ...THEMES.map((t) => h('option', { value: t.id }, t.name)));
  theme.value = s.theme;
  const fontFamily = h('input', { class: 'input mono', value: s.fontFamily, spellcheck: false });
  const fontSize = h('input', { class: 'input', type: 'number', min: 6, max: 48, step: 1, value: String(s.fontSize) });
  const lineHeight = h('input', { class: 'input', type: 'number', min: 0.8, max: 2.5, step: 0.05, value: String(s.lineHeight) });
  const cursorStyle = h('select', { class: 'input' }, h('option', { value: 'block' }, 'Block'), h('option', { value: 'bar' }, 'Bar'), h('option', { value: 'underline' }, 'Underline'));
  cursorStyle.value = s.cursorStyle;
  const [cursorBlinkEl, cursorBlink] = check('Blinking cursor', s.cursorBlink);
  const [gpuEl, gpu] = check('GPU accelerated rendering', s.gpuAcceleration, 'WebGL renderer. Turn off if you see rendering glitches.');

  const defaultShell = shellOptions(s.defaultShellId);
  (defaultShell.options[0] as HTMLOptionElement).textContent = 'First available';
  const defaultCwd = h('input', { class: 'input mono', value: s.defaultCwd, placeholder: store.sys.homeDir, spellcheck: false });
  const browse = h('button', { class: 'btn', type: 'button' }, 'Browse…');
  browse.addEventListener('click', async () => {
    const d = await pickDirectory(defaultCwd.value);
    if (d) defaultCwd.value = d;
  });
  const scrollback = h('input', { class: 'input', type: 'number', min: 0, max: 1000000, step: 1000, value: String(s.scrollback) });
  const closeOnExit = h(
    'select',
    { class: 'input' },
    h('option', { value: 'graceful' }, 'When it exits successfully (code 0)'),
    h('option', { value: 'always' }, 'Always'),
    h('option', { value: 'never' }, 'Never (press Enter to restart)'),
  );
  closeOnExit.value = s.closeOnExit;
  const [shiftEnterEl, shiftEnter] = check('Shift+Enter inserts a newline', s.shiftEnterNewline, 'Sends ESC+Enter, which Claude Code and readline treat as a newline instead of submitting.');
  const [copySelEl, copySel] = check('Copy on select', s.copyOnSelect);
  const rightClick = h(
    'select',
    { class: 'input' },
    h('option', { value: 'paste' }, 'Paste'),
    h('option', { value: 'copyPaste' }, 'Copy selection, otherwise paste'),
    h('option', { value: 'menu' }, 'Show menu'),
  );
  rightClick.value = s.rightClick;
  const [integrationEl, integration] = check('Shell integration', s.shellIntegration, 'Shells report their working directory so "new terminal here" follows cd.');
  const [confirmEl, confirmClose] = check('Confirm before closing terminals with running programs', s.confirmClose);

  // Custom shells editor.
  let custom: ShellProfile[] = s.customShells.map((x) => ({ ...x, args: [...x.args] }));
  const customList = h('div', { class: 'custom-shells' });
  const renderCustom = () => {
    customList.replaceChildren(
      ...custom.map((sh, i) => {
        const nameI = h('input', { class: 'input small', value: sh.name, placeholder: 'Name', oninput: (e: Event) => (custom[i].name = (e.target as HTMLInputElement).value) });
        const pathI = h('input', {
          class: 'input small mono',
          value: sh.path,
          placeholder: 'C:\\path\\to\\shell.exe',
          oninput: (e: Event) => {
            custom[i].path = (e.target as HTMLInputElement).value;
            custom[i].kind = guessShellKind(custom[i].path);
          },
        });
        const argsI = h('input', {
          class: 'input small mono',
          value: sh.args.join(' '),
          placeholder: 'Arguments',
          oninput: (e: Event) => (custom[i].args = (e.target as HTMLInputElement).value.split(' ').filter(Boolean)),
        });
        return h(
          'div',
          { class: 'custom-shell' },
          nameI,
          pathI,
          argsI,
          h('button', {
            class: 'icon-btn',
            title: 'Remove',
            html: icons.trash,
            onclick: () => {
              custom.splice(i, 1);
              renderCustom();
            },
          }),
        );
      }),
      h('button', {
        class: 'btn small',
        type: 'button',
        onclick: () => {
          custom.push({ id: uid('shell-'), name: '', path: '', args: [], kind: 'other' });
          renderCustom();
        },
      }, '+ Add shell'),
    );
  };
  renderCustom();

  const detected = h(
    'div',
    { class: 'detected' },
    ...store.detectedShells.map((x) => h('div', null, h('b', null, x.name), ' ', h('code', null, x.path))),
  );

  const updates = h(
    'select',
    { class: 'input' },
    h('option', { value: 'auto' }, 'Download automatically, install on restart'),
    h('option', { value: 'notify' }, 'Tell me when a new version is out'),
    h('option', { value: 'off' }, "Don't check"),
  );
  updates.value = s.updates;
  const updateStatus = h('span', { class: 'hint update-status' });
  const updateBtn = h('button', { class: 'btn small', type: 'button' });
  const renderUpdate = () => {
    const st = updater.state;
    updateStatus.textContent =
      st.kind === 'checking'
        ? 'Checking…'
        : st.kind === 'current'
          ? `Shellman ${store.sys.version} is the latest version.`
          : st.kind === 'available'
            ? `Shellman ${st.version} is available.`
            : st.kind === 'downloading'
              ? `Downloading ${st.version}${st.percent === null ? '…' : ` (${st.percent}%)`}`
              : st.kind === 'ready'
                ? `Shellman ${st.version} is downloaded and will be installed on the next restart.`
                : st.kind === 'error'
                  ? st.message
                  : `You have Shellman ${store.sys.version}.`;
    updateStatus.classList.toggle('error', st.kind === 'error');
    const [label, run] =
      st.kind === 'available'
        ? ['Download', () => void updater.download()]
        : st.kind === 'ready'
          ? ['Restart now', () => window.dispatchEvent(new Event('shellman:restart-to-update'))]
          : ['Check now', () => void updater.check(true)];
    updateBtn.textContent = label;
    updateBtn.disabled = st.kind === 'checking' || st.kind === 'downloading';
    updateBtn.onclick = run;
  };
  renderUpdate();
  const offUpdate = updater.on(renderUpdate);

  const section = (title: string, ...children: (HTMLElement | null)[]) => h('section', { class: 'settings-section' }, h('h3', null, title), ...children);

  const configLink = h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void api.openDir(store.sys.configDir); } }, store.sys.configDir);

  dialog({
    title: 'Settings',
    width: 640,
    className: 'settings-dialog',
    onClose: () => offUpdate(),
    body: [
      section(
        'Appearance',
        h('div', { class: 'row two' }, field('Theme', theme), field('Cursor', cursorStyle)),
        field('Font family', fontFamily),
        h('div', { class: 'row two' }, field('Font size', fontSize, 'Ctrl+wheel to zoom'), field('Line height', lineHeight)),
        cursorBlinkEl,
        gpuEl,
      ),
      section(
        'Terminal',
        h('div', { class: 'row two' }, field('Default shell', defaultShell), field('Scrollback lines', scrollback)),
        field('Default directory', h('div', { class: 'row' }, defaultCwd, browse), 'Used for new terminals that are not opened from a session or an existing terminal.'),
        h(
          'div',
          { class: 'row two' },
          field('Close pane when the shell exits', closeOnExit),
          field('Right-click in terminal', rightClick, 'Shift+right-click always opens the menu.'),
        ),
        shiftEnterEl,
        copySelEl,
        integrationEl,
        confirmEl,
      ),
      section('Shells', h('small', { class: 'hint' }, 'Detected automatically:'), detected, h('small', { class: 'hint' }, 'Custom shells:'), customList),
      section(
        'Updates',
        field('New versions', updates, 'Updates come from GitHub Releases and are signed; only signed installers are accepted.'),
        h('div', { class: 'row update-row' }, updateStatus, updateBtn),
      ),
      section('About', h('p', { class: 'hint' }, `Shellman ${store.sys.version} · settings are stored in `, configLink)),
    ],
    buttons: [
      {
        label: 'Reset to defaults',
        onClick: () => {
          const d = defaultSettings();
          store.update((c) => {
            c.settings = { ...d, customShells: c.settings.customShells, sidebarVisible: c.settings.sidebarVisible, sidebarWidth: c.settings.sidebarWidth, otherTerminalsCollapsed: c.settings.otherTerminalsCollapsed };
          });
        },
      },
      { label: 'Cancel' },
      {
        label: 'Save',
        kind: 'primary',
        onClick: () => {
          const next: Partial<Settings> = {
            theme: theme.value,
            fontFamily: fontFamily.value.trim() || DEFAULT_FONT,
            fontSize: Number(fontSize.value),
            lineHeight: Number(lineHeight.value),
            cursorStyle: cursorStyle.value as Settings['cursorStyle'],
            cursorBlink: cursorBlink(),
            gpuAcceleration: gpu(),
            defaultShellId: defaultShell.value,
            defaultCwd: defaultCwd.value.trim(),
            scrollback: Number(scrollback.value),
            closeOnExit: closeOnExit.value as Settings['closeOnExit'],
            shiftEnterNewline: shiftEnter(),
            copyOnSelect: copySel(),
            rightClick: rightClick.value as Settings['rightClick'],
            shellIntegration: integration(),
            confirmClose: confirmClose(),
            updates: updates.value as UpdateMode,
            customShells: custom.filter((x) => x.path.trim()).map((x) => ({ ...x, name: x.name.trim() || x.path })),
          };
          store.update((c) => Object.assign(c.settings, next));
        },
      },
    ],
  });
}

export function openShortcuts(): void {
  const seen = new Set<Action>();
  const rows: HTMLElement[] = [];
  for (const b of BINDINGS) {
    if (b.action === 'goToTab') {
      if (seen.has('goToTab')) continue;
      seen.add('goToTab');
      rows.push(h('tr', null, h('td', null, ACTION_LABELS.goToTab), h('td', null, h('kbd', null, 'Alt+1…9'))));
      continue;
    }
    const all = BINDINGS.filter((x) => x.action === b.action);
    if (seen.has(b.action)) continue;
    seen.add(b.action);
    rows.push(h('tr', null, h('td', null, ACTION_LABELS[b.action]), h('td', null, ...all.flatMap((x, i) => [i ? ' ' : '', h('kbd', null, bindingLabel(x))]))));
  }
  const extra: [string, string][] = [
    ['Copy selection / interrupt', 'Ctrl+C'],
    ['Paste (forwards Ctrl+V for images)', 'Ctrl+V'],
    ['Paste (configurable in Settings)', 'Right-click'],
    ['Terminal menu', 'Shift+Right-click'],
    ['Newline in Claude Code', 'Shift+Enter'],
    ['Select text in apps that use the mouse (Claude Code)', 'Shift+Drag'],
    ['Open link', 'Ctrl+Click'],
    ['Zoom font', 'Ctrl+Wheel'],
    ['Close tab', 'Middle-click tab'],
    ['Open saved session in split', 'Middle-click session'],
  ];
  for (const [label, key] of extra) rows.push(h('tr', null, h('td', null, label), h('td', null, h('kbd', null, key))));
  dialog({
    title: 'Keyboard shortcuts',
    width: 560,
    body: h('table', { class: 'shortcuts' }, h('tbody', null, ...rows)),
    buttons: [{ label: 'Close', kind: 'primary' }],
  });
}
