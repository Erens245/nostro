import { request } from '../api.ts';
import type { RunSummary } from '../api.ts';
import { Loading, Money, Notice, PageHead, RunStatus, useLoad } from '../ui.tsx';

function RunTable({ runs }: { runs: RunSummary[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>File id</th>
          <th>Submitted by</th>
          <th>Paid</th>
          <th className="number">Total</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>
              <a href={`#run/${run.id}`}>Run {run.id}</a>
            </td>
            <td className="mono">{run.messageId ?? '—'}</td>
            <td className="mono">{run.maker}</td>
            <td>
              {run.sent} of {run.lineCount}
            </td>
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
  );
}

function useRuns() {
  return useLoad(() => request<RunSummary[]>('/api/runs'), []);
}

export function Runs() {
  const { data, error } = useRuns();
  if (error) {
    return (
      <Notice tone="bad" title="Runs could not be loaded">
        {error}
      </Notice>
    );
  }
  if (!data) return <Loading what="runs" />;
  return (
    <>
      <PageHead title="All runs" />
      {data.length === 0 ? <p className="muted">No runs yet.</p> : <RunTable runs={data} />}
    </>
  );
}

export function Approvals() {
  const { data, error } = useRuns();
  if (error) {
    return (
      <Notice tone="bad" title="Runs could not be loaded">
        {error}
      </Notice>
    );
  }
  if (!data) return <Loading what="runs" />;
  const waiting = data.filter((run) => run.status === 'Submitted');
  return (
    <>
      <PageHead title="Approvals" lead="Runs waiting for a second person. Open one to check it on this device before you approve." />
      {waiting.length === 0 ? <p className="muted">Nothing is waiting for you.</p> : <RunTable runs={waiting} />}
    </>
  );
}
