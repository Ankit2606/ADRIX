import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits } from 'ethers';
import { call, shorten, trimAmount, formatFiat } from '../../lib/ui.js';
import { BalanceChanges, GasPresetGrid, Skeleton } from './common.jsx';

/**
 * Slippage worth accepting for a given route.
 *
 * A fixed default is wrong in both directions: 0.5% is far too tight for a thin
 * pair and needlessly loose for a stablecoin pair. This suggests a floor based
 * on what the route's own price impact already implies.
 */
export function suggestSlippage(quote) {
  const impact = Math.abs(quote?.priceImpact ?? 0);
  if (!Number.isFinite(impact) || impact === 0) return null;
  // Headroom above the impact the quote already shows, since that impact will
  // move between quoting and inclusion.
  const suggested = Math.min(MAX_SLIPPAGE_UI, Math.max(0.005, (impact / 100) * 1.5));
  return Math.round(suggested * 10000) / 10000;
}

export const MAX_SLIPPAGE_UI = 0.05;

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

/**
 * The aggregator's token list for one chain, cached per chain.
 *
 * Shared rather than fetched per selector: the list runs to well over a
 * thousand entries and both sides of a swap need the same one — including the
 * parent, which needs the selected token's decimals to convert an amount at all.
 */
const tokenListCache = new Map();

