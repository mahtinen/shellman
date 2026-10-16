import { h, type Child } from './dom';
import { icons } from './icons';

export interface DialogButton {
  label: string;
  kind?: 'primary' | 'danger' | 'default';
  /** Return false to keep the dialog open (e.g. validation failed). */
  onClick?: () => boolean | void | Promise<boolean | void>;
}

export interface DialogOptions {
  title: string;
  body: Child | Child[];
  buttons: DialogButton[];
  width?: number;
  onClose?: () => void;
  /** Element to focus on open (defaults to the first input). */
  focus?: HTMLElement;
  className?: string;
}

const openDialogs: { close: () => void }[] = [];

export function isDialogOpen(): boolean {
  return openDialogs.length > 0;
}

export function dialog(opts: DialogOptions): { close: () => void; el: HTMLElement } {
  const restoreFocus = document.activeElement as HTMLElement | null;
  const footer = h('div', { class: 'dialog-footer' });
  const box = h(
    'div',
    {
      class: `dialog ${opts.className ?? ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      style: opts.width ? `width:min(${opts.width}px, calc(100vw - 32px))` : undefined,
    },
    h(
      'div',
      { class: 'dialog-header' },
      h('h2', null, opts.title),
      h('button', { class: 'icon-btn', title: 'Close', html: icons.x, onclick: () => close() }),
    ),
    h('div', { class: 'dialog-body' }, ...(Array.isArray(opts.body) ? opts.body : [opts.body])),
    footer,
  );
  const overlay = h('div', { class: 'overlay' }, box);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    const i = openDialogs.indexOf(handle);
    if (i >= 0) openDialogs.splice(i, 1);
    opts.onClose?.();
    restoreFocus?.focus?.();
  };
  const handle = { close };

  let primary: HTMLButtonElement | null = null;
  for (const b of opts.buttons) {
    const btn = h('button', { class: `btn ${b.kind ?? 'default'}` }, b.label);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const keep = (await b.onClick?.()) === false;
        if (!keep) close();
      } finally {
        btn.disabled = false;
      }
    });
    if (b.kind === 'primary' || b.kind === 'danger') primary ??= btn;
    footer.append(btn);
  }

  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && primary) {
      e.preventDefault();
      primary.click();
    }
  });

  document.body.append(overlay);
  openDialogs.push(handle);
  const focusEl = opts.focus ?? box.querySelector<HTMLElement>('input, select, textarea') ?? primary;
  requestAnimationFrame(() => {
    focusEl?.focus();
    if (focusEl instanceof HTMLInputElement) focusEl.select();
  });
  return { close, el: box };
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    dialog({
      title,
      width: 420,
      body: h('p', { class: 'dialog-text' }, message),
      buttons: [
        { label: 'Cancel' },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => void (result = true) },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(title: string, label: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', { class: 'input', value: initial, spellcheck: false });
    dialog({
      title,
      width: 420,
      body: h('label', { class: 'field' }, h('span', null, label), input),
      buttons: [{ label: 'Cancel' }, { label: 'OK', kind: 'primary', onClick: () => void (result = input.value) }],
      onClose: () => resolve(result),
      focus: input,
    });
  });
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4000, onClick?: () => void): void {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const t = h('div', { class: `toast ${kind}${onClick ? ' clickable' : ''}` }, message);
  const remove = () => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 200);
  };
  t.addEventListener('click', () => {
    onClick?.();
    remove();
  });
  toastHost.append(t);
  setTimeout(remove, ms);
}
