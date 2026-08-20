import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'ethers';
import { call, shorten, trimAmount, formatDateTime, timeAgo, useAsyncAction } from '../../lib/ui.js';
import { BackBar, CopyButton, Skeleton, ErrorState } from '../components/common.jsx';

export default function TransactionDetail({ hash, currency = 'usd', onBack, onChanged }) {
  const [tx, setTx] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [saved, setSaved] = useState(false);
  const [knownTags, setKnownTags] = useState([]);
  const { busy, error, run } = useAsyncAction();

  const load = async () => {
    try {
      const detail = await call('GET_TRANSACTION_DETAIL', { hash });
      setTx(detail);
      setNote(detail.note ?? '');
      setTags((detail.tags ?? []).join(', '));
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    }
  };

  // A pending transaction is still moving, so the screen re-polls until it
  // lands. The ref avoids re-creating the interval on every state change.
  const statusRef = useRef(null);
  statusRef.current = tx?.status ?? null;

  // Existing tags across the account, so the same label gets reused instead of
  // spawning near-duplicates like "tax" / "Taxes" / "tax 2026".
  useEffect(() => {
    call('LIST_TAGS')
      .then((result) => setKnownTags(result.tags ?? []))
      .catch(() => setKnownTags([]));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (statusRef.current === null || statusRef.current === 'pending') load();
    }, 12000);
    return () => clearInterval(timer);
  }, [hash]);

  if (loadError) {
    return (
      <div className="screen">
        <BackBar title="Transaction" onBack={onBack} />
        <div className="scroll pad">
          <ErrorState message={loadError} onRetry={load} />
        </div>
      </div>
    );
  }

  if (!tx) {
    return (
      <div className="screen">
        <BackBar title="Transaction" onBack={onBack} />
        <div className="scroll pad stack" aria-busy="true">
          <Skeleton height={30} width="60%" />
          <Skeleton height={120} radius={14} />
          <Skeleton height={160} radius={14} />
        </div>
      </div>
    );
  }

  const act = (type) =>
    run(async () => {
      await call(type, { hash: tx.hash });
      await load();
      onChanged?.();
    });

  const saveMeta = () =>
    run(async () => {
      await call('UPDATE_TX_META', { hash: tx.hash, note, tags });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      await load();
      setKnownTags((await call('LIST_TAGS').catch(() => ({ tags: [] }))).tags ?? []);
      onChanged?.();
    });

  const explorerUrl = tx.explorer ? `${tx.explorer}/tx/${tx.hash}` : null;

  return (
    <div className="screen">
      <BackBar title="Transaction" onBack={onBack} />
      <div className="scroll pad stack">
        <div className="center stack-sm">
          <span className={`badge ${tx.status}`}>{tx.status}</span>
          <div className="balance">
            {trimAmount(valueOf(tx), 8)}
            <span>{tx.tokenSymbol ?? tx.symbol ?? ''}</span>
          </div>
          <div className="small faint">
            {tx.blockTime ? formatDateTime(tx.blockTime) : formatDateTime(tx.submittedAt)}
            {tx.status === 'pending' && ` · submitted ${timeAgo(tx.submittedAt)}`}
          </div>
        </div>

        {tx.status === 'pending' && (
          <div className="card accent">
            <div className="eyebrow accent-text">Still pending</div>
            <p className="small">
              Waiting for a block. Speeding up rebroadcasts the same transaction with a higher fee; cancelling replaces
              it with an empty self-transfer at the same nonce.
            </p>
            <div className="row2">
              <button className="ghost" onClick={() => act('SPEED_UP')} disabled={busy}>
                Speed up
              </button>
              <button className="ghost" onClick={() => act('CANCEL_TX')} disabled={busy}>
                Cancel transaction
              </button>
            </div>
          </div>
        )}

        {tx.replacedBy && (
          <div className="notice">
            Replaced by <span className="mono">{shorten(tx.replacedBy, 10, 8)}</span>.
          </div>
        )}

        <div className="card">
          <div className="eyebrow">Details</div>
          <Row label="Hash" value={shorten(tx.hash, 12, 10)} copy={tx.hash} />
          <Row label="From" value={shorten(tx.from, 10, 8)} copy={tx.from} />
          <Row label="To" value={tx.to ? shorten(tx.to, 10, 8) : 'Contract deployment'} copy={tx.to} />
          <Row label="Network" value={tx.networkName ?? tx.chainId} />
          <Row label="Nonce" value={tx.nonce ?? '--'} />
          {tx.blockNumber != null && <Row label="Block" value={String(tx.blockNumber)} />}
          {tx.confirmations != null && <Row label="Confirmations" value={String(tx.confirmations)} />}
          {tx.decoded?.name && <Row label="Method" value={tx.decoded.name} />}
          {tx.decoded?.label && <Row label="Action" value={tx.decoded.label} />}
        </div>

        <div className="card">
          <div className="eyebrow">Gas</div>
          {tx.gasLimit && <Row label="Gas limit" value={Number(tx.gasLimit).toLocaleString()} />}
          <Row label="Gas used" value={tx.gasUsed ? Number(tx.gasUsed).toLocaleString() : 'pending'} />
          {tx.gasLimit && tx.gasUsed && (
            <Row
              label="Efficiency"
              value={`${Math.round((Number(tx.gasUsed) / Number(tx.gasLimit)) * 100)}% of limit`}
            />
          )}
          {tx.effectiveGasPrice && (
            <Row label="Effective price" value={`${trimAmount(formatUnits(tx.effectiveGasPrice, 'gwei'), 4)} gwei`} />
          )}
          {tx.maxFeePerGas && (
            <Row label="Max fee" value={`${trimAmount(formatUnits(tx.maxFeePerGas, 'gwei'), 4)} gwei`} />
          )}
          {tx.maxPriorityFeePerGas && (
            <Row label="Priority fee" value={`${trimAmount(formatUnits(tx.maxPriorityFeePerGas, 'gwei'), 4)} gwei`} />
          )}
          <Row
            label="Fee paid"
            value={tx.feePaid ? `${trimAmount(tx.feePaid, 8)} ${tx.symbol ?? ''}` : 'pending'}
          />
        </div>

        {tx.data && tx.data !== '0x' && (
          <div className="card">
            <div className="between">
              <span className="eyebrow">Calldata</span>
              <CopyButton value={tx.data} label="copy" className="link accent" />
            </div>
            <div className="data-block">{tx.data}</div>
          </div>
        )}

        <div className="card">
          <div className="eyebrow">Your notes</div>
          <label className="field">
            <span>Note</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this transaction matters"
              rows={2}
            />
          </label>
          <label className="field">
            <span>Tags</span>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="swap, tax, client"
              list="known-tags"
            />
            <datalist id="known-tags">
              {knownTags.map(({ tag }) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            <span className="small faint">
              Comma separated, up to 8. Tags are searchable, filterable, and go into the CSV export.
            </span>
          </label>

          {knownTags.length > 0 && (
            <div className="inline wrap">
              <span className="small faint">Reuse:</span>
              {knownTags.slice(0, 8).map(({ tag, count }) => {
                const applied = tags
                  .split(',')
                  .map((entry) => entry.trim().toLowerCase())
                  .includes(tag.toLowerCase());
                return (
                  <button
                    key={tag}
                    className={`chip ${applied ? 'accent' : ''}`}
                    aria-pressed={applied}
                    onClick={() => {
                      const list = tags
                        .split(',')
                        .map((entry) => entry.trim())
                        .filter(Boolean);
                      const next = applied
                        ? list.filter((entry) => entry.toLowerCase() !== tag.toLowerCase())
                        : [...list, tag];
                      setTags(next.join(', '));
                    }}
                  >
                    {tag} ({count})
                  </button>
                );
              })}
            </div>
          )}

          <button className="ghost" onClick={saveMeta} disabled={busy}>
            {busy ? 'Saving…' : saved ? 'Saved' : 'Save notes and tags'}
          </button>
        </div>

        {error && <div className="error" role="alert">{error}</div>}
      </div>

      {explorerUrl && (
        <div className="footer">
          <a className="ghost" href={explorerUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
            Open in block explorer ↗
          </a>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, copy }) {
  return (
    <div className="kv">
      <span className="kv-key">{label}</span>
      <span className="kv-value inline" style={{ justifyContent: 'flex-end' }}>
        {value}
        {copy && <CopyButton value={copy} label="⧉" className="link" />}
      </span>
    </div>
  );
}

function valueOf(tx) {
  if (tx.tokenAmount) return tx.tokenAmount;
  try {
    return Number(tx.value ?? 0) / 1e18;
  } catch {
    return 0;
  }
}
