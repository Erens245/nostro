import { useState } from 'react';
import { request } from '../api.ts';
import type { PortalConfig } from '../api.ts';
import type { Staff } from '../sign.ts';
import { Notice, useAction } from '../ui.tsx';

interface Props {
  config: PortalConfig;
  onSignIn: (staff: Staff) => void;
}

const ROLES = {
  Maker: { label: 'Finance clerk', does: 'Uploads payment files and adds payees' },
  Checker: { label: 'Finance director', does: 'Approves what the clerk submits' },
} as const;

export function SignIn({ config, onSignIn }: Props) {
  const [role, setRole] = useState<Staff['role']>('Maker');
  const [accountId, setAccountId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const { busy, error, run } = useAction();

  const demo = (next: Staff['role']) =>
    run(async () => {
      const key = next === 'Maker' ? 'clerk' : 'cfo';
      const signer = await request<{ accountId: string; privateKey: string }>(`/api/demo-key/${key}`);
      onSignIn({ ...signer, role: next, label: ROLES[next].label });
    });

  return (
    <main className="sign-in">
      <section className="sign-in-card">
        <p className="brand brand-dark">Nostro</p>
        <h1>{config.company}</h1>
        <p className="lead">Pay from your NEAR account using the file your accounting software already exports.</p>

        {config.demoKeys ? (
          <div className="demo-roles">
            <p className="field-label">Sign in to the demo as</p>
            {(Object.keys(ROLES) as Staff['role'][]).map((key) => (
              <button key={key} className="role" type="button" disabled={busy} onClick={() => void demo(key)}>
                <strong>{ROLES[key].label}</strong>
                <span>{ROLES[key].does}</span>
              </button>
            ))}
            <p className="muted small">These are throwaway testnet keys, so anyone can try both sides.</p>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSignIn({
                accountId: accountId.trim(),
                privateKey: privateKey.trim(),
                role,
                label: ROLES[role].label,
              });
            }}
          >
            <label className="field">
              <span className="field-label">Your role</span>
              <select value={role} onChange={(event) => setRole(event.target.value as Staff['role'])}>
                <option value="Maker">{ROLES.Maker.label}</option>
                <option value="Checker">{ROLES.Checker.label}</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">NEAR account</span>
              <input
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Staff key</span>
              <input
                type="password"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                autoComplete="current-password"
                required
              />
              <span className="muted small">
                Stays on this device. It can only do your role’s tasks, and it can’t move money by itself.
              </span>
            </label>
            <button className="primary" type="submit">
              Sign in
            </button>
          </form>
        )}
        {error ? (
          <Notice tone="bad" title="Could not sign in">
            {error}
          </Notice>
        ) : null}
      </section>
    </main>
  );
}
