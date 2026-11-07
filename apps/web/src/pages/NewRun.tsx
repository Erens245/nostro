import { useRef, useState } from 'react';
import { formatCents } from '@nostro/bankfiles';
import { go, usePortal } from '../App.tsx';
import { request } from '../api.ts';
import type { Call, Preview, PreviewLine } from '../api.ts';
import { send } from '../sign.ts';
import { FORMAT_NAMES, Money, Notice, PageHead, PayeeStatus, routeLabel, useAction } from '../ui.tsx';

const baseToUsd = (base: string): string => formatCents((BigInt(base) + 5_000n) / 10_000n);

function Route({ line }: { line: PreviewLine }) {
  if (!line.route) return <span className="muted">No route yet</span>;
  return <span>{routeLabel(line.route)}</span>;
}

function Comparison({ preview }: { preview: Preview }) {
  const { comparison } = preview;
  if (comparison.quotedLines === 0) return null;
  return (
    <section className="compare">
      <div>
        <p className="field-label">Estimated routing cost</p>
        <Money value={comparison.feeUsd} large />
        <p className="muted small">Live NEAR Intents quotes for {comparison.quotedLines} payments</p>
      </div>
      <div className="compare-versus">
        <p className="field-label">The same payments by wire</p>
        <Money value={`${comparison.wireFeeUsd}.00`} large />
        <p className="muted small">{comparison.note}</p>
      </div>
    </section>
  );
}

export function NewRun() {
  const { config, staff } = usePortal();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reading = useAction();
  const submitting = useAction();

  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    setFile(chosen);
    setPreview(null);
    void reading.run(async () => {
      setPreview(
        await request<Preview>('/api/preview', { method: 'POST', body: await chosen.arrayBuffer() }),
      );
    });
  };

  const submit = () =>
    submitting.run(async () => {
      if (!file) return;
      const { draftId, call } = await request<{ draftId: string; call: Call }>('/api/drafts', {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent(file.name) },
        body: await file.arrayBuffer(),
      });
      const result = await send(staff, config.contractId, call, draftId);
      const submitted = result.events.find((event) => event.event === 'run_submitted');
      go(submitted ? `run/${String(submitted.data['run_id'])}` : 'runs');
    });

  const errors = preview?.run.issues.filter((issue) => issue.severity === 'error') ?? [];
  const warnings = preview?.run.issues.filter((issue) => issue.severity === 'warning') ?? [];

  return (
    <>
      <PageHead
        title="New payment run"
        lead="Upload the payment file from your accounting or payroll software. You don’t need to change how it’s made."
      />

      <button
        type="button"
        className={dragging ? 'drop drop-active' : 'drop'}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          choose(event.dataTransfer.files[0]);
        }}
      >
        <strong>{file ? file.name : 'Drop a payment file here, or choose one'}</strong>
        <span>ISO 20022 pain.001 · NACHA ACH · CSV</span>
      </button>
      <input
        ref={input}
        type="file"
        hidden
        aria-label="Payment file"
        accept=".xml,.ach,.txt,.csv,.tsv"
        onChange={(event) => choose(event.target.files?.[0])}
      />

      {reading.busy ? <p className="muted">Reading the file…</p> : null}
      {reading.error ? (
        <Notice tone="bad" title="This file could not be read">
          {reading.error}
        </Notice>
      ) : null}

      {preview ? (
        <>
          <dl className="file-facts">
            <div>
              <dt>Type</dt>
              <dd>{FORMAT_NAMES[preview.run.format] ?? preview.run.format}</dd>
            </div>
            <div>
              <dt>File id</dt>
              <dd className="mono">{preview.run.messageId}</dd>
            </div>
            <div>
              <dt>Payments</dt>
              <dd>{preview.lines.length}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>
                <Money value={formatCents(BigInt(preview.run.controlSumMinor))} />
              </dd>
            </div>
            {preview.run.requestedExecutionDate ? (
              <div>
                <dt>Pay on</dt>
                <dd>{preview.run.requestedExecutionDate}</dd>
              </div>
            ) : null}
          </dl>

          {preview.duplicate ? (
            <Notice tone="bad" title="This file has already been submitted">
              Paying it again would pay everyone twice, so it can’t be submitted.
            </Notice>
          ) : null}
          {errors.length > 0 ? (
            <Notice tone="bad" title={`${errors.length} problem${errors.length === 1 ? '' : 's'} to fix in the file`}>
              <ul>
                {errors.map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {warnings.length > 0 ? (
            <Notice tone="warn" title="Worth checking">
              <ul>
                {warnings.map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {preview.missing.length > 0 ? (
            <Notice tone="warn" title={`${preview.missing.length} payee${preview.missing.length === 1 ? ' has' : 's have'} no payout route`}>
              <a href="#payees">Add them on the Payees page</a>, then upload this file again.
            </Notice>
          ) : null}

          <Comparison preview={preview} />

          <table>
            <thead>
              <tr>
                <th>Payee</th>
                <th>Reference</th>
                <th>Paid in</th>
                <th>Payee status</th>
                <th className="number">Routing cost</th>
                <th className="number">Amount</th>
              </tr>
            </thead>
            <tbody>
              {preview.lines.map((line) => (
                <tr key={line.index}>
                  <td>
                    {line.creditorName}
                    <span className="sub mono">{line.creditorAccount.value}</span>
                  </td>
                  <td>{line.remittance ?? '—'}</td>
                  <td>
                    <Route line={line} />
                  </td>
                  <td>
                    <PayeeStatus state={line.state} />
                  </td>
                  <td className="number">
                    {line.estimate ? <Money value={baseToUsd(line.estimate.feeBase)} /> : '—'}
                  </td>
                  <td className="number">
                    <Money value={formatCents(BigInt(line.amountMinor))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {submitting.error ? (
            <Notice tone="bad" title="This run was not submitted">
              {submitting.error}
            </Notice>
          ) : null}
          <div className="actions">
            <button className="primary" type="button" disabled={!preview.canSubmit || submitting.busy} onClick={() => void submit()}>
              {submitting.busy ? 'Submitting…' : 'Submit for approval'}
            </button>
            <p className="muted small">Nothing is paid until someone other than you approves it.</p>
          </div>
        </>
      ) : null}
    </>
  );
}
