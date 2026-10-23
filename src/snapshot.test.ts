import { describe, expect, it } from 'vitest';
import { leaf, type LayoutNode } from './layout';
import { layoutFromSnapshot, normalizeSnapshot, snapshotLeaves, snapshotNode, snapshotPanes, type SnapshotLeaf } from './snapshot';
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

  it('keeps a hex pane colour only', () => {
    const snap = normalizeSnapshot({ tabs: [{ root: { pane: spec('C:\\a', { color: '#A1B2C3' }) } }, { root: { pane: spec('C:\\b', { color: 'red;x' }) } }] })!;
    expect(snap.tabs.map((t) => snapshotPanes(t.root)[0].color)).toEqual(['#a1b2c3', '']);
  });

  it('round-trips a nested layout with sizes', () => {
    const tree: LayoutNode = {
      type: 'split',
      direction: 'row',
      sizes: [0.7, 0.3],
      children: [leaf('a'), { type: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] }],
    };
    const specs: Record<string, LaunchSpec> = { a: spec('C:\\a', { command: 'claude' }), b: spec('C:\\b'), c: spec('C:\\c') };
    const snap = snapshotNode(tree, (id) => ({ pane: specs[id] }))!;
    expect(snapshotPanes(snap).map((s) => s.cwd)).toEqual(['C:\\a', 'C:\\b', 'C:\\c']);

    let n = 0;
    const created: SnapshotLeaf[] = [];
    const back = layoutFromSnapshot(snap, (l) => (created.push(l), `p${n++}`));
    expect(created.map((l) => ('pane' in l ? l.pane.command : null))).toEqual(['claude', '', '']);
    expect(back).toEqual({
      type: 'split',
      direction: 'row',
      sizes: [0.7, 0.3],
      children: [leaf('p0'), { type: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('p1'), leaf('p2')] }],
    });
  });

  it('drops panes that are gone and collapses single-child splits', () => {
    const tree: LayoutNode = { type: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('gone')] };
    expect(snapshotNode(tree, (id) => (id === 'a' ? { pane: spec('C:\\a') } : null))).toEqual({ pane: spec('C:\\a') });
  });

  it('keeps request panes next to terminals', () => {
    const tree: LayoutNode = { type: 'split', direction: 'row', sizes: [0.6, 0.4], children: [leaf('r'), leaf('t')] };
    const leaves: Record<string, SnapshotLeaf> = { r: { request: { groupId: 'g1', path: 'users/list.request.json' } }, t: { pane: spec('C:\\a') } };
    const snap = normalizeSnapshot({ tabs: [{ activePane: 1, root: snapshotNode(tree, (id) => leaves[id]) }] })!;
    expect(snapshotLeaves(snap.tabs[0].root)).toEqual([leaves.r, leaves.t]);
    expect(snapshotPanes(snap.tabs[0].root)).toEqual([spec('C:\\a')]);
    expect(snap.tabs[0].activePane).toBe(1);
    // A request without its group or file can't be reopened.
    expect(normalizeSnapshot({ tabs: [{ root: { request: { groupId: 'g1' } } }, { root: { request: 'x' } }] })).toBeNull();
  });

  it('keeps the worktree a terminal was opened in', () => {
    const worktree = { path: 'C:\\Projects\\shop.worktrees\\fix', branch: 'claude/fix', base: 'a'.repeat(40) };
    const snap = normalizeSnapshot({ tabs: [{ root: { pane: { ...spec('C:\\Projects\\shop.worktrees\\fix\\api'), worktree } } }] })!;
    expect(snapshotPanes(snap.tabs[0].root)[0].worktree).toEqual(worktree);
    const broken = normalizeSnapshot({ tabs: [{ root: { pane: { ...spec('C:\\a'), worktree: { path: 'C:\\x' } } } }] })!;
    expect(snapshotPanes(broken.tabs[0].root)[0].worktree).toBeUndefined();
  });

  it('keeps Files panes, with defaults for what is missing', () => {
    const files: SnapshotLeaf = { files: { root: 'C:\\Projects\\app', path: 'src/main.ts', view: 'changes', mode: 'diff', base: 'merge-base:main', baseLabel: 'main' } };
    const snap = normalizeSnapshot({ tabs: [{ root: { split: 'row', sizes: [1, 1], children: [files, { pane: spec('C:\\a') }] } }] })!;
    expect(snapshotLeaves(snap.tabs[0].root)).toEqual([files, { pane: spec('C:\\a') }]);
    expect(normalizeSnapshot({ tabs: [{ root: { files: { root: 'C:\\x', view: 'odd' } } }] })!.tabs[0].root).toEqual({
      files: { root: 'C:\\x', path: '', view: 'all', mode: 'file', base: 'HEAD', baseLabel: '' },
    });
    expect(normalizeSnapshot({ tabs: [{ root: { files: { path: 'a.ts' } } }] })).toBeNull();
  });

  it('leaves out panes that can no longer be opened', () => {
    const leaves: SnapshotLeaf[] = [{ request: { groupId: 'g', path: 'gone.request.json' } }, { pane: spec('C:\\a') }, { pane: spec('C:\\b') }];
    const root = { split: 'row' as const, sizes: [0.5, 0.125, 0.375], children: leaves };
    let n = 0;
    const back = layoutFromSnapshot(root, (l) => ('request' in l ? null : `p${n++}`));
    expect(back).toEqual({ type: 'split', direction: 'row', sizes: [0.25, 0.75], children: [leaf('p0'), leaf('p1')] });
    expect(layoutFromSnapshot(leaves[0], () => null)).toBeNull();
    expect(layoutFromSnapshot({ ...root, children: [leaves[0], leaves[1]] }, (l) => ('request' in l ? null : 'only'))).toEqual(leaf('only'));
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
