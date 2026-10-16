// Minimal Chrome DevTools Protocol driver for the Shellman WebView2 window.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = 9333;
export const EXE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'target', 'release', 'shellman.exe');

/** Resolves once nothing is listening on the debug port any more. */
export async function portFree(timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('debug port still in use');
}

export async function launch() {
  await portFree();
  // Launch with an environment like Explorer's: drop variables that only
  // exist because this harness runs inside a Claude Code tool shell.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(NO_COLOR|GIT_TERMINAL_PROMPT|CLAUDECODE|CLAUDE_)/i.test(k)),
  );
  // Own WebView2 profile, so the test never attaches to a Shellman you have open.
  const userData = path.join(os.tmpdir(), 'shellman-e2e-webview');
  const child = spawn(EXE, [], {
    env: {
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: userData,
    },
    detached: false,
    stdio: 'ignore',
  });
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(timeout = 20000) {
  const end = Date.now() + timeout;
  let target;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) throw new Error('no CDP target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[console.${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) + '\n' + expression);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 10000, label = expression) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try {
        last = await ev(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${label} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const key = async (code, keyName, vk, mods = []) => {
    const modifiers = mods.reduce((a, m) => a | MODS[m], 0);
    const base = { modifiers, code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const type = (text) => send('Input.insertText', { text });
  const click = async (selector) => {
    const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) throw new Error('no element ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  };
  return { ws, send, ev, waitFor, shot, key, type, click, logs, close: () => ws.close() };
}

export const HELPERS = `
window.__t = {
  get app() { return window.__shellman; },
  get ws() { return window.__shellman.workspace; },
  active() { return window.__shellman.workspace.activePane(); },
  text(p = window.__shellman.workspace.activePane()) {
    const b = p.term.buffer.active; let s = '';
    for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n';
    return s;
  },
  panes() { return [...window.__shellman.workspace.panes.values()]; },
};
true;
`;
