import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits } from 'ethers';
import { call, shorten, trimAmount, formatFiat } from '../../lib/ui.js';
import { BalanceChanges, GasPresetGrid, Skeleton } from './common.jsx';

export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export const SLIPPAGE_PRESETS = [0.001, 0.005, 0.01, 0.03];

export const fmtUnits = (raw, decimals) => {
  try {
    return formatUnits(BigInt(raw ?? 0), decimals ?? 18);
  } catch {
    return '0';
  }
};

/**
 * Quote fetching with debounce and cancellation.
 *
 * Quotes go stale in seconds — the rate moves, and the calldata is built
 * against a block that is about to be replaced — so this re-fetches on a timer
 * and tracks the age, rather than letting a five-minute-old route sit on screen
 * looking current.
 */
export function useQuote({ enabled, params, intervalMs = 20_000 }) {
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);
  const requestRef = useRef(0);
  const key = JSON.stringify(params ?? {});

  const fetchQuote = useCallback(async () => {
    if (!enabled) return;
    const ticket = ++requestRef.current;
    setLoading(true);
    try {
      const next = await call('SWAP_QUOTE', params);
      // A slower earlier request must never overwrite a newer answer.
      if (ticket !== requestRef.current) return;
      setQuote(next);
      setFetchedAt(Date.now());
      setError('');
    } catch (err) {
      if (ticket !== requestRef.current) return;
      setQuote(null);
      setError(err.message);
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled) {
      setQuote(null);
      setError('');
      return undefined;
    }
    const timer = setTimeout(fetchQuote, 450);
    return () => clearTimeout(timer);
  }, [enabled, key, fetchQuote]);

  useEffect(() => {
    if (!enabled || !quote) return undefined;
    const timer = setInterval(fetchQuote, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, quote, intervalMs, fetchQuote]);

  return { quote, error, loading, fetchedAt, refetch: fetchQuote };
}

