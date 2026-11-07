// Writes a camt.053.001.08 bank statement, the format ERP systems import to
// reconcile their cash accounts. Element order follows the XSD exactly.

import { formatCents } from './money.ts';
import { PEG_NOTE, prepareStatement } from './statement.ts';
import type { PreparedEntry, PreparedStatement } from './statement.ts';
import type { StatementInput } from './types.ts';
import { clip, document, group, leaf } from './xml.ts';

const NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08';

const amount = (cents: bigint, ccy: string, name = 'Amt'): string | null =>
  leaf(name, formatCents(cents), { Ccy: ccy });

const indicator = (direction: 'credit' | 'debit'): string =>
  direction === 'credit' ? 'CRDT' : 'DBIT';

function balance(code: 'OPBD' | 'CLBD', cents: bigint, ccy: string, date: string): string | null {
  const negative = cents < 0n;
  return group(
    'Bal',
    group('Tp', group('CdOrPrtry', leaf('Cd', code))),
    amount(negative ? -cents : cents, ccy),
    leaf('CdtDbtInd', negative ? 'DBIT' : 'CRDT'),
    group('Dt', leaf('Dt', date)),
  );
}

/** PMNT/ICDT is an issued credit transfer, PMNT/RCDT a received one. */
function transactionCode(entry: PreparedEntry): string | null {
  const family = entry.direction === 'debit' ? 'ICDT' : 'RCDT';
  return group(
    'BkTxCd',
    group('Domn', leaf('Cd', 'PMNT'), group('Fmly', leaf('Cd', family), leaf('SubFmlyCd', 'XBCT'))),
  );
}

function otherAccount(name: string, value: string): string | null {
  return group(name, group('Id', group('Othr', leaf('Id', clip(value, 34)))));
}

function parties(entry: PreparedEntry): string | null {
  if (!entry.counterpartyName && !entry.counterpartyAccount) return null;
  const party = entry.counterpartyName
    ? group('Pty', leaf('Nm', clip(entry.counterpartyName, 140)))
    : null;
  const isDebit = entry.direction === 'debit';
  return group(
    'RltdPties',
    isDebit ? null : group('Dbtr', party),
    isDebit || !entry.counterpartyAccount ? null : otherAccount('DbtrAcct', entry.counterpartyAccount),
    isDebit ? group('Cdtr', party) : null,
    isDebit && entry.counterpartyAccount ? otherAccount('CdtrAcct', entry.counterpartyAccount) : null,
  );
}

function details(entry: PreparedEntry, ccy: string): string | null {
  const references = group(
    'Refs',
    leaf('AcctSvcrRef', `N${clip(entry.id, 34)}`),
    entry.endToEndId ? leaf('EndToEndId', clip(entry.endToEndId, 35)) : null,
  );
  const hasFee = entry.feeCents !== undefined && entry.principalCents !== undefined;
  return group(
    'NtryDtls',
    group(
      'TxDtls',
      references,
      amount(entry.cents, ccy),
      leaf('CdtDbtInd', indicator(entry.direction)),
      hasFee ? group('AmtDtls', group('TxAmt', amount(entry.principalCents ?? 0n, ccy))) : null,
      transactionCode(entry),
      hasFee ? group('Chrgs', amount(entry.feeCents ?? 0n, ccy, 'TtlChrgsAndTaxAmt')) : null,
      parties(entry),
      entry.remittance ? group('RmtInf', leaf('Ustrd', clip(entry.remittance, 140))) : null,
      entry.txHash ? leaf('AddtlTxInf', clip(`NEAR transaction ${entry.txHash}`, 500)) : null,
    ),
  );
}

function statementEntry(entry: PreparedEntry, ccy: string): string | null {
  return group(
    'Ntry',
    leaf('NtryRef', clip(entry.id, 35)),
    amount(entry.cents, ccy),
    leaf('CdtDbtInd', indicator(entry.direction)),
    group('Sts', leaf('Cd', 'BOOK')),
    group('BookgDt', leaf('Dt', entry.date)),
    group('ValDt', leaf('Dt', entry.date)),
    leaf('AcctSvcrRef', `N${clip(entry.id, 34)}`),
    transactionCode(entry),
    details(entry, ccy),
    entry.kind === 'rounding' ? leaf('AddtlNtryInf', entry.remittance) : null,
  );
}

function summary(statement: PreparedStatement, ccy: string): string | null {
  const credits = statement.entries.filter((e) => e.direction === 'credit');
  const debits = statement.entries.filter((e) => e.direction === 'debit');
  const net = statement.creditCents - statement.debitCents;
  return group(
    'TxsSummry',
    group(
      'TtlNtries',
      leaf('NbOfNtries', String(statement.entries.length)),
      leaf('Sum', formatCents(statement.creditCents + statement.debitCents)),
      group(
        'TtlNetNtry',
        leaf('Amt', formatCents(net < 0n ? -net : net)),
        leaf('CdtDbtInd', net < 0n ? 'DBIT' : 'CRDT'),
      ),
    ),
    group(
      'TtlCdtNtries',
      leaf('NbOfNtries', String(credits.length)),
      leaf('Sum', formatCents(statement.creditCents)),
    ),
    group(
      'TtlDbtNtries',
      leaf('NbOfNtries', String(debits.length)),
      leaf('Sum', formatCents(statement.debitCents)),
    ),
  );
}

export function writeCamt053(input: StatementInput): string {
  const statement = prepareStatement(input);
  const ccy = input.currency;
  const note = `${PEG_NOTE} Account ${input.accountId}.`;

  const account = group(
    'Acct',
    group(
      'Id',
      group('Othr', leaf('Id', clip(input.accountId, 34)), group('SchmeNm', leaf('Prtry', 'NEAR'))),
    ),
    leaf('Ccy', ccy),
    leaf('Nm', clip(input.accountName, 70)),
    group('Ownr', leaf('Nm', clip(input.ownerName, 140))),
  );

  const body = group(
    'BkToCstmrStmt',
    group('GrpHdr', leaf('MsgId', clip(input.statementId, 35)), leaf('CreDtTm', input.createdAt)),
    group(
      'Stmt',
      leaf('Id', clip(input.statementId, 35)),
      leaf('CreDtTm', input.createdAt),
      group(
        'FrToDt',
        leaf('FrDtTm', `${input.periodFrom}T00:00:00Z`),
        leaf('ToDtTm', `${input.periodTo}T23:59:59Z`),
      ),
      account,
      balance('OPBD', statement.openingCents, ccy, input.periodFrom),
      balance('CLBD', statement.closingCents, ccy, input.periodTo),
      summary(statement, ccy),
      ...statement.entries.map((entry) => statementEntry(entry, ccy)),
      leaf('AddtlStmtInf', clip(note, 500)),
    ),
  );
  return document(NAMESPACE, body);
}
