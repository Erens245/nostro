#!/usr/bin/env node
// Records the demo video from the real portal: Chrome's own screen frames, a
// spoken narration and burned-in captions. It runs the actual flow, so what you
// see happened. Long waits for the chain are shortened afterwards.
//
//   node scripts/record-demo.mjs http://127.0.0.1:8787 demo/nostro-demo.mp4
//
// Needs ffmpeg on PATH. The voice uses Windows speech, so elsewhere it's silent
// with captions only.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshPaymentFile, launchChrome, portalConfig, sleep } from './chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const output = resolve(process.argv[3] ?? join('demo', 'nostro-demo.mp4'));
const work = mkdtempSync(join(tmpdir(), 'nostro-video-'));
const WIDTH = 1280;
const HEIGHT = 720;
const TAIL = 0.5; // Seconds held after the narration ends.

const config = await portalConfig(base);
const simulated = config.contractId.includes('simulated');
const gnucashLog = join(here, '..', 'proof', 'gnucash-interop.txt');
const gnucashPasses = existsSync(gnucashLog)
  ? readFileSync(gnucashLog, 'utf8').split('\n').filter((line) => line.startsWith('PASS')).length
  : 14;

const SLIDE_STYLE = `
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; justify-content: center;
    padding: 0 110px 60px; box-sizing: border-box; background: #1c2b3a; color: #f6f3ec;
    font-family: 'Palatino Linotype', Georgia, serif; }
  h1 { font-size: 54px; line-height: 1.15; font-weight: 600; margin: 0 0 20px; letter-spacing: -0.01em; }
  p { font-family: 'Segoe UI', sans-serif; font-size: 24px; line-height: 1.45; color: #c9cfd6; margin: 0; }
  pre { font-family: Consolas, monospace; font-size: 19px; line-height: 1.5; color: #e8e4da;
    background: #142130; padding: 22px 26px; border-radius: 3px; margin: 22px 0 0; overflow: hidden; }
  b { color: #e6c98a; font-weight: 600; }`;

const slide = (body) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><style>${SLIDE_STYLE}</style>${body}`)}`;

// ---------- The script ----------

const payment = simulated
  ? resolve(here, '..', 'fixtures', 'pain.001.001.03.xml')
  : freshPaymentFile(resolve(here, '..', 'fixtures', 'pain.001.001.03.xml'));

let runId = 1;
const today = new Date().toISOString().slice(0, 10);

const SCENES = [
  {
    say: 'Your accounting software can already pay people. It exports a bank file.',
    run: (page) =>
      page.call('Page.navigate', {
        url: slide(`<h1>Your accounting software can already pay people.</h1>
          <p>It exports a bank file. It imports a statement.<br>Nobody wants a new app for that.</p>`),
      }),
  },
  {
    say: 'Nostro reads that same file, and pays each line in stablecoins, on the chain each payee chose.',
    run: (page) =>
      page.call('Page.navigate', {
        url: slide(`<h1>This is that file.</h1><pre>&lt;CdtTrfTxInf&gt;
  &lt;Amt&gt;&lt;InstdAmt Ccy="USD"&gt;<b>2450.75</b>&lt;/InstdAmt&gt;&lt;/Amt&gt;
  &lt;Cdtr&gt;&lt;Nm&gt;<b>Lucia Marin</b>&lt;/Nm&gt;&lt;/Cdtr&gt;
  &lt;RmtInf&gt;&lt;Ustrd&gt;INV-208 Brand design&lt;/Ustrd&gt;&lt;/RmtInf&gt;
&lt;/CdtTrfTxInf&gt;</pre>`),
      }),
  },
  {
    say: 'A finance clerk uploads it, unchanged. Nostro reads every payment, and prices each one live on NEAR Intents.',
    run: async (page) => {
      await page.signIn(base, 'Finance clerk');
      await page.goTo('new');
      await page.waitFor('Drop a payment file');
      await page.chooseFile(payment);
      await page.waitFor('Submit for approval', 90_000);
    },
  },
  {
    say: 'Here is what it costs, next to the same payments by wire.',
    run: (page) =>
      page.evaluate(`document.querySelector('.compare')?.scrollIntoView({ block: 'center', behavior: 'smooth' })`),
  },
  {
    say: 'The clerk submits, with no wallet and no gas. A relayer pays. And the clerk cannot approve their own run. The contract enforces that.',
    run: async (page) => {
      await page.clickText('Submit for approval');
      await page.waitFor('Waiting for approval', 90_000);
      runId = Number(/run\/(\d+)/.exec(await page.evaluate('window.location.hash'))?.[1]);
    },
  },
  {
    say: 'The finance director opens the run. Their own browser re-reads the file, and checks every payment against what is recorded on chain.',
    run: async (page) => {
      await page.signIn(base, 'Finance director');
      await page.goTo(`run/${runId}`);
      await page.waitFor('Checked on this device', 60_000);
    },
  },
  {
    say: simulated
      ? 'Approve, and release. Each payment settles.'
      : 'Approve, and release. Each payment settles on testnet. On mainnet, NEAR Intents delivers each one to the chain the payee chose.',
    run: async (page) => {
      await page.clickText('Approve');
      await page.waitFor('Release payments', 90_000);
      await page.clickText('Release payments');
      await page.waitFor('Settled', 180_000);
    },
  },
  {
    say: 'Upload the same file twice, and it is refused, so nobody gets paid twice.',
    run: async (page) => {
      await page.signIn(base, 'Finance clerk');
      await page.goTo('new');
      await page.waitFor('Drop a payment file');
      await page.chooseFile(payment);
      await page.waitFor('This file has already been submitted', 90_000);
      await page.evaluate(`document.querySelector('.notice-bad')?.scrollIntoView({ block: 'center' })`);
    },
  },
  {
    say: 'Now the part an accountant cares about. A statement that ties to the chain, to the cent, in the format your software already imports.',
    run: async (page) => {
      await page.goTo('statements');
      await page.waitFor('This statement ties to the chain', 60_000);
    },
  },
  {
    say: 'GnuCash’s own importers read these statements, with the right balances.',
    run: (page) =>
      page.call('Page.navigate', {
        url: slide(`<h1>Real accounting software reads them.</h1><pre>LibOFX 0.10.5     OFX              <b>PASS</b>
AqBanking 6.9.2   MT940            <b>PASS</b>
AqBanking 6.9.2   camt.053.001.08  <b>PASS</b>

${gnucashPasses} checks on amounts and balances, in GnuCash's importers.</pre>`),
      }),
  },
  {
    say: 'Nostro. Your accounting software stays the same. Your payments get cheaper. Built at NEAR Hackathon.',
    run: (page) =>
      page.call('Page.navigate', {
        url: slide(`<h1>Nostro</h1>
          <p>Bank file in. Stablecoins out. Statement back.</p>
          <p style="margin-top:18px">Built at NEAR HACKATHON. ${simulated ? '' : `Contract ${config.contractId} on testnet.`}</p>`),
      }),
  },
];

