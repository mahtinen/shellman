// End-to-end test of the real Shellman app through CDP. Run it via `npm run e2e`
// (all.mjs), which protects your real configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, HELPERS, launch, portFree } from './cdp.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
// all.mjs points the app at a throwaway profile; never run against the real one.
if (!process.env.SHELLMAN_CONFIG_DIR) {
  console.error('Run the e2e tests with `npm run e2e` (it sets up a separate profile).');
  process.exit(2);
}
const CONFIG = path.join(process.env.SHELLMAN_CONFIG_DIR, 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The repository checkout and its parent are used as real directories to open terminals in.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARENT = path.dirname(REPO);
const js = JSON.stringify;
const prompt = (dir) => js(`PS ${dir}>`);

let passed = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const phase = process.argv[2] ?? 'main';
const child = await launch();
const c = await connect();
await c.waitFor('!!window.__shellman', 15000, 'app booted');
await c.ev(HELPERS);
const { ev, waitFor, shot, key, type, click } = c;

if (phase === 'main') {
  await step('welcome screen shown with no tabs', async () => {
    assert(await ev(`!document.querySelector('.welcome').hidden`), 'welcome hidden');
    assert((await ev(`__t.ws.tabs.length`)) === 0, 'tabs exist');
    assert(await ev(`!!document.querySelector('.sidebar-empty')`), 'no empty sidebar state');
  });
  await shot(path.join(OUT, '01-welcome.png'));

  await step('create session through the dialog (Save & open)', async () => {
    await click('.sidebar-header .icon-btn[title="New session"]');
    await waitFor(`!!document.querySelector('.dialog')`);
    await ev(`(() => {
      const inputs = document.querySelectorAll('.dialog input.input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); };
      set(inputs[0], 'Shellman repo');
      set(inputs[1], ${js(REPO)});
      set(inputs[2], "Write-Output ('startup-' + 'ok')");
      return true;
    })()`);
    await shot(path.join(OUT, '02-session-dialog.png'));
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Save & open').click()`);
    await waitFor(`!document.querySelector('.dialog') && __t.ws.tabs.length === 1`, 5000, 'dialog closed + tab opened');
    assert((await ev(`document.querySelectorAll('.session-row').length`)) === 1, 'sidebar row missing');
  });

  await step('startup command runs in the session directory', async () => {
    await waitFor(`__t.text().includes('startup-ok')`, 15000, 'startup-ok output');
    await waitFor(`__t.text().includes(${prompt(REPO)})`, 10000, 'PowerShell prompt in the repo directory');
    assert((await ev(`__t.active().state`)) === 'running', 'pane not running');
    assert((await ev(`document.querySelector('.tab.active .tab-label').textContent`)) === 'Shellman repo', 'tab label');
  });

  await step('typing through real key events reaches the shell', async () => {
    await ev(`__t.active().focus()`);
    await type('echo "typed-$((6*7))"');
    await key('Enter', 'Enter', 13);
    await waitFor(`__t.text().includes('typed-42')`, 8000, 'typed-42');
  });

  await step('shell integration tracks cd (OSC 9;9)', async () => {
    await type('cd ..');
    await key('Enter', 'Enter', 13);
    await waitFor(`__t.active().cwd === ${js(PARENT)}`, 8000, 'cwd = parent directory');
    assert((await ev(`document.querySelector('.status-link').textContent`)) === PARENT, 'status bar cwd');
  });

  await step('Ctrl+Shift+T opens a new tab in the current directory', async () => {
    await key('KeyT', 'T', 84, ['ctrl', 'shift']);
    await waitFor(`__t.ws.tabs.length === 2`, 5000, '2 tabs');
    await waitFor(`__t.text().includes(${prompt(PARENT)})`, 10000, 'prompt in the parent directory');
    assert((await ev(`__t.active().spec.command`)) === '', 'new tab should not re-run command');
  });

  await step('Ctrl+Shift+E / Ctrl+Shift+O split right and down', async () => {
    await key('KeyE', 'E', 69, ['ctrl', 'shift']);
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab).length === 2`, 5000);
    await key('KeyO', 'O', 79, ['ctrl', 'shift']);
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab).length === 3`, 5000);
    assert(await ev(`__t.ws.activeTab.el.classList.contains('multi')`), 'multi class');
    assert((await ev(`__t.ws.activeTab.el.querySelectorAll('.divider').length`)) === 2, 'two dividers');
    await waitFor(`__t.panes().every(p => p.state === 'running')`, 10000, 'all running');
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab).every(p => __t.text(p).includes(${prompt(PARENT)}))`, 10000, 'all prompts in the parent directory');
  });
  await sleep(300);
  await shot(path.join(OUT, '03-splits.png'));

  await step('Alt+arrows move focus between panes', async () => {
    const ids = await ev(`__t.ws.panesOf(__t.ws.activeTab).map(p => p.id)`);
    // layout: row[ a, column[ b, c ] ], active = c
    assert((await ev(`__t.active().id`)) === ids[2], 'c active');
    await key('ArrowUp', 'ArrowUp', 38, ['alt']);
    await waitFor(`__t.active().id === ${JSON.stringify(ids[1])}`, 2000, 'b active after Alt+Up');
    await key('ArrowLeft', 'ArrowLeft', 37, ['alt']);
    await waitFor(`__t.active().id === ${JSON.stringify(ids[0])}`, 2000, 'a active after Alt+Left');
    await key('ArrowRight', 'ArrowRight', 39, ['alt']);
    await waitFor(`__t.active().id !== ${JSON.stringify(ids[0])}`, 2000, 'moved right');
  });

  await step('zoom toggles a single pane', async () => {
    await key('KeyZ', 'Z', 90, ['ctrl', 'shift']);
    await waitFor(`__t.ws.activeTab.el.querySelectorAll('.pane').length === 1`, 2000, 'one pane visible');
    await key('KeyZ', 'Z', 90, ['ctrl', 'shift']);
    await waitFor(`__t.ws.activeTab.el.querySelectorAll('.pane').length === 3`, 2000, 'three panes visible');
  });

  await step('resizing a divider changes pane sizes and terminal columns', async () => {
    const before = await ev(`__t.ws.panesOf(__t.ws.activeTab)[0].term.cols`);
    const box = await ev(`(() => { const r = __t.ws.activeTab.el.querySelector('.divider.row').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - i * 20, y: box.y, button: 'left' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x - 200, y: box.y, button: 'left', clickCount: 1 });
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab)[0].term.cols < ${before} - 10`, 3000, 'cols shrank');
  });

  await step('exit closes the pane gracefully', async () => {
    await ev(`__t.active().sendInput('exit\\r')`);
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab).length === 2`, 8000, 'pane closed after exit');
    assert((await ev(`__t.ws.activeTab.el.querySelectorAll('.divider').length`)) === 1, 'one divider');
  });

  await step('Ctrl+Shift+W closes the active pane', async () => {
    await key('KeyW', 'W', 87, ['ctrl', 'shift']);
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab).length === 1`, 5000, 'one pane');
    assert(!(await ev(`__t.ws.activeTab.el.classList.contains('multi')`)), 'not multi');
  });

  await step('Shift+Enter sends ESC CR (newline for Claude Code)', async () => {
    await ev(`(() => { const p = __t.active(); window.__sent = []; const orig = p.sendInput.bind(p); p.sendInput = (d) => { window.__sent.push(d); orig(d); }; return true; })()`);
    await key('Enter', 'Enter', 13, ['shift']);
    await waitFor(`window.__sent.includes('\\x1b\\r')`, 2000, 'ESC CR sent');
  });

  await step('Ctrl+C with a selection copies instead of interrupting', async () => {
    await ev(`(() => { const p = __t.active(); p.term.selectAll(); return true; })()`);
    await ev(`window.__sent = []`);
    await key('KeyC', 'c', 67, ['ctrl']);
    await sleep(200);
    assert(!(await ev(`window.__sent.includes('\\x03')`)), 'Ctrl+C was sent to the shell');
    assert(!(await ev(`__t.active().term.hasSelection()`)), 'selection not cleared');
    await key('KeyC', 'c', 67, ['ctrl']);
    await waitFor(`window.__sent.includes('\\x03')`, 2000, 'Ctrl+C without selection reaches shell');
  });

  await step('right-click pastes; Shift+right-click opens the menu', async () => {
    const saved = await ev(`window.__TAURI_INTERNALS__.invoke('clipboard_read')`);
    try {
      await ev(`window.__TAURI_INTERNALS__.invoke('clipboard_write', { text: 'echo right-click-paste' })`);
      await ev(`(() => { window.__sent = []; __t.active().term.clearSelection(); return true; })()`);
      const box = await ev(`(() => { const r = __t.active().el.querySelector('.pane-term').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      const rightClick = async (modifiers) => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', buttons: 2, clickCount: 1, modifiers });
        }
      };
      await rightClick(0);
      await waitFor(`window.__sent.join('').includes('echo right-click-paste')`, 3000, 'pasted text sent to shell');
      assert(!(await ev(`!!document.querySelector('.menu')`)), 'menu opened on plain right-click');
      await rightClick(8);
      await waitFor(`!!document.querySelector('.menu')`, 2000, 'menu on Shift+right-click');
      await key('Escape', 'Escape', 27);
      await waitFor(`!document.querySelector('.menu')`, 2000, 'menu closed');
      // Clear the pasted text from the prompt.
      await ev(`__t.active().sendInput('\\x03')`);
      await sleep(300);
    } finally {
      await ev(`window.__TAURI_INTERNALS__.invoke('clipboard_write', { text: ${js(saved ?? '')} })`).catch(() => undefined);
    }
  });

  await step('AltGr characters (Ctrl+Alt) are typed, not treated as shortcuts', async () => {
    await ev(`window.__sent = []`);
    // On Nordic layouts AltGr+2 is @. The browser reports it as Ctrl+Alt with key '@'.
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 3, code: 'Digit2', key: '@', text: '@', unmodifiedText: '2', windowsVirtualKeyCode: 50 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 3, code: 'Digit2', key: '@', windowsVirtualKeyCode: 50 });
    await sleep(200);
    assert((await ev(`__t.ws.tabs.findIndex(t => t.id === __t.ws.activeTabId)`)) === 1, 'tab changed');
    assert(await ev(`window.__sent.join('').includes('@')`), 'AltGr+2 did not type @: ' + JSON.stringify(await ev('window.__sent')));
  });

  await step('tabs: Ctrl+Tab cycles, Alt+1 jumps', async () => {
    await key('Digit1', '1', 49, ['alt']);
    await waitFor(`__t.ws.tabs[0].id === __t.ws.activeTabId`, 2000, 'tab 1 active');
    await key('Tab', 'Tab', 9, ['ctrl']);
    await waitFor(`__t.ws.tabs[1].id === __t.ws.activeTabId`, 2000, 'tab 2 active');
  });

  await step('background tab activity indicator', async () => {
    await key('Digit1', '1', 49, ['alt']);
    await waitFor(`__t.ws.tabs[0].id === __t.ws.activeTabId`, 2000);
    await ev(`__t.ws.panesOf(__t.ws.tabs[1])[0].sendInput('\x03')`);
    await sleep(500);
    await ev(`__t.ws.panesOf(__t.ws.tabs[1])[0].sendInput('1..40 | % { Start-Sleep -Milliseconds 50; $_ }\\r')`);
    await waitFor(`['busy','unread'].includes(__t.ws.tabs[1].tabEl.querySelector('.tab-status').dataset.state)`, 5000, 'busy/unread state');
    await shot(path.join(OUT, '04-activity.png'));
  });

  await step('quick open palette launches a saved session', async () => {
    await key('KeyP', 'P', 80, ['ctrl', 'shift']);
    await waitFor(`!!document.querySelector('.palette')`, 2000);
    await type('shellman');
    await sleep(100);
    await shot(path.join(OUT, '05-palette.png'));
    await key('Enter', 'Enter', 13);
    await waitFor(`__t.ws.tabs.length === 3 && !document.querySelector('.palette')`, 3000, '3 tabs');
    await waitFor(`__t.text().includes('startup-ok')`, 15000);
    // The tree under the session lists both terminals opened from it (plus ad-hoc ones in its directory).
    await waitFor(`(() => {
      const rows = [...(document.querySelector('.session-row + .term-tree')?.querySelectorAll('.term-row') ?? [])].map((r) => r.dataset.pane);
      const fromSession = __t.panes().filter((p) => p.spec.sessionId).map((p) => p.id);
      return fromSession.length === 2 && fromSession.every((id) => rows.includes(id))
        && document.querySelector('.session-row .badge')?.textContent === String(rows.length);
    })()`, 3000, 'session terminal tree');
  });

  await step('claude CLI runs inside a session', async () => {
    await ev(`void __t.ws.open({ name: 'claude version', cwd: ${js(REPO)}, command: 'claude --version', shellId: '', env: {}, color: '#bb9af7', sessionId: null }, 'right')`);
    await waitFor(`/\\d+\\.\\d+\\.\\d+.*Claude Code/.test(__t.text())`, 30000, 'claude --version output');
  });

  await step('interactive claude TUI renders', async () => {
    await ev(`void __t.ws.open({ name: 'claude', cwd: ${js(REPO)}, command: 'claude', shellId: '', env: {}, color: '#7aa2f7', sessionId: null }, 'tab')`);
    await waitFor(`/Claude Code|trust|Welcome|╭/.test(__t.text())`, 40000, 'claude UI');
    await sleep(3000);
    await shot(path.join(OUT, '06-claude.png'));
    const rgb = await ev(`(() => {
      const b = __t.active().term.buffer.active, cell = b.getNullCell(); let n = 0;
      for (let y = 0; y < b.length; y++) { const l = b.getLine(y); for (let x = 0; l && x < l.length; x++) { l.getCell(x, cell); if (cell.isFgRGB()) n++; } }
      return n;
    })()`);
    assert(rgb > 0, 'claude output has no 24-bit colour');
  });

  await step('Shift+Enter inserts a newline in the Claude prompt instead of submitting', async () => {
    await ev(`__t.active().focus()`);
    await type('first-line-xyz');
    await key('Enter', 'Enter', 13, ['shift']);
    await type('second-line-xyz');
    await sleep(1500);
    const lines = await ev(`__t.text().split('\\n')`);
    const a = lines.findIndex((l) => l.includes('first-line-xyz'));
    const b = lines.findIndex((l) => l.includes('second-line-xyz'));
    assert(a >= 0 && b === a + 1, `expected two consecutive input lines, got ${a}, ${b}`);
    await shot(path.join(OUT, '06b-claude-multiline.png'));
    // Clear the prompt without sending anything.
    await key('KeyC', 'c', 67, ['ctrl']);
    await sleep(300);
  });

  await step('closing a pane with a running program asks for confirmation', async () => {
    await ev(`void __t.ws.requestClosePane(__t.active().id)`);
    await waitFor(`!!document.querySelector('.dialog')`, 5000, 'confirm dialog');
    const text = await ev(`document.querySelector('.dialog').textContent`);
    assert(/still running/.test(text), 'unexpected dialog text: ' + text);
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Close').click()`);
    await waitFor(`!document.querySelector('.dialog') && __t.ws.tabs.length === 3`, 5000, 'tab closed');
  });

  await step('a missing directory shows an error and Enter retries', async () => {
    await ev(`void __t.ws.open({ name: 'gone', cwd: 'C:\\\\does\\\\not\\\\exist', command: '', shellId: '', env: {}, color: '', sessionId: null }, 'tab')`);
    await waitFor(`__t.text().includes('Directory not found') && __t.active().state === 'error'`, 5000, 'error shown');
    await ev(`__t.active().sendInput('\\r')`);
    await waitFor(`(__t.text().match(/Directory not found/g) || []).length === 2`, 5000, 'retried');
    await ev(`__t.ws.closePane(__t.active().id)`);
  });

  await step('settings dialog saves and applies font size', async () => {
    await key('Comma', ',', 188, ['ctrl']);
    await waitFor(`!!document.querySelector('.settings-dialog')`, 2000);
    await shot(path.join(OUT, '07-settings.png'));
    await ev(`(() => { const i = document.querySelector('.settings-dialog input[type=number]'); i.value = '16'; return true; })()`);
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Save').click()`);
    await waitFor(`__t.active().term.options.fontSize === 16`, 3000, 'font applied');
  });

  await step('settings "Check now" reports an update result', async () => {
    await key('Comma', ',', 188, ['ctrl']);
    await waitFor(`!!document.querySelector('.settings-dialog .update-status')`, 2000, 'updates section');
    await ev(`[...document.querySelectorAll('.settings-dialog .btn')].find(b => b.textContent === 'Check now').click(), true`);
    // Whatever GitHub answers (latest, newer, or no release yet), the check must finish with a message.
    await waitFor(`!/Checking/.test(document.querySelector('.update-status').textContent) && !document.querySelector('.settings-dialog .update-row .btn').disabled`, 40000, 'check finished');
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Cancel').click(), true`);
    await waitFor(`!document.querySelector('.dialog')`, 2000, 'settings closed');
  });

  await step('config is persisted to disk', async () => {
    await sleep(800);
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    assert(cfg.sessions.length === 1 && cfg.sessions[0].name === 'Shellman repo', 'session not saved');
    assert(cfg.settings.fontSize === 16, 'font size not saved');
  });

  await step('create a group and move the session into it via the context menu', async () => {
    await click('.sidebar-header .icon-btn[title="New group"]');
    await waitFor(`!!document.querySelector('.dialog input')`, 3000);
    await ev(`(() => { const i = document.querySelector('.dialog input'); i.value = 'Work'; return true; })()`);
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'OK').click()`);
    await waitFor(`document.querySelectorAll('.group-row').length === 1`, 3000, 'group row');
    await ev(`document.querySelector('.session-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
    await waitFor(`!!document.querySelector('.menu')`, 2000, 'menu');
    await shot(path.join(OUT, '07b-session-menu.png'));
    await ev(`[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('Move to group')).click()`);
    await waitFor(`document.querySelectorAll('.menu').length === 2`, 2000, 'submenu');
    await ev(`[...document.querySelectorAll('.menu')[1].querySelectorAll('.menu-item')].find(m => m.textContent.includes('Work')).click()`);
    await waitFor(`!!document.querySelector('.group-body .session-row')`, 3000, 'session inside group');
    await sleep(600);
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    assert(cfg.groups[0].name === 'Work' && cfg.sessions[0].groupId === cfg.groups[0].id, 'group not saved');
  });

  await step('sidebar tree: clicking a terminal focuses its tab', async () => {
    const target = await ev(`__t.panes().find((p) => __t.ws.tabOf(p).id !== __t.ws.activeTabId && document.querySelector('.term-row[data-pane="' + p.id + '"]'))?.id`);
    assert(target, 'no background terminal in the tree');
    await click(`.term-row[data-pane="${target}"]`);
    await waitFor(`__t.active()?.id === ${js(target)}`, 3000, 'pane focused');
    await waitFor(`document.querySelector('.term-row.active')?.dataset.pane === ${js(target)}`, 3000, 'row highlighted');
  });

  await step('the session chevron collapses and expands its terminals (saved)', async () => {
    await click('.session-row .session-chevron[title]');
    await waitFor(`!document.querySelector('.session-row + .term-tree') && !!document.querySelector('.session-row .badge.folded')`, 3000, 'collapsed');
    await sleep(800);
    assert(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).sessions[0].collapsed === true, 'collapsed state not saved');
    await click('.session-row .session-chevron[title]');
    await waitFor(`!!document.querySelector('.session-row + .term-tree')`, 3000, 'expanded');
  });

  await step('session "Open with shell" starts another shell in its directory', async () => {
    const before = await ev(`__t.panes().length`);
    await ev(`document.querySelector('.session-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
    await waitFor(`!!document.querySelector('.menu')`, 2000, 'menu');
    await ev(`[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('Open with shell')).click()`);
    await waitFor(`document.querySelectorAll('.menu').length === 2`, 2000, 'submenu');
    await ev(`[...document.querySelectorAll('.menu')[1].querySelectorAll('.menu-item')].find(m => m.textContent.includes('Command Prompt')).click()`);
    await waitFor(`__t.panes().length === ${before + 1} && __t.active().spec.shellId === 'cmd' && !!__t.active().spec.sessionId`, 3000, 'cmd pane from session');
    await waitFor(`__t.text().includes(${js(REPO + '>')})`, 10000, 'cmd prompt in the session directory');
    await waitFor(`!!document.querySelector('.term-tree .term-row[data-pane="' + __t.active().id + '"]')`, 3000, 'listed in the tree');
  });

  await step('status bar switches the active terminal to another shell', async () => {
    const id = await ev(`__t.active().id`);
    await click('.status-shell');
    await waitFor(`!!document.querySelector('.menu')`, 2000, 'shell menu');
    await ev(`[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('Switch to Windows PowerShell')).click()`);
    await waitFor(`__t.active().id === ${js(id)} && __t.active().shell?.id === 'powershell' && __t.active().state === 'running'`, 5000, 'switched shell');
    await waitFor(`__t.text().includes(${prompt(REPO)})`, 15000, 'PowerShell prompt in the same directory');
  });

  await step('tabs use the same names as the sidebar tree', async () => {
    await waitFor(`__t.ws.tabs.every((t) => {
      const row = document.querySelector('.term-row[data-pane="' + t.activePaneId + '"] .term-label');
      return row && row.textContent === t.tabEl.querySelector('.tab-label').textContent;
    })`, 3000, 'tab and tree names differ: ' + JSON.stringify(await ev(`__t.ws.tabs.map((t) => [t.tabEl.querySelector('.tab-label').textContent, document.querySelector('.term-row[data-pane="' + t.activePaneId + '"] .term-label')?.textContent])`)));
  });

  await step('many tabs shrink and cut their names instead of overflowing', async () => {
    const before = await ev(`__t.ws.tabs.length`);
    await ev(`(() => { for (let i = 0; i < 10; i++) __t.ws.open({ name: 'A rather long terminal name number ' + i, cwd: 'C:\\\\', command: '', shellId: 'cmd', env: {}, color: '', sessionId: null }, 'tab'); return true; })()`);
    await waitFor(`__t.ws.tabs.length === ${before + 10}`, 5000, 'tabs opened');
    await sleep(300);
    await shot(path.join(OUT, '09-many-tabs.png'));
    const m = await ev(`(() => {
      const strip = document.querySelector('.tabs');
      const tabs = [...strip.querySelectorAll('.tab')];
      return {
        overflow: strip.scrollWidth - strip.clientWidth,
        widest: Math.max(...tabs.map((t) => t.offsetWidth)),
        cut: tabs.filter((t) => { const l = t.querySelector('.tab-label'); return l.scrollWidth > l.clientWidth; }).length,
        allAtMinimum: tabs.every((t) => t.offsetWidth <= parseFloat(getComputedStyle(t).minWidth) + 1),
      };
    })()`);
    // Tabs shrink first; the strip only scrolls once every tab is at its minimum width.
    assert(m.widest < 200 && m.cut >= 10 && (m.overflow <= 1 || m.allAtMinimum), 'tabs did not shrink: ' + JSON.stringify(m));
    await ev(`(() => { for (const t of __t.ws.tabs.slice(-10)) __t.ws.removeTab(t); return true; })()`);
    await waitFor(`__t.ws.tabs.length === ${before}`, 3000, 'extra tabs closed');
  });

  await step('new sessions default to the home directory', async () => {
    await click('.sidebar-header .icon-btn[title="New session"]');
    await waitFor(`!!document.querySelector('.dialog')`, 2000);
    const cwd = await ev(`document.querySelectorAll('.dialog input.input')[1].value`);
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Cancel').click()`);
    assert(cwd && cwd.toLowerCase() === process.env.USERPROFILE.toLowerCase(), `expected ${process.env.USERPROFILE}, got ${cwd}`);
  });

  await step('a terminal follows cd into a saved session directory', async () => {
    await ev(`void __t.ws.open({ name: 'root', cwd: 'C:\\\\', command: '', shellId: 'powershell', env: {}, color: '', sessionId: null }, 'tab')`);
    await waitFor(`__t.text().includes('PS C:\\\\>')`, 15000, 'prompt in C:\\');
    const id = await ev(`__t.active().id`);
    const ownerOfRow = `document.querySelector('.term-row[data-pane="${id}"]')?.closest('.term-tree')?.previousElementSibling`;
    await waitFor(`${ownerOfRow}?.classList.contains('terms-head')`, 3000, 'listed under Other terminals');
    await ev(`__t.active().sendInput(${js(`cd "${REPO}"\r`)})`);
    await waitFor(`__t.active().cwd === ${js(REPO)}`, 10000, 'cd tracked');
    await waitFor(`${ownerOfRow}?.querySelector('.session-name span')?.textContent === 'Shellman repo'`, 3000, 'moved under the session');
    assert((await ev(`__t.ws.activeTab.tabEl.querySelector('.tab-label').textContent`)) === 'Shellman repo', 'tab takes the session name');
  });

  await step('open terminals are saved for the next start', async () => {
    // A known layout: the session with a cmd split beside it (cmd focused), and a renamed PowerShell tab.
    await ev(`(() => { for (const t of [...__t.ws.tabs]) __t.ws.removeTab(t); return true; })()`);
    await click('.session-row');
    await waitFor(`__t.ws.tabs.length === 1 && __t.text().includes('startup-ok')`, 15000, 'session tab');
    await ev(`void __t.ws.open({ name: 'root', cwd: 'C:\\\\', command: '', shellId: 'cmd', env: {}, color: '', sessionId: null }, 'right', __t.active().id)`);
    await ev(`void __t.ws.open({ name: 'parent', cwd: ${js(PARENT)}, command: '', shellId: 'powershell', env: {}, color: '', sessionId: null }, 'tab')`);
    await waitFor(`__t.ws.tabs.length === 2`, 3000, 'two tabs');
    await ev(`(() => {
      const [first, second] = __t.ws.tabs;
      __t.ws.renameTab(second, 'Parent');
      first.root.sizes = [0.7, 0.3];
      __t.ws.activateTab(first.id);
      __t.ws.setActivePane(__t.ws.panesOf(first)[1].id, true);
      return true;
    })()`);
    await ev(`__t.app.saveWorkspace()`);
    const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(CONFIG), 'workspace.json'), 'utf8'));
    assert(saved.tabs.length === 2 && saved.activeTab === 0, 'tabs: ' + JSON.stringify(saved).slice(0, 300));
    assert(saved.tabs[0].root.split === 'row' && Math.abs(saved.tabs[0].root.sizes[0] - 0.7) < 0.01, 'split: ' + JSON.stringify(saved.tabs[0].root).slice(0, 300));
    assert(saved.tabs[0].activePane === 1 && saved.tabs[1].title === 'Parent', 'active pane / title');
  });

  await step('no uncaught errors in the page', async () => {
    const errors = c.logs.filter((l) => l.startsWith('[exception]') || l.startsWith('[console.error]'));
    assert(errors.length === 0, errors.join('\n'));
  });

  await shot(path.join(OUT, '08-final.png'));
}

