/**
 * Application shortcuts. Matching uses `KeyboardEvent.code` (the physical
 * key) so shortcuts work the same on every keyboard layout, and modifiers
 * must match exactly. Nothing here uses Ctrl+Alt because that is AltGr on
 * most European layouts (AltGr+2 = @, AltGr+7 = { ...).
 */

export type Action =
  | 'newTab'
  | 'splitRight'
  | 'splitDown'
  | 'duplicate'
  | 'closePane'
  | 'zoomPane'
  | 'equalize'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'nextTab'
  | 'prevTab'
  | 'goToTab'
  | 'find'
  | 'palette'
  | 'toggleSidebar'
  | 'settings'
  | 'saveSession'
  | 'renameTab'
  | 'copy'
  | 'paste'
  | 'fontUp'
  | 'fontDown'
  | 'fontReset';

export interface Binding {
  action: Action;
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** For goToTab: zero-based tab index. */
  arg?: number;
}

export interface Match {
  action: Action;
  arg?: number;
}

export const BINDINGS: Binding[] = [
  { action: 'newTab', code: 'KeyT', ctrl: true, shift: true },
  { action: 'splitRight', code: 'KeyE', ctrl: true, shift: true },
  { action: 'splitDown', code: 'KeyO', ctrl: true, shift: true },
  { action: 'duplicate', code: 'KeyD', ctrl: true, shift: true },
  { action: 'closePane', code: 'KeyW', ctrl: true, shift: true },
  { action: 'zoomPane', code: 'KeyZ', ctrl: true, shift: true },
  { action: 'equalize', code: 'KeyQ', ctrl: true, shift: true },
  { action: 'focusLeft', code: 'ArrowLeft', alt: true },
  { action: 'focusRight', code: 'ArrowRight', alt: true },
  { action: 'focusUp', code: 'ArrowUp', alt: true },
  { action: 'focusDown', code: 'ArrowDown', alt: true },
  { action: 'nextTab', code: 'Tab', ctrl: true },
  { action: 'prevTab', code: 'Tab', ctrl: true, shift: true },
  { action: 'nextTab', code: 'PageDown', ctrl: true },
  { action: 'prevTab', code: 'PageUp', ctrl: true },
  ...Array.from({ length: 9 }, (_, i): Binding => ({ action: 'goToTab', code: `Digit${i + 1}`, alt: true, arg: i })),
  { action: 'find', code: 'KeyF', ctrl: true, shift: true },
  { action: 'palette', code: 'KeyP', ctrl: true, shift: true },
  { action: 'toggleSidebar', code: 'KeyB', ctrl: true, shift: true },
  { action: 'settings', code: 'Comma', ctrl: true },
  { action: 'saveSession', code: 'KeyS', ctrl: true, shift: true },
  { action: 'renameTab', code: 'KeyR', ctrl: true, shift: true },
  { action: 'copy', code: 'KeyC', ctrl: true, shift: true },
  { action: 'copy', code: 'Insert', ctrl: true },
  { action: 'paste', code: 'KeyV', ctrl: true, shift: true },
  { action: 'paste', code: 'Insert', shift: true },
  { action: 'fontUp', code: 'NumpadAdd', ctrl: true },
  { action: 'fontDown', code: 'NumpadSubtract', ctrl: true },
  { action: 'fontReset', code: 'Numpad0', ctrl: true },
];

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function matchKey(e: KeyLike, bindings: Binding[] = BINDINGS): Match | null {
  if (e.metaKey) return null;
  for (const b of bindings) {
    if (
      b.code === e.code &&
      !!b.ctrl === e.ctrlKey &&
      !!b.shift === e.shiftKey &&
      !!b.alt === e.altKey
    ) {
      return b.arg === undefined ? { action: b.action } : { action: b.action, arg: b.arg };
    }
  }
  return null;
}

const CODE_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Comma: ',',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  Numpad0: 'Num 0',
  PageDown: 'PgDn',
  PageUp: 'PgUp',
};

export function bindingLabel(b: Binding): string {
  const key = CODE_LABELS[b.code] ?? b.code.replace(/^Key/, '').replace(/^Digit/, '');
  return [b.ctrl && 'Ctrl', b.shift && 'Shift', b.alt && 'Alt', key].filter(Boolean).join('+');
}

export function shortcutFor(action: Action): string {
  const b = BINDINGS.find((x) => x.action === action);
  return b ? bindingLabel(b) : '';
}

export const ACTION_LABELS: Record<Action, string> = {
  newTab: 'New tab in the current directory',
  splitRight: 'Split right (same directory)',
  splitDown: 'Split down (same directory)',
  duplicate: 'Duplicate pane (re-runs its command)',
  closePane: 'Close pane',
  zoomPane: 'Maximize / restore pane',
  equalize: 'Make all panes equal size',
  focusLeft: 'Focus pane to the left',
  focusRight: 'Focus pane to the right',
  focusUp: 'Focus pane above',
  focusDown: 'Focus pane below',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  goToTab: 'Go to tab 1–9',
  find: 'Find in terminal',
  palette: 'Quick open saved session',
  toggleSidebar: 'Show / hide sidebar',
  settings: 'Settings',
  saveSession: 'Save pane as session',
  renameTab: 'Rename tab',
  copy: 'Copy',
  paste: 'Paste',
  fontUp: 'Increase font size',
  fontDown: 'Decrease font size',
  fontReset: 'Reset font size',
};
