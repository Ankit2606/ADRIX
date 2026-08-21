import { useEffect, useState } from 'react';
import { formatUnits } from 'ethers';
import { call, shorten, trimAmount, formatFiat, useAsyncAction } from '../../lib/ui.js';
import { BackBar, GasPresetGrid } from '../components/common.jsx';

const MAX_BATCH = 20;

/**
 * Sending to several recipients in one pass.
 *
 * The screen this replaces said these went out as "a single atomic transaction"
 * where "they all succeed or fail together". A plain EOA cannot do that —
 * atomicity needs a smart account or an EIP-7702 delegation, neither of which
 * ADRIX has. The claim was false in the way that matters, because it promised
 * that the one thing which can actually go wrong could not happen.
 *
 * This sends them as separate transactions with pre-assigned sequential nonces,
 * says so plainly, and reports exactly which ones went out.
 */
export default function BatchSend({ state, go }) {
  const [transfers, setTransfers] = useState([{ address: '', amount: '' }]);
  const [asset, setAsset] = useState('native');
  const [portfolio, setPortfolio] = useState(null);
  const [prepared, setPrepared] = useState(null);
  const [preset, setPreset] = useState('market');
  const [result, setResult] = useState(null);
  const [step, setStep] = useState('form');
  const { busy, error, setError, run } = useAsyncAction();

  const currency = portfolio?.currency ?? state.currency ?? 'usd';

  useEffect(() => {
    call('GET_PORTFOLIO').then(setPortfolio).catch(() => {});
  }, [state.selected, state.chainId]);

  const update = (index, field, value) =>
    setTransfers((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  const addRow = () =>
    setTransfers((current) => (current.length >= MAX_BATCH ? current : [...current, { address: '', amount: '' }]));

  const removeRow = (index) =>
    setTransfers((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));

  /** Accepts "address,amount" per line — how these lists actually arrive. */
  const pasteList = (text) => {
    const rows = String(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [address, amount] = line.split(/[,;\t]\s*/);
        return { address: (address ?? '').trim(), amount: (amount ?? '').trim() };
      })
      .filter((row) => row.address)
      .slice(0, MAX_BATCH);
    if (rows.length) setTransfers(rows);
  };

  const prepare = () =>
    run(async () => {
      const next = await call('BATCH_PREPARE', {
        transfers: transfers.filter((row) => row.address.trim() && row.amount.trim()),
        tokenAddress: asset === 'native' ? null : asset,
      });
      setPrepared(next);
      setStep('review');
    });

  const send = () =>
    run(async () => {
      const next = await call('BATCH_SEND', {
        transfers: prepared.rows.filter((row) => !row.error).map((row) => ({ address: row.to, amount: row.amount })),
        tokenAddress: asset === 'native' ? null : asset,
        fees: prepared.gasInfo.options[preset],
        gas: prepared.gasInfo.gasLimit,
      });
      setResult(next);
      setStep('done');
    });

  // --- result -----------------------------------------------------------------
  if (step === 'done') {
    const partial = result.failed.length > 0 || result.stoppedAt != null;
    return (
      <div className="screen">
        <BackBar title="Batch sent" onBack={() => go('home')} />
        <div className="scroll pad stack">
          <div className={partial ? 'notice danger' : 'ok'}>
            {partial ? (
              <>
                <b>
                  {result.sent.length} of {result.total} went out.
                </b>{' '}
                The rest did not. Because these are separate transactions, the ones already sent cannot be recalled —
                they will confirm normally.
              </>
            ) : (
              <>All {result.sent.length} transfers were submitted.</>
            )}
          </div>

          {result.sent.length > 0 && (
            <div className="card">
              <span className="eyebrow">Submitted</span>
              {result.sent.map((entry) => (
                <div className="kv" key={entry.hash}>
                  <span className="kv-key">
                    nonce {entry.nonce} · {shorten(entry.to, 6, 4)}
                  </span>
                  <span className="kv-value mono small">{shorten(entry.hash, 8, 6)}</span>
                </div>
              ))}
            </div>
          )}

          {result.failed.length > 0 && (
            <div className="card">
              <span className="eyebrow">Not sent</span>
              {result.failed.map((entry) => (
                <div className="kv" key={`${entry.index}-${entry.address}`}>
                  <span className="kv-key">{shorten(entry.address, 8, 6)}</span>
                  <span className="kv-value small" style={{ color: 'var(--danger)' }}>
                    {entry.error}
                  </span>
                </div>
              ))}
            </div>
          )}

          {result.remaining > 0 && (
            <div className="notice">
              {result.remaining} transfers were never attempted. The run stopped at the first failure on purpose —
              nonces execute in order, so continuing past a gap would have left everything after it stuck behind a
              nonce that was never broadcast.
            </div>
          )}
        </div>
        <div className="footer">
          <button className="primary" onClick={() => go('home')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  // --- review -----------------------------------------------------------------
  if (step === 'review') {
    const flagged = prepared.rows.filter(
      (row) => !row.error && (row.duplicateOf != null || row.inspection?.lookalike || row.inspection?.isContract)
    );

    return (
      <div className="screen">
        <BackBar title="Review batch" onBack={() => setStep('form')} />
        <div className="scroll pad stack">
          <div className="notice danger">
            <b>These are {prepared.valid} separate transactions, not one.</b>
            <p className="small">
              ADRIX has no smart account or EIP-7702 delegation, so they cannot be atomic. Each pays its own fee, and
              if one fails the ones already sent stay sent.
            </p>
          </div>

          <div className="card">
            <div className="kv">
              <span className="kv-key">Sending</span>
              <span className="kv-value mono">
                {trimAmount(formatUnits(prepared.totalRaw, prepared.decimals), 6)} {prepared.symbol}
              </span>
            </div>
            <div className="kv">
              <span className="kv-key">Recipients</span>
              <span className="kv-value">{prepared.valid}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Total network fees</span>
              <span className="kv-value mono">
                ~{trimAmount(formatUnits(prepared.totalGasCost, 18), 6)} {prepared.network.symbol}
              </span>
            </div>
            {prepared.startNonce != null && (
              <div className="kv">
                <span className="kv-key">Nonces</span>
                <span className="kv-value mono">
                  {prepared.startNonce} – {prepared.startNonce + prepared.valid - 1}
                </span>
              </div>
            )}
          </div>

          {!prepared.affordable && (
            <div className="notice danger">
              This account holds {trimAmount(formatUnits(prepared.balance, 18), 6)} {prepared.network.symbol} but the
              batch needs {trimAmount(formatUnits(prepared.nativeNeeded, 18), 6)} including fees. Later transfers will
              fail once the balance runs out.
            </div>
          )}

          {prepared.invalid > 0 && (
            <div className="notice">
              {prepared.invalid} row{prepared.invalid === 1 ? '' : 's'} could not be read and will be skipped.
            </div>
          )}

          {flagged.length > 0 && (
            <div className="notice">
              <b>{flagged.length} recipients need a second look.</b>
              <p className="small">
                Nobody reads twenty rows as carefully as they read one, so these are called out individually below.
              </p>
            </div>
          )}

          <div className="card">
            <span className="eyebrow">Recipients</span>
            {prepared.rows.map((row) => (
              <div className="batch-row" key={row.index}>
                <div className="between">
                  <span className="mono small">{row.error ? row.input : shorten(row.to, 10, 8)}</span>
                  <span className="mono small">
                    {row.amount} {row.symbol}
                  </span>
                </div>
                {row.error && <span className="small" style={{ color: 'var(--danger)' }}>{row.error}</span>}
                {row.duplicateOf != null && (
                  <span className="small" style={{ color: 'var(--warn)' }}>
                    Same address as row {row.duplicateOf + 1} — both will be sent.
                  </span>
                )}
                {row.inspection?.lookalike && (
                  <span className="small" style={{ color: 'var(--danger)' }}>
                    Resembles {row.inspection.lookalike.against.label} but is a different address.
                  </span>
                )}
                {row.inspection?.contractKind?.kind === 'token' && (
                  <span className="small" style={{ color: 'var(--danger)' }}>
                    This is a token contract, not a wallet.
                  </span>
                )}
                {row.inspection?.contact && (
                  <span className="small faint">☆ {row.inspection.contact.name}</span>
                )}
              </div>
            ))}
          </div>

          <div className="stack-sm">
            <h3>Network fee, per transfer</h3>
            <GasPresetGrid gasInfo={prepared.gasInfo} preset={preset} onSelect={setPreset} />
          </div>

          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => setStep('form')} disabled={busy}>
              Back
            </button>
            <button className="primary" onClick={send} disabled={busy}>
              {busy ? 'Sending…' : `Send ${prepared.valid} transfers`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- form -------------------------------------------------------------------
  const ready = transfers.some((row) => row.address.trim() && row.amount.trim());

  return (
    <div className="screen">
      <BackBar title="Batch transfer" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="notice">
          Sends to several recipients in one pass. They go out as separate transactions with sequential nonces — not
          atomically, which a plain account cannot do.
        </div>

        <label className="field">
          <span>Asset</span>
          <select value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option value="native">
              {portfolio?.native?.symbol ?? state.network?.symbol} — {trimAmount(portfolio?.native?.balance)}
            </option>
            {(portfolio?.tokens ?? []).map((token) => (
              <option key={token.address} value={token.address}>
                {token.symbol} — {trimAmount(token.balance)}
              </option>
            ))}
          </select>
        </label>

        <div className="card">
          <div className="between">
            <span className="eyebrow">
              Recipients ({transfers.length}/{MAX_BATCH})
            </span>
            <button className="link" onClick={() => setTransfers([{ address: '', amount: '' }])}>
              clear
            </button>
          </div>

          {transfers.map((row, index) => (
            <div className="batch-input" key={index}>
              <div className="between">
                <span className="small faint">{index + 1}</span>
                {transfers.length > 1 && (
                  <button className="link" onClick={() => removeRow(index)}>
                    remove
                  </button>
                )}
              </div>
              <input
                className="mono"
                placeholder="0x… or name.eth"
                value={row.address}
                onChange={(e) => update(index, 'address', e.target.value)}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text');
                  // A multi-line paste is a list, not an address.
                  if (/\r?\n/.test(text.trim())) {
                    e.preventDefault();
                    pasteList(text);
                  }
                }}
                spellCheck="false"
                aria-label={`Recipient ${index + 1}`}
              />
              <input
                className="mono"
                inputMode="decimal"
                placeholder="Amount"
                value={row.amount}
                onChange={(e) => update(index, 'amount', e.target.value.replace(/[^\d.]/g, ''))}
                aria-label={`Amount ${index + 1}`}
              />
            </div>
          ))}

          {transfers.length < MAX_BATCH && (
            <button className="ghost" onClick={addRow}>
              + Add recipient
            </button>
          )}
          <p className="small faint">
            Paste a list of <code>address,amount</code> lines into any address box to fill the whole batch at once.
          </p>
        </div>

        {error && <div className="error" role="alert">{error}</div>}
      </div>
      <div className="footer">
        <button className="primary" onClick={prepare} disabled={busy || !ready}>
          {busy ? 'Checking…' : 'Review batch'}
        </button>
      </div>
    </div>
  );
}