if (phase === 'restart') {
  await step('saved session survives a restart', async () => {
    await waitFor(`document.querySelectorAll('.session-row').length === 1`, 5000, 'session row');
    assert((await ev(`document.querySelector('.session-row .session-name span').textContent`)) === 'Shellman repo', 'name');
    assert((await ev(`document.querySelectorAll('.welcome-card').length`)) === 1, 'welcome card');
  });
  await step('open terminals are reopened where they were', async () => {
    await waitFor(`__t.ws.tabs.length === 2`, 10000, 'two tabs restored');
    const r = await ev(`(() => {
      const [first, second] = __t.ws.tabs;
      const [a, b] = __t.ws.panesOf(first);
      return {
        split: first.root.type === 'split' && first.root.direction, size: first.root.sizes?.[0],
        aSession: !!a.spec.sessionId, bShell: b.spec.shellId, bCwd: b.cwd,
        title: second.customTitle, parentCwd: __t.ws.panesOf(second)[0].cwd,
        activeTab: __t.ws.tabs.indexOf(__t.ws.activeTab), activePane: __t.active()?.id === b.id,
      };
    })()`);
    assert(r.split === 'row' && Math.abs(r.size - 0.7) < 0.01, 'layout: ' + JSON.stringify(r));
    assert(r.aSession && r.bShell === 'cmd' && r.bCwd === 'C:\\', 'panes: ' + JSON.stringify(r));
    assert(r.title === 'Parent' && r.parentCwd === PARENT, 'second tab: ' + JSON.stringify(r));
    assert(r.activeTab === 0 && r.activePane, 'focus: ' + JSON.stringify(r));
    // The session's startup command runs again.
    await waitFor(`__t.text(__t.ws.panesOf(__t.ws.tabs[0])[0]).includes('startup-ok')`, 15000, 'startup command re-ran');
  });
  await step('one click on a saved session opens it', async () => {
    await ev(`(() => { window.__log = []; for (const t of ['mousedown','mouseup','click']) document.addEventListener(t, e => window.__log.push(t + ':' + e.target.className), true); return true; })()`);
    await sleep(1000); // synthetic input is dropped until WebView2 presents its first frame
    await click('.session-row');
    await waitFor(`__t.ws.tabs.length === 3`, 3000).catch(async (e) => {
      throw new Error(e.message + ' ' + (await ev(`JSON.stringify({ log: window.__log, tabs: __t.ws.tabs.length, rows: document.querySelectorAll('.session-row').length, rect: JSON.stringify(document.querySelector('.session-row').getBoundingClientRect()) })`)));
    });
    await waitFor(`__t.text().includes('startup-ok')`, 15000);
    assert((await ev(`__t.active().term.options.fontSize`)) === 16, 'font size restored');
  });
  await step('no uncaught errors in the page', async () => {
    const errors = c.logs.filter((l) => l.startsWith('[exception]') || l.startsWith('[console.error]'));
    assert(errors.length === 0, errors.join('\n'));
  });
}