const CHAPTERS = [
  'The idea',
  'The file you already have',
  'A clerk uploads it',
  'What it costs',
  'Submitted, with no gas',
  'A second person checks it',
  'Approve and pay',
  'A repeat is refused',
  'The statement',
  'Real accounting software',
  'In one line',
];

// ---------- Narration ----------

function speak() {
  if (process.platform !== 'win32') return SCENES.map(() => null);
  const script = join(work, 'speak.ps1');
  const lines = SCENES.map((scene, index) => {
    const text = scene.say.replace(/'/g, "''").replace(/’/g, "''");
    return `$s.SetOutputToWaveFile('${join(work, `say-${index}.wav`)}'); $s.Speak('${text}')`;
  });
  writeFileSync(
    script,
    [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      "$s.SelectVoice('Microsoft Zira Desktop')",
      '$s.Rate = 0',
      ...lines,
      '$s.SetOutputToNull()',
      '$s.Dispose()',
    ].join('\r\n'),
  );
  const run = spawnSync('powershell', ['-NoProfile', '-File', script], { encoding: 'utf8' });
  if (run.status !== 0) console.warn(`No narration: ${run.stderr.slice(0, 200)}`);
  return SCENES.map((_, index) => {
    const path = join(work, `say-${index}.wav`);
    return existsSync(path) && statSync(path).size > 1000 ? path : null;
  });
}

function seconds(path) {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  );
  return Number(probe.stdout.trim()) || 0;
}

const wavs = speak();
const spoken = wavs.map((path, index) =>
  path ? seconds(path) : Math.max(2.5, SCENES[index].say.split(' ').length / 2.6),
);
console.log(`Narration: ${spoken.reduce((a, b) => a + b, 0).toFixed(1)}s across ${SCENES.length} scenes`);

// ---------- Recording ----------

