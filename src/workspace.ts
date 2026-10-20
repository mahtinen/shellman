import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { baseName, ownerSession, sessionColor, uid } from './config';
import { choiceDialog, confirmDialog, toast } from './dialogs';
import { h } from './dom';
import { icons } from './icons';
import type { Match } from './keys';
import {
  contains,
  equalize,
  insertNode,
  leaf,
  neighbor,
  paneIds,
  removePane,
  resizeAt,
  splitPane,
  type FocusDirection,
  type LayoutNode,
  type SplitNode,
} from './layout';
import { Pane, type PaneHost } from './pane';
import { isTerminal, type HeaderAction, type WorkspacePane } from './panes';
import type { RequestHost, RequestPane } from './requestPane';
import { layoutFromSnapshot, snapshotNode, type RequestRef, type SnapshotLeaf, type TabSnapshot, type WorkspaceSnapshot } from './snapshot';
import { store } from './store';
import type { LaunchSpec, SavedSession, SplitPlacement } from './types';

export interface Tab {
  id: string;
  root: LayoutNode;
  activePaneId: string;
  customTitle: string | null;
  zoomedPaneId: string | null;
  el: HTMLDivElement;
  tabEl: HTMLDivElement | null;
  /** Output arrived while the tab was in the background. */
  unread: boolean;
  /** Output is arriving right now while in the background. */
  busy: boolean;
  bell: boolean;
  hiddenAt: number;
  /** A preview: the next request opened with a single click replaces it (until it is edited). */
  preview: boolean;
}

export interface WorkspaceEvents {
  /** Tabs or panes were added/removed/activated. */
  onChange(): void;
  /** The active pane or its title/cwd/state changed. */
  onActiveInfo(pane: WorkspacePane | null): void;
  onShortcut(match: Match): boolean;
  onPaneContextMenu(pane: WorkspacePane, e: MouseEvent): void;
  onTabContextMenu(tab: Tab, e: MouseEvent): void;
  /** Some tab or pane's label, cwd, state or activity changed. */
  onTerminalsInfo(): void;
}

/** Max simultaneous WebGL renderers; browsers cap live contexts at ~16. */
const MAX_GPU_PANES = 8;
const BUSY_WINDOW_MS = 1500;
const DRAG_TYPE = 'application/x-shellman-tab';

/** Where a dragged tab lands on a pane: the half of it nearest the pointer. */
interface PaneDrop {
  paneId: string;
  side: FocusDirection;
}

export class Workspace implements PaneHost, RequestHost {
  tabs: Tab[] = [];
  activeTabId: string | null = null;
  readonly panes = new Map<string, WorkspacePane>();
  private readonly paneTab = new Map<string, Tab>();
  private gpuOrder: string[] = [];
  readonly windowsBuild = store.sys.windowsBuild;
  readonly homeDir = store.sys.homeDir;
  /** Set while an update is being installed: its ended terminals must not close their panes. */
  keepPanesOnExit = false;
  /** The tab being dragged, which can be dropped onto a pane of the visible tab to join its split. */
  private draggingTab: Tab | null = null;
  private readonly dropEl = h('div', { class: 'pane-drop', hidden: true });
  /** The request pane a single click opened in a split ("Open requests in: split"); the next one replaces it. */
  private previewSplitId: string | null = null;
  /** Makes request panes (set by the app, which knows the linked folders). */
  requestFactory: ((ref: RequestRef, host: RequestHost) => RequestPane | null) | null = null;

