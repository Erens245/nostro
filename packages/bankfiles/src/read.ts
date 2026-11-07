// Works out what a file is, then hands it to the right reader.

import { readCsv } from './csv.ts';
import type { CsvOptions } from './csv.ts';
import { sha256Hex } from './money.ts';
import { readNacha } from './nacha.ts';
import { readPain001 } from './pain001.ts';
import type { CanonicalRun, SourceFormat } from './types.ts';

export type ReadOptions = Omit<CsvOptions, 'sourceSha256'>;

const toText = (bytes: Uint8Array | string): string =>
  typeof bytes === 'string' ? bytes : new TextDecoder('utf-8').decode(bytes);

export function detectFormat(bytes: Uint8Array | string): SourceFormat | null {
  const text = toText(bytes).replace(/^﻿/, '');
  const head = text.slice(0, 2048);

  if (head.trimStart().startsWith('<')) {
    const match = /urn:iso:std:iso:20022:tech:xsd:(pain\.001\.001\.\d\d)/.exec(head);
    if (match?.[1] === 'pain.001.001.03') return 'pain.001.001.03';
    if (match?.[1] === 'pain.001.001.09') return 'pain.001.001.09';
    return null;
  }

  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  if (firstLine.length === 94 && firstLine.startsWith('1')) return 'nacha';

  const hasDelimiter = /[,;\t|]/.test(firstLine);
  const hasRows = /\r\n|\n|\r/.test(text.trim());
  return hasDelimiter && hasRows ? 'csv' : null;
}

export function readPaymentFile(
  bytes: Uint8Array | string,
  options: ReadOptions = {},
): CanonicalRun {
  const format = detectFormat(bytes);
  const text = toText(bytes);
  const sourceSha256 = sha256Hex(bytes);
  switch (format) {
    case 'pain.001.001.03':
    case 'pain.001.001.09':
      return readPain001(text, sourceSha256);
    case 'nacha':
      return readNacha(text, sourceSha256);
    case 'csv':
      return readCsv(text, { ...options, sourceSha256 });
    default:
      throw new Error(
        'This file type is not recognized. Upload a pain.001 XML, a NACHA file or a CSV.',
      );
  }
}
