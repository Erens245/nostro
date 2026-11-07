import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { request } from './api.ts';
import type { PortalConfig } from './api.ts';
import { Approvals, Runs } from './pages/Runs.tsx';
import { NewRun } from './pages/NewRun.tsx';
import { Overview } from './pages/Overview.tsx';
import { Payees } from './pages/Payees.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Statements } from './pages/Statements.tsx';
import { loadStaff, saveStaff } from './sign.ts';
import type { Staff } from './sign.ts';
import { Loading, Notice, PageBoundary, useLoad } from './ui.tsx';

interface Portal {
  config: PortalConfig;
  staff: Staff;
}

const PortalContext = createContext<Portal | null>(null);

export function usePortal(): Portal {
  const portal = useContext(PortalContext);
  if (!portal) throw new Error('usePortal needs a signed-in portal.');
  return portal;
}

export const go = (path: string): void => {
  window.location.hash = path;
};

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const update = () => setHash(window.location.hash.slice(1));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash;
}

const NAV = [
  { path: '', label: 'Overview' },
  { path: 'new', label: 'New payment run', role: 'Maker' },
  { path: 'approvals', label: 'Approvals', role: 'Checker' },
  { path: 'runs', label: 'All runs' },
  { path: 'payees', label: 'Payees' },
  { path: 'statements', label: 'Statements' },
] as const;

function Page({ hash }: { hash: string }) {
  const runMatch = /^run\/(\d+)$/.exec(hash);
  if (runMatch) return <RunPage id={Number(runMatch[1])} />;
  switch (hash) {
    case 'new':
      return <NewRun />;
    case 'approvals':
      return <Approvals />;
    case 'runs':
      return <Runs />;
    case 'payees':
      return <Payees />;
    case 'statements':
      return <Statements />;
    default:
      return <Overview />;
  }
}

export function App() {
  const { data: config, error } = useLoad(() => request<PortalConfig>('/api/config'), []);
  const [staff, setStaff] = useState<Staff | null>(loadStaff);
  const hash = useHash();
  const portal = useMemo(
    () => (config && staff ? { config, staff } : null),
    [config, staff],
  );

  if (error) {
    return (
      <main className="centered">
        <Notice tone="bad" title="The portal could not start">
          {error}
        </Notice>
      </main>
    );
  }
  if (!config) {
    return (
      <main className="centered">
        <Loading what="the portal" />
      </main>
    );
  }
  if (!staff || !portal) {
    return (
      <SignIn
        config={config}
        onSignIn={(next) => {
          saveStaff(next);
          setStaff(next);
        }}
      />
    );
  }

  return (
    <PortalContext.Provider value={portal}>
      <div className="shell">
        <aside className="rail">
          <a className="brand" href="#">
            Nostro
          </a>
          <p className="company">{config.company}</p>
          <nav aria-label="Main">
            {NAV.filter((item) => !('role' in item) || item.role === staff.role).map((item) => (
              <a key={item.path} href={`#${item.path}`} aria-current={hash === item.path ? 'page' : undefined}>
                {item.label}
              </a>
            ))}
          </nav>
          <div className="rail-foot">
            <p className="who">{staff.label}</p>
            <p className="who-account">{staff.accountId}</p>
            <button
              className="link"
              type="button"
              onClick={() => {
                saveStaff(null);
                setStaff(null);
              }}
            >
              Sign out
            </button>
            {config.network === 'testnet' ? (
              <p className="network">Testnet. No real money moves.</p>
            ) : null}
          </div>
        </aside>
        <main className="main">
          <PageBoundary page={hash}>
            <Page hash={hash} />
          </PageBoundary>
        </main>
      </div>
    </PortalContext.Provider>
  );
}
