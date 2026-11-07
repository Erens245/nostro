import { Component, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from './api.ts';

/** One broken page must never blank the whole portal. */
export class PageBoundary extends Component<
  { children: ReactNode; page: string },
  { failed: string | null }
> {
  override state = { failed: null as string | null };

  static getDerivedStateFromError(error: unknown): { failed: string } {
    return { failed: error instanceof Error ? error.message : 'Unknown problem' };
  }

  override componentDidUpdate(previous: { page: string }): void {
    if (previous.page !== this.props.page && this.state.failed) this.setState({ failed: null });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Notice tone="bad" title="This page could not be shown">
        No money has moved because of this. Reload, or choose another page. Detail: {this.state.failed}
      </Notice>
    );
  }
}

export type Tone = 'good' | 'warn' | 'bad' | 'plain';

export function Chip({ tone = 'plain', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function Money({ value, large }: { value: string; large?: boolean }) {
  const [whole = '0', cents = '00'] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (
    <span className={large ? 'money money-large' : 'money'}>
      <span className="money-unit">$</span>
      {grouped}
      <span className="money-cents">.{cents}</span>
    </span>
  );
}

export function Notice({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children ? <div className="notice-body">{children}</div> : null}
    </div>
  );
}

export function PageHead({ title, lead, side }: { title: string; lead?: string; side?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lead ? <p className="lead">{lead}</p> : null}
      </div>
      {side ? <div className="page-side">{side}</div> : null}
    </header>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">Loading {what}…</p>;
}

export const messageOf = (error: unknown): string =>
  error instanceof ApiError || error instanceof Error ? error.message : 'That did not work.';

export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (problem) {
      setError(messageOf(problem));
    }
    // The caller passes its own dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, refresh };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run, clearError: () => setError(null) };
}

const RUN_TONES: Record<string, Tone> = {
  Submitted: 'warn',
  Approved: 'plain',
  Executing: 'plain',
  Completed: 'good',
  CompletedWithFailures: 'bad',
  Rejected: 'bad',
};

const RUN_LABELS: Record<string, string> = {
  Submitted: 'Waiting for approval',
  Approved: 'Approved',
  Executing: 'Paying',
  Completed: 'Paid',
  CompletedWithFailures: 'Paid with failures',
  Rejected: 'Rejected',
};

export function RunStatus({ status }: { status: string }) {
  return <Chip tone={RUN_TONES[status] ?? 'plain'}>{RUN_LABELS[status] ?? status}</Chip>;
}

const ISO_LABELS: Record<string, { label: string; tone: Tone }> = {
  PDNG: { label: 'Pending', tone: 'warn' },
  ACCP: { label: 'Accepted', tone: 'plain' },
  ACSP: { label: 'In progress', tone: 'plain' },
  ACSC: { label: 'Settled', tone: 'good' },
  RJCT: { label: 'Rejected', tone: 'bad' },
};

export function PaymentStatus({ code }: { code: string }) {
  const entry = ISO_LABELS[code] ?? { label: code, tone: 'plain' as Tone };
  return <Chip tone={entry.tone}>{entry.label}</Chip>;
}

const PAYEE_LABELS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'good' },
  cooloff: { label: 'Cooling off', tone: 'warn' },
  unapproved: { label: 'Needs approval', tone: 'warn' },
  unknown: { label: 'Not registered', tone: 'bad' },
};

export function PayeeStatus({ state }: { state: string }) {
  const entry = PAYEE_LABELS[state] ?? { label: state, tone: 'plain' as Tone };
  return <Chip tone={entry.tone}>{entry.label}</Chip>;
}

export const FORMAT_NAMES: Record<string, string> = {
  'pain.001.001.03': 'ISO 20022 payment file (pain.001.001.03)',
  'pain.001.001.09': 'ISO 20022 payment file (pain.001.001.09)',
  nacha: 'NACHA ACH file',
  csv: 'Payment list (CSV)',
};

const CHAIN_NAMES: Record<string, string> = {
  near: 'NEAR',
  base: 'Base',
  arb: 'Arbitrum',
  sol: 'Solana',
  tron: 'Tron',
  eth: 'Ethereum',
  pol: 'Polygon',
  bsc: 'BNB Chain',
};

/** 1Click's chain ids are short codes, not names a finance team would know. */
export const routeLabel = (route: { asset: string; chain: string }): string =>
  `${route.asset} on ${CHAIN_NAMES[route.chain] ?? route.chain}`;

export const shortHash = (hash: string): string => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

export function saveFile(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.click();
}
