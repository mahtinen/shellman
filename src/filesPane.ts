/**
 * The Files pane: a read-only look at a folder (usually a session's project) without leaving
 * Shellman. The tree lists every file and marks what changed since the last commit; a file opens
 * with syntax colours, and a changed one also as a diff, side by side or inline. Search finds text in
 * the files, and names in the code lead to their definitions, references and implementations
 * (found by searching, see navigate.ts). Nothing in the folder is ever written: for editing,
 * "VS Code" opens the whole folder there.
 */
import { api, type FileChange, type FileContent, type FileEntry, type FileState, type GitChanges, type Hunk, type SearchMatch } from './api';
import { baseName, ownerSession, pathKey, sessionColor, uid } from './config';
import {
  changeStarts,
  foldRows,
  inlineRows,
  isFold,
  lineMarks,
  pairRows,
  splitLines,
  wholeFileHunks,
  wordDiff,
  type Fold,
  type InlineRow,
  type LineMark,
  type PairRow,
  type Ranges,
} from './diff';
import { toast } from './dialogs';
import { h, setChildren } from './dom';
import { fuzzyScore } from './fuzzy';
import { icons } from './icons';
import { codeNodes, LineView, widestLine } from './lineView';
import { showMenu, type MenuEntry } from './menu';
import { definitions, fileSymbols, implementations, wordAt } from './navigate';
import { ProjectSearch } from './filesSearch';
import { paneHeader, type PaneEvents, type WorkspacePane } from './panes';
import type { FilesRef, SnapshotLeaf } from './snapshot';
import { store } from './store';
import { Highlighter, langFor } from './syntax';
import type { Settings } from './types';

type View = FilesRef['view'];
type Mode = FilesRef['mode'];

const LETTER: Record<FileState, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!' };
const STATE_NAME: Record<FileState, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'New, not in git yet',
  conflict: 'Conflict',
};
/** What git compares with. Later: the commit a worktree started from. */
const BASE = 'HEAD';
/** Unchanged lines kept around each change in a diff. */
const CONTEXT = 3;
/** At most this often while files keep changing (a build, Claude editing). */
const REFRESH_GAP_MS = 1500;

type Listing = { entries: FileEntry[]; truncated: boolean } | { error: string };

/** A file as opened: its text now and at the base, and git's hunks between them. */
interface Opened {
  path: string;
  change: FileChange | null;
  content: FileContent | null;
  /** Why it couldn't be read (deleted, no access). */
  error: string | null;
  lines: string[] | null;
  oldLines: string[] | null;
  /** The base version isn't text (binary, too large). */
  oldContent: FileContent | null;
  hunks: Hunk[];
  hl: Highlighter;
  oldHl: Highlighter;
}

/** One row in the side list: a folder or file of the tree, or a changed file. */
interface SideRow {
  path: string;
  dir: boolean;
  el: HTMLElement;
  /** What Enter or a click does, when it isn't opening the file or folder at `path`. */
  open?: () => void;
  toggle?: () => void;
}

/** A place to go back to. */
interface Place {
  path: string;
  mode: Mode;
  /** The first row in view. */
  top: number;
}

/** Matches in a code navigation search, at most. */
const MAX_NAME_MATCHES = 5000;
const MAX_HISTORY = 50;

/** The pane whose find highlights are showing (one set for the whole window). */
let findOwner: FilesPane | null = null;

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const sameText = (a: string[] | null, b: string[] | null) => a === b || (!!a && !!b && a.length === b.length && a.every((l, i) => l === b[i]));

export class FilesPane implements WorkspacePane {
  readonly id = uid('p-');
  readonly kind = 'files';
  readonly el: HTMLDivElement;
  readonly progress = null;
  readonly ended = false;
  readonly hasGpu = false;
  readonly dirty = false;
  lastOutput = 0;
  readonly root: string;

  private view: View;
  private mode: Mode;
  private changes: GitChanges | null = null;
  /** Not a git repository (or git isn't installed): no Changes view. */
  private noGit = false;
  private gitError: string | null = null;
  private readonly listings = new Map<string, Listing>();
  private readonly expanded = new Set<string>(['']);
  private allFiles: string[] | null = null;
  private opened: Opened | null = null;
  /** The path to open once the pane has started (from a saved workspace or a link). */
  private pending: { path: string; line?: number } | null;
  /** The selected row of the side list (a path). */
  private cursor = '';
  private sideRows: SideRow[] = [];
  private readonly openFolds = new Set<number>();
  private readonly wordCache = new Map<string, { old: Ranges; new: Ranges } | null>();
  private loadSeq = 0;
  private watchId: number | null = null;
  private refreshTimer: number | undefined;
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;
  /** Something changed while the pane wasn't visible: refresh when it is. */
  private stale = false;
  private started = false;
  private disposed = false;
  private findRows: number[] = [];
  private findIndex = -1;
  private readonly search: ProjectSearch;
  private readonly back: Place[] = [];
  private readonly forward: Place[] = [];
  /** The line a search result or a definition led to (1-based), marked until the next file opens. */
  private target: { path: string; line: number; ranges: Ranges } | null = null;
  private hovered = false;
  private readonly ctrlKey = (e: KeyboardEvent) => {
    if (e.key === 'Control') this.el.classList.toggle('ctrl-link', e.type === 'keydown' && this.hovered);
  };

  private readonly header: ReturnType<typeof paneHeader>;
  private readonly sideEl: HTMLElement;
  private readonly viewTabs: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly listEl: HTMLElement;
  private readonly footEl: HTMLElement;
  private readonly barEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly findInput: HTMLInputElement;
  private readonly findCount: HTMLElement;
  /** The views drawn now: one, or old and new side by side. */
  private views: LineView[] = [];
  /** Row i of the views → its line's text, for find. */
  private rowText: (i: number) => string = () => '';
  /** Row i of the views → its line in the file as it is now (1-based); null for a removed line or a fold. */
  private rowLine: (i: number) => number | null = () => null;
  private changeRows: number[] = [];
  /** Rows in the views drawn now. */
  private rowsTotal = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribe: () => void;

