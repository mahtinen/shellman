import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { baseName, pathKey, uid } from './config';
import { confirmDialog, toast } from './dialogs';
import { h } from './dom';
import { icons } from './icons';
import type { Match } from './keys';
import {
  equalize,
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
}

export interface WorkspaceEvents {
  /** Tabs or panes were added/removed/activated. */
  onChange(): void;
  /** The active pane or its title/cwd/state changed. */
  onActiveInfo(pane: Pane | null): void;
  onShortcut(match: Match): boolean;
  onPaneContextMenu(pane: Pane, e: MouseEvent): void;
  onTabContextMenu(tab: Tab, e: MouseEvent): void;
  /** Some tab or pane's label, cwd, state or activity changed. */
  onTerminalsInfo(): void;
}

/** Max simultaneous WebGL renderers; browsers cap live contexts at ~16. */
const MAX_GPU_PANES = 8;
const BUSY_WINDOW_MS = 1500;
const DRAG_TYPE = 'application/x-shellman-tab';

export class Workspace implements PaneHost {
  tabs: Tab[] = [];
  activeTabId: string | null = null;
  readonly panes = new Map<string, Pane>();
  private readonly paneTab = new Map<string, Tab>();
  private gpuOrder: string[] = [];
  readonly windowsBuild = store.sys.windowsBuild;

  constructor(
    private readonly tabsEl: HTMLElement,
    private readonly areaEl: HTMLElement,
    private readonly events: WorkspaceEvents,
  ) {
    window.setInterval(() => this.tickActivity(), 500);
  }

  // ---- PaneHost -------------------------------------------------------

  settings = () => store.settings;
  resolveShell = (id: string) => store.resolveShell(id);

  onFocus(pane: Pane): void {
    const tab = this.paneTab.get(pane.id);
    if (tab && tab.activePaneId !== pane.id) this.setActivePane(pane.id, false);
  }

  onInfoChange(pane: Pane): void {
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
    const mode = store.settings.closeOnExit;
    if (mode === 'always' || (mode === 'graceful' && code === 0)) this.closePane(pane.id);
  }

  onShortcut(_pane: Pane, match: Match): boolean {
    return this.events.onShortcut(match);
  }

  onContextMenu(pane: Pane, e: MouseEvent): void {
    this.setActivePane(pane.id, true);
    this.events.onPaneContextMenu(pane, e);
  }

  onHeaderAction(pane: Pane, action: 'zoom' | 'close'): void {
    if (action === 'zoom') this.toggleZoom(pane.id);
    else void this.requestClosePane(pane.id);
  }

  // ---- queries --------------------------------------------------------

  get activeTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  activePane(): Pane | null {
    const tab = this.activeTab;
    return tab ? (this.panes.get(tab.activePaneId) ?? null) : null;
  }

  tabOf(pane: Pane): Tab | undefined {
    return this.paneTab.get(pane.id);
  }

  panesOf(tab: Tab): Pane[] {
    return paneIds(tab.root)
      .map((id) => this.panes.get(id))
      .filter((p): p is Pane => !!p);
  }

  tabLabel(tab: Tab): string {
    const pane = this.panes.get(tab.activePaneId);
    return tab.customTitle ?? (pane ? this.paneLabel(pane) : 'Terminal');
  }

  /** The saved session a pane belongs to: the one it was opened from, else the first one whose directory it is in. */
  ownerOf(pane: Pane): SavedSession | undefined {
    const dir = pathKey(pane.cwd);
    return store.session(pane.spec.sessionId) ?? store.config.sessions.find((s) => s.cwd && pathKey(s.cwd) === dir);
  }

  /** A terminal's name, shared by its tab and its entry in the sidebar tree. */
  paneLabel(pane: Pane): string {
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

  /** Spec for a new terminal next to `pane`: same shell and directory. */
  specFrom(pane: Pane, rerunCommand: boolean): LaunchSpec {
    if (rerunCommand) return { ...pane.spec, cwd: pane.cwd };
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
    this.panes.set(pane.id, pane);
    const targetTab = targetPaneId ? this.paneTab.get(targetPaneId) : this.activeTab;

    let tab: Tab;
    if (placement === 'tab' || !targetTab) {
      tab = {
        id: uid('t-'),
        root: leaf(pane.id),
        activePaneId: pane.id,
        customTitle: null,
        zoomedPaneId: null,
        el: h('div', { class: 'tab-content', hidden: true }),
        tabEl: null,
        unread: false,
        busy: false,
        bell: false,
        hiddenAt: 0,
      };
      this.areaEl.append(tab.el);
      const activeIdx = this.tabs.findIndex((t) => t.id === this.activeTabId);
      this.tabs.splice(activeIdx >= 0 ? activeIdx + 1 : this.tabs.length, 0, tab);
    } else {
      tab = targetTab;
      const target = targetPaneId ?? tab.activePaneId;
      tab.zoomedPaneId = null;
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
    return pane;
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
      p.queueFit();
    }
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

  moveFocus(dir: FocusDirection): void {
    const tab = this.activeTab;
    if (!tab || tab.zoomedPaneId) return;
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
    el.addEventListener('dblclick', () => this.events.onShortcut({ action: 'renameTab' }));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.activateTab(tab.id);
      this.events.onTabContextMenu(tab, e);
    });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(DRAG_TYPE, tab.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
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
    const exited = panes.length > 0 && panes.every((p) => p.state === 'exited' || p.state === 'error');
    (el.querySelector('.tab-label') as HTMLElement).textContent = label;
    el.title = [label, active?.title && active.title !== label ? active.title : '', active?.cwd, panes.length > 1 ? `${panes.length} panes` : '']
      .filter(Boolean)
      .join('\n');
    el.classList.toggle('active', tab.id === this.activeTabId);
    el.classList.toggle('exited', exited);
    el.style.setProperty('--session-color', active?.spec.color || 'transparent');
    const status = el.querySelector('.tab-status') as HTMLElement;
    const state = progress ? 'progress' : tab.bell ? 'bell' : tab.busy ? 'busy' : tab.unread ? 'unread' : '';
    if (status.dataset.state !== state) {
      status.dataset.state = state;
      status.innerHTML = state === 'bell' ? icons.bell : '';
      status.title =
        state === 'progress' ? 'Working…' : state === 'bell' ? 'Needs attention' : state === 'busy' ? 'Output in progress' : state === 'unread' ? 'New output' : '';
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

  async requestClosePane(paneId: string): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    if (store.settings.confirmClose && (await pane.hasRunningProgram())) {
      const ok = await confirmDialog(`Close "${pane.name}"?`, 'A program is still running in this terminal.', 'Close', true);
      if (!ok) return pane.focus();
    }
    this.closePane(paneId);
  }

  async requestCloseTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
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

  private disposePane(pane: Pane): void {
    pane.dispose();
    this.panes.delete(pane.id);
    this.paneTab.delete(pane.id);
    this.gpuOrder = this.gpuOrder.filter((x) => x !== pane.id);
  }

  removeTab(tab: Tab): void {
    for (const p of this.panesOf(tab)) this.disposePane(p);
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

  /** Panes whose shell is running a program (used to confirm quitting). */
  async busyPanes(): Promise<Pane[]> {
    const all = [...this.panes.values()];
    const flags = await Promise.all(all.map((p) => p.hasRunningProgram()));
    return all.filter((_, i) => flags[i]);
  }

  applySettings(): void {
    for (const p of this.panes.values()) p.applySettings(store.settings);
    this.refreshGpu();
  }
}
