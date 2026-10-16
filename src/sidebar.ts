import { h } from './dom';
import { icons } from './icons';
import { showMenu, showMenuBelow, type MenuEntry } from './menu';
import { shellEntries } from './sessionEditor';
import { store } from './store';
import type { Group, SavedSession, SplitPlacement } from './types';

/** An open terminal pane, as listed under its session in the sidebar tree. */
export interface OpenTerminal {
  paneId: string;
  /** 1-based tab position (matches Alt+1…9). */
  tab: number;
  label: string;
  /** Shell name, omitted when it is already the label. */
  shell: string;
  tooltip: string;
  active: boolean;
  status: '' | 'unread' | 'busy' | 'progress' | 'bell' | 'exited';
}

export interface SidebarActions {
  /** `shellId` overrides the session's shell. */
  open(session: SavedSession, placement: SplitPlacement, shellId?: string): void;
  openGroup(group: Group): void;
  edit(session: SavedSession): void;
  create(groupId: string | null): void;
  duplicate(session: SavedSession): void;
  remove(session: SavedSession): void;
  createGroup(): void;
  renameGroup(group: Group): void;
  removeGroup(group: Group): void;
  openFolder(session: SavedSession): void;
  /** Open terminals by saved session id; `null` holds the ones that belong to no session. */
  terminals(): Map<string | null, OpenTerminal[]>;
  focusTerminal(paneId: string): void;
  closeTerminal(paneId: string): void;
  terminalMenu(paneId: string, e: MouseEvent): void;
  settings(): void;
  shortcuts(): void;
}

const SESSION_DRAG = 'application/x-shellman-session';
const GROUP_DRAG = 'application/x-shellman-group';

export class Sidebar {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement;
  private terms = new Map<string | null, OpenTerminal[]>();
  private termsKey = '';
  private dragging = false;
  private refreshQueued = false;

