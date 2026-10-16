import { describe, expect, it } from 'vitest';
import { leaf, type LayoutNode } from './layout';
import { layoutFromSnapshot, normalizeSnapshot, snapshotNode, snapshotPanes } from './snapshot';
import type { LaunchSpec } from './types';

const spec = (cwd: string, extra: Partial<LaunchSpec> = {}): LaunchSpec => ({
  name: cwd,
  cwd,
  command: '',
  shellId: '',
  env: {},
  color: '',
  sessionId: null,
  ...extra,
});

describe('snapshot', () => {
  it('keeps a pane\'s connection', () => {
    const connection = { kind: 'ssh' as const, host: 'web1', port: 22, user: 'bob', identityFile: '', identityKey: '', passwordAuth: false, legacyAlgorithms: false, jumpHost: '', extraArgs: '-A' };
    const snap = normalizeSnapshot({ tabs: [{ root: { pane: spec('C:\\Users\\me', { connection }) } }, { root: { pane: spec('C:\\x', { connection: { kind: 'bogus' } as any }) } }] })!;
    expect(snapshotPanes(snap.tabs[0].root)[0].connection).toEqual(connection);
    expect(snapshotPanes(snap.tabs[1].root)[0].connection).toBeUndefined();
  });

  it('round-trips a nested layout with sizes', () => {
    const tree: LayoutNode = {
      type: 'split',
      direction: 'row',
      sizes: [0.7, 0.3],
      children: [leaf('a'), { type: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] }],
    };
    const specs: Record<string, LaunchSpec> = { a: spec('C:\\a', { command: 'claude' }), b: spec('C:\\b'), c: spec('C:\\c') };
    const snap = snapshotNode(tree, (id) => specs[id])!;
    expect(snapshotPanes(snap).map((s) => s.cwd)).toEqual(['C:\\a', 'C:\\b', 'C:\\c']);

    let n = 0;
    const created: LaunchSpec[] = [];
    const back = layoutFromSnapshot(snap, (s) => (created.push(s), `p${n++}`));
    expect(created.map((s) => s.command)).toEqual(['claude', '', '']);
    expect(back).toEqual({
      type: 'split',
      direction: 'row',
      sizes: [0.7, 0.3],
      children: [leaf('p0'), { type: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('p1'), leaf('p2')] }],
    });
  });

  it('drops panes that are gone and collapses single-child splits', () => {
    const tree: LayoutNode = { type: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('gone')] };
    expect(snapshotNode(tree, (id) => (id === 'a' ? spec('C:\\a') : null))).toEqual({ pane: spec('C:\\a') });
  });

  it('normalizes what is read from disk', () => {
    expect(normalizeSnapshot(null)).toBeNull();
    expect(normalizeSnapshot({ tabs: [] })).toBeNull();
    expect(normalizeSnapshot({ tabs: [{ root: { pane: { name: 'no cwd' } } }] })).toBeNull();

    const s = normalizeSnapshot({
      activeTab: 7,
      tabs: [
        'junk',
        {
          title: '  Work  ',
          activePane: 1,
          root: { split: 'column', sizes: [3, 'x', 1], children: [{ pane: { cwd: 'C:\\a', env: { A: '1', B: 2 } } }, { pane: { cwd: 'C:\\b' } }, { bogus: true }] },
        },
      ],
    })!;
    expect(s.activeTab).toBe(0);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].title).toBe('Work');
    expect(s.tabs[0].activePane).toBe(1);
    const root = s.tabs[0].root as { split: string; sizes: number[]; children: { pane: LaunchSpec }[] };
    expect(root.split).toBe('column');
    expect(root.sizes).toEqual([0.75, 0.25]);
    expect(root.children[0].pane).toEqual(spec('C:\\a', { name: 'Terminal', env: { A: '1' } }));
  });
});
