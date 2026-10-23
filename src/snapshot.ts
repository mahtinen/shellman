/**
 * Saved form of the open tabs and splits (workspace.json), so they can be reopened
 * after a restart. Pure functions; the workspace does the opening.
 */
import { isUuid } from './claude';
import { hexColor } from './config';
import { normalizeConnection } from './connection';
import type { Direction, LayoutNode } from './layout';
import type { LaunchSpec } from './types';

/** A request pane: the request file, relative to the folder of the group it is in. */
export interface RequestRef {
  groupId: string;
  path: string;
}

/** A Files pane: the folder, the file it shows and how. */
export interface FilesRef {
  root: string;
  /** Relative to the root, with `/` ('' = none). */
  path: string;
  view: 'all' | 'changes' | 'search';
  mode: 'file' | 'diff';
  /**
   * What the changes are compared with, for git: `HEAD` (what isn't committed), `merge-base:<branch>`
   * (everything on this branch) or `<commit>^` (from that commit on).
   */
  base: string;
  /** How the base is shown ('' for HEAD). */
  baseLabel: string;
}

/** One saved pane: a terminal, a request or a Files pane. */
export type SnapshotLeaf = { pane: LaunchSpec } | { request: RequestRef } | { files: FilesRef };

export type SnapshotNode = SnapshotLeaf | { split: Direction; sizes: number[]; children: SnapshotNode[] };

const isLeaf = (n: SnapshotNode): n is SnapshotLeaf => 'pane' in n || 'request' in n || 'files' in n;

export interface TabSnapshot {
  /** Name the user gave the tab, if any. */
  title: string | null;
  /** Index (in layout order) of the pane that had focus. */
  activePane: number;
  root: SnapshotNode;
}

export interface WorkspaceSnapshot {
  version: 1;
  activeTab: number;
  tabs: TabSnapshot[];
}

const MAX_TABS = 50;
const MAX_DEPTH = 12;

/** Converts a tab's layout; `leaf` gives each pane's saved form (null: not reopened). */
export function snapshotNode(node: LayoutNode, leaf: (paneId: string) => SnapshotLeaf | null): SnapshotNode | null {
  if (node.type === 'pane') return leaf(node.paneId);
  const kids = node.children.map((c) => snapshotNode(c, leaf));
  const children: SnapshotNode[] = [];
  const sizes: number[] = [];
  kids.forEach((k, i) => {
    if (k) {
      children.push(k);
      sizes.push(node.sizes[i] ?? 1);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return { split: node.direction, sizes: normalizeSizes(sizes, children.length), children };
}

/**
 * Builds a layout tree, creating a pane for every saved one. A pane that can't be created (its
 * request file is gone) is left out, and a split left with one pane collapses.
 */
export function layoutFromSnapshot(node: SnapshotNode, createPane: (leaf: SnapshotLeaf) => string | null): LayoutNode | null {
  if (isLeaf(node)) {
    const id = createPane(node);
    return id ? { type: 'pane', paneId: id } : null;
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const child = layoutFromSnapshot(c, createPane);
    if (child) {
      children.push(child);
      sizes.push(node.sizes[i] ?? 1);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return { type: 'split', direction: node.split, sizes: normalizeSizes(sizes, children.length), children };
}

/** Every saved pane, in layout order. */
export function snapshotLeaves(node: SnapshotNode): SnapshotLeaf[] {
  return isLeaf(node) ? [node] : node.children.flatMap(snapshotLeaves);
}

/** The terminals' launch specs, in layout order. */
export function snapshotPanes(node: SnapshotNode): LaunchSpec[] {
  return snapshotLeaves(node).flatMap((l) => ('pane' in l ? [l.pane] : []));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown, max: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max ? v : 0);

function normalizeSizes(sizes: number[], n: number): number[] {
  const s = Array.from({ length: n }, (_, i) => (typeof sizes[i] === 'number' && Number.isFinite(sizes[i]) && sizes[i] > 0 ? sizes[i] : 1));
  const total = s.reduce((a, b) => a + b, 0);
  return s.map((x) => x / total);
}

function normalizeSpec(v: unknown): LaunchSpec | null {
  if (!isObj(v) || !str(v.cwd)) return null;
  const env: Record<string, string> = {};
  if (isObj(v.env)) for (const [k, val] of Object.entries(v.env)) if (k && typeof val === 'string') env[k] = val;
  const spec: LaunchSpec = {
    name: str(v.name) || 'Terminal',
    cwd: str(v.cwd),
    command: str(v.command),
    shellId: str(v.shellId),
    env,
    color: hexColor(v.color),
    sessionId: str(v.sessionId) || null,
  };
  const connection = normalizeConnection(v.connection);
  if (connection) spec.connection = connection;
  if (isUuid(v.claudeId)) {
    spec.claudeId = v.claudeId;
    spec.claudeStarted = v.claudeStarted === true;
  }
  return spec;
}

function normalizeNode(v: unknown, depth: number): SnapshotNode | null {
  if (!isObj(v) || depth > MAX_DEPTH) return null;
  if ('pane' in v) {
    const spec = normalizeSpec(v.pane);
    return spec ? { pane: spec } : null;
  }
  if ('request' in v) {
    const r = isObj(v.request) ? v.request : {};
    return str(r.groupId) && str(r.path) ? { request: { groupId: str(r.groupId), path: str(r.path) } } : null;
  }
  if ('files' in v) {
    const f = isObj(v.files) ? v.files : {};
    if (!str(f.root)) return null;
    return { files: { root: str(f.root), path: str(f.path), view: f.view === 'changes' || f.view === 'search' ? f.view : 'all', mode: f.mode === 'diff' ? 'diff' : 'file', base: str(f.base) || 'HEAD', baseLabel: str(f.base) ? str(f.baseLabel) : '' } };
  }
  if ((v.split !== 'row' && v.split !== 'column') || !Array.isArray(v.children)) return null;
  const rawSizes = Array.isArray(v.sizes) ? v.sizes : [];
  const children: SnapshotNode[] = [];
  const sizes: number[] = [];
  v.children.forEach((c, i) => {
    const n = normalizeNode(c, depth + 1);
    if (n) {
      children.push(n);
      sizes.push(rawSizes[i] as number);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return { split: v.split, sizes: normalizeSizes(sizes, children.length), children };
}

/** Turns whatever was on disk into a valid snapshot, or null if nothing can be reopened. */
export function normalizeSnapshot(raw: unknown): WorkspaceSnapshot | null {
  if (!isObj(raw) || !Array.isArray(raw.tabs)) return null;
  const tabs: TabSnapshot[] = [];
  for (const t of raw.tabs.slice(0, MAX_TABS)) {
    if (!isObj(t)) continue;
    const root = normalizeNode(t.root, 0);
    if (!root) continue;
    const title = str(t.title).trim();
    tabs.push({ title: title || null, activePane: int(t.activePane, snapshotLeaves(root).length), root });
  }
  if (!tabs.length) return null;
  return { version: 1, activeTab: int(raw.activeTab, tabs.length), tabs };
}