  constructor(private readonly actions: SidebarActions) {
    this.search = h('input', {
      class: 'input small sidebar-search',
      placeholder: 'Filter sessions',
      spellcheck: false,
      oninput: () => this.render(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          this.search.value = '';
          this.render();
        } else if (e.key === 'Enter') {
          const first = this.visibleSessions()[0];
          if (first) actions.open(first, 'tab');
        }
      },
    });
    this.list = h('div', { class: 'sidebar-list' });
    this.list.addEventListener('dragover', (e) => {
      if (e.target === this.list && e.dataTransfer?.types.includes(SESSION_DRAG)) e.preventDefault();
    });
    this.list.addEventListener('drop', (e) => {
      if (e.target !== this.list) return;
      const id = e.dataTransfer?.getData(SESSION_DRAG);
      if (id) this.moveSession(id, null, null, false);
    });
    // A drop re-renders the list, so the source row may be gone before its dragend.
    this.list.addEventListener('drop', () => (this.dragging = false), true);
    this.list.addEventListener('contextmenu', (e) => {
      if (e.target !== this.list) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'New session…', icon: 'plus', action: () => actions.create(null) },
        { label: 'New group…', icon: 'folderPlus', action: () => actions.createGroup() },
      ]);
    });

    this.el = h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'sidebar-header' },
        h('span', { class: 'sidebar-title' }, 'Sessions'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: 'New session', html: icons.plus, onclick: () => actions.create(null) }),
        h('button', { class: 'icon-btn', title: 'New group', html: icons.folderPlus, onclick: () => actions.createGroup() }),
      ),
      h('div', { class: 'sidebar-search-wrap' }, this.search),
      this.list,
      h(
        'div',
        { class: 'sidebar-footer' },
        h('button', { class: 'footer-btn', onclick: () => actions.settings() }, h('span', { html: icons.gear }), 'Settings'),
        h('button', { class: 'footer-btn', onclick: () => actions.shortcuts() }, h('span', { html: icons.keyboard }), 'Shortcuts'),
      ),
    );
  }

  focusSearch(): void {
    this.search.focus();
    this.search.select();
  }

  private matches(s: SavedSession): boolean {
    const q = this.search.value.trim().toLowerCase();
    if (!q) return true;
    return [s.name, s.cwd, s.command].some((f) => f.toLowerCase().includes(q));
  }

  private visibleSessions(): SavedSession[] {
    const { sessions, groups } = store.config;
    const filtering = !!this.search.value.trim();
    const out: SavedSession[] = [];
    for (const g of groups) {
      if (g.collapsed && !filtering) continue;
      out.push(...sessions.filter((s) => s.groupId === g.id && this.matches(s)));
    }
    out.push(...sessions.filter((s) => !s.groupId && this.matches(s)));
    return out;
  }

  /** Re-renders when the open terminals changed (cheap to call often). */
  refreshTerminals(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      // Re-rendering mid-drag would drop the drag source and drop targets.
      if (this.dragging) return;
      if (JSON.stringify([...this.actions.terminals()]) !== this.termsKey) this.render();
    });
  }

  render(): void {
    this.terms = this.actions.terminals();
    this.termsKey = JSON.stringify([...this.terms]);
    const { sessions, groups } = store.config;
    const filtering = !!this.search.value.trim();
    const rows: HTMLElement[] = [];

    for (const g of groups) {
      const members = sessions.filter((s) => s.groupId === g.id);
      const shown = members.filter((s) => this.matches(s));
      if (filtering && !shown.length) continue;
      rows.push(this.groupRow(g, members.length));
      if (!g.collapsed || filtering) {
        const body = h('div', { class: 'group-body' }, ...shown.flatMap((s) => this.sessionRows(s)));
        if (!shown.length) body.append(h('div', { class: 'group-empty' }, 'Drop sessions here'));
        rows.push(body);
      }
    }
    const ungrouped = sessions.filter((s) => !s.groupId && this.matches(s));
    rows.push(...ungrouped.flatMap((s) => this.sessionRows(s)));

    const other = this.terms.get(null) ?? [];
    if (other.length && !filtering) {
      const folded = store.settings.otherTerminalsCollapsed;
      const head = h(
        'div',
        { class: `terms-head${folded ? ' collapsed' : ''}`, title: 'Terminals outside the saved session directories' },
        h('span', { class: 'chevron', html: folded ? icons.chevronRight : icons.chevronDown }),
        h('span', { class: 'group-icon', html: icons.terminal }),
        h('span', { class: 'group-name' }, 'Other terminals'),
        h('span', { class: 'group-count' }, String(other.length)),
      );
      head.addEventListener('click', () => store.update((c) => (c.settings.otherTerminalsCollapsed = !c.settings.otherTerminalsCollapsed)));
      rows.push(head);
      if (!folded) rows.push(this.termTree(other, false));
    }

    if (!sessions.length && !groups.length) {
      rows.push(
        h(
          'div',
          { class: 'sidebar-empty' },
          h('p', null, 'Save the directories you work in, with an optional startup command like ', h('code', null, 'claude'), '.'),
          h('button', { class: 'btn primary', onclick: () => this.actions.create(null) }, 'Add a session'),
        ),
      );
    } else if (filtering && !rows.length) {
      rows.push(h('div', { class: 'sidebar-empty' }, 'No sessions match.'));
    }
    this.list.replaceChildren(...rows);
  }

  private groupRow(g: Group, count: number): HTMLElement {
    const row = h(
      'div',
      { class: `group-row${g.collapsed ? ' collapsed' : ''}`, draggable: true, title: `${g.name} (${count})` },
      h('span', { class: 'chevron', html: g.collapsed ? icons.chevronRight : icons.chevronDown }),
      h('span', { class: 'group-icon', html: icons.folder }),
      h('span', { class: 'group-name' }, g.name),
      h('span', { class: 'group-count' }, String(count)),
    );
    row.addEventListener('click', () => store.update((c) => {
      const x = c.groups.find((y) => y.id === g.id);
      if (x) x.collapsed = !x.collapsed;
    }));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const entries: MenuEntry[] = [
        { label: 'Open all in tabs', icon: 'play', disabled: !count, action: () => this.actions.openGroup(g) },
        { label: 'New session in group…', icon: 'plus', action: () => this.actions.create(g.id) },
        'separator',
        { label: 'Rename…', icon: 'edit', action: () => this.actions.renameGroup(g) },
        { label: 'Delete group', icon: 'trash', danger: true, action: () => this.actions.removeGroup(g) },
      ];
      showMenu(e.clientX, e.clientY, entries);
    });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(GROUP_DRAG, g.id);
      row.classList.add('dragging');
      this.dragging = true;
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      this.dragging = false;
      this.refreshTerminals();
    });
    row.addEventListener('dragover', (e) => {
      const types = e.dataTransfer?.types ?? [];
      if (types.includes(SESSION_DRAG)) {
        e.preventDefault();
        row.classList.add('drop-into');
      } else if (types.includes(GROUP_DRAG)) {
        e.preventDefault();
        const before = this.isUpperHalf(e, row);
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-into', 'drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-into', 'drop-before', 'drop-after');
      const sid = e.dataTransfer?.getData(SESSION_DRAG);
      const gid = e.dataTransfer?.getData(GROUP_DRAG);
      if (sid) {
        e.preventDefault();
        this.moveSession(sid, g.id, null, false);
      } else if (gid && gid !== g.id) {
        e.preventDefault();
        const before = this.isUpperHalf(e, row);
        store.update((c) => {
          const moving = c.groups.find((x) => x.id === gid);
          if (!moving) return;
          c.groups = c.groups.filter((x) => x !== moving);
          const at = c.groups.findIndex((x) => x.id === g.id) + (before ? 0 : 1);
          c.groups.splice(at, 0, moving);
        });
      }
    });
    return row;
  }

  /** The session row followed by the tree of its open terminals. */
  private sessionRows(s: SavedSession): HTMLElement[] {
    const terms = this.terms.get(s.id) ?? [];
    const row = this.sessionRow(s, terms.length);
    if (!terms.length || s.collapsed) return [row];
    return [row, this.termTree(terms, !!s.groupId)];
  }

  private toggleCollapsed(id: string): void {
    store.update((c) => {
      const x = c.sessions.find((y) => y.id === id);
      if (x) x.collapsed = !x.collapsed;
    });
  }

  private termTree(terms: OpenTerminal[], inGroup: boolean): HTMLElement {
    return h('div', { class: `term-tree${inGroup ? ' in-group' : ''}`, role: 'tree' }, ...terms.map((t) => this.termRow(t)));
  }

  private termRow(t: OpenTerminal): HTMLElement {
    const row = h(
      'div',
      {
        class: `term-row${t.active ? ' active' : ''}${t.status === 'exited' ? ' exited' : ''}`,
        role: 'treeitem',
        title: t.tooltip,
        dataset: { pane: t.paneId },
      },
      h('span', { class: 'tab-status', dataset: { state: t.status === 'exited' ? '' : t.status }, html: t.status === 'bell' ? icons.bell : '' }),
      h('span', { class: 'term-tab' }, String(t.tab)),
      h('span', { class: 'term-label' }, t.label),
      t.shell ? h('span', { class: 'term-shell' }, t.shell) : null,
      h('button', {
        class: 'icon-btn small term-close',
        title: 'Close terminal',
        html: icons.x,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          this.actions.closeTerminal(t.paneId);
        },
      }),
    );
    row.addEventListener('click', () => this.actions.focusTerminal(t.paneId));
    row.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    row.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.actions.closeTerminal(t.paneId);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.actions.terminalMenu(t.paneId, e);
    });
    return row;
  }

  private sessionRow(s: SavedSession, running: number): HTMLElement {
    const shell = s.shellId ? store.shells.find((x) => x.id === s.shellId)?.name : '';
    const row = h(
      'div',
      {
        class: `session-row${s.groupId ? ' in-group' : ''}`,
        draggable: true,
        style: s.color ? `--session-color:${s.color}` : undefined,
        title: [s.name, s.cwd, s.command ? `> ${s.command}` : '', shell ? `Shell: ${shell}` : '', '', 'Click: new tab · Middle-click: split right'].filter((x, i) => x || i === 4).join('\n'),
      },
      // Like a group's chevron, but only when there are open terminals to fold.
      running
        ? h('span', {
            class: 'chevron session-chevron',
            title: s.collapsed ? 'Show open terminals' : 'Hide open terminals',
            html: s.collapsed ? icons.chevronRight : icons.chevronDown,
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              this.toggleCollapsed(s.id);
            },
          })
        : h('span', { class: 'chevron session-chevron' }),
      h('span', { class: 'session-icon', html: icons.terminal }),
      h(
        'div',
        { class: 'session-text' },
        h(
          'div',
          { class: 'session-name' },
          h('span', null, s.name),
          running
            ? h('span', { class: `badge${s.collapsed ? ' folded' : ''}`, title: `${running} open terminal${running > 1 ? 's' : ''}` }, String(running))
            : null,
        ),
        h('div', { class: 'session-sub' }, s.command ? h('span', { class: 'session-cmd' }, s.command) : null, h('span', null, s.cwd)),
      ),
      h(
        'div',
        { class: 'session-actions' },
        this.actionBtn('splitRight', 'Open in split right', () => this.actions.open(s, 'right')),
        this.actionBtn('splitDown', 'Open in split down', () => this.actions.open(s, 'down')),
        this.actionBtn('chevronDown', 'Open with another shell', (e) =>
          showMenuBelow(e.currentTarget as HTMLElement, shellEntries((id) => this.actions.open(s, 'tab', id))),
        ),
        this.actionBtn('edit', 'Edit', () => this.actions.edit(s)),
      ),
    );
    row.addEventListener('click', () => this.actions.open(s, 'tab'));
    row.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    row.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.actions.open(s, 'right');
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Open in new tab', icon: 'terminal', action: () => this.actions.open(s, 'tab') },
        { label: 'Open in split right', icon: 'splitRight', action: () => this.actions.open(s, 'right') },
        { label: 'Open in split down', icon: 'splitDown', action: () => this.actions.open(s, 'down') },
        { label: 'Open with shell', icon: 'terminal', submenu: shellEntries((id) => this.actions.open(s, 'tab', id)) },
        'separator',
        { label: 'Edit…', icon: 'edit', action: () => this.actions.edit(s) },
        { label: 'Duplicate', icon: 'duplicate', action: () => this.actions.duplicate(s) },
        {
          label: 'Move to group',
          icon: 'folder',
          submenu: [
            { label: '(No group)', disabled: !s.groupId, action: () => this.moveSession(s.id, null, null, false) },
            ...store.config.groups.map((g) => ({
              label: g.name,
              disabled: g.id === s.groupId,
              action: () => this.moveSession(s.id, g.id, null, false),
            })),
          ],
        },
        { label: 'Open folder in Explorer', icon: 'openExternal', action: () => this.actions.openFolder(s) },
        'separator',
        { label: 'Delete', icon: 'trash', danger: true, action: () => this.actions.remove(s) },
      ]);
    });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(SESSION_DRAG, s.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
      this.dragging = true;
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      this.dragging = false;
      this.refreshTerminals();
    });
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(SESSION_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      const before = this.isUpperHalf(e, row);
      row.classList.toggle('drop-before', before);
      row.classList.toggle('drop-after', !before);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-before', 'drop-after');
      const id = e.dataTransfer?.getData(SESSION_DRAG);
      if (!id || id === s.id) return;
      e.preventDefault();
      e.stopPropagation();
      this.moveSession(id, s.groupId, s.id, this.isUpperHalf(e, row));
    });
    return row;
  }

  private actionBtn(icon: keyof typeof icons, title: string, fn: (e: MouseEvent) => void): HTMLElement {
    return h('button', {
      class: 'icon-btn small',
      title,
      html: icons[icon],
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        fn(e);
      },
    });
  }

  private isUpperHalf(e: DragEvent, el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  }

  /** Moves a session into `groupId`, before/after `targetId` (or to the end). */
  private moveSession(id: string, groupId: string | null, targetId: string | null, before: boolean): void {
    store.update((c) => {
      const moving = c.sessions.find((x) => x.id === id);
      if (!moving) return;
      moving.groupId = groupId;
      c.sessions = c.sessions.filter((x) => x !== moving);
      let at = c.sessions.length;
      if (targetId) {
        const t = c.sessions.findIndex((x) => x.id === targetId);
        if (t >= 0) at = t + (before ? 0 : 1);
      }
      c.sessions.splice(at, 0, moving);
    });
  }
}
