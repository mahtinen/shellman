import { collections, type RequestEntry } from './collections';
import { gitSync } from './gitSync';
import { childGroups, groupAndDescendants, groupColor, groupOptions, moveGroup, sessionColor } from './config';
import { connectionKindName, connectionLabel, connectionTarget, keyLabel } from './connection';
import { h } from './dom';
import { icons } from './icons';
import { showMenu, showMenuBelow, type MenuEntry } from './menu';
import type { OpenHow } from './requestActions';
import { requestFolder, requestName } from './requestFile';
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
  /** `shellId` overrides the session's shell; `plain` leaves out its startup command. */
  open(session: SavedSession, placement: SplitPlacement, shellId?: string, plain?: boolean): void;
  openGroup(group: Group): void;
  edit(session: SavedSession): void;
  /** `remember` ticks "Remember this session" to start with. */
  create(groupId: string | null, remember?: boolean): void;
  duplicate(session: SavedSession): void;
  remove(session: SavedSession): void;
  /** A new group in `parentId` (null = top level). */
  createGroup(parentId?: string | null): void;
  /** Imports sessions from another program (XShell), into `groupId` to start with. */
  importSessions(groupId: string | null): void;
  /** Name and colour. */
  editGroup(group: Group): void;
  removeGroup(group: Group): void;
  openFolder(session: SavedSession): void;
  /** The session's folder in a Files pane (files and what changed). */
  showFiles(session: SavedSession): void;
  /** Copies the ssh/telnet command for a connection. */
  copyCommand(session: SavedSession): void;
  /** Open terminals by saved session id; `null` holds the ones that belong to no session. */
  terminals(): Map<string | null, OpenTerminal[]>;
  focusTerminal(paneId: string): void;
  closeTerminal(paneId: string): void;
  terminalMenu(paneId: string, e: MouseEvent): void;
  settings(): void;
  shortcuts(): void;
  /** Requests of a group's linked folder. */
  openRequest(group: Group, path: string, how: OpenHow): void;
  requestMenu(group: Group, path: string, e: MouseEvent): void;
  folderMenu(group: Group, folder: string, e: MouseEvent): void;
  /** Group menu entries about requests (link a folder, new request, import, environments). */
  groupRequestEntries(group: Group): MenuEntry[];
  envMenu(group: Group, anchor: HTMLElement): void;
  /** Open request panes (`groupId/path`), those with unsaved changes, and the active one. */
  openRequests(): { open: string[]; dirty: string[]; active: string | null };
  /** Drag and drop within a linked folder: into `folder` ('' = its top). */
  moveRequest(group: Group, path: string, folder: string): void;
  moveFolder(group: Group, folder: string, target: string): void;
}

const REQUEST_DRAG = 'application/x-shellman-request';

