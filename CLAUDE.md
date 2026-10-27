# Shellman: notes for Claude

Shellman is a Windows-only terminal manager (Tauri 2 + Rust backend, TypeScript + xterm.js frontend, no UI
framework). Saved sessions are local folders (with a startup command and shell) or SSH/Telnet hosts. The
repository is public (MIT), and every release auto-updates everyone's installed copy.

## Commands

```powershell
npm install
npm run build          # tsc type check + vite build
npm test               # vitest (pure frontend logic)
npm run test:rust      # Rust unit tests + real ConPTY / ssh.exe integration tests
npm run app:dev        # run with hot reload
npx tauri build --no-bundle   # release exe for e2e (no installer, no signing)
npm run e2e            # drives the release exe over CDP; needs a desktop and the claude CLI
```

Run `npm run build`, `npm test` and `npm run test:rust` before committing; run e2e for UI or behaviour changes.

**e2e next to a running Shellman.** The user usually runs Shellman from `src-tauri\target\release\shellman.exe`
(this Claude session may be running inside it), so that file is locked. Never kill a running Shellman. Build
into another target dir and point the tests at it:

```bash
export CARGO_TARGET_DIR="$LOCALAPPDATA/Temp/shellman-e2e-target"
npx tauri build --no-bundle
SHELLMAN_EXE="$CARGO_TARGET_DIR/release/shellman.exe" npm run e2e
```

e2e uses a throwaway profile (`SHELLMAN_CONFIG_DIR`) and its own WebView2 profile. Set
`SSH_AUTH_SOCK=\\.\pipe\shellman-e2e-no-agent` to test a machine without an SSH agent. The WSL Claude step needs a
folder Claude inside WSL already trusts: `SHELLMAN_E2E_WSL_CLAUDE_DIR=\\wsl.localhost\<distro>\<folder>` (else it
is skipped). Unset this session's `CLAUDE_CODE_*` / `CLAUDECODE` variables first: they stop the Claude that e2e
starts from writing its session files. SSH tests only use
127.0.0.1 (a closed port, or a small fake server in `e2e/run.mjs`).

## Layout

| Path | What |
|---|---|
| `src-tauri/src/pty.rs` | ConPTY sessions (reader/writer/waiter threads), spawn of shells and connections |
| `src-tauri/src/shell.rs` | Shell detection and launch arguments (startup commands, shell integration) |
| `src-tauri/src/connect.rs` | SSH/Telnet: finds ssh.exe/telnet.exe, builds and checks their arguments, agent keys |
| `src-tauri/src/config.rs`, `lib.rs` | Atomic config files, Tauri commands |
| `src/main.ts` | App shell: status bar, menus, dialogs wiring, shortcuts, restore |
| `src/workspace.ts`, `pane.ts`, `layout.ts` | Tabs and splits, one terminal (xterm), pure split-tree ops |
| `src/sidebar.ts`, `sessionEditor.ts`, `settingsDialog.ts`, `palette.ts` | UI |
| `src/config.ts`, `connection.ts`, `snapshot.ts`, `claude.ts` | Pure logic with unit tests |
| `docs/` | The shellman.app website (GitHub Pages, served from `main:/docs`) |

## Rules

- **Never splice user input into a command line.** Startup commands reach shells through `-EncodedCommand` or an
  environment variable (`shell.rs`). SSH/Telnet arguments are a list; host, user and jump host must not start
  with `-`, and the ssh destination follows `--`. New ssh options go into `connect.rs` (with tests) and the
  matching "copy command" in `connection.ts`.
- **Shellman never stores passwords or private keys.** SSH runs Windows' own OpenSSH so keys, the Windows
  ssh-agent, 1Password's agent and `~/.ssh/config` work unchanged. Only a chosen agent key's public half is
  written (to `<config dir>\ssh-keys`).
- **Config and workspace files must stay loadable.** New fields get defaults in `normalizeConfig` /
  `normalizeSnapshot` / `normalizeConnection`, old files keep working, and the config version stays 1 for
  additive changes. Cover it in `config.test.ts` / `snapshot.test.ts`.
- **Shortcuts** live in `src/keys.ts`. Never use Ctrl+Alt (it is AltGr on Nordic and other layouts).
- Match the surrounding code: small functions, comments that explain why, plain and short UI text.

## Privacy (public repo)

Never commit personal data: real host names, IP addresses, ports, user names, SSH key or 1Password item names,
XShell session names, or paths from the developer's machine. Use `example.com`, `203.0.113.x`, `198.51.100.x`,
`192.0.2.x`, `10.0.0.x` and paths like `C:\Projects\…` or `C:\Users\me`. Screenshots for `docs/img` must come
from a throwaway `SHELLMAN_CONFIG_DIR` with made-up sessions and `SSH_AUTH_SOCK` pointing at an unused pipe
(otherwise real agent keys appear in the SSH dialog). Scan the diff for such data before every commit.

## Releases and the website

- Releases are built and published only by GitHub Actions (`npm run release -- X.Y.Z` just starts the workflow).
  Never publish from a local machine, never commit the updater signing key, and don't release for docs-only
  changes: every release reaches all installs automatically.
- `main` can't be force-pushed; pull requests need green CI; `v*` tags can't be moved.
- When a user-visible feature changes, update `README.md` (features, shortcuts) and `docs/index.html`
  (feature cards, FAQ and its JSON-LD copy, shortcuts). `docs/img/og.png` has its tagline baked into the image.
