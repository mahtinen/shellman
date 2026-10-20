import { api } from './api';
import { DEFAULT_FONT, defaultSettings, guessShellKind, uid } from './config';
import { dialog } from './dialogs';
import { h } from './dom';
import { icons } from './icons';
import { ACTION_LABELS, BINDINGS, bindingLabel, REQUEST_BINDINGS, REQUEST_LABELS, type Action } from './keys';
import { pickDirectory, shellOptions } from './sessionEditor';
import { store } from './store';
import { THEMES } from './themes';
import type { CurlShell, ProxyMode, ResponseLayout, RestoreMode, Settings, ShellProfile, UpdateMode } from './types';
import { updater } from './updater';

function check(label: string, value: boolean, hint?: string): [HTMLElement, () => boolean] {
  const input = h('input', { type: 'checkbox', checked: value });
  const el = h('label', { class: 'check' }, input, h('span', null, label, hint ? h('small', { class: 'hint' }, hint) : null));
  return [el, () => input.checked];
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
}

export type SettingsTab = 'Appearance' | 'Terminal' | 'Shells' | 'Connections' | 'Requests' | 'Updates' | 'About';

/** The tab shown last, so Settings opens where you were. */
let lastTab: SettingsTab = 'Appearance';

export function openSettings(tab?: SettingsTab): void {
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
  const restore = h(
    'select',
    { class: 'input' },
    h('option', { value: 'all' }, 'Reopen terminals and re-run their startup commands'),
    h('option', { value: 'shells' }, 'Reopen terminals as plain shells'),
    h('option', { value: 'off' }, 'Start with no terminals open'),
  );
  restore.value = s.restoreTerminals;
  const [confirmEl, confirmClose] = check('Confirm before closing terminals with running programs', s.confirmClose);
  const [reconnectEl, reconnect] = check(
    'Reconnect SSH and Telnet tabs on start',
    s.reconnectOnStart,
    "Off: reopened connections wait until you press Enter, so starting Shellman doesn't log in to every host (or ask 1Password for every key) at once.",
  );
  const sshPath = h('input', { class: 'input mono', value: s.sshPath, placeholder: 'Windows OpenSSH (System32\\OpenSSH\\ssh.exe)', spellcheck: false });

  // Requests
  const select = <T extends string>(value: T, options: [T, string][]) => {
    const el = h('select', { class: 'input' }, ...options.map(([v, label]) => h('option', { value: v }, label)));
    el.value = value;
    return el;
  };
  const [previewEl, preview] = check('Single-click opens a preview tab', s.requestPreviewTabs, 'The next request you click replaces it, until you edit it or double-click. Off: every click opens a tab of its own.');
  const openIn = select(s.requestOpenIn, [
    ['tab', 'A new tab'],
    ['split', 'A split right of the active pane'],
  ]);
  const layout = select<ResponseLayout>(s.responseLayout, [
    ['auto', 'Below, or on the right in wide panes'],
    ['below', 'Always below the request'],
    ['right', 'Always on the right'],
  ]);
  const timeout = h('input', { class: 'input', type: 'number', min: 1, max: 3600, value: String(s.requestTimeout) });
  const maxMb = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: String(s.responseMaxMb) });
  const [redirectsEl, redirects] = check('Follow redirects', s.requestFollowRedirects);
  const [wrapEl, wrap] = check('Wrap long lines in responses', s.responseWrap);
  const [protectEl, protect] = check('Confirm before sending to a protected environment', s.confirmProtectedSend, 'Anything but GET to an environment marked protected (like prod) asks first.');
  const [hideEl, hide] = check('Hide secret values', s.hideSecrets, 'Tokens and passwords from your .env.local show as dots.');
  const [warnEl, warn] = check('Warn when saving a token or password in a request', s.warnSecretsOnSave, 'Request files are shared through git; offers to move the value to your .env.local.');
  const [saveOnSendEl, saveOnSend] = check('Sending also saves the request', s.saveOnSend);
  const curlShell = select<CurlShell>(s.copyCurlShell, [
    ['powershell', 'PowerShell 7'],
    ['cmd', 'Command Prompt (cmd)'],
    ['bash', 'bash (Git Bash, WSL)'],
  ]);
  const proxyMode = select<ProxyMode>(s.proxyMode, [
    ['none', 'No proxy'],
    ['environment', 'From HTTPS_PROXY / HTTP_PROXY'],
    ['custom', 'This proxy:'],
  ]);
  const proxyUrl = h('input', { class: 'input mono', value: s.proxyUrl, placeholder: 'http://proxy.example.com:8080', spellcheck: false });
  const curlPath = h('input', { class: 'input mono', value: s.curlPath, placeholder: "Windows' curl (System32\\curl.exe)", spellcheck: false });
  const opPath = h('input', { class: 'input mono', value: s.opPath, placeholder: 'op.exe on PATH', spellcheck: false });
  // The accounts op knows; filled in once op answers.
  const opAccount = h('select', { class: 'input' }, h('option', { value: s.opAccount }, s.opAccount || "1Password's default"));
  void api.opAccounts(s.opPath).then((accounts) => {
    const options = [h('option', { value: '' }, "1Password's default (asks when there are several)")];
    for (const a of accounts) options.push(h('option', { value: a.url }, `${a.email} · ${a.url}`));
    if (s.opAccount && !accounts.some((a) => a.url === s.opAccount)) options.push(h('option', { value: s.opAccount }, s.opAccount));
    opAccount.replaceChildren(...options);
    opAccount.value = s.opAccount;
  });

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

  const section = (title: SettingsTab, ...children: (HTMLElement | null)[]) => h('section', { class: 'settings-section', role: 'tabpanel', dataset: { tab: title } }, ...children);

  const configLink = h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void api.openDir(store.sys.configDir); } }, store.sys.configDir);

  const sections = [
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
        field('On start', restore, 'Tabs and splits open where you left them, each in the folder it was last in.'),
        field('Default directory', h('div', { class: 'row' }, defaultCwd, browse), 'Used for new terminals that are not opened from a session or an existing terminal.'),
        h(
          'div',
          { class: 'row two' },
          field('Close pane when the shell exits', closeOnExit),
          field('Right-click in terminal', rightClick, 'Programs that use the mouse (like Claude Code) handle right-click themselves. Shift+right-click always opens the menu.'),
        ),
        shiftEnterEl,
        copySelEl,
        integrationEl,
        confirmEl,
      ),
      section('Shells', h('small', { class: 'hint' }, 'Detected automatically:'), detected, h('small', { class: 'hint' }, 'Custom shells:'), customList),
      section(
        'Connections',
        field('SSH client', sshPath, "Leave empty for Windows OpenSSH, which uses the Windows ssh-agent or 1Password's SSH agent. Telnet uses the Windows Telnet Client (an optional Windows feature)."),
        reconnectEl,
      ),
      section(
        'Requests',
        previewEl,
        h('div', { class: 'row two' }, field('Open requests in', openIn), field('Response', layout)),
        h('div', { class: 'row two' }, field('Timeout (seconds)', timeout, "A request's own Options win."), field('Largest response shown (MB)', maxMb, 'Larger ones can be saved to a file.')),
        redirectsEl,
        wrapEl,
        protectEl,
        hideEl,
        warnEl,
        saveOnSendEl,
        h('div', { class: 'row two' }, field('Copy as curl for', curlShell), field('Proxy', proxyMode)),
        field('Proxy address', proxyUrl, 'Used when Proxy is "This proxy".'),
        h('div', { class: 'row two' }, field('curl.exe', curlPath), field('1Password CLI (op.exe)', opPath, 'For op:// references in variables.')),
        field('1Password account', opAccount, 'With several 1Password accounts, the one the op:// references are in. Shellman runs op without a terminal, so op can\'t ask.'),
      ),
      section(
        'Updates',
        field('New versions', updates, 'Updates come from GitHub Releases and are signed; only signed installers are accepted.'),
        h('div', { class: 'row update-row' }, updateStatus, updateBtn),
      ),
      section('About', h('p', { class: 'hint' }, `Shellman ${store.sys.version} · settings are stored in `, configLink)),
  ];
  // One tab per category; every control stays in the form, so Save takes them all.
  const tabs = sections.map((sec) => h('button', { class: 'settings-tab', type: 'button', role: 'tab', onclick: () => show(sec.dataset.tab as SettingsTab) }, sec.dataset.tab));
  const show = (name: SettingsTab) => {
    lastTab = name;
    sections.forEach((sec, i) => {
      const on = sec.dataset.tab === name;
      sec.hidden = !on;
      tabs[i].classList.toggle('sel', on);
      tabs[i].setAttribute('aria-selected', String(on));
    });
  };
  show(tab ?? lastTab);

  dialog({
    title: 'Settings',
    width: 780,
    className: 'settings-dialog',
    onClose: () => offUpdate(),
    body: h('div', { class: 'settings-layout' }, h('nav', { class: 'settings-tabs', role: 'tablist' }, ...tabs), h('div', { class: 'settings-panels' }, ...sections)),
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
            restoreTerminals: restore.value as RestoreMode,
            reconnectOnStart: reconnect(),
            sshPath: sshPath.value.trim().replace(/^"(.*)"$/, '$1'),
            requestPreviewTabs: preview(),
            requestOpenIn: openIn.value as Settings['requestOpenIn'],
            responseLayout: layout.value as ResponseLayout,
            requestTimeout: Math.min(3600, Math.max(1, Math.round(Number(timeout.value) || 30))),
            responseMaxMb: Math.min(500, Math.max(1, Math.round(Number(maxMb.value) || 10))),
            requestFollowRedirects: redirects(),
            responseWrap: wrap(),
            confirmProtectedSend: protect(),
            hideSecrets: hide(),
            warnSecretsOnSave: warn(),
            saveOnSend: saveOnSend(),
            copyCurlShell: curlShell.value as CurlShell,
            proxyMode: proxyMode.value as ProxyMode,
            proxyUrl: proxyUrl.value.trim(),
            curlPath: curlPath.value.trim().replace(/^"(.*)"$/, '$1'),
            opPath: opPath.value.trim().replace(/^"(.*)"$/, '$1'),
            opAccount: opAccount.value,
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
  for (const action of ['send', 'save'] as const) {
    const keys = REQUEST_BINDINGS.filter((b) => b.action === action).slice(0, 1).map((b) => bindingLabel(b));
    rows.push(h('tr', null, h('td', null, REQUEST_LABELS[action]), h('td', null, h('kbd', null, keys[0]))));
  }
  rows.push(h('tr', null, h('td', null, 'Open a request in a split'), h('td', null, h('kbd', null, 'Middle-click request'))));
  dialog({
    title: 'Keyboard shortcuts',
    width: 560,
    body: h('table', { class: 'shortcuts' }, h('tbody', null, ...rows)),
    buttons: [{ label: 'Close', kind: 'primary' }],
  });
}