  constructor(
    ref: FilesRef,
    private readonly host: PaneEvents,
  ) {
    this.root = ref.root.replace(/[\\/]+$/, '') || ref.root;
    this.view = ref.view;
    this.mode = ref.mode;
    this.pending = ref.path ? { path: ref.path } : null;
    this.header = paneHeader((action) => host.onHeaderAction(this, action));

    this.viewTabs = h('div', { class: 'fp-views', role: 'tablist' });
    this.filterInput = h('input', { class: 'input small fp-filter', placeholder: 'Go to file', spellcheck: false, autocomplete: 'off' });
    this.filterInput.addEventListener('input', () => {
      this.cursor = '';
      this.renderList();
    });
    this.filterInput.addEventListener('focus', () => {
      if (this.view === 'all' && !this.allFiles) void this.loadAllFiles();
    });
    this.filterInput.addEventListener('keydown', (e) => this.listKey(e, true));
    this.listEl = h('div', { class: 'fp-list', tabindex: 0 });
    this.listEl.addEventListener('keydown', (e) => this.listKey(e, false));
    this.footEl = h('div', { class: 'fp-foot' });
    this.search = new ProjectSearch({
      root: this.root,
      openMatch: (path, line, ranges) => void this.goTo(path, line, ranges),
      changed: () => this.view === 'search' && this.renderList(),
    });
    this.search.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') this.listKey(e, true);
    });
    this.sideEl = h('div', { class: 'fp-side' }, h('div', { class: 'fp-sidehead' }, this.viewTabs, this.filterInput, this.search.headEl), this.listEl, this.footEl);
    const splitter = h('div', { class: 'fp-splitter' });
    splitter.addEventListener('pointerdown', (e) => this.dragSplitter(e, splitter));

    this.findInput = h('input', { class: 'input small fp-find', placeholder: 'Find', spellcheck: false });
    this.findInput.addEventListener('input', () => this.find(0));
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.find(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.findInput.value = '';
        this.find(0);
        this.views[this.views.length - 1]?.el.focus();
      }
    });
    this.findCount = h('span', { class: 'fp-findcount muted' });
    this.barEl = h('div', { class: 'fp-bar' });
    this.bodyEl = h('div', { class: 'fp-body' });

    this.el = h(
      'div',
      { class: 'pane files-pane', dataset: { pane: this.id } },
      this.header.el,
      h('div', { class: 'fp' }, this.sideEl, splitter, h('div', { class: 'fp-main' }, this.barEl, this.bodyEl)),
    );
    this.el.addEventListener('mousedown', () => host.onFocus(this));
    this.el.addEventListener('focusin', () => host.onFocus(this));
    this.el.addEventListener('keydown', (e) => this.paneKey(e));
    this.el.addEventListener('contextmenu', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('input')) return;
      e.preventDefault();
      if (target.closest('.lv-row')) this.codeMenu(e);
      else host.onContextMenu(this, e);
    });
    // Ctrl+click on a name goes to its definition; holding Ctrl shows it is a link.
    this.bodyEl.addEventListener('mousedown', (e) => {
      if (!e.ctrlKey || e.button !== 0 || !(e.target as HTMLElement).closest('.lv-code')) return;
      const word = this.wordAtPoint(e.clientX, e.clientY);
      if (!word) return;
      e.preventDefault();
      void this.goToDefinition(word);
    });
    this.el.addEventListener('mouseenter', () => (this.hovered = true));
    this.el.addEventListener('mouseleave', () => {
      this.hovered = false;
      this.el.classList.remove('ctrl-link');
    });
    this.el.addEventListener('mousemove', (e) => this.el.classList.toggle('ctrl-link', e.ctrlKey));
    window.addEventListener('keydown', this.ctrlKey);
    window.addEventListener('keyup', this.ctrlKey);
    // The mouse's back and forward buttons.
    this.el.addEventListener('mousedown', (e) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    });
    this.el.addEventListener('mouseup', (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      void this.goBack(e.button === 3 ? 1 : -1);
    });
    this.resizeObserver = new ResizeObserver(() => this.queueFit());
    // The theme or the pane's settings may change.
    this.unsubscribe = store.on(() => this.renderHeader());
    this.renderHeader();
    this.renderTabs();
    this.renderBar();
    this.renderBody();
  }

  // ---- WorkspacePane ----------------------------------------------------

  get name(): string {
    return `Files · ${baseName(this.root)}`;
  }

  get title(): string {
    return this.opened?.path ?? '';
  }

  get location(): string {
    return this.opened ? `${this.root}\\${this.opened.path.replace(/\//g, '\\')}` : this.root;
  }

  get color(): string {
    const owner = ownerSession(store.config.sessions, this.root, null);
    return owner ? sessionColor(store.config.groups, owner) : '';
  }

  /** The file shown, relative to the root ('' = none). */
  get path(): string {
    return this.opened?.path ?? '';
  }

  get branch(): string | null {
    return this.changes?.branch ?? null;
  }

  get changeCount(): number | null {
    return this.changes ? this.changes.files.length : null;
  }

  mount(): void {
    this.resizeObserver.observe(this.el);
  }

  async start(): Promise<void> {
    void api
      .filesWatch(this.root, () => this.scheduleRefresh())
      .then((id) => {
        if (this.disposed) void api.collectionUnwatch(id);
        else this.watchId = id;
      })
      .catch(() => undefined);
    await Promise.all([this.loadDir(''), this.loadChanges()]);
    if (this.noGit && this.view === 'changes') this.view = 'all';
    this.lastRefresh = performance.now();
    this.renderTabs();
    this.renderList();
    const pending = this.pending;
    this.pending = null;
    this.started = true;
    if (pending) await this.show(pending.path, this.mode, pending.line);
  }

  /** Opens `path` now, or once the pane has read the folder. */
  open(path: string, mode: Mode = this.mode, line?: number): void {
    if (this.started) void this.show(path, mode, line);
    else {
      this.pending = { path, line };
      this.mode = mode;
    }
  }

  setActive(active: boolean): void {
    this.el.classList.toggle('active', active);
  }

  setZoomed(zoomed: boolean): void {
    this.header.setZoomed(zoomed);
  }

  queueFit(): void {
    if (this.stale && this.visible) {
      this.stale = false;
      this.scheduleRefresh();
    }
    for (const v of this.views) v.draw(false);
  }

  focus(): void {
    if (this.el.contains(document.activeElement)) return;
    (this.views[this.views.length - 1]?.el ?? this.listEl).focus();
  }

  enableGpu(): void {}
  disableGpu(): void {}

  applySettings(_s: Settings): void {
    this.renderList();
    this.renderBar();
    this.renderBody(true);
  }

  async hasRunningProgram(): Promise<boolean> {
    return false;
  }

  snapshot(): SnapshotLeaf {
    return { files: { root: this.root, path: this.opened?.path ?? this.pending?.path ?? '', view: this.view, mode: this.mode } };
  }

  openSearch(): void {
    this.findInput.focus();
    this.findInput.select();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.watchId !== null) void api.collectionUnwatch(this.watchId);
    window.clearTimeout(this.refreshTimer);
    this.unsubscribe();
    window.removeEventListener('keydown', this.ctrlKey);
    window.removeEventListener('keyup', this.ctrlKey);
    this.resizeObserver.disconnect();
    this.clearFind();
    this.el.remove();
  }

  // ---- loading ----------------------------------------------------------

  private get visible(): boolean {
    return this.el.isConnected && this.el.offsetParent !== null;
  }

  private async loadDir(dir: string): Promise<void> {
    try {
      this.listings.set(dir, await api.filesList(this.root, dir));
    } catch (e) {
      this.listings.set(dir, { error: String(e) });
    }
  }

  private async loadChanges(): Promise<void> {
    try {
      this.changes = await api.gitChanges(this.root, BASE);
      this.noGit = !this.changes;
      this.gitError = null;
    } catch (e) {
      // git isn't installed, or refuses the folder (e.g. one inside WSL owned by another user).
      this.changes = null;
      this.noGit = true;
      this.gitError = String(e);
    }
  }

  private async loadAllFiles(): Promise<void> {
    try {
      this.allFiles = (await api.filesAll(this.root)).files;
    } catch (e) {
      this.allFiles = [];
      toast(String(e), 'error');
    }
    if (this.filterInput.value) this.renderList();
  }

  /** Something in the folder changed: refresh soon, but not more often than every REFRESH_GAP_MS. */
  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (!this.visible) {
      this.stale = true;
      return;
    }
    if (this.refreshTimer !== undefined) return;
    const wait = Math.max(200, REFRESH_GAP_MS - (performance.now() - this.lastRefresh));
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, wait);
  }

  /** Reads again what is shown: the changes, the open folders and the open file. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      this.lastRefresh = performance.now();
      const dirs = [...this.listings.keys()].filter((d) => d === '' || this.expanded.has(d));
      for (const d of [...this.listings.keys()]) if (!dirs.includes(d)) this.listings.delete(d);
      await Promise.all([this.loadChanges(), ...dirs.map((d) => this.loadDir(d))]);
      this.allFiles = null;
      if (this.view === 'changes' && this.noGit) this.view = 'all';
      this.renderTabs();
      this.renderList();
      if (this.view === 'search') this.search.refresh();
      if (this.opened) await this.load(this.opened.path, true);
      this.host.onInfoChange(this);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private changeOf(path: string): FileChange | null {
    return this.changes?.files.find((f) => f.path === path) ?? null;
  }

  /**
   * Opens `path` (and selects it in the tree). `line` (1-based) scrolls to it, `top` (a row) puts
   * that row at the top. The place left behind is kept for Back unless `record` is false.
   */
  async show(path: string, mode: Mode = this.mode, line?: number, opts: { top?: number; record?: boolean } = {}): Promise<void> {
    if (opts.record !== false) this.remember();
    if (!this.changeOf(path) && mode === 'diff') mode = 'file';
    if (this.target && (this.target.path !== path || !line)) this.target = null;
    this.mode = mode;
    this.cursor = path;
    if (this.view === 'all') await this.revealInTree(path);
    await this.load(path, false);
    if (opts.top !== undefined) for (const v of this.views) v.scrollTop = opts.top * v.rowHeight;
    else if (line && this.mode === 'file') this.views[0]?.reveal(line - 1);
    this.renderBar();
    this.host.onInfoChange(this);
  }

  // ---- navigation: back and forward, definitions, references ---------------

  private here(): Place | null {
    const o = this.opened;
    return o ? { path: o.path, mode: this.mode, top: this.views[this.views.length - 1]?.topRow() ?? 0 } : null;
  }

  /** Keeps the current place for Back (and forgets what Forward had). */
  private remember(): void {
    const at = this.here();
    if (!at) return;
    const last = this.back[this.back.length - 1];
    if (!last || last.path !== at.path || last.top !== at.top || last.mode !== at.mode) this.back.push(at);
    if (this.back.length > MAX_HISTORY) this.back.shift();
    this.forward.length = 0;
  }

  /** Back (1) or forward (-1) to the place before or after. */
  async goBack(dir: 1 | -1): Promise<void> {
    const from = dir > 0 ? this.back : this.forward;
    const to = dir > 0 ? this.forward : this.back;
    const place = from.pop();
    if (!place) return;
    const at = this.here();
    if (at) to.push(at);
    this.target = null;
    await this.show(place.path, place.mode, undefined, { top: place.top, record: false });
  }

  /** Opens a file at a line and marks it (a search result, a definition). */
  async goTo(path: string, line: number, ranges: Ranges = []): Promise<void> {
    this.target = { path, line, ranges };
    await this.show(path, 'file', line);
  }

  /** Every whole-word, case-sensitive use of `name` in the folder. */
  private async findName(name: string): Promise<SearchMatch[] | null> {
    try {
      const r = await api.filesSearch(this.root, { query: name, caseSensitive: true, word: true, regex: false, include: '', max: MAX_NAME_MATCHES });
      return r.matches;
    } catch (e) {
      toast(String(e), 'error');
      return null;
    }
  }

  private showList(title: string, name: string, matches: SearchMatch[]): void {
    this.view = 'search';
    this.filterInput.value = '';
    this.renderTabs();
    this.search.showList(title, name, matches);
    this.renderList();
  }

  /** Where `name` is declared: straight there when there is one place, else a list to choose from. */
  async goToDefinition(name: string): Promise<void> {
    const found = await this.findName(name);
    if (!found) return;
    const defs = definitions(found, name, this.path);
    if (defs.length === 1) return this.goTo(defs[0].path, defs[0].line, this.wordRanges(defs[0].text, name));
    if (defs.length) return this.showList(`Definitions of ${name}`, name, defs);
    toast(`No declaration of "${name}" was found, so here is where it is used.`);
    this.showList(`References to ${name}`, name, found);
  }

  async findReferences(name: string): Promise<void> {
    const found = await this.findName(name);
    if (found) this.showList(`References to ${name}`, name, found);
  }

  /** Types that implement or extend `name`, or the bodies of a method declared in an interface. */
  async goToImplementations(name: string): Promise<void> {
    const found = await this.findName(name);
    if (!found) return;
    const impls = implementations(found, name, this.path);
    if (impls.length === 1) return this.goTo(impls[0].path, impls[0].line, this.wordRanges(impls[0].text, name));
    if (impls.length) return this.showList(`Implementations of ${name}`, name, impls);
    toast(`No implementation of "${name}" was found.`);
  }

  /** Searches the folder for `text` (the selection, or what was typed before). */
  searchProject(text?: string): void {
    this.view = 'search';
    this.filterInput.value = '';
    this.renderTabs();
    this.renderList();
    this.search.focus(text);
  }

  private wordRanges(text: string, name: string): Ranges {
    const out: Ranges = [];
    const re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
    for (let m = re.exec(text); m; m = re.exec(text)) out.push([m.index, m.index + m[0].length]);
    return out;
  }

  /** The name at a point of the code (a Ctrl+click, a right-click). */
  private wordAtPoint(x: number, y: number): string | null {
    const range = document.caretRangeFromPoint?.(x, y);
    return range ? this.wordAtNode(range.startContainer, range.startOffset) : null;
  }

  /** The name at the caret or in the selection of the code. */
  private wordAtSelection(): string | null {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return null;
    const text = sel.toString().trim();
    if (text && /^[\w$]+$/.test(text)) return text;
    return this.wordAtNode(sel.anchorNode, sel.anchorOffset);
  }

  private wordAtNode(node: Node, offset: number): string | null {
    const code = (node instanceof Element ? node : node.parentElement)?.closest('.lv-code');
    if (!code || !this.bodyEl.contains(code)) return null;
    const before = document.createRange();
    before.setStart(code, 0);
    before.setEnd(node, offset);
    return wordAt(code.textContent ?? '', before.toString().length)?.word ?? null;
  }

  /** The row a node is in, in the views drawn now. */
  private rowOf(node: Node | null): number | null {
    const el = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.lv-row');
    return el && this.bodyEl.contains(el) && el.dataset.row ? Number(el.dataset.row) : null;
  }

  /** The line of row `row`, or of the nearest row in direction `dir` that has one (then the other way). */
  private nearestLine(row: number, dir: 1 | -1): number | null {
    for (const d of [dir, -dir]) {
      for (let i = row; i >= 0 && i < this.rowsTotal; i += d) {
        const line = this.rowLine(i);
        if (line !== null) return line;
      }
    }
    return null;
  }

  /**
   * `path:line` for the right-clicked line, or `path:first-last` when it is inside a selection of
   * several lines: a reference to paste for Claude.
   */
  private lineReference(e: MouseEvent): string | null {
    const o = this.opened;
    const clicked = this.rowOf(e.target as Node);
    if (!o || clicked === null) return null;
    let from = clicked;
    let to = clicked;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const a = this.rowOf(sel.anchorNode);
      const b = this.rowOf(sel.focusNode);
      if (a !== null && b !== null && clicked >= Math.min(a, b) && clicked <= Math.max(a, b)) [from, to] = [Math.min(a, b), Math.max(a, b)];
    }
    const first = this.nearestLine(from, 1);
    const last = this.nearestLine(to, -1);
    if (first === null) return null;
    return `${o.path}:${last !== null && last > first ? `${first}-${last}` : first}`;
  }

  /** Right-click in the code: a reference to the line, and what can be done with the name there. */
  private codeMenu(e: MouseEvent): void {
    const word = (e.target as HTMLElement).closest('.lv-code') ? this.wordAtPoint(e.clientX, e.clientY) : null;
    const selected = window.getSelection()?.toString() ?? '';
    const quoted = word ? `"${word.length > 30 ? `${word.slice(0, 29)}…` : word}"` : '';
    const ref = this.lineReference(e);
    const entries: MenuEntry[] = [
      {
        label: ref ? `Copy reference ${nameOf(ref)}` : 'Copy reference',
        icon: 'copy',
        disabled: !ref,
        action: () => ref && void api.clipboardWrite(ref).then(() => toast(`Copied ${ref}`), (err) => toast(String(err), 'error')),
      },
      'separator',
      { label: 'Go to definition', icon: 'arrowRight', shortcut: 'F12', disabled: !word, action: () => word && void this.goToDefinition(word) },
      { label: 'Go to implementations', icon: 'arrowRight', shortcut: 'Ctrl+F12', disabled: !word, action: () => word && void this.goToImplementations(word) },
      { label: 'Find references', icon: 'search', shortcut: 'Shift+F12', disabled: !word, action: () => word && void this.findReferences(word) },
      { label: word ? `Search for ${quoted}` : 'Search in files', icon: 'search', shortcut: 'Ctrl+Shift+F', action: () => this.searchProject(selected.trim() || word || undefined) },
      'separator',
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', disabled: !selected, action: () => void api.clipboardWrite(selected) },
      { label: 'Open in VS Code here', icon: 'openExternal', action: () => this.openInEditor(true) },
    ];
    showMenu(e.clientX, e.clientY, entries);
  }

  /** Opens the folders above `path` in the tree. */
  private async revealInTree(path: string): Promise<void> {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      this.expanded.add(dir);
      if (!this.listings.has(dir)) await this.loadDir(dir);
    }
    this.renderList();
    this.sideRows.find((r) => r.path === path)?.el.scrollIntoView({ block: 'nearest' });
  }

  /** Reads the file (and its base version when it changed). `again` keeps the scroll position. */
  private async load(path: string, again: boolean): Promise<void> {
    const seq = ++this.loadSeq;
    const change = this.changeOf(path);
    const read = api.filesRead(this.root, path).then(
      (c) => ({ content: c, error: null }),
      (e) => ({ content: null, error: String(e) }),
    );
    const base = change && change.state !== 'untracked' ? api.gitFileAt(this.root, change.oldPath ?? path, BASE).catch(() => null) : Promise.resolve(null);
    const gitHunks =
      change && (change.state === 'modified' || change.state === 'renamed' || change.state === 'conflict')
        ? api.gitHunks(this.root, path, change.oldPath, BASE).catch(() => null)
        : Promise.resolve(null);
    const [now, old, hunks] = await Promise.all([read, base, gitHunks]);
    if (seq !== this.loadSeq || this.disposed) return;
    const lines = now.content?.kind === 'text' ? splitLines(now.content.text) : null;
    const oldLines = old?.kind === 'text' ? splitLines(old.text) : change && change.state !== 'untracked' && !old ? [] : null;
    const opened: Opened = {
      path,
      change,
      content: now.content,
      error: now.error,
      lines,
      oldLines,
      oldContent: old,
      hunks: hunks ?? (change ? wholeFileHunks(oldLines?.length ?? 0, lines?.length ?? 0) : []),
      hl: new Highlighter(lines ?? [], langFor(path)),
      oldHl: new Highlighter(oldLines ?? [], langFor(change?.oldPath ?? path)),
    };
    const prev = this.opened;
    const same =
      again &&
      prev?.path === path &&
      sameText(prev.lines, lines) &&
      sameText(prev.oldLines, oldLines) &&
      JSON.stringify(prev.hunks) === JSON.stringify(opened.hunks) &&
      prev.content?.kind === opened.content?.kind;
    if (same) return;
    if (!again || prev?.path !== path) {
      this.openFolds.clear();
      this.wordCache.clear();
    }
    this.opened = opened;
    this.renderBar();
    this.renderBody(again);
    if (!again) this.renderList();
  }

  // ---- side: tree, changes and "go to file" -------------------------------

  private renderTabs(): void {
    const tab = (view: View, label: string, badge: string | null, title: string) =>
      h(
        'button',
        {
          class: `fp-viewtab${this.view === view ? ' sel' : ''}`,
          role: 'tab',
          title,
          onclick: () => {
            this.view = view;
            this.cursor = this.opened?.path ?? '';
            this.renderTabs();
            this.renderList();
            if (view === 'all' && this.opened) void this.revealInTree(this.opened.path);
            this.host.onInfoChange(this);
          },
        },
        label,
        badge ? h('span', { class: 'rq-badge' }, badge) : null,
      );
    const n = this.changes?.files.length ?? 0;
    setChildren(
      this.viewTabs,
      tab('all', 'Files', null, 'Every file in the folder'),
      this.noGit ? null : tab('changes', 'Changes', String(n), 'Files changed since the last commit'),
      tab('search', 'Search', null, 'Find text in the files (Ctrl+Shift+F)'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn small', title: 'Refresh', html: icons.refresh, onclick: () => void this.refresh() }),
      h('button', {
        class: 'icon-btn small',
        title: 'More',
        html: icons.chevronDown,
        onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, this.moreEntries()),
      }),
    );
    this.filterInput.placeholder = this.view === 'changes' ? 'Filter changes' : 'Go to file (@ for symbols)';
    this.filterInput.hidden = this.view === 'search';
    this.search.headEl.hidden = this.view !== 'search';
  }

  private moreEntries() {
    const s = store.settings;
    return [
      {
        label: s.showIgnoredFiles ? 'Hide files git ignores' : 'Show files git ignores',
        icon: s.showIgnoredFiles ? ('eyeOff' as const) : ('eye' as const),
        action: () => store.update((c) => (c.settings.showIgnoredFiles = !c.settings.showIgnoredFiles)),
      },
      { label: 'Collapse all folders', icon: 'folder' as const, action: () => (this.expanded.clear(), this.expanded.add(''), this.renderList()) },
      'separator' as const,
      { label: 'Open folder in VS Code', icon: 'openExternal' as const, action: () => this.openInEditor(false) },
      { label: 'Open folder in Explorer', icon: 'openExternal' as const, action: () => void api.openDir(this.root).catch((e) => toast(String(e), 'error')) },
    ];
  }

  private renderList(): void {
    const q = this.view === 'search' ? '' : this.filterInput.value.trim();
    const rows: SideRow[] = q
      ? this.filterRows(q)
      : this.view === 'search'
        ? this.search.rows()
        : this.view === 'changes'
          ? this.changeRowsFor(this.changes?.files ?? [])
          : this.treeRows();
    if (!q && this.view === 'changes' && !rows.length) {
      this.listEl.replaceChildren(h('div', { class: 'fp-empty muted' }, this.gitError ? 'git could not read this folder.' : 'Nothing changed since the last commit.'));
    } else if (q && !rows.length) {
      this.listEl.replaceChildren(h('div', { class: 'fp-empty muted' }, q.startsWith('@') ? (this.opened?.lines ? 'No matching symbols in this file.' : 'Open a file to see its symbols.') : this.view === 'all' && !this.allFiles ? 'Reading the file list…' : 'No matching files.'));
    } else {
      this.listEl.replaceChildren(...rows.map((r) => r.el));
    }
    this.sideRows = rows;
    this.markCursor();
    this.renderFoot();
  }

  private renderFoot(): void {
    const c = this.changes;
    if (this.gitError) {
      setChildren(this.footEl, h('span', { class: 'fp-giterror', title: this.gitError }, `git: ${this.gitError.split('\n')[0]}`));
      return;
    }
    if (!c) {
      setChildren(this.footEl, h('span', { class: 'muted' }, 'Not in a git repository'));
      return;
    }
    let added = 0;
    let removed = 0;
    for (const f of c.files) {
      added += f.added ?? 0;
      removed += f.removed ?? 0;
    }
    setChildren(
      this.footEl,
      h('span', { class: 'fp-branch', title: c.base ? `Compared with ${c.base.slice(0, 10)} (the last commit)` : 'No commits yet' }, c.branch ?? 'detached HEAD'),
      h('span', { class: 'spacer' }),
      c.files.length ? h('span', { class: 'fp-counts' }, h('span', { class: 'fp-plus' }, `+${added}`), ' ', h('span', { class: 'fp-minus' }, `−${removed}`)) : null,
    );
  }

  private isIgnored(path: string, dir: boolean): boolean {
    const ignored = this.changes?.ignored;
    return !!ignored && ignored.includes(dir ? `${path}/` : path);
  }

  private treeRows(): SideRow[] {
    const rows: SideRow[] = [];
    const changed = new Map((this.changes?.files ?? []).map((f) => [f.path, f]));
    const changedDirs = new Set<string>();
    for (const f of changed.keys()) for (let d = dirOf(f); d; d = dirOf(d)) changedDirs.add(d);
    const showIgnored = store.settings.showIgnoredFiles;
    const walk = (dir: string, depth: number, ignoredAbove: boolean) => {
      const listing = this.listings.get(dir);
      if (!listing) {
        rows.push({ path: `${dir}/…`, dir: false, el: h('div', { class: 'fp-row fp-note muted', style: `--depth:${depth}` }, 'Loading…') });
        return;
      }
      if ('error' in listing) {
        rows.push({ path: `${dir}/!`, dir: false, el: h('div', { class: 'fp-row fp-note fp-error', style: `--depth:${depth}`, title: listing.error }, listing.error) });
        return;
      }
      const entries = [...listing.entries].sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })));
      for (const e of entries) {
        const path = dir ? `${dir}/${e.name}` : e.name;
        const ignored = ignoredAbove || this.isIgnored(path, e.dir);
        if (ignored && !showIgnored) continue;
        const change = changed.get(path);
        const open = e.dir && this.expanded.has(path);
        const el = h(
          'div',
          {
            class: ['fp-row', e.dir ? 'dir' : 'file', ignored ? 'ignored' : '', change ? `st-${change.state}` : '', e.dir && changedDirs.has(path) ? 'has-changes' : ''].filter(Boolean).join(' '),
            style: `--depth:${depth}`,
            title: [path, change ? STATE_NAME[change.state] : '', e.link ? 'A link to another folder or file' : ''].filter(Boolean).join('\n'),
          },
          h('span', { class: 'fp-chev', html: e.dir ? (open ? icons.chevronDown : icons.chevronRight) : '' }),
          h('span', { class: 'fp-icon', html: e.dir ? icons.folder : icons.file }),
          h('span', { class: 'fp-name' }, e.name),
          change ? h('span', { class: 'fp-letter' }, LETTER[change.state]) : e.dir && changedDirs.has(path) ? h('span', { class: 'fp-dot' }) : null,
        );
        el.addEventListener('click', () => this.activateRow({ path, dir: e.dir, el }));
        rows.push({ path, dir: e.dir, el });
        if (open) walk(path, depth + 1, ignored);
      }
      if (listing.truncated) rows.push({ path: `${dir}/+`, dir: false, el: h('div', { class: 'fp-row fp-note muted', style: `--depth:${depth}` }, 'More files than shown here') });
    };
    walk('', 0, false);
    return rows;
  }

  /** A changed file (or a "go to file" result): its name, its folder, and what changed. */
  private fileRow(path: string, change: FileChange | null): SideRow {
    const dir = dirOf(path);
    const el = h(
      'div',
      { class: `fp-row fp-flat file${change ? ` st-${change.state}` : ''}`, title: [path, change ? STATE_NAME[change.state] : '', change?.oldPath ? `was ${change.oldPath}` : ''].filter(Boolean).join('\n') },
      h('span', { class: 'fp-icon', html: icons.file }),
      h('span', { class: 'fp-name' }, nameOf(path)),
      h('span', { class: 'fp-dir' }, dir),
      change && change.added !== null ? h('span', { class: 'fp-counts' }, change.added ? h('span', { class: 'fp-plus' }, `+${change.added}`) : null, change.removed ? h('span', { class: 'fp-minus' }, `−${change.removed}`) : null) : null,
      change ? h('span', { class: 'fp-letter' }, LETTER[change.state]) : null,
    );
    const row = { path, dir: false, el };
    el.addEventListener('click', () => this.activateRow(row));
    return row;
  }

  private changeRowsFor(files: FileChange[]): SideRow[] {
    return files.map((f) => this.fileRow(f.path, f));
  }

  private filterRows(q: string): SideRow[] {
    if (q.startsWith('@')) return this.symbolRows(q.slice(1).trim());
    if (this.view === 'changes') {
      const files = (this.changes?.files ?? []).filter((f) => fuzzyScore(q, f.path) !== null);
      return this.changeRowsFor(files);
    }
    if (!this.allFiles) {
      void this.loadAllFiles();
      return [];
    }
    const scored: [number, string][] = [];
    for (const path of this.allFiles) {
      const byName = fuzzyScore(q, nameOf(path));
      const byPath = fuzzyScore(q, path);
      const score = Math.max(byName === null ? -Infinity : byName * 1.5, byPath ?? -Infinity);
      if (score > -Infinity) scored.push([score, path]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
    return scored.slice(0, 200).map(([, path]) => this.fileRow(path, this.changeOf(path)));
  }

  /** The open file's functions, classes and headings, for `@` in Go to file. */
  private symbolRows(q: string): SideRow[] {
    const o = this.opened;
    if (!o?.lines) return [];
    const symbols = fileSymbols(o.lines, langFor(o.path)?.id === 'markdown');
    const shown = q ? symbols.map((s) => ({ s, score: fuzzyScore(q, s.name) })).filter((x) => x.score !== null).sort((a, b) => b.score! - a.score!).map((x) => x.s) : symbols;
    return shown.slice(0, 500).map((s, i) => {
      const el = h(
        'div',
        { class: 'fp-row fp-symbol', style: `--depth:${q ? 0 : Math.min(s.depth, 6)}`, title: `Line ${s.line + 1}` },
        h('span', { class: 'fp-symkind' }, s.kind),
        h('span', { class: 'fp-name' }, s.name),
        h('span', { class: 'fp-matchline' }, String(s.line + 1)),
      );
      const row: SideRow = { path: `\0sym:${s.line}:${i}`, dir: false, el, open: () => void this.goTo(o.path, s.line + 1, this.wordRanges(o.lines![s.line], s.name)) };
      el.addEventListener('click', () => row.open!());
      return row;
    });
  }

  private activateRow(row: SideRow): void {
    this.cursor = row.path;
    if (row.open) return row.open();
    if (row.toggle) return row.toggle();
    if (row.dir) {
      void this.toggleDir(row.path);
      return;
    }
    if (row.path.endsWith('/…') || row.path.endsWith('/!') || row.path.endsWith('/+')) return;
    const fromChanges = this.view === 'changes';
    if (this.filterInput.value && this.view === 'all') {
      this.filterInput.value = '';
    }
    void this.show(row.path, fromChanges || (this.mode === 'diff' && !!this.changeOf(row.path)) ? 'diff' : 'file');
  }

  private async toggleDir(path: string, open = !this.expanded.has(path)): Promise<void> {
    if (open) {
      this.expanded.add(path);
      if (!this.listings.has(path)) {
        this.renderList();
        await this.loadDir(path);
      }
    } else {
      this.expanded.delete(path);
    }
    this.renderList();
  }

  private markCursor(): void {
    for (const r of this.sideRows) {
      r.el.classList.toggle('sel', r.path === this.cursor);
      r.el.classList.toggle('open', r.path === this.opened?.path);
    }
  }

  /** Arrow keys and Enter in the list, or in the filter above it. */
  private listKey(e: KeyboardEvent, inFilter: boolean): void {
    const rows = this.sideRows.filter((r) => !/\/[…!+]$/.test(r.path) && !r.path.startsWith('\0note:'));
    const i = rows.findIndex((r) => r.path === this.cursor);
    const move = (to: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!row) return;
      this.cursor = row.path;
      this.markCursor();
      row.el.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Enter') {
      const row = rows[i] ?? (inFilter ? rows[0] : undefined);
      if (row) this.activateRow(row);
    } else if (e.key === 'Escape' && inFilter) {
      this.filterInput.value = '';
      this.renderList();
      this.listEl.focus();
    } else if (!inFilter && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const row = rows[i];
      if (!row) return;
      if (row.toggle) row.toggle();
      else if (row.dir && (e.key === 'ArrowRight') !== this.expanded.has(row.path)) void this.toggleDir(row.path);
      else if (e.key === 'ArrowLeft' && dirOf(row.path) && this.view === 'all') {
        this.cursor = dirOf(row.path);
        this.markCursor();
      } else return;
    } else return;
    e.preventDefault();
  }

  private dragSplitter(e: PointerEvent, splitter: HTMLElement): void {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const start = e.clientX;
    const width = this.sideEl.getBoundingClientRect().width;
    document.body.classList.add('resizing-col');
    const move = (ev: PointerEvent) => {
      this.sideEl.style.width = `${Math.max(140, Math.min(width + ev.clientX - start, this.el.clientWidth - 200))}px`;
    };
    const up = () => {
      document.body.classList.remove('resizing-col');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      this.queueFit();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  }

  // ---- the viewer ---------------------------------------------------------

  private renderHeader(): void {
    this.header.name.textContent = this.name;
    this.header.title.textContent = this.opened?.path ?? this.root;
    this.el.style.setProperty('--session-color', this.color || 'transparent');
  }

  private renderBar(): void {
    const o = this.opened;
    this.renderHeader();
    const seg = <T extends string>(value: T, options: [T, string, string][], pick: (v: T) => void) =>
      h(
        'div',
        { class: 'fp-seg' },
        ...options.map(([v, label, title]) => h('button', { class: `btn small${v === value ? ' on' : ''}`, title, onclick: () => pick(v) }, label)),
      );
    const crumbs = o
      ? h(
          'span',
          { class: 'fp-crumbs', title: o.path },
          ...o.path.split('/').flatMap((p, i, all) => [i ? h('span', { class: 'fp-crumbsep' }, '/') : null, h('span', { class: i === all.length - 1 ? 'fp-crumb last' : 'fp-crumb' }, p)]),
          o.change ? h('span', { class: `fp-state st-${o.change.state}`, title: o.change.oldPath ? `Renamed from ${o.change.oldPath}` : '' }, STATE_NAME[o.change.state]) : null,
        )
      : h('span', { class: 'fp-crumbs muted' }, this.root);
    const diffable = !!o?.change;
    const nav = h(
      'div',
      { class: 'fp-seg' },
      h('button', { class: 'icon-btn small', title: 'Back (mouse back button)', html: icons.arrowLeft, disabled: !this.back.length, onclick: () => void this.goBack(1) }),
      h('button', { class: 'icon-btn small', title: 'Forward (mouse forward button)', html: icons.arrowRight, disabled: !this.forward.length, onclick: () => void this.goBack(-1) }),
    );
    setChildren(
      this.barEl,
      nav,
      crumbs,
      h('span', { class: 'spacer' }),
      diffable
        ? seg(this.mode, [['file', 'File', 'The file as it is now'], ['diff', 'Diff', 'What changed since the last commit']], (m) => {
            this.mode = m;
            this.renderBar();
            this.renderBody();
            this.host.onInfoChange(this);
          })
        : null,
      diffable && this.mode === 'diff'
        ? seg(store.settings.diffLayout, [['split', 'Side by side', 'Old and new next to each other'], ['inline', 'Inline', 'Removed lines above the added ones']], (l) =>
            store.update((c) => (c.settings.diffLayout = l)),
          )
        : null,
      o
        ? h(
            'div',
            { class: 'fp-seg' },
            h('button', { class: 'icon-btn small', title: 'Previous change (Shift+F7)', html: icons.arrowUp, onclick: () => this.jumpChange(-1) }),
            h('button', { class: 'icon-btn small', title: 'Next change (F7)', html: icons.arrowDown, onclick: () => this.jumpChange(1) }),
          )
        : null,
      o ? this.findInput : null,
      o ? this.findCount : null,
      h('button', { class: 'btn small fp-vscode', title: 'Open the folder in VS Code (with this file at this line)', onclick: () => this.openInEditor(true) }, h('span', { html: icons.openExternal }), 'VS Code'),
    );
  }

  /** Draws the open file: its text, its diff, an image, or why it can't be shown. */
  private renderBody(keepScroll = false): void {
    const o = this.opened;
    const top = keepScroll ? (this.views[this.views.length - 1]?.scrollTop ?? 0) : 0;
    this.views = [];
    this.changeRows = [];
    this.rowsTotal = 0;
    this.rowLine = () => null;
    if (!o) {
      this.bodyEl.replaceChildren(h('div', { class: 'fp-placeholder muted' }, h('span', { html: icons.files }), h('div', null, 'Pick a file on the left.'), h('div', { class: 'fp-hint' }, 'Read-only. VS Code opens the whole folder for editing.')));
      this.findRows = [];
      this.updateFindCount();
      return;
    }
    if (this.mode === 'diff' && o.change) this.renderDiff(o);
    else this.renderFile(o);
    for (const v of this.views) v.scrollTop = top;
    for (const v of this.views) v.draw(true);
    if (this.findInput.value) this.find(0, true);
  }

  private message(text: string, extra?: HTMLElement): void {
    this.bodyEl.replaceChildren(h('div', { class: 'fp-placeholder muted' }, h('div', null, text), extra ?? null));
  }

  private notTextMessage(c: FileContent | null, what: string): string {
    if (!c) return '';
    const mb = (c.size / (1 << 20)).toFixed(1);
    return c.kind === 'binary' ? `${what} is a binary file (${mb} MB).` : c.kind === 'tooLarge' ? `${what} is too large to show here (${mb} MB).` : '';
  }

  private renderFile(o: Opened): void {
    if (o.error || !o.content) {
      const gone = o.change?.state === 'deleted';
      this.message(
        gone ? 'This file was deleted.' : (o.error ?? ''),
        gone ? h('button', { class: 'btn small', onclick: () => ((this.mode = 'diff'), this.renderBar(), this.renderBody()) }, 'Show what it was') : undefined,
      );
      return;
    }
    if (o.content.kind === 'image') {
      this.bodyEl.replaceChildren(h('div', { class: 'fp-image' }, h('img', { src: o.content.dataUrl, alt: o.path })));
      return;
    }
    if (o.content.kind !== 'text' || !o.lines) {
      this.message(this.notTextMessage(o.content, 'This'), h('button', { class: 'btn small', onclick: () => this.openInEditor(true) }, 'Open in VS Code'));
      return;
    }
    const lines = o.lines;
    if (!lines.length) {
      this.message('This file is empty.');
      return;
    }
    const marks = o.change ? lineMarks(o.hunks) : new Map<number, LineMark>();
    const view = new LineView('fp-code');
    view.el.tabIndex = 0;
    view.el.style.setProperty('--ln-w', `${Math.max(3, String(lines.length).length)}ch`);
    view.el.style.setProperty('--lv-gutter', 'calc(var(--ln-w) + 28px)');
    const target = this.target?.path === o.path ? this.target : null;
    view.set(lines.length, widestLine(lines), (i) => {
      const mark = marks.get(i);
      const here = target?.line === i + 1;
      return h(
        'div',
        { class: here ? 'lv-row lv-target' : 'lv-row' },
        h('span', { class: 'lv-gutter' }, h('span', { class: 'lv-ln' }, String(i + 1)), h('span', { class: `lv-mark${mark ? ` m-${mark}` : ''}` })),
        h('span', { class: 'lv-code' }, ...codeNodes(o.hl.tokens(i), here ? target.ranges : null)),
      );
    });
    this.changeRows = [...marks.keys()].sort((a, b) => a - b).filter((l, i, all) => i === 0 || all[i - 1] !== l - 1);
    this.rowText = (i) => lines[i] ?? '';
    this.rowLine = (i) => (i < lines.length ? i + 1 : null);
    this.mountViews([view], lines.length);
  }

  private renderDiff(o: Opened): void {
    if (!o.lines && !o.oldLines) {
      this.message(this.notTextMessage(o.content ?? o.oldContent, 'This') || 'There is no text to compare.', h('button', { class: 'btn small', onclick: () => this.openInEditor(true) }, 'Open in VS Code'));
      return;
    }
    if ((o.content && o.content.kind !== 'text') || (o.oldContent && o.oldContent.kind !== 'text')) {
      const img = o.content?.kind === 'image' ? h('div', { class: 'fp-image' }, h('img', { src: o.content.dataUrl, alt: o.path })) : undefined;
      this.message(o.content?.kind === 'image' ? 'The image changed. This is how it is now:' : this.notTextMessage(o.content?.kind !== 'text' ? o.content : o.oldContent, 'This'), img);
      return;
    }
    const lines = o.lines ?? [];
    const old = o.oldLines ?? [];
    const digits = `${Math.max(3, String(Math.max(lines.length, old.length)).length)}ch`;
    // Changed lines paired up, for the words that changed in them.
    const pairs = pairRows(o.hunks, old.length);
    const partner = new Map<string, number>();
    for (const p of pairs) if (p.kind === 'mod') partner.set(`o${p.old}`, p.new!).set(`n${p.new}`, p.old!);
    const words = (oldLine: number, newLine: number) => {
      const key = `${oldLine}:${newLine}`;
      if (!this.wordCache.has(key)) this.wordCache.set(key, wordDiff(old[oldLine] ?? '', lines[newLine] ?? ''));
      return this.wordCache.get(key) ?? null;
    };
    const foldRow = (f: Fold, cls: string) => {
      const el = h('div', { class: `lv-row lv-fold ${cls}`, title: 'Click to show them' }, h('span', { class: 'lv-gutter' }), h('span', { class: 'lv-code' }, `⋯ ${f.fold} unchanged lines`));
      el.addEventListener('click', () => {
        this.openFolds.add(f.key);
        this.renderBody(true);
      });
      return el;
    };
    const ln = (n: number | null) => h('span', { class: 'lv-ln' }, n === null ? '' : String(n + 1));

    if (store.settings.diffLayout === 'inline') {
      const rows = foldRows(inlineRows(o.hunks, old.length), CONTEXT, this.openFolds);
      const view = new LineView('fp-code fp-diff');
      view.el.tabIndex = 0;
      view.el.style.setProperty('--ln-w', digits);
      view.el.style.setProperty('--lv-gutter', 'calc(2 * var(--ln-w) + 40px)');
      const textOf = (r: InlineRow) => (r.old !== null ? old[r.old] : lines[r.new!]) ?? '';
      view.set(rows.length, Math.max(widestLine(lines), widestLine(old)), (i) => {
        const r = rows[i];
        if (isFold(r)) return foldRow(r, '');
        const tokens = r.kind === 'del' ? o.oldHl.tokens(r.old!) : o.hl.tokens(r.new!);
        const other = r.kind === 'del' ? partner.get(`o${r.old}`) : r.kind === 'add' ? partner.get(`n${r.new}`) : undefined;
        const changed = other === undefined ? null : r.kind === 'del' ? (words(r.old!, other)?.old ?? null) : (words(other, r.new!)?.new ?? null);
        return h(
          'div',
          { class: `lv-row d-${r.kind}` },
          h('span', { class: 'lv-gutter' }, ln(r.old), ln(r.new), h('span', { class: 'lv-sign' }, r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : '')),
          h('span', { class: 'lv-code' }, ...codeNodes(tokens, changed)),
        );
      });
      this.changeRows = changeStarts(rows);
      this.rowText = (i) => {
        const r = rows[i];
        return !r || isFold(r) ? '' : textOf(r);
      };
      this.rowLine = (i) => {
        const r = rows[i];
        return !r || isFold(r) || r.new === null ? null : r.new + 1;
      };
      this.mountViews([view], rows.length);
      return;
    }

    const rows = foldRows(pairs, CONTEXT, this.openFolds);
    const side = (which: 'old' | 'new') => {
      const view = new LineView(`fp-code fp-diff fp-${which}`);
      view.el.tabIndex = 0;
      view.el.style.setProperty('--ln-w', digits);
      view.el.style.setProperty('--lv-gutter', 'calc(var(--ln-w) + 28px)');
      const text = which === 'old' ? old : lines;
      view.set(rows.length, widestLine(text), (i) => {
        const r = rows[i];
        if (isFold(r)) return foldRow(r, '');
        const line = which === 'old' ? r.old : r.new;
        if (line === null) return h('div', { class: 'lv-row d-filler' }, h('span', { class: 'lv-gutter' }), h('span', { class: 'lv-code' }));
        const kind = r.kind === 'same' ? 'same' : which === 'old' ? 'del' : 'add';
        const changed = r.kind === 'mod' ? (words(r.old!, r.new!)?.[which] ?? null) : null;
        return h(
          'div',
          { class: `lv-row d-${kind}` },
          h('span', { class: 'lv-gutter' }, ln(line), h('span', { class: 'lv-sign' }, kind === 'add' ? '+' : kind === 'del' ? '−' : '')),
          h('span', { class: 'lv-code' }, ...codeNodes(which === 'old' ? o.oldHl.tokens(line) : o.hl.tokens(line), changed)),
        );
      });
      return view;
    };
    const left = side('old');
    const right = side('new');
    // One vertical position for both sides; each scrolls sideways on its own.
    let syncing = false;
    const follow = (from: LineView, to: LineView) => {
      from.onScroll = (top) => {
        if (syncing || to.scrollTop === top) return;
        syncing = true;
        to.scrollTop = top;
        syncing = false;
      };
    };
    follow(left, right);
    follow(right, left);
    this.changeRows = changeStarts(rows);
    this.rowText = (i) => {
      const r = rows[i] as PairRow | Fold | undefined;
      if (!r || isFold(r)) return '';
      return `${r.old !== null ? old[r.old] : ''}\n${r.new !== null ? lines[r.new] : ''}`;
    };
    this.rowLine = (i) => {
      const r = rows[i] as PairRow | Fold | undefined;
      return !r || isFold(r) || r.new === null ? null : r.new + 1;
    };
    this.mountViews([left, right], rows.length);
  }

  private mountViews(views: LineView[], rows: number): void {
    this.views = views;
    this.rowsTotal = rows;
    const box = views.length > 1 ? h('div', { class: 'fp-sbs' }, ...views.map((v) => v.el)) : views[0].el;
    this.bodyEl.replaceChildren(box);
    for (const v of views) v.onDraw = () => this.highlightFind();
  }

  /** Scrolls to the next (or previous) change. */
  private jumpChange(dir: 1 | -1): void {
    const view = this.views[this.views.length - 1];
    if (!view || !this.changeRows.length) return;
    // The change now at the top counts as passed.
    const top = view.topRow() + Math.floor(view.el.clientHeight / view.rowHeight / 3);
    const next = dir > 0 ? this.changeRows.find((r) => r > top) : [...this.changeRows].reverse().find((r) => r < top);
    const target = next ?? (dir > 0 ? this.changeRows[0] : this.changeRows[this.changeRows.length - 1]);
    for (const v of this.views) v.reveal(target);
  }

  // ---- find -------------------------------------------------------------

  /** Finds the text in the find box: `step` 1/-1 moves to the next/previous line with it, 0 stays. */
  private find(step: 0 | 1 | -1, keep = false): void {
    const q = this.findInput.value.toLowerCase();
    this.findRows = [];
    if (q) for (let i = 0; i < this.rowsTotal; i++) if (this.rowText(i).toLowerCase().includes(q)) this.findRows.push(i);
    const n = this.findRows.length;
    if (!n) this.findIndex = -1;
    else if (keep) this.findIndex = Math.max(0, Math.min(this.findIndex, n - 1));
    else if (step === 0) {
      // While typing: the first match from the top of the view down.
      const top = this.views[this.views.length - 1]?.topRow() ?? 0;
      const at = this.findRows.findIndex((r) => r >= top);
      this.findIndex = at >= 0 ? at : 0;
    } else this.findIndex = this.findIndex < 0 ? (step > 0 ? 0 : n - 1) : (this.findIndex + step + n) % n;
    if (n && !keep) for (const v of this.views) v.reveal(this.findRows[this.findIndex]);
    this.updateFindCount();
    this.highlightFind();
  }

  private updateFindCount(): void {
    const q = this.findInput.value;
    this.findCount.textContent = !q ? '' : this.findRows.length ? `${this.findIndex + 1}/${this.findRows.length}` : 'none';
  }

  private clearFind(): void {
    if (findOwner !== this) return;
    CSS.highlights?.delete('fp-find');
    CSS.highlights?.delete('fp-find-current');
    findOwner = null;
  }

  /** Marks the matches in the rows drawn now. */
  private highlightFind(): void {
    const q = this.findInput.value.toLowerCase();
    const reg = CSS.highlights;
    if (!reg) return;
    if (!q) return this.clearFind();
    findOwner = this;
    const all: Range[] = [];
    const current: Range[] = [];
    const currentRow = this.findRows[this.findIndex];
    for (const v of this.views) {
      for (const row of v.rows()) {
        const code = row.querySelector('.lv-code');
        if (!code) continue;
        const isCurrent = Number(row.dataset.row) === currentRow;
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = (n.textContent ?? '').toLowerCase();
          for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
            const range = new Range();
            range.setStart(n, i);
            range.setEnd(n, i + q.length);
            (isCurrent ? current : all).push(range);
          }
        }
      }
    }
    reg.set('fp-find', new Highlight(...all));
    reg.set('fp-find-current', new Highlight(...current));
  }

  // ---- keys and the editor ------------------------------------------------

  private paneKey(e: KeyboardEvent): void {
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    const inCode = !(e.target as HTMLElement).closest('input');
    if (e.key === 'F12' && !e.altKey && inCode) {
      const word = this.wordAtSelection();
      if (!word) toast('Click a name in the file first (or Ctrl+click it).');
      else if (e.shiftKey) void this.findReferences(word);
      else if (e.ctrlKey) void this.goToImplementations(word);
      else void this.goToDefinition(word);
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyF') {
      const selected = inCode ? (window.getSelection()?.toString().trim() ?? '') : '';
      this.searchProject(selected && !selected.includes('\n') ? selected : undefined);
    } else if (e.key === 'F7' && plain) this.jumpChange(e.shiftKey ? -1 : 1);
    else if (e.key === 'F5' && e.altKey && !e.ctrlKey) this.jumpChange(e.shiftKey ? -1 : 1);
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyF') this.openSearch();
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyP') {
      this.filterInput.focus();
      this.filterInput.select();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** The line at the top of the view (1-based, in the current file), for the editor. */
  private topLine(): number | null {
    const o = this.opened;
    const view = this.views[this.views.length - 1];
    if (!o || !view) return null;
    const top = view.topRow();
    if (this.mode === 'file' || !o.change) return top + 1;
    // In a diff, the nearest line of the new text at or below the top.
    const rows = store.settings.diffLayout === 'inline' ? foldRows(inlineRows(o.hunks, o.oldLines?.length ?? 0), CONTEXT, this.openFolds) : foldRows(pairRows(o.hunks, o.oldLines?.length ?? 0), CONTEXT, this.openFolds);
    for (let i = top; i < rows.length; i++) {
      const r = rows[i];
      if (!isFold(r) && r.new !== null) return r.new + 1;
    }
    return null;
  }

  /** VS Code with the whole folder, and (`withFile`) the open file at the line in view. */
  openInEditor(withFile: boolean): void {
    const o = this.opened;
    const file = withFile && o && o.change?.state !== 'deleted' ? o.path : null;
    void api.openInEditor(this.root, file, file ? this.topLine() : null).catch((e) => toast(String(e), 'error', 8000));
  }

  /** The same folder (by its path), for "show files" to reuse an open pane. */
  isFor(root: string): boolean {
    return pathKey(root) === pathKey(this.root);
  }
}
