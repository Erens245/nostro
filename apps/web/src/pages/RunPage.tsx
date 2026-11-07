import { useEffect, useState } from 'react';
import {
  compareRunToFile,
  formatCents,
  payeeKey,
  readPaymentFile,
  sha256Hex,
} from '@nostro/bankfiles';
import type { CanonicalRun, LineMismatch, RecordedLine } from '@nostro/bankfiles';
import { usePortal } from '../App.tsx';
import { postJson, request } from '../api.ts';
import type { RunDetail } from '../api.ts';
import { verifyRoutedLines } from '../quote-check.ts';
import type { SignedQuote, Token } from '../quote-check.ts';
import { send } from '../sign.ts';
import {
  FORMAT_NAMES,
  Loading,
  Money,
  Notice,
  PageHead,
  PaymentStatus,
  RunStatus,
  saveFile,
  shortHash,
  useAction,
  useLoad,
} from '../ui.tsx';

interface DeviceCheck {
  matches: boolean;
  fileMatches: boolean;
  mismatches: LineMismatch[];
  computed: string;
  chainHash: string;
  fromChain: boolean;
  run: CanonicalRun;
}

interface RecordedRun {
  file_sha256: string;
  lines: (RecordedLine & { receiver: string })[];
}

/** Routing cost the approver will accept on a line, on mainnet. */
const MAX_FEE_BPS = 100;

const ONE_CLICK = 'https://1click.chaindefuser.com/v0';

/** Reads the contract directly, so the answer doesn't pass through our server. */
async function chainView<T>(
  rpcUrl: string,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'nostro',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = (await response.json()) as { result?: { result?: number[] } };
  if (!body.result?.result) throw new Error('This device could not read the chain directly.');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result))) as T | null;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Re-reads the original file on the approver's own device, then compares it with
 * what is recorded on chain, line by line. A matching file hash alone would not
 * be enough: money follows the recorded lines, which arrive separately from the
 * file, so a dishonest submitter could pair a genuine file with altered lines.
 */
function useDeviceCheck(detail: RunDetail | null) {
  const { config } = usePortal();
  const [check, setCheck] = useState<DeviceCheck | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!detail) return;
    let stale = false;
    void (async () => {
      try {
        const response = await fetch(`/api/runs/${detail.id}/file`);
        if (!response.ok) throw new Error('This server does not hold the original file.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const computed = sha256Hex(bytes);
        // Only the simulated preview has no chain to read. Anywhere else, a
        // failed read throws, because trusting the server's copy instead would
        // defeat the point. With no check result, Approve stays disabled.
        const direct = config.rpcUrl
          ? await chainView<RecordedRun>(config.rpcUrl, config.contractId, 'get_run', { run_id: detail.id })
          : null;
        if (config.rpcUrl && !direct) throw new Error('This run is not on chain.');
        const chainHash = direct?.file_sha256 ?? detail.fileSha256;
        const run = readPaymentFile(bytes, { company: config.company });
        const fileMatches = computed === chainHash;
        const recorded = direct?.lines ?? detail.recordedLines;
        const mainnet = config.network === 'mainnet';
        const mismatches = compareRunToFile(run, recorded, { maxFeeBps: mainnet ? MAX_FEE_BPS : 0 });
        if (mainnet) {
          mismatches.push(
            ...(await verifyRoutedLines(
              run.lines.map((line) => ({
                index: line.index,
                name: line.creditorName,
                payeeKey: payeeKey(line.creditorAccount),
                depositAddress: recorded[line.index]?.receiver ?? '',
                route: detail.lines[line.index]?.route ?? null,
                principalBase: line.amountMinor * 10_000n,
              })),
              {
                contractId: config.contractId,
                approvedRouteHash: async (key) => {
                  const payee = await chainView<{ route_hash: string; approved_by: string | null }>(
                    config.rpcUrl,
                    config.contractId,
                    'get_payee',
                    { payee_key: key },
                  );
                  return payee?.approved_by ? payee.route_hash : null;
                },
                status: async (address) =>
                  (
                    await getJson<{ quoteResponse: SignedQuote }>(
                      `${ONE_CLICK}/status?depositAddress=${encodeURIComponent(address)}`,
                    )
                  ).quoteResponse,
                tokens: () => getJson<Token[]>(`${ONE_CLICK}/tokens`),
              },
            )),
          );
        }
        if (!stale) {
          setCheck({
            matches: fileMatches && mismatches.length === 0,
            fileMatches,
            mismatches,
            computed,
            chainHash,
            fromChain: direct !== null,
            run,
          });
        }
      } catch (error) {
        if (!stale) setProblem(error instanceof Error ? error.message : 'The check failed.');
      }
    })();
    return () => {
      stale = true;
    };
  }, [detail?.id, detail?.fileSha256, config]);

  return { check, problem };
}

