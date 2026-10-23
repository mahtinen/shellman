/**
 * File paths in terminal output that open in the Files pane: `src/app.ts:42`, `C:\Projects\app\Program.cs(12,5)`,
 * `./web/page.tsx:8:3`, `/c/repo/x.rs`, `"main.py", line 7`. Only paths that exist become links
 * (the terminal checks), so text that merely looks like a path stays plain. Pure functions.
 */

export interface PathLink {
  /** Where the link is in the line (characters, end exclusive). */
  start: number;
  end: number;
  /** As written (without its line number). */
  path: string;
  line: number | null;
  column: number | null;
}

/** A path: a drive (C:\), a Git Bash or WSL drive (/c/, /mnt/c/), ./ or ../, then folders and a file with an extension. */
const PATH =
  /(?:[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|\/[a-z]\/|\.{1,2}[\\/])?(?:[\w.@$+~-]+[\\/])*[\w.@$+~-]*\.[A-Za-z][\w]{0,11}(?=$|[\s:(),;'"`\]>|#])/g;
/** What may follow a path: :line, :line:column, (line,column), #Lline, or Python's ", line N". */
const LINE = /^(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|#L(\d+)|",\s*line\s+(\d+))/;
const MAX_LINKS = 20;

export function findPathLinks(text: string): PathLink[] {
  const out: PathLink[] = [];
  PATH.lastIndex = 0;
  for (let m = PATH.exec(text); m && out.length < MAX_LINKS; m = PATH.exec(text)) {
    const start = m.index;
    const path = m[0];
    // Part of a URL (the web links handle those) or of a longer word.
    if (/:\/\/\S*$/.test(text.slice(Math.max(0, start - 200), start)) || /[\w/\\]/.test(text[start - 1] ?? '')) continue;
    // A bare name needs to look like a file name, not "e.g" or "v1.2".
    if (!/[\\/]/.test(path) && !/\.[A-Za-z][\w]*$/.test(path)) continue;
    if (/^\d/.test(path.slice(path.lastIndexOf('.') + 1))) continue;
    const rest = LINE.exec(text.slice(start + path.length));
    const line = rest ? Number(rest[1] ?? rest[3] ?? rest[5] ?? rest[6]) : null;
    const column = rest && (rest[2] ?? rest[4]) ? Number(rest[2] ?? rest[4]) : null;
    // A Python traceback quotes the path: the link stays on the path, the line number comes along.
    const end = start + path.length + (rest && !rest[0].startsWith('"') ? rest[0].length : 0);
    out.push({ start, end, path, line, column });
  }
  return out;
}

/** The Windows path that `path` names, seen from the folder `cwd`; null when it can't be one here. */
export function resolvePath(path: string, cwd: string): string | null {
  let p = path.replace(/\//g, '\\');
  const drive = /^\\(?:mnt\\)?([a-z])\\/.exec(p);
  if (drive) p = `${drive[1].toUpperCase()}:\\${p.slice(drive[0].length)}`;
  else if (p.startsWith('\\')) return null;
  const absolute = /^[A-Za-z]:\\/.test(p);
  if (!absolute) {
    if (!cwd) return null;
    p = `${cwd.replace(/[\\/]+$/, '')}\\${p}`;
  }
  // Fold . and .. so the same file always has the same path. A UNC path (WSL) keeps its \\server\share.
  const unc = p.startsWith('\\\\');
  const [head, ...parts] = unc ? [`\\\\${p.slice(2).split('\\').slice(0, 2).join('\\')}`, ...p.slice(2).split('\\').slice(2)] : p.split('\\');
  const kept: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') kept.pop();
    else kept.push(part);
  }
  return [head, ...kept].join('\\');
}

/** The Windows path of a `file://` link (from an OSC 8 hyperlink), or null. */
export function fileUriPath(uri: string): string | null {
  const m = /^file:\/\/(?:localhost)?\/([A-Za-z]:\/.*)$/i.exec(uri);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/\//g, '\\');
  } catch {
    return null;
  }
}
