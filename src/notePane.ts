/**
 * A note pane: plain text to keep things in (commands, log output), like Notepad++'s tabs. A note
 * doesn't have to be saved: while its text differs from its file (or it has no file), the text is
 * kept in the config folder (notes.rs), so every note reopens after a restart as it was.
 */
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api } from './api';
import { baseName, uid } from './config';
import { toast } from './dialogs';
import { h } from './dom';
import { icons } from './icons';
import { matchNoteKey } from './keys';
import { appendText, editorText, fileEol, fileText, findAll, nearestMatch, type Eol } from './note';
import { paneHeader, type PaneEvents, type WorkspacePane } from './panes';
import type { NoteRef, SnapshotLeaf } from './snapshot';
import type { Settings } from './types';

/** Typing is kept this long after it stops. */
const KEEP_DELAY = 500;

/** The note last focused: "Add to note" adds there. */
let lastNote: NotePane | null = null;
export const latestNote = (): NotePane | null => lastNote;

export class NotePane implements WorkspacePane {
  readonly id = uid('p-');
  readonly kind = 'note';
  readonly el: HTMLDivElement;
  readonly title = '';
  readonly color = '';
  readonly progress = null;
  readonly ended = false;
  readonly hasGpu = false;
  readonly keptOnQuit = true;
  lastOutput = 0;
  readonly ref: NoteRef;

  /** The file's text as last read or written, with `\n` line endings ('' without a file). */
  private saved = '';
  private eol: Eol = 'crlf';
  /** Set until it has been read from disk; nothing is kept before that. */
  private loading: Promise<void> | null = null;
  private ready = false;
  /** Why the note or its file couldn't be read. */
  private problem = '';
  /** What the config folder keeps for it: null = nothing, undefined = not known (a write failed). */
  private kept: string | null | undefined = undefined;
  private keepTimer: number | undefined;
  /** Writes to the config folder, one after another. */
  private writing: Promise<void> = Promise.resolve();
  private warned = false;
  /** What `dirty` says, worked out on each edit: reading a large note's text costs a copy of it. */
  private changes = false;
  private findIndex = -1;
  private disposed = false;

  private readonly header: ReturnType<typeof paneHeader>;
  private readonly input: HTMLTextAreaElement;
  private readonly infoEl: HTMLElement;
  private readonly problemEl: HTMLElement;
  private readonly findInput: HTMLInputElement;
  private readonly findCount: HTMLElement;
  private readonly wrapBtn: HTMLButtonElement;

