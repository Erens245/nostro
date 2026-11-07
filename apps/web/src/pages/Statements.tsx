import { useState } from 'react';
import { postJson, request } from '../api.ts';
import type { Verification } from '../api.ts';
import { Loading, Money, Notice, PageHead, saveFile, shortHash, useAction, useLoad } from '../ui.tsx';

const FORMATS = [
  { id: 'camt053', name: 'camt.053', for: 'SAP, Oracle, Odoo and other ERPs' },
  { id: 'ofx', name: 'OFX', for: 'Xero, QuickBooks, GnuCash' },
  { id: 'mt940', name: 'MT940', for: 'Older ERP and bank systems' },
  { id: 'csv', name: 'CSV', for: 'Anyone with a spreadsheet' },
];

const today = (): string => new Date().toISOString().slice(0, 10);

export function Statements() {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const query = `from=${from}&to=${to}`;
  const { data, error, refresh } = useLoad(
    () => request<Verification>(`/api/statements/verify?${query}`),
    [query],
  );
  const anchor = useAction();

  const fix = () =>
    anchor.run(async () => {
      await postJson('/api/statements/anchor', { from, to });
      await refresh();
    });

  return (
    <>
      <PageHead title="Statements" lead="Import these into your accounting software, as you would a bank statement." />

      <div className="form-grid dates">
        <label className="field">
          <span className="field-label">From</span>
          <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">To</span>
          <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>

      {error ? (
        <Notice tone="bad" title="This statement could not be built">
          {error}
        </Notice>
      ) : null}
      {!data && !error ? <Loading what="the statement" /> : null}

      {data ? (
        <>
          <dl className="file-facts">
            <div>
              <dt>Opening</dt>
              <dd>
                <Money value={data.openingUsd} />
              </dd>
            </div>
            <div>
              <dt>Closing</dt>
              <dd>
                <Money value={data.closingUsd} />
              </dd>
            </div>
            <div>
              <dt>Entries</dt>
              <dd>{data.entries}</dd>
            </div>
            <div>
              <dt>Statement</dt>
              <dd className="mono">{data.statementId}</dd>
            </div>
          </dl>

          {data.tie.ties && data.tie.ledgerFoots ? (
            <Notice tone="good" title="This statement ties to the chain">
              Every ledger entry adds up, and the closing ledger balance equals the token balance read from the token
              contract. Anyone can repeat this check, because it needs only public data.
            </Notice>
          ) : (
            <Notice tone="bad" title="This statement does not tie">
              Ledger {data.tie.ledgerBalance}, token {data.tie.tokenBalance}, difference {data.tie.difference} token
              units.
            </Notice>
          )}

          <ul className="formats">
            {FORMATS.map((format) => (
              <li key={format.id}>
                <div>
                  <strong>{format.name}</strong>
                  <span className="muted small">{format.for}</span>
                </div>
                <button type="button" onClick={() => saveFile(`/api/statements/download?${query}&format=${format.id}`)}>
                  Download
                </button>
              </li>
            ))}
          </ul>

          <section className="anchor">
            <h2>Fix this statement on chain</h2>
            {data.anchored ? (
              data.anchorMatches ? (
                <Notice tone="good" title={`Fixed at block ${data.anchorBlock}`}>
                  The hash on chain matches this statement. <span className="mono">{shortHash(data.sha256)}</span>
                </Notice>
              ) : (
                <Notice tone="bad" title="This statement has changed">
                  The hash fixed on chain no longer matches what’s produced now.
                </Notice>
              )
            ) : (
              <>
                <p className="muted small">
                  Records this statement’s hash in the contract, so it can’t be altered later without detection. The
                  contract refuses a closing balance that doesn’t match its own ledger.
                </p>
                <button type="button" disabled={anchor.busy || data.entries === 0} onClick={() => void fix()}>
                  {anchor.busy ? 'Working…' : 'Fix on chain'}
                </button>
              </>
            )}
            {anchor.error ? (
              <Notice tone="bad" title="That was refused">
                {anchor.error}
              </Notice>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}
