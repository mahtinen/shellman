/**
 * What the workspace needs from a pane, whatever it shows. Tabs, splits, focus, maximize, moving
 * between tabs and saving for the next start work the same for every kind; what only terminals
 * do (shells, connections, GPU rendering) is reached through `isTerminal`.
 */
import { h } from './dom';
import { icons } from './icons';
import type { Match } from './keys';
import type { Pane } from './pane';
import type { SnapshotLeaf } from './snapshot';
import type { Settings } from './types';

export type HeaderAction = 'zoom' | 'tab' | 'close';

export interface WorkspacePane {
  readonly id: string;
  readonly kind: 'terminal' | 'request';
  /** The `.pane` element, with `data-pane` set to the id (drag and drop finds panes by it). */
  readonly el: HTMLElement;
  /** Shown in its header, and in dialogs about it. */
  readonly name: string;
  /** What the program set as its title ('' = none). */
  readonly title: string;
  /** Where it is (a directory or connection), for tooltips. */
  readonly location: string;
  /** Its own colour when it doesn't belong to a saved session. */
  readonly color: string;
  readonly progress: { state: number; value: number } | null;
  /** When it last showed new output (performance.now()); a background tab with output shows it. */
  readonly lastOutput: number;
  /** Not running (ended, failed or not started): a tab whose panes all are is shown dimmed. */
  readonly ended: boolean;
  readonly hasGpu: boolean;
  /** Called once its element is in the document. */
  mount(): void;
  start(): Promise<void>;
  setActive(active: boolean): void;
  setZoomed(zoomed: boolean): void;
  queueFit(): void;
  focus(): void;
  enableGpu(): void;
  disableGpu(): void;
  applySettings(s: Settings): void;
  /** True while closing it would end something (a running program, an open connection). */
  hasRunningProgram(): Promise<boolean>;
  /** It has changes that aren't saved; closing asks to save them. */
  readonly dirty: boolean;
  /** Saves the changes; false when that failed or was cancelled. */
  save?(): Promise<boolean>;
  openSearch(): void;
  /** How it is saved for the next start; null when it isn't reopened. */
  snapshot(): SnapshotLeaf | null;
  dispose(): void;
}

/** What every pane reports to the workspace. */
export interface PaneEvents {
  settings(): Settings;
  onFocus(pane: WorkspacePane): void;
  /** Its name, title, state or progress changed. */
  onInfoChange(pane: WorkspacePane): void;
  /** An app shortcut was pressed inside the pane; return true if handled. */
  onShortcut(pane: WorkspacePane, match: Match): boolean;
  onContextMenu(pane: WorkspacePane, e: MouseEvent): void;
  onHeaderAction(pane: WorkspacePane, action: HeaderAction): void;
}

export const isTerminal = (p: WorkspacePane | null | undefined): p is Pane => p?.kind === 'terminal';

/** The header a pane shows while its tab is split: name, title and the pane buttons. */
export function paneHeader(onAction: (action: HeaderAction) => void) {
  const dot = h('span', { class: 'pane-dot' });
  const name = h('span', { class: 'pane-name' });
  const title = h('span', { class: 'pane-title' });
  const zoomBtn = h('button', { class: 'icon-btn small', onclick: () => onAction('zoom') });
  const el = h(
    'div',
    { class: 'pane-header', ondblclick: () => onAction('zoom') },
    dot,
    name,
    title,
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn small', title: 'Move to new tab (Ctrl+Shift+M)', html: icons.popOut, onclick: () => onAction('tab') }),
    zoomBtn,
    h('button', { class: 'icon-btn small', title: 'Close pane (Ctrl+Shift+W)', html: icons.x, onclick: () => onAction('close') }),
  );
  /** While maximized the other panes are hidden; the button says how to get them back. */
  const setZoomed = (zoomed: boolean) => {
    zoomBtn.innerHTML = zoomed ? icons.restore : icons.maximize;
    zoomBtn.title = zoomed ? 'Restore split (Ctrl+Shift+Z or Alt+arrows)' : 'Maximize (Ctrl+Shift+Z)';
  };
  setZoomed(false);
  return { el, dot, name, title, setZoomed };
}
