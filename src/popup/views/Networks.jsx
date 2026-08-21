import { useState } from 'react';
import { call, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState, NetworkHealthPanel } from '../components/common.jsx';

const MAX_RPC_URLS = 6;
const EMPTY = { name: '', chainId: '', rpcUrls: [''], symbol: '', explorer: '', testnet: false };

const FIELD_LABELS = {
  name: 'Network name',
  chainId: 'Chain ID',
  symbol: 'Currency symbol',
  explorer: 'Block explorer URL (optional)',
};

const PLACEHOLDERS = {
  name: 'My network',
  chainId: '0x1 or 1',
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
                    <span className="item-sub">
                      {hostOf(network.rpc)}
                      {network.rpcUrls?.length > 1 && ` +${network.rpcUrls.length - 1} fallback`}
                    </span>
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
          rpcUrls: network.rpcUrls?.length ? [...network.rpcUrls] : [network.rpc ?? ''],
          symbol: network.symbol ?? '',
          explorer: network.explorer ?? '',
          testnet: Boolean(network.testnet),
        }
      : EMPTY
  );
  // url -> test result. Keyed by URL rather than index so reordering the list
  // does not reassign one endpoint's verdict to another.
  const [testResults, setTestResults] = useState({});
  const [testing, setTesting] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  const originalUrls = new Set(isEdit ? (network.rpcUrls ?? [network.rpc]) : []);
  const filledUrls = form.rpcUrls.map((url) => url.trim()).filter(Boolean);

  // Every endpoint the user has not already been running must prove itself
  // before it is saved: an unverified RPC can serve a different chain, and the
  // wallet would then sign against the wrong one.
  const untested = filledUrls.filter((url) => !originalUrls.has(url) && !testResults[url]?.ok);
  const needsTest = untested.length > 0;

  const hexChainId = () => {
    const raw = String(form.chainId).trim();
    if (!raw) throw new Error('Enter a chain ID.');
    return raw.toLowerCase().startsWith('0x') ? raw.toLowerCase() : `0x${Number(raw).toString(16)}`;
  };

  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    // A chain ID change invalidates every verdict — each one was a check that
    // the endpoint serves *that* chain.
    if (key === 'chainId') setTestResults({});
    setError('');
  };

  const updateUrl = (index, value) => {
    setForm((current) => {
      const next = [...current.rpcUrls];
      next[index] = value;
      return { ...current, rpcUrls: next };
    });
    setError('');
  };

  const addUrl = () =>
    setForm((current) =>
      current.rpcUrls.length >= MAX_RPC_URLS ? current : { ...current, rpcUrls: [...current.rpcUrls, ''] }
    );

  const removeUrl = (index) =>
    setForm((current) => ({
      ...current,
      rpcUrls: current.rpcUrls.length > 1 ? current.rpcUrls.filter((_, i) => i !== index) : current.rpcUrls,
    }));

  const promoteUrl = (index) =>
    setForm((current) => {
      const next = [...current.rpcUrls];
      const [moved] = next.splice(index, 1);
      return { ...current, rpcUrls: [moved, ...next] };
    });

  const testUrl = (url) =>
    run(async () => {
      setTesting(url);
      try {
        const result = await call('TEST_RPC', { network: { ...form, rpc: url, chainId: hexChainId() } });
        setTestResults((current) => ({ ...current, [url]: { ...result, rpc: url } }));
      } catch (err) {
        setTestResults((current) => ({ ...current, [url]: { ok: false, rpc: url, error: err.message } }));
        throw err;
      } finally {
        setTesting('');
      }
    });

  const testAll = () =>
    run(async () => {
      for (const url of filledUrls) {
        setTesting(url);
        try {
          const result = await call('TEST_RPC', { network: { ...form, rpc: url, chainId: hexChainId() } });
          setTestResults((current) => ({ ...current, [url]: { ...result, rpc: url } }));
        } catch (err) {
          // One bad endpoint should not abort the sweep — the point is to find
          // out which of them work.
          setTestResults((current) => ({ ...current, [url]: { ok: false, rpc: url, error: err.message } }));
        }
      }
      setTesting('');
    });

  const save = () =>
    run(async () => {
      const chainId = hexChainId();
      if (!filledUrls.length) throw new Error('Add at least one RPC URL.');
      if (needsTest) {
        throw new Error(
          untested.length === 1
            ? 'Test the new RPC endpoint before saving.'
            : `Test the ${untested.length} new RPC endpoints before saving.`
        );
      }
      const payload = { ...form, rpcUrls: filledUrls, rpc: filledUrls[0] };
      if (isEdit) await call('EDIT_NETWORK', { chainId, network: payload });
      else await call('ADD_NETWORK', { network: { ...payload, chainId } });
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
        {(['name', 'chainId']).map((key) => (
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
          </label>
        ))}

        <RpcEndpoints
          urls={form.rpcUrls}
          results={testResults}
          testing={testing}
          busy={busy}
          knownUrls={originalUrls}
          onChange={updateUrl}
          onAdd={addUrl}
          onRemove={removeUrl}
          onPromote={promoteUrl}
          onTest={testUrl}
          onTestAll={testAll}
        />

        {(['symbol', 'explorer']).map((key) => (
          <label className="field" key={key}>
            <span>{FIELD_LABELS[key]}</span>
            <input
              className="mono"
              value={form[key]}
              placeholder={PLACEHOLDERS[key]}
              onChange={(e) => update(key, e.target.value)}
              spellCheck="false"
            />
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

        {filledUrls.map((url) => testResults[url]?.ok && <RpcTestResult key={url} result={testResults[url]} />)}
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
          <button className="ghost" onClick={testAll} disabled={busy || !filledUrls.length || !form.chainId}>
            {busy ? 'Testing…' : filledUrls.length > 1 ? `Test all ${filledUrls.length}` : 'Test RPC'}
          </button>
          <button className="primary" onClick={save} disabled={busy || !form.name || !filledUrls.length || needsTest}>
            {isEdit ? 'Save changes' : 'Add network'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The endpoint list.
 *
 * Order is meaningful: the first entry is tried first and the rest are failover,
 * so promoting one is a real setting rather than cosmetic sorting. Each is
 * tested on its own, because "the network works" and "this particular endpoint
 * works" are different claims and only the second one is checkable here.
 */
function RpcEndpoints({ urls, results, testing, busy, knownUrls, onChange, onAdd, onRemove, onPromote, onTest, onTestAll }) {
  const filled = urls.filter((url) => url.trim());
  const passing = filled.filter((url) => results[url]?.ok).length;

  return (
    <div className="card">
      <div className="between">
        <h2>RPC endpoints</h2>
        {filled.length > 1 && (
          <button className="link accent" onClick={onTestAll} disabled={busy}>
            test all
          </button>
        )}
      </div>
      <p className="small">
        Tried in order. If the first stops answering, ADRIX moves to the next automatically and backs off the failed one
        for a while — a rate-limited public endpoint stops being an outage.
      </p>

      {urls.map((url, index) => {
        const trimmed = url.trim();
        const result = results[trimmed];
        const isTesting = testing === trimmed;
        const known = knownUrls.has(trimmed);

        return (
          <div className="endpoint-edit" key={index}>
            <div className="between">
              <span className="eyebrow">{index === 0 ? 'Primary' : `Fallback ${index}`}</span>
              <span className="inline">
                {index > 0 && (
                  <button className="link" onClick={() => onPromote(index)} title="Try this one first">
                    make primary
                  </button>
                )}
                {urls.length > 1 && (
                  <button className="link" onClick={() => onRemove(index)}>
                    remove
                  </button>
                )}
              </span>
            </div>

            <div className="input-group">
              <input
                className="mono"
                value={url}
                placeholder="https://…"
                onChange={(e) => onChange(index, e.target.value)}
                spellCheck="false"
                aria-label={index === 0 ? 'Primary RPC URL' : `Fallback RPC URL ${index}`}
              />
              <button className="ghost" onClick={() => onTest(trimmed)} disabled={busy || !trimmed}>
                {isTesting ? '…' : 'Test'}
              </button>
            </div>

            {result?.ok ? (
              <span className="badge confirmed">
                ✓ chain matches · {result.latencyMs}ms · block {result.blockNumber}
              </span>
            ) : result ? (
              <div className="error small">{result.error}</div>
            ) : known ? (
              <span className="small faint">Already in use — no re-test needed unless you change it.</span>
            ) : trimmed ? (
              <span className="small faint">Not tested yet.</span>
            ) : null}
          </div>
        );
      })}

      {urls.length < MAX_RPC_URLS ? (
        <button className="ghost" onClick={onAdd}>
          + Add a fallback endpoint
        </button>
      ) : (
        <p className="small faint">Six endpoints is the maximum.</p>
      )}

      {filled.length > 1 && (
        <p className="small faint">
          {passing} of {filled.length} verified. Every endpoint you add can see the addresses you query, so add only
          ones you would be willing to use on their own.
        </p>
      )}
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
