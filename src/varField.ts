/**
 * `{{variables}}` look and work the same in every request field (URL, headers, params, auth, body):
 * coloured by whether they are defined, their value on hover, Ctrl+click to edit them. A field's
 * text is made transparent over a coloured copy (as the body editor does) only while it has
 * variables, so other fields stay exactly the browser's.
 */
import { h } from './dom';
import { store } from './store';
import { describeVariable, splitVariables, usedVariables, type Variable } from './variables';

export interface VarContext {
  /** The variables in effect now (they change with the environment and the files). */
  vars(): Map<string, Variable>;
  /** Opens the variables editor at `name`; `missing`: adds it. */
  edit(name: string, missing: boolean): void;
}

/** How each field repaints, for when the variables change. */
const painters = new WeakMap<Element, () => void>();

export function onRepaint(el: Element, paint: () => void): void {
  el.classList.add('vf-paints');
  painters.set(el, paint);
}

/** Repaints the fields in `root` (the variables, environment or field text changed). */
export function repaintVarFields(root: Element): void {
  for (const el of [root, ...root.querySelectorAll('.vf-paints')]) painters.get(el)?.();
}

/**
 * A `{{variable}}` as written, coloured. `name` is undefined for something in braces that isn't
 * a valid name (the JSON body colours those too).
 */
export function varSpan(text: string, vars: Map<string, Variable>, name = usedVariables(text)[0]): HTMLElement {
  if (!name) return h('span', { class: 'seg-missing', title: `${text} isn't a valid variable name.` }, text);
  const d = describeVariable(name, vars, store.settings.hideSecrets);
  return h('span', { class: `seg-${d.kind}`, dataset: { var: name, tip: d.title } }, text);
}

/** The field under the mouse: Ctrl pressed or let go there turns its variable into a link or back. */
let hovered: ((ctrl: boolean) => void) | null = null;
window.addEventListener('keydown', (e) => e.key === 'Control' && hovered?.(true));
window.addEventListener('keyup', (e) => e.key === 'Control' && hovered?.(false));
window.addEventListener('blur', () => hovered?.(false));

/**
 * Hover over a variable shows its value; with Ctrl held it is a link that edits it. The coloured
 * copy lies over the field without taking the pointer, so the field's own events are used and
 * matched to its spans.
 */
export function varPointer(field: HTMLElement, view: HTMLElement, ctx: VarContext): void {
  const title = field.title;
  let mouse: { x: number; y: number } | null = null;
  const at = (x: number, y: number) =>
    [...view.querySelectorAll<HTMLElement>('[data-var]')].find((s) => [...s.getClientRects()].some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom));
  const update = (ctrl: boolean) => {
    const s = mouse ? at(mouse.x, mouse.y) : undefined;
    field.title = s?.dataset.tip ?? title;
    const link = !!s && ctrl;
    field.classList.toggle('vf-link', link);
    for (const o of view.querySelectorAll('.vf-hot')) if (o !== s || !link) o.classList.remove('vf-hot');
    if (link) s.classList.add('vf-hot');
  };
  field.addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    hovered = update;
    update(e.ctrlKey);
  });
  field.addEventListener('mouseleave', () => {
    mouse = null;
    if (hovered === update) hovered = null;
    update(false);
  });
  field.addEventListener('mousedown', (e) => {
    if (!e.ctrlKey || e.button !== 0) return;
    const s = at(e.clientX, e.clientY);
    if (!s) return;
    e.preventDefault();
    ctx.edit(s.dataset.var!, s.classList.contains('seg-missing'));
  });
}

/** `input` wrapped so that its variables show as in the body. Setting its value in code needs a repaint. */
export function varField(input: HTMLInputElement, ctx: VarContext): HTMLDivElement {
  const view = h('div', { class: 'vf-view', 'aria-hidden': 'true' });
  const el = h('div', { class: 'vf' }, input, view);
  const sync = () => (view.scrollLeft = input.scrollLeft);
  const paint = () => {
    const text = input.value;
    const has = text.includes('{{');
    el.classList.toggle('has-vars', has);
    if (has) {
      const vars = ctx.vars();
      view.replaceChildren(...splitVariables(text).map((p) => (p.name ? varSpan(p.text, vars, p.name) : p.text)));
    } else view.replaceChildren();
    sync();
  };
  input.addEventListener('input', paint);
  input.addEventListener('scroll', sync);
  // The text scrolls with the caret (and back to its start on blur) without always saying so.
  for (const ev of ['keydown', 'keyup', 'mouseup', 'mousemove', 'select', 'focus', 'blur']) input.addEventListener(ev, () => requestAnimationFrame(sync));
  varPointer(input, view, ctx);
  onRepaint(el, paint);
  paint();
  return el;
}
