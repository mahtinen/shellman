import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from './api';
import { baseName, deleteGroup, groupPath, newGroup, uid } from './config';
import { connectionCommand, connectionKindName, connectionLabel, connectionTarget, emptyConnection, parseQuickConnect } from './connection';
import { confirmDialog, isDialogOpen, promptDialog, toast } from './dialogs';
import { clamp, h, isEditableTarget, setChildren } from './dom';
import { icons } from './icons';
import { importSessions } from './importDialog';
import { matchKey, shortcutFor, type Match } from './keys';
import { showMenu, showMenuBelow, type MenuEntry } from './menu';
import type { Pane } from './pane';
import { showPalette, type PaletteItem } from './palette';
import { normalizeSnapshot, snapshotPanes } from './snapshot';
import { editSession, pickDirectory, shellEntries } from './sessionEditor';
import { openSettings, openShortcuts } from './settingsDialog';
import { Sidebar, type OpenTerminal } from './sidebar';
import { store } from './store';
import { applyUiTheme, getTheme } from './themes';
import type { Connection, Group, LaunchSpec, SavedSession, SplitPlacement } from './types';
import { updater } from './updater';
import { Workspace, type Tab } from './workspace';

/** Browser shortcuts that must never reach WebView2 (reload, print, ...). */
const BLOCKED_KEYS = new Set(['F3', 'F5', 'F7', 'F12', 'BrowserBack', 'BrowserForward', 'BrowserRefresh']);
const BLOCKED_CTRL = new Set(['KeyR', 'KeyP', 'KeyU', 'KeyJ', 'KeyH', 'KeyG', 'KeyS', 'KeyO', 'KeyN', 'KeyF', 'KeyL', 'KeyD']);

class App {
  private readonly workspace: Workspace;
  private readonly sidebar: Sidebar;
  private readonly appEl = document.getElementById('app')!;
  private readonly tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  private readonly areaEl = h('div', { class: 'area' });
  private readonly welcomeEl = h('div', { class: 'welcome' });
  private readonly statusLeft = h('div', { class: 'status-left' });
  private readonly statusRight = h('div', { class: 'status-right' });
  private readonly updateBtn = h('button', { class: 'update-btn', hidden: true });
  private appliedSettings = '';
  /** Last workspace.json written; nothing is saved until the previous one has been reopened. */
  private savedWorkspace = '';
  private workspaceTimer: number | undefined;
  private workspaceSaving: Promise<void> = Promise.resolve();
  private canSaveWorkspace = false;

  constructor() {
    this.workspace = new Workspace(this.tabsEl, this.areaEl, {
      onChange: () => this.onWorkspaceChange(),
      onActiveInfo: (p) => this.updateStatus(p),
      onShortcut: (m) => this.runAction(m),
      onPaneContextMenu: (p, e) => this.paneMenu(p, e),
      onTabContextMenu: (t, e) => this.tabMenu(t, e),
      onTerminalsInfo: () => {
        this.sidebar?.refreshTerminals();
        this.scheduleWorkspaceSave();
      },
    });

    this.sidebar = new Sidebar({
      open: (s, placement, shellId, plain) => this.openSession(s, placement, shellId, plain),
      openGroup: (g) => this.openGroup(g),
      edit: (s) => void this.editExisting(s),
      // "New session in group" is meant to be kept, so Remember starts ticked there.
      create: (groupId, remember) => void this.createSession({ groupId }, { remember: remember ?? !!groupId }),
      duplicate: (s) =>
        store.update((c) => {
          const i = c.sessions.findIndex((x) => x.id === s.id);
          c.sessions.splice(i + 1, 0, { ...s, id: uid('s-'), name: `${s.name} (copy)`, env: { ...s.env } });
        }),
      remove: (s) => void this.removeSession(s),
      createGroup: (parentId) => void this.createGroup(parentId),
      importSessions: (groupId) => importSessions(groupId),
      renameGroup: (g) => void this.renameGroup(g),
      removeGroup: (g) => void this.removeGroup(g),
      openFolder: (s) => void api.openDir(s.cwd).catch((e) => toast(String(e), 'error')),
      copyCommand: (s) => s.connection && void this.copyConnectionCommand(s.connection),
      terminals: () => this.openTerminals(),
      focusTerminal: (id) => this.workspace.setActivePane(id, true),
      closeTerminal: (id) => void this.workspace.requestClosePane(id),
      terminalMenu: (id, e) => {
        const pane = this.workspace.panes.get(id);
        if (pane) this.terminalMenu(pane, e);
      },
      settings: () => openSettings(),
      shortcuts: () => openShortcuts(),
    });

    this.buildLayout();
    this.areaEl.append(this.welcomeEl);
    store.on(() => this.onConfigChange());
    this.onConfigChange();
    this.onWorkspaceChange();
    this.installGlobalHandlers();
  }

  // ---- layout ---------------------------------------------------------

