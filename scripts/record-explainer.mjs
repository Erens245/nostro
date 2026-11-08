#!/usr/bin/env node
// Makes the plain-language explainer video: what goes wrong when a business pays people
// abroad, and how Nostro fixes it, with no technical detail.
//
//   node scripts/record-explainer.mjs [demo/nostro-explainer.mp4]
//   node scripts/record-explainer.mjs --stills 4,20.5 [folder]     draws single frames to check
//
// The words are in scripts/explainer/lines.json and the scenes in scripts/explainer/explainer.html.
// Each line is spoken by a voice built into Windows, the scenes are timed to the speech, and
// headless Chrome draws every frame from that timing, so a run always gives the same video.
// Captions are burned in for people watching with the sound off, and also written as .srt.
// Needs Chrome, and ffmpeg on PATH or named by FFMPEG_PATH. Off Windows the video has captions
// but no voice.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, sleep } from './chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const folder = join(here, 'explainer');
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const FADE = 0.5; // Seconds two scenes overlap while one fades into the next.
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const args = process.argv.slice(2);
const stillsFlag = args.indexOf('--stills');
const stills = stillsFlag >= 0 ? args[stillsFlag + 1].split(',').map(Number) : null;
const rest = args.filter((_, index) => stillsFlag < 0 || (index !== stillsFlag && index !== stillsFlag + 1));
const work = mkdtempSync(join(tmpdir(), 'nostro-explainer-'));
const output = resolve(rest[0] ?? (stills ? join(work, 'stills') : join('demo', 'nostro-explainer.mp4')));
const script = JSON.parse(readFileSync(join(folder, 'lines.json'), 'utf8'));
const allLines = script.scenes.flatMap((scene) => scene.lines);

// ---------- Narration ----------