  constructor(
    private readonly tabsEl: HTMLElement,
    private readonly areaEl: HTMLElement,
    private readonly events: WorkspaceEvents,
  ) {
    window.setInterval(() => this.tickActivity(), 500);
    this.areaEl.append(this.dropEl);
    this.areaEl.addEventListener('dragover', (e) => {
      const drop = this.paneDrop(e);
      this.showDrop(drop);
      if (!drop) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    this.areaEl.addEventListener('dragleave', (e) => {
      if (!this.areaEl.contains(e.relatedTarget as Node | null)) this.showDrop(null);
    });
    this.areaEl.addEventListener('drop', (e) => {
      const drop = this.paneDrop(e);
      const tab = this.draggingTab;
      this.showDrop(null);
      if (!drop || !tab) return;
      e.preventDefault();
      this.moveTabInto(tab, drop.paneId, drop.side);
    });
  }

  // ---- PaneHost -------------------------------------------------------

  settings = () => store.settings;
  resolveShell = (id: string) => store.resolveShell(id);

  onFocus(pane: WorkspacePane): void {
    const tab = this.paneTab.get(pane.id);
    if (tab && tab.activePaneId !== pane.id) this.setActivePane(pane.id, false);
  }

  onInfoChange(pane: WorkspacePane): void {
    const tab = this.paneTab.get(pane.id);
    if (!tab) return;
    this.updateTabEl(tab);
    if (this.activePane() === pane) this.events.onActiveInfo(pane);
  }

  onOutput(): void {
    // Background activity is sampled in tickActivity() to keep this hot path cheap.
  }

  onBell(pane: Pane): void {
    this.attention(pane, null);
  }

  onNotify(pane: Pane, title: string, body: string): void {
    this.attention(pane, [title, body].filter(Boolean).join(': ') || 'Notification');
  }

  onExit(pane: Pane, code: number | null): void {
    if (this.keepPanesOnExit) return;
    const mode = store.settings.closeOnExit;
    if (mode === 'always' || (mode === 'graceful' && code === 0)) this.closePane(pane.id);
  }

  onConnectionChange(pane: Pane): void {
    const conn = pane.connection;
    const session = store.session(pane.spec.sessionId);
    if (!conn || !session?.connection) return;
    // Only the flag: the pane's copy may also hold a user name typed at "login as:", and the
    // session may have been edited since the pane opened.
    store.update((c) => {
      const s = c.sessions.find((x) => x.id === session.id);
      if (s?.connection) s.connection.legacyAlgorithms = conn.legacyAlgorithms;
    });
    if (conn.legacyAlgorithms && !session.connection.legacyAlgorithms) toast(`"${session.name}" now allows old algorithms (Edit → SSH options).`);
  }

  onEdited(pane: WorkspacePane): void {
    const tab = this.paneTab.get(pane.id);
    if (tab?.preview) this.pin(tab);
    if (this.previewSplitId === pane.id) this.previewSplitId = null;
  }

  onShortcut(_pane: WorkspacePane, match: Match): boolean {
    return this.events.onShortcut(match);
  }

  onContextMenu(pane: WorkspacePane, e: MouseEvent): void {
    this.setActivePane(pane.id, true);
    this.events.onPaneContextMenu(pane, e);
  }

  onHeaderAction(pane: WorkspacePane, action: HeaderAction): void {
    if (action === 'zoom') this.toggleZoom(pane.id);
    else if (action === 'tab') this.moveToNewTab(pane.id);
    else void this.requestClosePane(pane.id);
  }

  // ---- queries --------------------------------------------------------

  get activeTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  activePane(): WorkspacePane | null {
    const tab = this.activeTab;
    return tab ? (this.panes.get(tab.activePaneId) ?? null) : null;
  }

  /** The active pane when it is a terminal. */
  activeTerminal(): Pane | null {
    const pane = this.activePane();
    return isTerminal(pane) ? pane : null;
  }

  tabOf(pane: WorkspacePane): Tab | undefined {
    return this.paneTab.get(pane.id);
  }

  panesOf(tab: Tab): WorkspacePane[] {
    return paneIds(tab.root)
      .map((id) => this.panes.get(id))
      .filter((p): p is WorkspacePane => !!p);
  }

  tabLabel(tab: Tab): string {
    const pane = this.panes.get(tab.activePaneId);
    return tab.customTitle ?? (pane ? this.paneLabel(pane) : 'Terminal');
  }

  /** The saved session a pane is in now: it follows `cd` (see ownerSession). A connection stays with its session. */
  ownerOf(pane: WorkspacePane): SavedSession | undefined {
    if (!isTerminal(pane)) return undefined;
    if (pane.connection) return store.session(pane.spec.sessionId);
    return ownerSession(store.config.sessions, pane.cwd, pane.spec.sessionId);
  }

  /** Colour of the session a pane is in now (tab stripe and pane header). */
  private paneColor(pane: WorkspacePane, owner = this.ownerOf(pane)): string {
    return owner ? sessionColor(store.config.groups, owner) : pane.color;
  }

  /** A pane's name, shared by its tab and its entry in the sidebar tree. */
  paneLabel(pane: WorkspacePane): string {
    if (!isTerminal(pane)) return pane.name;
    const owner = this.ownerOf(pane);
    // Claude Code animates a spinner at the start of its title; leave it out to keep the label stable.
    const title = pane.title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    // Claude Code's default title says nothing about the task, so the session name is more useful.
    // Git Bash and other shells put the prompt location there ("MINGW64:/c/repo", "user@host: ~/repo").
    const useful = /^claude code$/i.test(title) || /^(MINGW(32|64)|MSYS|UCRT64|CLANG64)\b|^[\w.-]+@[\w.-]+:/.test(title) ? '' : title;
    // The session's own startup command is implied by its name; a different one tells terminals apart.
    const command = pane.spec.command !== owner?.command ? pane.spec.command : '';
    return useful || command || owner?.name || pane.name || 'Terminal';
  }

  /** Re-labels every tab (after sessions were renamed or moved). */
  refreshTabs(): void {
    for (const t of this.tabs) this.updateTabEl(t);
  }

  /**
   * Spec for a new terminal next to `pane`: same shell and directory. For a connection, a duplicate
   * connects to the same host again and anything else is a local shell in the default directory.
   */
  specFrom(pane: Pane, rerunCommand: boolean): LaunchSpec {
    // A duplicate gets its own Claude conversation rather than sharing this one.
    if (rerunCommand) return { ...pane.spec, cwd: pane.cwd, claudeId: undefined, claudeStarted: undefined };
    if (pane.connection) {
      const cwd = store.defaultCwd();
      return { name: baseName(cwd), cwd, command: '', shellId: '', env: {}, color: '', sessionId: null };
    }
    return {
      name: baseName(pane.cwd),
      cwd: pane.cwd,
      command: '',
      shellId: pane.spec.shellId,
      env: {},
      color: '',
      sessionId: null,
    };
  }

  // ---- opening --------------------------------------------------------

  open(spec: LaunchSpec, placement: SplitPlacement = 'tab', targetPaneId?: string): Pane {
    const pane = new Pane(spec, this);
    this.add(pane, placement, targetPaneId);
    return pane;
  }

  /** Shows a new pane in a tab of its own, or split next to `targetPaneId` (default: the active pane). */
  add(pane: WorkspacePane, placement: SplitPlacement = 'tab', targetPaneId?: string): void {
    this.panes.set(pane.id, pane);
    const targetTab = targetPaneId ? this.paneTab.get(targetPaneId) : this.activeTab;

    let tab: Tab;
    if (placement === 'tab' || !targetTab) {
      tab = this.createTab(leaf(pane.id), pane.id);
    } else {
      tab = targetTab;
      const target = targetPaneId ?? tab.activePaneId;
      tab.zoomedPaneId = null;
      tab.preview = false;
      tab.root = splitPane(tab.root, target, pane.id, placement === 'right' ? 'row' : 'column');
    }
    this.paneTab.set(pane.id, tab);

    this.renderTabBar();
    this.activateTab(tab.id, false);
    this.renderLayout(tab);
    pane.mount();
    this.setActivePane(pane.id, true);
    this.ensureGpu(tab);
    void pane.start();
    this.events.onChange();
  }

  /** Adds an empty tab after `after` (default: the active tab). */
  private createTab(root: LayoutNode, activePaneId: string, after = this.activeTab): Tab {
    const tab: Tab = {
      id: uid('t-'),
      root,
      activePaneId,
      customTitle: null,
      zoomedPaneId: null,
      el: h('div', { class: 'tab-content', hidden: true }),
      tabEl: null,
      unread: false,
      busy: false,
      bell: false,
      hiddenAt: 0,
      preview: false,
    };
    this.areaEl.append(tab.el);
    const afterIdx = after ? this.tabs.indexOf(after) : -1;
    this.tabs.splice(afterIdx >= 0 ? afterIdx + 1 : this.tabs.length, 0, tab);
    return tab;
  }

  /** Takes a pane out of its split into a tab of its own, next to the tab it was in. The terminal keeps running. */
  moveToNewTab(paneId: string): void {
    const pane = this.panes.get(paneId);
    const from = this.paneTab.get(paneId);
    const root = from && removePane(from.root, paneId);
    if (!pane || !from || !root) return;
    from.root = root;
    from.zoomedPaneId = null;
    if (from.activePaneId === paneId) from.activePaneId = paneIds(root)[0];
    this.renderLayout(from);

    const tab = this.createTab(leaf(paneId), paneId, from);
    this.paneTab.set(paneId, tab);
    this.renderTabBar();
    this.activateTab(tab.id, false);
    this.renderLayout(tab);
    this.setActivePane(paneId, true);
    this.events.onChange();
  }

  /** Moves a whole tab, with its splits, next to `targetPaneId` in another tab. The terminals keep running. */
  moveTabInto(source: Tab, targetPaneId: string, side: FocusDirection): void {
    this.moveInto(source, source.root, null, targetPaneId, side, source.activePaneId);
  }

  /** Moves one terminal next to `targetPaneId` in another tab; its old tab closes if it was alone there. */
  movePaneInto(paneId: string, targetPaneId: string, side: FocusDirection): void {
    const source = this.paneTab.get(paneId);
    if (source) this.moveInto(source, leaf(paneId), removePane(source.root, paneId), targetPaneId, side, paneId);
  }

  /** `moved` leaves `source` (which keeps `rest`, or closes when it is null) and joins the target's tab. */
  private moveInto(source: Tab, moved: LayoutNode, rest: LayoutNode | null, targetPaneId: string, side: FocusDirection, focusId: string): void {
    const target = this.paneTab.get(targetPaneId);
    if (!target || target === source) return;
    target.zoomedPaneId = null;
    target.preview = false;
    target.root = insertNode(target.root, targetPaneId, moved, side === 'left' || side === 'right' ? 'row' : 'column', side === 'left' || side === 'up');
    for (const id of paneIds(moved)) this.paneTab.set(id, target);
    this.renderLayout(target);
    this.activateTab(target.id, false);
    if (rest) {
      source.root = rest;
      source.zoomedPaneId = null;
      if (!contains(rest, source.activePaneId)) source.activePaneId = paneIds(rest)[0];
      this.renderLayout(source);
      this.updateTabEl(source);
    } else {
      this.detachTab(source);
    }
    this.setActivePane(focusId, true);
    this.events.onChange();
  }

  /** The pane under a dragged tab, and which half of it the tab would take. */
  private paneDrop(e: DragEvent): PaneDrop | null {
    const tab = this.activeTab;
    if (!this.draggingTab || !tab || this.draggingTab === tab) return null;
    const el = (e.target as Element | null)?.closest<HTMLElement>('.pane');
    const paneId = el?.dataset.pane;
    if (!el || !paneId || this.paneTab.get(paneId) !== tab) return null;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edges: [FocusDirection, number][] = [['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]];
    return { paneId, side: edges.reduce((a, b) => (b[1] < a[1] ? b : a))[0] };
  }

  private showDrop(drop: PaneDrop | null): void {
    const el = drop && this.panes.get(drop.paneId)?.el;
    this.dropEl.hidden = !el;
    if (!drop || !el) return;
    const r = el.getBoundingClientRect();
    const area = this.areaEl.getBoundingClientRect();
    const half = drop.side === 'left' || drop.side === 'right' ? { w: r.width / 2, h: r.height } : { w: r.width, h: r.height / 2 };
    Object.assign(this.dropEl.style, {
      left: `${r.left - area.left + (drop.side === 'right' ? half.w : 0)}px`,
      top: `${r.top - area.top + (drop.side === 'down' ? half.h : 0)}px`,
      width: `${half.w}px`,
      height: `${half.h}px`,
    });
  }

  // ---- saving and reopening ---------------------------------------------

  /** The open tabs and splits, with each terminal's current directory. */
  snapshot(): WorkspaceSnapshot {
    const tabs: TabSnapshot[] = [];
    let activeTab = 0;
    for (const tab of this.tabs) {
      const root = snapshotNode(tab.root, (id) => this.panes.get(id)?.snapshot() ?? null);
      if (!root) continue;
      if (tab.id === this.activeTabId) activeTab = tabs.length;
      tabs.push({ title: tab.customTitle, activePane: Math.max(0, paneIds(tab.root).indexOf(tab.activePaneId)), root });
    }
    return { version: 1, activeTab, tabs };
  }

  /** A pane for a saved one; null when it can't be reopened. */
  private paneFromSnapshot(leaf: SnapshotLeaf): WorkspacePane | null {
    if ('pane' in leaf) return new Pane(leaf.pane, this);
    return this.requestFactory?.(leaf.request, this) ?? null;
  }

  /** The open pane of a request file, if any. */
  requestPane(ref: RequestRef): RequestPane | undefined {
    for (const p of this.panes.values()) {
      if (p.kind === 'request' && (p as RequestPane).ref.groupId === ref.groupId && (p as RequestPane).ref.path === ref.path) return p as RequestPane;
    }
    return undefined;
  }

  /**
   * Opens a request. One already open is focused. A `preview` replaces the preview tab, if there
   * is one, so clicking through requests doesn't pile up tabs.
   */
  openRequest(ref: RequestRef, how: { preview: boolean; placement: SplitPlacement; targetPaneId?: string }): RequestPane | null {
    const open = this.requestPane(ref);
    if (open) {
      const tab = this.paneTab.get(open.id);
      if (tab && !how.preview && tab.preview) this.pin(tab);
      this.setActivePane(open.id, true);
      return open;
    }
    const pane = this.requestFactory?.(ref, this);
    if (!pane) return null;
    // A preview with unsaved changes, or with a request on its way, stays.
    const replaceable = (p: WorkspacePane | undefined) => !!p && !p.dirty && !(p as RequestPane).isSending;
    if (how.preview && how.placement === 'tab') {
      const old = this.tabs.find((t) => t.preview && paneIds(t.root).length === 1);
      const oldPane = old && this.panes.get(old.activePaneId);
      if (old && replaceable(oldPane)) {
        this.replacePane(old, oldPane!, pane);
        return pane;
      }
    } else if (how.preview && this.previewSplitId) {
      const oldPane = this.panes.get(this.previewSplitId);
      const tab = oldPane && this.paneTab.get(oldPane.id);
      if (tab && replaceable(oldPane)) {
        this.replacePane(tab, oldPane!, pane);
        this.previewSplitId = pane.id;
        return pane;
      }
    }
    this.add(pane, how.placement, how.targetPaneId);
    const tab = this.paneTab.get(pane.id);
    if (tab && how.preview && how.placement === 'tab' && paneIds(tab.root).length === 1) {
      tab.preview = true;
      this.updateTabEl(tab);
    }
    if (how.preview && how.placement !== 'tab') this.previewSplitId = pane.id;
    return pane;
  }

  /** Puts `pane` where `old` is in `tab` (a preview's place). */
  private replacePane(tab: Tab, old: WorkspacePane, pane: WorkspacePane): void {
    const swap = (n: LayoutNode): LayoutNode =>
      n.type === 'pane' ? (n.paneId === old.id ? leaf(pane.id) : n) : { ...n, children: n.children.map(swap) };
    this.disposePane(old);
    this.panes.set(pane.id, pane);
    this.paneTab.set(pane.id, tab);
    tab.root = swap(tab.root);
    tab.activePaneId = pane.id;
    tab.zoomedPaneId = null;
    this.renderLayout(tab);
    pane.mount();
    this.activateTab(tab.id, false);
    this.setActivePane(pane.id, true);
    void pane.start();
    this.events.onChange();
  }

  /** A preview tab becomes an ordinary one. */
  pin(tab: Tab): void {
    if (!tab.preview) return;
    tab.preview = false;
    this.updateTabEl(tab);
  }

  /**
   * Reopens a saved tab with all its splits; every pane starts its shell again. Connections wait
   * for Enter unless Settings say to reconnect, so a start doesn't fire a burst of logins.
   * Null when none of its panes could be reopened.
   */
  restoreTab(saved: TabSnapshot): Tab | null {
    // In layout order, with a gap for each pane that couldn't be reopened (activePane counts those).
    const slots: (WorkspacePane | null)[] = [];
    const root = layoutFromSnapshot(saved.root, (leaf) => {
      const pane = this.paneFromSnapshot(leaf);
      slots.push(pane);
      if (!pane) return null;
      this.panes.set(pane.id, pane);
      return pane.id;
    });
    const created = slots.filter((p): p is WorkspacePane => !!p);
    if (!root || !created.length) return null;
    const active = slots[saved.activePane] ?? created[0];
    const tab = this.createTab(root, active.id);
    tab.customTitle = saved.title;
    for (const p of created) this.paneTab.set(p.id, tab);

    this.renderTabBar();
    this.activateTab(tab.id, false);
    this.renderLayout(tab);
    for (const p of created) p.mount();
    this.setActivePane(active.id, false);
    this.ensureGpu(tab);
    for (const p of created) {
      if (isTerminal(p) && p.connection && !store.settings.reconnectOnStart) p.showIdle();
      else void p.start();
    }
    this.events.onChange();
    return tab;
  }

  // ---- layout ---------------------------------------------------------

  private renderLayout(tab: Tab): void {
    const zoomed = tab.zoomedPaneId ? this.panes.get(tab.zoomedPaneId) : null;
    const multi = paneIds(tab.root).length > 1;
    tab.el.classList.toggle('multi', multi && !zoomed);
    tab.el.classList.toggle('zoomed', !!zoomed);
    tab.el.replaceChildren(zoomed ? zoomed.el : this.buildNode(tab.root, tab));
    for (const p of this.panesOf(tab)) {
      p.setActive(p.id === tab.activePaneId);
      p.setZoomed(p === zoomed);
      p.queueFit();
    }
    this.events.onTerminalsInfo();
  }

  private buildNode(node: LayoutNode, tab: Tab): HTMLElement {
    if (node.type === 'pane') return this.panes.get(node.paneId)!.el;
    const box = h('div', { class: `split ${node.direction}` });
    node.children.forEach((child, i) => {
      if (i > 0) box.append(this.divider(node, i - 1, box, tab));
      const cell = h('div', { class: 'split-cell' });
      cell.style.flex = `${node.sizes[i]} 1 0px`;
      cell.append(this.buildNode(child, tab));
      box.append(cell);
    });
    return box;
  }

  private divider(node: SplitNode, index: number, box: HTMLElement, tab: Tab): HTMLElement {
    const row = node.direction === 'row';
    const d = h('div', { class: `divider ${node.direction}` });
    d.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      d.classList.add('dragging');
      document.body.classList.add(row ? 'resizing-col' : 'resizing-row');
      const rect = box.getBoundingClientRect();
      const total = row ? rect.width : rect.height;
      const start = row ? e.clientX : e.clientY;
      const startSizes = [...node.sizes];
      const cells = Array.from(box.children).filter((c) => c.classList.contains('split-cell')) as HTMLElement[];
      const min = Math.min(0.45, 60 / Math.max(total, 1));
      const move = (ev: PointerEvent) => {
        const pos = row ? ev.clientX : ev.clientY;
        node.sizes = resizeAt(startSizes, index, (pos - start) / Math.max(total, 1), min);
        cells.forEach((c, i) => (c.style.flex = `${node.sizes[i]} 1 0px`));
      };
      const up = () => {
        d.classList.remove('dragging');
        document.body.classList.remove('resizing-col', 'resizing-row');
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', up);
        d.removeEventListener('pointercancel', up);
        this.panes.get(tab.activePaneId)?.focus();
        // New sizes are part of what is saved for the next start.
        this.events.onTerminalsInfo();
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
      d.addEventListener('pointercancel', up);
    });
    d.addEventListener('dblclick', () => {
      node.sizes = node.children.map(() => 1 / node.children.length);
      this.renderLayout(tab);
    });
    return d;
  }

  equalize(): void {
    const tab = this.activeTab;
    if (!tab) return;
    tab.root = equalize(tab.root);
    this.renderLayout(tab);
    this.panes.get(tab.activePaneId)?.focus();
  }

  toggleZoom(paneId?: string): void {
    const tab = paneId ? this.paneTab.get(paneId) : this.activeTab;
    if (!tab || paneIds(tab.root).length < 2) return;
    const id = paneId ?? tab.activePaneId;
    tab.zoomedPaneId = tab.zoomedPaneId ? null : id;
    if (tab.zoomedPaneId) tab.activePaneId = id;
    this.renderLayout(tab);
    this.panes.get(tab.activePaneId)?.focus();
  }

  /** Moving to another pane of a maximized tab restores the split (see setActivePane), so no pane is out of reach. */
  moveFocus(dir: FocusDirection): void {
    const tab = this.activeTab;
    if (!tab) return;
    const next = neighbor(tab.root, tab.activePaneId, dir);
    if (next) this.setActivePane(next, true);
  }

  setActivePane(paneId: string, focus: boolean): void {
    const tab = this.paneTab.get(paneId);
    const pane = this.panes.get(paneId);
    if (!tab || !pane) return;
    if (tab.zoomedPaneId && tab.zoomedPaneId !== paneId) {
      tab.zoomedPaneId = null;
      tab.activePaneId = paneId;
      this.renderLayout(tab);
    }
    tab.activePaneId = paneId;
    for (const p of this.panesOf(tab)) p.setActive(p.id === paneId);
    if (this.activeTabId !== tab.id) this.activateTab(tab.id, false);
    if (focus) pane.focus();
    this.updateTabEl(tab);
    this.events.onActiveInfo(pane);
  }

  // ---- tabs -----------------------------------------------------------

  activateTab(tabId: string, focus = true): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const prev = this.activeTab;
    if (prev && prev !== tab) {
      prev.el.hidden = true;
      prev.hiddenAt = performance.now();
    }
    tab.el.hidden = false;
    tab.unread = false;
    tab.busy = false;
    tab.bell = false;
    this.activeTabId = tab.id;
    for (const t of this.tabs) this.updateTabEl(t);
    tab.tabEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.ensureGpu(tab);
    for (const p of this.panesOf(tab)) p.queueFit();
    if (focus) this.panes.get(tab.activePaneId)?.focus();
    this.events.onActiveInfo(this.activePane());
    this.events.onChange();
  }

  cycleTab(delta: number): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const next = this.tabs[(idx + delta + this.tabs.length) % this.tabs.length];
    this.activateTab(next.id);
  }

  goToTab(index: number): void {
    const tab = index >= 8 ? this.tabs[this.tabs.length - 1] : this.tabs[index];
    if (tab) this.activateTab(tab.id);
  }

  renameTab(tab: Tab, title: string | null): void {
    tab.customTitle = title?.trim() || null;
    this.updateTabEl(tab);
    this.events.onActiveInfo(this.activePane());
  }

  private renderTabBar(): void {
    this.tabsEl.replaceChildren(...this.tabs.map((t) => this.buildTabEl(t)));
  }

  private buildTabEl(tab: Tab): HTMLDivElement {
    const el = h(
      'div',
      { class: 'tab', draggable: true, role: 'tab', dataset: { tab: tab.id } },
      h('span', { class: 'tab-status' }),
      h('span', { class: 'tab-label' }),
      h('button', {
        class: 'tab-close',
        title: 'Close tab',
        html: icons.x,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          void this.requestCloseTab(tab.id);
        },
      }),
    );
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) void this.requestCloseTab(tab.id);
    });
    el.addEventListener('click', () => this.activateTab(tab.id));
    // Double-click keeps a preview tab; on any other it renames.
    el.addEventListener('dblclick', () => (tab.preview ? this.pin(tab) : this.events.onShortcut({ action: 'renameTab' })));
    // The menu leaves the current tab showing, so a background tab can be moved into its split.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.events.onTabContextMenu(tab, e);
    });
    el.addEventListener('dragstart', (e) => {
      this.draggingTab = tab;
      e.dataTransfer?.setData(DRAG_TYPE, tab.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      this.draggingTab = null;
      this.showDrop(null);
      el.classList.remove('dragging');
      this.tabsEl.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    });
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      el.classList.toggle('drop-before', before);
      el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData(DRAG_TYPE);
      el.classList.remove('drop-before', 'drop-after');
      if (!id || id === tab.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      const moving = this.tabs.find((t) => t.id === id);
      if (!moving) return;
      this.tabs = this.tabs.filter((t) => t !== moving);
      const at = this.tabs.indexOf(tab) + (before ? 0 : 1);
      this.tabs.splice(at, 0, moving);
      this.renderTabBar();
    });
    tab.tabEl = el;
    this.updateTabEl(tab);
    return el;
  }

  private updateTabEl(tab: Tab): void {
    this.events.onTerminalsInfo();
    const el = tab.tabEl;
    if (!el) return;
    const panes = this.panesOf(tab);
    const active = this.panes.get(tab.activePaneId);
    const label = this.tabLabel(tab);
    const progress = panes.some((p) => p.progress);
    const exited = panes.length > 0 && panes.every((p) => p.ended);
    (el.querySelector('.tab-label') as HTMLElement).textContent = label;
    el.title = [label, active?.title && active.title !== label ? active.title : '', active?.location, panes.length > 1 ? `${panes.length} panes` : '']
      .filter(Boolean)
      .join('\n');
    el.classList.toggle('active', tab.id === this.activeTabId);
    el.classList.toggle('exited', exited);
    el.classList.toggle('preview', tab.preview);
    el.style.setProperty('--session-color', (active ? this.paneColor(active) : '') || 'transparent');
    for (const p of panes) {
      if (!isTerminal(p)) continue;
      const owner = this.ownerOf(p);
      p.setIdentity(owner?.name ?? p.spec.name, this.paneColor(p, owner));
    }
    const status = el.querySelector('.tab-status') as HTMLElement;
    const dirty = panes.some((p) => p.dirty);
    const state = progress ? 'progress' : tab.bell ? 'bell' : tab.busy ? 'busy' : tab.unread ? 'unread' : dirty ? 'dirty' : '';
    if (status.dataset.state !== state) {
      status.dataset.state = state;
      status.innerHTML = state === 'bell' ? icons.bell : '';
      status.title =
        state === 'progress'
          ? 'Working…'
          : state === 'bell'
            ? 'Needs attention'
            : state === 'busy'
              ? 'Output in progress'
              : state === 'unread'
                ? 'New output'
                : state === 'dirty'
                  ? 'Unsaved changes'
                  : '';
    }
  }

  private tickActivity(): void {
    const now = performance.now();
    for (const tab of this.tabs) {
      if (tab.id === this.activeTabId) continue;
      const panes = this.panesOf(tab);
      const busy = panes.some((p) => p.lastOutput > tab.hiddenAt + 250 && now - p.lastOutput < BUSY_WINDOW_MS);
      const unread = tab.unread || busy;
      if (busy !== tab.busy || unread !== tab.unread) {
        tab.busy = busy;
        tab.unread = unread;
        this.updateTabEl(tab);
      }
    }
  }

  private attention(pane: Pane, message: string | null): void {
    const tab = this.paneTab.get(pane.id);
    if (!tab) return;
    const focused = document.hasFocus();
    const visible = focused && tab.id === this.activeTabId && tab.activePaneId === pane.id;
    pane.el.classList.remove('flash');
    void pane.el.offsetWidth;
    pane.el.classList.add('flash');
    if (visible) return;
    if (tab.id !== this.activeTabId) {
      tab.bell = true;
      this.updateTabEl(tab);
    }
    if (!focused) void getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => undefined);
    if (message) toast(`${this.tabLabel(tab)} — ${message}`, 'info', 8000, () => this.setActivePane(pane.id, true));
  }

  // ---- GPU budget -----------------------------------------------------

  private ensureGpu(tab: Tab): void {
    if (!store.settings.gpuAcceleration) return;
    const visible = new Set(paneIds(tab.root));
    for (const id of visible) {
      this.panes.get(id)?.enableGpu();
      this.gpuOrder = [id, ...this.gpuOrder.filter((x) => x !== id)];
    }
    let live = this.gpuOrder.filter((id) => this.panes.get(id)?.hasGpu);
    for (let i = live.length - 1; i >= 0 && live.length > MAX_GPU_PANES; i--) {
      const id = live[i];
      if (visible.has(id)) continue;
      this.panes.get(id)?.disableGpu();
      live = live.filter((x) => x !== id);
    }
  }

  refreshGpu(): void {
    const tab = this.activeTab;
    if (!store.settings.gpuAcceleration) for (const p of this.panes.values()) p.disableGpu();
    else if (tab) this.ensureGpu(tab);
  }

  // ---- closing --------------------------------------------------------

  /**
   * Asks what to do with unsaved changes in `panes`: true when they were saved or may be thrown
   * away, false to keep them open.
   */
  async confirmUnsaved(panes: WorkspacePane[]): Promise<boolean> {
    const dirty = panes.filter((p) => p.dirty);
    if (!dirty.length) return true;
    const names = dirty.map((p) => `"${p.name}"`).join(', ');
    const answer = await choiceDialog(dirty.length > 1 ? 'Save the changes?' : `Save "${dirty[0].name}"?`, `${names} ${dirty.length > 1 ? 'have' : 'has'} changes that aren't saved.`, [
      { label: 'Cancel', value: 'cancel' as const },
      { label: "Don't save", value: 'discard' as const },
      { label: 'Save', value: 'save' as const, kind: 'primary' },
    ]);
    if (answer === 'discard') return true;
    if (answer !== 'save') return false;
    for (const p of dirty) if (!(await p.save?.())) return false;
    return true;
  }

  async requestClosePane(paneId: string): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    if (!(await this.confirmUnsaved([pane]))) return pane.focus();
    if (store.settings.confirmClose && (await pane.hasRunningProgram())) {
      const why = !isTerminal(pane) ? 'A request is still on its way.' : pane.connection ? 'The connection is still open.' : 'A program is still running in this terminal.';
      const ok = await confirmDialog(`Close "${pane.name}"?`, why, 'Close', true);
      if (!ok) return pane.focus();
    }
    this.closePane(paneId);
  }

  async requestCloseTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!(await this.confirmUnsaved(this.panesOf(tab)))) return;
    if (store.settings.confirmClose) {
      const busy = (await Promise.all(this.panesOf(tab).map((p) => p.hasRunningProgram()))).filter(Boolean).length;
      if (busy) {
        const ok = await confirmDialog(
          `Close "${this.tabLabel(tab)}"?`,
          busy === 1 ? 'A program is still running in this tab.' : `Programs are still running in ${busy} panes of this tab.`,
          'Close',
          true,
        );
        if (!ok) return;
      }
    }
    this.removeTab(tab);
  }

  closePane(paneId: string): void {
    const pane = this.panes.get(paneId);
    const tab = this.paneTab.get(paneId);
    if (!pane || !tab) return;
    const order = paneIds(tab.root);
    const idx = order.indexOf(paneId);
    this.disposePane(pane);
    const root = removePane(tab.root, paneId);
    if (!root) return this.removeTab(tab);
    tab.root = root;
    if (tab.zoomedPaneId === paneId) tab.zoomedPaneId = null;
    if (tab.activePaneId === paneId) {
      const remaining = paneIds(root);
      tab.activePaneId = remaining[Math.max(0, idx - 1)] ?? remaining[0];
    }
    this.renderLayout(tab);
    this.updateTabEl(tab);
    if (tab.id === this.activeTabId) this.setActivePane(tab.activePaneId, true);
    this.events.onChange();
  }

  private disposePane(pane: WorkspacePane): void {
    pane.dispose();
    this.panes.delete(pane.id);
    this.paneTab.delete(pane.id);
    this.gpuOrder = this.gpuOrder.filter((x) => x !== pane.id);
  }

  removeTab(tab: Tab): void {
    for (const p of this.panesOf(tab)) this.disposePane(p);
    this.detachTab(tab);
  }

  /** Takes a tab away without ending its terminals (they have been closed or moved). */
  private detachTab(tab: Tab): void {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);
    tab.el.remove();
    tab.tabEl?.remove();
    tab.tabEl = null;
    if (this.activeTabId === tab.id) {
      this.activeTabId = null;
      const next = this.tabs[idx] ?? this.tabs[idx - 1];
      if (next) this.activateTab(next.id);
    }
    this.renderTabBar();
    if (!this.tabs.length) this.events.onActiveInfo(null);
    this.events.onChange();
  }

  closeOtherTabs(keep: Tab): void {
    for (const t of [...this.tabs]) if (t !== keep) this.removeTab(t);
  }

  /** Panes with unsaved changes (asked about before quitting). */
  unsavedPanes(): WorkspacePane[] {
    return [...this.panes.values()].filter((p) => p.dirty);
  }

  /** Panes whose shell is running a program (used to confirm quitting). */
  async busyPanes(): Promise<WorkspacePane[]> {
    const all = [...this.panes.values()];
    const flags = await Promise.all(all.map((p) => p.hasRunningProgram()));
    return all.filter((_, i) => flags[i]);
  }

  applySettings(): void {
    for (const p of this.panes.values()) p.applySettings(store.settings);
    this.refreshGpu();
  }
}
