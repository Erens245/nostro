#!/usr/bin/env node
// Runs Nostro's statements through the importers GnuCash ships: LibOFX for OFX,
// and AqBanking for MT940 and camt.053. These are command-line tools, so no GUI
// is involved. It checks what those tools read, not merely that they exited.
//
//   node scripts/interop-gnucash.mjs <gnucash-app-folder> <statements-folder> [log-file]
//
// The folder is the installed "app" directory holding bin, lib and share. This
// exercises GnuCash's parsers. It doesn't click through GnuCash's import screens.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [app, statements, logFile] = process.argv.slice(2);
if (!app || !statements) {
  console.error('Usage: node scripts/interop-gnucash.mjs <gnucash-app-folder> <statements-folder> [log-file]');
  process.exit(2);
}

const bin = join(app, 'bin');
const home = mkdtempSync(join(tmpdir(), 'nostro-aq-'));
const log = [];
let failed = 0;

function say(line) {
  console.log(line);
  log.push(line);
}

function check(claim, ok, detail = '') {
  if (!ok) failed += 1;
  say(`${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `  (${detail})` : ''}`);
}

// AqBanking writes a settings folder to the user's home. Point it somewhere
// disposable, so running this leaves nothing behind in anyone's profile.
const env = {
  ...process.env,
  PATH: `${bin};${process.env.PATH}`,
  OFX_DTD_PATH: join(app, 'share', 'libofx', 'dtd'),
  USERPROFILE: home,
  HOME: home,
  APPDATA: home,
};

function run(tool, args) {
  const result = spawnSync(join(bin, tool), args, { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { code: result.status, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

const cents = (text) => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw new Error(`Not an amount: "${text}"`);
  const [, sign, whole, fraction = ''] = match;
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign ? -value : value;
};

const money = (value) => {
  const size = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${size / 100n}.${String(size % 100n).padStart(2, '0')}`;
};

// Our own CSV supplies the expected figures, which each importer must reproduce.
const csv = readFileSync(join(statements, 'statement.csv'), 'utf8').split(/\r?\n/);
const balanceOf = (type) => {
  const row = csv.find((line) => line.split(',')[1] === type);
  if (!row) throw new Error(`No ${type} row in statement.csv`);
  return cents(row.split(',')[6]);
};
const opening = balanceOf('Opening balance');
const closing = balanceOf('Closing balance');
say(`Expected: opening ${money(opening)}, closing ${money(closing)}`);

// ---------- OFX, through LibOFX ----------

say('');
const version = run('ofxdump.exe', ['--version']).out.trim().split('\n')[0];
say(`LibOFX: ${version}`);
for (const name of ['statement.ofx', 'statement-220.ofx']) {
  const { code, out } = run('ofxdump.exe', [join(statements, name)]);
  const amounts = [...out.matchAll(/Total money amount:\s*(-?[\d.]+)/g)].map((match) => cents(match[1]));
  const ledger = /Ledger balance:\s*(-?[\d.]+)/.exec(out)?.[1];
  const net = amounts.reduce((sum, value) => sum + value, 0n);
  const errors = out.split('\n').filter((line) => /^\s*(LibOFX ERROR|ERROR)/i.test(line));
  check(`${name}: read with no errors`, code === 0 && errors.length === 0, `${amounts.length} transactions`);
  check(`${name}: ledger balance matches`, ledger !== undefined && cents(ledger) === closing, ledger);
  check(`${name}: transactions add up to the closing balance`, opening + net === closing, money(net));
}
const ofx = run('ofxdump.exe', [join(statements, 'statement.ofx')]).out;
const ids = [...ofx.matchAll(/Financial institution's ID for this transaction:\s*(\S+)/g)].map((match) => match[1]);
check('OFX: transaction ids are unique, so re-importing can spot duplicates', ids.length > 0 && new Set(ids).size === ids.length);

// ---------- MT940 and camt.053, through AqBanking ----------

say('');
const aqVersion = /version\s+([\d.]+)/.exec(run('aqbanking-cli.exe', ['--help']).out)?.[1];
say(`AqBanking: ${aqVersion ?? 'unknown version'}`);

function aqbanking(label, importer, profile, file) {
  const context = join(home, `${importer}.ctx`);
  const imported = run('aqbanking-cli.exe', [
    'import',
    '-c',
    context,
    `--importer=${importer}`,
    `--profile=${profile}`,
    '-f',
    join(statements, file),
  ]);
  check(`${label}: imported`, imported.code === 0, `exit ${imported.code}`);
  if (imported.code !== 0) return;

  const rows = run('aqbanking-cli.exe', ['listtrans', '-c', context])
    .out.split('\n')
    .map((line) => line.split('\t'))
    .filter((cells) => /^\d\d\.\d\d\.\d{4}$/.test(cells[0] ?? ''));
  const net = rows.reduce((sum, cells) => sum + cents(cells[1] ?? '0'), 0n);
  check(`${label}: transactions add up to the closing balance`, rows.length > 0 && opening + net === closing, `${rows.length} transactions, net ${money(net)}`);

  // Read the balance from the context AqBanking saved. `listbal` only prints
  // some balance types, and MT940 balances are stored as "noted", so it shows
  // nothing for them even though they were read correctly.
  const saved = readFileSync(context, 'utf8');
  const list = /balanceList\s*\{([\s\S]*?)\}\s*#balanceList/.exec(saved)?.[1] ?? '';
  const reported = [...list.matchAll(/value="(-?\d+)%2F100%3AUSD"/g)].map((match) => BigInt(match[1]));
  check(
    `${label}: stored the closing balance`,
    reported.includes(closing),
    reported.map(money).join(', '),
  );
}

aqbanking('MT940', 'swift', 'SWIFT-MT940', 'statement.sta');
aqbanking('camt.053.001.08', 'xml', 'camt_053_001_08', 'statement.camt053.xml');

rmSync(home, { recursive: true, force: true });

say('');
say(failed === 0 ? 'All checks passed.' : `${failed} checks failed.`);
if (logFile) {
  mkdirSync(join(logFile, '..'), { recursive: true });
  writeFileSync(logFile, `${log.join('\n')}\n`);
}
process.exit(failed === 0 ? 0 : 1);
