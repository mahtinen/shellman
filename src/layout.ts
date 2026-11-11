/**
 * Pure split-layout tree for a tab.
 *
 * `row` lays children out side by side (a "split right"), `column` stacks
 * them (a "split down"). `sizes` are fractions of the parent that sum to 1.
 */

export type Direction = 'row' | 'column';
export type FocusDirection = 'left' | 'right' | 'up' | 'down';

/** A cell of a split: one pane, or several stacked as tabs with one of them shown. */
export interface PaneNode {
  type: 'pane';
  /** The pane shown. */
  paneId: string;
  /** Every pane of the cell in tab order, the shown one included. */
  stack: string[];
}

export interface SplitNode {
  type: 'split';
  direction: Direction;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const leaf = (paneId: string): PaneNode => ({ type: 'pane', paneId, stack: [paneId] });

/** Every pane, the stacked ones too, in layout order. */
export function paneIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? node.stack : node.children.flatMap(paneIds);
}

/** The pane shown in each cell, in layout order. */
export function shownIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.paneId] : node.children.flatMap(shownIds);
}

export function contains(node: LayoutNode, paneId: string): boolean {
  return paneIds(node).includes(paneId);
}

/** The cell a pane is in. */
export function cellOf(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.type === 'pane') return node.stack.includes(paneId) ? node : null;
  for (const c of node.children) {
    const found = cellOf(c, paneId);
    if (found) return found;
  }
  return null;
}

/** Applies `f` to the cell holding `paneId`. */
function mapCell(node: LayoutNode, paneId: string, f: (cell: PaneNode) => PaneNode): LayoutNode {
  if (node.type === 'pane') return node.stack.includes(paneId) ? f(node) : node;
  return { ...node, children: node.children.map((c) => mapCell(c, paneId, f)) };
}

/** Shows `paneId` in its cell (picks its tab). */
export function showPane(root: LayoutNode, paneId: string): LayoutNode {
  return mapCell(root, paneId, (cell) => ({ ...cell, paneId }));
}

/**
 * Adds panes as tabs to the cell of `targetId`, right after it (or before), and shows the first.
 * Panes already in that cell move to the new place, which reorders the tabs.
 */
export function addToStack(root: LayoutNode, targetId: string, ids: string[], before = false): LayoutNode {
  if (!ids.length || ids.includes(targetId)) return root;
  return mapCell(root, targetId, (cell) => {
    const rest = cell.stack.filter((id) => !ids.includes(id));
    const at = rest.indexOf(targetId) + (before ? 0 : 1);
    return { type: 'pane', paneId: ids[0], stack: [...rest.slice(0, at), ...ids, ...rest.slice(at)] };
  });
}

/** The tab shown when the shown `paneId` leaves its stack: the one to its left, or else to its right. */
function stackNeighbor(stack: string[], paneId: string): string | undefined {
  const i = stack.indexOf(paneId);
  return stack[i > 0 ? i - 1 : 1];
}

/**
 * The pane to make active when `paneId` leaves: what its cell shows then, or else the pane
 * before it (or after it) in the layout.
 */
export function successor(root: LayoutNode, paneId: string): string | null {
  const cell = cellOf(root, paneId);
  if (!cell) return null;
  if (cell.stack.length > 1) return cell.paneId !== paneId ? cell.paneId : (stackNeighbor(cell.stack, paneId) ?? null);
  const shown = shownIds(root);
  const i = shown.indexOf(paneId);
  return shown[i - 1] ?? shown[i + 1] ?? null;
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / total);
}

/**
 * Inserts `newPaneId` next to `targetId`. When the target already sits in a
 * split of the same direction the new pane becomes a sibling, sharing the
 * target's space, instead of nesting a new split.
 */
export function splitPane(
  root: LayoutNode,
  targetId: string,
  newPaneId: string,
  direction: Direction,
  before = false,
): LayoutNode {
  return insertNode(root, targetId, leaf(newPaneId), direction, before);
}

/**
 * Like splitPane, but inserts a whole layout (e.g. another tab's splits) next to `targetId`, in half
 * of the target's space. A layout split the same way is merged in rather than nested.
 */
