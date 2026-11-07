#!/usr/bin/env node
// Downloads the ISO 20022 schemas used to validate our XML, and refuses any
// file that does not match a pinned SHA-256. The schemas are not in this repo
// because their licence limits redistribution. See schemas/README.md.
//
// A missing schema is reported, not hidden: tests that need one say SKIP.
// Exit code is 0 unless --strict is passed.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, 'cache');
const strict = process.argv.includes('--strict');

const mirror = 'https://raw.githubusercontent.com/qianbaidu1266/ISO20022-Messages/main';

// SHA-256 of the text with any BOM removed, CRLF turned into LF, and trailing
// whitespace reduced to one newline, so line endings cannot change the result.
export const SCHEMAS = {
  'pain.001.001.03': 'ae2bbba02a6be0119a26f4afcb65ced067453cb1b81d38b26bcc569f19eca93e',
  'pain.001.001.09': '05440a7e84f695e7dbc6677082f43623cd7393881b76a5e8d648ae21d7d728e3',
  'pain.002.001.10': '22a9dda9d006c21fd368f44e9fae812e7b5cde95b6774f31289c372242aac906',
  'camt.053.001.08': 'ca0b135cc8e2dde5b2f99af6b6c514a8f29d6e7c6cf98e9ea84d247189868ff5',
};

function normalize(bytes) {
  const text = bytes
    .toString('utf8')
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
  return Buffer.from(`${text}\n`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function localSources(name) {
  // npm dev dependencies that happen to ship the same files.
  const root = join(here, '..', 'node_modules');
  return [
    join(root, 'sepa-xml-ts', 'schemas', 'iso20022', `${name}.xsd`),
    join(root, 'camt-parser', 'schemas', `${name}.xsd`),
  ];
}

function remoteSources(name) {
  const family = name.slice(0, 4);
  return [
    `${mirror}/Archive/${family}/${name}.xsd`,
    `${mirror}/Message%20Definitions/${family}/${name}.xsd`,
  ];
}

async function obtain(name, expected) {
  const target = join(cache, `${name}.xsd`);
  if (existsSync(target) && sha256(normalize(readFileSync(target))) === expected) {
    return 'cached';
  }
  for (const path of localSources(name)) {
    if (!existsSync(path)) continue;
    const bytes = normalize(readFileSync(path));
    if (sha256(bytes) === expected) {
      writeFileSync(target, bytes);
      return 'npm package';
    }
  }
  for (const url of remoteSources(name)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) continue;
      const bytes = normalize(Buffer.from(await response.arrayBuffer()));
      if (sha256(bytes) === expected) {
        writeFileSync(target, bytes);
        return 'mirror';
      }
      console.warn(`  ${name}: ${url} did not match the pinned hash, ignored`);
    } catch {
      // Try the next source.
    }
  }
  return null;
}

mkdirSync(cache, { recursive: true });
let missing = 0;
for (const [name, expected] of Object.entries(SCHEMAS)) {
  const from = await obtain(name, expected);
  if (from) {
    console.log(`schema ${name}: ok (${from})`);
  } else {
    missing += 1;
    console.warn(`schema ${name}: NOT AVAILABLE, tests that need it will be skipped`);
  }
}
if (missing > 0 && strict) process.exitCode = 1;
