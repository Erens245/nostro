#!/usr/bin/env node
// Walks the portal in a real headless Chrome, clerk then director.
//
//   node scripts/browser-check.mjs http://127.0.0.1:8799 <screenshot-dir>
//
// Works against the simulated preview or a real testnet server. Exits non-zero
// if any step fails. A page error fails the run too, which is the point: a build
// that compiles can still crash in a browser.

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshPaymentFile, launchChrome, portalConfig, sleep } from './chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? 'http://127.0.0.1:8799';
const shots = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'nostro-shots-'));
mkdirSync(shots, { recursive: true });

const config = await portalConfig(base);
const simulated = config.contractId.includes('simulated');
console.log(`Checking ${base}, contract ${config.contractId}${simulated ? ' (simulated chain)' : ''}\n`);

// The walk expects run 1 and a $20,000 balance, and the preview keeps runs in memory.
if (simulated && (await (await fetch(`${base}/api/runs`)).json()).length > 0) {
  console.log('This preview has already been used. Stop it, start `npm run preview` again, and rerun this check.');
  process.exit(1);
}

const page = await launchChrome();
let failed = 0;

async function shot(name) {
  await page.screenshot(join(shots, `${name}.png`));
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

const fixture = (name) => resolve(here, '..', 'fixtures', name);
const payment = simulated ? fixture('pain.001.001.03.xml') : freshPaymentFile(fixture('pain.001.001.03.xml'));
let runId = 1;

try {
  await step('the portal loads with no script errors', async () => {
    await page.call('Page.navigate', { url: `${base}/` });
    await page.waitFor('Sign in to the demo');
    await shot('01-sign-in');
  });

  await step('the clerk signs in and sees the balance', async () => {
    await page.signIn(base, 'Finance clerk');
    await page.waitFor('Balance');
    if (simulated) await page.waitFor('20,000');
    await shot('02-overview');
  });

  await step('a real payment file is read and priced', async () => {
    await page.goTo('new');
    await page.waitFor('Drop a payment file');
    await page.chooseFile(payment);
    await page.waitFor('Submit for approval', 60_000);
    await page.waitFor('Lucia Marin');
    await shot('03-file-read');
  });

  await step('the clerk submits, signing in the browser', async () => {
    await page.clickText('Submit for approval');
    await page.waitFor('Waiting for approval', 60_000);
    runId = Number(/run\/(\d+)/.exec(await page.evaluate('window.location.hash'))?.[1]);
    if (!runId) throw new Error('The page did not move to the new run.');
    await shot('04-submitted');
  });

  await step('the clerk cannot see an approve button', async () => {
    if ((await page.textOf()).includes('Your decision')) throw new Error('A clerk was offered approval.');
  });

  await step('the director opens the run and it is checked on their device', async () => {
    await page.signIn(base, 'Finance director');
    await page.goTo('approvals');
    await page.waitFor(`Run ${runId}`);
    await page.clickText(`Run ${runId}`);
    await page.waitFor('Checked on this device', 45_000);
    await page.waitFor('Your decision');
    await shot('05-approval');
  });

  await step('the director approves', async () => {
    await page.clickText('Approve');
    await page.waitFor('Release payments', 60_000);
  });

  await step('payments are released and settle', async () => {
    await page.clickText('Release payments');
    await page.waitFor('Paid', 120_000);
    await page.waitFor('Settled');
    await shot('06-paid');
  });

  await step('each step and payment names its transaction', async () => {
    await page.waitFor('On chain');
    if (!simulated) {
      // A judge can open each one, so on a real chain they must be links.
      const links = await page.evaluate(`document.querySelectorAll('a[href*="nearblocks.io/txns/"]').length`);
      if (links < 3) throw new Error(`Expected links to NearBlocks for each step, found ${links}.`);
    }
  });

  await step('the statement ties to the chain', async () => {
    await page.goTo('statements');
    await page.waitFor('This statement ties to the chain', 45_000);
    await shot('07-statements');
  });

  await step('the statement can be fixed on chain', async () => {
    await page.clickText('Fix on chain');
    await page.waitFor('Fixed at block', 60_000);
    await shot('08-anchored');
  });

  await step('the overview reports the books match', async () => {
    await page.goTo('');
    await page.waitFor('The books match the chain', 45_000);
    if (simulated) await page.waitFor('10,651');
    await shot('09-overview-after');
  });

  await step('uploading the same file again is refused', async () => {
    await page.signIn(base, 'Finance clerk');
    await page.goTo('new');
    await page.waitFor('Drop a payment file');
    await page.chooseFile(payment);
    await page.waitFor('This file has already been submitted', 60_000);
    const disabled = await page.evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.innerText.startsWith('Submit for approval'))?.disabled`,
    );
    if (disabled !== true) throw new Error('The submit button is still enabled.');
    await shot('11-duplicate-refused');
  });

  // Tampering needs the preview's hook, so this only runs on the simulated chain.
  // The contract's own defence is covered by its unit tests and the testnet demo.
  if (simulated) {
    await step('a genuine file with altered recorded lines cannot be approved', async () => {
      await page.call('Page.reload');
      await page.waitFor('Overview');
      await page.goTo('new');
      await page.waitFor('Drop a payment file');
      await page.chooseFile(fixture('pain.001.001.09.xml'));
      await page.waitFor('Submit for approval', 60_000);
      await page.waitFor('Lucia Marin');
      await page.clickText('Submit for approval');
      await page.waitFor('Waiting for approval', 30_000);

      // The file is untouched. Only what is recorded to be paid has changed.
      const reply = await fetch(`${base}/__simulate/tamper/2`);
      if (!reply.ok) throw new Error('This server has no tamper hook.');

      await page.signIn(base, 'Finance director');
      await page.goTo('run/2');
      await page.waitFor('Do not approve this run');
      await page.waitFor('has a different amount on record');
      const disabled = await page.evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.innerText.startsWith('Approve'))?.disabled`,
      );
      if (disabled !== true) throw new Error('The Approve button is still enabled.');
      await shot('12-tamper-caught');
    });
  }

  await step('the page stays usable on a phone', async () => {
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(400);
    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth > document.documentElement.clientWidth',
    );
    await shot('10-phone');
    if (overflow) throw new Error('The page scrolls sideways at phone width.');
  });
} catch {
  // Already reported by step().
}

if (page.pageErrors.length > 0) {
  failed += 1;
  console.log('FAIL  no script errors in the page');
  for (const error of page.pageErrors.slice(0, 6)) console.log(`      ${String(error).slice(0, 300)}`);
} else {
  console.log('PASS  no script errors in the page');
}

console.log(`\nScreenshots: ${shots}`);
page.close();
process.exit(failed === 0 ? 0 : 1);
