/**
 * Gives every Claude Code terminal its own conversation, so reopening Shellman (or restarting a
 * terminal) resumes that terminal's conversation instead of the folder's latest one.
 */
import type { ShellKind } from './types';

/** Options that already choose a conversation, or don't start an interactive one. */
const OWN_CHOICE = new Set(['-p', '--print', '-c', '--continue', '-r', '--resume', '--session-id', '--fork-session', '-v', '--version', '-h', '--help']);

/** Options that take one value (`<value>` or `[value]` in `claude --help`). */
const VALUE_OPTIONS = new Set([
  '--agent', '--agents', '--append-system-prompt', '--autocompact', '--cloud', '-d', '--debug', '--debug-file',
  '--effort', '--environment', '--fallback-model', '--from-pr', '--input-format', '--json-schema',
  '--max-budget-usd', '--model', '-n', '--name', '--output-format', '--permission-mode', '--permission-prompts',
  '--plugin-dir', '--plugin-url', '--prompt-suggestions', '--remote-control', '--remote-control-session-name-prefix',
  '--setting-sources', '--settings', '--system-prompt', '--system-prompt-snapshot', '--teammate-mode', '--teleport',
  '-w', '--worktree',
]);

/** Options that take a list of values (`<values...>`): every following bare word is one. */
const LIST_OPTIONS = new Set([
  '--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools', '--disallowed-tools', '--file',
  '--mcp-config', '--tools',
]);

/**
 * True for `claude` started interactively with options only, e.g. `claude` or
 * `claude --model opus --dangerously-skip-permissions`. Not for subcommands (`claude mcp`),
 * a startup prompt (`claude "fix the bug"`, `claude --verbose fix`), or commands that pick
 * their own conversation.
 */
export function isTrackableClaude(command: string): boolean {
  const c = command.trim();
  // A quoted argument is a startup prompt; resuming would send it again.
  if (!c || /["'`]/.test(c)) return false;
  const [exe, ...args] = c.split(/\s+/);
  if (!/^claude(\.exe|\.cmd|\.ps1)?$/i.test(exe)) return false;
  // What a bare word can be right now: the value of the option before it, more list values, or nothing.
  let accepts: 'none' | 'one' | 'list' = 'none';
  for (const a of args) {
    if (a.startsWith('-')) {
      const [flag, inline] = [a.split('=')[0], a.includes('=')];
      if (OWN_CHOICE.has(flag)) return false;
      accepts = inline ? 'none' : LIST_OPTIONS.has(flag) ? 'list' : VALUE_OPTIONS.has(flag) ? 'one' : 'none';
      continue;
    }
    // Any other bare word is a startup prompt (or a subcommand).
    if (accepts === 'none') return false;
    if (accepts === 'one') accepts = 'none';
  }
  return true;
}

/**
 * The command a terminal actually runs. The first start creates conversation `id`; later starts
 * resume it, and if it was never used (Claude then exits with "No conversation found"), start it fresh.
 */
export function claudeCommand(command: string, id: string, resume: boolean, shell: ShellKind): string {
  const base = command.trim();
  const fresh = `${base} --session-id ${id}`;
  if (!resume) return fresh;
  const again = `${base} --resume ${id}`;
  switch (shell) {
    case 'powershell':
      return `${again}; if ($LASTEXITCODE -ne 0) { ${fresh} }`;
    case 'cmd':
    case 'bash':
    case 'wsl':
      return `${again} || ${fresh}`;
    default:
      return again;
  }
}

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
