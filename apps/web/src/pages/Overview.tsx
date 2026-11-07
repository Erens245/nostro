import { usePortal } from '../App.tsx';
import { request } from '../api.ts';
import type { Overview as OverviewData, RunSummary, Verification } from '../api.ts';
import { Chip, Loading, Money, Notice, PageHead, RunStatus, useLoad } from '../ui.tsx';

const today = (): string => new Date().toISOString().slice(0, 10);
const asUsd = (base: string): string => (Number(BigInt(base) / 10_000n) / 100).toFixed(2);

export function Overview() {
  const { staff } = usePortal();
  const overview = useLoad(() => request<OverviewData>('/api/overview'), []);
  const runs = useLoad(() => request<RunSummary[]>('/api/runs'), []);
  const check = useLoad(
    () => request<Verification>(`/api/statements/verify?from=${today()}&to=${today()}`),
    [],
  );

  if (overview.error) {
    return (
      <Notice tone="bad" title="This account could not be read">
        {overview.error}
      </Notice>
    );
  }
  if (!overview.data) return <Loading what="your account" />;

  const { data } = overview;
  const waiting = runs.data?.filter((run) => run.status === 'Submitted') ?? [];
  const tie = check.data?.tie;

  return (
    <>
      <PageHead title="Overview" />
      <section className="balance">
        <div>
          <p className="field-label">Balance</p>
          <Money value={data.balanceUsd} large />
          <p className="muted small">USDC on NEAR, shown at 1 USDC = 1 USD</p>
        </div>
        <dl className="facts">
          <div>
            <dt>Available now</dt>
            <dd>
              <Money value={data.availableUsd} />
            </dd>
          </div>
          <div>
            <dt>Paid today</dt>
            <dd>
              <Money value={data.spentTodayUsd} />
            </dd>
          </div>
          <div>
            <dt>Daily limit</dt>
            <dd>
              <Money value={asUsd(data.contract.daily_limit)} />
            </dd>
          </div>
        </dl>
      </section>

      {tie ? (
        tie.ties && tie.ledgerFoots ? (
          <Notice tone="good" title="The books match the chain">
            All {tie.entries} ledger entries add up, and the total equals the token balance held by this
            account.
          </Notice>
        ) : (
          <Notice tone="bad" title="The books do not match the chain">
            The token balance differs from the ledger by {tie.difference} token units. Check Statements before
            paying.
          </Notice>
        )
      ) : null}

      {staff.role === 'Checker' && waiting.length > 0 ? (
        <Notice tone="warn" title={`${waiting.length} run${waiting.length === 1 ? '' : 's'} waiting for you`}>
          <a href="#approvals">Review them</a>
        </Notice>
      ) : null}

      <h2>Recent runs</h2>
      {runs.data?.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>File id</th>
              <th>Payments</th>
              <th className="number">Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.data?.slice(0, 6).map((run) => (
              <tr key={run.id}>
                <td>
                  <a href={`#run/${run.id}`}>Run {run.id}</a>
                </td>
                <td className="mono">{run.messageId ?? <Chip>Not on this server</Chip>}</td>
                <td>{run.lineCount}</td>
                <td className="number">
                  <Money value={run.totalUsd} />
                </td>
                <td>
                  <RunStatus status={run.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