export function useTokenList(chainId) {
  const [tokens, setTokens] = useState(() => tokenListCache.get(chainId) ?? []);
  const [loading, setLoading] = useState(!tokenListCache.has(chainId));

  useEffect(() => {
    const cached = tokenListCache.get(chainId);
    if (cached) {
      setTokens(cached);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setTokens([]);
    call('SWAP_TOKENS', { chainId })
      .then((result) => {
        if (cancelled) return;
        const list = result.tokens ?? [];
        tokenListCache.set(chainId, list);
        setTokens(list);
      })
      .catch(() => !cancelled && setTokens([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  const find = useCallback(
    (address) => tokens.find((token) => token.address?.toLowerCase() === String(address ?? '').toLowerCase()) ?? null,
    [tokens]
  );

  return { tokens, loading, find };
}

/**
 * The pill that opens the picker.
 *
 * Kept separate from the picker panel itself. Rendering the open list inside
 * this button's flex row is what made it overflow the popup — a full-width
 * panel cannot live inside a row sized for a pill.
 */
export function TokenTrigger({ token, label, onOpen, loading }) {
  return (
    <button className="token-select" onClick={onOpen} disabled={loading}>
      {token?.logoURI ? (
        <img className="token-logo" src={token.logoURI} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="token-icon sm">{token?.symbol?.charAt(0) ?? '?'}</span>
      )}
      <span className="token-select-text">
        <span className="token-select-symbol">{loading ? '…' : (token?.symbol ?? 'Select')}</span>
        <span className="token-select-label">{label}</span>
      </span>
      <span className="caret" aria-hidden="true">
        ▼
      </span>
    </button>
  );
}

/**
 * Full-width token picker.
 *
 * Renders as its own block, never nested in a flex row. Each row carries the
 * chain it belongs to, its unit price, and — where the aggregator reports one —
 * its verification status, because a list this long is mostly tokens the user
 * has never heard of and the symbol alone does not distinguish them.
 */
export function TokenPicker({ chainId, chainName, tokens, loading, exclude, balances, onPick, onClose, title }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const held = new Map(
    (balances ?? []).map((entry) => [entry.address?.toLowerCase(), entry])
  );

  const visible = tokens
    .filter((token) => token.address?.toLowerCase() !== exclude?.toLowerCase())
    .filter(
      (token) =>
        !needle ||
        token.symbol?.toLowerCase().includes(needle) ||
        token.name?.toLowerCase().includes(needle) ||
        token.address?.toLowerCase().includes(needle)
    )
    // Tokens the user actually holds float to the top — with a thousand-plus
    // entries, alphabetical order buries the handful that matter.
    .sort((a, b) => {
      const aHeld = held.has(a.address?.toLowerCase()) ? 1 : 0;
      const bHeld = held.has(b.address?.toLowerCase()) ? 1 : 0;
      return bHeld - aHeld;
    })
    .slice(0, 60);

  return (
    <div className="card token-picker-panel">
      <div className="between">
        <span className="eyebrow">
          {title} · {chainName}
        </span>
        <button className="link" onClick={onClose}>
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
          spellCheck="false"
        />
      </label>

      {loading ? (
        <Skeleton height={54} radius={10} />
      ) : (
        <div className="list token-picker">
          {visible.map((token) => {
            const balance = held.get(token.address?.toLowerCase());
            return (
              <button className="token-row" key={token.address} onClick={() => onPick(token)}>
                {token.logoURI ? (
                  <img className="token-logo" src={token.logoURI} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className="token-icon sm">{token.symbol?.charAt(0) ?? '?'}</span>
                )}

                <span className="token-row-main">
                  <span className="token-row-top">
                    <span className="token-row-symbol">{token.symbol}</span>
                    {token.verificationStatus === 'verified' && (
                      <span className="badge confirmed token-row-badge">verified</span>
                    )}
                  </span>
                  <span className="token-row-sub">{token.name}</span>
                  <span className="token-row-meta">
                    {chainName} · {shorten(token.address, 6, 4)}
                  </span>
                </span>

                <span className="token-row-right">
                  {balance && <span className="token-row-balance">{trimAmount(balance.balance, 4)}</span>}
                  {Number(token.priceUSD) > 0 && (
                    <span className="token-row-price">{formatFiat(Number(token.priceUSD), 'usd')}</span>
                  )}
                </span>
              </button>
            );
          })}
          {!visible.length && <p className="small faint">No token matches that search.</p>}
        </div>
      )}

      <p className="small faint">
        {tokens.length.toLocaleString()} tokens on {chainName}
        {visible.length >= 60 ? ' · showing the first 60, keep typing to narrow it' : ''}
      </p>
    </div>
  );
}

/**
 * Slippage control.
 *
 * Every setting is stated as what it costs rather than as a number: slippage is
 * a floor on what you accept, and a loose one is a standing offer to whoever is
 * watching the mempool. Where the route's own price impact already exceeds the
 * tolerance, the quote cannot execute — that is worth catching here rather than
 * as a revert.
 */
export function SlippageControl({ value, onChange, quote, symbol }) {
  const [custom, setCustom] = useState('');
  const suggestion = suggestSlippage(quote);
  const impact = Math.abs(quote?.priceImpact ?? 0);
  const tooTight = impact > 0 && value * 100 < impact;

  // What the tolerance is worth in the output token, which is the number people
  // can actually judge — "0.5%" of an unfamiliar token is not.
  const atRisk =
    quote?.toAmountRaw && quote?.toToken?.decimals != null
      ? Number(fmtUnits(quote.toAmountRaw, quote.toToken.decimals)) * value
      : null;

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
            if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_SLIPPAGE_UI) onChange(parsed);
          }}
          aria-label="Custom slippage percent"
        />
      </div>

      {atRisk != null && (
        <div className="between small faint">
          <span>Worst case you accept</span>
          <span className="mono">
            up to {trimAmount(atRisk, 6)} {symbol ?? quote?.toToken?.symbol} less
          </span>
        </div>
      )}

      {tooTight && (
        <div className="notice danger">
          This route already moves the price {impact.toFixed(2)}%, which is more than the {(value * 100).toFixed(2)}%
          you are allowing — it will revert.
          {suggestion && (
            <button className="link accent" onClick={() => onChange(suggestion)}>
              Raise to {(suggestion * 100).toFixed(2)}%
            </button>
          )}
        </div>
      )}

      {!tooTight && value > 0.01 && (
        <div className="notice">
          {(value * 100).toFixed(2)}% means you accept receiving that much less than quoted. Anyone watching the
          mempool can take the difference, and at this size it is worth their while.
        </div>
      )}
    </div>
  );
}

/**
 * Price impact, called out separately from the route summary.
 *
 * Impact is the cost of the trade itself moving the price — distinct from fees
 * and from slippage, and the one people conflate. Below a percent it is noise;
 * past a few percent it usually means the pool is too thin for the size, which
 * is actionable in a way "high impact" is not.
 */
export function PriceImpactWarning({ quote }) {
  const impact = quote?.priceImpact;
  if (impact == null || impact > -1) return null;

  const magnitude = Math.abs(impact);
  const severe = magnitude >= 5;

  return (
    <div className={severe ? 'notice danger' : 'notice'}>
      <b>This trade moves the price {magnitude.toFixed(2)}%.</b>
      <p className="small">
        {severe
          ? `You would receive about ${magnitude.toFixed(1)}% less value than you put in, before fees. That is thin liquidity for this size — a smaller amount, or splitting it across several trades, usually costs far less.`
          : 'Part of the difference between what you pay and what you receive is the trade moving the price against itself, not a fee.'}
      </p>
      {quote.fromAmountUsd != null && quote.toAmountUsd != null && (
        <div className="between small">
          <span className="faint">Value in / out</span>
          <span className="mono">
            {formatFiat(quote.fromAmountUsd, 'usd')} → {formatFiat(quote.toAmountUsd, 'usd')}
          </span>
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
