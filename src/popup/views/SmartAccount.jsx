import { useEffect, useState } from 'react';
import { formatEther, parseEther } from 'ethers';
import { call, shorten, trimAmount, timeAgo, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState, GasPresetGrid, Skeleton } from '../components/common.jsx';

/**
 * Smart accounts: Safe multisigs and ERC-4337 accounts.
 *
 * Both are contracts that hold funds and are controlled by keys elsewhere, so
 * they share a screen — but almost nothing else. A Safe needs signatures
 * gathered from several owners before anything can execute; a 4337 account
 * needs one signature turned into a user operation and handed to a bundler.
 * The view detects which it is looking at and shows only the relevant half.
 */
export default function SmartAccount({ state, go, params }) {
  const address = params?.address ?? state.selected;
  const [kind, setKind] = useState('detecting');
  const [safe, setSafe] = useState(null);
  const [aa, setAa] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setKind('detecting');
    (async () => {
      // Safe first: its getOwners/getThreshold pair is a definitive test, while
      // 4337 detection is a set of conventions any contract might partly match.
      const safeInfo = await call('SAFE_INSPECT', { address }).catch(() => null);
      if (cancelled) return;
      if (safeInfo?.isSafe) {
        setSafe(safeInfo);
        setKind('safe');
        return;
      }
      const aaInfo = await call('AA_INSPECT', { address }).catch((err) => {
        setError(err.message);
        return null;
      });
      if (cancelled) return;
      setAa(aaInfo);
      setKind(aaInfo?.entryPoint ? 'aa' : 'unknown');
    })();
    return () => {
      cancelled = true;
    };
  }, [address, state.chainId]);

  if (kind === 'detecting') {
    return (
      <div className="screen">
        <BackBar title="Smart account" onBack={() => go('accounts')} />
        <div className="scroll pad stack">
          <Skeleton height={80} radius={14} />
          <Skeleton height={140} radius={14} />
          <p className="small faint center">Reading the contract on {state.network?.name}…</p>
        </div>
      </div>
    );
  }

  if (kind === 'safe') return <SafeView safe={safe} state={state} go={go} onReload={setSafe} />;
  if (kind === 'aa') return <AaView account={aa} state={state} go={go} />;

  return (
    <div className="screen">
      <BackBar title="Smart account" onBack={() => go('accounts')} />
      <div className="scroll pad stack">
        <EmptyState
          icon="◇"
          title="Not a recognised smart account"
          body={
            aa?.notes?.[0] ??
            error ??
            `Nothing at ${shorten(address, 8, 6)} on ${state.network?.name} looks like a Safe or an ERC-4337 account. It may live on a different network.`
          }
          action={
            <button className="ghost" onClick={() => go('networks')}>
              Switch network
            </button>
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Safe
// ---------------------------------------------------------------------------
function SafeView({ safe, state, go, onReload }) {
  const [queue, setQueue] = useState(null);
  const [tab, setTab] = useState('queue');
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => {
    const result = await call('SAFE_PENDING', { address: safe.address }).catch(() => null);
    setQueue(result);
    const fresh = await call('SAFE_INSPECT', { address: safe.address }).catch(() => null);
    if (fresh?.isSafe) onReload(fresh);
  };

  useEffect(() => {
    load();
  }, [safe.address, state.chainId]);

  const signOne = (entry) =>
    run(async () => {
      const owner = safe.localOwners.find(
        (candidate) => !entry.signedByMe.some((signed) => signed.toLowerCase() === candidate.address.toLowerCase())
      );
      if (!owner) throw new Error('Every owner ADRIX holds a key for has already signed this.');

      await call('SAFE_CONFIRM', {
        safeAddress: safe.address,
        tx: entry,
        safeTxHash: entry.safeTxHash,
        ownerAddress: owner.address,
      });
      await load();
    });

  const executeOne = (entry) =>
    run(async () => {
      const check = await call('SAFE_CHECK_EXECUTABLE', {
        safeAddress: safe.address,
        tx: entry,
        confirmations: entry.confirmations,
      });
      if (!check.ok) throw new Error(check.error);

      const gasInfo = await call('ESTIMATE_GAS', {
        request: { from: state.selected, to: safe.address, value: '0x0', data: check.data },
      });
      await call('SAFE_EXECUTE', {
        safeAddress: safe.address,
        tx: entry,
        confirmations: entry.confirmations,
        fees: gasInfo.options.market,
        gas: gasInfo.gasLimit,
      });
      await load();
    });

  return (
    <div className="screen">
      <BackBar title="Safe" onBack={() => go('accounts')} />
      <div className="scroll pad stack">
        <div className="card accent">
          <div className="between">
            <span className="eyebrow accent-text">Safe {safe.version}</span>
            <span className="badge confirmed">
              {safe.threshold} of {safe.owners.length}
            </span>
          </div>
          <div className="data-block">{safe.address}</div>
          <div className="kv">
            <span className="kv-key">Next nonce</span>
            <span className="kv-value mono">{safe.nonce}</span>
          </div>
          <div className="kv">
            <span className="kv-key">You control</span>
            <span className="kv-value">
              {safe.localOwners.length
                ? `${safe.localOwners.length} of ${safe.owners.length} owner keys`
                : 'no owner keys'}
            </span>
          </div>
        </div>

        {!safe.canSign && (
          <div className="notice">
            None of this Safe's owners are keys ADRIX holds, so it can be watched but not signed for. Anything queued
            below still needs {safe.threshold} signatures from elsewhere.
          </div>
        )}

        {!safe.serviceAvailable && (
          <div className="notice">
            Safe does not run a transaction service on {state.network?.name}, so signatures cannot be shared through
            ADRIX here. Signing and executing still work if the other owners coordinate another way.
          </div>
        )}

        <div className="tabs" role="tablist" aria-label="Safe sections">
          <button role="tab" aria-selected={tab === 'queue'} onClick={() => setTab('queue')}>
            Queue{queue?.pending?.length ? ` (${queue.pending.length})` : ''}
          </button>
          <button role="tab" aria-selected={tab === 'owners'} onClick={() => setTab('owners')}>
            Owners
          </button>
        </div>

        {error && <div className="error" role="alert">{error}</div>}

        {tab === 'owners' ? (
          <div className="card">
            {safe.owners.map((owner) => {
              const mine = safe.localOwners.find((entry) => entry.address.toLowerCase() === owner.toLowerCase());
              return (
                <div className="kv" key={owner}>
                  <span className="kv-key mono small">{shorten(owner, 10, 8)}</span>
                  <span className="kv-value">{mine ? <span className="badge confirmed">{mine.name}</span> : '—'}</span>
                </div>
              );
            })}
            <p className="small faint">
              Any {safe.threshold} of these {safe.owners.length} must sign before a transaction can execute.
            </p>
          </div>
        ) : !queue ? (
          <Skeleton height={100} radius={14} />
        ) : !queue.pending.length ? (
          <EmptyState
            icon="✓"
            title="Nothing waiting"
            body="Transactions proposed by any owner appear here until they have enough signatures to execute."
          />
        ) : (
          <div className="stack-sm">
            {queue.pending.map((entry) => (
              <div className="card" key={entry.safeTxHash}>
                <div className="between">
                  <span className="eyebrow">nonce {entry.nonce}</span>
                  <span className={`badge ${entry.ready ? 'confirmed' : 'pending'}`}>
                    {entry.confirmations.length} of {entry.confirmationsRequired}
                  </span>
                </div>

                <div className="kv">
                  <span className="kv-key">To</span>
                  <span className="kv-value mono">{shorten(entry.to, 10, 8)}</span>
                </div>
                <div className="kv">
                  <span className="kv-key">Value</span>
                  <span className="kv-value mono">
                    {trimAmount(formatEther(entry.value || '0'), 6)} {state.network?.symbol}
                  </span>
                </div>
                {entry.data && entry.data !== '0x' && (
                  <div className="kv">
                    <span className="kv-key">Calldata</span>
                    <span className="kv-value mono small">{entry.data.slice(0, 10)}…</span>
                  </div>
                )}
                {entry.submittedAt && <span className="item-sub faint">proposed {timeAgo(entry.submittedAt)}</span>}

                {entry.operation === 1 && (
                  <div className="notice danger">
                    Delegate call — this runs another contract's code with the Safe's own permissions and can change
                    its owners.
                  </div>
                )}
                {entry.conflictsWithNonce && (
                  <div className="notice">
                    Another queued transaction shares nonce {entry.nonce}. Only one of them can ever execute; the other
                    becomes void.
                  </div>
                )}
                {entry.signedByMe.length > 0 && (
                  <span className="item-sub">You have signed with {entry.signedByMe.length} of your keys.</span>
                )}

                <div className="row2">
                  <button
                    className="ghost"
                    disabled={busy || !entry.canSign}
                    onClick={() => signOne(entry)}
                    title={entry.canSign ? 'Add your signature' : 'No unsigned owner key available'}
                  >
                    {busy ? 'Working…' : 'Sign'}
                  </button>
                  <button className="primary" disabled={busy || !entry.ready} onClick={() => executeOne(entry)}>
                    {entry.ready ? 'Execute' : `Needs ${entry.needs} more`}
                  </button>
                </div>
              </div>
            ))}
            <p className="small faint">
              Executing is an ordinary transaction paid for by whoever submits it — the gas comes from your account,
              not the Safe's.
            </p>
          </div>
        )}

        <button className="ghost" onClick={() => setError('') || load()} disabled={busy}>
          Refresh
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ERC-4337
// ---------------------------------------------------------------------------
function AaView({ account, state, go }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [prepared, setPrepared] = useState(null);
  const [config, setConfig] = useState(null);
  const [sent, setSent] = useState(null);
  const [status, setStatus] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  useEffect(() => {
    call('AA_CONFIG', { chainId: state.chainId }).then(setConfig).catch(() => {});
  }, [state.chainId]);

  // A user operation has no transaction hash until a bundler includes it, so
  // the only way to know where it got to is to ask.
  useEffect(() => {
    if (!sent) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      const next = await call('AA_STATUS', { userOpHash: sent.userOpHash }).catch(() => null);
      if (cancelled) return;
      setStatus(next);
      if (next?.status === 'pending') timer = setTimeout(poll, 6000);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sent]);

  const prepare = () =>
    run(async () => {
      const { address } = await call('RESOLVE_RECIPIENT', { input: to });
      setPrepared(
        await call('AA_PREPARE', {
          sender: account.address,
          calls: [{ to: address, value: `0x${parseEther(amount || '0').toString(16)}`, data: '0x' }],
          sponsor: true,
        })
      );
    });

  const send = () =>
    run(async () => {
      setSent(await call('AA_SEND', { prepared }));
      setPrepared(null);
    });

  if (sent) {
    return (
      <div className="screen">
        <BackBar title="User operation" onBack={() => go('accounts')} />
        <div className="scroll pad stack">
          <div className="beam" />
          <h1>{status?.status === 'confirmed' ? 'Executed' : status?.status === 'failed' ? 'Failed' : 'Submitted'}</h1>
          <p className="small">
            {status?.status === 'pending' || !status
              ? 'The bundler has accepted it. It has no transaction hash until it is included in one.'
              : status.status === 'confirmed'
                ? 'The operation was included and succeeded.'
                : `The operation was included but reverted. ${status.reason ?? ''}`}
          </p>

          <div className="card">
            <span className="eyebrow">UserOp hash</span>
            <div className="data-block">{sent.userOpHash}</div>
            {status?.transactionHash && (
              <>
                <span className="eyebrow">Transaction</span>
                <div className="data-block">{status.transactionHash}</div>
              </>
            )}
            {status?.actualGasCost && (
              <div className="kv">
                <span className="kv-key">Gas cost</span>
                <span className="kv-value mono">
                  {trimAmount(formatEther(status.actualGasCost), 8)} {state.network?.symbol}
                  {status.paymaster ? ' (paid by paymaster)' : ''}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="footer">
          <button className="primary" onClick={() => go('home')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (prepared) {
    const sponsored = prepared.sponsorship.granted;
    return (
      <div className="screen">
        <BackBar title="Review operation" onBack={() => setPrepared(null)} />
        <div className="scroll pad stack">
          <div className={`card ${sponsored ? 'accent' : ''}`}>
            <div className="between">
              <span className="eyebrow accent-text">Cost to you</span>
              {sponsored && <span className="badge confirmed">sponsored</span>}
            </div>
            <div className="balance">
              {sponsored ? '0' : trimAmount(formatEther(prepared.maxCost), 8)}
              <span>{state.network?.symbol}</span>
            </div>
            {sponsored ? (
              <p className="small">
                A paymaster is covering the fee. Without it this would cost up to{' '}
                {trimAmount(formatEther(prepared.maxCostUnsponsored), 8)} {state.network?.symbol}.
              </p>
            ) : (
              <p className="small">{prepared.sponsorship.reason ?? 'Paid from the smart account\'s own balance.'}</p>
            )}
          </div>

          <div className="card">
            <div className="kv">
              <span className="kv-key">Account</span>
              <span className="kv-value mono">{shorten(prepared.op.sender, 10, 8)}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Signed by</span>
              <span className="kv-value">{prepared.account.signer?.name}</span>
            </div>
            <div className="kv">
              <span className="kv-key">EntryPoint</span>
              <span className="kv-value mono small">{shorten(prepared.entryPoint, 8, 6)}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Total gas</span>
              <span className="kv-value mono">{Number(prepared.totalGas).toLocaleString()}</span>
            </div>
          </div>

          <div className="notice">
            This is a user operation, not a transaction. It goes to a bundler, which submits it on your behalf — so it
            can be dropped without ever appearing on chain, and it has no transaction hash until it is included.
          </div>

          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => setPrepared(null)} disabled={busy}>
              Back
            </button>
            <button className="primary" onClick={send} disabled={busy}>
              {busy ? 'Submitting…' : 'Sign and submit'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <BackBar title="Smart account" onBack={() => go('accounts')} />
      <div className="scroll pad stack">
        <div className="card accent">
          <div className="between">
            <span className="eyebrow accent-text">ERC-4337 account</span>
            {account.deployed && <span className="badge confirmed">deployed</span>}
          </div>
          <div className="data-block">{account.address}</div>
          {account.entryPoint && (
            <div className="kv">
              <span className="kv-key">EntryPoint</span>
              <span className="kv-value mono small">{shorten(account.entryPoint, 8, 6)}</span>
            </div>
          )}
          <div className="kv">
            <span className="kv-key">Signing key</span>
            <span className="kv-value">{account.signer ? account.signer.name : 'none held here'}</span>
          </div>
        </div>

        {account.notes.map((note) => (
          <div className="notice" key={note}>
            {note}
          </div>
        ))}

        {config && !config.bundlerUrl && (
          <div className="notice danger">
            No bundler is configured for {state.network?.name}, and a user operation cannot be submitted without one.
            <button className="link accent" onClick={() => go('settings')}>
              Configure a bundler
            </button>
          </div>
        )}

        {config?.bundlerUrl && (
          <p className="small faint">
            Bundler: {new URL(config.bundlerUrl).host}
            {config.isDefault ? ' (public default)' : ''}
            {config.paymasterUrl ? ` · paymaster: ${new URL(config.paymasterUrl).host}` : ' · no paymaster'}
          </p>
        )}

        {account.signer && account.canExecute && (
          <div className="card">
            <h2>Send from this account</h2>
            <label className="field">
              <span>To</span>
              <input
                className="mono"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setError('');
                }}
                placeholder="0x… or name.eth"
                spellCheck="false"
              />
            </label>
            <label className="field">
              <span>Amount ({state.network?.symbol})</span>
              <input
                className="mono"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder="0.0"
              />
            </label>
            {error && <div className="error" role="alert">{error}</div>}
            <button className="primary" onClick={prepare} disabled={busy || !to || !amount || !config?.bundlerUrl}>
              {busy ? 'Preparing…' : 'Prepare operation'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