  private buildLayout(): void {
    const resizer = h('div', { class: 'sidebar-resizer', title: 'Drag to resize' });
    resizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing-col');
      let width = store.settings.sidebarWidth;
      const move = (ev: PointerEvent) => {
        width = clamp(ev.clientX, 160, Math.min(700, innerWidth - 300));
        this.appEl.style.setProperty('--sidebar-width', `${width}px`);
      };
      const up = () => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing-col');
        store.update((c) => (c.settings.sidebarWidth = width));
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
    });

    const newTabBtn = h('button', {
      class: 'icon-btn new-tab',
      title: `New terminal in the current directory (${shortcutFor('newTab')})`,
      html: icons.plus,
      onclick: () => this.newTerminal('tab'),
    });
    const newTabMenu = h('button', { class: 'icon-btn new-tab-menu', title: 'More…', html: icons.chevronDown });
    newTabMenu.addEventListener('click', () => showMenuBelow(newTabMenu, this.newTabMenuEntries()));

    const tabbar = h(
      'header',
      { class: 'tabbar' },
      h('button', {
        class: 'icon-btn toggle-sidebar',
        title: `Toggle sidebar (${shortcutFor('toggleSidebar')})`,
        html: icons.sidebar,
        onclick: () => this.toggleSidebar(),
      }),
      this.tabsEl,
      newTabBtn,
      newTabMenu,
      h('span', { class: 'tabbar-fill' }),
      this.updateBtn,
    );
    updater.on(() => this.renderUpdateButton());
    window.addEventListener('shellman:restart-to-update', () => void this.restartToUpdate());
    this.tabsEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.tabsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    tabbar.addEventListener('dblclick', (e) => {
      if (e.target === tabbar || (e.target as HTMLElement).classList.contains('tabbar-fill')) this.newTerminal('tab');
    });

    const main = h('main', { class: 'main' }, tabbar, this.areaEl, h('footer', { class: 'statusbar' }, this.statusLeft, this.statusRight));
    this.appEl.replaceChildren(this.sidebar.el, resizer, main);
  }

  private onConfigChange(): void {
    const s = store.settings;
    this.appEl.classList.toggle('no-sidebar', !s.sidebarVisible);
    this.appEl.style.setProperty('--sidebar-width', `${s.sidebarWidth}px`);
    const key = JSON.stringify({ ...s, sidebarVisible: 0, sidebarWidth: 0, otherTerminalsCollapsed: 0 });
    if (key !== this.appliedSettings) {
      this.appliedSettings = key;
      applyUiTheme(getTheme(s.theme));
      this.workspace.applySettings();
    }
    this.workspace.refreshTabs();
    this.sidebar.render();
    this.renderWelcome();
  }

  private onWorkspaceChange(): void {
    this.scheduleWorkspaceSave();
    const empty = this.workspace.tabs.length === 0;
    this.welcomeEl.hidden = !empty;
    this.sidebar.render();
    const tab = this.workspace.activeTab;
    const title = tab ? `${this.workspace.tabLabel(tab)} — Shellman` : 'Shellman';
    if (document.title !== title) {
      document.title = title;
      void getCurrentWindow().setTitle(title).catch(() => undefined);
    }
    if (empty) this.updateStatus(null);
  }

  private updateStatus(pane: Pane | null): void {
    if (!pane) {
      this.statusLeft.replaceChildren(h('span', { class: 'muted' }, `${store.config.sessions.length} saved sessions`));
      this.statusRight.replaceChildren(h('span', { class: 'muted' }, `${shortcutFor('palette')} quick open`));
      return;
    }
    const conn = pane.connection;
    const state =
      pane.state === 'exited'
        ? `${conn ? 'disconnected' : 'exited'} (${pane.exitCode ?? '?'})`
        : pane.state === 'error'
          ? 'failed'
          : pane.state === 'starting'
            ? conn ? 'connecting…' : 'starting…'
            : pane.state === 'idle'
              ? 'not connected'
              : pane.state === 'login'
                ? 'waiting for a user name'
                : '';
    if (conn) {
      setChildren(
        this.statusLeft,
        h(
          'button',
          {
            class: 'status-shell',
            title: 'Reconnect or copy the command',
            onclick: (e: MouseEvent) =>
              showMenu(e.clientX, e.clientY - 4, [
                { label: 'Reconnect', icon: 'globe', action: () => this.reconnect(pane) },
                { label: `Copy ${connectionKindName(conn.kind)} command`, icon: 'copy', action: () => void this.copyConnectionCommand(conn) },
              ]),
          },
          connectionKindName(conn.kind),
        ),
        h('span', { class: 'muted mono' }, connectionTarget(conn)),
      );
    } else {
      const cwd = h('button', { class: 'status-link', title: 'Open in Explorer', onclick: () => void api.openDir(pane.cwd).catch((e) => toast(String(e), 'error')) }, pane.cwd);
      setChildren(
        this.statusLeft,
        h(
          'button',
          {
            class: 'status-shell',
            title: 'Change shell or open another one here',
            onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY - 4, [...this.changeShellEntries(pane), 'separator', ...this.newHereEntries(pane)]),
          },
          pane.shell?.name ?? '',
        ),
        cwd,
        pane.spec.command ? h('span', { class: 'muted mono' }, `> ${pane.spec.command}`) : null,
      );
    }
    setChildren(
      this.statusRight,
      state ? h('span', { class: 'status-state' }, state) : null,
      h('span', { class: 'muted' }, `${pane.term.cols}×${pane.term.rows}`),
    );
    if (this.workspace.activeTab) {
      const title = `${this.workspace.tabLabel(this.workspace.activeTab)} — Shellman`;
      if (document.title !== title) {
        document.title = title;
        void getCurrentWindow().setTitle(title).catch(() => undefined);
      }
    }
  }

  private renderWelcome(): void {
    const sessions = store.config.sessions;
    const card = (s: SavedSession) =>
      h(
        'button',
        {
          class: 'welcome-card',
          style: s.color ? `--session-color:${s.color}` : undefined,
          title: s.connection ? connectionLabel(s.connection) : s.cwd,
          onclick: () => this.openSession(s, 'tab'),
        },
        h('span', { class: 'welcome-card-icon', html: s.connection ? icons.globe : icons.terminal }),
        h('span', { class: 'welcome-card-name' }, s.name),
        h('span', { class: 'welcome-card-sub' }, s.connection ? connectionLabel(s.connection) : s.command || baseName(s.cwd)),
      );
    setChildren(
      this.welcomeEl,
      h(
        'div',
        { class: 'welcome-inner' },
        h('h1', null, 'Shellman'),
        h('p', { class: 'muted' }, 'Pick a saved session, or start a terminal.'),
        h(
          'div',
          { class: 'welcome-actions' },
          h('button', { class: 'btn primary', onclick: () => this.newTerminal('tab') }, h('span', { html: icons.terminal }), 'New terminal'),
          h('button', { class: 'btn', onclick: () => void this.openDirectory() }, h('span', { html: icons.folder }), 'Open directory…'),
          h('button', { class: 'btn', onclick: () => void this.createSession({}) }, h('span', { html: icons.plus }), 'New session…'),
          h('button', { class: 'btn', onclick: () => this.newConnection() }, h('span', { html: icons.globe }), 'New connection…'),
        ),
        sessions.length ? h('div', { class: 'welcome-grid' }, ...sessions.slice(0, 24).map(card)) : null,
        h(
          'div',
          { class: 'welcome-tips' },
          ...(
            [
              ['palette', 'quick open a saved session, or type user@host'],
              ['newConnection', 'new SSH or Telnet connection'],
              ['newTab', 'new tab in the current directory'],
              ['splitRight', 'split right'],
              ['splitDown', 'split down'],
            ] as const
          ).map(([a, label]) => h('div', null, h('kbd', null, shortcutFor(a)), ` ${label}`)),
        ),
      ),
    );
  }

  // ---- reopening terminals after a restart ----------------------------

  /** Reopens the tabs and splits that were open when Shellman last closed. */
  async restoreWorkspace(): Promise<void> {
    const mode = store.settings.restoreTerminals;
    let raw: unknown = null;
    if (mode !== 'off') {
      try {
        const loaded = await api.loadWorkspace();
        raw = loaded.value;
        if (loaded.notice) toast(loaded.notice, 'error', 12000);
      } catch (e) {
        // The file is there but can't be read: leave it alone instead of overwriting it (saving stays off).
        toast(`Could not reopen the previous tabs: ${e}`, 'error', 10000);
        return;
      }
    }
    try {
      const snap = normalizeSnapshot(raw);
      if (!snap) return;
      // A folder that no longer exists falls back to its session's folder, then to the default one.
      const specs = snap.tabs.flatMap((t) => snapshotPanes(t.root));
      await Promise.all(
        specs.map(async (spec) => {
          if (mode === 'shells') spec.command = '';
          if (await api.dirExists(spec.cwd)) return;
          const session = store.session(spec.sessionId);
          spec.cwd = session && (await api.dirExists(session.cwd)) ? session.cwd : store.defaultCwd();
        }),
      );
      const tabs = snap.tabs.map((t) => this.workspace.restoreTab(t));
      this.workspace.activateTab(tabs[snap.activeTab].id, true);
    } catch (e) {
      console.warn('Could not reopen the previous terminals:', e);
    } finally {
      this.canSaveWorkspace = true;
      this.scheduleWorkspaceSave();
    }
  }

  /**
   * Saves at most once a second. A throttle, not a debounce: Claude's animated title changes a
   * tab several times a second, which would keep postponing a debounced save for a whole task.
   */
  private scheduleWorkspaceSave(): void {
    if (!this.canSaveWorkspace || this.workspaceTimer !== undefined) return;
    this.workspaceTimer = window.setTimeout(() => {
      this.workspaceTimer = undefined;
      void this.saveWorkspace();
    }, 1000);
  }

  /**
   * Writes the open tabs now (when they changed). Saves run one after another, so an older one can
   * never finish last. `final` stops later saves while the app shuts down.
   */
  saveWorkspace(final = false): Promise<void> {
    clearTimeout(this.workspaceTimer);
    this.workspaceTimer = undefined;
    if (!this.canSaveWorkspace) return this.workspaceSaving;
    if (final) this.canSaveWorkspace = false;
    const snap = this.workspace.snapshot();
    const json = JSON.stringify(snap);
    if (json === this.savedWorkspace) return this.workspaceSaving;
    this.savedWorkspace = json;
    this.workspaceSaving = this.workspaceSaving.then(() =>
      api.saveWorkspace(snap).catch((e) => console.warn('Could not save the open terminals:', e)),
    );
    return this.workspaceSaving;
  }

  // ---- updates ---------------------------------------------------------

  private renderUpdateButton(): void {
    const st = updater.state;
    const b = this.updateBtn;
    b.hidden = !(st.kind === 'available' || st.kind === 'downloading' || st.kind === 'ready');
    b.disabled = st.kind === 'downloading';
    b.classList.toggle('ready', st.kind === 'ready');
    if (st.kind === 'available') {
      b.textContent = `Update to ${st.version}`;
      b.title = 'Download the new version in the background';
      b.onclick = () => void updater.download();
    } else if (st.kind === 'downloading') {
      b.textContent = `Downloading ${st.version}${st.percent === null ? '…' : ` ${st.percent}%`}`;
      b.title = '';
      b.onclick = null;
    } else if (st.kind === 'ready') {
      b.textContent = 'Restart to update';
      b.title = `Shellman ${st.version} is downloaded. Restart now, or it is installed when you close Shellman.`;
      b.onclick = () => void this.restartToUpdate();
    }
  }

  /** Installs the downloaded update and starts the new version. */
  private async restartToUpdate(): Promise<void> {
    if (!updater.ready) return;
    const busy = await this.workspace.busyPanes();
    if (busy.length) {
      const names = [...new Set(busy.map((p) => p.name))].slice(0, 5).join(', ');
      const ok = await confirmDialog(
        'Restart to update?',
        `${busy.length} terminal${busy.length > 1 ? 's have' : ' has'} a running program (${names}). Restarting will end ${busy.length > 1 ? 'them' : 'it'}.`,
        'Restart',
        true,
      );
      if (!ok) return;
    }
    await this.saveWorkspace(true);
    await store.flush();
    const live = [...this.workspace.panes.values()].filter((p) => p.isRunning);
    // The terminals are ended before the installer runs; keep their panes open meanwhile.
    this.workspace.keepPanesOnExit = true;
    if (await updater.install(true)) return;
    // The installer didn't start: Shellman keeps running, so bring the terminals back.
    this.workspace.keepPanesOnExit = false;
    this.canSaveWorkspace = true;
    for (const p of live) p.restart();
  }

  // ---- opening terminals ---------------------------------------------

  private defaultSpec(shellId = '', cwd = store.defaultCwd()): LaunchSpec {
    return { name: baseName(cwd), cwd, command: '', shellId, env: {}, color: '', sessionId: null };
  }

  private sessionSpec(s: SavedSession): LaunchSpec {
    if (s.connection) return this.connectionSpec(s.connection, s);
    return { name: s.name, cwd: s.cwd, command: s.command, shellId: s.shellId, env: { ...s.env }, color: s.color, sessionId: s.id };
  }

  /** A connection, from a saved session or typed (ad hoc). The client runs in the home directory. */
  private connectionSpec(c: Connection, s?: SavedSession): LaunchSpec {
    return {
      name: s?.name ?? connectionTarget(c),
      cwd: store.sys.homeDir,
      command: '',
      shellId: '',
      env: { ...s?.env },
      color: s?.color ?? '',
      sessionId: s?.id ?? null,
      connection: { ...c },
    };
  }

  private openConnection(c: Connection, placement: SplitPlacement): void {
    const pane = this.workspace.activePane();
    this.workspace.open(this.connectionSpec(c), pane ? placement : 'tab', pane?.id);
  }

  private newConnection(): void {
    void this.createSession({ connection: emptyConnection('ssh') });
  }

  private reconnect(pane: Pane): void {
    pane.restart();
    this.workspace.setActivePane(pane.id, true);
  }

  private async copyConnectionCommand(c: Connection): Promise<void> {
    const keyFile = c.kind === 'ssh' && c.identityKey ? await api.sshPublicKeyFile(c.identityKey).catch(() => '') : '';
    await api.clipboardWrite(connectionCommand(c, keyFile)).then(
      () => toast('Command copied'),
      (e) => toast(String(e), 'error'),
    );
  }

  /** New plain shell next to the active pane (same directory and shell). */
  newTerminal(placement: SplitPlacement, shellId?: string): void {
    const pane = this.workspace.activePane();
    const spec = pane ? this.workspace.specFrom(pane, false) : this.defaultSpec();
    if (shellId !== undefined) spec.shellId = shellId;
    this.workspace.open(spec, pane ? placement : 'tab', pane?.id);
  }

  /** `plain`: the session's folder, shell and environment, without its startup command. */
  openSession(s: SavedSession, placement: SplitPlacement, shellId?: string, plain = false): void {
    const pane = this.workspace.activePane();
    const spec = this.sessionSpec(s);
    if (shellId !== undefined && !s.connection) spec.shellId = shellId;
    if (plain) spec.command = '';
    this.workspace.open(spec, pane ? placement : 'tab', pane?.id);
  }

  /** New plain terminal in `pane`'s directory with the given shell. */
  private openHere(pane: Pane, shellId: string, placement: SplitPlacement): void {
    const spec = this.workspace.specFrom(pane, false);
    spec.shellId = shellId;
    // Keep it listed under the same saved session in the sidebar.
    spec.sessionId = pane.spec.sessionId;
    spec.color = pane.spec.sessionId ? pane.spec.color : '';
    this.workspace.open(spec, placement, pane.id);
  }

  private async changeShell(pane: Pane, shellId: string): Promise<void> {
    if (store.settings.confirmClose && (await pane.hasRunningProgram())) {
      const name = store.resolveShell(shellId)?.name ?? 'another shell';
      if (!(await confirmDialog(`Switch "${pane.name}" to ${name}?`, 'A program is still running in this terminal and will be ended.', 'Switch', true))) return;
    }
    pane.switchShell(shellId);
    this.workspace.setActivePane(pane.id, true);
  }

  private changeShellEntries(pane: Pane): MenuEntry[] {
    return shellEntries((id) => void this.changeShell(pane, id), pane.shell?.id, 'Switch to ');
  }

  private newHereEntries(pane: Pane): MenuEntry[] {
    return shellEntries((id) => this.openHere(pane, id, 'tab'), undefined, 'New tab: ');
  }

  /** Open terminals grouped under the saved session they belong to, for the sidebar tree. */
  private openTerminals(): Map<string | null, OpenTerminal[]> {
    const out = new Map<string | null, OpenTerminal[]>();
    const active = this.workspace.activePane();
    this.workspace.tabs.forEach((tab, i) => {
      const panes = this.workspace.panesOf(tab);
      const inactive = tab.id !== this.workspace.activeTabId;
      for (const p of panes) {
        // Opened from a session, or (for ad-hoc terminals) sitting in a session's directory.
        const owner = this.workspace.ownerOf(p)?.id ?? null;
        const shell = p.connection ? connectionKindName(p.connection.kind) : (p.shell?.name ?? '');
        // Same name as the tab (a renamed tab's name applies when it is the only pane).
        const label = (panes.length === 1 ? tab.customTitle : null) || this.workspace.paneLabel(p);
        const status: OpenTerminal['status'] =
          p.state === 'exited' || p.state === 'error'
            ? 'exited'
            : p.progress
              ? 'progress'
              : inactive && tab.bell
                ? 'bell'
                : inactive && tab.busy
                  ? 'busy'
                  : inactive && tab.unread
                    ? 'unread'
                    : '';
        const list = out.get(owner) ?? [];
        list.push({
          paneId: p.id,
          tab: i + 1,
          label,
          shell: label === shell ? '' : shell,
          tooltip: [`Tab ${i + 1}${panes.length > 1 ? ` (${panes.length} panes)` : ''}: ${this.workspace.tabLabel(tab)}`, p.location, '', 'Click: focus · Middle-click: close'].join('\n'),
          active: p === active,
          status,
        });
        out.set(owner, list);
      }
    });
    return out;
  }

  private openGroup(g: Group): void {
    for (const s of store.config.sessions.filter((x) => x.groupId === g.id)) this.workspace.open(this.sessionSpec(s), 'tab');
  }

  private async openDirectory(placement: SplitPlacement = 'tab'): Promise<void> {
    const dir = await pickDirectory(this.workspace.activePane()?.cwd ?? store.defaultCwd());
    if (!dir) return;
    const pane = this.workspace.activePane();
    this.workspace.open(this.defaultSpec(pane?.spec.shellId ?? '', dir), pane ? placement : 'tab', pane?.id);
  }

  private newTabMenuEntries(): MenuEntry[] {
    const pane = this.workspace.activePane();
    const here = pane ? ` in ${baseName(pane.cwd)}` : '';
    return [
      ...store.shells.map((s): MenuEntry => ({ label: `${s.name}${here}`, icon: 'terminal', action: () => this.newTerminal('tab', s.id) })),
      'separator',
      { label: 'Open directory…', icon: 'folder', action: () => void this.openDirectory() },
      { label: 'New terminal in default directory', icon: 'terminal', action: () => this.workspace.open(this.defaultSpec(), 'tab') },
      { label: 'Quick open saved session…', icon: 'search', shortcut: shortcutFor('palette'), action: () => this.palette() },
      { label: 'New connection…', icon: 'globe', shortcut: shortcutFor('newConnection'), action: () => this.newConnection() },
      { label: 'Import sessions…', icon: 'globe', action: () => importSessions() },
      'separator',
      { label: 'Settings', icon: 'gear', shortcut: shortcutFor('settings'), action: () => openSettings() },
      { label: 'Keyboard shortcuts', icon: 'keyboard', action: () => openShortcuts() },
    ];
  }

  private palette(): void {
    const items: PaletteItem[] = store.config.sessions.map((s) => ({
      label: s.name,
      detail: s.connection ? connectionLabel(s.connection) : s.command ? `${s.command} · ${s.cwd}` : s.cwd,
      icon: s.connection ? 'globe' : undefined,
      color: s.color,
      keywords: [groupPath(store.config.groups, s.groupId)],
      run: (placement) => this.openSession(s, placement),
    }));
    const pane = this.workspace.activePane();
    for (const sh of store.shells) {
      items.push({
        label: `New ${sh.name}${pane ? ` in ${baseName(pane.cwd)}` : ''}`,
        detail: pane?.cwd ?? store.defaultCwd(),
        icon: 'plus',
        run: (placement) => this.newTerminal(placement, sh.id),
      });
    }
    items.push({ label: 'Open directory…', icon: 'folder', run: (placement) => void this.openDirectory(placement) });
    items.push({ label: 'New connection…', icon: 'globe', detail: 'SSH or Telnet', run: () => this.newConnection() });
    items.push({ label: 'Import sessions…', icon: 'globe', detail: 'SSH and Telnet sessions from XShell', run: () => importSessions() });
    showPalette(items, 'Open a saved session, or type user@host to connect…', (q) => {
      const c = parseQuickConnect(q);
      if (!c) return [];
      const connect = (conn: Connection, label: string): PaletteItem => ({
        label,
        detail: connectionCommand(conn),
        icon: 'globe',
        run: (placement) => this.openConnection(conn, placement),
      });
      const items = [connect(c, `Connect to ${connectionTarget(c)}`)];
      // Password servers may never get to ask when the agent offers many keys first.
      if (c.kind === 'ssh' && !c.passwordAuth) items.push(connect({ ...c, passwordAuth: true }, `Connect to ${connectionTarget(c)} with a password`));
      return items;
    });
  }

  // ---- sessions & groups ----------------------------------------------

  /** Opens a new terminal or connection from the dialog; it is saved only if "Remember" was ticked. */
  private async createSession(initial: Partial<SavedSession>, opts: { remember?: boolean } = {}): Promise<void> {
    const res = await editSession(initial, 'new', opts);
    if (!res) return;
    const pane = this.workspace.activePane();
    if (!res.save) {
      this.workspace.open({ ...this.sessionSpec(res.session), sessionId: null }, 'tab', pane?.id);
      return;
    }
    store.update((c) => c.sessions.push(res.session));
    this.openSession(res.session, 'tab');
    toast(`Saved "${res.session.name}"`);
  }

  /** Saves a session, from an open pane (which then belongs to it) or from scratch. */
  private async saveSession(initial: Partial<SavedSession>, fromPane?: Pane): Promise<void> {
    const res = await editSession(initial, 'save');
    if (!res) return;
    store.update((c) => c.sessions.push(res.session));
    if (fromPane && !fromPane.spec.sessionId) {
      fromPane.spec = { ...fromPane.spec, sessionId: res.session.id, color: res.session.color };
      fromPane.rename(res.session.name);
      this.sidebar.render();
    }
    toast(`Saved "${res.session.name}"`);
  }

  private saveAsSession(pane: Pane): void {
    void this.saveSession(
      {
        name: pane.spec.sessionId ? `${pane.name} (copy)` : pane.name,
        connection: pane.connection ? { ...pane.connection } : null,
        cwd: pane.connection ? '' : pane.cwd,
        command: pane.spec.command,
        shellId: pane.spec.shellId,
        color: pane.spec.color,
        env: pane.spec.env,
      },
      pane,
    );
  }

  private async editExisting(s: SavedSession): Promise<void> {
    const res = await editSession(s, 'edit');
    if (!res) return;
    store.update((c) => {
      const i = c.sessions.findIndex((x) => x.id === s.id);
      if (i >= 0) c.sessions[i] = res.session;
    });
  }

  private async removeSession(s: SavedSession): Promise<void> {
    if (!(await confirmDialog('Delete session?', `"${s.name}" will be removed from the sidebar. Open terminals are not affected.`, 'Delete', true))) return;
    store.update((c) => (c.sessions = c.sessions.filter((x) => x.id !== s.id)));
  }

  private async createGroup(parentId: string | null = null): Promise<void> {
    const name = (await promptDialog(parentId ? 'New subgroup' : 'New group', 'Group name'))?.trim();
    if (!name) return;
    store.update((c) => {
      c.groups.push(newGroup(name, parentId));
      const parent = c.groups.find((g) => g.id === parentId);
      if (parent) parent.collapsed = false;
    });
  }

  private async renameGroup(g: Group): Promise<void> {
    const name = (await promptDialog('Rename group', 'Group name', g.name))?.trim();
    if (name)
      store.update((c) => {
        const x = c.groups.find((y) => y.id === g.id);
        if (x) x.name = name;
      });
  }

  private async removeGroup(g: Group): Promise<void> {
    const { sessions, groups } = store.config;
    const count = sessions.filter((s) => s.groupId === g.id).length;
    const subgroups = groups.filter((x) => x.parentId === g.id).length;
    const what = [count ? `${count} session${count > 1 ? 's' : ''}` : '', subgroups ? `${subgroups} subgroup${subgroups > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
    const parent = groups.find((x) => x.id === g.parentId);
    const msg = what ? `The ${what} in it will be kept, ${parent ? `in "${parent.name}"` : 'outside any group'}.` : 'The group is empty.';
    if (!(await confirmDialog(`Delete group "${g.name}"?`, msg, 'Delete', true))) return;
    store.update((c) => deleteGroup(c, g.id));
  }

  // ---- menus ----------------------------------------------------------

  private paneMenu(pane: Pane, e: MouseEvent): void {
    const hasSel = pane.term.hasSelection();
    const conn = pane.connection;
    const localOnly = (entries: MenuEntry[]): MenuEntry[] => (conn ? [] : entries);
    showMenu(e.clientX, e.clientY, [
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', disabled: !hasSel, action: () => void pane.copySelection(true) },
      { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', action: () => void pane.paste() },
      'separator',
      { label: 'Split right', icon: 'splitRight', shortcut: shortcutFor('splitRight'), action: () => this.workspace.open(this.workspace.specFrom(pane, false), 'right', pane.id) },
      { label: 'Split down', icon: 'splitDown', shortcut: shortcutFor('splitDown'), action: () => this.workspace.open(this.workspace.specFrom(pane, false), 'down', pane.id) },
      {
        label: 'Duplicate',
        icon: 'duplicate',
        shortcut: shortcutFor('duplicate'),
        disabled: !pane.spec.command && !conn,
        action: () => this.workspace.open(this.workspace.specFrom(pane, true), 'right', pane.id),
      },
      {
        label: conn ? 'New local tab' : 'New tab here',
        icon: 'terminal',
        shortcut: shortcutFor('newTab'),
        action: () => this.workspace.open(this.workspace.specFrom(pane, false), 'tab'),
      },
      ...localOnly([
        { label: 'New tab here with', icon: 'terminal', submenu: this.newHereEntries(pane) },
        { label: 'Switch shell', icon: 'terminal', submenu: this.changeShellEntries(pane) },
      ]),
      'separator',
      { label: 'Find…', icon: 'search', shortcut: shortcutFor('find'), action: () => pane.openSearch() },
      { label: 'Save as session…', icon: 'save', shortcut: shortcutFor('saveSession'), action: () => this.saveAsSession(pane) },
      conn
        ? { label: `Copy ${connectionKindName(conn.kind)} command`, icon: 'copy', action: () => void this.copyConnectionCommand(conn) }
        : { label: 'Open folder in Explorer', icon: 'openExternal', action: () => void api.openDir(pane.cwd).catch((err) => toast(String(err), 'error')) },
      { label: 'Clear', action: () => pane.term.clear() },
      { label: conn ? 'Reconnect' : 'Restart', action: () => pane.restart() },
      'separator',
      { label: 'Close pane', icon: 'x', danger: true, shortcut: shortcutFor('closePane'), action: () => void this.workspace.requestClosePane(pane.id) },
    ]);
  }

  /** Context menu for a terminal in the sidebar tree. */
  private terminalMenu(pane: Pane, e: MouseEvent): void {
    const tab = this.workspace.tabOf(pane);
    if (pane.connection) {
      showMenu(e.clientX, e.clientY, [
        { label: 'Focus', icon: 'globe', action: () => this.workspace.setActivePane(pane.id, true) },
        { label: 'Connect again in split right', icon: 'splitRight', action: () => this.workspace.open(this.workspace.specFrom(pane, true), 'right', pane.id) },
        { label: 'Connect again in split down', icon: 'splitDown', action: () => this.workspace.open(this.workspace.specFrom(pane, true), 'down', pane.id) },
        'separator',
        { label: 'Rename tab…', icon: 'edit', disabled: !tab, action: () => tab && void this.renameTab(tab) },
        { label: 'Reconnect', action: () => this.reconnect(pane) },
        'separator',
        { label: 'Close', icon: 'x', danger: true, action: () => void this.workspace.requestClosePane(pane.id) },
      ]);
      return;
    }
    showMenu(e.clientX, e.clientY, [
      { label: 'Focus', icon: 'terminal', action: () => this.workspace.setActivePane(pane.id, true) },
      { label: 'Split right here', icon: 'splitRight', action: () => this.openHere(pane, pane.spec.shellId, 'right') },
      { label: 'Split down here', icon: 'splitDown', action: () => this.openHere(pane, pane.spec.shellId, 'down') },
      { label: 'New tab here with', icon: 'terminal', submenu: this.newHereEntries(pane) },
      { label: 'Switch shell', icon: 'terminal', submenu: this.changeShellEntries(pane) },
      'separator',
      { label: 'Rename tab…', icon: 'edit', disabled: !tab, action: () => tab && void this.renameTab(tab) },
      { label: 'Restart', action: () => pane.restart() },
      'separator',
      { label: 'Close', icon: 'x', danger: true, action: () => void this.workspace.requestClosePane(pane.id) },
    ]);
  }

  private tabMenu(tab: Tab, e: MouseEvent): void {
    const pane = this.workspace.panes.get(tab.activePaneId);
    showMenu(e.clientX, e.clientY, [
      { label: 'Rename…', icon: 'edit', shortcut: shortcutFor('renameTab'), action: () => void this.renameTab(tab) },
      { label: 'New tab here', icon: 'terminal', disabled: !pane, action: () => pane && this.workspace.open(this.workspace.specFrom(pane, false), 'tab') },
      { label: 'Duplicate tab', icon: 'duplicate', disabled: !pane, action: () => pane && this.workspace.open(this.workspace.specFrom(pane, true), 'tab') },
      { label: 'Save as session…', icon: 'save', disabled: !pane, action: () => pane && this.saveAsSession(pane) },
      'separator',
      { label: 'Close other tabs', disabled: this.workspace.tabs.length < 2, action: () => void this.closeOtherTabs(tab) },
      { label: 'Close tab', icon: 'x', danger: true, action: () => void this.workspace.requestCloseTab(tab.id) },
    ]);
  }

  private async renameTab(tab: Tab): Promise<void> {
    const name = await promptDialog('Rename tab', 'Tab name (empty = automatic)', tab.customTitle ?? this.workspace.tabLabel(tab));
    if (name !== null) this.workspace.renameTab(tab, name);
    this.workspace.activePane()?.focus();
  }

  private async closeOtherTabs(keep: Tab): Promise<void> {
    const others = this.workspace.tabs.filter((t) => t !== keep);
    if (store.settings.confirmClose) {
      const busy = (await Promise.all(others.flatMap((t) => this.workspace.panesOf(t)).map((p) => p.hasRunningProgram()))).filter(Boolean).length;
      if (busy && !(await confirmDialog('Close other tabs?', `${busy} terminal${busy > 1 ? 's have' : ' has'} a running program.`, 'Close', true))) return;
    }
    this.workspace.closeOtherTabs(keep);
  }

  // ---- shortcuts ------------------------------------------------------

  private toggleSidebar(): void {
    store.update((c) => (c.settings.sidebarVisible = !c.settings.sidebarVisible));
    this.workspace.activePane()?.focus();
  }

  private zoomFont(delta: number | null): void {
    store.update((c) => {
      c.settings.fontSize = delta === null ? 14 : clamp(c.settings.fontSize + delta, 6, 48);
    });
  }

  /** Runs an app shortcut. Returns false if it does not apply right now. */
  runAction(m: Match): boolean {
    const ws = this.workspace;
    const pane = ws.activePane();
    switch (m.action) {
      case 'newTab':
        this.newTerminal('tab');
        return true;
      case 'splitRight':
        this.newTerminal('right');
        return true;
      case 'splitDown':
        this.newTerminal('down');
        return true;
      case 'duplicate':
        if (pane) ws.open(ws.specFrom(pane, true), 'right', pane.id);
        return !!pane;
      case 'closePane':
        if (pane) void ws.requestClosePane(pane.id);
        return !!pane;
      case 'zoomPane':
        ws.toggleZoom();
        return true;
      case 'equalize':
        ws.equalize();
        return true;
      case 'focusLeft':
      case 'focusRight':
      case 'focusUp':
      case 'focusDown':
        ws.moveFocus(m.action.slice(5).toLowerCase() as 'left' | 'right' | 'up' | 'down');
        return true;
      case 'nextTab':
        ws.cycleTab(1);
        return true;
      case 'prevTab':
        ws.cycleTab(-1);
        return true;
      case 'goToTab':
        ws.goToTab(m.arg ?? 0);
        return true;
      case 'find':
        pane?.openSearch();
        return !!pane;
      case 'palette':
        this.palette();
        return true;
      case 'newConnection':
        this.newConnection();
        return true;
      case 'toggleSidebar':
        this.toggleSidebar();
        return true;
      case 'settings':
        openSettings();
        return true;
      case 'saveSession':
        if (pane) this.saveAsSession(pane);
        else void this.saveSession({});
        return true;
      case 'renameTab':
        if (ws.activeTab) void this.renameTab(ws.activeTab);
        return !!ws.activeTab;
      case 'copy':
        if (pane) void pane.copySelection(false);
        return !!pane;
      case 'paste':
        if (pane) void pane.paste();
        return !!pane;
      case 'fontUp':
        this.zoomFont(1);
        return true;
      case 'fontDown':
        this.zoomFont(-1);
        return true;
      case 'fontReset':
        this.zoomFont(null);
        return true;
    }
  }

  private installGlobalHandlers(): void {
    window.addEventListener('keydown', (e) => {
      if (isDialogOpen()) return;
      const editable = isEditableTarget(e.target);
      const m = matchKey(e);
      if (m && !(editable && (m.action === 'copy' || m.action === 'paste'))) {
        if (this.runAction(m)) {
          e.preventDefault();
          return;
        }
      }
      if (BLOCKED_KEYS.has(e.code) || BLOCKED_KEYS.has(e.key)) e.preventDefault();
      else if (e.ctrlKey && !editable && BLOCKED_CTRL.has(e.code)) e.preventDefault();
      else if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) e.preventDefault();
    });

    window.addEventListener('contextmenu', (e) => {
      if (!isEditableTarget(e.target)) e.preventDefault();
    });
    // Keep middle-click from starting autoscroll.
    window.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });

    window.addEventListener('focus', () => {
      if (!isDialogOpen() && !document.querySelector('.menu, .palette')) this.workspace.activePane()?.focus();
    });

    void getCurrentWindow().onCloseRequested(async (event) => {
      if (store.settings.confirmClose) {
        const busy = await this.workspace.busyPanes();
        if (busy.length) {
          const names = [...new Set(busy.map((p) => p.name))].slice(0, 5).join(', ');
          const ok = await confirmDialog(
            'Quit Shellman?',
            `${busy.length} terminal${busy.length > 1 ? 's have' : ' has'} a running program (${names}). Quitting will end ${busy.length > 1 ? 'them' : 'it'}.`,
            'Quit',
            true,
          );
          if (!ok) {
            event.preventDefault();
            return;
          }
        }
      }
      await this.saveWorkspace(true);
      await store.flush();
      // A downloaded update is installed on the way out; the next start runs the new version.
      if (updater.ready) await updater.install(false);
    });
  }
}

async function main(): Promise<void> {
  try {
    await store.init();
  } catch (e) {
    toast(`Start-up failed: ${e}`, 'error', 15000);
  }
  applyUiTheme(getTheme(store.settings.theme));
  const app = new App();
  (window as any).__shellman = app;
  await app.restoreWorkspace();
  updater.start();
}

void main();