const METHOD_LABEL: Record<string, string> = { DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' };

const SESSION_DRAG = 'application/x-shellman-session';
const GROUP_DRAG = 'application/x-shellman-group';

export class Sidebar {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement;
  private terms = new Map<string | null, OpenTerminal[]>();
  private termsKey = '';
  private dragging = false;
  /** The group being dragged (dragover can't read the drag data). */
  private draggedGroup: string | null = null;
  private refreshQueued = false;
  private requestsState: { open: Set<string>; dirty: Set<string>; active: string | null } = { open: new Set(), dirty: new Set(), active: null };
  /** The request or folder being dragged (dragover can't read the drag data). */
  private draggedItem: { groupId: string; path: string; folder: boolean } | null = null;

  constructor(private readonly actions: SidebarActions) {
    this.search = h('input', {
      class: 'input small sidebar-search',
      placeholder: 'Filter sessions and requests',
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
      const types = e.dataTransfer?.types ?? [];
      if (e.target === this.list && (types.includes(SESSION_DRAG) || types.includes(GROUP_DRAG))) e.preventDefault();
    });
    // Dropped below everything: out of its group, or (a group) to the top level.
    this.list.addEventListener('drop', (e) => {
      if (e.target !== this.list) return;
      const id = e.dataTransfer?.getData(SESSION_DRAG);
      const gid = e.dataTransfer?.getData(GROUP_DRAG);
      if (id) this.moveSession(id, null, null, false);
      else if (gid) store.update((c) => (c.groups = moveGroup(c.groups, gid, null)));
    });
    // A drop re-renders the list, so the source row may be gone before its dragend.
    this.list.addEventListener('drop', () => (this.dragging = false), true);
    this.list.addEventListener('contextmenu', (e) => {
      if (e.target !== this.list) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'New session…', icon: 'plus', action: () => actions.create(null) },
        { label: 'New group…', icon: 'folderPlus', action: () => actions.createGroup(null) },
        'separator',
        { label: 'Import sessions…', icon: 'globe', action: () => actions.importSessions(null) },
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
    return [s.name, s.cwd, s.command, s.connection ? connectionLabel(s.connection) : ''].some((f) => f.toLowerCase().includes(q));
  }

  private matchesRequest(r: RequestEntry): boolean {
    const q = this.search.value.trim().toLowerCase();
    return !q || [requestName(r.path), r.path, r.doc.url].some((f) => f.toLowerCase().includes(q));
  }

  /** Sessions in the order they are shown (subgroups before a group's own sessions). */
  private visibleSessions(): SavedSession[] {
    const { sessions, groups } = store.config;
    const filtering = !!this.search.value.trim();
    const out: SavedSession[] = [];
    const add = (parentId: string | null) => {
      for (const g of childGroups(groups, parentId)) {
        if (g.collapsed && !filtering) continue;
        add(g.id);
        out.push(...sessions.filter((s) => s.groupId === g.id && this.matches(s)));
      }
    };
    add(null);
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
      if (this.stateKey() !== this.termsKey) this.render();
    });
  }

  /** What the open terminals and requests look like, to re-render only when it changed. */
  private stateKey(): string {
    return JSON.stringify([[...this.actions.terminals()], this.actions.openRequests()]);
  }

  render(): void {
    this.terms = this.actions.terminals();
    const reqs = this.actions.openRequests();
    this.requestsState = { open: new Set(reqs.open), dirty: new Set(reqs.dirty), active: reqs.active };
    this.termsKey = this.stateKey();
    const { sessions, groups } = store.config;
    const filtering = !!this.search.value.trim();
    const rows: HTMLElement[] = [];

    for (const g of childGroups(groups, null)) rows.push(...this.groupRows(g, 0, filtering));
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
          h('button', { class: 'btn primary', onclick: () => this.actions.create(null, true) }, 'Add a session'),
          h('button', { class: 'btn', onclick: () => this.actions.importSessions(null) }, 'Import sessions'),
        ),
      );
    } else if (filtering && !rows.length) {
      rows.push(h('div', { class: 'sidebar-empty' }, 'No sessions match.'));
    }
    this.list.replaceChildren(...rows);
  }

  /**
   * A group's header, then (unless it is folded) its subgroups and its own sessions. While
   * filtering, only groups with a matching session somewhere inside are shown, unfolded.
   */
  private groupRows(g: Group, depth: number, filtering: boolean): HTMLElement[] {
    const { sessions, groups } = store.config;
    const inside = groupAndDescendants(groups, g.id);
    const members = sessions.filter((s) => s.groupId && inside.has(s.groupId));
    const requests = groups.filter((x) => inside.has(x.id) && x.folder).flatMap((x) => collections.get(x.id)?.requests ?? []);
    if (filtering && !members.some((s) => this.matches(s)) && !requests.some((r) => this.matchesRequest(r))) return [];
    const row = this.groupRow(g, members.length + requests.length, depth, members.length);
    if (g.collapsed && !filtering) return [row];
    const body = h(
      'div',
      // Rows inside indent by the depth (a CSS variable, inherited by the session rows).
      { class: 'group-body', style: `--depth:${depth}` },
      ...childGroups(groups, g.id).flatMap((c) => this.groupRows(c, depth + 1, filtering)),
      ...sessions.filter((s) => s.groupId === g.id && this.matches(s)).flatMap((s) => this.sessionRows(s)),
      ...(g.folder ? this.requestRows(g, filtering) : []),
    );
    if (!body.childElementCount) body.append(h('div', { class: 'group-empty' }, 'Drop sessions here'));
    return [row, body];
  }

  /** Where a dragged group lands on a group row: the middle half puts it inside. */
  private groupDropZone(e: DragEvent, row: HTMLElement): 'before' | 'into' | 'after' {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
  }

  private groupRow(g: Group, count: number, depth: number, sessions = count): HTMLElement {
    const color = groupColor(store.config.groups, g.id);
    const env = g.folder ? collections.env(g) : '';
    const envDoc = env ? collections.environment(g) : undefined;
    const row = h(
      'div',
      {
        class: `group-row${g.collapsed ? ' collapsed' : ''}`,
        draggable: true,
        title: `${g.name} (${count})${g.folder ? `\nRequests: ${g.folder}` : ''}`,
        style: `--depth:${depth}${color ? `;--group-color:${color}` : ''}`,
      },
      h('span', { class: 'chevron', html: g.collapsed ? icons.chevronRight : icons.chevronDown }),
      h('span', { class: 'group-icon', html: icons.folder }),
      h('span', { class: 'group-name' }, g.name),
      env
        ? h('button', {
            class: `env-pill${envDoc?.protected ? ' protected' : ''}`,
            title: `Environment: ${env}${envDoc?.protected ? ' (protected)' : ''}. Click to change.`,
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              this.actions.envMenu(g, e.currentTarget as HTMLElement);
            },
          }, env)
        : null,
      this.syncBadge(g),
      h('span', { class: 'group-count' }, String(count)),
    );
    row.addEventListener('click', () => store.update((c) => {
      const x = c.groups.find((y) => y.id === g.id);
      if (x) x.collapsed = !x.collapsed;
    }));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const entries: MenuEntry[] = [
        { label: 'Open all sessions in tabs', icon: 'play', disabled: !sessions, action: () => this.actions.openGroup(g) },
        { label: 'New session in group…', icon: 'plus', action: () => this.actions.create(g.id) },
        { label: 'New subgroup…', icon: 'folderPlus', action: () => this.actions.createGroup(g.id) },
        { label: 'Import sessions here…', icon: 'globe', action: () => this.actions.importSessions(g.id) },
        'separator',
        ...this.actions.groupRequestEntries(g),
        'separator',
        { label: 'Edit…', icon: 'edit', action: () => this.actions.editGroup(g) },
        { label: 'Delete group', icon: 'trash', danger: true, action: () => this.actions.removeGroup(g) },
      ];
      showMenu(e.clientX, e.clientY, entries);
    });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(GROUP_DRAG, g.id);
      row.classList.add('dragging');
      this.dragging = true;
      this.draggedGroup = g.id;
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      this.dragging = false;
      this.draggedGroup = null;
      this.refreshTerminals();
    });
    row.addEventListener('dragover', (e) => {
      const types = e.dataTransfer?.types ?? [];
      if (types.includes(SESSION_DRAG)) {
        e.preventDefault();
        row.classList.add('drop-into');
      } else if (types.includes(GROUP_DRAG)) {
        // Not onto itself or a group inside it.
        if (this.draggedGroup && groupAndDescendants(store.config.groups, this.draggedGroup).has(g.id)) return;
        e.preventDefault();
        const zone = this.groupDropZone(e, row);
        row.classList.toggle('drop-before', zone === 'before');
        row.classList.toggle('drop-into', zone === 'into');
        row.classList.toggle('drop-after', zone === 'after');
      }
    });
    if (g.folder) this.dropTarget(row, g, '');
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
        const zone = this.groupDropZone(e, row);
        store.update((c) => {
          if (zone === 'into') {
            c.groups = moveGroup(c.groups, gid, g.id);
            const target = c.groups.find((x) => x.id === g.id);
            if (target) target.collapsed = false;
          } else c.groups = moveGroup(c.groups, gid, g.parentId, g.id, zone === 'before');
        });
      }
    });
    return row;
  }

  /** The git sync state of a linked group; a click syncs (or settles a conflict). */
  private syncBadge(g: Group): HTMLElement | null {
    const b = gitSync.badge(g);
    if (!b) return null;
    return h(
      'button',
      {
        class: `sync-badge ${b.kind}`,
        title: b.title,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          const problem = gitSync.get(g.id)?.problem;
          if (problem?.kind === 'conflict') void gitSync.resolve(g, problem.files);
          else void gitSync.sync(g);
        },
      },
      b.text,
    );
  }

  /** The folders and requests of a linked group's folder, as a tree. */
  private requestRows(g: Group, filtering: boolean): HTMLElement[] {
    const c = collections.get(g.id);
    if (!c) return [h('div', { class: 'req-note' }, 'Reading the folder…')];
    if (c.error) return [h('div', { class: 'req-note error', title: c.error }, c.error)];
    const walk = (folder: string, level: number): HTMLElement[] => {
      const { folders, requests } = collections.children(g.id, folder);
      const out: HTMLElement[] = [];
      for (const f of folders) {
        const inside = c.requests.filter((r) => r.path.startsWith(`${f}/`));
        if (filtering && !inside.some((r) => this.matchesRequest(r))) continue;
        const folded = !filtering && g.folded.includes(f);
        out.push(this.folderRow(g, f, level, folded, inside.length));
        if (!folded) out.push(...walk(f, level + 1));
      }
      for (const r of requests) if (this.matchesRequest(r)) out.push(this.requestRow(g, r, level));
      return out;
    };
    const rows = walk('', 0);
    if (!c.requests.length && !filtering)
      rows.push(h('div', { class: 'req-note' }, 'No requests yet. Right-click the group for New request, Paste curl command or Import from Postman.'));
    return rows;
  }

  /** Whether the dragged request or folder may go into `folder` of `g`. */
  private canDrop(g: Group, folder: string): boolean {
    const d = this.draggedItem;
    if (!d || d.groupId !== g.id) return false;
    if (!d.folder) return requestFolder(d.path) !== folder;
    return folder !== d.path && !folder.startsWith(`${d.path}/`) && requestFolder(d.path) !== folder;
  }

  /** Lets a request or folder of the same group be dropped on `row`, into `folder`. */
  private dropTarget(row: HTMLElement, g: Group, folder: string): void {
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(REQUEST_DRAG) || !this.canDrop(g, folder)) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('drop-into');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-into'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-into');
      const d = this.draggedItem;
      if (!e.dataTransfer?.types.includes(REQUEST_DRAG) || !d || !this.canDrop(g, folder)) return;
      e.preventDefault();
      e.stopPropagation();
      this.draggedItem = null;
      if (d.folder) this.actions.moveFolder(g, d.path, folder);
      else this.actions.moveRequest(g, d.path, folder);
    });
  }

  /** Makes a request or folder row draggable. */
  private dragSource(row: HTMLElement, g: Group, path: string, folder: boolean): void {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer?.setData(REQUEST_DRAG, `${g.id}\n${path}`);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
      this.dragging = true;
      this.draggedItem = { groupId: g.id, path, folder };
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      this.dragging = false;
      this.draggedItem = null;
      this.refreshTerminals();
    });
  }

  private folderRow(g: Group, folder: string, level: number, folded: boolean, count: number): HTMLElement {
    const row = h(
      'div',
      { class: 'req-folder-row', style: `--level:${level}`, title: `${folder}\nDrag requests or folders here to move them in.` },
      h('span', { class: 'chevron', html: folded ? icons.chevronRight : icons.chevronDown }),
      h('span', { class: 'group-icon', html: icons.folder }),
      h('span', { class: 'group-name' }, folder.split('/').pop() ?? folder),
      h('span', { class: 'group-count' }, String(count)),
    );
    row.addEventListener('click', () => store.update((c) => {
      const x = c.groups.find((y) => y.id === g.id);
      if (x) x.folded = folded ? x.folded.filter((f) => f !== folder) : [...x.folded, folder];
    }));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.actions.folderMenu(g, folder, e);
    });
    this.dragSource(row, g, folder, true);
    this.dropTarget(row, g, folder);
    return row;
  }

  private requestRow(g: Group, r: RequestEntry, level: number): HTMLElement {
    const key = `${g.id}/${r.path}`;
    const st = this.requestsState;
    const method = r.doc.method;
    const row = h(
      'div',
      {
        class: `req-row${st.active === key ? ' active' : ''}${st.open.has(key) ? ' open' : ''}`,
        style: `--level:${level}`,
        title: [`${method} ${r.doc.url}`, r.path, r.doc.notes, '', 'Click: open · Double-click: keep open · Middle-click: split right · Drag: move to another folder'].filter((x, i) => x || i === 3).join('\n'),
        dataset: { request: r.path },
      },
      h('span', { class: `req-method m-${method}` }, METHOD_LABEL[method] ?? method),
      h('span', { class: 'req-name' }, requestName(r.path)),
      st.dirty.has(key) ? h('span', { class: 'dirty-dot', title: 'Unsaved changes' }) : null,
    );
    row.addEventListener('click', () => this.actions.openRequest(g, r.path, 'click'));
    row.addEventListener('dblclick', () => this.actions.openRequest(g, r.path, 'pin'));
    row.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    row.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.actions.openRequest(g, r.path, 'right');
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.actions.requestMenu(g, r.path, e);
    });
    this.dragSource(row, g, r.path, false);
    // Dropped on a request: into the folder it is in.
    this.dropTarget(row, g, requestFolder(r.path));
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
    const color = sessionColor(store.config.groups, s);
    const shell = s.shellId ? store.shells.find((x) => x.id === s.shellId)?.name : '';
    const conn = s.connection;
    const tooltip = conn
      ? [s.name, connectionLabel(conn), conn.passwordAuth ? 'Log in with a password' : conn.identityKey ? `Key: ${keyLabel(conn.identityKey)}` : '',
          conn.legacyAlgorithms ? 'Old algorithms allowed' : '', '', 'Click: connect in a new tab · Middle-click: split right']
      : [s.name, s.cwd, s.command ? `> ${s.command}` : '', shell ? `Shell: ${shell}` : '', '', s.command ? 'Click: new tab · Shift+click: plain terminal · Middle-click: split right' : 'Click: new tab · Middle-click: split right'];
    const row = h(
      'div',
      {
        class: `session-row${s.groupId ? ' in-group' : ''}`,
        draggable: true,
        style: color ? `--session-color:${color}` : undefined,
        title: tooltip.filter((x, i) => x || i === tooltip.length - 2).join('\n'),
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
      h('span', { class: 'session-icon', html: conn ? icons.globe : icons.terminal }),
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
        conn
          ? h('div', { class: 'session-sub' }, h('span', { class: 'session-cmd' }, conn.kind), h('span', { class: 'session-target' }, connectionTarget(conn)))
          : h('div', { class: 'session-sub' }, s.command ? h('span', { class: 'session-cmd' }, s.command) : null, h('span', null, s.cwd)),
      ),
      h(
        'div',
        { class: 'session-actions' },
        this.actionBtn('splitRight', 'Open in split right', () => this.actions.open(s, 'right')),
        this.actionBtn('splitDown', 'Open in split down', () => this.actions.open(s, 'down')),
        conn
          ? null
          : this.actionBtn('chevronDown', s.command ? 'Open a plain terminal or another shell' : 'Open with another shell', (e) =>
              showMenuBelow(e.currentTarget as HTMLElement, this.openEntries(s)),
            ),
        this.actionBtn('edit', 'Edit', () => this.actions.edit(s)),
      ),
    );
    // Shift+click: the session's folder and shell without its startup command.
    row.addEventListener('click', (e) => this.actions.open(s, 'tab', undefined, e.shiftKey));
    row.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    row.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.actions.open(s, 'right');
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: conn ? 'Connect in new tab' : 'Open in new tab', icon: conn ? 'globe' : 'terminal', action: () => this.actions.open(s, 'tab') },
        { label: 'Open in split right', icon: 'splitRight', action: () => this.actions.open(s, 'right') },
        { label: 'Open in split down', icon: 'splitDown', action: () => this.actions.open(s, 'down') },
        'separator',
        ...(conn ? [{ label: `Copy ${connectionKindName(conn.kind)} command`, icon: 'copy' as const, action: () => this.actions.copyCommand(s) }] : this.openEntries(s)),
        'separator',
        { label: 'Edit…', icon: 'edit', action: () => this.actions.edit(s) },
        { label: 'Duplicate', icon: 'duplicate', action: () => this.actions.duplicate(s) },
        {
          label: 'Move to group',
          icon: 'folder',
          submenu: [
            { label: '(No group)', disabled: !s.groupId, action: () => this.moveSession(s.id, null, null, false) },
            ...groupOptions(store.config.groups).map((g) => ({
              label: g.label,
              disabled: g.id === s.groupId,
              action: () => this.moveSession(s.id, g.id, null, false),
            })),
          ],
        },
        ...(conn
          ? []
          : [
              { label: 'Show files', icon: 'files' as const, action: () => this.actions.showFiles(s) },
              { label: 'Open folder in Explorer', icon: 'openExternal' as const, action: () => this.actions.openFolder(s) },
            ]),
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

  /** Plain terminals (folder and shell, no startup command) and other shells for a session. */
  private openEntries(s: SavedSession): MenuEntry[] {
    const withShell = shellEntries((id) => this.actions.open(s, 'tab', id));
    if (!s.command) return [{ label: 'Open with shell', icon: 'terminal', submenu: withShell }];
    const cmd = s.command.length > 24 ? `${s.command.slice(0, 23)}…` : s.command;
    return [
      { label: 'Open plain terminal', icon: 'terminal', shortcut: 'Shift+Click', action: () => this.actions.open(s, 'tab', undefined, true) },
      { label: 'Plain terminal with', icon: 'terminal', submenu: shellEntries((id) => this.actions.open(s, 'tab', id, true)) },
      { label: `Run ${cmd} with`, icon: 'play', submenu: withShell },
    ];
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
