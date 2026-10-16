import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { api, type PtyMessage } from './api';
import { uid } from './config';
import { h } from './dom';
import { icons } from './icons';
import { matchKey, type Match } from './keys';
import { isWindowsPath, parseOsc7, parseOsc777, parseOsc9 } from './osc';
import { getTheme } from './themes';
import type { LaunchSpec, Settings, ShellProfile } from './types';

export type PaneState = 'starting' | 'running' | 'exited' | 'error';

export interface PaneHost {
  settings(): Settings;
  resolveShell(id: string): ShellProfile | null;
  windowsBuild: number;
  onFocus(pane: Pane): void;
  /** Title, cwd, progress or state changed. */
  onInfoChange(pane: Pane): void;
  onOutput(pane: Pane): void;
  onBell(pane: Pane): void;
  onNotify(pane: Pane, title: string, body: string): void;
  onExit(pane: Pane, code: number | null): void;
  /** An app shortcut was pressed inside the terminal; return true if handled. */
  onShortcut(pane: Pane, match: Match): boolean;
  onContextMenu(pane: Pane, e: MouseEvent): void;
  onHeaderAction(pane: Pane, action: 'zoom' | 'close'): void;
}

function terminalOptions(s: Settings, windowsBuild: number): ITerminalOptions {
  return {
    allowProposedApi: true,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    cursorInactiveStyle: 'outline',
    // Right-click pastes or opens the menu; it must not change the selection first.
    rightClickSelectsWord: false,
    scrollback: s.scrollback,
    theme: getTheme(s.theme).term,
    windowsPty: { backend: 'conpty', buildNumber: windowsBuild || undefined },
    smoothScrollDuration: 0,
    rescaleOverlappingGlyphs: true,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
  };
}

export class Pane {
  readonly id = uid('p-');
  spec: LaunchSpec;
  cwd: string;
  title = '';
  state: PaneState = 'starting';
  exitCode: number | null = null;
  progress: { state: number; value: number } | null = null;
  shell: ShellProfile | null = null;
  lastOutput = 0;
  lastInput = 0;

  readonly el: HTMLDivElement;
  readonly term: Terminal;
  private readonly host: PaneHost;
  private readonly termEl: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly dotEl: HTMLSpanElement;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private searchBox: HTMLElement | null = null;
  private webgl: WebglAddon | null = null;
  private ptyId: number | null = null;
  private pendingInput: string[] = [];
  private generation = 0;
  private opened = false;
  private disposed = false;
  private fitQueued = false;
  private resizeTimer: number | undefined;
  private resizeObserver: ResizeObserver;