  /** `text` starts a new note with it (it has nothing kept yet). */
  constructor(
    ref: NoteRef,
    private readonly host: PaneEvents,
    private readonly text = '',
  ) {
    this.ref = { ...ref };
    this.header = paneHeader((action) => host.onHeaderAction(this, action));
    this.input = h('textarea', { class: 'note-input', spellcheck: false, autocomplete: 'off', placeholder: 'Paste or type anything to keep: commands, log lines, results…' });
    this.input.readOnly = true;
    this.input.addEventListener('input', () => this.changed());
    this.input.addEventListener('keydown', (e) => {
      // Tab is typed, as in any text editor.
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || this.input.readOnly) return;
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    });
    this.infoEl = h('span', { class: 'note-info' });
    this.problemEl = h('div', { class: 'note-problem' });
    this.findInput = h('input', { class: 'input small note-find', placeholder: 'Find', spellcheck: false });
    this.findCount = h('span', { class: 'note-find-count muted' });
    this.findInput.addEventListener('input', () => this.find(0));
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.find(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.findInput.value = '';
        this.findCount.textContent = '';
        this.input.focus();
      }
    });
    const tool = (icon: keyof typeof icons, label: string, title: string, fn: () => void) =>
      h('button', { class: 'rq-tool', title, onclick: fn }, h('span', { html: icons[icon] }), label);
    this.wrapBtn = tool('list', 'Wrap', 'Wrap long lines', () => this.setWrap(!this.ref.wrap));
    this.el = h(
      'div',
      { class: 'pane note-pane', dataset: { pane: this.id } },
      this.header.el,
      h(
        'div',
        { class: 'note-bar' },
        this.infoEl,
        h('span', { class: 'spacer' }),
        this.findInput,
        this.findCount,
        this.wrapBtn,
        tool('save', 'Save', 'Save to a file (Ctrl+S)', () => void this.save()),
        tool('save', 'Save as…', 'Save to another file', () => void this.saveAs()),
      ),
      this.problemEl,
      this.input,
    );
    this.el.addEventListener('mousedown', () => host.onFocus(this));
    this.el.addEventListener('focusin', () => {
      lastNote = this;
      host.onFocus(this);
    });
    this.el.addEventListener('keydown', (e) => {
      const action = matchNoteKey(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'save') void this.save();
      else this.openSearch();
    });
    this.el.addEventListener('contextmenu', (e) => {
      // The text keeps its own menu (cut, copy, paste).
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      e.preventDefault();
      host.onContextMenu(this, e);
    });
    this.setWrap(this.ref.wrap);
    this.applySettings(host.settings());
    this.render();
  }

  // ---- WorkspacePane ----------------------------------------------------

  get name(): string {
    return this.ref.path ? baseName(this.ref.path) : this.ref.name;
  }

  get location(): string {
    return this.ref.path || 'Not saved to a file (Shellman keeps it)';
  }

  /** The file it is saved to ('' = none). */
  get path(): string {
    return this.ref.path;
  }

  /** The file's line endings, for the status bar ('' without a file). */
  get eolLabel(): string {
    return this.ref.path ? this.eol.toUpperCase() : '';
  }

  /** Not saved to a file, or changed since. An empty note without a file has nothing to save. */
  get dirty(): boolean {
    return this.changes;
  }

  mount(): void {}

  start(): Promise<void> {
    return (this.loading ??= this.load());
  }

  setActive(active: boolean): void {
    this.el.classList.toggle('active', active);
  }

  setZoomed(zoomed: boolean): void {
    this.header.setZoomed(zoomed);
  }

  queueFit(): void {}

  focus(): void {
    if (!this.el.contains(document.activeElement)) this.input.focus();
  }

  enableGpu(): void {}
  disableGpu(): void {}

  applySettings(s: Settings): void {
    this.input.style.fontFamily = s.fontFamily;
    this.input.style.fontSize = `${s.fontSize}px`;
  }

  async hasRunningProgram(): Promise<boolean> {
    return false;
  }

  snapshot(): SnapshotLeaf {
    return { note: { ...this.ref } };
  }

  openSearch(): void {
    const { value, selectionStart: s, selectionEnd: e } = this.input;
    const selected = value.slice(s, e);
    if (selected && !selected.includes('\n') && selected.length <= 200) this.findInput.value = selected;
    this.findInput.focus();
    this.findInput.select();
    if (this.findInput.value) this.find(0);
  }

  flush(): Promise<void> {
    return this.keep();
  }

  /** Closed: what was kept for it goes. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.keepTimer);
    if (lastNote === this) lastNote = null;
    const id = this.ref.id;
    this.writing = this.writing.then(() => api.noteBackupDelete(id)).catch((e) => console.warn('Could not delete a closed note:', e));
    this.el.remove();
  }

  // ---- text ---------------------------------------------------------------

  private async load(): Promise<void> {
    let kept: string | null = null;
    try {
      kept = await api.noteBackupRead(this.ref.id);
      this.kept = kept;
    } catch (e) {
      this.problem = String(e);
    }
    if (this.ref.path) {
      try {
        const disk = await api.noteFileRead(this.ref.path);
        this.eol = fileEol(disk);
        this.saved = editorText(disk);
      } catch (e) {
        // Gone or unreadable: the note still opens (with what was kept), and saving writes the file again.
        this.problem = String(e);
        this.saved = '';
      }
    }
    if (this.disposed) return;
    this.input.value = kept ?? (this.ref.path ? this.saved : this.text);
    this.input.readOnly = false;
    this.ready = true;
    this.changed();
  }

  /** Adds `text` on lines of its own at the end (from "Add to note"). */
  async append(text: string): Promise<void> {
    await this.start();
    const at = this.input.value.length;
    const added = appendText(this.input.value, text).slice(at);
    // In the note being typed in, as an edit (Ctrl+Z takes it back); execCommand types into whatever
    // has focus, so otherwise (a terminal has it) the text is put in directly.
    if (document.activeElement === this.input) {
      this.input.setSelectionRange(at, at);
      document.execCommand('insertText', false, added);
    } else this.input.setRangeText(added, at, at, 'end');
    this.input.scrollTop = this.input.scrollHeight;
    this.changed();
  }

  private changed(): void {
    clearTimeout(this.keepTimer);
    this.keepTimer = window.setTimeout(() => void this.keep(), KEEP_DELAY);
    if (this.findInput.value) this.findCount.textContent = '';
    const dirty = this.ready && this.input.value !== this.saved;
    if (dirty !== this.changes) {
      this.changes = dirty;
      this.render();
      this.host.onInfoChange(this);
    }
  }

  /** Writes the text to the config folder while it isn't saved to the file, and deletes it when it is. */
  private keep(): Promise<void> {
    clearTimeout(this.keepTimer);
    this.keepTimer = undefined;
    if (!this.ready || this.disposed) return this.writing;
    const text = this.dirty ? this.input.value : null;
    if (text === this.kept) return this.writing;
    this.kept = text;
    const id = this.ref.id;
    this.writing = this.writing
      .then(() => (text === null ? api.noteBackupDelete(id) : api.noteBackupWrite(id, text)))
      .catch((e) => {
        this.kept = undefined;
        if (this.warned) return;
        this.warned = true;
        toast(`Could not keep "${this.name}" for the next start: ${e}`, 'error', 10000);
      });
    return this.writing;
  }

  // ---- saving -------------------------------------------------------------

  async save(): Promise<boolean> {
    return this.ref.path ? this.writeFile(this.ref.path) : this.saveAs();
  }

  async saveAs(): Promise<boolean> {
    const path = await saveDialog({
      title: `Save "${this.name}"`,
      defaultPath: this.ref.path || `${this.ref.name}.txt`,
      filters: [
        { name: 'Text files', extensions: ['txt', 'log', 'md'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }).catch(() => null);
    return path ? this.writeFile(path) : false;
  }

  private async writeFile(path: string): Promise<boolean> {
    await this.start();
    const text = this.input.value;
    try {
      await api.noteFileWrite(path, fileText(text, this.eol));
    } catch (e) {
      toast(String(e), 'error', 8000);
      return false;
    }
    this.ref.path = path;
    this.saved = text;
    this.problem = '';
    this.changes = this.input.value !== text;
    void this.keep();
    this.render();
    this.host.onInfoChange(this);
    return true;
  }

  // ---- view ---------------------------------------------------------------

  private setWrap(wrap: boolean): void {
    if (wrap !== this.ref.wrap) {
      this.ref.wrap = wrap;
      this.host.onInfoChange(this);
    }
    this.input.wrap = wrap ? 'soft' : 'off';
    this.input.classList.toggle('wrap', wrap);
    this.wrapBtn.classList.toggle('on', wrap);
    this.wrapBtn.title = wrap ? 'Long lines wrap: click to scroll sideways instead' : 'Wrap long lines';
  }

  toggleWrap(): void {
    this.setWrap(!this.ref.wrap);
  }

  get wraps(): boolean {
    return this.ref.wrap;
  }

  private render(): void {
    this.header.name.textContent = this.name;
    this.header.title.textContent = this.dirty ? '● unsaved' : '';
    this.infoEl.textContent = this.ref.path || 'Not saved to a file: Shellman keeps it until you close it';
    this.infoEl.title = this.ref.path;
    this.problemEl.textContent = this.problem;
    this.problemEl.hidden = !this.problem;
  }

  /** Selects a match of the search box: `step` 1 = next, -1 = previous, 0 = from the caret. */
  private find(step: number): void {
    const q = this.findInput.value;
    const matches = findAll(this.input.value, q);
    if (!q || !matches.length) {
      this.findCount.textContent = q ? 'No results' : '';
      this.findIndex = -1;
      return;
    }
    const caret = this.input.selectionStart;
    let i: number;
    if (step === 0) i = nearestMatch(matches, caret, false);
    else if (this.findIndex >= 0 && matches[this.findIndex] === caret && this.input.selectionEnd === caret + q.length) i = (this.findIndex + step + matches.length) % matches.length;
    else i = nearestMatch(matches, step > 0 ? this.input.selectionEnd : caret, step < 0);
    this.findIndex = i;
    this.findCount.textContent = `${i + 1} of ${matches.length}`;
    // Selecting in the focused textarea scrolls the match into view; the search box keeps the keys.
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(matches[i], matches[i] + q.length);
    this.findInput.focus({ preventScroll: true });
  }
}
