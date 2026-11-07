// Reads ISO 20022 customer credit transfer files, the payment export of most
// ERP and many payroll systems. Versions .03 and .09 differ here in only a few
// places: the BIC element name, and ReqdExctnDt becoming a choice.

import { classifyAccount, finishRun, isNearAccount, issue } from './checks.ts';
import { parseAmount, sha256Hex } from './money.ts';
import type { CanonicalLine, Issue, PayeeAccount, CanonicalRun, SourceFormat } from './types.ts';
import { at, kid, kids, parseXml, textAt } from './xml.ts';
import type { XmlNode } from './xml.ts';

const SUPPORTED: Record<string, SourceFormat> = {
  'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03': 'pain.001.001.03',
  'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09': 'pain.001.001.09',
};

const NOT_PROVIDED = 'NOTPROVIDED';

export function readPain001(xml: string, sourceSha256?: string): CanonicalRun {
  const root = parseXml(xml);
  const format = SUPPORTED[root.uri];
  if (root.local !== 'Document' || !format) {
    throw new Error(
      `This is not a supported payment file. Found ${root.local} in "${root.uri || 'no namespace'}".`,
    );
  }
  const body = kid(root, 'CstmrCdtTrfInitn');
  if (!body) throw new Error('This XML has no credit transfer section.');

  const header = kid(body, 'GrpHdr');
  const issues: Issue[] = [];
  const messageId = textAt(header, 'MsgId');
  if (!messageId) {
    issues.push(issue('error', 'MISSING_MESSAGE_ID', 'The file has no message id (MsgId).'));
  }

  const declaredCountText = textAt(header, 'NbOfTxs');
  const declaredSumText = textAt(header, 'CtrlSum');
  const declaredSum = declaredSumText === undefined ? undefined : parseAmount(declaredSumText);
  if (declaredSum === null) {
    issues.push(
      issue('error', 'INVALID_AMOUNT', `The file total "${declaredSumText}" is not a valid amount.`),
    );
  }

  const paymentBlocks = kids(body, 'PmtInf');
  const first = paymentBlocks[0];
  const lines: CanonicalLine[] = [];
  for (const block of paymentBlocks) {
    checkBlockTotals(block, lines.length, issues);
    for (const transaction of kids(block, 'CdtTrfTxInf')) {
      lines.push(readLine(transaction, lines.length, messageId ?? '', issues));
    }
  }

  const debtorAccount = textAt(first, 'DbtrAcct', 'Id', 'IBAN')
    ?? textAt(first, 'DbtrAcct', 'Id', 'Othr', 'Id');
  const requestedExecutionDate =
    textAt(first, 'ReqdExctnDt', 'Dt') ??
    textAt(first, 'ReqdExctnDt', 'DtTm')?.slice(0, 10) ??
    textAt(first, 'ReqdExctnDt');
  const debtorName = textAt(first, 'Dbtr', 'Nm');

  return finishRun({
    format,
    messageId: messageId ?? '',
    createdAt: textAt(header, 'CreDtTm') ?? '',
    initiatingParty: textAt(header, 'InitgPty', 'Nm') ?? debtorName ?? '',
    ...(debtorName ? { debtorName } : {}),
    ...(debtorAccount ? { debtorAccount } : {}),
    ...(requestedExecutionDate ? { requestedExecutionDate } : {}),
    ...(declaredSum === undefined || declaredSum === null
      ? {}
      : { declaredControlSumMinor: declaredSum }),
    ...(declaredCountText ? { declaredCount: Number(declaredCountText) } : {}),
    lines,
    issues,
    sourceSha256: sourceSha256 ?? sha256Hex(xml),
  });
}