const page = await launchChrome({ width: WIDTH, height: HEIGHT });
await page.call('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});

// A caption bar, added to every document so it survives navigation.
await page.call('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__clickPause = 500;
  window.__caption = (text) => {
    const label = ${JSON.stringify(simulated ? 'Rehearsal: simulated chain' : '')};
    if (label && !document.getElementById('nostro-badge')) {
      const badge = document.createElement('div');
      badge.id = 'nostro-badge';
      badge.textContent = label;
      badge.style.cssText = 'position:fixed;top:12px;right:14px;z-index:99999;padding:5px 11px;' +
        'background:#8a5a0a;color:#fff;font:600 15px "Segoe UI",sans-serif;border-radius:3px;';
      document.documentElement.appendChild(badge);
    }
    let bar = document.getElementById('nostro-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'nostro-caption';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:14px 48px 16px;' +
        'background:rgba(16,24,33,.93);color:#fff;font:500 23px/1.35 "Segoe UI",sans-serif;text-align:center;';
      document.documentElement.appendChild(bar);
    }
    bar.textContent = text;
  };`,
});

const frames = [];
let frameIndex = 0;
page.on('Page.screencastFrame', (frame) => {
  const file = join(work, `f${String(frameIndex).padStart(5, '0')}.jpg`);
  frameIndex += 1;
  writeFileSync(file, Buffer.from(frame.data, 'base64'));
  frames.push({ file, at: Date.now() });
  void page.call('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
});

await page.call('Page.navigate', { url: slide('') });
await sleep(400);
await page.call('Page.startScreencast', {
  format: 'jpeg',
  quality: 88,
  maxWidth: WIDTH,
  maxHeight: HEIGHT,
  everyNthFrame: 1,
});

const caption = (text) =>
  page.evaluate(`window.__caption?.(${JSON.stringify(text)})`).catch(() => {});

const marks = [];
try {
  for (const [index, scene] of SCENES.entries()) {
    const started = Date.now();
    marks.push({ started });
    console.log(`Scene ${index + 1}/${SCENES.length}: ${scene.say.slice(0, 60)}`);

    // Keep the caption up while the scene works, through any page load.
    let working = true;
    const keepCaption = (async () => {
      while (working) {
        await caption(scene.say);
        await sleep(350);
      }
    })();

    await scene.run(page);
    const left = spoken[index] * 1000 + TAIL * 1000 - (Date.now() - started);
    if (left > 0) await sleep(left);
    working = false;
    await keepCaption;
    marks[index].ended = Date.now();
  }
} finally {
  await page.call('Page.stopScreencast').catch(() => {});
}
await sleep(300);
const errors = [...page.pageErrors];
page.close();
if (errors.length > 0) console.warn(`Page errors during recording:\n${errors.slice(0, 3).join('\n')}`);

// ---------- A page to watch it on ----------

/** Writes index.html beside the video, with chapters and a way to try it. */
function writeViewingPage() {
  const clock = (value) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const chapters = offsets
    .map(
      (at, index) =>
        `<li><button type="button" data-at="${at.toFixed(2)}"><span>${clock(at)}</span>${CHAPTERS[index]}</button></li>`,
    )
    .join('\n');
  const sample = resolve(here, '..', 'fixtures', 'pain.001.001.03.xml');
  const note = simulated
    ? `<p class="note"><strong>This is a rehearsal on a simulated chain.</strong> The portal, file reading, browser
       signing and all the checks are real, and the routing costs are live quotes. No blockchain is involved yet, so
       “settled” here is simulated. The real testnet run is scheduled for 06:01 IST.</p>`
    : `<p class="note">Recorded on NEAR testnet, contract <code>${config.contractId}</code>. Test tokens have no value.</p>`;
  const tryIt = simulated
    ? `<section>
        <h2>Try it yourself</h2>
        <p><a class="button" href="${base}/" target="_blank" rel="noopener">Open the portal</a></p>
        <ol>
          <li>Click <strong>Finance clerk</strong>.</li>
          <li>Click <strong>New payment run</strong> and choose this file:<br><code>${sample}</code></li>
          <li>Look at the cost comparison, then click <strong>Submit for approval</strong>.</li>
          <li>Click <strong>Sign out</strong>, then <strong>Finance director</strong>.</li>
          <li>Click <strong>Approvals</strong>, then <strong>Run 1</strong>. See <strong>Checked on this device</strong>.</li>
          <li>Click <strong>Approve</strong>, then <strong>Release payments</strong>.</li>
          <li>Click <strong>Statements</strong> and download one. Then try uploading the same file again.</li>
        </ol>
      </section>`
    : '';
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nostro walkthrough</title>
<style>
  :root { --paper:#f6f3ec; --sheet:#fffdf8; --ink:#1c2b3a; --muted:#5e6670; --rule:#dcd6c8; --warn:#8a5a0a; --warn-wash:#f7ecd5; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px 64px; background: var(--paper); color: var(--ink);
    font-family: system-ui, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.5; }
  main { max-width: 960px; margin: 0 auto; }
  h1, h2 { font-family: 'Palatino Linotype', Palatino, Georgia, serif; font-weight: 600; letter-spacing: -0.01em; }
  h1 { margin: 0 0 4px; font-size: 2.1rem; }
  h2 { margin: 32px 0 8px; font-size: 1.3rem; }
  .lead { margin: 0 0 16px; color: var(--muted); }
  .note { margin: 0 0 16px; padding: 10px 14px; border-left: 3px solid var(--warn); background: var(--warn-wash); }
  video { display: block; width: 100%; background: #000; border-radius: 3px; }
  .chapters { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 6px; margin: 16px 0 0; padding: 0; list-style: none; }
  .chapters button { display: flex; gap: 10px; width: 100%; padding: 8px 12px; border: 1px solid var(--rule); border-radius: 3px;
    background: var(--sheet); color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
  .chapters button:hover { border-color: var(--ink); }
  .chapters span { color: var(--muted); font-variant-numeric: tabular-nums; }
  .button { display: inline-block; padding: 10px 16px; border-radius: 3px; background: var(--ink); color: var(--paper); font-weight: 600; text-decoration: none; }
  ol { padding-left: 20px; }
  li { margin-bottom: 4px; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 0.85em; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
  <h1>How Nostro works</h1>
  <p class="lead">Press play, with sound on. About ${Math.round(clock_seconds())} seconds.</p>
  ${note}
  <video id="demo" controls preload="auto" src="${basename(output)}"></video>
  <ul class="chapters">
${chapters}
  </ul>
  ${tryIt}
</main>
<script>
  const video = document.getElementById('demo');
  for (const button of document.querySelectorAll('[data-at]')) {
    button.addEventListener('click', () => {
      video.currentTime = Number(button.dataset.at);
      video.play();
    });
  }
</script>
</body>
</html>
`;
  writeFileSync(join(dirname(output), 'index.html'), page);
}

const clock_seconds = () => clips.reduce((sum, clip) => sum + clip.seconds, 0);

// ---------- Editing ----------

// Each frame shows until the next. Within a scene that outlasts its narration,
// the longest static stretches are cut down, which removes waits for the chain
// without touching anything that moved.
const clips = [];
const offsets = [];
let clock = 0;
for (const [index, mark] of marks.entries()) {
  const inScene = frames
    .map((frame, position) => ({ ...frame, until: frames[position + 1]?.at ?? mark.ended }))
    .filter((frame) => frame.at < mark.ended && frame.until > mark.started)
    .map((frame) => ({
      file: frame.file,
      seconds: (Math.min(frame.until, mark.ended) - Math.max(frame.at, mark.started)) / 1000,
    }));
  if (inScene.length === 0) {
    const previous = frames.filter((frame) => frame.at <= mark.started).at(-1) ?? frames[0];
    inScene.push({ file: previous.file, seconds: (mark.ended - mark.started) / 1000 });
  }

  const wanted = spoken[index] + TAIL;
  let excess = inScene.reduce((sum, frame) => sum + frame.seconds, 0) - wanted;
  for (const frame of [...inScene].sort((a, b) => b.seconds - a.seconds)) {
    if (excess <= 0) break;
    const cut = Math.min(excess, Math.max(frame.seconds - 0.4, 0));
    frame.seconds -= cut;
    excess -= cut;
  }

  offsets.push(clock);
  clock += inScene.reduce((sum, frame) => sum + frame.seconds, 0);
  clips.push(...inScene);
}

const listFile = join(work, 'frames.txt');
const quoted = (path) => `file '${path.replace(/\\/g, '/')}'`;
writeFileSync(
  listFile,
  `${clips.map((clip) => `${quoted(clip.file)}\nduration ${clip.seconds.toFixed(3)}`).join('\n')}\n${quoted(clips.at(-1).file)}\n`,
);

const inputs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
const delays = [];
const mix = [];
wavs.forEach((path, index) => {
  if (!path) return;
  const input = mix.length + 1;
  inputs.push('-i', path);
  const ms = Math.round(offsets[index] * 1000);
  delays.push(`[${input}:a]adelay=${ms}|${ms}[a${input}]`);
  mix.push(`[a${input}]`);
});

const video = ['-vf', `fps=30,scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`];
const encode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart'];
const audio =
  mix.length > 0
    ? [
        '-filter_complex',
        `${delays.join(';')};${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest[a]`,
        '-map',
        '0:v',
        '-map',
        '[a]',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
      ]
    : ['-an'];

mkdirSync(dirname(output), { recursive: true });
const made = spawnSync('ffmpeg', [...inputs, ...audio, ...video, ...encode, output], { encoding: 'utf8' });
if (made.status !== 0) {
  console.error(made.stderr.slice(-1500));
  process.exit(1);
}

writeViewingPage();

const length = seconds(output);
console.log(`\nWrote ${output}`);
console.log(`${length.toFixed(1)} seconds, ${(statSync(output).size / 1024 / 1024).toFixed(1)} MB, ${frames.length} frames`);
if (length > 120) console.warn('Over 2 minutes. Keep it under, per the rules on a good demo.');
process.exit(0);