if (phase === 'quit') {
  const { execSync } = await import('node:child_process');
  const pings = () =>
    execSync(`powershell -NoProfile -Command "(Get-Process -Name PING -ErrorAction SilentlyContinue).Id"`).toString().trim();

  await step('closing the window with a running program asks first', async () => {
    await sleep(800);
    await ev(`void __t.ws.open({ name: 'pinger', cwd: 'C:\\\\', command: 'ping -n 300 127.0.0.1', shellId: 'cmd', env: {}, color: '', sessionId: null }, 'tab')`);
    await waitFor(`/Reply from|Pinging/.test(__t.text())`, 15000, 'ping running');
    await ev(`void window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })`);
    await waitFor(`!!document.querySelector('.dialog') && /Quit Shellman/.test(document.querySelector('.dialog').textContent)`, 5000, 'quit dialog');
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Cancel').click()`);
    await sleep(800);
    assert(child.exitCode === null, 'app exited after Cancel');
  });

  await step('confirming quit exits and ends child programs', async () => {
    assert(pings() !== '', 'ping not running before quit');
    await ev(`void window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })`);
    await waitFor(`!!document.querySelector('.dialog')`, 5000, 'quit dialog');
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Quit').click()`).catch(() => undefined);
    const end = Date.now() + 10000;
    while (child.exitCode === null && Date.now() < end) await sleep(200);
    assert(child.exitCode !== null, 'app did not exit');
    await sleep(1500);
    assert(pings() === '', 'ping.exe still running after quit: ' + pings());
  });
}

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join(', ') : ''}`);
c.close();
child.kill();
await portFree().catch(() => undefined);
process.exit(failures.length ? 1 : 0);