  constructor(spec: LaunchSpec, host: PaneHost) {
    this.spec = spec;
    this.cwd = spec.cwd;
    this.host = host;

    this.dotEl = h('span', { class: 'pane-dot' });
    this.nameEl = h('span', { class: 'pane-name' });
    this.titleEl = h('span', { class: 'pane-title' });
    const header = h(
      'div',
      { class: 'pane-header', ondblclick: () => host.onHeaderAction(this, 'zoom') },
      this.dotEl,
      this.nameEl,
      this.titleEl,
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn small', title: 'Maximize / restore (Ctrl+Shift+Z)', html: icons.maximize, onclick: () => host.onHeaderAction(this, 'zoom') }),
      h('button', { class: 'icon-btn small', title: 'Close pane (Ctrl+Shift+W)', html: icons.x, onclick: () => host.onHeaderAction(this, 'close') }),
    );
    this.termEl = h('div', { class: 'pane-term' });
    this.el = h('div', { class: 'pane', dataset: { pane: this.id } }, header, this.termEl);
    this.el.addEventListener('mousedown', () => host.onFocus(this));
    this.termEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const mode = host.settings().rightClick;
      if (e.shiftKey || mode === 'menu') return host.onContextMenu(this, e);
      host.onFocus(this);
      if (mode === 'copyPaste' && this.term.hasSelection()) void this.copySelection(true);
      else void this.paste();
    });
    this.termEl.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        host.onShortcut(this, { action: e.deltaY < 0 ? 'fontUp' : 'fontDown' });
      },
      { capture: true, passive: false },
    );

    this.term = new Terminal({
      ...terminalOptions(host.settings(), host.windowsBuild),
      linkHandler: {
        activate: (e, text) => this.openLink(e, text),
        allowNonHttpProtocols: false,
      },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon((e, uri) => this.openLink(e, uri)));

    this.term.onData((d) => this.sendInput(d));
    this.term.onBinary((d) => {
      if (this.ptyId !== null) void api.writeBytes(this.ptyId, Array.from(d, (c) => c.charCodeAt(0) & 0xff));
    });
    this.term.onResize(({ cols, rows }) => this.schedulePtyResize(cols, rows));
    this.term.onTitleChange((t) => {
      this.title = this.isShellPathTitle(t) ? '' : t;
      this.updateHeader();
      host.onInfoChange(this);
    });
    this.term.onBell(() => host.onBell(this));
    this.term.onSelectionChange(() => {
      if (host.settings().copyOnSelect && this.term.hasSelection()) void this.copySelection(false);
    });
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    this.registerOscHandlers();

    this.resizeObserver = new ResizeObserver(() => this.queueFit());
    this.updateHeader();
  }

  get name(): string {
    return this.spec.name;
  }

  /** Console hosts default the title to the shell's path, which is just noise. */
  private isShellPathTitle(title: string): boolean {
    const exe = this.shell?.path.split(/[\\/]/).pop()?.toLowerCase();
    const t = title.trim().toLowerCase();
    return !!exe && (t === exe || t.endsWith(`\\${exe}`) || t.endsWith(`/${exe}`));
  }

  get isRunning(): boolean {
    return this.state === 'running' || this.state === 'starting';
  }

  /** True when the shell has started a program that is still running. */
  async hasRunningProgram(): Promise<boolean> {
    if (this.ptyId === null || this.state !== 'running') return false;
    // If the check fails, assume a pane started with a command (e.g. claude) is busy.
    return api.hasChildren(this.ptyId).catch(() => this.spec.command.trim() !== '');
  }

  /** Must be called once the element is in the document. */
  mount(): void {
    if (this.opened || this.disposed) return;
    this.term.open(this.termEl);
    this.opened = true;
    this.term.textarea?.addEventListener('focus', () => this.host.onFocus(this));
    this.resizeObserver.observe(this.termEl);
    this.fitNow();
  }

  async start(): Promise<void> {
    const gen = ++this.generation;
    this.state = 'starting';
    this.exitCode = null;
    this.progress = null;
    this.host.onInfoChange(this);

    const shell = this.host.resolveShell(this.spec.shellId);
    if (!shell) return this.fail('No shell found. Add one in Settings.');
    this.shell = shell;
    this.fitNow();

    try {
      const id = await api.spawn(
        {
          shell,
          cwd: this.spec.cwd,
          command: this.spec.command.trim() || null,
          env: this.spec.env,
          shellIntegration: this.host.settings().shellIntegration,
          cols: this.term.cols,
          rows: this.term.rows,
        },
        (msg) => this.onPtyMessage(gen, msg),
      );
      if (gen !== this.generation || this.disposed) {
        void api.kill(id);
        return;
      }
      this.ptyId = id;
      if (this.state === 'starting') this.state = 'running';
      const queued = this.pendingInput.join('');
      this.pendingInput = [];
      if (queued) void api.write(id, queued);
      // The size may have changed while the process was starting.
      void api.resize(id, this.term.cols, this.term.rows);
      this.host.onInfoChange(this);
    } catch (err) {
      if (gen === this.generation) this.fail(String(err));
    }
  }

  restart(): void {
    if (this.ptyId !== null) void api.kill(this.ptyId);
    this.ptyId = null;
    this.pendingInput = [];
    this.term.write('\r\n');
    void this.start();
  }

  /** Restarts in the current directory with another shell (the startup command runs again). */
  switchShell(shellId: string): void {
    this.spec = { ...this.spec, shellId, cwd: this.cwd };
    this.restart();
  }

  private fail(message: string): void {
    this.state = 'error';
    this.term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n\x1b[90mPress Enter to retry.\x1b[0m\r\n`);
    this.host.onInfoChange(this);
  }

  private onPtyMessage(gen: number, msg: PtyMessage): void {
    if (gen !== this.generation || this.disposed) return;
    if (typeof msg === 'string') {
      this.term.write(msg);
      this.lastOutput = performance.now();
      this.host.onOutput(this);
      return;
    }
    this.ptyId = null;
    this.state = 'exited';
    this.exitCode = msg.exit;
    this.progress = null;
    const code = msg.exit === null ? 'unknown' : String(msg.exit);
    this.term.write(`\r\n\x1b[90m[Process exited with code ${code}. Press Enter to restart.]\x1b[0m\r\n`);
    this.updateHeader();
    this.host.onInfoChange(this);
    this.host.onExit(this, msg.exit);
  }

  sendInput(data: string): void {
    if (this.disposed) return;
    if (this.state === 'exited' || this.state === 'error') {
      if (data === '\r') this.restart();
      return;
    }
    this.lastInput = performance.now();
    if (this.ptyId === null) this.pendingInput.push(data);
    else void api.write(this.ptyId, data);
  }

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true;
    const match = matchKey(e);
    if (match && this.host.onShortcut(this, match)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    const onlyCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
    if (onlyCtrl && e.code === 'KeyC' && this.term.hasSelection()) {
      e.preventDefault();
      void this.copySelection(true);
      return false;
    }
    if (onlyCtrl && e.code === 'KeyV') {
      e.preventDefault();
      void this.paste();
      return false;
    }
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && this.host.settings().shiftEnterNewline) {
      e.preventDefault();
      this.sendInput('\x1b\r');
      return false;
    }
    if (e.key === 'Escape' && this.searchBox) {
      this.closeSearch();
      return false;
    }
    return true;
  }

  async copySelection(clear: boolean): Promise<void> {
    const text = this.term.getSelection();
    if (!text) return;
    await api.clipboardWrite(text).catch(() => undefined);
    if (clear) this.term.clearSelection();
  }

  /**
   * Pastes clipboard text. When the clipboard holds no text (e.g. a
   * screenshot) the raw Ctrl+V is forwarded so programs like Claude Code can
   * read the image from the clipboard themselves.
   */
  async paste(): Promise<void> {
    const text = await api.clipboardRead().catch(() => '');
    if (text) this.term.paste(text);
    else this.sendInput('\x16');
    this.term.focus();
  }

  private openLink(e: MouseEvent, uri: string): void {
    if (!e.ctrlKey) return;
    void api.openUrl(uri).catch(() => undefined);
  }

  private registerOscHandlers(): void {
    const setCwd = (path: string) => {
      if (!isWindowsPath(path) || path === this.cwd) return;
      this.cwd = path;
      this.host.onInfoChange(this);
    };
    const handle = (r: ReturnType<typeof parseOsc9>) => {
      if (!r) return;
      if (r.kind === 'cwd') setCwd(r.path);
      else if (r.kind === 'notify') this.host.onNotify(this, r.title, r.body);
      else if (r.kind === 'progress') {
        this.progress = r.state === 0 ? null : { state: r.state, value: r.value };
        this.updateHeader();
        this.host.onInfoChange(this);
      }
    };
    this.term.parser.registerOscHandler(7, (data) => {
      const p = parseOsc7(data);
      if (p) setCwd(p);
      return true;
    });
    this.term.parser.registerOscHandler(9, (data) => {
      handle(parseOsc9(data));
      return true;
    });
    this.term.parser.registerOscHandler(777, (data) => {
      handle(parseOsc777(data));
      return true;
    });
  }

  private updateHeader(): void {
    this.nameEl.textContent = this.spec.name;
    this.titleEl.textContent = this.title && this.title !== this.spec.name ? this.title : '';
    this.el.style.setProperty('--session-color', this.spec.color || 'transparent');
    this.el.classList.toggle('exited', this.state === 'exited' || this.state === 'error');
    this.dotEl.className = `pane-dot${this.progress ? ' busy' : ''}`;
  }

  rename(name: string): void {
    this.spec = { ...this.spec, name };
    this.updateHeader();
    this.host.onInfoChange(this);
  }

  queueFit(): void {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      this.fitNow();
    });
  }

  fitNow(): void {
    if (!this.opened || this.disposed) return;
    if (this.termEl.offsetWidth < 10 || this.termEl.offsetHeight < 10) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const cols = Math.max(2, dims.cols);
    const rows = Math.max(1, dims.rows);
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  private schedulePtyResize(cols: number, rows: number): void {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (this.ptyId !== null) void api.resize(this.ptyId, cols, rows).catch(() => undefined);
    }, 40);
  }

  focus(): void {
    this.term.focus();
  }

  setActive(active: boolean): void {
    this.el.classList.toggle('active', active);
  }

  /** GPU rendering. Contexts are limited, so the workspace turns this on and off. */
  get hasGpu(): boolean {
    return this.webgl !== null;
  }

  enableGpu(): void {
    if (this.webgl || !this.opened || this.disposed || !this.host.settings().gpuAcceleration) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => this.disableGpu());
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      this.webgl = null;
    }
  }

  disableGpu(): void {
    if (!this.webgl) return;
    try {
      this.webgl.dispose();
    } catch {
      // already gone
    }
    this.webgl = null;
  }

  applySettings(s: Settings): void {
    const o = terminalOptions(s, this.host.windowsBuild);
    this.term.options.fontFamily = o.fontFamily;
    this.term.options.fontSize = o.fontSize;
    this.term.options.lineHeight = o.lineHeight;
    this.term.options.cursorStyle = o.cursorStyle;
    this.term.options.cursorBlink = o.cursorBlink;
    this.term.options.scrollback = o.scrollback;
    this.term.options.theme = o.theme;
    if (!s.gpuAcceleration) this.disableGpu();
    this.queueFit();
  }

  // ---- search ---------------------------------------------------------

  openSearch(): void {
    if (this.searchBox) {
      this.searchBox.querySelector('input')?.select();
      return;
    }
    const input = h('input', { class: 'input small', placeholder: 'Find', spellcheck: false });
    const count = h('span', { class: 'search-count' });
    let caseSensitive = false;
    let regex = false;
    const decorations = {
      matchBackground: '#5a4a1a',
      activeMatchBackground: '#c07a00',
      matchOverviewRuler: '#a08030',
      activeMatchColorOverviewRuler: '#ffb000',
    };
    const opts = () => ({ caseSensitive, regex, decorations });
    const next = () => this.search.findNext(input.value, opts());
    const prev = () => this.search.findPrevious(input.value, opts());
    const toggle = (label: string, title: string, set: (v: boolean) => void) => {
      const b = h('button', { class: 'toggle-btn', title }, label);
      b.addEventListener('click', () => {
        const on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        set(on);
        next();
        input.focus();
      });
      return b;
    };
    const sub = this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = input.value ? (resultCount ? `${resultIndex + 1}/${resultCount}` : 'No results') : '';
    });
    input.addEventListener('input', () => {
      if (input.value) next();
      else {
        this.search.clearDecorations();
        count.textContent = '';
      }
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) prev();
        else next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSearch();
      }
    });
    this.searchBox = h(
      'div',
      { class: 'search-box' },
      h('span', { class: 'search-icon', html: icons.search }),
      input,
      count,
      toggle('Aa', 'Match case', (v) => (caseSensitive = v)),
      toggle('.*', 'Regular expression', (v) => (regex = v)),
      h('button', { class: 'icon-btn small', title: 'Previous (Shift+Enter)', html: icons.chevronDown, style: 'transform:rotate(180deg)', onclick: prev }),
      h('button', { class: 'icon-btn small', title: 'Next (Enter)', html: icons.chevronDown, onclick: next }),
      h('button', { class: 'icon-btn small', title: 'Close (Esc)', html: icons.x, onclick: () => this.closeSearch() }),
    );
    (this.searchBox as any)._dispose = () => sub.dispose();
    const sel = this.term.getSelection();
    if (sel && !sel.includes('\n')) input.value = sel;
    this.el.append(this.searchBox);
    input.focus();
    input.select();
    if (input.value) next();
  }

  closeSearch(): void {
    if (!this.searchBox) return;
    (this.searchBox as any)._dispose?.();
    this.searchBox.remove();
    this.searchBox = null;
    this.search.clearDecorations();
    this.term.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    clearTimeout(this.resizeTimer);
    this.resizeObserver.disconnect();
    if (this.ptyId !== null) void api.kill(this.ptyId);
    this.ptyId = null;
    this.disableGpu();
    this.term.dispose();
    this.el.remove();
  }
}
