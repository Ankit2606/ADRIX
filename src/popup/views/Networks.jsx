import { useState } from 'react';
import { call, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState, NetworkHealthPanel } from '../components/common.jsx';

const EMPTY = { name: '', chainId: '', rpc: '', symbol: '', explorer: '', testnet: false };

const FIELD_LABELS = {
  name: 'Network name',
  chainId: 'Chain ID',
  rpc: 'RPC URL',
  symbol: 'Currency symbol',
  explorer: 'Block explorer URL (optional)',
};

const PLACEHOLDERS = {
  name: 'My network',
  chainId: '0x1 or 1',
  rpc: 'https://…',
  symbol: 'ETH',
  explorer: 'https://etherscan.io',
};

export default function Networks({ state, go, refresh }) {
  const [editing, setEditing] = useState(null); // null | 'new' | chainId
  const networks = Object.values(state.allNetworks ?? state.networks);
  const visible = networks.filter((net) => state.showTestnets || !net.testnet || net.chainId === state.chainId);
  const { busy, error, setError, run } = useAsyncAction();

  const select = async (chainId) => {
    await run(async () => {
      await call('SET_CHAIN', { chainId });
      await refresh();
      go('home');
    });
  };

  if (editing) {
    const target = editing === 'new' ? null : networks.find((net) => net.chainId === editing);
    return (
      <NetworkForm
        network={target}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          await refresh();
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div className="screen">
      <BackBar title="Networks" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <label className="check-line card" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={Boolean(state.showTestnets)}
            onChange={async (e) => {
              await call('SET_SHOW_TESTNETS', { value: e.target.checked });
              await refresh();
            }}
          />
          <span className="item-main">
            <span className="item-title">Show test networks</span>
            <span className="small faint">Sepolia, Localhost, and any custom network marked as a testnet</span>
          </span>
        </label>

        <NetworkHealthPanel
          chainId={state.chainId}
          name={state.network?.name}
          initial={state.networkHealth?.status === 'unknown' ? null : state.networkHealth}
        />

        {error && <div className="error" role="alert">{error}</div>}

        {!visible.length ? (
          <EmptyState
            icon="◇"
            title="No networks visible"
            body="Every network is marked as a testnet and testnets are hidden."
          />
        ) : (
          <div className="list">
            {visible.map((network) => (
              <div className="item-pair" key={network.chainId}>
                <button
                  className={`item ${network.chainId === state.chainId ? 'selected' : ''}`}
                  disabled={busy}
                  aria-current={network.chainId === state.chainId ? 'true' : undefined}
                  onClick={() => select(network.chainId)}
                >
                  <span
                    className="dot"
                    style={{ background: network.chainId === state.chainId ? 'var(--accent)' : 'var(--line-strong)' }}
                  />
                  <div className="item-main">
                    <span className="item-title">{network.name}</span>
                    <span className="item-sub">
                      {network.chainId} · {network.symbol}
                    </span>
                    <span className="item-sub">{hostOf(network.rpc)}</span>
                  </div>
                  <span className="item-right">
                    {network.testnet && <span className="badge">testnet</span>}
                    {network.edited && <span className="badge accent">edited</span>}
                    {network.custom && <span className="badge accent">custom</span>}
                  </span>
                </button>
                <button
                  className="link item-aside"
                  onClick={() => setEditing(network.chainId)}
                  aria-label={`Edit ${network.name}`}
                >
                  edit
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="footer">
        <button className="ghost" onClick={() => setEditing('new')}>
          Add a network
        </button>
      </div>
    </div>
  );
}

function NetworkForm({ network, onCancel, onSaved }) {
  const isEdit = Boolean(network);
  const isBuiltIn = isEdit && !network.custom;
  const [form, setForm] = useState(
    isEdit
      ? {
          name: network.name ?? '',
          chainId: network.chainId ?? '',
          rpc: network.rpc ?? '',
          symbol: network.symbol ?? '',
          explorer: network.explorer ?? '',
          testnet: Boolean(network.testnet),
        }
      : EMPTY
  );
  const [testResult, setTestResult] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  // Editing an existing network only needs a re-test when the RPC changes;
  // adding one always does, because an unverified RPC can lie about its chain.
  const rpcChanged = !isEdit || form.rpc !== network.rpc;
  const needsTest = rpcChanged && !(testResult?.ok && testResult.rpc === form.rpc);

  const hexChainId = () => {
    const raw = String(form.chainId).trim();
    if (!raw) throw new Error('Enter a chain ID.');
    return raw.toLowerCase().startsWith('0x') ? raw.toLowerCase() : `0x${Number(raw).toString(16)}`;
  };

  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === 'rpc' || key === 'chainId') setTestResult(null);
    setError('');
  };

  const testRpc = () =>
    run(async () => {
      const result = await call('TEST_RPC', { network: { ...form, chainId: hexChainId() } });
      setTestResult({ ...result, rpc: form.rpc });
    });

  const save = () =>
    run(async () => {
      const chainId = hexChainId();
      if (needsTest) throw new Error('Test the RPC URL before saving.');
      if (isEdit) await call('EDIT_NETWORK', { chainId, network: form });
      else await call('ADD_NETWORK', { network: { ...form, chainId } });
      await onSaved();
    });

  const reset = () =>
    run(async () => {
      await call('RESET_NETWORK', { chainId: network.chainId });
      await onSaved();
    });

  const remove = () =>
    run(async () => {
      await call('REMOVE_NETWORK', { chainId: network.chainId });
      await onSaved();
    });

  return (
    <div className="screen">
      <BackBar title={isEdit ? 'Edit network' : 'Add a network'} onBack={onCancel} />
      <div className="scroll pad stack">
        {(['name', 'chainId', 'rpc', 'symbol', 'explorer']).map((key) => (
          <label className="field" key={key}>
            <span>{FIELD_LABELS[key]}</span>
            <input
              className={key === 'name' ? '' : 'mono'}
              value={form[key]}
              placeholder={PLACEHOLDERS[key]}
              onChange={(e) => update(key, e.target.value)}
              spellCheck="false"
              disabled={key === 'chainId' && isEdit}
              aria-describedby={key === 'chainId' ? 'chainid-help' : undefined}
            />
            {key === 'chainId' && isEdit && (
              <span className="small faint" id="chainid-help">
                Chain ID cannot change — tokens, permissions, and history are keyed to it.
              </span>
            )}
            {key === 'explorer' && (
              <span className="small faint">Used for the "view" links on transactions and addresses.</span>
            )}
          </label>
        ))}

        {!isBuiltIn && (
          <label className="check-line">
            <input type="checkbox" checked={form.testnet} onChange={(e) => update('testnet', e.target.checked)} />
            This is a test network
          </label>
        )}

        {testResult?.ok && <RpcTestResult result={testResult} />}
        {error && <div className="error" role="alert">{error}</div>}

        <p className="small">
          A wrong chain ID lets a network produce signatures that are valid on a different chain. Verify it against
          chainlist.org.
        </p>

        {isEdit && <NetworkHealthPanel chainId={network.chainId} name={network.name} />}

        {isEdit && isBuiltIn && network.edited && (
          <button className="ghost" onClick={reset} disabled={busy}>
            Restore built-in defaults
          </button>
        )}
        {isEdit && network.custom && (
          <button className="danger" onClick={remove} disabled={busy}>
            Delete this network
          </button>
        )}
      </div>

      <div className="footer">
        <div className="row2">
          <button className="ghost" onClick={testRpc} disabled={busy || !form.rpc || !form.chainId}>
            {busy ? 'Testing…' : 'Test RPC'}
          </button>
          <button className="primary" onClick={save} disabled={busy || !form.name || !form.rpc || needsTest}>
            {isEdit ? 'Save changes' : 'Add network'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What the probe actually found. A green tick that only means "answered once"
 * is worse than no test at all, so every check is listed with its result.
 */
function RpcTestResult({ result }) {
  const failing = (result.methods ?? []).filter((m) => !m.ok);

  return (
    <div className={`card ${failing.length || result.warnings?.length ? '' : 'accent'}`}>
      <div className="between">
        <span className="eyebrow">RPC test</span>
        <span className={`badge ${failing.length ? 'failed' : 'confirmed'}`}>
          {failing.length ? 'issues found' : 'passed'}
        </span>
      </div>

      <div className="kv">
        <span className="kv-key">Chain ID</span>
        <span className="kv-value">{result.chainId} — matches</span>
      </div>
      <div className="kv">
        <span className="kv-key">Round trip</span>
        <span className="kv-value">{result.latencyMs}ms</span>
      </div>
      <div className="kv">
        <span className="kv-key">Head block</span>
        <span className="kv-value">
          {result.blockNumber}
          {result.blockAgeMs != null ? ` · ${Math.round(result.blockAgeMs / 1000)}s old` : ''}
        </span>
      </div>
      <div className="kv">
        <span className="kv-key">Fee market</span>
        <span className="kv-value">{result.supportsEip1559 ? 'EIP-1559' : 'legacy gas price'}</span>
      </div>
      {result.clientVersion && (
        <div className="kv">
          <span className="kv-key">Client</span>
          <span className="kv-value">{result.clientVersion}</span>
        </div>
      )}

      {result.methods?.length > 0 && (
        <>
          <span className="eyebrow">Method support</span>
          <div className="method-grid">
            {result.methods.map((entry) => (
              <span key={entry.method} className={`method-chip ${entry.ok ? 'ok' : 'bad'}`}>
                {entry.ok ? '✓' : '✕'} {entry.method}
              </span>
            ))}
          </div>
        </>
      )}

      {result.warnings?.map((warning) => (
        <div className="notice" key={warning}>
          {warning}
        </div>
      ))}
    </div>
  );
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url ?? '';
  }
}
