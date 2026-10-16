export type Child = Node | string | number | null | undefined | false;

type Handler = (e: any) => void;

export interface Props {
  class?: string;
  style?: string | Partial<Record<string, string>>;
  dataset?: Record<string, string>;
  /** Trusted, static markup only (icons). */
  html?: string;
  [key: string]: unknown;
}

/** Tiny hyperscript helper: h('div', { class: 'x', onclick: fn }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (value === false) {
        if (key in el && typeof (el as any)[key] === 'boolean') (el as any)[key] = false;
        continue;
      }
      if (key === 'class') el.className = String(value);
      else if (key === 'style') {
        if (typeof value === 'string') el.style.cssText = value;
        else Object.assign(el.style, value);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'html') el.innerHTML = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as Handler);
      } else if (key in el && typeof (el as any)[key] !== 'function' && !key.includes('-')) {
        try {
          (el as any)[key] = value;
        } catch {
          // Read-only reflection (e.g. input.list): fall back to the attribute.
          el.setAttribute(key, String(value));
        }
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** Like replaceChildren, but skips null/false entries. */
export function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** True when keyboard focus is in a text field (not the terminal). */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.classList.contains('xterm-helper-textarea')) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}
