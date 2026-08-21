import { useEffect, useState } from 'react';
import { formatEther, parseEther } from 'ethers';
import { call, shorten, trimAmount, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState, GasPresetGrid, Skeleton } from '../components/common.jsx';

/**
 * Staking and DeFi positions.
 *
 * Both answer "what do I hold that is not a plain token balance", so they share
 * a screen. Everything here is read directly from contracts — there is no
 * indexer — which is why positions have to be pointed at rather than discovered.
 */
export default function Earn({ state, go }) {
  const [tab, setTab] = useState('stake');

  return (
    <div className="screen">
      <BackBar title="Earn" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="tabs" role="tablist" aria-label="Earn sections">
          <button role="tab" aria-selected={tab === 'stake'} onClick={() => setTab('stake')}>
            Stake
          </button>
          <button role="tab" aria-selected={tab === 'positions'} onClick={() => setTab('positions')}>
            Positions
          </button>
        </div>

        {tab === 'stake' ? <Staking state={state} go={go} /> : <Positions state={state} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Staking({ state, go }) {
  const [data, setData] = useState(null);
  const [amount, setAmount] = useState('');
  const [venue, setVenue] = useState(null);
  const [quote, setQuote] = useState(null);
  const [gasInfo, setGasInfo] = useState(null);
  const [preset, setPreset] = useState('market');
  const [hash, setHash] = useState('');
  const [portfolio, setPortfolio] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => {
    setData(await call('STAKING_VENUES', { chainId: state.chainId }).catch(() => null));
    setPortfolio(await call('GET_PORTFOLIO').catch(() => null));
  };

  useEffect(() => {
    load();
    setQuote(null);
    setVenue(null);
    setHash('');
  }, [state.chainId, state.selected]);

  const review = (entry) =>
    run(async () => {
      const wei = parseEther(amount || '0');
      if (wei <= 0n) throw new Error('Enter an amount above zero.');
      const balance = BigInt(portfolio?.native?.raw ?? '0');
      if (wei > balance) throw new Error(`That is more than the ${state.network?.symbol} available.`);

      const q = await call('QUOTE_STAKE', { venueId: entry.id, amountWei: wei.toString() });
      setQuote(q);
      setVenue(entry);
      setGasInfo(
        await call('ESTIMATE_GAS', {
          request: { from: state.selected, to: q.target, value: `0x${wei.toString(16)}`, data: q.data },
        }).catch(() => null)
      );
    });

  const confirm = () =>
    run(async () => {
      const result = await call('STAKE', {
        venueId: venue.id,
        amountWei: quote.amountWei,
        fees: gasInfo?.options?.[preset],
        gas: gasInfo?.gasLimit,
      });
      setHash(result.hash);
      setQuote(null);
      setAmount('');
      await load();
    });

  if (!data) return <Skeleton height={120} radius={14} />;

  if (!data.supported) {
    return (
      <EmptyState
        icon="◈"
        title={`No staking on ${state.network?.name}`}
        body="ADRIX supports direct deposits into Lido and Rocket Pool on Ethereum. Switch networks to use them."
        action={
          <button className="ghost" onClick={() => go('networks')}>
            Switch network
          </button>
        }
      />
    );
  }

  if (quote) {
    return (
      <>
        <div className="card accent">
          <div className="eyebrow accent-text">Confirm stake</div>
          <div className="kv">
            <span className="kv-key">Depositing</span>
            <span className="kv-value mono">
              {trimAmount(formatEther(quote.amountWei), 6)} {state.network?.symbol}
            </span>
          </div>
          <div className="kv">
            <span className="kv-key">You receive</span>
            <span className="kv-value mono">
              ≈ {trimAmount(quote.receives, 6)} {quote.receivesSymbol}
            </span>
          </div>
          <div className="kv">
            <span className="kv-key">Venue</span>
            <span className="kv-value">{quote.venue.name}</span>
          </div>
        </div>

        {/* Rocket Pool returns fewer rETH than ETH deposited because rETH is
            worth more — a number that reads like a loss until it is explained. */}
        {quote.venue.kind === 'appreciating' && (
          <div className="notice">
            You receive less {quote.receivesSymbol} than {state.network?.symbol} deposited because each{' '}
            {quote.receivesSymbol} is already worth more than one {state.network?.symbol}. Its value rises over time
            while the amount stays fixed.
          </div>
        )}
        {quote.venue.kind === 'rebasing' && (
          <div className="notice">
            {quote.receivesSymbol} rebases: the balance itself grows each day rather than the price rising.
          </div>
        )}

        <div className="notice danger">
          <b>Staked funds are not immediately liquid.</b>
          <p className="small">{quote.withdrawal}</p>
        </div>

        {gasInfo && (
          <div className="stack-sm">
            <h3>Network fee</h3>
            <GasPresetGrid gasInfo={gasInfo} preset={preset} onSelect={setPreset} />
          </div>
        )}

        {error && <div className="error" role="alert">{error}</div>}
        <div className="row2">
          <button className="ghost" onClick={() => setQuote(null)} disabled={busy}>
            Back
          </button>
          <button className="primary" onClick={confirm} disabled={busy}>
            {busy ? 'Staking…' : `Stake with ${quote.venue.name}`}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {hash && (
        <div className="ok">
          Stake submitted.
          <div className="data-block">{hash}</div>
        </div>
      )}

      <div className="card">
        <div className="between">
          <span className="eyebrow">Amount to stake</span>
          {portfolio?.native && (
            <button
              className="link accent"
              onClick={() => setAmount(String(Math.max(0, Number(portfolio.native.balance) * 0.98)))}
            >
              max {trimAmount(portfolio.native.balance)}
            </button>
          )}
        </div>
        <div className="amount-input">
          <input
            className="mono"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^\d.]/g, ''));
              setError('');
            }}
            aria-label="Amount to stake"
          />
          <span className="amount-suffix">{state.network?.symbol}</span>
        </div>
        <p className="small faint">
          Deposited directly with the protocol, not bought on a market — so there is no slippage and no spread.
        </p>
        {error && <div className="error" role="alert">{error}</div>}
      </div>

      {data.venues.map((entry) => (
        <div className="card" key={entry.id}>
          <div className="between">
            <h2>{entry.name}</h2>
            {entry.staked && <span className="badge confirmed">staked</span>}
          </div>
          <p className="small">{entry.hint}</p>

          {entry.staked && (
            <div className="kv">
              <span className="kv-key">Your position</span>
              <span className="kv-value mono">
                {trimAmount(entry.balance, 6)} {entry.symbol}
                {entry.underlying && entry.kind === 'appreciating'
                  ? ` ≈ ${trimAmount(entry.underlying, 6)} ${state.network?.symbol}`
                  : ''}
              </span>
            </div>
          )}
          {entry.rate != null && entry.kind === 'appreciating' && (
            <div className="kv">
              <span className="kv-key">Rate</span>
              <span className="kv-value mono">
                1 {entry.symbol} = {trimAmount(entry.rate, 6)} {state.network?.symbol}
              </span>
            </div>
          )}
          {entry.error && <div className="notice">Could not read this venue: {entry.error}</div>}

          <button className="ghost" onClick={() => review(entry)} disabled={busy || !amount}>
            {busy ? 'Pricing…' : `Stake with ${entry.name}`}
          </button>
        </div>
      ))}

      <p className="small faint">
        ADRIX shows no APR figures. Yield rates come from off-chain sources it does not have, and a stale or invented
        number on a staking screen is worse than none.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
function Positions({ state }) {
  const [data, setData] = useState(null);
  const [address, setAddress] = useState('');
  const [probe, setProbe] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => setData(await call('LIST_POSITIONS', { chainId: state.chainId }).catch(() => null));

  useEffect(() => {
    load();
    setProbe(null);
  }, [state.chainId, state.selected]);

  const identify = () =>
    run(async () => {
      setProbe(null);
      const { address: resolved } = await call('RESOLVE_RECIPIENT', { input: address });
      setProbe(await call('IDENTIFY_POSITION', { address: resolved }));
    });

  const track = () =>
    run(async () => {
      await call('TRACK_POSITION', { address: probe.address, label: probe.name || probe.symbol });
      setProbe(null);
      setAddress('');
      await load();
    });

  return (
    <>
      {!data ? (
        <Skeleton height={100} radius={14} />
      ) : !data.positions.length ? (
        <EmptyState
          icon="▤"
          title="No positions on this network"
          body="Staking positions appear automatically. Vaults, lending, and LP positions have to be pointed at by contract address — ADRIX has no indexer to find them for you."
        />
      ) : (
        <div className="stack-sm">
          {data.positions.map((position) => (
            <div className="card" key={`${position.type}:${position.address}`}>
              <div className="between">
                <span className="eyebrow">{position.typeLabel}</span>
                {position.automatic ? (
                  <span className="badge">detected</span>
                ) : (
                  <button
                    className="link"
                    onClick={() =>
                      run(async () => {
                        await call('UNTRACK_POSITION', { address: position.address });
                        await load();
                      })
                    }
                  >
                    remove
                  </button>
                )}
              </div>

              {!position.ok ? (
                <div className="notice">
                  {shorten(position.address, 8, 6)} — could not be read: {position.error}
                </div>
              ) : (
                <>
                  <div className="balance">
                    {trimAmount(position.value, 6)}
                    <span>{position.valueSymbol}</span>
                  </div>
                  {position.type === 'erc4626' && (
                    <>
                      <div className="kv">
                        <span className="kv-key">Vault shares</span>
                        <span className="kv-value mono">
                          {trimAmount(position.shares, 6)} {position.symbol}
                        </span>
                      </div>
                      <span className="item-sub faint">
                        {/* The distinction the standard exists to express. */}
                        Shares stay fixed; what they redeem for is what grows.
                      </span>
                    </>
                  )}
                  {position.type === 'univ3' && (
                    <p className="small">
                      {position.positionCount} liquidity position{position.positionCount === 1 ? '' : 's'}. ADRIX reads
                      the count but does not yet decode each range's composition.
                    </p>
                  )}
                  {position.note && <p className="small faint">{position.note}</p>}
                  <span className="item-sub faint mono">{shorten(position.address, 10, 8)}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Track a position</h2>
        <p className="small">
          Any ERC-4626 vault works without ADRIX knowing the protocol — the standard exposes what your shares are worth.
          Other contracts are recognised where there is an adapter for them.
        </p>
        <label className="field">
          <span>Contract address</span>
          <input
            className="mono"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setProbe(null);
              setError('');
            }}
            placeholder="0x…"
            spellCheck="false"
          />
        </label>

        {probe && (
          <div className="card">
            <div className="kv">
              <span className="kv-key">Recognised as</span>
              <span className="kv-value">{probe.typeLabel}</span>
            </div>
            {probe.value != null && (
              <div className="kv">
                <span className="kv-key">Your position</span>
                <span className="kv-value mono">
                  {trimAmount(probe.value, 6)} {probe.valueSymbol}
                </span>
              </div>
            )}
            {probe.note && <div className="notice">{probe.note}</div>}
          </div>
        )}

        {error && <div className="error" role="alert">{error}</div>}
        {!probe ? (
          <button className="ghost" onClick={identify} disabled={busy || !address.trim()}>
            {busy ? 'Reading…' : 'Identify contract'}
          </button>
        ) : (
          <button className="primary" onClick={track} disabled={busy}>
            Track this position
          </button>
        )}
      </div>
    </>
  );
}
