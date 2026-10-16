import { h } from './dom';
import { fuzzyBest } from './fuzzy';
import { icons, type IconName } from './icons';
import type { SplitPlacement } from './types';

export interface PaletteItem {
  label: string;
  detail?: string;
  icon?: IconName;
  color?: string;
  keywords?: string[];
  run: (placement: SplitPlacement) => void;
}

let open: (() => void) | null = null;

/**
 * Quick launcher. Enter opens in a new tab, Ctrl+Enter splits right,
 * Shift+Enter splits down.
 */
export function showPalette(items: PaletteItem[], placeholder = 'Open a saved session…'): void {
  if (open) return open();
  const restoreFocus = document.activeElement as HTMLElement | null;
  const input = h('input', { class: 'palette-input', placeholder, spellcheck: false });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const box = h(
    'div',
    { class: 'palette' },
    h('div', { class: 'palette-search' }, h('span', { html: icons.search }), input),
    list,
    h(
      'div',
      { class: 'palette-hint' },
      h('span', null, h('kbd', null, 'Enter'), ' new tab'),
      h('span', null, h('kbd', null, 'Ctrl+Enter'), ' split right'),
      h('span', null, h('kbd', null, 'Shift+Enter'), ' split down'),
      h('span', null, h('kbd', null, 'Esc'), ' close'),
    ),
  );
  const overlay = h('div', { class: 'overlay palette-overlay' }, box);

  let filtered: PaletteItem[] = [];
  let selected = 0;

  const close = () => {
    overlay.remove();
    open = null;
    restoreFocus?.focus?.();
  };

  const run = (item: PaletteItem | undefined, placement: SplitPlacement) => {
    if (!item) return;
    close();
    item.run(placement);
  };

  const render = () => {
    const q = input.value;
    filtered = items
      .map((item, i) => ({ item, i, score: fuzzyBest(q, [item.label, item.detail ?? '', ...(item.keywords ?? [])]) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => (q ? b.score! - a.score! : 0) || a.i - b.i)
      .map((x) => x.item);
    selected = Math.min(selected, Math.max(0, filtered.length - 1));
    list.replaceChildren(
      ...filtered.map((item, i) =>
        h(
          'div',
          {
            class: `palette-item${i === selected ? ' selected' : ''}`,
            role: 'option',
            style: item.color ? `--session-color:${item.color}` : undefined,
            onclick: (e: MouseEvent) => run(item, e.ctrlKey ? 'right' : e.shiftKey ? 'down' : 'tab'),
            onmousemove: () => {
              if (selected !== i) {
                selected = i;
                list.querySelectorAll('.palette-item').forEach((el, j) => el.classList.toggle('selected', j === i));
              }
            },
          },
          h('span', { class: 'palette-icon', html: icons[item.icon ?? 'terminal'] }),
          h('span', { class: 'palette-label' }, item.label),
          item.detail ? h('span', { class: 'palette-detail' }, item.detail) : null,
        ),
      ),
    );
    if (!filtered.length) list.append(h('div', { class: 'palette-empty' }, 'No matches'));
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    selected = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = (selected + 1) % Math.max(1, filtered.length);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = (selected - 1 + filtered.length) % Math.max(1, filtered.length);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(filtered[selected], e.ctrlKey ? 'right' : e.shiftKey ? 'down' : 'tab');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });

  document.body.append(overlay);
  open = () => input.focus();
  render();
  input.focus();
}
