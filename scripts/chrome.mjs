// Drives a real headless Chrome over the DevTools protocol, with no dependencies.
// Shared by browser-check.mjs and record-demo.mjs.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function launchChrome({ width = 1320, height = 900 } = {}) {
  const path = CHROME_PATHS.find((candidate) => existsSync(candidate));
  if (!path) throw new Error('No Chrome found. Set CHROME_PATH.');

  const port = 9333 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    path,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'nostro-chrome-'))}`,
      `--window-size=${width},${height}`,
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let target;
  for (let attempt = 0; attempt < 80 && !target; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = pages.find((page) => page.type === 'page')?.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    if (!target) await sleep(500);
  }
  if (!target) {
    chrome.kill();
    throw new Error('Chrome did not start.');
  }

  const socket = new WebSocket(target);
  const waiting = new Map();
  const listeners = new Map();
  const pageErrors = [];
  let next = 1;

  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && waiting.has(data.id)) {
      const { done, fail } = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) fail(new Error(data.error.message));
      else done(data.result);
      return;
    }
    if (data.method === 'Runtime.exceptionThrown') {
      const detail = data.params.exceptionDetails;
      pageErrors.push(detail.exception?.description ?? detail.text);
    } else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      const text = data.params.args.map((arg) => arg.value ?? arg.description).join(' ');
      // A 4xx the app handles shows in the console too. Those are expected.
      if (!/Failed to load resource/.test(text)) pageErrors.push(text);
    }
    listeners.get(data.method)?.(data.params);
  };

  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = next;
      next += 1;
      waiting.set(id, { done, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((ready) => {
    socket.onopen = ready;
  });
  await call('Page.enable');
  await call('Runtime.enable');
  await call('DOM.enable');

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return result.value;
  };

  const textOf = () => evaluate('document.body.innerText');

  async function waitFor(text, timeout = 30_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      // innerText follows CSS, so uppercased labels come back in capitals.
      if ((await textOf()).toLowerCase().includes(text.toLowerCase())) return;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for "${text}". Page says: ${(await textOf()).slice(0, 400)}`);
  }

  const clickText = (text) =>
    evaluate(`(async () => {
      const items = [...document.querySelectorAll('button, a')];
      const item = items.find((el) => el.innerText.trim().startsWith(${JSON.stringify(text)}));
      if (!item) throw new Error('Nothing to click called ' + ${JSON.stringify(text)});
      if (item.disabled) throw new Error(${JSON.stringify(text)} + ' is disabled');
      item.scrollIntoView({ block: 'center' });
      item.style.outline = '3px solid #d18a00';
      item.style.outlineOffset = '2px';
      await new Promise((done) => setTimeout(done, window.__clickPause ?? 0));
      item.click();
    })()`);

  const goTo = (hash) => evaluate(`(() => { window.location.hash = ${JSON.stringify(hash)}; })()`);

  async function chooseFile(path) {
    const { root } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: 'input[type=file]',
    });
    await call('DOM.setFileInputFiles', { nodeId, files: [path] });
  }

  async function screenshot(file) {
    const { data } = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  async function signIn(base, label) {
    // Go to the portal first: a slide's data: URL has no localStorage to clear.
    await call('Page.navigate', { url: `${base}/` });
    const end = Date.now() + 15_000;
    while ((await evaluate('location.origin').catch(() => 'null')) !== base) {
      if (Date.now() > end) throw new Error(`The portal at ${base} did not load.`);
      await sleep(100);
    }
    await evaluate('localStorage.clear()');
    await call('Page.reload');
    await sleep(300);
    await waitFor('Sign in to the demo');
    await clickText(label);
    await waitFor('Overview');
  }

  return {
    call,
    evaluate,
    textOf,
    waitFor,
    clickText,
    goTo,
    chooseFile,
    screenshot,
    signIn,
    pageErrors,
    on: (method, handler) => listeners.set(method, handler),
    close() {
      socket.close();
      chrome.kill();
    },
  };
}

/** The sample file with fresh ids, because a real chain refuses a repeat. */
export function freshPaymentFile(fixture) {
  const stamp = Date.now().toString(36).toUpperCase();
  const path = join(mkdtempSync(join(tmpdir(), 'nostro-file-')), 'payment-run.xml');
  const text = readFileSync(fixture, 'utf8')
    .replaceAll('HP-2026-11-07-00', `HP-${stamp}-`)
    .replaceAll('HP-1101-', `HP-${stamp}-L`);
  writeFileSync(path, text);
  return path;
}

export async function portalConfig(base) {
  return (await fetch(`${base}/api/config`)).json();
}