/** Reads a 16-bit PCM WAV, keeps one channel, and trims silence off both ends. */
function readWav(path) {
  const bytes = readFileSync(path);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a WAV file.`);
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = { channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(bytes.length, body + size));
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data || format.bits !== 16) throw new Error(`${path} is not 16-bit PCM.`);
  const count = Math.floor(data.length / 2 / format.channels);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = data.readInt16LE(i * 2 * format.channels);

  // The voice is silent between words, so a low threshold keeps soft endings like a final "s".
  const quiet = 100;
  const pad = Math.round(format.rate * 0.08);
  let first = 0;
  while (first < count && Math.abs(samples[first]) < quiet) first += 1;
  let last = count - 1;
  while (last > first && Math.abs(samples[last]) < quiet) last -= 1;
  const kept = samples.slice(Math.max(0, first - pad), Math.min(count, last + pad + 1));
  return { rate: format.rate, samples: kept, seconds: kept.length / format.rate };
}

function speak() {
  if (process.platform !== 'win32') return null;
  const list = join(work, 'say.json');
  writeFileSync(list, JSON.stringify(Object.fromEntries(allLines.map((line) => [line.id, line.say]))));
  const run = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(folder, 'voice.ps1'), '-Lines', list,
      '-Out', join(work, 'voice'), '-Voice', script.voice, '-Rate', String(script.rate)],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    console.warn(`No narration: ${(run.stderr || run.stdout).trim().slice(0, 300)}`);
    return null;
  }
  console.log(`Voice: ${run.stdout.trim()}`);
  return Object.fromEntries(allLines.map((line) => [line.id, readWav(join(work, 'voice', `${line.id}.wav`))]));
}

// ---------- Timing ----------

/** Lays the lines end to end. Each scene starts as the last one fades out. */
function plan(voice) {
  const length = (line) => (voice ? voice[line.id].seconds : Math.max(1, line.say.split(/\s+/).length / 2.6));
  const round = (value) => Math.round(value * 1000) / 1000;
  const timeline = { fps: FPS, lines: [], scenes: [] };
  let cursor = 0;
  script.scenes.forEach((scene, index) => {
    const start = index === 0 ? 0 : cursor - FADE;
    let at = index === 0 ? 0.8 : cursor + (scene.lead ?? 0.3);
    for (const line of scene.lines) {
      const end = at + length(line);
      timeline.lines.push({
        id: line.id,
        scene: scene.id,
        say: line.say,
        caption: line.caption ?? line.say,
        start: round(at),
        end: round(end),
      });
      at = end + (line.after ?? 0.35);
    }
    cursor = at + (scene.hold ?? 0.5);
    timeline.scenes.push({ id: scene.id, start: round(start), end: round(cursor) });
  });
  timeline.duration = round(cursor);
  return timeline;
}

function writeNarration(voice, timeline, path) {
  const rate = voice[allLines[0].id].rate;
  const total = Math.ceil(timeline.duration * rate);
  const mix = new Int16Array(total);
  for (const line of timeline.lines) {
    const clip = voice[line.id];
    if (clip.rate !== rate) throw new Error('The voice clips have different sample rates.');
    const at = Math.round(line.start * rate);
    mix.set(clip.samples.subarray(0, Math.max(0, total - at)), at);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + mix.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(mix.byteLength, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(mix.buffer, mix.byteOffset, mix.byteLength)]));
}

function writeCaptions(timeline, path) {
  const stamp = (seconds) => {
    const ms = Math.round(seconds * 1000);
    const pad = (value, size = 2) => String(value).padStart(size, '0');
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  const cues = timeline.lines.map(
    (line, index) => `${index + 1}\n${stamp(line.start)} --> ${stamp(line.end + 0.3)}\n${line.caption}\n`,
  );
  writeFileSync(path, cues.join('\n'));
}

// ---------- Drawing ----------

const voice = speak();
const timeline = plan(voice);
console.log(`Length ${timeline.duration.toFixed(1)}s: ${timeline.lines.length} lines in ${timeline.scenes.length} scenes`);

const page = await launchChrome({ width: WIDTH, height: HEIGHT });
await page.call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
await page.call('Page.addScriptToEvaluateOnNewDocument', { source: `window.TIMING = ${JSON.stringify(timeline)};` });
await page.call('Page.navigate', { url: pathToFileURL(join(folder, 'explainer.html')).href });
const deadline = Date.now() + 20_000;
while (!(await page.evaluate('window.ready === true').catch(() => false))) {
  if (page.pageErrors.length > 0 || Date.now() > deadline) {
    console.error(`The scenes did not load: ${page.pageErrors.join('\n') || 'timed out'}`);
    page.close();
    process.exit(1);
  }
  await sleep(100);
}

async function frame(seconds, format) {
  await page.evaluate(`window.seek(${seconds.toFixed(4)})`);
  const { data } = await page.call(
    'Page.captureScreenshot',
    format === 'png' ? { format: 'png' } : { format: 'jpeg', quality: 94 },
  );
  return Buffer.from(data, 'base64');
}

if (stills) {
  mkdirSync(output, { recursive: true });
  for (const seconds of stills) writeFileSync(join(output, `at-${seconds.toFixed(2)}s.png`), await frame(seconds, 'png'));
  for (const scene of timeline.scenes) {
    console.log(`\n${scene.id}  ${scene.start.toFixed(2)}–${scene.end.toFixed(2)}s`);
    for (const line of timeline.lines.filter((item) => item.scene === scene.id)) {
      console.log(`  ${line.start.toFixed(2).padStart(6)}–${line.end.toFixed(2).padEnd(6)} ${line.id}  ${line.caption}`);
    }
  }
  const errors = [...page.pageErrors];
  page.close();
  if (errors.length > 0) console.error(`Page errors:\n${errors.join('\n')}`);
  console.log(`\nStills in ${output}`);
  process.exit(errors.length > 0 ? 1 : 0);
}

mkdirSync(dirname(output), { recursive: true });
const picture = join(work, 'picture.mp4');
const encoder = spawn(
  FFMPEG,
  ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
    // Chrome's JPEG frames are full-range BT.601. Players and upload sites expect HD video in
    // TV range and BT.709, and some show full range with the wrong contrast.
    // The tags go on in the filter chain, because ffmpeg takes them from the frames, not from
    // encoder options.
    '-vf', 'scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,'
      + 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
    '-c:v', 'libx264', '-preset', 'medium', '-tune', 'animation', '-crf', '18', picture],
  { stdio: ['pipe', 'ignore', 'pipe'] },
);
let encoderLog = '';
encoder.stderr.on('data', (chunk) => {
  encoderLog = (encoderLog + chunk).slice(-3000);
});
const encoded = new Promise((done) => encoder.on('close', done));

const frames = Math.ceil(timeline.duration * FPS);
const begun = Date.now();
for (let index = 0; index < frames; index += 1) {
  const jpeg = await frame(index / FPS, 'jpeg');
  if (!encoder.stdin.write(jpeg)) await new Promise((done) => encoder.stdin.once('drain', done));
  if (index % (FPS * 10) === 0) console.log(`Drawing ${Math.round(index / FPS)}s of ${Math.round(timeline.duration)}s`);
}
encoder.stdin.end();
const status = await encoded;
const errors = [...page.pageErrors];
page.close();
if (status !== 0) {
  console.error(`ffmpeg failed:\n${encoderLog}`);
  process.exit(1);
}
if (errors.length > 0) {
  console.error(`Page errors while drawing:\n${errors.join('\n')}`);
  process.exit(1);
}

// ---------- Sound ----------

const mux = ['-y', '-loglevel', 'error', '-i', picture];
if (voice) {
  const narration = join(work, 'narration.wav');
  writeNarration(voice, timeline, narration);
  mux.push('-i', narration, '-map', '0:v', '-map', '1:a', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-shortest');
}
mux.push('-c:v', 'copy', '-movflags', '+faststart', output);
const muxed = spawnSync(FFMPEG, mux, { encoding: 'utf8' });
if (muxed.status !== 0) {
  console.error(`ffmpeg failed:\n${muxed.stderr.slice(-1500)}`);
  process.exit(1);
}
writeCaptions(timeline, output.replace(/\.mp4$/i, '.srt'));
rmSync(work, { recursive: true, force: true });

const megabytes = statSync(output).size / 1024 / 1024;
console.log(`\nWrote ${output}`);
console.log(`${timeline.duration.toFixed(1)}s, ${megabytes.toFixed(1)} MB, ${frames} frames drawn in ${Math.round((Date.now() - begun) / 1000)}s`);
process.exit(0);
