/**
 * Importing sessions from other programs. Each source (XShell, …) turns its own files into
 * candidates; choosing them, finding the ones already saved and making sessions is shared here.
 */
import { newGroup, uid } from './config';
import type { Connection, Group, SavedSession } from './types';

/** A session found in another program. */
export interface ImportCandidate {
  /** Folders it is in, in that program. */
  folder: string[];
  name: string;
  connection: Connection | null;
  /** Why it can't be imported ('' = it can). */
  skip: string;
}

const DEFAULT_PORT = { ssh: 22, telnet: 23 } as const;

/** Same server: kind, host (any case), port (the default spelled out or not) and user. */
export function connectionKey(c: Connection): string {
  return [c.kind, c.host.toLowerCase(), c.port ?? DEFAULT_PORT[c.kind], c.kind === 'ssh' ? c.user : ''].join('\n');
}

/** "Prod / Web / web1" (or just "web1"). */
export function candidateName(c: ImportCandidate, folderNames: boolean): string {
  return [...(folderNames ? c.folder : []), c.name.trim() || c.connection?.host || 'Session'].join(' / ');
}

/**
 * Marks servers that are already saved, or that came earlier in the list, so each one is
 * imported once.
 */
export function markDuplicates(candidates: ImportCandidate[], existing: SavedSession[]): ImportCandidate[] {
  const seen = new Map<string, string>();
  for (const s of existing) if (s.connection) seen.set(connectionKey(s.connection), '');
  return candidates.map((c) => {
    if (c.skip || !c.connection) return c;
    const key = connectionKey(c.connection);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, candidateName(c, true));
      return c;
    }
    return { ...c, skip: first ? `Same host as ${first}` : 'Already saved' };
  });
}

/** The program's folders become subgroups, or go in front of the session names. */
export type FolderMode = 'subgroups' | 'names';

/**
 * New groups and sessions for the chosen candidates, in `groupId`. As subgroups, a folder reuses a
 * group of that name that is already there, so importing more later fills the same groups.
 */
export function importInto(chosen: ImportCandidate[], groups: Group[], groupId: string | null, folders: FolderMode): { groups: Group[]; sessions: SavedSession[] } {
  const added: Group[] = [];
  const all = [...groups];
  const groupFor = (folder: string[]): string | null => {
    let parent = groupId;
    for (const name of folders === 'subgroups' ? folder : []) {
      let g = all.find((x) => x.parentId === parent && x.name.toLowerCase() === name.toLowerCase());
      if (!g) {
        g = newGroup(name, parent);
        all.push(g);
        added.push(g);
      }
      parent = g.id;
    }
    return parent;
  };
  const sessions = chosen
    .filter((c) => !c.skip && c.connection)
    .map((c) => ({
      id: uid('s-'),
      name: candidateName(c, folders === 'names'),
      groupId: groupFor(c.folder),
      connection: { ...c.connection! },
      cwd: '',
      command: '',
      shellId: '',
      color: '',
      env: {},
      collapsed: false,
      newWorktree: false,
    }));
  return { groups: added, sessions };
}

/** "12 sessions", "1 session". */
export const sessionCount = (n: number) => `${n} session${n === 1 ? '' : 's'}`;
