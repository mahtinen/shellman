# Working on Shellman

## Development

Requirements: Rust (stable, MSVC toolchain), the VS C++ Build Tools with a Windows SDK, and Node 20+.

```powershell
npm install
npm run app:dev        # run with hot reload
npm run app:build      # signed release exe + NSIS installer + latest.json
npm run release -- 0.2.0 --notes "What changed"   # start the Release workflow on GitHub
npm test               # frontend unit tests (vitest)
npm run test:rust      # Rust unit + real ConPTY integration tests
npm run e2e            # drives the release build through WebView2 DevTools (see e2e/)
```

If you build the installer yourself, it is in `src-tauri\target\release\bundle\nsis\`.

`npm run e2e` runs the app with a throwaway profile (`SHELLMAN_CONFIG_DIR` in Temp; set `SHELLMAN_EXE` to test a
build from another target directory, e.g. while `target\release\shellman.exe` is open), so it can run while you
use Shellman; your settings, open tabs and window position aren't touched. Its window may take keyboard focus
when it starts, so don't type into it. Local and test builds never update themselves in the background; only
builds from the Release workflow do.

## Releasing

Releases are built and published by GitHub Actions, never from a developer's machine:

1. Push to `main` (or merge a pull request). The **CI** workflow type-checks, builds the frontend and runs the
   unit and Rust tests. Run `npm run e2e` locally too; it needs a real desktop and the `claude` CLI, so it
   can't run in CI.
2. Start a release from **Actions → Release → Run workflow** and enter the version (e.g. `0.2.0`). From a
   terminal, `npm run release -- 0.2.0 [--notes "What changed"]` does the same, and pushing a tag `v0.2.0`
   works too.
3. The **Release** workflow checks that the version is newer than the latest release and that CI passed for
   that commit. It stamps the version into the build, signs the installer for the updater, and publishes
   release `v0.2.0` with the installer, its `.sig`, `latest.json` and `Shellman-setup.exe`. Without notes,
   GitHub lists the changes since the last release.

Installed copies poll `releases/latest/download/latest.json`, so publishing the release is all it takes.
The version in the repository files isn't bumped; the release tag decides the version.

**Signing key.** The updater key lives in the `TAURI_SIGNING_PRIVATE_KEY` secret of the `release`
environment (Settings → Environments). Its public half is in `src-tauri/tauri.conf.json`. Keep an offline
backup: if it's lost, installed copies can't verify new versions and everyone has to reinstall by hand.
`npm run app:build` can still make a signed build locally from `%USERPROFILE%\.tauri\shellman.key`.

**Branch protection.** `main` can't be force-pushed or deleted, and pull requests need a passing CI run
(admins can push directly). Release tags `v*` can't be moved or deleted.

## Layout

| Path | What |
|---|---|
| `src-tauri/src/pty.rs` | ConPTY sessions: reader/writer/waiter threads, UTF-8 streaming, child-process detection |
| `src-tauri/src/shell.rs` | Shell detection and launch arguments (startup commands, shell integration) |
| `src-tauri/src/connect.rs` | SSH/Telnet: finds `ssh.exe`/`telnet.exe` and builds their arguments (checked against option injection) |
| `src-tauri/src/config.rs` | Atomic config persistence with backup and corrupt-file quarantine |
| `src-tauri/src/http.rs`, `collection.rs`, `git.rs` | Requests through curl (options as a config on stdin, secrets as curl variables), linked folders, git |
| `src/workspace.ts` | Tabs, split layout rendering, focus, activity tracking, GPU budget |
| `src/pane.ts` | One terminal: xterm.js, input/clipboard handling, OSC parsing, search |
| `src/layout.ts` | Pure split-tree operations (unit tested) |
| `src/connection.ts` | Connection validation, labels and quick-open parsing (unit tested) |
| `src/requestPane.ts`, `codeEditor.ts`, `varField.ts`, `collections.ts`, `requestActions.ts` | Request panes, the body editor, `{{variables}}` in fields, linked folders, request menus |
| `src/filesPane.ts`, `lineView.ts`, `src-tauri/src/files.rs` | The Files pane: folder tree, read-only file and diff views (only the visible lines are drawn), reading files inside the folder only |
| `src/diff.ts`, `syntax.ts`, `navigate.ts` | Diff layout from git's hunks (inline, side by side, folding, changed words), syntax colours, and finding declarations for code navigation (unit tested) |
| `src/markdown.ts`, `markdownView.ts` | Markdown preview: the parser (unit tested), and drawing it element by element with an allowlist for HTML |
| `src/worktrees.ts`, `worktreeDialog.ts`, `src-tauri/src/worktree.rs` | Git worktrees for sessions: names and folders (unit tested), the new and remove dialogs, git worktree add/list/remove |
| `src/filesSearch.ts` | The Files pane's Search view (`git grep`) and its lists of definitions and references |
| `src/requestFile.ts`, `variables.ts`, `dotenv.ts`, `curl.ts`, `postman.ts`, `jsonView.ts`, `codeEdit.ts` | Request files, variables, curl copy/paste, Postman import, JSON colours and editing keys (unit tested) |
| `src/sidebar.ts`, `sessionEditor.ts`, `settingsDialog.ts`, `palette.ts` | UI |
| `src/updater.ts` | Background update checks, download and install-on-restart |
| `.github/workflows/` | CI checks and the Release workflow |
| `scripts/build.mjs`, `set-version.mjs`, `release.mjs` | Signed build + `latest.json`, version stamping, starting a release |
| `docs/` | The [shellman.app](https://shellman.app) website (GitHub Pages) |

Startup commands are never spliced into a command line. PowerShell gets them as `-EncodedCommand`, and
cmd/bash/WSL read them from an environment variable. That way quotes, `&`, `$` and non-ASCII paths
behave exactly as typed.
