import { useEffect, useMemo, useState } from 'react';
import { parseUnits } from 'ethers';
import { call, trimAmount, timeAgo, formatFiat, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState } from '../components/common.jsx';
import {
  NATIVE_TOKEN,
  PriceImpactWarning,
  QuoteSummary,
  QuoteVerification,
  SlippageControl,
  SwapFeeControls,
  TokenPicker,
  TokenTrigger,
  fmtUnits,
  useQuote,
  useTokenList,
} from '../components/swap.jsx';

/**
 * Token swapping through the LI.FI aggregator.
 *
 * The flow is deliberately four steps rather than one button: pick, review the
 * route, approve if the router needs an allowance, then confirm a transaction
 * the wallet has simulated for itself. Collapsing that into "Swap" is how people
 * end up signing calldata nobody looked at.
 */
export default function Swap({ state, go }) {
  const chainId = state.chainId;
  const [fromToken, setFromToken] = useState(NATIVE_TOKEN);
  const [toToken, setToToken] = useState('');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(0.005);
  const [step, setStep] = useState('form');
  const [portfolio, setPortfolio] = useState(null);
  const [allowance, setAllowance] = useState(null);
  const [verification, setVerification] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [gasInfo, setGasInfo] = useState(null);
  const [preset, setPreset] = useState('market');
  const [hash, setHash] = useState('');
  const [supported, setSupported] = useState(null);
  const [picker, setPicker] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const currency = portfolio?.currency ?? state.currency ?? 'usd';
  const { tokens, loading: tokensLoading, find: findToken } = useTokenList(chainId);

  useEffect(() => {
    call('GET_PORTFOLIO').then(setPortfolio).catch(() => {});
    call('SWAP_CHAINS')
      .then((result) => setSupported(result.chains ?? []))
      .catch(() => setSupported([]));
  }, [state.selected, state.chainId]);

  /**
   * Decimals come from the token's own metadata, not from the wallet.
   *
   * This is what broke quoting: the picker offers the aggregator's full list —
   * well over a thousand tokens per chain — but the lookup only searched the
   * handful the wallet tracks. Selecting anything else produced no decimals, so
   * no amount, so no quote, and the screen sat on "0.0" with no explanation.
   * The balance is a separate question and is allowed to be unknown.
   */
  const sellAsset = useMemo(() => {
    const meta = findToken(fromToken);
    const isNative = fromToken?.toLowerCase() === NATIVE_TOKEN.toLowerCase();

    const held = isNative
      ? { balance: portfolio?.native?.balance, raw: portfolio?.native?.raw }
      : (() => {
          const tracked = portfolio?.tokens?.find((t) => t.address?.toLowerCase() === fromToken?.toLowerCase());
          return tracked ? { balance: tracked.balance, raw: tracked.raw } : { balance: null, raw: null };
        })();

    if (!meta && !isNative) return null;

    return {
      symbol: meta?.symbol ?? portfolio?.native?.symbol ?? '',
      decimals: meta?.decimals ?? 18,
      priceUSD: meta?.priceUSD ? Number(meta.priceUSD) : null,
      logoURI: meta?.logoURI ?? null,
      native: isNative,
      ...held,
    };
  }, [findToken, fromToken, portfolio]);

  const buyAsset = useMemo(() => findToken(toToken), [findToken, toToken]);

  const amountRaw = useMemo(() => {
    if (!amount || !sellAsset) return null;
    try {
      const parsed = parseUnits(amount, sellAsset.decimals ?? 18);
      return parsed > 0n ? parsed.toString() : null;
    } catch {
      return null;
    }
  }, [amount, sellAsset]);

  // Only meaningful when the wallet actually knows the balance. An untracked
  // token has none, and treating unknown as zero would block every such swap.
  const overBalance = Boolean(amountRaw && sellAsset?.raw && BigInt(amountRaw) > BigInt(sellAsset.raw));
  const balanceKnown = sellAsset?.raw != null;

  const { quote, error: quoteError, loading: quoting, fetchedAt } = useQuote({
    enabled: Boolean(amountRaw && toToken && fromToken && !overBalance),
    params: {
      fromChainId: chainId,
      toChainId: chainId,
      fromToken,
      toToken,
      fromAmountRaw: amountRaw,
      slippage,
    },
  });

  const chainSupported = supported === null || supported.some((c) => c.chainId === chainId);

  // --- review -----------------------------------------------------------------
  const openReview = () =>
    run(async () => {
      if (!quote) throw new Error('Wait for a route before continuing.');
      setVerifying(true);
      setVerification(null);
      try {
        // Allowance first, then verification — sequential on purpose. Until the
        // router can pull the token the swap reverts on the allowance check,
        // and a verification run without knowing that reports the revert as a
        // broken route for every ERC-20 swap.
        const allow = await call('SWAP_ALLOWANCE', {
          chainId,
          token: fromToken,
          spender: quote.approvalAddress,
          amountRaw: quote.fromAmountRaw,
        });
        setAllowance(allow);

        const verified = await call('SWAP_VERIFY', { quote, allowanceReady: !allow.needed });
        setVerification(verified);
        // Gas is priced against the aggregator's own transaction, not a generic
        // transfer — these routes are long and a default estimate undershoots.
        setGasInfo(
          await call('ESTIMATE_GAS', {
            request: {
              from: state.selected,
              to: quote.transactionRequest?.to,
              value: quote.transactionRequest?.value ?? '0x0',
              data: quote.transactionRequest?.data ?? '0x',
            },
          }).catch(() => null)
        );
        setStep('review');
      } finally {
        setVerifying(false);
      }
    });

  const doApprove = () =>
    run(async () => {
      await call('SWAP_APPROVE', {
        chainId,
        token: fromToken,
        spender: quote.approvalAddress,
        amountRaw: quote.fromAmountRaw,
      });
      // Re-read rather than assuming: the approval has to actually land before
      // the swap can pull the tokens.
      const allow = await call('SWAP_ALLOWANCE', {
        chainId,
        token: fromToken,
        spender: quote.approvalAddress,
        amountRaw: quote.fromAmountRaw,
      });
      setAllowance(allow);

      // Now that the router can move the token, the route can finally be
      // simulated for real — which is the check worth having.
      if (!allow.needed) {
        setVerifying(true);
        try {
          setVerification(await call('SWAP_VERIFY', { quote, allowanceReady: true }));
        } finally {
          setVerifying(false);
        }
      }
    });

  const doSwap = () =>
    run(async () => {
      const result = await call('SWAP_EXECUTE', {
        quote,
        fees: gasInfo?.options?.[preset],
        gas: gasInfo?.gasLimit,
      });
      setHash(result.hash);
      setStep('sent');
    });

  // --- screens ----------------------------------------------------------------
  if (step === 'sent') {
    return (
      <div className="screen">
        <BackBar title="Swap submitted" onBack={() => go('home')} />
        <div className="scroll pad stack">
          <div className="beam" />
          <h1>Swap submitted</h1>
          <p>
            Swapping {trimAmount(fmtUnits(quote.fromAmountRaw, quote.fromToken?.decimals), 6)}{' '}
            {quote.fromToken?.symbol} for at least{' '}
            {trimAmount(fmtUnits(quote.toAmountMinRaw, quote.toToken?.decimals), 6)} {quote.toToken?.symbol}.
          </p>
          <div className="data-block">{hash}</div>
          {state.network?.explorer && (
            <a className="link accent" href={`${state.network.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
              Open in block explorer ↗
            </a>
          )}
          <p className="small faint">
            The received token may not be tracked yet — add it from the Tokens tab if it does not appear.
          </p>
        </div>
        <div className="footer">
          <button className="primary" onClick={() => go('home')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (step === 'review') {
    const needsApproval = allowance?.needed;
    const fatal = verification?.problems?.some((p) => /will not sign|do not sign/i.test(p));

    return (
      <div className="screen">
        <BackBar title="Review swap" onBack={() => setStep('form')} />
        <div className="scroll pad stack">
          <div className="swap-hero">
            <div className="swap-leg">
              <span className="swap-amount">
                −{trimAmount(fmtUnits(quote.fromAmountRaw, quote.fromToken?.decimals), 6)}
              </span>
              <span className="swap-symbol">{quote.fromToken?.symbol}</span>
            </div>
            <span className="swap-arrow" aria-hidden="true">
              ↓
            </span>
            <div className="swap-leg">
              <span className="swap-amount in">
                +{trimAmount(fmtUnits(quote.toAmountRaw, quote.toToken?.decimals), 6)}
              </span>
              <span className="swap-symbol">{quote.toToken?.symbol}</span>
            </div>
          </div>

          <QuoteSummary quote={quote} currency={currency} stale={quoting} />

          <QuoteVerification verification={verification} quote={quote} loading={verifying} />

          {needsApproval && (
            <div className="card accent">
              <div className="eyebrow accent-text">Approval needed first</div>
              <p className="small">
                {quote.fromToken?.symbol} is an ERC-20, so the router has to be allowed to move it before the swap can
                run. ADRIX approves <b>exactly {trimAmount(fmtUnits(quote.fromAmountRaw, quote.fromToken?.decimals), 6)}{' '}
                {quote.fromToken?.symbol}</b>, not an unlimited amount — the next swap will ask again, which is the
                trade being made deliberately.
              </p>
              <div className="kv">
                <span className="kv-key">Spender</span>
                <span className="kv-value mono">{allowance.spender}</span>
              </div>
              <button className="primary" onClick={doApprove} disabled={busy}>
                {busy ? 'Approving…' : `Approve ${quote.fromToken?.symbol}`}
              </button>
            </div>
          )}

          <SwapFeeControls gasInfo={gasInfo} preset={preset} setPreset={setPreset} />

          <div className="notice">
            This route is built and priced by LI.FI, a third-party aggregator. ADRIX does not choose the venue, takes no
            fee, and cannot reverse the trade. What it does do is simulate the transaction itself before you sign it.
          </div>

          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => setStep('form')} disabled={busy}>
              Back
            </button>
            <button className="primary" onClick={doSwap} disabled={busy || needsApproval || fatal}>
              {busy ? 'Sending…' : needsApproval ? 'Approve first' : 'Confirm swap'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- form -------------------------------------------------------------------
  return (
    <div className="screen">
      <BackBar title="Swap" onBack={() => go('home')} />
      <div className="scroll pad stack">
        {!chainSupported ? (
          <EmptyState
            icon="⇌"
            title={`No routes on ${state.network?.name}`}
            body="The aggregator does not cover this network. Switch to a supported one to swap."
            action={
              <button className="ghost" onClick={() => go('networks')}>
                Switch network
              </button>
            }
          />
        ) : (
          <>
            {/* The picker replaces the form rather than opening inside it. A
                full-width list cannot live in the row sized for a pill, which
                is what pushed the whole screen sideways. */}
            {picker ? (
              <TokenPicker
                chainId={chainId}
                chainName={state.network?.name ?? 'this network'}
                tokens={tokens}
                loading={tokensLoading}
                title={picker === 'from' ? 'Pay with' : 'Receive'}
                exclude={picker === 'from' ? toToken : fromToken}
                balances={portfolio?.tokens}
                onClose={() => setPicker(null)}
                onPick={(token) => {
                  if (picker === 'from') setFromToken(token.address);
                  else setToToken(token.address);
                  setPicker(null);
                }}
              />
            ) : (
              <>
                <div className="card">
                  <div className="between">
                    <span className="eyebrow">You pay</span>
                    {balanceKnown && (
                      <button
                        className="link accent"
                        onClick={() =>
                          setAmount(
                            // Leaving the full native balance would leave
                            // nothing for gas, so a slice is held back.
                            sellAsset.native
                              ? String(Math.max(0, Number(sellAsset.balance) * 0.98))
                              : String(sellAsset.balance ?? '')
                          )
                        }
                      >
                        max {trimAmount(sellAsset.balance)}
                      </button>
                    )}
                  </div>
                  <div className="swap-input">
                    <input
                      className="mono"
                      inputMode="decimal"
                      placeholder="0.0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                      aria-invalid={overBalance}
                      aria-label="Amount to swap"
                    />
                    <TokenTrigger token={sellAsset} label="from" loading={tokensLoading} onOpen={() => setPicker('from')} />
                  </div>
                  <div className="between small faint">
                    <span>
                      {sellAsset?.priceUSD && amount
                        ? `≈ ${formatFiat(Number(amount) * sellAsset.priceUSD, currency)}`
                        : ''}
                    </span>
                    {!balanceKnown && sellAsset && (
                      <span>Balance unknown — {sellAsset.symbol} is not tracked in this wallet</span>
                    )}
                  </div>
                  {overBalance && <div className="error">That is more than the {sellAsset?.symbol} available.</div>}
                </div>

                <button
                  className="swap-flip"
                  onClick={() => {
                    setFromToken(toToken || NATIVE_TOKEN);
                    setToToken(fromToken);
                    setAmount('');
                  }}
                  aria-label="Swap direction"
                  disabled={!toToken}
                >
                  ⇅
                </button>

                <div className="card">
                  <span className="eyebrow">You receive</span>
                  <div className="swap-input">
                    <span className="mono swap-output">
                      {quote
                        ? trimAmount(fmtUnits(quote.toAmountRaw, quote.toToken?.decimals), 6)
                        : quoting
                          ? '…'
                          : '0.0'}
                    </span>
                    <TokenTrigger token={buyAsset} label="to" loading={tokensLoading} onOpen={() => setPicker('to')} />
                  </div>
                  <div className="between small faint">
                    {/* Priced from the token list even before a route exists,
                        so the output side is never a bare zero with no price. */}
                    <span>
                      {quote?.toAmountUsd != null
                        ? `≈ ${formatFiat(quote.toAmountUsd, currency)}`
                        : buyAsset?.priceUSD
                          ? `1 ${buyAsset.symbol} ≈ ${formatFiat(Number(buyAsset.priceUSD), currency)}`
                          : ''}
                    </span>
                    {quoting && <span>finding a route…</span>}
                  </div>
                </div>

                <SlippageControl
                  value={slippage}
                  onChange={setSlippage}
                  quote={quote}
                  symbol={buyAsset?.symbol}
                />

                <PriceImpactWarning quote={quote} />

                {quote && <QuoteSummary quote={quote} currency={currency} stale={quoting} />}
                {fetchedAt && (
                  <p className="small faint center">
                    Quote from {timeAgo(fetchedAt)}, refreshed automatically. Rates move between quoting and signing.
                  </p>
                )}

                {quoteError && <div className="notice">{quoteError}</div>}
                {error && <div className="error" role="alert">{error}</div>}
              </>
            )}
          </>
        )}
      </div>

      {chainSupported && !picker && (
        <div className="footer">
          <button
            className="primary"
            onClick={openReview}
            disabled={busy || verifying || !quote || overBalance || quoting}
          >
            {/* Reports which step is actually outstanding. "Enter an amount"
                while an amount is on screen is what made the earlier failure
                impossible to diagnose. */}
            {verifying
              ? 'Checking route…'
              : quoting
                ? 'Finding a route…'
                : quote
                  ? 'Review swap'
                  : !toToken
                    ? 'Choose a token to receive'
                    : !amountRaw
                      ? 'Enter an amount'
                      : overBalance
                        ? 'Amount exceeds balance'
                        : quoteError
                          ? 'No route for this pair'
                          : 'Finding a route…'}
          </button>
        </div>
      )}
    </div>
  );
}
