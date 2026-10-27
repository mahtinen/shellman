# Shellman

**[shellman.app](https://shellman.app)** · [Download for Windows](https://github.com/mahtinen/shellman/releases/latest/download/Shellman-setup.exe) · MIT license

![Shellman with Claude Code in a git worktree and its changes as a diff below, saved sessions in the sidebar](docs/img/hero.png)

A Windows terminal manager built around the places you work. Save a project folder with the command you run
there (`claude`, `npm run dev`), or an SSH host, and open it in a tab or split with one click. Free, open source,
a 2 MB installer.

## Highlights

- **Saved sessions.** A folder and a command, or an SSH or Telnet host, in groups. Each session lists its open
  terminals, and tabs, splits and folders come back after a restart.
- **Several Claudes in one repository.** Open in new worktree gives a terminal its own folder and branch. Every
  Claude tab keeps its own conversation, and the tab lights up when Claude finishes or needs you.
- **Review changes without an editor.** Show files (Ctrl+Shift+G) opens the folder read-only: the tree, the
  changed files and their diffs, compared with the last commit, another branch or an earlier commit.
- **SSH with the keys you already have.** Windows' own OpenSSH, so the ssh-agent, 1Password and `~/.ssh/config`
  work as usual. Shellman never stores passwords or private keys.
- **API requests, shared through git.** Request files in a folder your team shares, sent with Windows' curl,
  with secrets kept in `.env.local` or 1Password.

Also: PowerShell, cmd, Git Bash and WSL; splits to any depth; quick open; six themes; keyboard first.

## Install

Download [Shellman-setup.exe](https://github.com/mahtinen/shellman/releases/latest/download/Shellman-setup.exe)
(per-user install, no admin needed). It needs the WebView2 runtime, which comes with Windows 11 and most
Windows 10 PCs. The installer isn't code-signed yet, so SmartScreen may ask you to confirm (More info → Run
anyway).

New versions download in the background and install when you restart Shellman. Only installers signed with the
project's update key are accepted.

<details>
<summary>Updates and where settings are stored</summary>

Shellman checks GitHub Releases (`github.com/mahtinen/shellman`) 15 seconds after it starts and then every
4 hours. By default a new version downloads in the background, and a **Restart to update** button appears in
the tab bar. If you don't restart, the update installs when you close Shellman, and the next start runs the
new version. Settings → Updates can switch this to "tell me when a new version is out" or turn checks off.
Settings → About lists what changed in the five latest versions, with their release dates.

Settings and sessions are stored in `%APPDATA%\app.shellman.desktop\config.json`. Every save also keeps
the previous version as `config.json.bak`. If `config.json` can't be parsed (say, after a hand edit), it is
moved aside as `config.json.corrupt-…` and the backup is loaded instead, with a message saying so. Only one
Shellman runs at a time: starting it again brings the open window to the front.

</details>

## Features in detail

<details>
<summary><b>Sessions, tabs and splits</b></summary>

- **Session sidebar.** Saved directories with optional startup command, shell, colour (15 presets or any
  custom colour), environment variables and groups. A group can have a colour too: its sessions and subgroups get it unless they have
  their own. Click opens a new tab; the hover buttons or middle-click open it as a split.
  The + button (and Ctrl+Shift+N for SSH/Telnet) opens a terminal or connection without saving it, unless
  you tick "Remember this session"; Ctrl+Shift+S saves an open one later.
  Shift+click (or "Open plain terminal") opens the session's folder and shell *without* its startup command,
  e.g. for some git work next to Claude.
  Drag to reorder or move between groups. Groups can hold subgroups ("New subgroup…" on a group, or drag a
  group onto the middle of another); deleting a group moves what was in it up one level. "Open all in tabs"
  on a group starts your whole workspace (its own sessions, not its subgroups').
  New sessions start out in your home directory (or the default directory from Settings).
  With the WSL shell, Browse starts in your Linux home and the directory can be typed as a Linux path
  (`~/projects/app`); a folder in another distribution opens in that distribution.
- **Open terminals tree.** Each session lists its open terminals underneath it: the ones opened from it, plus
  any other terminal sitting in its directory. Click one to jump to its tab, middle-click to close it,
  right-click for more. The chevron next to a session collapses its list, like a group, and the state is
  saved. Terminals outside every session directory are listed under "Other terminals" at the top of the sidebar (also collapsible).
- **Quick open** (Ctrl+Shift+P): fuzzy-search saved sessions; Enter = tab, Ctrl+Enter = split right,
  Shift+Enter = split down.
- **Any shell, any time.** Open a session with a different shell from the ▾ hover button or "Open with
  shell" in its menu. To change the shell of a running terminal, click the shell name in the status bar or
  use "Switch shell" in the terminal menu. It restarts in the same directory. "New tab here with" opens
  another shell next to it.
- **Splits and tabs.** Split right/down to any depth, drag dividers (double-click resets), maximize a
  pane (Alt+arrows from a maximized pane bring the split back), move focus with Alt+arrows, drag tabs to
  reorder. Terminals move between tabs and keep running: a pane goes out of its split into a tab of its own
  (Ctrl+Shift+M or the pane header), and another tab comes into the current one as a split (drag it onto a
  pane, or "Move into current tab" on the tab's right-click menu). A tab has the same name as its terminal
  in the sidebar: Claude's task title if there is one, otherwise the session's name. Tabs shrink and cut their
  names as more of them open (hover for the full name).
- **Picks up where you left off.** Tabs, splits and each terminal's folder are reopened on the next start,
  with startup commands run again (Settings → Terminal → On start can reopen plain shells or nothing).
  The screen contents of terminals aren't restored.
- **"Same directory" everywhere.** New tab, splits and duplicate all start in the *current* directory
  of the active terminal. Shell integration makes PowerShell, cmd, Git Bash and WSL report `cd`
  (OSC 9;9 / OSC 7).
- **Other terminal features.** Find (Ctrl+Shift+F), clickable links and file paths (Ctrl+Click; files open in
  the Files pane), copy on select, right-click paste, Ctrl+wheel zoom, six themes, custom shells. Closing a
  pane, tab or the window warns if a program (like `claude`) is still running. (Programs inside WSL can't be
  seen from Windows, so there it warns when the terminal was started with a command.)

</details>

<details>
<summary><b>Claude Code and git worktrees</b></summary>

- **Its own conversation in every terminal.** Every terminal started with `claude` has its own conversation,
  and it comes back in that terminal: three Claude tabs in one folder reopen three different conversations.
- **Git worktrees, one per Claude.** Several Claudes can work in one repository without changing each other's
  files: right-click a session → Open in new worktree (or tick "Open each terminal in a new git worktree" for the
  session) gives the terminal a folder and branch of its own (`claude/<name>`, in `<repository>.worktrees` next to
  the repository), started from the branch you choose. It runs the session's startup command there and stays under
  its session in the sidebar, with its branch; Show files in it compares with where the worktree started, so it
  shows exactly that terminal's work, committed or not. Worktrees… in the session's menu lists the repository's
  worktrees, to open a terminal or the files in one or remove it; removing says first what would be lost
  (uncommitted changes, commits that are only on its branch) and can delete the branch too. Settings → Worktrees
  sets the folder, the branch prefix and the ignored files to copy into new worktrees (like `.env.local`), or turns
  worktrees off altogether.
- **Small things.** Shift+Enter inserts a newline. Ctrl+V forwards to Claude when the clipboard holds an image.
  Background tabs show when a session is producing output or has finished. Bells and OSC 9 / OSC 777
  notifications flash the taskbar and show a toast.

Tips:

- To get notified when Claude finishes or needs input, set Claude Code's notification channel to the
  terminal bell (`/config`). Shellman then marks the tab and flashes the taskbar when Shellman isn't focused.
- Use plain `claude` (options like `--model` are fine) as a session's startup command. Shellman starts each
  terminal with its own conversation (`--session-id`) and resumes exactly that one after a restart, Restart
  or Switch shell (`--resume`). Switching conversations inside the tab with `/resume` or `/clear` is followed,
  so the one on screen is the one that comes back. A conversation that was never used starts fresh.
  `claude --continue` would instead make every terminal in the folder open the same, most recent conversation.
- Not tracked: sessions whose startup command isn't plain `claude`, such as startup prompts
  (`claude "fix the bug"`), `-p` and subcommands. In WSL, `/resume` is followed when Claude Code is installed inside
  WSL (not a Windows `claude.exe` run from there).

</details>

<details>
<summary><b>Files and changes (read-only)</b></summary>

Right-click a session → Show files (or Ctrl+Shift+G in its terminal) to look at its folder without opening an
editor: the whole tree, every file with syntax colours, and what changed since the last commit marked in the tree
(M, A, D, U for new files git doesn't know yet). The Changes view lists only the changed files with their added
and removed lines. "vs last commit" at the bottom changes what they are compared with: another branch (everything
done on this branch, committed or not, like a pull request) or an earlier commit (that commit and everything after
it), so work Claude has already committed shows too.

- A changed file opens as a diff, side by side or inline, with unchanged lines folded away and the changed words
  marked; F7 and Shift+F7 jump between changes.
- Ctrl+click a file path in a terminal (`src/app.ts:42`, `Program.cs(12,5)`, a `file://` link) to open it here at
  that line.
- Markdown files open as a preview (headings, lists, tables, code with colours, images from the folder; links to
  other files open them here), with Source a click away. HTML in a Markdown file is shown only as far as it is
  safe: scripts, styles and event handlers are left out, and images from the internet aren't loaded.
- Ctrl+P goes to a file by name (`@` lists the open file's functions and classes) and Ctrl+F finds text in the
  open one. **Search** (Ctrl+Shift+F) finds text in all the files, with match case, whole word, regular
  expressions and globs for the files to look in (`*.cs, !tests/**`); it runs `git grep`, so files git ignores
  are left out.
- Ctrl+click a name, or F12, to go to its definition; Shift+F12 lists its references and Ctrl+F12 the types that
  implement it. These find declarations by searching (no language server), so they work in any language without
  installing anything, and a name declared in several places gives a list to choose from. The mouse's back and
  forward buttons go back to where you were.
- Right-click a line → Copy reference puts `src/app.ts:42` on the clipboard (`src/app.ts:42-48` for the selected
  lines), to paste for Claude.
- The pane follows along while Claude (or anything else) edits files, commits or switches branches. Nothing is
  ever written: the VS Code button opens the whole folder there, at the file and line you are looking at. Files
  git ignores are dimmed (or hidden, from the pane's menu).

</details>

<details>
<summary><b>SSH and Telnet</b></summary>

Save remote hosts next to your folders (same groups, colours and quick open), or connect without saving: type
`user@host`, `ssh -p 2222 host` or `telnet 10.0.0.1 2323` in quick open, or use Ctrl+Shift+N. Shellman runs
Windows' own clients (OpenSSH's `ssh.exe` and the Telnet Client), so your keys, the Windows ssh-agent or
1Password's SSH agent, `~/.ssh/config` and `known_hosts` work as in any terminal, and Windows Update keeps the
clients patched. Shellman never stores passwords or private keys.

- **Keys.** No agent is needed: without one, ssh uses your key files in `~/.ssh` (or a key file you choose). With
  many keys in an agent (1Password or the Windows ssh-agent), pick the session's key under **Log in with**
  (1Password shows its item names): servers stop after about 6 offered keys ("Too many authentication
  failures"), so Shellman then offers only that key (`-i <its public key> -o IdentitiesOnly=yes`) and the agent
  still does the signing.
- **Passwords.** "Log in with: Password" offers no keys at all, and ssh asks for the password in the terminal (it
  isn't stored). Without a user name, the terminal asks `login as:` first (Enter keeps ssh's default user).
- **Old servers** that only offer ssh-rsa (SHA-1), DSA or CBC ciphers ("Unable to negotiate") can be allowed per
  session (SSH options → Allow old algorithms), or by pressing A when a connection fails that way.
- **Keepalives.** New SSH sessions send keepalives (`-o ServerAliveInterval=30` in SSH options, which you can
  remove), so routers and VPNs don't drop idle connections ("Connection reset").
- **Reconnecting.** Enter reconnects a closed connection, Duplicate opens another connection to the same host,
  and new tabs or splits next to it are local shells. Reopened connection tabs wait for Enter instead of logging
  in to every host at start-up (Settings → Connections can change that).
- **Telnet** needs the optional Windows feature "Telnet Client".
- **Import sessions.** Right-click the sidebar (or a group) → Import sessions, or use quick open. Choose the
  program (XShell for now), tick the sessions you want, and import them into a new group or one you already
  have. For XShell it reads the `.xsh` files in `Documents\NetSarang Computer\<version>\Xshell\Sessions` (or a
  folder you choose) and imports the SSH and Telnet hosts, ports and users. XShell's folders become subgroups
  (Prod › Web › web1), or go in front of the names ("Prod / Web / web1") if you choose so. Hosts that are
  already saved are skipped; saved passwords and XShell's own keys are not imported.

</details>

<details>
<summary><b>API requests and git sync</b></summary>

A group can be linked to a folder of request files (Edit group → Requests folder, or right-click → Link a
requests folder): often a git repository your team clones. Its requests show in the group; a click opens one in a
preview tab, a double-click keeps it, and a request sits in tabs and splits like a terminal (handy next to a
terminal tailing the server's log). Drag a request or folder onto another folder to move it. Send with
Ctrl+Enter, save with Ctrl+S.

- **Editing.** The JSON body editor colours keys, values and `{{variables}}` as you type, indents on Enter and
  closes brackets and quotes.
- **Sending.** Requests run through Windows' own `curl.exe`; the response shows as folding JSON with search,
  headers, timing and cookies, and a Console tab with the exact curl command, the options it read and curl's own
  log (secrets hidden). Login cookies are kept per group and environment until Shellman closes.
- **Variables** are `{{name}}` (a value may use other variables) and look the same in the URL, headers, params,
  auth and body: coloured by whether they are defined, with their value on hover and Ctrl+click to edit them.
  The URL shows filled in under it, and the body's Preview button does the same for the body. They are edited in
  the app (Variables, or click one in the URL line or the list under each section): shared values in `.env` and
  `environments/<env>.json` (pick the environment next to Send or on the group; one marked `"protected": true`
  asks before anything but GET).
- **Choices.** A variable can have several values to switch between (a tenant, a test user, an API version),
  each with a short note on when to use it; the note is only shown, never sent. Switch from the environment
  menu next to Send, with Ctrl+click on the variable, or from the list under each section. The choices are
  shared with the team; which one you use is your own and never changes the shared files (in `.env` they are
  `# @choice value -- note` lines above the variable, so other tools read the first one as its value).
- **Secrets.** Each variable applies to every environment or one, and is secret or not: normal values are shared
  through git (`.env`, `environments/<env>.json`), secret ones stay on your computer in `.env.local` /
  `.env.<env>.local`, which git must ignore (Shellman checks and offers to add them to `.gitignore`). A value can
  also be a 1Password reference like `op://Vault/Item/field`, which is safe to commit: 1Password's CLI fills it in
  when sending. Secret values never go into a command line or the request text: curl reads them from its
  environment.
- **curl and Postman.** Copy as curl (PowerShell 7, cmd or bash), Paste curl command (e.g. a browser's "Copy as
  cURL"), and Import from Postman (collection v2.0/2.1, environment and globals exports; globals go to `.env`,
  and secrets to `.env.local`, not the shared files). Settings → Requests has the options.
- **Git sync.** Per group (Edit group → Git sync): off, with the Sync button, or automatically. Sync commits only
  Shellman's files in the folder (requests, environments, `.env` and `.gitignore`; never the secret `.env*.local`
  ones, nor anything else in the folder or repository), pulls teammates' changes and pushes. Automatically, saves
  made within a minute (adjustable) go up together as one commit, and teammates' changes are pulled every few
  minutes while Shellman is in front (never in the background, so no sign-in or 1Password prompt pops up out of
  nowhere). The badge on the group shows what's waiting (●2 changes, ↑1 to push, ↓3 to pull) and syncs on
  click. Git runs as you (your credential manager and keys); if it needs a sign-in, Shellman says so and stops
  trying until you sync. Automatic sync pauses instead of pushing your other unpushed commits in the same
  repository or setting your other changes aside, and Sync asks first. When a teammate changed the same request,
  you choose to keep yours or take theirs. Sync stays on the branch it started on. Meant for a repository (or
  branch) of requests that takes pushes without pull requests and runs no CI; for request folders inside a code
  repository, use the Sync button.

</details>

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Quick open saved session (or type `user@host` to connect) | Ctrl+Shift+P |
| New SSH or Telnet connection | Ctrl+Shift+N |
| New tab in current directory | Ctrl+Shift+T |
| Split right / down (current directory) | Ctrl+Shift+E / Ctrl+Shift+O |
| Duplicate pane (re-runs its command) | Ctrl+Shift+D |
| Close pane | Ctrl+Shift+W |
| Maximize / restore pane | Ctrl+Shift+Z |
| Move pane to a new tab | Ctrl+Shift+M |
| Equalize panes | Ctrl+Shift+Q |
| Move focus | Alt+←↑→↓ |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Go to tab 1–9 | Alt+1…9 |
| Find | Ctrl+Shift+F |
| Show the files and changes of the current folder | Ctrl+Shift+G |
| Save pane as session | Ctrl+Shift+S |
| Rename tab | Ctrl+Shift+R (or double-click the tab) |
| Toggle sidebar | Ctrl+Shift+B |
| Settings | Ctrl+, |
| Copy / paste | Ctrl+C (with selection) / Ctrl+V, or Ctrl+Shift+C / Ctrl+Shift+V |

No shortcut uses Ctrl+Alt, because that's AltGr on Nordic and other European layouts (AltGr+2 = @).

<details>
<summary>Mouse, request panes and the Files pane</summary>

| Action | Keys |
|---|---|
| Paste with the mouse | Right-click (Settings can switch it to "copy selection, otherwise paste" or "show menu"). Programs that use the mouse, like Claude Code, get the right-click themselves (Claude Code pastes on its own) |
| Terminal menu (split, save as session, find…) | Shift+Right-click |
| Select text in Claude Code | Shift+drag |
| Send / save a request (in a request pane) | Ctrl+Enter / Ctrl+S |
| Open a request in a split | Middle-click it in the sidebar |
| Move a request or folder | Drag it onto another folder in the sidebar |
| Next / previous change (in a Files pane) | F7 / Shift+F7 |
| Open a file path printed in a terminal (in the Files pane, at its line) | Ctrl+Click |
| Go to file (`@` for symbols) / find in the file (in a Files pane) | Ctrl+P / Ctrl+F |
| Search in all the files (in a Files pane) | Ctrl+Shift+F |
| Go to definition / references / implementations (in a Files pane) | F12 or Ctrl+click / Shift+F12 / Ctrl+F12 |

</details>

## Building from source

Shellman is Rust ([Tauri 2](https://tauri.app) + [portable-pty](https://crates.io/crates/portable-pty) over
Windows ConPTY) and TypeScript with [xterm.js](https://xtermjs.org). With Rust (MSVC), the VS C++ Build Tools and
Node 20+:

```powershell
npm install
npm run app:dev
```

Tests, the end-to-end suite, releases and a map of the code are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Not done yet

- Terminal contents (scrollback) aren't restored after a restart; tabs, splits and folders are.
- Shortcuts aren't configurable yet (see `src/keys.ts`).
- Windows only.
