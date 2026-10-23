/**
 * A scrolling list of fixed-height rows where only the rows on screen (and a few around them) are
 * in the document, so a file of 100 000 lines opens as fast as a short one. Used by the Files pane.
 */
import { h } from './dom';
import type { Ranges } from './diff';
import type { Token } from './syntax';

/** Rows drawn above and below the visible ones, so scrolling doesn't show gaps. */
const OVERSCAN = 20;
/** A line longer than this is cut when drawn (minified code). */
export const MAX_DRAWN = 20_000;

export class LineView {
  readonly el: HTMLDivElement;
  private readonly inner: HTMLDivElement;
  private count = 0;
  private render: (index: number) => HTMLElement = () => h('div');
  private drawn: [number, number] = [-1, -1];
  private frame = 0;
  /** Called after rows were drawn (find highlights). */
  onDraw: (() => void) | null = null;
  /** Called when the view scrolled (to keep another view in step). */
  onScroll: ((top: number) => void) | null = null;

  constructor(cls: string) {
    this.inner = h('div', { class: 'lv-inner' });
    this.el = h('div', { class: `lv ${cls}` }, this.inner);
    this.el.addEventListener('scroll', () => {
      this.onScroll?.(this.el.scrollTop);
      if (!this.frame) this.frame = requestAnimationFrame(() => ((this.frame = 0), this.draw(false)));
    });
  }

  /** The height of one row, from the CSS (it follows the font size). */
  get rowHeight(): number {
    return parseFloat(getComputedStyle(this.el).getPropertyValue('--lv-row')) || 19;
  }

  /** Shows `count` rows, the widest `widthCh` characters wide; `render` draws one row. */
  set(count: number, widthCh: number, render: (index: number) => HTMLElement): void {
    this.count = count;
    this.render = render;
    this.inner.style.width = `calc(${Math.min(widthCh, MAX_DRAWN) + 2}ch + var(--lv-gutter, 0px))`;
    this.draw(true);
  }

  /** Draws the rows on screen again (after a resize, or when what they show changed). */
  draw(force = true): void {
    const row = this.rowHeight;
    // Set here: the row height is only known once the view is in the document.
    this.inner.style.height = `${this.count * row}px`;
    const top = this.el.scrollTop;
    const first = Math.max(0, Math.floor(top / row) - OVERSCAN);
    const last = Math.min(this.count, Math.ceil((top + this.el.clientHeight) / row) + OVERSCAN);
    if (!force && first === this.drawn[0] && last === this.drawn[1]) return;
    this.drawn = [first, last];
    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      const el = this.render(i);
      el.style.top = `${i * row}px`;
      el.dataset.row = String(i);
      rows.push(el);
    }
    this.inner.replaceChildren(...rows);
    this.onDraw?.();
  }

  /** The first row that is fully or partly visible. */
  topRow(): number {
    return Math.floor(this.el.scrollTop / this.rowHeight);
  }

  get scrollTop(): number {
    return this.el.scrollTop;
  }

  set scrollTop(top: number) {
    this.el.scrollTop = top;
  }

  /** Scrolls row `index` into view: to about a third from the top, or only as far as needed. */
  reveal(index: number, how: 'third' | 'nearest' = 'third'): void {
    const row = this.rowHeight;
    const top = index * row;
    const height = this.el.clientHeight;
    if (how === 'nearest') {
      if (top < this.el.scrollTop) this.el.scrollTop = top;
      else if (top + row > this.el.scrollTop + height) this.el.scrollTop = top + row - height;
    } else {
      this.el.scrollTop = Math.max(0, top - Math.floor(height / 3));
    }
    this.draw(false);
  }

  /** The rows drawn now, for find highlights. */
  rows(): HTMLElement[] {
    return Array.from(this.inner.children) as HTMLElement[];
  }
}

/** Widest line, in characters (a tab counts as 4). */
export function widestLine(lines: readonly string[]): number {
  let max = 0;
  for (const l of lines) {
    if (l.length <= max / 4) continue;
    let w = l.length;
    for (let i = l.indexOf('\t'); i >= 0; i = l.indexOf('\t', i + 1)) w += 3;
    if (w > max) max = w;
  }
  return max;
}

/** A line's coloured text, with the `changed` character ranges marked (words changed in a diff). */
export function codeNodes(tokens: Token[], changed: Ranges | null): Node[] {
  const out: Node[] = [];
  let pos = 0;
  let r = 0;
  for (const t of tokens) {
    if (pos >= MAX_DRAWN) {
      out.push(h('span', { class: 'lv-cut' }, ' …'));
      break;
    }
    const text = t.text.length + pos > MAX_DRAWN ? t.text.slice(0, MAX_DRAWN - pos) : t.text;
    const end = pos + text.length;
    const cls = t.kind ? `sy-${t.kind}` : '';
    // Split the token where changed ranges start or end inside it.
    let at = pos;
    while (at < end) {
      while (changed && r < changed.length && changed[r][1] <= at) r++;
      const range = changed?.[r];
      const inRange = !!range && range[0] <= at;
      const stop = Math.min(end, range ? (inRange ? range[1] : range[0]) : end);
      const piece = text.slice(at - pos, stop - pos);
      const c = [cls, inRange ? 'wd' : ''].filter(Boolean).join(' ');
      out.push(c ? h('span', { class: c }, piece) : document.createTextNode(piece));
      at = stop;
    }
    pos = end;
  }
  return out;
}
