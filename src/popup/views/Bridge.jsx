import { useEffect, useMemo, useState } from 'react';
import { parseUnits } from 'ethers';
import { call, trimAmount, timeAgo, formatFiat, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState } from '../components/common.jsx';
import {
  NATIVE_TOKEN,
  BridgeTracker,
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
 * Cross-chain transfers, through the same aggregator as swapping.
 *
 * The difference that shapes the whole screen: a bridge is two transactions on
 * two chains, and only the first one is signed here. The second arrives minutes
 * later and the wallet cannot simulate it, so this is explicit that the source
 * transaction confirming is not the same as the money arriving — and it tracks
 * the destination leg rather than declaring success early.
 */
export default function Bridge({ state, go }) {
  const [fromChainId, setFromChainId] = useState(state.chainId);
  const [toChainId, setToChainId] = useState('');
  const [fromToken, setFromToken] = useState(NATIVE_TOKEN);
  const [toToken, setToToken] = useState('');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(0.005);
  const [step, setStep] = useState('form');
  const [chains, setChains] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [allowance, setAllowance] = useState(null);
  const [verification, setVerification] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [gasInfo, setGasInfo] = useState(null);
  const [preset, setPreset] = useState('market');
  const [hash, setHash] = useState('');
  const [picker, setPicker] = useState(null);
  const [refuel, setRefuel] = useState(false);
  const [destGas, setDestGas] = useState(null);
  const { busy, error, run } = useAsyncAction();

  const currency = portfolio?.currency ?? state.currency ?? 'usd';
  const fromList = useTokenList(fromChainId);
  const toList = useTokenList(toChainId);

  useEffect(() => {
    call('GET_PORTFOLIO').then(setPortfolio).catch(() => {});
    call('SWAP_CHAINS')
      .then((result) => {
        const list = result.chains ?? [];
        setChains(list);
        // Default the destination to the first supported chain that is not the
        // source, so the screen opens on a valid pair.
        setToChainId((current) => current || list.find((c) => c.chainId !== state.chainId)?.chainId || '');
      })
      .catch(() => setChains([]));
  }, [state.chainId, state.selected]);

  // Whether the destination chain can actually be transacted on after arrival.
  useEffect(() => {
    if (!toChainId) return;
    call('DESTINATION_GAS', { chainId: toChainId })
      .then((info) => {
        setDestGas(info);
        // Defaulted on where the user would otherwise arrive stranded — tokens
        // present, no gas to move them.
        if (info.stranded) setRefuel(true);
      })
      .catch(() => setDestGas(null));
  }, [toChainId, state.selected]);

  // Decimals come from the token list, not the wallet — the picker offers every
  // token the aggregator supports and only a few are tracked here.
  const sellAsset = useMemo(() => {
    const meta = fromList.find(fromToken);
    const isNative = fromToken?.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    const onCurrentChain = fromChainId === state.chainId;

    const held = !onCurrentChain
      ? { balance: null, raw: null }
      : isNative
        ? { balance: portfolio?.native?.balance, raw: portfolio?.native?.raw }
        : (() => {
            const t = portfolio?.tokens?.find((x) => x.address?.toLowerCase() === fromToken?.toLowerCase());
            return t ? { balance: t.balance, raw: t.raw } : { balance: null, raw: null };
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
  }, [fromList, fromToken, portfolio, fromChainId, state.chainId]);

  const buyAsset = useMemo(() => toList.find(toToken), [toList, toToken]);

  const amountRaw = useMemo(() => {
    if (!amount) return null;
    try {
      const parsed = parseUnits(amount, sellAsset?.decimals ?? 18);
      return parsed > 0n ? parsed.toString() : null;
    } catch {
      return null;
    }
  }, [amount, sellAsset]);

  // Roughly 2% of the amount, which is enough for a handful of transfers on any
  // chain without meaningfully denting what is being bridged.
  const refuelRaw = useMemo(() => {
    if (!refuel || !amountRaw) return null;
    const slice = (BigInt(amountRaw) * 2n) / 100n;
    return slice > 0n ? slice.toString() : null;
  }, [refuel, amountRaw]);

  const overBalance = Boolean(amountRaw && sellAsset?.raw && BigInt(amountRaw) > BigInt(sellAsset.raw));
  const sameChain = fromChainId === toChainId;
  // Signing happens on the source chain, so the wallet has to be on it.
  const wrongNetwork = fromChainId !== state.chainId;

  const { quote, error: quoteError, loading: quoting, fetchedAt } = useQuote({
    enabled: Boolean(amountRaw && toToken && fromToken && !sameChain && !overBalance && !wrongNetwork),
    params: { fromChainId, toChainId, fromToken, toToken, fromAmountRaw: amountRaw, slippage, gasRefuelRaw: refuelRaw },
    intervalMs: 30_000,
  });

  const balanceKnown = sellAsset?.raw != null;

  const openReview = () =>
    run(async () => {
      setVerifying(true);
      setVerification(null);
      try {
        // Sequential: without an allowance the route reverts on that check, and
        // verifying before knowing would report it as a broken route.
        const allow = await call('SWAP_ALLOWANCE', {
          chainId: fromChainId,
          token: fromToken,
          spender: quote.approvalAddress,
          amountRaw: quote.fromAmountRaw,
        });
        setAllowance(allow);

        const verified = await call('SWAP_VERIFY', { quote, allowanceReady: !allow.needed });
        setVerification(verified);
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
        chainId: fromChainId,
        token: fromToken,
        spender: quote.approvalAddress,
        amountRaw: quote.fromAmountRaw,
      });
      const allow = await call('SWAP_ALLOWANCE', {
        chainId: fromChainId,
        token: fromToken,
        spender: quote.approvalAddress,
        amountRaw: quote.fromAmountRaw,
      });
      setAllowance(allow);

      if (!allow.needed) {
        setVerifying(true);
        try {
          setVerification(await call('SWAP_VERIFY', { quote, allowanceReady: true }));
        } finally {
          setVerifying(false);
        }
      }
    });

  const doBridge = () =>
    run(async () => {
      const result = await call('SWAP_EXECUTE', {
        quote,
        fees: gasInfo?.options?.[preset],
        gas: gasInfo?.gasLimit,
      });
      setHash(result.hash);
      setStep('sent');
    });

  const chainName = (id) => chains?.find((c) => c.chainId === id)?.name ?? id;

  // --- screens ----------------------------------------------------------------
  if (step === 'sent') {
    return (
      <div className="screen">
        <BackBar title="Bridging" onBack={() => go('home')} />
        <div className="scroll pad stack">
          <div className="beam" />
          <h1>Sent from {chainName(fromChainId)}</h1>
          <p>
            The source transaction is on its way. Funds arrive on {chainName(toChainId)} in a{' '}
            <b>separate transaction</b> — usually within{' '}
            {quote.durationSeconds ? `${Math.max(1, Math.round(quote.durationSeconds / 60))} minutes` : 'a few minutes'}.
          </p>

          <BridgeTracker
            txHash={hash}
            fromChainId={fromChainId}
            toChainId={toChainId}
            tool={quote.tool}
          />

          <div className="data-block">{hash}</div>
          {state.network?.explorer && (
            <a className="link accent" href={`${state.network.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
              Source transaction in explorer ↗
            </a>
          )}
          <p className="small faint">
            Closing this window does not stop the bridge. Nothing in ADRIX needs to stay open for the funds to land.
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
        <BackBar title="Review bridge" onBack={() => setStep('form')} />
        <div className="scroll pad stack">
          <div className="card">
            <div className="chain-hop">
              <div className="chain-hop-side">
                <span className="chain-hop-label">From</span>
                <span className="chain-hop-name">{chainName(fromChainId)}</span>
                <span className="chain-hop-meta mono">
                  −{trimAmount(fmtUnits(quote.fromAmountRaw, quote.fromToken?.decimals), 6)}{' '}
                  {quote.fromToken?.symbol}
                </span>
              </div>
              <span className="chain-hop-arrow" aria-hidden="true">
                →
              </span>
              <div className="chain-hop-side">
                <span className="chain-hop-label">To</span>
                <span className="chain-hop-name">{chainName(toChainId)}</span>
                <span className="chain-hop-meta mono">
                  +{trimAmount(fmtUnits(quote.toAmountRaw, quote.toToken?.decimals), 6)} {quote.toToken?.symbol}
                </span>
              </div>
            </div>
          </div>

          <QuoteSummary quote={quote} currency={currency} stale={quoting} />

          <QuoteVerification verification={verification} quote={quote} loading={verifying} />

          {needsApproval && (
            <div className="card accent">
              <div className="eyebrow accent-text">Approval needed first</div>
              <p className="small">
                The bridge contract needs permission to move your {quote.fromToken?.symbol}. ADRIX approves exactly the
                amount being bridged, not an unlimited allowance.
              </p>
              <button className="primary" onClick={doApprove} disabled={busy}>
                {busy ? 'Approving…' : `Approve ${quote.fromToken?.symbol}`}
              </button>
            </div>
          )}

          <SwapFeeControls gasInfo={gasInfo} preset={preset} setPreset={setPreset} />

          <div className="notice">
            Bridges are the highest-risk operation in this wallet. The funds leave {chainName(fromChainId)}
            immediately and depend on {quote.tool} to deliver them on {chainName(toChainId)}. If it fails, recovery
            depends on that bridge, not on ADRIX.
          </div>

          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => setStep('form')} disabled={busy}>
              Back
            </button>
            <button className="primary" onClick={doBridge} disabled={busy || needsApproval || fatal}>
              {busy ? 'Sending…' : needsApproval ? 'Approve first' : 'Confirm bridge'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- form -------------------------------------------------------------------
  if (chains && !chains.length) {
    return (
      <div className="screen">
        <BackBar title="Bridge" onBack={() => go('home')} />
        <div className="scroll pad">
          <EmptyState icon="⇄" title="Bridge unavailable" body="The route service could not be reached." />
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <BackBar title="Bridge" onBack={() => go('home')} />
      <div className="scroll pad stack">
        {picker ? (
          <TokenPicker
            chainId={picker === 'from' ? fromChainId : toChainId}
            chainName={chainName(picker === 'from' ? fromChainId : toChainId)}
            tokens={picker === 'from' ? fromList.tokens : toList.tokens}
            loading={picker === 'from' ? fromList.loading : toList.loading}
            title={picker === 'from' ? 'Send' : 'Receive'}
            balances={picker === 'from' && fromChainId === state.chainId ? portfolio?.tokens : []}
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
          <div className="row2">
            <label className="field">
              <span>From network</span>
              <select value={fromChainId} onChange={(e) => setFromChainId(e.target.value)}>
                {(chains ?? []).map((chain) => (
                  <option key={chain.chainId} value={chain.chainId}>
                    {chain.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>To network</span>
              <select value={toChainId} onChange={(e) => setToChainId(e.target.value)}>
                {(chains ?? [])
                  .filter((chain) => chain.chainId !== fromChainId)
                  .map((chain) => (
                    <option key={chain.chainId} value={chain.chainId}>
                      {chain.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          {wrongNetwork && (
            <div className="notice">
              The transaction is signed on {chainName(fromChainId)}, so the wallet has to be on that network.
              <button
                className="link accent"
                onClick={() =>
                  run(async () => {
                    await call('SET_CHAIN', { chainId: fromChainId });
                    go('bridge');
                  })
                }
              >
                Switch to {chainName(fromChainId)}
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="between">
            <span className="eyebrow">You send</span>
            {sellAsset && (
              <button
                className="link accent"
                onClick={() =>
                  setAmount(
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
              aria-label="Amount to bridge"
            />
            <TokenTrigger token={sellAsset} label="asset" loading={fromList.loading} onOpen={() => setPicker('from')} />
          </div>
          {overBalance && <div className="error">That is more than the {sellAsset?.symbol} available.</div>}
        </div>

        <div className="card">
          <span className="eyebrow">You receive on {chainName(toChainId)}</span>
          <div className="swap-input">
            <span className="mono swap-output">
              {quote ? trimAmount(fmtUnits(quote.toAmountRaw, quote.toToken?.decimals), 6) : quoting ? '…' : '0.0'}
            </span>
            <TokenTrigger token={buyAsset} label="asset" loading={toList.loading} onOpen={() => setPicker('to')} />
          </div>
          {quote?.toAmountUsd != null && <span className="small faint">≈ {formatFiat(quote.toAmountUsd, currency)}</span>}
        </div>

        {/* Cross-chain gas. Arriving with tokens and no native coin is the
            classic bridging dead end: the funds are visibly there and cannot
            be moved, and fixing it afterwards needs a second bridge. */}
        <div className="card">
          <label className="check-line">
            <input type="checkbox" checked={refuel} onChange={(e) => setRefuel(e.target.checked)} />
            <span className="item-main">
              <span>Also deliver gas on {chainName(toChainId)}</span>
              <span className="small faint">
                Converts about 2% of the amount into {destGas?.symbol ?? 'the destination coin'} so the funds are
                usable the moment they land.
              </span>
            </span>
          </label>

          {destGas?.stranded && (
            <div className="notice">
              This account holds almost no {destGas.symbol} on {chainName(toChainId)}. Without gas delivered alongside,
              anything bridged there cannot be moved until you fund it separately.
            </div>
          )}

          {quote?.refuel && (
            <div className="between small">
              <span className="faint">Gas being delivered</span>
              <span className="mono">
                {quote.refuel.amountUsd != null ? formatFiat(quote.refuel.amountUsd, currency) : '--'}
                {quote.refuel.token ? ` of ${quote.refuel.token}` : ''}
              </span>
            </div>
          )}
        </div>

        <SlippageControl value={slippage} onChange={setSlippage} quote={quote} symbol={buyAsset?.symbol} />

        <PriceImpactWarning quote={quote} />

        {quote && <QuoteSummary quote={quote} currency={currency} stale={quoting} />}
        {fetchedAt && (
          <p className="small faint center">Quote from {timeAgo(fetchedAt)}, refreshed automatically.</p>
        )}

        {quoteError && <div className="notice">{quoteError}</div>}
        {error && <div className="error" role="alert">{error}</div>}
        </>
        )}
      </div>

      {!picker && (
      <div className="footer">
        <button
          className="primary"
          onClick={openReview}
          disabled={busy || verifying || !quote || overBalance || wrongNetwork || quoting}
        >
          {/* Names the step that is actually outstanding, rather than always
              blaming a missing amount. */}
          {verifying
            ? 'Checking route…'
            : quoting
              ? 'Finding a route…'
              : quote
                ? 'Review bridge'
                : wrongNetwork
                  ? `Switch to ${chainName(fromChainId)}`
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
