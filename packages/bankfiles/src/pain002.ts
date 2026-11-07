// Writes a pain.002.001.10 payment status report. It is the reply an ERP expects
// after sending a pain.001: which payments were accepted, settled or refused.

import { formatCents } from './money.ts';
import type { LineStatusInput, SourceFormat, StatusInput } from './types.ts';
import { clip, document, group, leaf } from './xml.ts';

const NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:pain.002.001.10';

const originalMessageName = (format: SourceFormat): string =>
  format.startsWith('pain.') ? format : format.toUpperCase();

function reason(line: LineStatusInput): string | null {
  if (!line.reasonCode && !line.reasonText) return null;
  return group(
    'StsRsnInf',
    line.reasonCode ? group('Rsn', leaf('Cd', clip(line.reasonCode, 4))) : null,
    line.reasonText ? leaf('AddtlInf', clip(line.reasonText, 105)) : null,
  );
}

function transaction(line: LineStatusInput): string | null {
  return group(
    'TxInfAndSts',
    line.instructionId ? leaf('OrgnlInstrId', clip(line.instructionId, 35)) : null,
    leaf('OrgnlEndToEndId', clip(line.endToEndId, 35)),
    leaf('TxSts', line.status),
    reason(line),
  );
}

export function writePain002(input: StatusInput): string {
  const body = group(
    'CstmrPmtStsRpt',
    group('GrpHdr', leaf('MsgId', clip(input.messageId, 35)), leaf('CreDtTm', input.createdAt)),
    group(
      'OrgnlGrpInfAndSts',
      leaf('OrgnlMsgId', clip(input.originalMessageId, 35)),
      leaf('OrgnlMsgNmId', originalMessageName(input.originalFormat)),
      input.originalCreatedAt ? leaf('OrgnlCreDtTm', input.originalCreatedAt) : null,
      input.originalCount === undefined ? null : leaf('OrgnlNbOfTxs', String(input.originalCount)),
      input.originalControlSumMinor === undefined
        ? null
        : leaf('OrgnlCtrlSum', formatCents(input.originalControlSumMinor)),
      leaf('GrpSts', input.groupStatus),
    ),
    group(
      'OrgnlPmtInfAndSts',
      leaf('OrgnlPmtInfId', clip(input.originalMessageId, 35)),
      ...input.lines.map(transaction),
    ),
  );
  return document(NAMESPACE, body);
}
