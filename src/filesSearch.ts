/**
 * The Search view of the Files pane: text search over the folder's files (git grep, see git.rs),
 * results grouped by file. It also shows the lists that code navigation finds (definitions,
 * references, implementations), which are searches for one name.
 */
import { api, type SearchMatch } from './api';
import type { Ranges } from './diff';
import { h } from './dom';
import { icons } from './icons';
import { matchRanges, queryRegExp, type QueryOptions } from './navigate';

/** Results shown at most; a search that finds more says so. */
export const MAX_RESULTS = 2000;
/** A long line is shown from a little before its first match. */
const SNIPPET_LEAD = 12;

export interface SearchRow {
  /** Unique within the list (for the keyboard cursor). */
  path: string;
  dir: boolean;
  el: HTMLElement;
  open?: () => void;
  toggle?: () => void;
}

export interface SearchHost {
  readonly root: string;
  /** Opens a result: the file at `line` (1-based), with `ranges` of that line marked. */
  openMatch(path: string, line: number, ranges: Ranges): void;
  /** The results or the state changed: draw the list again. */
  changed(): void;
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export class ProjectSearch {
  readonly headEl: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly includeInput: HTMLInputElement;
  private readonly toggles: Record<'caseSensitive' | 'word' | 'regex', HTMLButtonElement>;
  private opts: QueryOptions = { query: '', caseSensitive: false, word: false, regex: false };
  /** What a list from code navigation shows ("References to x"); null for a typed search. */
  private title: string | null = null;
  private results: SearchMatch[] | null = null;
  private truncated = false;
  private error: string | null = null;
  private running = false;
  private seq = 0;
  private timer: number | undefined;
  private readonly collapsed = new Set<string>();

  constructor(private readonly host: SearchHost) {
    this.input = h('input', { class: 'input small fp-search-input', placeholder: 'Search in files', spellcheck: false, autocomplete: 'off' });
    this.input.addEventListener('input', () => {
      this.title = null;
      this.schedule();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.run();
      } else if (e.altKey && !e.ctrlKey && ['KeyC', 'KeyW', 'KeyR'].includes(e.code)) {
        e.preventDefault();
        this.flip(e.code === 'KeyC' ? 'caseSensitive' : e.code === 'KeyW' ? 'word' : 'regex');
      }
    });
    const toggle = (key: 'caseSensitive' | 'word' | 'regex', label: string, title: string) =>
      h('button', { class: 'fp-toggle', title, onclick: () => this.flip(key) }, label);
    this.toggles = {
      caseSensitive: toggle('caseSensitive', 'Aa', 'Match case (Alt+C)'),
      word: toggle('word', 'ab', 'Whole word (Alt+W)'),
      regex: toggle('regex', '.*', 'Regular expression (Alt+R)'),
    };
    this.includeInput = h('input', {
      class: 'input small fp-include',
      placeholder: 'In files, e.g. *.cs, src/**, !tests/**',
      spellcheck: false,
      autocomplete: 'off',
      title: 'Globs separated by commas; ! in front leaves those files out',
    });
    this.includeInput.addEventListener('input', () => this.schedule());
    this.includeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.run();
      }
    });
    this.headEl = h(
      'div',
      { class: 'fp-searchhead' },
      h('div', { class: 'fp-searchrow' }, this.input, this.toggles.caseSensitive, this.toggles.word, this.toggles.regex),
      this.includeInput,
    );
    this.renderToggles();
  }

  get query(): QueryOptions {
    return { ...this.opts, query: this.input.value };
  }

  focus(text?: string): void {
    if (text) {
      this.input.value = text;
      this.title = null;
      this.run();
    }
    this.input.focus();
    this.input.select();
  }

  private flip(key: 'caseSensitive' | 'word' | 'regex'): void {
    this.opts[key] = !this.opts[key];
    this.title = null;
    this.renderToggles();
    this.run();
  }

  private renderToggles(): void {
    for (const [key, el] of Object.entries(this.toggles)) el.classList.toggle('on', this.opts[key as keyof typeof this.toggles]);
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(), 300);
  }

  /** Searches for what is in the box (again). */
  run(): void {
    window.clearTimeout(this.timer);
    const q = this.query;
    const seq = ++this.seq;
    if (!q.query) {
      this.results = null;
      this.error = null;
      this.running = false;
      this.host.changed();
      return;
    }
    this.running = true;
    this.host.changed();
    api
      .filesSearch(this.host.root, { ...q, include: this.includeInput.value, max: MAX_RESULTS })
      .then(
        (r) => {
          if (seq !== this.seq) return;
          this.results = r.matches;
          this.truncated = r.truncated;
          this.error = null;
        },
        (e) => {
          if (seq !== this.seq) return;
          this.results = null;
          this.error = String(e);
        },
      )
      .finally(() => {
        if (seq !== this.seq) return;
        this.running = false;
        this.collapsed.clear();
        this.host.changed();
      });
  }

  /** Shows a list found by code navigation: `matches` of `name`, under `title`. */
  showList(title: string, name: string, matches: SearchMatch[]): void {
    this.seq++;
    this.input.value = name;
    this.includeInput.value = '';
    this.opts = { query: name, caseSensitive: true, word: true, regex: false };
    this.renderToggles();
    this.title = title;
    this.results = matches;
    this.truncated = false;
    this.error = null;
    this.running = false;
    this.collapsed.clear();
    this.host.changed();
  }

  /** Searches again (after files changed), unless a navigation list is showing. */
  refresh(): void {
    if (this.input.value && !this.title) this.run();
  }

  /** The rows of the list: a note, then each file with its matching lines. */
  rows(): SearchRow[] {
    const note = (text: string, cls = '') => ({ path: `\0note:${text}`, dir: false, el: h('div', { class: `fp-row fp-note fp-searchnote ${cls}` }, text) });
    if (this.error) return [note(this.error.split('\n')[0], 'fp-error')];
    if (this.running && !this.results) return [note('Searching…', 'muted')];
    if (!this.results) return [note('Type to search the files in this folder. Files git ignores are left out.', 'muted')];
    if (!this.results.length) return [note(this.title ? `${this.title}: none found.` : 'No results.', 'muted')];
    const byFile = new Map<string, SearchMatch[]>();
    for (const m of this.results) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);
    const count = this.results.length;
    const summary = `${this.title ? `${this.title}: ` : ''}${count}${this.truncated ? '+' : ''} ${count === 1 ? 'result' : 'results'} in ${byFile.size} ${byFile.size === 1 ? 'file' : 'files'}${this.truncated ? ` (the first ${count})` : ''}`;
    const rows: SearchRow[] = [note(summary, 'muted')];
    const re = queryRegExp(this.query);
    for (const [path, matches] of byFile) {
      const open = !this.collapsed.has(path);
      const toggle = () => {
        if (this.collapsed.has(path)) this.collapsed.delete(path);
        else this.collapsed.add(path);
        this.host.changed();
      };
      const header = h(
        'div',
        { class: 'fp-row fp-flat fp-resultfile', title: path },
        h('span', { class: 'fp-chev', html: open ? icons.chevronDown : icons.chevronRight }),
        h('span', { class: 'fp-icon', html: icons.file }),
        h('span', { class: 'fp-name' }, nameOf(path)),
        h('span', { class: 'fp-dir' }, dirOf(path)),
        h('span', { class: 'rq-badge' }, String(matches.length)),
      );
      const fileRow: SearchRow = { path: `\0file:${path}`, dir: true, el: header, toggle };
      header.addEventListener('click', toggle);
      rows.push(fileRow);
      if (!open) continue;
      matches.forEach((m, i) => {
        const ranges = matchRanges(m.text, re);
        const row: SearchRow = { path: `\0match:${path}:${m.line}:${i}`, dir: false, el: matchRow(m, ranges), open: () => this.host.openMatch(m.path, m.line, ranges) };
        row.el.addEventListener('click', () => row.open!());
        rows.push(row);
      });
    }
    return rows;
  }
}

/** A matching line: its number and text, with the matches marked and a long line cut before the first. */
function matchRow(m: SearchMatch, ranges: Ranges): HTMLElement {
  const indent = m.text.length - m.text.trimStart().length;
  const from = ranges.length && ranges[0][0] - indent > SNIPPET_LEAD + 8 ? ranges[0][0] - SNIPPET_LEAD : indent;
  const parts: (Node | string)[] = from > indent ? ['…'] : [];
  let at = from;
  for (const [s, e] of ranges) {
    if (e <= at) continue;
    parts.push(m.text.slice(at, Math.max(at, s)), h('mark', { class: 'fp-hit' }, m.text.slice(Math.max(at, s), e)));
    at = e;
  }
  parts.push(m.text.slice(at));
  return h(
    'div',
    { class: 'fp-row fp-match', title: m.text.trim() },
    h('span', { class: 'fp-matchline' }, String(m.line)),
    h('span', { class: 'fp-matchtext' }, ...parts),
  );
}
