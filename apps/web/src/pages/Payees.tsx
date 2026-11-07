import { useState } from 'react';
import { usePortal } from '../App.tsx';
import { postJson, request } from '../api.ts';
import type { Call, Payee } from '../api.ts';
import { send } from '../sign.ts';
import { Loading, Notice, PageHead, PayeeStatus, routeLabel, useAction, useLoad } from '../ui.tsx';

const CHAINS = [
  { chain: 'near', asset: 'USDC', label: 'USDC on NEAR' },
  { chain: 'base', asset: 'USDC', label: 'USDC on Base' },
  { chain: 'arb', asset: 'USDC', label: 'USDC on Arbitrum' },
  { chain: 'sol', asset: 'USDC', label: 'USDC on Solana' },
  { chain: 'tron', asset: 'USDT', label: 'USDT on Tron' },
];

function AddPayee({ onDone }: { onDone: () => Promise<void> }) {
  const { config, staff } = usePortal();
  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [routeIndex, setRouteIndex] = useState(0);
  const [address, setAddress] = useState('');
  const [testnetReceiver, setTestnetReceiver] = useState('');
  const action = useAction();

  const submit = () =>
    action.run(async () => {
      const choice = CHAINS[routeIndex] ?? CHAINS[0];
      if (!choice) return;
      const { call } = await postJson<{ call: Call }>('/api/payees', {
        name: name.trim(),
        account: account.trim(),
        route: { chain: choice.chain, asset: choice.asset, address: address.trim() },
        ...(testnetReceiver.trim() ? { testnetReceiver: testnetReceiver.trim() } : {}),
      });
      await send(staff, config.contractId, call);
      setName('');
      setAccount('');
      setAddress('');
      setTestnetReceiver('');
      await onDone();
    });

  return (
    <form
      className="form-card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>Add or change a payee</h2>
      <p className="muted small">
        Changing an existing payee’s route removes their approval, and they can’t be paid until someone approves the
        new route. This is what stops the “our bank details have changed” fraud.
      </p>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">Account in your payment file</span>
          <input value={account} onChange={(event) => setAccount(event.target.value)} required placeholder="IBAN, account number or name.near" />
        </label>
        <label className="field">
          <span className="field-label">Pay them in</span>
          <select value={routeIndex} onChange={(event) => setRouteIndex(Number(event.target.value))}>
            {CHAINS.map((item, index) => (
              <option key={item.label} value={index}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Their address</span>
          <input value={address} onChange={(event) => setAddress(event.target.value)} required />
        </label>
        {config.network === 'testnet' ? (
          <label className="field">
            <span className="field-label">Testnet account</span>
            <input
              value={testnetReceiver}
              onChange={(event) => setTestnetReceiver(event.target.value)}
              placeholder="NEAR Intents has no testnet, so this is paid instead"
              required
            />
          </label>
        ) : null}
      </div>
      {action.error ? (
        <Notice tone="bad" title="This payee was not saved">
          {action.error}
        </Notice>
      ) : null}
      <button className="primary" type="submit" disabled={action.busy}>
        {action.busy ? 'Saving…' : 'Save payee'}
      </button>
    </form>
  );
}

export function Payees() {
  const { config, staff } = usePortal();
  const { data, error, refresh } = useLoad(() => request<Payee[]>('/api/payees'), []);
  const approving = useAction();

  if (error) {
    return (
      <Notice tone="bad" title="Payees could not be loaded">
        {error}
      </Notice>
    );
  }
  if (!data) return <Loading what="payees" />;

  const approve = (key: string) =>
    approving.run(async () => {
      await send(staff, config.contractId, { method: 'approve_payee', args: { payee_key: key } });
      await refresh();
    });

  return (
    <>
      <PageHead title="Payees" lead="Who gets paid, and how they want to receive it. A new or changed payee needs a second person." />
      {approving.error ? (
        <Notice tone="bad" title="That was refused">
          {approving.error}
        </Notice>
      ) : null}
      {data.length === 0 ? (
        <p className="muted">No payees yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Account in file</th>
              <th>Paid in</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((payee) => (
              <tr key={payee.key}>
                <td>{payee.name}</td>
                <td className="mono">{payee.account}</td>
                <td>{routeLabel(payee.route)}</td>
                <td>
                  <PayeeStatus state={payee.state} />
                </td>
                <td className="number">
                  {staff.role === 'Checker' && payee.state === 'unapproved' ? (
                    <button type="button" disabled={approving.busy} onClick={() => void approve(payee.key)}>
                      Approve
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {staff.role === 'Maker' ? <AddPayee onDone={refresh} /> : null}
    </>
  );
}