export function insertNode(
  root: LayoutNode,
  targetId: string,
  added: LayoutNode,
  direction: Direction,
  before = false,
): LayoutNode {
  const flat = added.type === 'split' && added.direction === direction;
  const parts = flat ? added.children : [added];
  const partSizes = flat ? added.sizes : [1];
  const place = (target: LayoutNode, targetSize: number) => {
    const half = targetSize / 2;
    const ins = partSizes.map((s) => s * half);
    return {
      children: before ? [...parts, target] : [target, ...parts],
      sizes: before ? [...ins, half] : [half, ...ins],
    };
  };
  // Next to the target's whole cell, even when the target is one of its tabs.
  const insert = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') {
      if (!node.stack.includes(targetId)) return node;
      return { type: 'split', direction, ...place(node, 1) };
    }
    const idx = node.children.findIndex((c) => c.type === 'pane' && c.stack.includes(targetId));
    if (idx >= 0 && node.direction === direction) {
      const { children, sizes } = place(node.children[idx], node.sizes[idx]);
      return {
        ...node,
        children: [...node.children.slice(0, idx), ...children, ...node.children.slice(idx + 1)],
        sizes: [...node.sizes.slice(0, idx), ...sizes, ...node.sizes.slice(idx + 1)],
      };
    }
    return { ...node, children: node.children.map(insert) };
  };
  return insert(root);
}

/** Removes a pane (and its cell, when it was the only tab there). Returns null when the tree becomes empty. */
export function removePane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (root.type === 'pane') {
    if (!root.stack.includes(paneId)) return root;
    const stack = root.stack.filter((id) => id !== paneId);
    if (!stack.length) return null;
    return { type: 'pane', paneId: root.paneId === paneId ? stackNeighbor(root.stack, paneId)! : root.paneId, stack };
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, i) => {
    const next = removePane(child, paneId);
    if (next) {
      children.push(next);
      sizes.push(root.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // A child split that now has our direction is flattened into us.
  const flatChildren: LayoutNode[] = [];
  const flatSizes: number[] = [];
  children.forEach((c, i) => {
    if (c.type === 'split' && c.direction === root.direction) {
      c.children.forEach((cc, j) => {
        flatChildren.push(cc);
        flatSizes.push(sizes[i] * c.sizes[j]);
      });
    } else {
      flatChildren.push(c);
      flatSizes.push(sizes[i]);
    }
  });
  return { ...root, children: flatChildren, sizes: normalize(flatSizes) };
}

/** Unit-square rectangles of every cell, by the pane it shows; used for directional focus. */
export function paneRects(root: LayoutNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (node: LayoutNode, r: Rect) => {
    if (node.type === 'pane') {
      out.set(node.paneId, r);
      return;
    }
    let offset = 0;
    node.children.forEach((child, i) => {
      const s = node.sizes[i];
      const childRect =
        node.direction === 'row'
          ? { x: r.x + offset * r.w, y: r.y, w: s * r.w, h: r.h }
          : { x: r.x, y: r.y + offset * r.h, w: r.w, h: s * r.h };
      offset += s;
      walk(child, childRect);
    });
  };
  walk(root, rect);
  return out;
}

const EPS = 1e-6;

/** The pane adjacent to `paneId` in `dir`, preferring the largest overlap. */
export function neighbor(root: LayoutNode, paneId: string, dir: FocusDirection): string | null {
  const rects = paneRects(root);
  const shown = cellOf(root, paneId)?.paneId;
  const cur = shown && rects.get(shown);
  if (!cur) return null;
  let best: { id: string; dist: number; overlap: number } | null = null;
  for (const [id, r] of rects) {
    if (id === shown) continue;
    let dist: number;
    let overlap: number;
    switch (dir) {
      case 'right':
        dist = r.x - (cur.x + cur.w);
        overlap = Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y);
        break;
      case 'left':
        dist = cur.x - (r.x + r.w);
        overlap = Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y);
        break;
      case 'down':
        dist = r.y - (cur.y + cur.h);
        overlap = Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
        break;
      case 'up':
        dist = cur.y - (r.y + r.h);
        overlap = Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
        break;
    }
    if (dist < -EPS || overlap <= EPS) continue;
    if (!best || dist < best.dist - EPS || (Math.abs(dist - best.dist) <= EPS && overlap > best.overlap)) {
      best = { id, dist, overlap };
    }
  }
  return best?.id ?? null;
}

/**
 * Moves the boundary between children `index` and `index + 1` of the split
 * at `path` by `delta` (a fraction of the split), keeping both above `min`.
 */
export function resizeAt(sizes: number[], index: number, delta: number, min: number): number[] {
  const next = [...sizes];
  const pair = next[index] + next[index + 1];
  const lo = Math.min(min, pair / 2);
  const a = Math.max(lo, Math.min(pair - lo, next[index] + delta));
  next[index] = a;
  next[index + 1] = pair - a;
  return next;
}

/** Resets every split in the tree to equal sizes. */
export function equalize(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') return node;
  return {
    ...node,
    children: node.children.map(equalize),
    sizes: node.children.map(() => 1 / node.children.length),
  };
}
