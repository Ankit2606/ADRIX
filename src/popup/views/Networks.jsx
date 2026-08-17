import { useState } from 'react';
import { call } from '../../lib/ui.js';
import { BackBar } from '../components/common.jsx';

const EMPTY = { name: '', chainId: '', rpc: '', symbol: '', explorer: '' };

export default function Networks({ state, go, refresh }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const networks = Object.values(state.networks);

  const select = async (chainId) => {
    await call('SET_CHAIN', { chainId });
    await refresh();
    go('home');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const chainId = form.chainId.startsWith('0x')
        ? form.chainId.toLowerCase()
        : '0x' + Number(form.chainId).toString(16);
      if (!testResult?.ok || testResult.chainId !== chainId || testResult.rpc !== form.rpc) {
        throw new Error('Test this RPC URL before adding the network.');
      }
      await call('ADD_NETWORK', { network: { ...form, chainId } });
      await refresh();
      setAdding(false);
      setForm(EMPTY);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const updateForm = (key, value) => {
    setForm({ ...form, [key]: value });
    setTestResult(null);
    setError('');
  };

  const testRpc = async () => {
    setBusy(true);
    setError('');
    setTestResult(null);
    try {
      const chainId = form.chainId.startsWith('0x')
        ? form.chainId.toLowerCase()
        : '0x' + Number(form.chainId).toString(16);
      const result = await call('TEST_RPC', { network: { ...form, chainId } });
      setTestResult({ ...result, rpc: form.rpc });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <BackBar title="Networks" onBack={() => go('home')} />
      <div className="scroll pad stack">
        {adding ? (
          <div className="card">
            <h2>Add a network</h2>
            {['name', 'chainId', 'rpc', 'symbol', 'explorer'].map((key) => (
              <label className="field" key={key}>
                <span>{FIELD_LABELS[key]}</span>
                <input
                  className={key === 'name' ? '' : 'mono'}
                  value={form[key]}
                  placeholder={PLACEHOLDERS[key]}
                  onChange={(e) => updateForm(key, e.target.value)}
                  spellCheck="false"
                />
              </label>
            ))}
            {testResult?.ok && (
              <div className="ok">
                RPC connected in {testResult.latencyMs}ms at block {testResult.blockNumber}.
              </div>
            )}
            <p className="small">
              A wrong chain ID lets a network sign transactions valid on a different chain. Check it against
              chainlist.org.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="row2">
              <button className="ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="ghost" disabled={busy || !form.rpc || !form.chainId} onClick={testRpc}>
                {busy ? 'Testing...' : 'Test RPC'}
              </button>
            </div>
            <button
              className="primary"
              disabled={
                busy ||
                !form.name ||
                !form.rpc ||
                !form.chainId ||
                !testResult?.ok ||
                testResult.rpc !== form.rpc
              }
              onClick={submit}
            >
                Add network
            </button>
          </div>
        ) : (
          <div className="list">
            {networks.map((network) => (
              <div className="item" key={network.chainId} onClick={() => select(network.chainId)}>
                <span
                  className="dot"
                  style={{ background: network.chainId === state.chainId ? 'var(--accent)' : 'var(--line)' }}
                />
                <div className="item-main">
                  <span className="item-title">{network.name}</span>
                  <span className="item-sub">
                    {network.chainId} · {network.symbol}
                  </span>
                </div>
                <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
                  {network.testnet && <span className="badge">testnet</span>}
                  {network.custom && (
                    <button
                      className="link"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await call('REMOVE_NETWORK', { chainId: network.chainId });
                        refresh();
                      }}
                    >
                      remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!adding && (
        <div className="footer">
          <button className="ghost" onClick={() => setAdding(true)}>
            Add a network
          </button>
        </div>
      )}
    </div>
  );
}

const FIELD_LABELS = {
  name: 'Network name',
  chainId: 'Chain ID',
  rpc: 'RPC URL',
  symbol: 'Currency symbol',
  explorer: 'Block explorer (optional)',
};

const PLACEHOLDERS = {
  name: 'My network',
  chainId: '0x1 or 1',
  rpc: 'https://...',
  symbol: 'ETH',
  explorer: 'https://...',
};
