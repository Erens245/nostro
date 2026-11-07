#!/usr/bin/env node
// Drives a real headless Chrome through the portal, clerk then director, with
// no extra dependencies: it speaks the DevTools protocol over a WebSocket.
//
//   node scripts/browser-check.mjs http://127.0.0.1:8799 <screenshot-dir>
//
// Exits non-zero if any step fails. Any page error fails the run too, which is
// the point: a build that compiles can still crash in a browser.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? 'http://127.0.0.1:8799';
const shots = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'nostro-shots-'));
mkdirSync(shots, { recursive: true });

const chromePaths = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = chromePaths.find((path) => existsSync(path));
if (!chromePath) {
  console.error('No Chrome found. Set CHROME_PATH.');
  process.exit(2);
}

const debugPort = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'nostro-chrome-'))}`,
    '--window-size=1320,900',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pageErrors = [];
let failed = 0;

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = targets.find((target) => target.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(500);
  }
  throw new Error('Chrome did not start.');
}

function client(url) {
  const socket = new WebSocket(url);
  const waiting = new Map();
  let next = 1;
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && waiting.has(data.id)) {
      const { resolve: done, reject } = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else done(data.result);
    } else if (data.method === 'Runtime.exceptionThrown') {
      const detail = data.params.exceptionDetails;
      pageErrors.push(detail.exception?.description ?? detail.text);
    } else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      const text = data.params.args.map((arg) => arg.value ?? arg.description).join(' ');
      // A 4xx the app handles shows in the console too. Those are expected.
      if (!/Failed to load resource/.test(text)) pageErrors.push(text);
    }
  };
  const call = (method, params = {}) =>
    new Promise((done, reject) => {
      const id = next;
      next += 1;
      waiting.set(id, { resolve: done, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return new Promise((ready) => {
    socket.onopen = () => ready({ call, close: () => socket.close() });
  });
}

const cdp = await client(await connect());
await cdp.call('Page.enable');
await cdp.call('Runtime.enable');
await cdp.call('DOM.enable');

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await cdp.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.value;
};

const textOf = () => evaluate('document.body.innerText');

async function waitFor(text, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    // innerText follows CSS, so uppercased labels come back in capitals.
    if ((await textOf()).toLowerCase().includes(text.toLowerCase())) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for "${text}". Page says: ${(await textOf()).slice(0, 400)}`);
}

const clickText = (text) =>
  evaluate(`(() => {
    const items = [...document.querySelectorAll('button, a')];
    const item = items.find((el) => el.innerText.trim().startsWith(${JSON.stringify(text)}));
    if (!item) throw new Error('Nothing to click called ' + ${JSON.stringify(text)});
    if (item.disabled) throw new Error(${JSON.stringify(text)} + ' is disabled');
    item.click();
  })()`);

const goTo = (hash) =>
  evaluate(`(() => { window.location.hash = ${JSON.stringify(hash)}; })()`);

async function shot(name) {
  const { data } = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}

async function step(name, action) {
  try {
    await action();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
    await shot(`failed-${name.replace(/\W+/g, '-')}`).catch(() => {});
    throw error;
  }
}

async function signIn(label) {
  await evaluate('localStorage.clear()');
  await cdp.call('Page.navigate', { url: `${base}/` });
  await waitFor('Sign in to the demo');
  await clickText(label);
  await waitFor('Overview');
}

const fixture = resolve(here, '..', 'fixtures', process.env.FIXTURE ?? 'pain.001.001.03.xml');

try {
  await step('the portal loads with no script errors', async () => {
    await cdp.call('Page.navigate', { url: `${base}/` });
    await waitFor('Sign in to the demo');
    await shot('01-sign-in');
  });

  await step('the clerk signs in and sees the balance', async () => {
    await signIn('Finance clerk');
    await waitFor('20,000');
    await shot('02-overview');
  });

  await step('a real payment file is read and priced', async () => {
    await goTo('new');
    await waitFor('Drop a payment file');
    const { root } = await cdp.call('DOM.getDocument');
    const { nodeId } = await cdp.call('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: 'input[type=file]',
    });
    await cdp.call('DOM.setFileInputFiles', { nodeId, files: [fixture] });
    await waitFor('Submit for approval', 45_000);
    await waitFor('Lucia Marin');
    await shot('03-file-read');
  });

  await step('the clerk submits, signing in the browser', async () => {
    await clickText('Submit for approval');
    await waitFor('Waiting for approval', 30_000);
    await shot('04-submitted');
  });

  await step('the clerk cannot see an approve button', async () => {
    if ((await textOf()).includes('Your decision')) throw new Error('A clerk was offered approval.');
  });

  await step('the director opens the run and it is checked on their device', async () => {
    await signIn('Finance director');
    await goTo('approvals');
    await waitFor('Run 1');
    await clickText('Run 1');
    await waitFor('Checked on this device');
    await waitFor('Your decision');
    await shot('05-approval');
  });

  await step('the director approves', async () => {
    await clickText('Approve');
    await waitFor('Release payments', 30_000);
  });

  await step('payments are released and settle', async () => {
    await clickText('Release payments');
    await waitFor('Paid', 30_000);
    await waitFor('Settled');
    await shot('06-paid');
  });

  await step('the statement ties to the chain', async () => {
    await goTo('statements');
    await waitFor('This statement ties to the chain');
    await shot('07-statements');
  });

  await step('the statement can be fixed on chain', async () => {
    await clickText('Fix on chain');
    await waitFor('Fixed at block', 30_000);
    await shot('08-anchored');
  });

  await step('the overview reports the books match', async () => {
    await goTo('');
    await waitFor('The books match the chain');
    await waitFor('10,651');
    await shot('09-overview-after');
  });

  await step('the page stays usable on a phone', async () => {
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(400);
    const overflow = await evaluate(
      'document.documentElement.scrollWidth > document.documentElement.clientWidth',
    );
    await shot('10-phone');
    if (overflow) throw new Error('The page scrolls sideways at phone width.');
  });
} catch {
  // Already reported by step().
}

if (pageErrors.length > 0) {
  failed += 1;
  console.log(`FAIL  no script errors in the page`);
  for (const error of pageErrors.slice(0, 6)) console.log(`      ${String(error).slice(0, 300)}`);
} else {
  console.log('PASS  no script errors in the page');
}

console.log(`\nScreenshots: ${shots}`);
cdp.close();
chrome.kill();
process.exit(failed === 0 ? 0 : 1);
