/**
 * Asking about worktrees: the name of a new one (and what it starts from), and whether to remove one
 * after saying what that would lose. The git work is in worktree.rs.
 */
import { api } from './api';
import { dialog } from './dialogs';
import { h } from './dom';
import { store } from './store';
import type { WorktreeRef } from './types';
import { branchProblem, defaultWorktreeName, folderInWorktree, worktreeFolder } from './worktrees';

export interface NewWorktree {
  ref: WorktreeRef;
  /** Where a terminal of the session opens in it (the same folder of the repository). */
  cwd: string;
  copied: number;
}

/** Asks for a name, then creates a worktree of the repository `folder` is in. Null when cancelled. */
export async function askNewWorktree(folder: string, sessionName: string): Promise<NewWorktree | null> {
  const info = await api.worktreeInfo(folder).catch((e) => {
    throw new Error(String(e));
  });
  if (!info) throw new Error(`${folder} isn't in a git repository, so it can't have worktrees.`);
  const targets = await api.gitCompareTargets(folder).catch(() => null);
  const s = store.settings;
  const prefix = s.worktreeBranchPrefix;
  const branches = [...(targets?.branches ?? []), ...info.worktrees.map((w) => w.branch ?? '')].filter(Boolean);
  const current = info.branch ?? 'HEAD';

  const name = h('input', { class: 'input', value: defaultWorktreeName(sessionName, prefix, branches), spellcheck: false, autocomplete: 'off' });
  const from = h(
    'select',
    { class: 'input' },
    h('option', { value: current }, info.branch ? `${info.branch} (this folder's branch)` : 'The commit this folder is on'),
    ...[...new Set(targets?.branches ?? [])].filter((b) => b !== current).map((b) => h('option', { value: b }, b)),
  );
  const where = h('small', { class: 'hint wt-where' });
  const error = h('div', { class: 'dialog-error' });
  const update = () => {
    const n = name.value.trim();
    where.textContent = n ? `Branch ${prefix}${n} in ${worktreeFolder(info.top, s.worktreeDir, n)}` : '';
    error.textContent = '';
  };
  name.addEventListener('input', update);
  update();

  return new Promise((resolve) => {
    let result: NewWorktree | null = null;
    dialog({
      title: `New worktree for ${sessionName}`,
      width: 520,
      body: [
        h('p', { class: 'hint' }, 'A folder and branch of its own, so this terminal\'s changes stay apart from the others until you merge them.'),
        h('label', { class: 'field' }, h('span', null, 'Name'), name, where),
        h('label', { class: 'field' }, h('span', null, 'Start from'), from),
        s.worktreeCopy ? h('small', { class: 'hint' }, `Copies ${s.worktreeCopy} into it (Settings → Worktrees).`) : null,
        error,
      ],
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Create',
          kind: 'primary',
          onClick: async () => {
            const n = name.value.trim();
            const branch = `${prefix}${n}`;
            const problem = branchProblem(n) ?? branchProblem(branch);
            if (problem) {
              error.textContent = problem;
              name.focus();
              return false;
            }
            const path = worktreeFolder(info.top, s.worktreeDir, n);
            error.textContent = 'Creating the worktree…';
            try {
              const added = await api.worktreeAdd(folder, path, branch, from.value, s.worktreeCopy);
              result = { ref: { path: added.path, branch: added.branch, base: added.base }, cwd: folderInWorktree(added.path, info.prefix), copied: added.copied };
              return true;
            } catch (e) {
              error.textContent = String(e);
              return false;
            }
          },
        },
      ],
      focus: name,
      onClose: () => resolve(result),
    });
  });
}

/**
 * Asks whether to remove the worktree at `path` (on `branch`), saying what would be lost: its
 * uncommitted changes and the commits only its branch has. `terminals` of it are open.
 */
export async function askRemoveWorktree(ref: { path: string; branch: string | null }, terminals: number): Promise<{ deleteBranch: boolean; force: boolean } | null> {
  const st = await api.worktreeStatus(ref.path).catch(() => null);
  const deleteBranch = h('input', { type: 'checkbox', checked: !!ref.branch && (st?.onlyHere ?? 1) === 0 });
  const lines = [
    st && st.changes ? `${st.changes} uncommitted ${st.changes === 1 ? 'change' : 'changes'} in it will be lost.` : null,
    st && st.onlyHere && ref.branch ? `${st.onlyHere} ${st.onlyHere === 1 ? 'commit is' : 'commits are'} only on ${ref.branch}: deleting the branch loses ${st.onlyHere === 1 ? 'it' : 'them'} (merge first to keep ${st.onlyHere === 1 ? 'it' : 'them'}).` : null,
    terminals ? `${terminals} open ${terminals === 1 ? 'terminal' : 'terminals'} in it will be closed.` : null,
    st ? null : 'Its state could not be read (the folder may be gone).',
  ].filter((l): l is string => !!l);
  return new Promise((resolve) => {
    let result: { deleteBranch: boolean; force: boolean } | null = null;
    dialog({
      title: `Remove the worktree ${ref.branch ?? ''}?`.replace(/\s+\?$/, '?'),
      width: 520,
      body: [
        h('p', { class: 'hint mono' }, ref.path),
        ...(lines.length ? lines.map((l) => h('p', { class: 'wt-warn' }, l)) : [h('p', null, 'Everything in it is committed and on another branch too, so nothing is lost.')]),
        ref.branch
          ? h('label', { class: 'check' }, deleteBranch, h('span', null, `Delete the branch ${ref.branch} too`, h('small', { class: 'hint' }, 'Otherwise the branch stays, and its commits with it.')))
          : null,
      ],
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Remove',
          kind: 'danger',
          onClick: () => {
            // Uncommitted work, or commits only on a branch being deleted, were just shown: removing means it.
            result = { deleteBranch: deleteBranch.checked, force: !!st && (st.changes > 0 || (deleteBranch.checked && st.onlyHere > 0)) };
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}
