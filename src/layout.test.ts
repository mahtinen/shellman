import { describe, expect, it } from 'vitest';
import {
  equalize,
  leaf,
  neighbor,
  paneIds,
  paneRects,
  removePane,
  resizeAt,
  splitPane,
  type LayoutNode,
  type SplitNode,
} from './layout';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('splitPane', () => {
  it('turns a single pane into a two-way split', () => {
    const t = splitPane(leaf('a'), 'a', 'b', 'row') as SplitNode;
    expect(t.type).toBe('split');
    expect(t.direction).toBe('row');
    expect(paneIds(t)).toEqual(['a', 'b']);
    expect(t.sizes).toEqual([0.5, 0.5]);
  });

  it('can insert before the target', () => {
    const t = splitPane(leaf('a'), 'a', 'b', 'column', true);
    expect(paneIds(t)).toEqual(['b', 'a']);
  });

  it('adds a sibling instead of nesting when the direction matches', () => {
    let t: LayoutNode = splitPane(leaf('a'), 'a', 'b', 'row');
    t = splitPane(t, 'b', 'c', 'row');
    const s = t as SplitNode;
    expect(s.children.every((c) => c.type === 'pane')).toBe(true);
    expect(paneIds(t)).toEqual(['a', 'b', 'c']);
    expect(s.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('nests when the direction differs', () => {
    let t: LayoutNode = splitPane(leaf('a'), 'a', 'b', 'row');
    t = splitPane(t, 'b', 'c', 'column');
    const s = t as SplitNode;
    expect(s.children[1].type).toBe('split');
    expect((s.children[1] as SplitNode).direction).toBe('column');
    expect(paneIds(t)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the tree unchanged for an unknown target', () => {
    const t = splitPane(leaf('a'), 'zzz', 'b', 'row');
    expect(paneIds(t)).toEqual(['a']);
  });
});

describe('removePane', () => {
  it('returns null when the last pane is removed', () => {
    expect(removePane(leaf('a'), 'a')).toBeNull();
  });

  it('collapses a split with a single remaining child', () => {
    const t = splitPane(leaf('a'), 'a', 'b', 'row');
    expect(removePane(t, 'b')).toEqual(leaf('a'));
  });

  it('renormalizes sizes after removal', () => {
    let t: LayoutNode = splitPane(leaf('a'), 'a', 'b', 'row');
    t = splitPane(t, 'b', 'c', 'row');
    const r = removePane(t, 'a') as SplitNode;
    expect(paneIds(r)).toEqual(['b', 'c']);
    expect(sum(r.sizes)).toBeCloseTo(1);
    expect(r.sizes[0]).toBeCloseTo(0.5);
  });

  it('flattens a nested split that ends up in the same direction', () => {
    // row[a, column[b, row[c, d]]] -> remove b -> row[a, c, d]
    let t: LayoutNode = splitPane(leaf('a'), 'a', 'b', 'row');
    t = splitPane(t, 'b', 'c', 'column');
    t = splitPane(t, 'c', 'd', 'row');
    const r = removePane(t, 'b') as SplitNode;
    expect(r.direction).toBe('row');
    expect(r.children.every((c) => c.type === 'pane')).toBe(true);
    expect(paneIds(r)).toEqual(['a', 'c', 'd']);
    expect(sum(r.sizes)).toBeCloseTo(1);
    expect(r.sizes).toEqual([0.5, 0.25, 0.25].map((x) => expect.closeTo(x)));
  });
});

describe('geometry and focus', () => {
  // a | b
  //   | c
  const tree = splitPane(splitPane(leaf('a'), 'a', 'b', 'row'), 'b', 'c', 'column');

  it('computes rectangles', () => {
    const r = paneRects(tree);
    expect(r.get('a')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(r.get('b')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(r.get('c')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('finds neighbours in every direction', () => {
    expect(neighbor(tree, 'a', 'right')).toBe('b');
    expect(neighbor(tree, 'b', 'down')).toBe('c');
    expect(neighbor(tree, 'c', 'up')).toBe('b');
    expect(neighbor(tree, 'c', 'left')).toBe('a');
    expect(neighbor(tree, 'a', 'left')).toBeNull();
    expect(neighbor(tree, 'b', 'up')).toBeNull();
  });

  it('prefers the neighbour with the largest overlap', () => {
    // top: a (full width); bottom: b (30%) | c (70%)
    const t: LayoutNode = {
      type: 'split',
      direction: 'column',
      sizes: [0.5, 0.5],
      children: [leaf('a'), { type: 'split', direction: 'row', sizes: [0.3, 0.7], children: [leaf('b'), leaf('c')] }],
    };
    expect(neighbor(t, 'a', 'down')).toBe('c');
  });
});

describe('resizeAt / equalize', () => {
  it('moves a boundary and clamps to the minimum', () => {
    expect(resizeAt([0.5, 0.5], 0, 0.1, 0.1)).toEqual([0.6, 0.4].map((x) => expect.closeTo(x)));
    expect(resizeAt([0.5, 0.5], 0, 0.9, 0.1)).toEqual([0.9, 0.1].map((x) => expect.closeTo(x)));
    expect(resizeAt([0.5, 0.5], 0, -0.9, 0.1)).toEqual([0.1, 0.9].map((x) => expect.closeTo(x)));
  });

  it('only touches the two adjacent children', () => {
    const r = resizeAt([0.2, 0.3, 0.5], 1, 0.1, 0.05);
    expect(r[0]).toBe(0.2);
    expect(r[1]).toBeCloseTo(0.4);
    expect(r[2]).toBeCloseTo(0.4);
  });

  it('equalizes all splits', () => {
    const t = equalize({ type: 'split', direction: 'row', sizes: [0.9, 0.1], children: [leaf('a'), leaf('b')] }) as SplitNode;
    expect(t.sizes).toEqual([0.5, 0.5]);
  });
});
