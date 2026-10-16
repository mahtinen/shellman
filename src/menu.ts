import { clamp, h } from './dom';
import { icons, type IconName } from './icons';

export interface MenuAction {
  label: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  action?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuAction | 'separator';

let current: { close: () => void } | null = null;

export function closeMenu(): void {
  current?.close();
}

/** Shows a context menu at viewport coordinates. Keyboard: ↑ ↓ Enter → ← Esc. */
export function showMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeMenu();
  const layers: HTMLElement[] = [];
  const restoreFocus = document.activeElement as HTMLElement | null;

  const close = () => {
    layers.forEach((l) => l.remove());
    layers.length = 0;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    if (current?.close === close) current = null;
    restoreFocus?.focus?.();
  };

  const build = (items: MenuEntry[], px: number, py: number, depth: number): HTMLElement => {
    const menu = h('div', { class: 'menu', role: 'menu', tabindex: '-1' });
    for (const item of items) {
      if (item === 'separator') {
        menu.append(h('div', { class: 'menu-sep' }));
        continue;
      }
      const row = h(
        'div',
        {
          class: `menu-item${item.disabled ? ' disabled' : ''}${item.danger ? ' danger' : ''}`,
          role: 'menuitem',
          tabindex: '-1',
        },
        h('span', { class: 'menu-icon', html: item.icon ? icons[item.icon] : '' }),
        h('span', { class: 'menu-label' }, item.label),
        item.submenu
          ? h('span', { class: 'menu-sub', html: icons.chevronRight })
          : h('span', { class: 'menu-shortcut' }, item.shortcut ?? ''),
      );
      const openSub = () => {
        while (layers.length > depth + 1) layers.pop()!.remove();
        if (!item.submenu || item.disabled) return;
        const r = row.getBoundingClientRect();
        const sub = build(item.submenu, r.right - 2, r.top - 4, depth + 1);
        (sub.querySelector('.menu-item:not(.disabled)') as HTMLElement | null)?.focus();
      };
      row.addEventListener('pointerenter', () => {
        row.focus();
        if (item.submenu) openSub();
        else while (layers.length > depth + 1) layers.pop()!.remove();
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.disabled) return;
        if (item.submenu) return openSub();
        close();
        item.action?.();
      });
      (row as any)._openSub = openSub;
      menu.append(row);
    }
    document.body.append(menu);
    layers.push(menu);
    const r = menu.getBoundingClientRect();
    let left = px;
    if (left + r.width > innerWidth - 4) left = depth > 0 ? px - r.width - (layers[depth - 1]?.offsetWidth ?? 0) + 4 : innerWidth - r.width - 4;
    menu.style.left = `${clamp(left, 4, Math.max(4, innerWidth - r.width - 4))}px`;
    menu.style.top = `${clamp(py, 4, Math.max(4, innerHeight - r.height - 4))}px`;
    return menu;
  };

  const onOutside = (e: PointerEvent) => {
    if (!layers.some((l) => l.contains(e.target as Node))) close();
  };

  const onKey = (e: KeyboardEvent) => {
    const layer = layers.find((l) => l.contains(document.activeElement)) ?? layers[layers.length - 1];
    if (!layer) return;
    const rows = Array.from(layer.querySelectorAll<HTMLElement>('.menu-item:not(.disabled)'));
    const idx = rows.indexOf(document.activeElement as HTMLElement);
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case 'Escape':
        stop();
        if (layers.length > 1) {
          layers.pop()!.remove();
          (layers[layers.length - 1].querySelector('.menu-item:focus, .menu-item') as HTMLElement | null)?.focus();
        } else close();
        break;
      case 'ArrowDown':
        stop();
        rows[(idx + 1) % rows.length]?.focus();
        break;
      case 'ArrowUp':
        stop();
        rows[(idx - 1 + rows.length) % rows.length]?.focus();
        break;
      case 'ArrowRight':
        stop();
        (document.activeElement as any)?._openSub?.();
        break;
      case 'ArrowLeft':
        stop();
        if (layers.length > 1) layers.pop()!.remove();
        break;
      case 'Enter':
      case ' ':
        stop();
        (document.activeElement as HTMLElement | null)?.click();
        break;
      default:
        stop();
    }
  };

  const root = build(entries, x, y, 0);
  root.focus();
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
  });
  document.addEventListener('keydown', onKey, true);
  current = { close };
}

/** Opens a menu below an element (for dropdown buttons). */
export function showMenuBelow(anchor: HTMLElement, entries: MenuEntry[]): void {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, entries);
}