/** Asset picker backed by the aggregator's token list for one chain. */
export function TokenSelect({ chainId, value, onChange, label, exclude }) {
  const [tokens, setTokens] = useState([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    call('SWAP_TOKENS', { chainId })
      .then((result) => !cancelled && setTokens(result.tokens ?? []))
      .catch(() => !cancelled && setTokens([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  const selected = tokens.find((token) => token.address?.toLowerCase() === value?.toLowerCase());
  const needle = query.trim().toLowerCase();
  const visible = tokens
    .filter((token) => token.address?.toLowerCase() !== exclude?.toLowerCase())
    .filter(
      (token) =>
        !needle ||
        token.symbol?.toLowerCase().includes(needle) ||
        token.name?.toLowerCase().includes(needle) ||
        token.address?.toLowerCase().includes(needle)
    )
    .slice(0, 40);

  if (!open) {
    return (
      <button className="token-select" onClick={() => setOpen(true)} disabled={loading}>
        {selected?.logoURI ? (
          <img className="token-logo" src={selected.logoURI} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="token-icon sm">{selected?.symbol?.charAt(0) ?? '?'}</span>
        )}
        <span className="token-select-text">
          <span className="token-select-symbol">{loading ? '…' : (selected?.symbol ?? 'Select')}</span>
          <span className="token-select-label">{label}</span>
        </span>
        <span className="caret" aria-hidden="true">
          ▼
        </span>
      </button>
    );
  }

  return (
    <div className="card">
      <div className="between">
        <span className="eyebrow">{label}</span>
        <button className="link" onClick={() => setOpen(false)}>
          close
        </button>
      </div>
      <label className="field">
        <span className="visually-hidden">Search tokens</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Symbol, name, or address"
          type="search"
          autoFocus
        />
      </label>
      <div className="list token-picker">
        {visible.map((token) => (
          <button
            className="item compact"
            key={token.address}
            onClick={() => {
              onChange(token.address);
              setOpen(false);
              setQuery('');
            }}
          >
            {token.logoURI ? (
              <img className="token-logo" src={token.logoURI} alt="" loading="lazy" referrerPolicy="no-referrer" />
            ) : (
              <span className="token-icon sm">{token.symbol?.charAt(0) ?? '?'}</span>
            )}
            <div className="item-main">
              <span className="item-title">{token.symbol}</span>
              <span className="item-sub">
                {token.name} · {shorten(token.address, 6, 4)}
              </span>
            </div>
            {token.priceUSD && <span className="mono small faint">${trimAmount(token.priceUSD, 2)}</span>}
          </button>
        ))}
        {!visible.length && <p className="small faint">No token matches that search.</p>}
      </div>
    </div>
  );
}

/** Slippage control, with the consequence of each setting spelled out. */
export function SlippageControl({ value, onChange }) {
  const [custom, setCustom] = useState('');

  return (
    <div className="stack-sm">
      <div className="between">
        <span className="small">Max slippage</span>
        <span className="mono small">{(value * 100).toFixed(2)}%</span>
      </div>
      <div className="row3">
        {SLIPPAGE_PRESETS.map((preset) => (
          <button
            key={preset}
            className="ghost"
            aria-pressed={value === preset}
            onClick={() => {
              onChange(preset);
              setCustom('');
            }}
          >
            {(preset * 100).toFixed(preset < 0.01 ? 1 : 0)}%
          </button>
        ))}
        <input
          className="mono"
          inputMode="decimal"
          placeholder="custom"
          value={custom}
          onChange={(e) => {
            const next = e.target.value.replace(/[^\d.]/g, '');
            setCustom(next);
            const parsed = Number(next) / 100;
            if (Number.isFinite(parsed) && parsed > 0 && parsed <= 0.05) onChange(parsed);
          }}
          aria-label="Custom slippage percent"
        />
      </div>
      {value > 0.01 && (
        <div className="notice">
          {(value * 100).toFixed(2)}% slippage means you accept receiving up to that much less than quoted. High
          settings are how sandwich bots get paid.
        </div>
      )}
    </div>
  );
}

/** The numbers that decide whether a route is acceptable. */
export function QuoteSummary({ quote, currency = 'usd', stale }) {
  if (!quote) return null;

  const out = fmtUnits(quote.toAmountRaw, quote.toToken?.decimals);
  const min = fmtUnits(quote.toAmountMinRaw, quote.toToken?.decimals);
  const inAmount = fmtUnits(quote.fromAmountRaw, quote.fromToken?.decimals);
  const rate = Number(inAmount) > 0 ? Number(out) / Number(inAmount) : null;
  const impact = quote.priceImpact;

  return (
    <div className="card">
      <div className="between">
        <span className="eyebrow">Route via {quote.tool}</span>
        {stale && <span className="badge pending">refreshing</span>}
      </div>

      <div className="kv">
        <span className="kv-key">Rate</span>
        <span className="kv-value mono">
          {rate != null ? `1 ${quote.fromToken?.symbol} ≈ ${trimAmount(rate, 6)} ${quote.toToken?.symbol}` : '--'}
        </span>
      </div>

      {/* The guaranteed floor, given more weight than the headline estimate.
          The estimate is what you probably get; this is what you are promised. */}
      <div className="kv">
        <span className="kv-key">
          <b>Minimum received</b>
        </span>
        <span className="kv-value mono">
          <b>
            {trimAmount(min, 6)} {quote.toToken?.symbol}
          </b>
        </span>
      </div>
      <div className="kv">
        <span className="kv-key">Estimated</span>
        <span className="kv-value mono">
          {trimAmount(out, 6)} {quote.toToken?.symbol}
          {quote.toAmountUsd != null ? ` · ${formatFiat(quote.toAmountUsd, currency)}` : ''}
        </span>
      </div>

      {impact != null && (
        <div className="kv">
          <span className="kv-key">Price impact</span>
          <span
            className="kv-value mono"
            style={{ color: impact < -5 ? 'var(--danger)' : impact < -1 ? 'var(--warn)' : 'var(--muted)' }}
          >
            {impact > 0 ? '+' : ''}
            {impact.toFixed(2)}%
          </span>
        </div>
      )}

      {quote.gasUsd != null && (
        <div className="kv">
          <span className="kv-key">Network fee</span>
          <span className="kv-value mono">{formatFiat(quote.gasUsd, currency)}</span>
        </div>
      )}
      {quote.feeUsd ? (
        <div className="kv">
          <span className="kv-key">Route fees</span>
          <span className="kv-value mono">{formatFiat(quote.feeUsd, currency)}</span>
        </div>
      ) : null}
      {quote.durationSeconds != null && (
        <div className="kv">
          <span className="kv-key">Takes about</span>
          <span className="kv-value mono">
            {quote.durationSeconds < 60 ? `${quote.durationSeconds}s` : `${Math.round(quote.durationSeconds / 60)} min`}
          </span>
        </div>
      )}

      {quote.steps?.length > 1 && (
        <span className="item-sub faint">
          {quote.steps.length} steps: {quote.steps.map((step) => step.tool).join(' → ')}
        </span>
      )}

      {impact != null && impact < -5 && (
        <div className="notice danger">
          This route loses {Math.abs(impact).toFixed(1)}% of the value against the quoted prices. That is usually thin
          liquidity for the size — try a smaller amount.
        </div>
      )}
    </div>
  );
}

/**
 * What the wallet independently concluded about the aggregator's transaction.
 *
 * This is the part that distinguishes routing through a third party from
 * trusting one. The quote and the calldata come from the same server; only the
 * simulation is the wallet's own.
 */
export function QuoteVerification({ verification, quote, loading }) {
  if (loading) return <Skeleton height={70} radius={12} />;
  if (!verification) return null;

  return (
    <>
      {verification.problems.map((problem) => (
        <div className="notice danger" role="alert" key={problem}>
          {problem}
        </div>
      ))}

      {verification.pendingApproval ? (
        <div className="notice info">
          The route cannot be simulated until the approval below is in place — without it the swap stops at the
          allowance check. ADRIX will simulate and verify the real transaction once you have approved.
        </div>
      ) : verification.crossChain ? (
        <div className="notice info">
          This is a cross-chain route, so the outgoing leg is all that can be simulated here — the funds arrive on{' '}
          {quote?.toToken?.symbol ? `the destination chain` : 'the other chain'} in a separate transaction, minutes
          later. ADRIX will track it once this is sent.
        </div>
      ) : verification.deliveryConfirmed ? (
        <div className="ok">
          Simulated independently: this transaction really does return at least the minimum quoted.
        </div>
      ) : null}

      <BalanceChanges simulation={verification.simulation} />
    </>
  );
}

/** Live tracking of a bridge from the source transaction to arrival. */
export function BridgeTracker({ txHash, fromChainId, toChainId, tool, onDone }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const poll = async () => {
      try {
        const next = await call('BRIDGE_STATUS', { txHash, fromChainId, toChainId, tool });
        if (cancelled) return;
        setStatus(next);
        if (next.status === 'DONE') onDone?.(next);
        // Keep polling while it is genuinely in flight. NOT_FOUND is expected
        // for the first half-minute while the indexer catches up, so it is not
        // treated as a terminal state.
        if (next.status !== 'DONE' && next.status !== 'FAILED') timer = setTimeout(poll, 12_000);
      } catch (err) {
        if (cancelled) return;
        setError(err.message);
        timer = setTimeout(poll, 20_000);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [txHash, fromChainId, toChainId, tool]);

  const state = status?.status ?? 'PENDING';

  return (
    <div className={`card ${state === 'DONE' ? 'accent' : ''}`}>
      <div className="between">
        <span className="eyebrow">Bridge status</span>
        <span className={`badge ${state === 'DONE' ? 'confirmed' : state === 'FAILED' ? 'failed' : 'pending'}`}>
          {state === 'NOT_FOUND' ? 'indexing' : state.toLowerCase()}
        </span>
      </div>

      {state === 'DONE' ? (
        <p className="small">
          Arrived
          {status.receiving?.amount && status.receiving?.decimals != null
            ? `: ${trimAmount(fmtUnits(status.receiving.amount, status.receiving.decimals), 6)} ${status.receiving.symbol ?? ''}`
            : '.'}
        </p>
      ) : state === 'FAILED' ? (
        <p className="small">
          {status.message ?? 'The bridge reported a failure. Funds are usually refunded on the source chain.'}
        </p>
      ) : (
        <p className="small">
          {status?.message ??
            'The source transaction is in. Funds are in flight and will land on the destination chain in a separate transaction — you can close this window.'}
        </p>
      )}

      {status?.receiving?.txHash && <div className="data-block">{status.receiving.txHash}</div>}
      {error && <p className="small faint">Status check failed: {error}. Retrying.</p>}
    </div>
  );
}

/** Shared fee picker for the send step. */
export function SwapFeeControls({ gasInfo, preset, setPreset }) {
  if (!gasInfo) return null;
  return (
    <div className="stack-sm">
      <h3>Network fee</h3>
      <GasPresetGrid gasInfo={gasInfo} preset={preset} onSelect={setPreset} />
    </div>
  );
}