function DecisionPanel({ detail, check, onDone }: { detail: RunDetail; check: DeviceCheck | null; onDone: () => Promise<void> }) {
  const { config, staff } = usePortal();
  const action = useAction();
  const [reason, setReason] = useState('');

  if (staff.role !== 'Checker' || detail.status !== 'Submitted') return null;

  if (detail.maker === staff.accountId) {
    return (
      <Notice tone="warn" title="You submitted this run">
        Someone else has to approve it. The contract enforces that, whatever this page says.
      </Notice>
    );
  }

  const decide = (call: { method: string; args: Record<string, unknown> }) =>
    action.run(async () => {
      await send(staff, config.contractId, call);
      await onDone();
    });

  return (
    <section className="decision">
      <h2>Your decision</h2>
      <p>
        You’re approving {detail.lineCount} payments totalling <Money value={detail.totalUsd} />, in the file with
        hash <span className="mono">{shortHash(detail.fileSha256)}</span>.
      </p>
      <div className="actions">
        <button
          className="primary"
          type="button"
          disabled={action.busy || !check?.matches}
          onClick={() => void decide({ method: 'approve_run', args: { run_id: detail.id, file_sha256: detail.fileSha256 } })}
        >
          {action.busy ? 'Working…' : 'Approve'}
        </button>
        <input
          aria-label="Reason for rejecting"
          placeholder="Reason for rejecting"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <button
          type="button"
          disabled={action.busy || reason.trim() === ''}
          onClick={() => void decide({ method: 'reject_run', args: { run_id: detail.id, reason: reason.trim() } })}
        >
          Reject
        </button>
      </div>
      {action.error ? (
        <Notice tone="bad" title="That was refused">
          {action.error}
        </Notice>
      ) : null}
    </section>
  );
}

export function RunPage({ id }: { id: number }) {
  const { data: detail, error, refresh } = useLoad(() => request<RunDetail>(`/api/runs/${id}`), [id]);
  const { check, problem } = useDeviceCheck(detail);
  const release = useAction();
  const [held, setHeld] = useState<string | null>(null);

  if (error) {
    return (
      <Notice tone="bad" title={`Run ${id} could not be loaded`}>
        {error}
      </Notice>
    );
  }
  if (!detail) return <Loading what={`run ${id}`} />;

  const payable = detail.status === 'Approved' || detail.status === 'Executing';
  const pay = () =>
    release.run(async () => {
      const result = await postJson<{ sent: number[]; held: { line: number; reason: string }[] }>(
        `/api/runs/${id}/execute`,
        {},
      );
      setHeld(result.held.length > 0 ? `${result.held.length} held` : null);
      await refresh();
    });

  return (
    <>
      <PageHead
        title={`Run ${detail.id}`}
        lead={`${FORMAT_NAMES[detail.format ?? ''] ?? 'Payment file'} · ${detail.messageId ?? 'file not on this server'}`}
        side={<RunStatus status={detail.status} />}
      />

      <dl className="file-facts">
        <div>
          <dt>Total</dt>
          <dd>
            <Money value={detail.totalUsd} />
          </dd>
        </div>
        <div>
          <dt>Submitted by</dt>
          <dd className="mono">{detail.maker}</dd>
        </div>
        <div>
          <dt>Approved by</dt>
          <dd className="mono">{detail.approvals.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>File hash</dt>
          <dd className="mono">{shortHash(detail.fileSha256)}</dd>
        </div>
      </dl>

      {detail.rejectedReason ? (
        <Notice tone="bad" title="This run was rejected">
          {detail.rejectedReason}
        </Notice>
      ) : null}

      {check ? (
        check.matches ? (
          <Notice tone="good" title="Checked on this device">
            This browser read the original file. Its hash and all {check.run.lines.length} payments match what’s
            recorded {check.fromChain ? 'on chain' : 'for this run'}, and the payees below come from that file.
          </Notice>
        ) : (
          <Notice tone="bad" title="Do not approve this run">
            {check.fileMatches ? (
              <>
                The file is genuine, but what’s recorded to be paid is different from it.
                <ul>
                  {check.mismatches.map((mismatch, index) => (
                    <li key={index}>{mismatch.message}</li>
                  ))}
                </ul>
              </>
            ) : (
              'The file on this server does not match the one recorded on chain.'
            )}
          </Notice>
        )
      ) : problem ? (
        <Notice tone="warn" title="This device could not check the file">
          {problem}
        </Notice>
      ) : (
        <p className="muted">Checking the file on this device…</p>
      )}

      <table>
        <thead>
          <tr>
            <th>Payee</th>
            <th>Reference</th>
            <th>Status</th>
            <th>Why</th>
            <th className="number">Amount</th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((line) => {
            const fromFile = check?.run.lines[line.index];
            return (
              <tr key={line.index}>
                <td>
                  {fromFile?.creditorName ?? line.creditorName ?? 'Unknown'}
                  <span className="sub mono">{fromFile?.creditorAccount.value ?? line.receiver}</span>
                </td>
                <td>{fromFile?.remittance ?? line.remittance ?? '—'}</td>
                <td>
                  <PaymentStatus code={line.iso.status} />
                </td>
                <td className="small">{line.iso.reasonText ?? '—'}</td>
                <td className="number">
                  <Money value={fromFile ? formatCents(fromFile.amountMinor) : line.amountUsd} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <DecisionPanel detail={detail} check={check} onDone={refresh} />

      <div className="actions">
        {payable ? (
          <button className="primary" type="button" disabled={release.busy} onClick={() => void pay()}>
            {release.busy ? 'Paying…' : 'Release payments'}
          </button>
        ) : null}
        <button type="button" onClick={() => saveFile(`/api/runs/${id}/pain002`)}>
          Download status report
        </button>
        {held ? <span className="muted small">{held}. See the table for why.</span> : null}
      </div>
      {release.error ? (
        <Notice tone="bad" title="Payments were not released">
          {release.error}
        </Notice>
      ) : null}
    </>
  );
}