/** PmtInf blocks can carry their own count and total, and they must hold too. */
function checkBlockTotals(block: XmlNode, offset: number, issues: Issue[]): void {
  const transactions = kids(block, 'CdtTrfTxInf');
  const id = textAt(block, 'PmtInfId') ?? `starting at payment ${offset + 1}`;
  const count = textAt(block, 'NbOfTxs');
  if (count !== undefined && Number(count) !== transactions.length) {
    issues.push(
      issue(
        'error',
        'COUNT_MISMATCH',
        `Payment block ${id} says it has ${count} payments, but ${transactions.length} were found.`,
      ),
    );
  }
  const total = textAt(block, 'CtrlSum');
  if (total === undefined) return;
  const declared = parseAmount(total);
  const actual = transactions.reduce(
    (sum, transaction) => sum + (parseAmount(textAt(transaction, 'Amt', 'InstdAmt') ?? '') ?? 0n),
    0n,
  );
  if (declared === null || declared !== actual) {
    issues.push(
      issue(
        'error',
        'CONTROL_SUM_MISMATCH',
        `Payment block ${id} has a total that doesn't match its payments.`,
      ),
    );
  }
}

function readLine(
  transaction: XmlNode,
  index: number,
  messageId: string,
  issues: Issue[],
): CanonicalLine {
  const label = `Payment ${index + 1}`;
  const amountNode = at(transaction, 'Amt', 'InstdAmt');
  let amountMinor = 0n;
  if (!amountNode) {
    issues.push(
      issue(
        'error',
        at(transaction, 'Amt', 'EqvtAmt') ? 'AMOUNT_TYPE_NOT_SUPPORTED' : 'INVALID_AMOUNT',
        `${label} has no instructed amount.`,
        index,
      ),
    );
  } else {
    const parsed = parseAmount(amountNode.text);
    if (parsed === null || parsed === 0n) {
      issues.push(
        issue(
          'error',
          'INVALID_AMOUNT',
          `${label} has an invalid amount: "${amountNode.text.trim()}".`,
          index,
        ),
      );
    } else {
      amountMinor = parsed;
    }
    const currency = amountNode.attrs['Ccy'];
    if (currency !== 'USD') {
      issues.push(
        issue(
          'error',
          'CURRENCY_NOT_SUPPORTED',
          `${label} is in ${currency ?? 'an unstated currency'}. Only USD can be paid.`,
          index,
        ),
      );
    }
  }

  const written = textAt(transaction, 'PmtId', 'EndToEndId');
  let endToEndId = written ?? '';
  if (!written || written === NOT_PROVIDED) {
    endToEndId = `${messageId}-${index + 1}`.slice(-35);
    issues.push(
      issue(
        'warning',
        'END_TO_END_ID_GENERATED',
        `${label} has no end-to-end id, so ${endToEndId} was generated from the file id.`,
        index,
      ),
    );
  }

  const unstructured = kids(kid(transaction, 'RmtInf'), 'Ustrd')
    .map((node) => node.text.trim())
    .filter(Boolean)
    .join(' ');
  const instructionId = textAt(transaction, 'PmtId', 'InstrId');
  const purposeCode = textAt(transaction, 'Purp', 'Cd');

  return {
    index,
    endToEndId,
    ...(instructionId ? { instructionId } : {}),
    amountMinor,
    currency: 'USD',
    creditorName: textAt(transaction, 'Cdtr', 'Nm') ?? '',
    creditorAccount: readCreditorAccount(transaction),
    ...(unstructured ? { remittance: unstructured } : {}),
    ...(purposeCode ? { purposeCode } : {}),
  };
}

function readCreditorAccount(transaction: XmlNode): PayeeAccount {
  const account = kid(transaction, 'CdtrAcct');
  const bic =
    textAt(transaction, 'CdtrAgt', 'FinInstnId', 'BICFI') ??
    textAt(transaction, 'CdtrAgt', 'FinInstnId', 'BIC');
  const withBic = (value: PayeeAccount): PayeeAccount => (bic ? { ...value, routing: bic } : value);

  const iban = textAt(account, 'Id', 'IBAN');
  if (iban) return withBic({ kind: 'IBAN', value: iban });

  const other = textAt(account, 'Id', 'Othr', 'Id') ?? textAt(account, 'Prxy', 'Id');
  const scheme = textAt(account, 'Id', 'Othr', 'SchmeNm', 'Prtry');
  if (other && (scheme?.toUpperCase() === 'NEAR' || isNearAccount(other))) {
    return withBic({ kind: 'NEAR', value: other });
  }
  return other ? withBic(classifyAccount(other)) : { kind: 'ACCOUNT', value: '' };
}
