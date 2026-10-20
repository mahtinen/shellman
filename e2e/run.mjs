// End-to-end test of the real Shellman app through CDP. Run it via `npm run e2e`
// (all.mjs), which protects your real configuration.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
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

  await step('create session through the dialog (Remember + Open)', async () => {
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
    const remember = `[...document.querySelectorAll('.dialog .check')].find((l) => l.textContent.includes('Remember this session')).querySelector('input')`;
    assert((await ev(`${remember}.checked`)) === false, 'Remember is off by default');
    await ev(`(() => { const r = ${remember}; r.checked = true; r.dispatchEvent(new Event('change')); return true; })()`);
    await shot(path.join(OUT, '02-session-dialog.png'));
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Open').click()`);
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

  await step('Alt+arrows from a maximized pane restore the split', async () => {
    const first = await ev(`__t.ws.panesOf(__t.ws.activeTab)[0].id`);
    await key('KeyZ', 'Z', 90, ['ctrl', 'shift']);
    await waitFor(`__t.ws.activeTab.el.querySelectorAll('.pane').length === 1`, 2000, 'one pane visible');
    assert((await ev(`__t.active().el.querySelector('.pane-header button:nth-last-child(2)').title`)).startsWith('Restore'), 'restore button');
    await key('ArrowLeft', 'ArrowLeft', 37, ['alt']);
    await waitFor(`__t.ws.activeTab.el.querySelectorAll('.pane').length === 3 && __t.active().id === ${JSON.stringify(first)}`, 2000, 'split restored, left pane active');
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

  await step('Ctrl+Shift+M moves a pane to its own tab, still running', async () => {
    const tabs = await ev(`__t.ws.tabs.length`);
    const from = await ev(`__t.ws.activeTab.id`);
    await key('KeyE', 'E', 69, ['ctrl', 'shift']);
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab).length === 2 && __t.active().state === 'running'`, 10000, 'split running');
    await ev(`__t.active().sendInput('echo "moved-$((2*21))"\\r')`);
    await waitFor(`__t.text().includes('moved-42')`, 8000, 'output before the move');
    const moved = await ev(`__t.active().id`);
    await key('KeyM', 'M', 77, ['ctrl', 'shift']);
    await waitFor(`__t.ws.tabs.length === ${tabs + 1}`, 2000, 'new tab');
    assert((await ev(`__t.ws.activeTab.id`)) !== from, 'new tab active');
    assert((await ev(`__t.ws.tabs.indexOf(__t.ws.activeTab) === __t.ws.tabs.findIndex(t => t.id === ${JSON.stringify(from)}) + 1`)), 'next to its old tab');
    assert((await ev(`__t.active().id`)) === moved, 'same terminal');
    assert(!(await ev(`__t.ws.activeTab.el.classList.contains('multi')`)), 'new tab not multi');
    assert((await ev(`__t.ws.panesOf(__t.ws.tabs.find(t => t.id === ${JSON.stringify(from)})).length`)) === 1, 'old tab has one pane');
    await ev(`__t.active().sendInput('echo "still-$((3*3))"\\r')`);
    await waitFor(`__t.text().includes('still-9') && __t.text().includes('moved-42')`, 8000, 'terminal kept running');
    await key('KeyW', 'W', 87, ['ctrl', 'shift']);
    await waitFor(`__t.ws.tabs.length === ${tabs} && __t.ws.activeTab.id === ${JSON.stringify(from)}`, 5000, 'back to the old tab');
  });

  // Opens a tab with some output in it, then goes back to `from`. Returns the new tab's pane id.
  const backgroundTab = async (from, marker) => {
    await key('KeyT', 'T', 84, ['ctrl', 'shift']);
    await waitFor(`__t.ws.activeTab.id !== ${js(from)} && __t.active().state === 'running'`, 10000, 'new tab running');
    await ev(`__t.active().sendInput('echo "${marker}-$((5*5))"\\r')`);
    await waitFor(`__t.text().includes('${marker}-25')`, 8000, 'output in the new tab');
    const id = await ev(`__t.active().id`);
    await ev(`__t.ws.activateTab(${js(from)})`);
    return id;
  };

  await step('a background tab moves into the current tab as a split (tab menu)', async () => {
    const tabs = await ev(`__t.ws.tabs.length`);
    const from = await ev(`__t.ws.activeTab.id`);
    const moved = await backgroundTab(from, 'menu');
    await ev(`__t.ws.tabOf(__t.ws.panes.get(${js(moved)})).tabEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 20 }))`);
    await waitFor(`!!document.querySelector('.menu')`, 2000, 'tab menu');
    assert((await ev(`__t.ws.activeTab.id`)) === from, 'right-click must not switch tabs');
    await ev(`[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('Move into current tab')).click()`);
    await waitFor(`document.querySelectorAll('.menu').length === 2`, 2000, 'submenu');
    await ev(`[...document.querySelectorAll('.menu')[1].querySelectorAll('.menu-item')].find(m => m.textContent.includes('Split right')).click()`);
    await waitFor(`__t.ws.tabs.length === ${tabs} && __t.ws.activeTab.id === ${js(from)} && __t.ws.panesOf(__t.ws.activeTab).length === 2`, 3000, 'joined the split');
    assert((await ev(`__t.active().id`)) === moved && (await ev(`__t.ws.panesOf(__t.ws.activeTab)[1].id`)) === moved, 'moved pane on the right, focused');
    await ev(`__t.active().sendInput('echo "still-$((4*4))"\\r')`);
    await waitFor(`__t.text().includes('menu-25') && __t.text().includes('still-16')`, 8000, 'terminal kept running');
  });

  await step('a tab dragged onto a pane joins the split on that side', async () => {
    const tabs = await ev(`__t.ws.tabs.length`);
    const from = await ev(`__t.ws.activeTab.id`);
    const target = await ev(`__t.active().id`);
    const moved = await backgroundTab(from, 'drag');
    const shown = await ev(`(() => {
      const dt = new DataTransfer();
      const tabEl = __t.ws.tabOf(__t.ws.panes.get(${js(moved)})).tabEl;
      tabEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const r = __t.ws.panes.get(${js(target)}).el.querySelector('.pane-term').getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.bottom - 5 };
      const over = document.elementFromPoint(at.clientX, at.clientY);
      over.dispatchEvent(new DragEvent('dragover', at));
      const zone = !document.querySelector('.pane-drop').hidden;
      over.dispatchEvent(new DragEvent('drop', at));
      tabEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return zone && document.querySelector('.pane-drop').hidden;
    })()`);
    assert(shown, 'drop zone shown while dragging and hidden after');
    await waitFor(`__t.ws.tabs.length === ${tabs} && __t.ws.panesOf(__t.ws.activeTab).length === 3 && __t.active().id === ${js(moved)}`, 3000, 'joined the split');
    const p = await ev(`(() => { const a = __t.ws.panes.get(${js(target)}).el.getBoundingClientRect(), b = __t.active().el.getBoundingClientRect(); return { below: b.top >= a.bottom - 2, aligned: Math.abs(a.left - b.left) < 2 }; })()`);
    assert(p.below && p.aligned, 'dropped below its target: ' + js(p));
    assert((await ev(`__t.text().includes('drag-25')`)), 'kept its output');
    // Back to one pane for the steps below.
    await key('KeyW', 'W', 87, ['ctrl', 'shift']);
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab).length === 2`, 5000, 'closed one');
    await ev(`__t.ws.setActivePane(__t.ws.panesOf(__t.ws.activeTab)[1].id, true)`);
    await key('KeyW', 'W', 87, ['ctrl', 'shift']);
    await waitFor(`__t.ws.panesOf(__t.ws.activeTab).length === 1`, 5000, 'one pane again');
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

  await step('right-click in Claude Code pastes once (Claude handles it, Shellman does not)', async () => {
    const saved = await ev(`window.__TAURI_INTERNALS__.invoke('clipboard_read')`);
    try {
      assert((await ev(`__t.active().term.modes.mouseTrackingMode`)) !== 'none', 'claude did not turn on mouse reporting');
      await ev(`window.__TAURI_INTERNALS__.invoke('clipboard_write', { text: 'rclick-once' })`);
      const box = await ev(`(() => { const r = __t.active().el.querySelector('.pane-term').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
      }
      await waitFor(`__t.text().includes('rclick-once')`, 5000, 'pasted');
      await sleep(1500);
      const times = (await ev(`__t.text()`)).split('rclick-once').length - 1;
      assert(times === 1, `pasted ${times} times`);
      // Clear the prompt again.
      await ev(`__t.active().sendInput('\\x15')`);
    } finally {
      await ev(`window.__TAURI_INTERNALS__.invoke('clipboard_write', { text: ${js(saved ?? '')} })`).catch(() => undefined);
    }
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

  await step('an idle Git Bash closes without asking', async () => {
    if (!(await ev(`__t.app.constructor && !!window.__shellman.workspace.resolveShell('gitbash') && window.__shellman.workspace.resolveShell('gitbash').id === 'gitbash'`))) {
      console.log('       (Git Bash not installed; skipped)');
      return;
    }
    const tabs = await ev(`__t.ws.tabs.length`);
    await ev(`void __t.ws.open({ name: 'bash', cwd: ${js(REPO)}, command: 'echo bash-ready', shellId: 'gitbash', env: {}, color: '', sessionId: null }, 'tab')`);
    await waitFor(`__t.text().includes('bash-ready')`, 15000, 'bash ready');
    await sleep(1500);
    assert(!(await ev(`__t.active().hasRunningProgram()`)), 'idle Git Bash counts as running a program');
    await ev(`void __t.ws.requestClosePane(__t.active().id)`);
    await sleep(800);
    assert(!(await ev(`!!document.querySelector('.dialog')`)), 'asked to confirm closing an idle Git Bash');
    await waitFor(`__t.ws.tabs.length === ${tabs}`, 3000, 'closed');
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
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Save').click()`);
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

  await step('subgroups: create, move a session in, fold, drag, delete', async () => {
    const groupRow = (name) => `[...document.querySelectorAll('.group-row')].find(r => r.querySelector('.group-name').textContent === ${js(name)})`;
    const menuOn = async (target) => {
      await ev(`${target}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
      await waitFor(`!!document.querySelector('.menu')`, 2000, 'menu');
    };
    const pick = (label, menu = 0) => ev(`[...document.querySelectorAll('.menu')[${menu}].querySelectorAll('.menu-item')].find(m => m.textContent.includes(${js(label)})).click()`);
    const config = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const savedSoon = async (check, what) => {
      for (let i = 0; i < 30; i++, await sleep(100)) if (check(config())) return;
      throw new Error(`not saved: ${what}: ${JSON.stringify(config().groups)}`);
    };

    await menuOn(groupRow('Work'));
    await pick('New subgroup');
    await waitFor(`!!document.querySelector('.dialog input')`, 2000, 'name prompt');
    await ev(`(() => { document.querySelector('.dialog input').value = 'Clients'; return true; })()`);
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Save').click()`);
    await waitFor(`!!${groupRow('Clients')}`, 3000, 'subgroup row');
    assert((await ev(`${groupRow('Clients')}.style.getPropertyValue('--depth')`)) === '1', 'subgroup is indented');
    await savedSoon((c) => c.groups.some((g) => g.name === 'Clients' && g.parentId === c.groups.find((x) => x.name === 'Work').id), 'subgroup in Work');

    await menuOn(`document.querySelector('.session-row')`);
    await pick('Move to group');
    await waitFor(`document.querySelectorAll('.menu').length === 2`, 2000, 'submenu');
    await pick('Work / Clients', 1);
    await savedSoon((c) => c.sessions[0].groupId === c.groups.find((g) => g.name === 'Clients').id, 'session in Clients');
    assert((await ev(`${groupRow('Work')}.querySelector('.group-count').textContent`)) === '1', 'Work counts the session inside Clients');

    // Colours: the session takes the nearest group's colour unless it has its own.
    const sessionColor = () => ev(`document.querySelector('.session-row').style.getPropertyValue('--session-color')`);
    const pickColor = async (title) => {
      await ev(`document.querySelector('.dialog .swatch[title=${js(title)}]').click()`);
      await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Save').click()`);
      await waitFor(`!document.querySelector('.dialog')`, 2000, 'dialog closed');
    };
    await menuOn(groupRow('Work'));
    await pick('Edit…');
    await waitFor(`!!document.querySelector('.dialog .swatch')`, 2000, 'group dialog');
    await pickColor('#7aa2f7');
    await savedSoon((c) => c.groups.find((g) => g.name === 'Work').color === '#7aa2f7', 'Work colour');
    await waitFor(`${groupRow('Clients')}.style.getPropertyValue('--group-color') === '#7aa2f7'`, 2000, 'Clients inherits Work colour');
    assert((await sessionColor()) === '#7aa2f7', 'session inherits the colour through Clients');
    await menuOn(groupRow('Clients'));
    await pick('Edit…');
    await waitFor(`!!document.querySelector('.dialog .swatch[title="Same as the group it is in"]')`, 2000, 'Clients shows the inherited colour');
    await pickColor('#9ece6a');
    await waitFor(`document.querySelector('.session-row').style.getPropertyValue('--session-color') === '#9ece6a'`, 2000, 'subgroup colour wins');
    await menuOn(`document.querySelector('.session-row')`);
    await pick('Edit…');
    await waitFor(`!!document.querySelector('.dialog .swatch[title="Same as its group"]')`, 2000, 'session dialog shows the group colour');
    await pickColor('#f7768e');
    await waitFor(`document.querySelector('.session-row').style.getPropertyValue('--session-color') === '#f7768e'`, 2000, 'own colour wins');
    await savedSoon((c) => c.sessions[0].color === '#f7768e', 'session colour');
    await menuOn(`document.querySelector('.session-row')`);
    await pick('Edit…');
    await waitFor(`!!document.querySelector('.dialog .swatch')`, 2000, 'session dialog');
    await pickColor('Same as its group');
    await savedSoon((c) => c.sessions[0].color === '', 'session colour cleared');
    assert((await sessionColor()) === '#9ece6a', 'back to the group colour');

    // Folding Work hides Clients and the session.
    await ev(`${groupRow('Work')}.click()`);
    await waitFor(`!${groupRow('Clients')} && !document.querySelector('.session-row')`, 2000, 'folded');
    await ev(`${groupRow('Work')}.click()`);
    await waitFor(`!!${groupRow('Clients')} && !!document.querySelector('.session-row')`, 2000, 'unfolded');

    // Drag Clients out to the top level, then back into the middle of Work.
    const drag = (from, to, y) => ev(`(() => {
      const dt = new DataTransfer();
      const src = ${from}, dst = ${to};
      const r = dst.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: ${y} };
      src.dispatchEvent(new DragEvent('dragstart', at));
      dst.dispatchEvent(new DragEvent('dragover', at));
      dst.dispatchEvent(new DragEvent('drop', at));
      src.dispatchEvent(new DragEvent('dragend', at));
      return true;
    })()`);
    await drag(groupRow('Clients'), `document.querySelector('.sidebar-list')`, 'r.bottom - 2');
    await savedSoon((c) => c.groups.find((g) => g.name === 'Clients').parentId === null, 'Clients at top level');
    await drag(groupRow('Clients'), groupRow('Work'), 'r.top + r.height / 2');
    await savedSoon((c) => c.groups.find((g) => g.name === 'Clients').parentId === c.groups.find((g) => g.name === 'Work').id, 'Clients back in Work');
    // Not into a group inside itself.
    await drag(groupRow('Work'), groupRow('Clients'), 'r.top + r.height / 2');
    await sleep(400);
    assert(config().groups.find((g) => g.name === 'Work').parentId === null, 'Work moved into its own subgroup');

    // Deleting Clients keeps its session, in Work.
    await menuOn(groupRow('Clients'));
    await pick('Delete group');
    await waitFor(`/kept, in "Work"/.test(document.querySelector('.dialog')?.textContent ?? '')`, 2000, 'confirm says where it goes');
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Delete').click()`);
    await savedSoon((c) => c.groups.length === 1 && c.sessions[0].groupId === c.groups[0].id, 'session back in Work');
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

  await step('session "Run … with" starts its command in another shell', async () => {
    const before = await ev(`__t.panes().length`);
    await ev(`document.querySelector('.session-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
    await waitFor(`!!document.querySelector('.menu')`, 2000, 'menu');
    await ev(`[...document.querySelectorAll('.menu-item')].find(m => m.textContent.startsWith('Run ')).click()`);
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

  await step('Shift+click opens a plain terminal in the session', async () => {
    const before = await ev(`__t.panes().length`);
    await ev(`document.querySelector('.session-row').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })), true`);
    await waitFor(`__t.panes().length === ${before + 1}`, 3000, 'new pane');
    const spec = await ev(`(({ command, sessionId, cwd }) => ({ command, sessionId, cwd }))(__t.active().spec)`);
    assert(spec.command === '' && spec.sessionId && spec.cwd === REPO, 'plain spec: ' + JSON.stringify(spec));
    await waitFor(`__t.text().includes(${prompt(REPO)})`, 15000, 'plain prompt');
    assert(!(await ev(`__t.text().includes('startup-ok')`)), 'startup command ran');
    await waitFor(`!!document.querySelector('.session-row + .term-tree .term-row[data-pane="' + __t.active().id + '"]')`, 3000, 'listed under the session');
  });

  // SSH runs the real Windows ssh.exe against a closed local port, so no server or keys are needed.
  await step('quick open connects to a typed ssh command', async () => {
    await key('KeyP', 'P', 80, ['ctrl', 'shift']);
    await waitFor(`!!document.querySelector('.palette-input')`, 3000, 'palette');
    await type('ssh -o BatchMode=yes -p 1 nobody@127.0.0.1');
    await waitFor(`document.querySelector('.palette-item.selected .palette-label')?.textContent === 'Connect to nobody@127.0.0.1:1'`, 3000, 'connect item first');
    assert(
      (await ev(`document.querySelectorAll('.palette-item .palette-label')[1]?.textContent`)) === 'Connect to nobody@127.0.0.1:1 with a password',
      'password item second',
    );
    const before = await ev(`__t.ws.tabs.length`);
    await key('Enter', 'Enter', 13);
    await waitFor(`__t.ws.tabs.length === ${before + 1} && __t.active().connection?.host === '127.0.0.1'`, 3000, 'connection tab');
    await waitFor(`__t.active().state === 'exited' && /Press Enter to reconnect/.test(__t.text())`, 20000, 'ssh ran and ended');
    assert(/Connection/.test(await ev(`__t.text()`)), 'ssh error not shown: ' + (await ev(`__t.text()`)));
    assert((await ev(`__t.active().exitCode`)) === 255, 'ssh exit code');
    assert((await ev(`document.querySelector('.status-shell').textContent`)) === 'SSH', 'status bar kind');
    assert((await ev(`document.querySelector('.status-state').textContent`)) === 'disconnected (255)', 'status bar state');
    const row = `document.querySelector('.term-row[data-pane="' + __t.active().id + '"]')`;
    assert((await ev(`${row}?.closest('.term-tree')?.previousElementSibling?.classList.contains('terms-head')`)) === true, 'listed under Other terminals');
    assert((await ev(`${row}.querySelector('.term-shell')?.textContent`)) === 'SSH', 'tree shows SSH');
    await shot(path.join(OUT, '10-ssh-adhoc.png'));
  });

  await step('Enter reconnects a closed connection', async () => {
    const pid = await ev(`__t.active().id`);
    await ev(`__t.active().focus()`);
    await key('Enter', 'Enter', 13);
    await waitFor(`__t.active().id === ${js(pid)} && __t.text().split('Press Enter to reconnect').length === 3`, 20000, 'second attempt ended');
  });

  await step('a new connection can be saved as an SSH session', async () => {
    await key('KeyN', 'N', 78, ['ctrl', 'shift']);
    await waitFor(`/New connection/.test(document.querySelector('.dialog h2')?.textContent)`, 3000, 'dialog');
    assert((await ev(`document.querySelector('.dialog select').value`)) === 'ssh', 'type defaults to SSH');
    const extra = await ev(`document.querySelectorAll('.dialog input.input')[8].value`);
    assert(extra === '-o ServerAliveInterval=30', 'keepalives by default: ' + extra);
    await ev(`(() => {
      const inputs = document.querySelectorAll('.dialog input.input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
      set(inputs[0], 'Closed port');
      set(inputs[3], 'nobody@127.0.0.1:1');
      set(inputs[8], '-o BatchMode=yes');
      return true;
    })()`);
    // user@host:port typed into Host is split into the fields.
    const fields = await ev(`[...document.querySelectorAll('.dialog input.input')].slice(3, 6).map((i) => i.value)`);
    assert(fields.join('|') === '127.0.0.1|1|nobody', 'fields: ' + fields.join('|'));
    // The SSH key picker lists the agent's keys (none on a machine without an agent).
    const keySel = `[...document.querySelectorAll('.dialog select')].find((s) => [...s.options].some((o) => o.value === 'file'))`;
    await waitFor(`${keySel}?.options[0].textContent === 'Default: SSH agent keys and ~/.ssh key files'`, 3000, 'key picker');
    await sleep(1500); // ssh-add -L
    const agentKeys = await ev(`[...${keySel}.options].filter((o) => /^a\\d+$/.test(o.value)).length`);
    // Run with SSH_AUTH_SOCK=\\.\pipe\shellman-e2e-no-agent to test a machine without an agent.
    if (/shellman-e2e-no-agent/.test(process.env.SSH_AUTH_SOCK ?? '')) {
      assert(agentKeys === 0, 'keys listed without an agent');
      assert(/No SSH agent is running/.test(await ev(`document.querySelector('.dialog').textContent`)), 'no-agent hint missing');
    }
    if (agentKeys) await ev(`(() => { const s = ${keySel}; s.value = 'a0'; s.dispatchEvent(new Event('change')); return true; })()`);
    // Temporary by default: group and colour only show once "Remember" is ticked.
    const remember = `[...document.querySelectorAll('.dialog .check')].find((l) => l.textContent.includes('Remember this session')).querySelector('input')`;
    assert((await ev(`document.querySelector('.dialog .btn.primary').textContent`)) === 'Connect', 'button says Connect for SSH');
    assert((await ev(`${remember}.checked`)) === false, 'remember is off by default');
    assert(await ev(`[...document.querySelectorAll('.dialog .field')].find((f) => f.firstChild?.textContent === 'Group').hidden`), 'group shown for a temporary connection');
    await ev(`(() => { const r = ${remember}; r.checked = true; r.dispatchEvent(new Event('change')); return true; })()`);
    assert(!(await ev(`[...document.querySelectorAll('.dialog .field')].find((f) => f.firstChild?.textContent === 'Group').hidden`)), 'group hidden after ticking Remember');
    await shot(path.join(OUT, '11-new-connection.png'));
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Connect').click()`);
    await waitFor(`!document.querySelector('.dialog') && __t.active().spec.sessionId && __t.active().connection?.user === 'nobody'`, 5000, 'saved and connecting');
    // Settings are saved 300 ms after a change.
    let saved;
    for (let i = 0; i < 30 && !saved; i++, await sleep(100)) saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).sessions.find((s) => s.name === 'Closed port');
    assert(saved?.connection?.kind === 'ssh' && saved.connection.port === 1 && saved.connection.extraArgs === '-o BatchMode=yes', 'saved: ' + JSON.stringify(saved));
    if (agentKeys) {
      assert(/^(ssh-|ecdsa-|sk-)/.test(saved.connection.identityKey), 'agent key not saved: ' + JSON.stringify(saved.connection));
      // The public half is written for `ssh -i` when connecting.
      await waitFor(`__t.active().state !== 'starting'`, 10000, 'started');
      const keyDir = path.join(path.dirname(CONFIG), 'ssh-keys');
      assert(fs.existsSync(keyDir) && fs.readdirSync(keyDir).some((f) => f.endsWith('.pub')), 'no public key file in ' + keyDir);
    } else console.log('       (no SSH agent keys here; key choice not tested)');
    const sub = await ev(`[...document.querySelectorAll('.session-row')].find((r) => r.textContent.includes('Closed port'))?.querySelector('.session-sub').textContent`);
    assert(sub === 'sshnobody@127.0.0.1:1', 'sidebar sub line: ' + sub);
    await waitFor(`!!document.querySelector('.session-row + .term-tree .term-row[data-pane="' + __t.active().id + '"]')`, 3000, 'listed under its session');
    await waitFor(`__t.active().state === 'exited'`, 20000, 'ssh ended');
  });

  await step('a temporary password connection is not saved', async () => {
    const sessionsBefore = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).sessions.length;
    await key('KeyN', 'N', 78, ['ctrl', 'shift']);
    await waitFor(`/New connection/.test(document.querySelector('.dialog h2')?.textContent)`, 3000, 'dialog');
    await ev(`(() => {
      const inputs = document.querySelectorAll('.dialog input.input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
      set(inputs[3], '127.0.0.1');
      set(inputs[4], '1');
      const auth = [...document.querySelectorAll('.dialog select')].find((s) => [...s.options].some((o) => o.value === 'password'));
      auth.value = 'password';
      auth.dispatchEvent(new Event('change'));
      return true;
    })()`);
    assert(/doesn't store it/.test(await ev(`document.querySelector('.dialog').textContent`)), 'password hint');
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Connect').click()`);
    await waitFor(`!document.querySelector('.dialog') && __t.active().connection?.passwordAuth === true`, 5000, 'connecting');
    assert((await ev(`__t.active().spec.sessionId`)) === null, 'temporary connection got a session');
    assert((await ev(`__t.active().name`)) === '127.0.0.1:1', 'name defaults to the target');
    // No user name: asked in the terminal first.
    await waitFor(`__t.active().state === 'login' && /login as: $/m.test(__t.text())`, 3000, 'login prompt');
    assert((await ev(`document.querySelector('.status-state').textContent`)) === 'waiting for a user name', 'status bar');
    await ev(`__t.active().focus()`);
    await type('testerx');
    await key('Backspace', 'Backspace', 8);
    await key('Enter', 'Enter', 13);
    await waitFor(`__t.active().connection.user === 'tester'`, 3000, 'user name taken (with backspace)');
    await waitFor(`__t.active().state === 'exited'`, 20000, 'ssh ended');
    await sleep(500);
    assert(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).sessions.length === sessionsBefore, 'temporary connection was saved');
  });

  await step('+ opens a terminal without saving it', async () => {
    const sessionsBefore = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).sessions.length;
    const tabsBefore = await ev(`__t.ws.tabs.length`);
    await click('.sidebar-header .icon-btn[title="New session"]');
    await waitFor(`!!document.querySelector('.dialog')`, 2000, 'dialog');
    assert((await ev(`document.querySelector('.dialog .btn.primary').textContent`)) === 'Open', 'button says Open');
    await ev(`(() => { const i = document.querySelectorAll('.dialog input.input'); i[1].value = ${js(PARENT)}; i[1].dispatchEvent(new Event('input')); return true; })()`);
    await ev(`document.querySelector('.dialog .btn.primary').click()`);
    await waitFor(`!document.querySelector('.dialog') && __t.ws.tabs.length === ${tabsBefore + 1}`, 5000, 'opened');
    assert((await ev(`__t.active().spec.sessionId`)) === null, 'got a session');
    await waitFor(`__t.text().includes(${prompt(PARENT)})`, 15000, 'prompt in the chosen folder');
    await sleep(500);
    assert(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).sessions.length === sessionsBefore, 'it was saved');
  });

  await step('an old server offers to allow old algorithms (A)', async () => {
    // Speaks just enough SSH to offer only ssh-rsa/ssh-dss host keys, like old network gear.
    const nameList = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
    const payload = Buffer.concat([
      Buffer.from([20]), Buffer.alloc(16, 7),
      nameList('curve25519-sha256'), nameList('ssh-rsa,ssh-dss'),
      nameList('aes128-ctr'), nameList('aes128-ctr'), nameList('hmac-sha2-256'), nameList('hmac-sha2-256'),
      nameList('none'), nameList('none'), nameList(''), nameList(''),
      Buffer.from([0, 0, 0, 0, 0]),
    ]);
    let pad = 8 - ((5 + payload.length) % 8);
    if (pad < 4) pad += 8;
    const head = Buffer.alloc(5);
    head.writeUInt32BE(1 + payload.length + pad);
    head[4] = pad;
    const kexinit = Buffer.concat([head, payload, Buffer.alloc(pad)]);
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.write('SSH-2.0-OldBox_1.0\r\n');
      sock.write(kexinit);
      setTimeout(() => sock.destroy(), 3000);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      await ev(`(__t.app.openConnection({ kind: 'ssh', host: '127.0.0.1', port: ${port}, user: 'nobody', identityFile: '', identityKey: '', passwordAuth: false, legacyAlgorithms: false, jumpHost: '', extraArgs: '-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL' }, 'tab'), true)`);
      await waitFor(`__t.active().state === 'exited' && /Press A to reconnect/.test(__t.text())`, 20000, 'offer to allow old algorithms');
      assert(/no matching host key type found/.test(await ev(`__t.text()`)), 'ssh negotiation error');
      await ev(`__t.active().focus()`);
      await type('a');
      await waitFor(`__t.active().connection.legacyAlgorithms === true`, 3000, 'old algorithms allowed');
      // With ssh-rsa allowed the host key type is agreed; the fake server then just hangs up.
      await waitFor(`__t.active().state === 'exited' && __t.text().split('[Connection closed').length === 2`, 20000, 'second attempt ended');
      const text = await ev(`__t.text()`);
      assert(text.split('no matching host key type').length === 2, 'still failing on the host key type:\n' + text);
    } finally {
      server.close();
    }
  });

  await step('a restored connection waits for Enter', async () => {
    const spec = await ev(`JSON.stringify(__t.active().spec)`);
    await ev(`(__t.ws.restoreTab({ title: null, activePane: 0, root: { pane: ${spec} } }), true)`);
    await waitFor(`__t.active().state === 'idle' && /press Enter to connect/.test(__t.text())`, 3000, 'idle');
    assert((await ev(`document.querySelector('.status-state').textContent`)) === 'not connected', 'status bar state');
    await ev(`__t.active().focus()`);
    await key('Enter', 'Enter', 13);
    await waitFor(`__t.active().state === 'exited' && /Press Enter to reconnect/.test(__t.text())`, 20000, 'connected after Enter');
  });

  await step('a saved connection can be deleted', async () => {
    await ev(`[...document.querySelectorAll('.session-row')].find((r) => r.textContent.includes('Closed port')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
    await waitFor(`!!document.querySelector('.menu')`, 2000, 'menu');
    assert(await ev(`[...document.querySelectorAll('.menu-item')].some((i) => i.textContent.includes('Copy SSH command'))`), 'copy command entry');
    assert(!(await ev(`[...document.querySelectorAll('.menu-item')].some((i) => i.textContent.includes('Explorer'))`)), 'no Explorer entry');
    await ev(`[...document.querySelectorAll('.menu-item')].find((i) => i.textContent.includes('Delete')).click()`);
    await waitFor(`!!document.querySelector('.dialog')`, 2000, 'confirm');
    await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Delete').click()`);
    await waitFor(`document.querySelectorAll('.session-row').length === 1`, 3000, 'removed');
  });

  await step('chosen XShell sessions are imported into a new group with subgroups, the rest later', async () => {
    // Made-up sessions the way XShell 7 writes them: UTF-16 with a byte-order mark, folders as subfolders.
    const dir = path.join(os.tmpdir(), 'shellman-e2e-xshell');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'Prod', 'Web'), { recursive: true });
    const xsh = (file, host, port, protocol, user = '') =>
      fs.writeFileSync(path.join(dir, file), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(
        `[CONNECTION]\r\nHost=${host}\r\nPort=${port}\r\nProtocol=${protocol}\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=${user}\r\nPassword=c2VjcmV0\r\n`, 'utf16le')]));
    xsh('router.xsh', '10.0.0.1', 23, 'TELNET');
    xsh(path.join('Prod', 'Web', 'web1.xsh'), 'web1.example.com', 2222, 'SSH', 'deploy');
    xsh(path.join('Prod', 'files.xsh'), 'web1.example.com', 22, 'SFTP', 'deploy');
    const button = (label) => `[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === ${js(label)})`;
    const rows = `[...document.querySelectorAll('.dialog .import-row')]`;
    const row = (name) => `${rows}.find(r => r.querySelector('.import-name').textContent === ${js(name)})`;
    const count = `document.querySelector('.dialog .import-count')?.textContent`;
    const groupSelect = `document.querySelectorAll('.dialog select')[1]`;
    const typeFolder = `(() => { const i = document.querySelector('.dialog input.mono'); i.value = ${js(dir)}; i.dispatchEvent(new Event('change')); return true; })()`;
    // The XShell group and its subgroups, once `n` sessions are saved somewhere in them.
    const readConfig = async (n) => {
      for (let i = 0; i < 30; i++, await sleep(100)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
        const group = cfg.groups.find((g) => g.name === 'XShell' && !g.parentId);
        const prod = cfg.groups.find((g) => g.name === 'Prod' && g.parentId === group?.id);
        const web = cfg.groups.find((g) => g.name === 'Web' && g.parentId === prod?.id);
        const inside = new Set([group?.id, prod?.id, web?.id].filter(Boolean));
        if (cfg.sessions.filter((s) => inside.has(s.groupId)).length === n) return { cfg, group, prod, web };
      }
      throw new Error(`no XShell group with ${n} sessions saved`);
    };

    await ev(`document.querySelector('.sidebar-list').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 400 }))`);
    await waitFor(`!!document.querySelector('.menu')`, 2000, 'menu');
    await ev(`[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('Import sessions')).click()`);
    await waitFor(`!!document.querySelector('.dialog')`, 2000, 'import dialog');
    assert((await ev(`document.querySelector('.dialog select').selectedOptions[0].textContent`)) === 'XShell', 'XShell is the source');
    await waitFor(`!/Looking/.test(document.querySelector('.dialog .import-status').textContent)`, 3000, 'default folder looked up');
    await ev(typeFolder);
    await waitFor(`${count} === "2 of 2 chosen, 1 can't be imported"`, 3000, 'sessions listed');
    assert((await ev(`${rows}.map(r => r.textContent).join('|')`)) === "routertelnet 10.0.0.1|filesSFTP isn't supported|web1ssh deploy@web1.example.com:2222",
      'rows: ' + (await ev(`${rows}.map(r => r.textContent).join('|')`)));
    assert((await ev(`${row('files')}.querySelector('input').disabled`)) === true, 'the SFTP session can be ticked');
    assert((await ev(`${groupSelect}.value`)) === '__new__', 'new group by default');
    assert((await ev(`document.querySelectorAll('.dialog select')[2].value`)) === 'subgroups', 'folders become subgroups by default');
    await ev(`${row('router')}.querySelector('input').click()`);
    await waitFor(`${count} === "1 of 2 chosen, 1 can't be imported"`, 2000, 'router unticked');
    await shot(path.join(OUT, '07c-import-sessions.png'));
    await ev(`${button('Import')}.click()`);
    await waitFor(`!document.querySelector('.dialog')`, 3000, 'dialog closed');
    const first = await readConfig(1);
    assert(first.web, 'no XShell › Prod › Web groups: ' + JSON.stringify(first.cfg.groups));
    const web = first.cfg.sessions.find((s) => s.groupId === first.web.id);
    assert(web?.name === 'web1', 'web1 in Web: ' + JSON.stringify(first.cfg.sessions.map((s) => [s.name, s.groupId])));
    assert(await ev(`[...document.querySelectorAll('.group-row')].some(r => r.querySelector('.group-name').textContent === 'Web' && r.style.getPropertyValue('--depth') === '2')`), 'Web shown two levels deep');
    await shot(path.join(OUT, '07d-imported-subgroups.png'));
    assert(web.connection.kind === 'ssh' && web.connection.host === 'web1.example.com' && web.connection.port === 2222 && web.connection.user === 'deploy' && !web.connection.passwordAuth, 'ssh: ' + JSON.stringify(web.connection));
    assert(!JSON.stringify(first.cfg).includes('c2VjcmV0'), 'the saved password was copied');

    // Again, into that group from its menu: web1 is already saved, the router is left.
    await ev(`[...document.querySelectorAll('.group-row')].find(r => r.textContent.includes('XShell')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
    await waitFor(`!!document.querySelector('.menu')`, 2000, 'group menu');
    await ev(`[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('Import sessions here')).click()`);
    await waitFor(`!!document.querySelector('.dialog')`, 2000, 'import dialog again');
    assert((await ev(`${groupSelect}.value`)) === first.group.id, 'the group is chosen');
    await waitFor(`!/Looking/.test(document.querySelector('.dialog .import-status').textContent)`, 3000, 'default folder looked up again');
    await ev(typeFolder);
    await waitFor(`${count} === "1 of 1 chosen, 2 can't be imported"`, 3000, 'web1 already saved');
    assert((await ev(`${row('web1')}.textContent`)).includes('Already saved'), 'web1 marked');
    await ev(`${button('Import')}.click()`);
    await waitFor(`!document.querySelector('.dialog')`, 3000, 'dialog closed again');
    const second = await readConfig(2);
    const router = second.cfg.sessions.find((s) => s.groupId === second.group.id && s.name === 'router');
    assert(second.cfg.groups.filter((g) => g.name === 'Prod').length === 1, 'Prod made twice');
    assert(router?.connection.kind === 'telnet' && router.connection.port === null, 'telnet: ' + JSON.stringify(router));

    // Leave the sidebar as the restart phase expects it.
    for (const name of ['router', 'web1']) {
      await ev(`[...document.querySelectorAll('.session-row')].find(r => r.querySelector('.session-name span').textContent === ${js(name)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
      await waitFor(`!!document.querySelector('.menu')`, 2000, 'session menu');
      await ev(`[...document.querySelectorAll('.menu-item')].find((i) => i.textContent.includes('Delete')).click()`);
      await waitFor(`!!document.querySelector('.dialog')`, 2000, 'confirm');
      await ev(`${button('Delete')}.click()`);
      await waitFor(`!document.querySelector('.dialog')`, 2000, 'confirmed');
    }
    for (const name of ['Web', 'Prod', 'XShell']) {
      await ev(`[...document.querySelectorAll('.group-row')].find(r => r.querySelector('.group-name').textContent === ${js(name)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
      await ev(`[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('Delete group')).click()`);
      await waitFor(`!!document.querySelector('.dialog')`, 2000, 'confirm group');
      await ev(`${button('Delete')}.click()`);
      await waitFor(`!document.querySelector('.dialog')`, 2000, 'group deleted');
    }
    await waitFor(`document.querySelectorAll('.session-row').length === 1 && document.querySelectorAll('.group-row').length === 1`, 3000, 'cleaned up');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await step('request backend: curl, linked folder and git commands', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.url === '/login') {
          res.writeHead(204, { 'set-cookie': 'sid=e2e; HttpOnly; Path=/' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(js({ method: req.method, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, body }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellman-e2e-collection-'));
    const invoke = (cmd, args) => ev(`window.__TAURI_INTERNALS__.invoke(${js(cmd)}, ${js(args)})`);
    try {
      const jar = 'e2e/dev';
      const login = await invoke('http_send', { id: 9001, request: { method: 'POST', url: `${base}/login`, cookieJar: jar } });
      assert(login?.status === 204, `login: ${js(login)}`);
      const res = await invoke('http_send', {
        id: 9002,
        request: {
          method: 'POST',
          url: `${base}/echo`,
          cookieJar: jar,
          headers: [{ name: 'Authorization', value: 'Bearer {{E2E_TOKEN}}' }],
          secrets: [{ name: 'E2E_TOKEN', value: 'from-env' }],
          body: { type: 'raw', text: '{"a":1}' },
        },
      });
      const echo = JSON.parse(res?.body ?? 'null');
      assert(res.status === 200 && echo?.auth === 'Bearer from-env' && echo.cookie === 'sid=e2e' && echo.body === '{"a":1}', js(res));
      const cookies = await invoke('http_cookies', { key: jar });
      assert(cookies?.length === 1 && cookies[0].httpOnly, js(cookies));
      await invoke('http_discard', { id: 9002 });

      await invoke('collection_write', { folder: dir, path: 'users/list.request.json', kind: 'request', text: '{}\n' });
      await invoke('collection_create_folder', { folder: dir, path: 'orders' });
      const scan = await invoke('collection_scan', { folder: dir });
      assert(js(scan?.requests.map((r) => r.path)) === js(['users/list.request.json']) && scan.folders.includes('orders'), js(scan));
      const bad = await ev(
        `window.__TAURI_INTERNALS__.invoke('collection_write', { folder: ${js(dir)}, path: '../x.request.json', kind: 'request', text: '' }).then(() => 'written', (e) => String(e))`,
      );
      assert(bad.includes('Invalid name'), bad);
      assert((await invoke('git_status', { folder: dir })) === null, 'a temporary folder is not a repository');
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await step('requests: a linked folder, preview tabs, sending, cookies, saving, environments', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.url === '/login') {
          res.writeHead(204, { 'set-cookie': 'sid=e2e; HttpOnly; Path=/' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(js({ path: req.url, method: req.method, auth: req.headers.authorization ?? null, tenant: req.headers['x-tenant'] ?? null, cookie: req.headers.cookie ?? null, body }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellman-e2e-requests-'));
    const put = (rel, value) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    };
    put('environments/dev.json', { variables: { baseUrl: base } });
    put('environments/prod.json', { variables: { baseUrl: base }, protected: true });
    put('.env', 'TENANT=acme-test\n');
    put('.env.local', 'API_TOKEN=s3cret-e2e\n');
    put('users/list.request.json', { method: 'GET', url: '{{baseUrl}}/users', headers: [{ name: 'X-Tenant', value: '{{TENANT}}' }], auth: { type: 'bearer', token: '{{API_TOKEN}}' } });
    put('login.request.json', { method: 'POST', url: '{{baseUrl}}/login' });
    put('me.request.json', { method: 'GET', url: '{{baseUrl}}/me' });
    const row = (name) => `[...document.querySelectorAll('.req-row')].find(r => r.querySelector('.req-name').textContent === ${js(name)})`;
    const active = `__t.active()`;
    const send = async () => {
      const before = await ev(`${active}.el.querySelector('.rq-status')?.textContent ?? ''`);
      await ev(`${active}.el.querySelector('.rq-url').focus()`);
      await key('Enter', 'Enter', 13, ['ctrl']);
      await waitFor(`!!${active}.el.querySelector('.rq-status .chip') && ${active}.el.querySelector('.rq-status').textContent !== ${js(before)}`, 15000, 'response');
      return ev(`${active}.el.querySelector('.rq-response-body').textContent`);
    };
    const menuItem = (text) => `[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes(${js(text)}))`;
    try {
      await click('.sidebar-header .icon-btn[title="New group"]');
      await waitFor(`document.querySelectorAll('.dialog input').length >= 2`, 3000, 'group dialog');
      await ev(`(() => { const [name, folder] = document.querySelectorAll('.dialog input.input'); name.value = 'API'; folder.value = ${js(dir)}; return true; })()`);
      await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Save').click()`);
      await waitFor(`document.querySelectorAll('.req-row').length === 3 && !!document.querySelector('.req-folder-row')`, 8000, 'request tree');
      assert((await ev(`document.querySelector('.env-pill')?.textContent`)) === 'dev', 'environment pill');

      // A click previews; the next click replaces the preview; a double-click keeps it.
      const tabs = await ev(`__t.ws.tabs.length`);
      await ev(`${row('list')}.click()`);
      await waitFor(`${active}?.kind === 'request' && __t.ws.activeTab.preview`, 5000, 'preview tab');
      await ev(`${row('me')}.click()`);
      await waitFor(`${active}?.ref.path === 'me.request.json'`, 5000, 'preview replaced');
      assert((await ev(`__t.ws.tabs.length`)) === tabs + 1, 'the preview tab was reused');
      await ev(`${row('me')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await waitFor(`!__t.ws.activeTab.preview`, 2000, 'pinned');

      // Variables: plain values filled in, the secret by curl.
      await ev(`${row('list')}.click()`);
      await waitFor(`${active}?.ref.path === 'users/list.request.json'`, 5000, 'list open');
      const listBody = await send();
      assert(listBody.includes('"Bearer s3cret-e2e"') && listBody.includes('"acme-test"'), 'variables: ' + listBody.slice(0, 300));
      await shot(path.join(OUT, '20-request-pane.png'));

      // The console shows what ran, without the secret.
      await ev(`[...${active}.el.querySelectorAll('.rq-tab')].find(b => b.textContent === 'Console').click()`);
      const consoleText = await waitFor(`${active}.el.querySelector('.rq-console')?.textContent`, 3000, 'console');
      assert(consoleText.includes('curl.exe') && consoleText.includes('> GET /users HTTP/1.1') && consoleText.includes('Bearer ••••••') && !consoleText.includes('s3cret-e2e'), 'console: ' + consoleText.slice(0, 600));
      await shot(path.join(OUT, '21-request-console.png'));

      // A variable used in a header opens the editor on itself.
      await ev(`[...${active}.el.querySelectorAll('.rq-tab')].find(b => b.textContent.startsWith('Headers')).click()`);
      await waitFor(`[...${active}.el.querySelectorAll('.rq-var-link')].some(b => b.textContent === '{{TENANT}}')`, 3000, 'variables used in headers');
      await ev(`[...${active}.el.querySelectorAll('.rq-var-link')].find(b => b.textContent === '{{TENANT}}').click()`);
      await waitFor(`document.querySelector('.variables-dialog .var-row.focus input.mono')?.value === 'TENANT'`, 3000, 'editor on TENANT');
      await ev(`[...document.querySelectorAll('.variables-dialog .btn')].find(b => b.textContent === 'Cancel').click()`);
      await waitFor(`!document.querySelector('.variables-dialog')`, 2000, 'editor closed');

      // Variables are edited in the app: a new one goes to the environment's file.
      await ev(`[...${active}.el.querySelectorAll('.rq-tool')].find(b => b.textContent.includes('Variables')).click()`);
      await waitFor(`!!document.querySelector('.variables-dialog .var-row:not(.var-head)')`, 3000, 'variables dialog');
      await ev(`[...document.querySelectorAll('.variables-dialog .btn')].find(b => b.textContent.includes('Add variable')).click()`);
      await ev(`(() => { const rows = document.querySelectorAll('.variables-dialog .var-row:not(.var-head)'); const [n, v] = rows[rows.length - 1].querySelectorAll('input.mono'); n.value = 'NEWVAR'; n.dispatchEvent(new Event('input')); v.value = 'hello'; v.dispatchEvent(new Event('input')); return true; })()`);
      await sleep(400); // past the dialog's fade-in
      await shot(path.join(OUT, '22-variables.png'));
      await ev(`[...document.querySelectorAll('.variables-dialog .btn')].find(b => b.textContent === 'Save').click()`);
      await waitFor(`!document.querySelector('.variables-dialog')`, 3000, 'dialog closed');
      // A normal variable for every environment is shared: it goes to .env.
      assert(fs.readFileSync(path.join(dir, '.env'), 'utf8').includes('NEWVAR=hello'), 'variable not saved');
      assert((await ev(`${active}.el.querySelector('.rq-env').textContent`)) === 'dev', 'environment button');

      // A login cookie is kept and sent with the next request.
      await ev(`${row('login')}.click()`);
      await waitFor(`${active}?.ref.path === 'login.request.json'`, 5000, 'login open');
      await send();
      await ev(`${row('me')}.click()`);
      await waitFor(`${active}?.ref.path === 'me.request.json'`, 5000, 'me open');
      assert((await send()).includes('sid=e2e'), 'cookie not sent');

      // Editing marks it unsaved; Ctrl+S writes the file.
      await ev(`(() => { const u = ${active}.el.querySelector('.rq-url'); u.value = '{{baseUrl}}/me?x=1'; u.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await waitFor(`${active}.dirty && !!document.querySelector('.req-row .dirty-dot')`, 2000, 'unsaved');
      // Ctrl+S saves also when nothing in the pane has focus.
      await ev(`document.activeElement.blur(), true`);
      await key('KeyS', 's', 83, ['ctrl']);
      await waitFor(`!${active}.dirty`, 3000, 'saved');
      assert(JSON.parse(fs.readFileSync(path.join(dir, 'me.request.json'), 'utf8')).url === '{{baseUrl}}/me?x=1', 'file not written');

      // A change on disk (a git pull) shows in a pane without unsaved changes.
      put('me.request.json', { method: 'GET', url: '{{baseUrl}}/me?pulled=1' });
      await waitFor(`${active}.el.querySelector('.rq-url').value === '{{baseUrl}}/me?pulled=1'`, 5000, 'reloaded from disk');

      // Copy as curl leaves the secret to curl.
      await ev(`${row('list')}.click()`);
      await waitFor(`${active}?.ref.path === 'users/list.request.json'`, 5000, 'list open');
      await ev(`[...${active}.el.querySelectorAll('.rq-tool')].find(b => b.textContent.includes('curl')).click()`);
      await sleep(500);
      const copied = await ev(`window.__TAURI_INTERNALS__.invoke('clipboard_read')`);
      assert(copied.includes('curl.exe') && copied.includes('--variable %API_TOKEN') && !copied.includes('s3cret'), 'copied: ' + copied);

      // A protected environment asks before anything but GET (switched from the button next to Send).
      await ev(`${active}.el.querySelector('.rq-env').click()`);
      await waitFor(`!!${menuItem('prod')}`, 2000, 'environment menu');
      await ev(`${menuItem('prod')}.click()`);
      await waitFor(`document.querySelector('.env-pill')?.textContent === 'prod' && document.querySelector('.env-pill').classList.contains('protected')`, 3000, 'prod chosen');
      await ev(`${row('login')}.click()`);
      await waitFor(`${active}?.ref.path === 'login.request.json'`, 5000, 'login open');
      await ev(`${active}.el.querySelector('.rq-send').click()`);
      await waitFor(`document.querySelector('.dialog h2')?.textContent.includes('prod')`, 3000, 'confirm dialog');
      await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Cancel').click()`);

      // A request dragged onto a folder moves there; its open pane follows.
      await ev(`(() => {
        const dt = new DataTransfer();
        const src = ${row('me')};
        const dst = [...document.querySelectorAll('.req-folder-row')].find(r => r.textContent.includes('users'));
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        return true;
      })()`);
      await waitFor(`__t.panes().some(p => p.kind === 'request' && p.ref.path === 'users/me.request.json')`, 5000, 'pane follows the move');
      assert(fs.existsSync(path.join(dir, 'users', 'me.request.json')) && !fs.existsSync(path.join(dir, 'me.request.json')), 'file not moved');

      // Request panes are saved with the workspace and reopen from their files.
      const snap = await ev(`JSON.stringify(__t.ws.snapshot())`);
      const saved = JSON.parse(snap).tabs.find((t) => t.root.request?.path === 'login.request.json');
      assert(saved, 'request not in the snapshot: ' + snap);
      await ev(`__t.ws.removeTab(__t.ws.activeTab)`);
      await ev(`__t.ws.restoreTab(${js(saved)})`);
      await waitFor(`__t.panes().some(p => p.kind === 'request' && p.ref.path === 'login.request.json')`, 3000, 'restored request pane');

      // Clean up: close the request tabs and remove the group.
      for (const t of await ev(`__t.ws.tabs.filter(t => __t.ws.panesOf(t).some(p => p.kind === 'request')).map(t => t.id)`)) await ev(`__t.ws.removeTab(__t.ws.tabs.find(x => x.id === ${js(t)}))`);
      await ev(`[...document.querySelectorAll('.group-row')].find(r => r.querySelector('.group-name').textContent === 'API').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
      await waitFor(`!!${menuItem('Delete group')}`, 2000, 'group menu');
      await ev(`${menuItem('Delete group')}.click()`);
      await waitFor(`!!document.querySelector('.dialog .btn.danger')`, 2000, 'confirm');
      await ev(`document.querySelector('.dialog .btn.danger').click()`);
      await waitFor(`!document.querySelector('.req-row')`, 3000, 'group removed');
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await step('git sync: Sync button, teammates\' changes, automatic commit and push', async () => {
    const { execFileSync } = await import('node:child_process');
    const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellman-e2e-sync-'));
    const [mine, theirs] = [path.join(root, 'mine'), path.join(root, 'theirs')];
    git(root, 'init', '--quiet', '--bare', '-b', 'main', 'remote.git');
    for (const dir of [mine, theirs]) {
      git(root, 'clone', '--quiet', 'remote.git', path.basename(dir));
      for (const [k, v] of [['user.name', 'E2E'], ['user.email', 'e2e@example.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(dir, 'config', k, v);
    }
    const req = (url) => JSON.stringify({ method: 'GET', url }, null, 2) + '\n';
    fs.mkdirSync(path.join(mine, 'api'));
    fs.writeFileSync(path.join(mine, 'api', 'list.request.json'), req('https://api.example.com/v1'));
    fs.writeFileSync(path.join(mine, 'api', '.gitignore'), '.env*.local\n');
    git(mine, 'add', '.');
    git(mine, 'commit', '--quiet', '-m', 'init');
    git(mine, 'push', '--quiet', '-u', 'origin', 'main');
    git(theirs, 'pull', '--quiet', 'origin', 'main');
    git(theirs, 'branch', '--quiet', '--set-upstream-to=origin/main');
    const badge = `document.querySelector('.group-row .sync-badge')`;
    const active = `__t.active()`;
    const menuItem = (text) => `[...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes(${js(text)}))`;
    try {
      await click('.sidebar-header .icon-btn[title="New group"]');
      await waitFor(`document.querySelectorAll('.dialog input').length >= 2`, 3000, 'group dialog');
      await ev(`(() => { const [name, folder] = document.querySelectorAll('.dialog input.input'); name.value = 'Synced'; folder.value = ${js(path.join(mine, 'api'))}; return true; })()`);
      await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Save').click()`);
      await waitFor(`${badge}?.textContent === '✓'`, 10000, 'in sync');
      // Sync stays on the branch it started on (the config is saved a moment later).
      const branchEnd = Date.now() + 5000;
      while (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).groups.find((g) => g.name === 'Synced')?.syncBranch !== 'main') {
        if (Date.now() > branchEnd) throw new Error('branch not remembered');
        await sleep(200);
      }

      // Manual: a save shows as a change; Sync commits, pulls and pushes.
      await ev(`[...document.querySelectorAll('.req-row')].find(r => r.textContent.includes('list')).click()`);
      await waitFor(`${active}?.kind === 'request'`, 5000, 'request open');
      await ev(`(() => { const u = ${active}.el.querySelector('.rq-url'); u.value = 'https://api.example.com/v2'; u.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await key('KeyS', 's', 83, ['ctrl']);
      await waitFor(`${badge}?.textContent === '●1'`, 5000, 'one change');
      await ev(`${badge}.click()`);
      await waitFor(`${badge}?.textContent === '✓'`, 20000, 'synced');
      git(theirs, 'pull', '--quiet');
      assert(fs.readFileSync(path.join(theirs, 'api', 'list.request.json'), 'utf8').includes('/v2'), 'not pushed');
      assert(git(theirs, 'log', '-1', '--format=%s').trim() === 'Update list', 'commit message');

      // A teammate's change comes in with Sync and shows in the open request.
      fs.writeFileSync(path.join(theirs, 'api', 'list.request.json'), req('https://api.example.com/v3'));
      git(theirs, 'commit', '--quiet', '-am', 'Teammate');
      git(theirs, 'push', '--quiet');
      await ev(`${badge}.click()`);
      await waitFor(`${active}.el.querySelector('.rq-url').value === 'https://api.example.com/v3'`, 20000, "teammate's change in the pane");

      // Automatic: a save is committed and pushed by itself.
      await ev(`[...document.querySelectorAll('.group-row')].find(r => r.textContent.includes('Synced')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
      await waitFor(`!!${menuItem('Edit…')}`, 2000, 'group menu');
      await ev(`${menuItem('Edit…')}.click()`);
      await waitFor(`!!document.querySelector('.dialog select[data-field=sync]')`, 3000, 'group editor');
      await ev(`(() => { const s = document.querySelector('.dialog select[data-field=sync]'); s.value = 'auto'; s.dispatchEvent(new Event('change')); document.querySelector('.dialog select[data-field=delay]').value = '10'; return true; })()`);
      await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Save').click()`);
      await waitFor(`!document.querySelector('.dialog')`, 2000, 'editor closed');
      await ev(`(() => { const u = ${active}.el.querySelector('.rq-url'); u.value = 'https://api.example.com/v4'; u.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await key('KeyS', 's', 83, ['ctrl']);
      const pushed = async () => {
        git(theirs, 'pull', '--quiet');
        return fs.readFileSync(path.join(theirs, 'api', 'list.request.json'), 'utf8').includes('/v4');
      };
      const end = Date.now() + 30000;
      while (!(await pushed())) {
        if (Date.now() > end) throw new Error('automatic sync did not push');
        await sleep(1000);
      }
      await waitFor(`${badge}?.textContent === '✓'`, 10000, 'in sync after the automatic push');

      // Someone's own unpushed commit elsewhere in the repository: automatic sync pauses rather
      // than push it along, and Sync asks first.
      fs.writeFileSync(path.join(mine, 'notes.txt'), 'my own work\n');
      git(mine, 'add', 'notes.txt');
      git(mine, 'commit', '--quiet', '-m', 'Own work');
      await ev(`(() => { const u = ${active}.el.querySelector('.rq-url'); u.value = 'https://api.example.com/v5'; u.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await key('KeyS', 's', 83, ['ctrl']);
      await waitFor(`${badge}?.textContent === 'paused'`, 30000, 'paused for the other commit');
      assert(!git(root, '--git-dir', path.join(root, 'remote.git'), 'log', '--format=%s', 'main').includes('Own work'), 'the other commit was pushed');
      await ev(`${badge}.click()`);
      await waitFor(`document.querySelector('.dialog h2')?.textContent === 'Sync other work too?'`, 5000, 'asks before syncing other work');
      await ev(`[...document.querySelectorAll('.dialog .btn')].find(b => b.textContent === 'Cancel').click()`);

      for (const t of await ev(`__t.ws.tabs.filter(t => __t.ws.panesOf(t).some(p => p.kind === 'request')).map(t => t.id)`)) await ev(`__t.ws.removeTab(__t.ws.tabs.find(x => x.id === ${js(t)}))`);
      await ev(`[...document.querySelectorAll('.group-row')].find(r => r.textContent.includes('Synced')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`);
      await waitFor(`!!${menuItem('Delete group')}`, 2000, 'group menu');
      await ev(`${menuItem('Delete group')}.click()`);
      await waitFor(`!!document.querySelector('.dialog .btn.danger')`, 2000, 'confirm');
      await ev(`document.querySelector('.dialog .btn.danger').click()`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await step('open terminals are saved for the next start', async () => {
    // A known layout: the session with a cmd split beside it (cmd focused), and a renamed PowerShell tab.
    await ev(`(() => { for (const t of [...__t.ws.tabs]) __t.ws.removeTab(t); return true; })()`);
    await click('.session-row');
    await waitFor(`__t.ws.tabs.length === 1 && __t.text().includes('startup-ok')`, 15000, 'session tab');
    await ev(`void __t.ws.open({ name: 'root', cwd: 'C:\\\\', command: '', shellId: 'cmd', env: {}, color: '', sessionId: null }, 'right', __t.active().id)`);
    await ev(`void __t.ws.open({ name: 'parent', cwd: ${js(PARENT)}, command: '', shellId: 'powershell', env: {}, color: '', sessionId: null }, 'tab')`);
    await waitFor(`__t.ws.tabs.length === 2`, 3000, 'two tabs');
    // Claude gets its own conversation id; nothing is asked, so after the restart it falls back to a fresh one.
    await ev(`void __t.ws.open({ name: 'claude', cwd: ${js(REPO)}, command: 'claude', shellId: '', env: {}, color: '', sessionId: null }, 'tab')`);
    await waitFor(`__t.ws.tabs.length === 3 && __t.active().spec.claudeStarted === true`, 15000, 'claude tab started');
    await waitFor(`/Claude Code|Welcome|trust/i.test(__t.text())`, 40000, 'claude UI');
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
    assert(saved.tabs.length === 3 && saved.activeTab === 0, 'tabs: ' + JSON.stringify(saved).slice(0, 300));
    const claude = saved.tabs[2].root.pane;
    assert(claude.command === 'claude' && /^[0-9a-f-]{36}$/.test(claude.claudeId) && claude.claudeStarted === true, 'claude conversation: ' + JSON.stringify(claude));
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
    await waitFor(`__t.ws.tabs.length === 3`, 10000, 'three tabs restored');
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
  await step('a restored Claude terminal resumes its own conversation', async () => {
    const id = await ev(`__t.ws.panesOf(__t.ws.tabs[2])[0].spec.claudeId`);
    assert(/^[0-9a-f-]{36}$/.test(id ?? ''), 'no conversation id: ' + id);
    const claudePane = `__t.ws.panesOf(__t.ws.tabs[2])[0]`;
    // It tries to resume exactly that conversation; it was never used, so Claude starts it fresh with the same id.
    await waitFor(`__t.text(${claudePane}).includes('No conversation found with session ID: ${id}')`, 40000, 'resumed by id');
    // Claude clears the screen when it starts, so the message above disappears again.
    await waitFor(`/Claude Code v\\d/.test(__t.text(${claudePane}))`, 40000, 'fresh conversation started');
  });
  await step('one click on a saved session opens it', async () => {
    await ev(`(() => { window.__log = []; for (const t of ['mousedown','mouseup','click']) document.addEventListener(t, e => window.__log.push(t + ':' + e.target.className), true); return true; })()`);
    await sleep(1000); // synthetic input is dropped until WebView2 presents its first frame
    await click('.session-row');
    await waitFor(`__t.ws.tabs.length === 4`, 3000).catch(async (e) => {
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
