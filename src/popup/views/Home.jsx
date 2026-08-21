import { useEffect, useRef, useState } from 'react';
import {
  call,
  shorten,
  trimAmount,
  timeAgo,
  formatFiat,
  formatEta,
  useAsyncAction,
  useAutoRefresh,
  usePullToRefresh,
} from '../../lib/ui.js';
import {
  TopBar,
  Avatar,
  Skeleton,
  SkeletonRows,
  EmptyState,
  GasPresetGrid,
  NonceGapWarning,
  UnderpricedWarning,
} from '../components/common.jsx';
import TransactionDetail from './TransactionDetail.jsx';
import NftDetail from './NftDetail.jsx';
import SendNft from './SendNft.jsx';

const TABS = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'nfts', label: 'NFTs' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'portfolio', label: 'Accounts' },
  { key: 'activity', label: 'Activity' },
];

export default function Home({ state, go, refresh, params }) {
  const [portfolio, setPortfolio] = useState(null);
  const [portfolios, setPortfolios] = useState(null);
  // A search result can land here pointing at a specific tab or transaction,
  // so the initial state comes from the route rather than always being 'tokens'.
  const [tab, setTab] = useState(params?.tab ?? 'tokens');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hideBalance, setHideBalance] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [detailHash, setDetailHash] = useState(params?.hash ?? null);
  const [detailNft, setDetailNft] = useState(null);
  const [sendingNft, setSendingNft] = useState(null);
  const [contacts, setContacts] = useState([]);

  const currency = portfolio?.currency ?? state.currency ?? 'usd';
  const pending = portfolio?.pending ?? 0;
  // A missing nonce freezes the whole queue, so it changes what the pending
  // banner means: not "waiting", but "waiting forever until this is fixed".
  const blockedByGap = (portfolio?.nonce?.gaps?.length ?? 0) > 0;

  const load = async () => {
    try {
      const nextPortfolio = await call('GET_PORTFOLIO');
      setPortfolio(nextPortfolio);
      setError('');
    } catch (err) {
      setError(err.message);
      // Rethrown so the poller can see the failure and back off; the message is
      // already on screen either way.
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const { refresh: refreshNow, refreshing, lastAt, failures } = useAutoRefresh(load, {
    interval: 15000,
    deps: [state.selected, state.chainId, state.currency],
  });

  const scrollRef = useRef(null);
  const { pull, armed } = usePullToRefresh(scrollRef, refreshNow);

  // The all-accounts view fans out across every account × every chain, so it is
  // only fetched when that tab is actually open.
  const loadPortfolios = async ({ force = false } = {}) => {
    try {
      setPortfolios(await call('GET_PORTFOLIOS', { force }));
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    setLoading(true);
    load().catch(() => {});
  }, [state.selected, state.chainId, state.currency]);

  useEffect(() => {
    if (tab === 'portfolio' && !portfolios) loadPortfolios();
  }, [tab]);

  useEffect(() => {
    call('LIST_CONTACTS')
      .then(setContacts)
      .catch(() => setContacts([]));
  }, [state.selected]);

  if (sendingNft) {
    return (
      <SendNft
        nft={sendingNft}
        state={state}
        contacts={contacts}
        onBack={() => setSendingNft(null)}
        onSent={load}
      />
    );
  }

  if (detailNft) {
    return (
      <NftDetail
        nft={detailNft}
        explorer={portfolio?.network?.explorer}
        currency={currency}
        onBack={() => setDetailNft(null)}
        onChanged={load}
        onSend={(nft) => {
          setDetailNft(null);
          setSendingNft(nft);
        }}
      />
    );
  }

  if (detailHash) {
    return (
      <TransactionDetail
        hash={detailHash}
        currency={currency}
        onBack={() => setDetailHash(null)}
        onChanged={load}
      />
    );
  }

  const showBackupBanner = state.backup?.needed && !bannerDismissed;

  return (
    <div className="screen">
      <TopBar
        state={state}
        pending={pending}
        onOpenAccounts={() => go('accounts')}
        onOpenNetworks={() => go('networks')}
        onOpenSearch={() => go('search')}
        onOpenSettings={() => go('settings')}
      />

      <div className="scroll" style={{ padding: 0 }} ref={scrollRef}>
        {/* The pull sheet only exists while a gesture is in progress, so it
            never occupies layout on a machine without a touchscreen. */}
        {pull > 0 && (
          <div className="pull-indicator" style={{ height: pull }} aria-hidden="true">
            <span className={armed ? 'armed' : ''}>{armed ? 'Release to refresh' : 'Pull to refresh'}</span>
          </div>
        )}

        <div className="hero">
          <div className="hero-amount">
            {loading && !portfolio ? (
              <Skeleton width={150} height={34} />
            ) : (
              <>
                {hideBalance ? '••••••' : trimAmount(portfolio?.native?.balance)}
                <span className="unit">{portfolio?.native?.symbol ?? ''}</span>
              </>
            )}
            <button
              className="icon-btn plain"
              style={{ width: 26, height: 26, fontSize: 13 }}
              onClick={() => setHideBalance(!hideBalance)}
              aria-pressed={hideBalance}
              aria-label={hideBalance ? 'Show balance' : 'Hide balance'}
            >
              {hideBalance ? '🙈' : '👁'}
            </button>
          </div>
          <div className="hero-fiat">
            {loading && !portfolio ? (
              <Skeleton width={90} height={13} />
            ) : (
              <span>
                {hideBalance
                  ? '••••'
                  : formatFiat(portfolio?.totalFiat, currency, { placeholder: 'No price data' })}
              </span>
            )}
            <button className="link accent" onClick={() => setTab('portfolio')}>
              All accounts ↗
            </button>
          </div>

          <div className="hero-refresh">
            <button
              className="icon-btn plain"
              style={{ width: 24, height: 24, fontSize: 13 }}
              onClick={refreshNow}
              disabled={refreshing}
              aria-label="Refresh balances"
              title="Refresh balances"
            >
              <span className={refreshing ? 'spin' : ''}>⟳</span>
            </button>
            <span className="small faint" aria-live="polite">
              {refreshing
                ? 'Refreshing…'
                : failures > 0
                  ? // Silently stale is the failure mode worth avoiding: the
                    // number on screen looks live and is not.
                    `Could not refresh — showing the last known values${lastAt ? ` from ${timeAgo(lastAt)}` : ''}`
                  : lastAt
                    ? `Updated ${timeAgo(lastAt)}`
                    : ''}
            </span>
          </div>
        </div>

        {error && (
          <div className="pad-x" style={{ paddingBottom: 12 }}>
            <div className="error" role="alert">
              {error}
            </div>
          </div>
        )}

        {/* A rate-limited price cache keeps serving old numbers that look
            current. Fiat values are the one place that silence is misleading. */}
        {(portfolio?.priceState?.rateLimited || portfolio?.priceState?.stale) && (
          <div className="pad-x" style={{ paddingBottom: 12 }}>
            <div className="notice">
              {portfolio.priceState.rateLimited
                ? `${portfolio.priceState.source} is rate limiting ADRIX, so fiat values are from ${portfolio.priceState.cachedAt ? timeAgo(portfolio.priceState.cachedAt) : 'earlier'} and are not updating.`
                : `Fiat values are from ${timeAgo(portfolio.priceState.cachedAt)}. Token balances are read live from the chain and are current.`}
            </div>
          </div>
        )}

        <div className="action-row">
          {[
            ['send', '↗', 'Send'],
            ['receive', '↙', 'Receive'],
            ['swap', '⇌', 'Swap'],
            ['bridge', '⇄', 'Bridge'],
            ['buy', '＋', 'Buy'],
          ].map(([view, icon, label]) => (
            <button className="action" key={view} onClick={() => go(view)}>
              <span className="action-icon" aria-hidden="true">
                {icon}
              </span>
              {label}
            </button>
          ))}
        </div>

        {showBackupBanner && (
          <div className="banner danger">
            <div className="banner-main">
              <div className="banner-title">Back up your recovery phrase</div>
              <div className="banner-sub">Without it, losing this browser loses the wallet.</div>
            </div>
            <button className="link accent" onClick={() => go('settings')}>
              back up
            </button>
            <button
              className="icon-btn plain"
              style={{ width: 24, height: 24, fontSize: 12 }}
              onClick={() => setBannerDismissed(true)}
              aria-label="Dismiss for now"
            >
              ✕
            </button>
          </div>
        )}

        {pending > 0 && (
          <button
            className={`banner ${blockedByGap ? 'danger' : 'pending-banner'}`}
            onClick={() => setTab('activity')}
          >
            {blockedByGap ? (
              <span className="banner-icon" aria-hidden="true">
                ⚠
              </span>
            ) : (
              <span className="spinner" aria-hidden="true" />
            )}
            <div className="banner-main">
              <div className="banner-title">
                {pending} transaction{pending === 1 ? '' : 's'} pending
              </div>
              <div className="banner-sub">
                {blockedByGap
                  ? `Blocked — nonce ${portfolio.nonce.firstGap} is missing and nothing behind it can confirm`
                  : 'Waiting for a block — tap to open the queue'}
              </div>
            </div>
            <span className="caret" aria-hidden="true">
              ›
            </span>
          </button>
        )}

        <div className="tabbar" role="tablist" aria-label="Wallet sections">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
            >
              {label}
              {key === 'activity' && pending > 0 && <span className="tab-count">{pending}</span>}
            </button>
          ))}
        </div>

        <div className="pad">
          {tab === 'tokens' ? (
            <Tokens portfolio={portfolio} loading={loading} currency={currency} go={go} onChange={load} />
          ) : tab === 'nfts' ? (
            <Nfts portfolio={portfolio} loading={loading} go={go} onChange={load} onOpen={setDetailNft} />
          ) : tab === 'approvals' ? (
            <ApprovalsTab portfolio={portfolio} loading={loading} onChange={load} />
          ) : tab === 'portfolio' ? (
            <AccountPortfolio
              portfolios={portfolios}
              currency={currency}
              selected={state.selected}
              go={go}
              onRetry={() => loadPortfolios({ force: true })}
            />
          ) : (
            <Activity
              portfolio={portfolio}
              loading={loading}
              onChange={load}
              onOpen={setDetailHash}
              nonceInfo={portfolio?.nonce}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Tokens({ portfolio, loading, currency, go, onChange }) {
  const [query, setQuery] = useState('');
  const [showSpam, setShowSpam] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [managing, setManaging] = useState(null);
  const needle = query.trim().toLowerCase();
  const tokens = (portfolio?.tokens ?? []).filter(
    (token) =>
      !needle ||
      token.symbol?.toLowerCase().includes(needle) ||
      token.name?.toLowerCase().includes(needle) ||
      token.address.toLowerCase().includes(needle)
  );

  if (loading && !portfolio) {
    return (
      <div className="card flush">
        <div style={{ padding: '2px 12px' }}>
          <SkeletonRows count={3} />
        </div>
      </div>
    );
  }

  const nativeSymbol = portfolio?.native?.symbol ?? 'ETH';
  const flagged = (portfolio?.tokens ?? []).filter((token) => token.spam?.likelySpam);
  const shown = showSpam ? tokens : tokens.filter((token) => !token.spam?.likelySpam);

  const hideAllSpam = async () => {
    setHiding(true);
    try {
      await call('HIDE_TOKENS', { addresses: flagged.map((token) => token.address) });
      await onChange();
    } finally {
      setHiding(false);
    }
  };

  return (
    <div className="stack">
      <label className="field">
        <span>Search tokens</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Symbol, name, or contract"
          type="search"
        />
      </label>

      {flagged.length > 0 && (
        <div className="card">
          <div className="between">
            <span className="eyebrow">
              {flagged.length} token{flagged.length === 1 ? '' : 's'} look like spam
            </span>
            <button className="link" onClick={() => setShowSpam(!showSpam)} aria-pressed={showSpam}>
              {showSpam ? 'collapse' : 'review'}
            </button>
          </div>
          <p className="small">
            Airdropped tokens whose name carries a URL or a claim prompt exist to lure you to a drainer site. These
            are flagged, not hidden — check before acting.
          </p>
          <button className="ghost" onClick={hideAllSpam} disabled={hiding}>
            {hiding ? 'Hiding…' : `Hide all ${flagged.length}`}
          </button>
        </div>
      )}

      <div className="card flush">
        <div style={{ padding: '2px 12px' }}>
          <div className="asset-row">
            <span className="token-icon">{nativeSymbol.charAt(0)}</span>
            <div className="asset-main">
              <div className="asset-name">{nativeSymbol}</div>
              <div className="asset-sub">{portfolio?.network?.name ?? 'Network'}</div>
            </div>
            <div className="asset-values">
              <div className="asset-amount">{trimAmount(portfolio?.native?.balance)}</div>
              <div className="asset-fiat">
                {formatFiat(portfolio?.native?.fiat, currency, { placeholder: 'No rate' })}
                <PriceChange value={portfolio?.native?.change24h} />
              </div>
            </div>
          </div>

          {shown.map((token) => (
            <div key={token.address}>
              <div className={`asset-row ${token.spam?.likelySpam ? 'flagged' : ''}`}>
                <span className="token-icon">{token.symbol?.charAt(0) ?? '?'}</span>
                <div className="asset-main">
                  <div className="asset-name">
                    {token.symbol}
                    {token.spam?.likelySpam && <span className="badge failed" style={{ marginLeft: 6 }}>spam?</span>}
                    {token.edited && <span className="badge" style={{ marginLeft: 6 }}>edited</span>}
                  </div>
                  <div className="asset-sub">{token.name || shorten(token.address)}</div>
                  {token.spam?.likelySpam && (
                    <div className="small" style={{ color: 'var(--danger)' }}>
                      {token.spam.reasons[0]}
                    </div>
                  )}
                  <button
                    className="link"
                    onClick={() => setManaging(managing === token.address ? null : token.address)}
                    aria-expanded={managing === token.address}
                  >
                    {managing === token.address ? 'close' : 'manage'}
                  </button>
                </div>
                <div className="asset-values">
                  <div className="asset-amount">{token.error ? '--' : trimAmount(token.balance)}</div>
                  <div className="asset-fiat">
                    {formatFiat(token.fiat, currency, { placeholder: 'No rate' })}
                    <PriceChange value={token.change24h} />
                  </div>
                </div>
              </div>
              {managing === token.address && (
                <ManageToken token={token} onDone={onChange} onClose={() => setManaging(null)} />
              )}
            </div>
          ))}
        </div>
      </div>

      {needle && !tokens.length && (
        <EmptyState icon="⌕" title="No match" body="No tracked token matches that search." />
      )}
      {!needle && !portfolio?.tokens?.length && (
        <EmptyState
          icon="◇"
          title="No tokens tracked yet"
          body="Auto-detect finds common tokens you hold, or add one by contract address."
          action={
            <button className="ghost" onClick={() => go('addToken')}>
              Add token
            </button>
          }
        />
      )}

      {(portfolio?.hiddenTokens ?? []).length > 0 && (
        <div className="card">
          <h2>Hidden tokens</h2>
          <div className="list">
            {portfolio.hiddenTokens.map((token) => (
              <div className="item static compact" key={token.address}>
                <div className="item-main">
                  <span className="item-title">{token.symbol}</span>
                  <span className="item-sub">{shorten(token.address)}</span>
                </div>
                <button
                  className="link accent"
                  onClick={async () => {
                    await call('UNHIDE_TOKEN', { address: token.address });
                    onChange();
                  }}
                >
                  unhide
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {portfolio?.tokens?.length > 0 && (
        <button className="ghost" onClick={() => go('addToken')}>
          Add token
        </button>
      )}
    </div>
  );
}

/**
 * Correcting a tracked token.
 *
 * Decimals are the field that matters. Every amount the user types is scaled by
 * them before it is sent, so a wrong value does not just display a wrong
 * balance — it moves the wrong quantity. Reading the contract again is offered
 * first, and a manual override has to be confirmed against what the chain says.
 */
function ManageToken({ token, onDone, onClose }) {
  const [symbol, setSymbol] = useState(token.symbol ?? '');
  const [name, setName] = useState(token.name ?? '');
  const [decimals, setDecimals] = useState(String(token.decimals ?? 18));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [note, setNote] = useState('');
  const { busy, error, run } = useAsyncAction();

  const decimalsChanged = Number(decimals) !== Number(token.decimals);
  const dirty = decimalsChanged || symbol !== token.symbol || name !== (token.name ?? '');

  const save = () =>
    run(async () => {
      await call('EDIT_TOKEN', { address: token.address, patch: { symbol, name, decimals: Number(decimals) } });
      setNote('Saved.');
      await onDone();
    });

  const refresh = () =>
    run(async () => {
      const result = await call('REFRESH_TOKEN_METADATA', { address: token.address });
      setSymbol(result.symbol);
      setName(result.name ?? '');
      setDecimals(String(result.decimals));
      setNote(
        result.changed
          ? `Re-read from the contract: ${result.previous.symbol} / ${result.previous.decimals} decimals → ${result.symbol} / ${result.decimals}.`
          : 'The contract reports the same values already stored.'
      );
      await onDone();
    });

  return (
    <div className="site-panel stack-sm">
      <div className="between">
        <span className="eyebrow">Edit {token.symbol}</span>
        <button className="link" onClick={onClose}>
          close
        </button>
      </div>

      <div className="data-block">{token.address}</div>

      <div className="row2">
        <label className="field">
          <span>Symbol</span>
          <input className="mono" value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={24} />
        </label>
        <label className="field">
          <span>Decimals</span>
          <input
            className="mono"
            inputMode="numeric"
            value={decimals}
            onChange={(e) => setDecimals(e.target.value.replace(/[^\d]/g, ''))}
            aria-invalid={decimalsChanged}
          />
        </label>
      </div>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </label>

      {decimalsChanged && (
        <div className="notice danger">
          Changing decimals from {token.decimals} to {decimals || '?'} rescales every amount for this token by a factor
          of 10<sup>{Math.abs(Number(decimals || 0) - Number(token.decimals))}</sup>. Only do this if the contract
          genuinely misreports its decimals — otherwise your next send will move the wrong quantity.
        </div>
      )}

      {note && <div className="ok">{note}</div>}
      {error && <div className="error" role="alert">{error}</div>}

      <div className="row2">
        <button className="ghost" onClick={refresh} disabled={busy}>
          {busy ? 'Reading…' : 'Re-read from chain'}
        </button>
        <button className="primary" onClick={save} disabled={busy || !dirty || !symbol.trim()}>
          Save
        </button>
      </div>

      {confirmRemove ? (
        <div className="stack-sm">
          <div className="notice">
            Removing only stops ADRIX tracking this token. Your balance is on chain and is unaffected — re-add the
            contract any time.
          </div>
          <div className="row2">
            <button className="ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await call('REMOVE_TOKEN', { address: token.address });
                  await onDone();
                  onClose();
                })
              }
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="row2">
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await call('HIDE_TOKEN', { address: token.address });
                await onDone();
                onClose();
              })
            }
          >
            Hide
          </button>
          <button className="danger" onClick={() => setConfirmRemove(true)}>
            Stop tracking
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ApprovalsTab({ portfolio, loading, onChange }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [quote, setQuote] = useState(null);
  const [selected, setSelected] = useState([]);
  const [batchResult, setBatchResult] = useState(null);

  const approvals = portfolio?.approvals ?? [];

  if (loading && !portfolio) {
    return (
      <div className="stack">
        <Skeleton height={70} radius={14} />
        <Skeleton height={40} radius={10} />
        <Skeleton height={120} radius={14} />
      </div>
    );
  }

  // Revoking costs gas, so the user sees the price and the exact effect before
  // anything is broadcast. A single click must never spend money.
  const openQuote = async (approval) => {
    setBusy(approval.id);
    setError('');
    try {
      setQuote(await call('QUOTE_REVOKE', { id: approval.id }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const confirmRevoke = async (preset) => {
    setBusy(quote.id);
    setError('');
    try {
      await call('REVOKE_APPROVAL', {
        id: quote.id,
        fees: quote.gasInfo.options[preset],
        gas: quote.gasInfo.gasLimit,
      });
      setQuote(null);
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const revokeSelected = async () => {
    setBusy('batch');
    setError('');
    try {
      const result = await call('REVOKE_APPROVALS', { ids: selected });
      setBatchResult(result);
      setSelected([]);
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  if (quote) {
    return <RevokeReview quote={quote} busy={Boolean(busy)} error={error} onCancel={() => setQuote(null)} onConfirm={confirmRevoke} />;
  }

  const needle = query.trim().toLowerCase();
  const filtered = approvals.filter(
    (app) =>
      !needle ||
      app.symbol?.toLowerCase().includes(needle) ||
      app.spender?.toLowerCase().includes(needle) ||
      app.name?.toLowerCase().includes(needle)
  );
  const unlimitedCount = approvals.filter((app) => app.unlimited).length;
  const toggle = (id) =>
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  return (
    <div className="stack">
      <div className="stat-grid">
        <div className="stat">
          <span className="stat-value">{approvals.length}</span>
          <span className="stat-label">Active approvals</span>
        </div>
        <div className="stat">
          <span className={`stat-value ${unlimitedCount > 0 ? 'danger' : ''}`}>{unlimitedCount}</span>
          <span className="stat-label">Unlimited allowance</span>
        </div>
      </div>

      {unlimitedCount > 0 && (
        <div className="notice">
          {unlimitedCount} approval{unlimitedCount === 1 ? '' : 's'} let a contract spend an unlimited amount of a
          token, indefinitely. Revoke any you no longer use.
        </div>
      )}

      {approvals.length > 0 && (
        <label className="field">
          <span>Search approvals</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Token symbol, name, or spender"
            type="search"
          />
        </label>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      {batchResult && (
        <div className={batchResult.failed.length ? 'notice' : 'ok'}>
          Sent {batchResult.sent.length} of {batchResult.total} revocations.
          {batchResult.failed.length > 0 && ` ${batchResult.failed.length} failed: ${batchResult.failed[0].error}`}
        </div>
      )}

      {selected.length > 0 && (
        <div className="card accent">
          <div className="between">
            <span className="small">
              {selected.length} selected — each revoke is its own transaction and its own gas.
            </span>
            <button className="link" onClick={() => setSelected([])}>
              clear
            </button>
          </div>
          <button className="primary" disabled={busy === 'batch'} onClick={revokeSelected}>
            {busy === 'batch' ? 'Revoking…' : `Revoke ${selected.length}`}
          </button>
        </div>
      )}

      <div className="list">
        {!approvals.length ? (
          <EmptyState
            icon="✓"
            title="No active approvals"
            body="Approvals you grant to contracts appear here so you can revoke them."
          />
        ) : !filtered.length ? (
          <EmptyState icon="⌕" title="No match" body="No approval matches that search." />
        ) : (
          filtered.map((approval) => (
            <div className={`item static ${selected.includes(approval.id) ? 'selected' : ''}`} key={approval.id}>
              <input
                type="checkbox"
                checked={selected.includes(approval.id)}
                onChange={() => toggle(approval.id)}
                aria-label={`Select ${approvalTitle(approval)} for bulk revoke`}
              />
              <div className="item-main">
                <span className="item-title">{approvalTitle(approval)}</span>
                <span className="item-sub">
                  {approval.standard} · spender {shorten(approval.spender, 6, 4)}
                </span>
                {approval.origin && <span className="item-sub">granted to {approval.origin.replace(/^https?:\/\//, '')}</span>}
              </div>
              <div className="item-right">
                {approval.unlimited && <span className="badge failed">unlimited</span>}
                <button className="link accent" disabled={busy === approval.id} onClick={() => openQuote(approval)}>
                  {busy === approval.id ? 'pricing…' : 'revoke'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Priced confirmation for filling a nonce gap.
 *
 * Spelled out rather than labelled "fix": the user is about to pay gas to send
 * an empty transaction to themselves, which is a strange enough thing to do
 * that it needs explaining before, not after.
 */
function NonceFillReview({ quote, busy, error, onCancel, onConfirm }) {
  const [preset, setPreset] = useState('market');
  const option = quote.gasInfo.options[preset];

  return (
    <div className="stack">
      <div className="card accent">
        <div className="eyebrow accent-text">Unblock the queue</div>
        <p className="small">{quote.effect}</p>
        <div className="kv">
          <span className="kv-key">Missing nonce</span>
          <span className="kv-value mono">{quote.nonce}</span>
        </div>
        <div className="kv">
          <span className="kv-key">Sends</span>
          <span className="kv-value">0 to your own address</span>
        </div>
        <div className="kv">
          <span className="kv-key">Unblocks</span>
          <span className="kv-value">
            {quote.blocked.length} transaction{quote.blocked.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {quote.blocked.length > 0 && (
        <div className="card">
          <span className="eyebrow">Waiting on this</span>
          {quote.blocked.map((tx) => (
            <div className="kv" key={tx.hash}>
              <span className="kv-key">nonce {tx.nonce}</span>
              <span className="kv-value">{tx.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="stack-sm">
        <h3>Network fee</h3>
        <GasPresetGrid gasInfo={quote.gasInfo} preset={preset} onSelect={setPreset} />
        <div className="between small faint">
          <span>Costs about</span>
          <span className="mono">
            {trimAmount(option.likelyFee ?? option.estimatedFee, 6)} {quote.gasInfo.symbol}
            {option.etaSeconds != null ? ` · ~${formatEta(option.etaSeconds)}` : ''}
          </span>
        </div>
      </div>

      <div className="notice">
        Pick a fee at least as high as the transactions behind it, or this one queues up behind the same congestion
        that stalled them.
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      <div className="row2">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={() => onConfirm(preset)} disabled={busy}>
          {busy ? 'Sending…' : `Fill nonce ${quote.nonce}`}
        </button>
      </div>
    </div>
  );
}

/** Priced confirmation for a revoke, shown before anything is broadcast. */
function RevokeReview({ quote, busy, error, onCancel, onConfirm }) {
  const [preset, setPreset] = useState('market');
  const { approval, gasInfo } = quote;
  const option = gasInfo.options[preset];

  return (
    <div className="stack">
      <div className="card accent">
        <div className="eyebrow accent-text">Confirm revoke</div>
        <p className="small">{quote.effect}</p>
        <div className="kv">
          <span className="kv-key">Token</span>
          <span className="kv-value">{approval.symbol || approval.name || shorten(approval.contract, 8, 6)}</span>
        </div>
        <div className="kv">
          <span className="kv-key">Spender</span>
          <span className="kv-value">{shorten(approval.spender, 10, 8)}</span>
        </div>
        <div className="kv">
          <span className="kv-key">Standard</span>
          <span className="kv-value">{approval.standard}</span>
        </div>
      </div>

      <div className="stack-sm">
        <h3>Network fee</h3>
        <GasPresetGrid gasInfo={gasInfo} preset={preset} onSelect={setPreset} />
        <div className="between small faint">
          <span>Costs about</span>
          <span className="mono">
            {trimAmount(option.likelyFee ?? option.estimatedFee, 6)} {gasInfo.symbol}
            {option.etaSeconds != null ? ` · ~${formatEta(option.etaSeconds)}` : ''}
          </span>
        </div>
      </div>

      {gasInfo.estimateError && (
        <div className="notice danger">
          This revoke could not be simulated: {gasInfo.estimateError}. It may fail and still cost the fee.
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}

      <div className="row2">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={() => onConfirm(preset)} disabled={busy}>
          {busy ? 'Revoking…' : 'Revoke'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Nfts({ portfolio, loading, go, onChange, onOpen }) {
  const [query, setQuery] = useState('');

  if (loading && !portfolio) {
    return (
      <div className="nft-grid">
        <Skeleton height={170} radius={14} />
        <Skeleton height={170} radius={14} />
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const nfts = (portfolio?.nfts ?? []).filter((nft) => {
    if (!needle) return true;
    return [nft.title, nft.name, nft.symbol, nft.address, nft.tokenId, nft.standard]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  return (
    <div className="stack">
      {(portfolio?.nfts ?? []).length > 0 && (
        <label className="field">
          <span>Search NFTs</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, contract, token ID"
            type="search"
          />
        </label>
      )}

      {!portfolio?.nfts?.length ? (
        <EmptyState
          icon="▣"
          title="No NFTs tracked"
          body="ADRIX has no NFT indexer, so add a collection by contract address and token ID."
          action={
            <button className="ghost" onClick={() => go('addToken')}>
              Add NFT
            </button>
          }
        />
      ) : !nfts.length ? (
        <EmptyState icon="⌕" title="No match" body="No tracked NFT matches that search." />
      ) : (
        <div className="nft-grid">
          {nfts.map((nft) => (
            <button
              className={`nft-card ${nft.spam?.likelySpam ? 'flagged' : ''}`}
              key={`${nft.address}:${nft.tokenId}`}
              onClick={() => onOpen(nft)}
            >
              {nft.image ? (
                <img src={nft.image} alt={nft.title || `Token ${nft.tokenId}`} loading="lazy" />
              ) : (
                <div className="nft-placeholder">{nft.standard}</div>
              )}
              <div className="stack-sm">
                <div className="item-title">{nft.title || nft.name || `${nft.standard} #${nft.tokenId}`}</div>
                <div className="item-sub">
                  #{nft.tokenId} · {nft.balance == null ? '--' : `${nft.balance} owned`}
                </div>
                {/* Cache-only: appears once the detail screen has looked this
                    collection up, rather than firing a lookup per tile. */}
                {nft.collection?.floorNative != null && (
                  <div className="item-sub">
                    floor {trimAmount(nft.collection.floorNative, 4)} {nft.collection.nativeSymbol ?? ''}
                  </div>
                )}
                <div className="between">
                  <span className={`badge ${nft.spam?.likelySpam ? 'failed' : ''}`}>
                    {nft.spam?.likelySpam ? 'spam?' : nft.standard}
                  </span>
                  <span className="link">details ›</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {(portfolio?.hiddenNfts ?? []).length > 0 && (
        <div className="card">
          <h2>Hidden NFTs</h2>
          <div className="list">
            {portfolio.hiddenNfts.map((nft) => (
              <div className="item static compact" key={`${nft.address}:${nft.tokenId}`}>
                <div className="item-main">
                  <span className="item-title">{nft.title || nft.name || `${nft.standard} #${nft.tokenId}`}</span>
                  <span className="item-sub">
                    {shorten(nft.address)} · #{nft.tokenId}
                  </span>
                </div>
                <button
                  className="link accent"
                  onClick={async () => {
                    await call('UNHIDE_NFT', { nft });
                    onChange();
                  }}
                >
                  unhide
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(portfolio?.nfts ?? []).length > 0 && (
        <button className="ghost" onClick={() => go('addToken')}>
          Add NFT
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function AccountPortfolio({ portfolios, currency, selected, go, onRetry }) {
  if (!portfolios) {
    return (
      <div className="stack">
        <Skeleton height={80} radius={14} />
        <SkeletonRows count={3} />
        <p className="small faint center">Reading every account across every network…</p>
      </div>
    );
  }

  const accounts = portfolios.accounts ?? [];
  if (!accounts.length) {
    return <EmptyState icon="◇" title="No visible accounts" body="Unhide an account to see it here." />;
  }

  const allocation = portfolios.allocation;

  return (
    <div className="stack">
      <div className="card accent center">
        <div className="eyebrow">Total across all accounts and chains</div>
        <div className="balance">{formatFiat(portfolios.totalFiat, currency, { placeholder: 'No price data' })}</div>
        <span className="small faint">
          {accounts.length} account{accounts.length === 1 ? '' : 's'} · {portfolios.chainsQueried} networks
          {portfolios.cached ? ' · cached' : ''}
          {portfolios.fetchedAt ? ` · ${timeAgo(portfolios.fetchedAt)}` : ''}
        </span>
      </div>

      {/* An unreachable chain leaves a hole in the total. Reporting it is the
          difference between an incomplete number and a wrong one. */}
      {portfolios.failures?.length > 0 && (
        <div className="notice">
          <b>{portfolios.failures.length} chain reads failed.</b>
          <p className="small">
            The total below is missing whatever is held on{' '}
            {[...new Set(portfolios.failures.map((f) => f.network))].join(', ')}. This is usually a rate-limited public
            endpoint — add a fallback in Networks.
          </p>
        </div>
      )}

      {allocation?.chains?.length > 0 && (
        <div className="card">
          <span className="eyebrow">Where it is</span>
          {allocation.chains
            .filter((chain) => chain.fiat > 0 || chain.tokenCount > 0)
            .map((chain) => (
              <div className="alloc-row" key={chain.chainId}>
                <div className="alloc-head">
                  <span className="alloc-name">{chain.name}</span>
                  <span className="mono small">
                    {formatFiat(chain.fiat, currency, { placeholder: '--' })}
                    {chain.share != null ? ` · ${chain.share}%` : ''}
                  </span>
                </div>
                <span className="alloc-bar" aria-hidden="true">
                  <span style={{ width: `${chain.share ?? 0}%` }} />
                </span>
                <span className="item-sub">
                  {trimAmount(chain.nativeBalance)} {chain.symbol}
                  {chain.tokenCount > 0 && ` · ${chain.tokenCount} token position${chain.tokenCount === 1 ? '' : 's'}`}
                  {chain.nftCount > 0 && ` · ${chain.nftCount} NFT${chain.nftCount === 1 ? '' : 's'}`}
                </span>
              </div>
            ))}
        </div>
      )}

      {allocation?.assets?.length > 0 && (
        <div className="card">
          <span className="eyebrow">By asset</span>
          <p className="small faint">
            The same symbol on several chains is one position here — that is how a holding is actually held.
          </p>
          {allocation.assets.map((asset) => (
            <div className="kv" key={asset.key}>
              <span className="kv-key">
                {asset.symbol}
                {asset.chainCount > 1 && <span className="badge" style={{ marginLeft: 6 }}>{asset.chainCount} chains</span>}
              </span>
              <span className="kv-value mono">
                {formatFiat(asset.fiat, currency, { placeholder: '--' })}
                {asset.share != null ? ` · ${asset.share}%` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="list">
        {accounts.map((account) => (
          <PortfolioRow key={account.address} account={account} currency={currency} selected={selected} />
        ))}
      </div>

      <p className="small faint">
        NFT counts here come from what ADRIX has stored rather than a fresh read — checking ownership across every
        account and chain would mean hundreds of requests. Open a single network's NFT tab for live data.
      </p>

      <div className="row2">
        <button className="ghost" onClick={onRetry}>
          Refresh
        </button>
        <button className="ghost" onClick={() => go('accounts')}>
          Manage accounts
        </button>
      </div>
    </div>
  );
}

/**
 * One account in the all-accounts view, expandable into its per-chain split.
 * The aggregate total answers "how much do I have"; the breakdown answers
 * "where is it", which is the question that actually drives a network switch.
 */
function PortfolioRow({ account, currency, selected }) {
  const [open, setOpen] = useState(false);
  const funded = (account.chainBalances ?? []).filter(
    (chain) => chain.fiat > 0 || Number(chain.native.balance) > 0 || chain.tokens.length > 0
  );

  return (
    <div className="site-row">
      <button className="item" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Avatar address={account.address} size="lg" src={account.ens?.avatar} />
        <div className="item-main">
          <span className="item-title">{account.name}</span>
          <span className="item-sub">
            {account.ens?.name ? `${account.ens.name} · ` : ''}
            {shorten(account.address, 8, 6)}
          </span>
          <span className="item-sub">
            {funded.length} chain{funded.length === 1 ? '' : 's'} · {account.tokens.length} token
            {account.tokens.length === 1 ? '' : 's'} · {account.nfts.length} NFT
            {account.nfts.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
          <span className="mono small">{formatFiat(account.totalFiat, currency, { placeholder: '--' })}</span>
          <span className="inline">
            {account.address === selected && <span className="badge confirmed">active</span>}
            {account.type !== 'hd' && <span className="badge">{account.type}</span>}
          </span>
        </div>
      </button>

      {open && (
        <div className="site-panel stack-sm">
          {!funded.length ? (
            <p className="small faint">No balance found on any visible network.</p>
          ) : (
            funded
              .slice()
              .sort((a, b) => b.fiat - a.fiat)
              .map((chain) => (
                <div className="kv" key={chain.chainId}>
                  <span className="kv-key">{chain.network.name}</span>
                  <span className="kv-value">
                    {trimAmount(chain.native.balance)} {chain.native.symbol}
                    {chain.tokens.length > 0 && ` + ${chain.tokens.length} token${chain.tokens.length === 1 ? '' : 's'}`}
                    {chain.fiat > 0 && ` · ${formatFiat(chain.fiat, currency)}`}
                  </span>
                </div>
              ))
          )}
          {account.type === 'watch' && (
            <p className="small faint">Watch-only — balances are read from the chain, nothing can be sent.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Activity({ portfolio, loading, onChange, onOpen, nonceInfo }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const [range, setRange] = useState('all');
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [gapQuote, setGapQuote] = useState(null);
  // Activity is scoped to one chain by design — the same symbol, nonce, and
  // even the same contract address mean different things on different networks.
  // This makes that scope visible and steppable rather than merely true.
  const [scope, setScope] = useState('current');
  const [allActivity, setAllActivity] = useState(null);
  const [chainSummary, setChainSummary] = useState([]);
  const [showNoise, setShowNoise] = useState(false);

  useEffect(() => {
    call('ACTIVITY_BY_CHAIN', {})
      .then((result) => setChainSummary(result.chains ?? []))
      .catch(() => setChainSummary([]));
  }, [portfolio?.address, portfolio?.activity?.length]);

  useEffect(() => {
    if (scope !== 'all') return;
    call('LIST_ALL_ACTIVITY', {})
      .then(setAllActivity)
      .catch(() => setAllActivity(null));
  }, [scope, portfolio?.activity?.length]);

  if (loading && !portfolio) return <SkeletonRows count={4} />;

  const activity = (scope === 'all' ? allActivity : portfolio?.activity) ?? [];
  const currentChainId = portfolio?.chainId;
  const elsewhere = chainSummary
    .filter((chain) => chain.chainId !== currentChainId)
    .reduce((sum, chain) => sum + chain.total, 0);
  const pending = activity.filter((tx) => tx.status === 'pending').sort((a, b) => a.nonce - b.nonce);

  const cutoff =
    range === '24h' ? Date.now() - 864e5 : range === '7d' ? Date.now() - 6048e5 : range === '30d' ? Date.now() - 2592e6 : 0;

  // Tags come from the rows on screen, so the chips always match what can
  // actually be filtered to.
  const tagCounts = new Map();
  for (const tx of activity) {
    for (const tag of tx.tags ?? []) {
      const key = tag.toLowerCase();
      const current = tagCounts.get(key) ?? { tag, count: 0 };
      current.count += 1;
      tagCounts.set(key, current);
    }
  }
  const tags = [...tagCounts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const noiseCount = activity.filter((tx) => tx.noise?.noise).length;

  const filtered = activity.filter((tx) => {
    // Zero-value self-sends the wallet generated itself — cancels and nonce
    // fills — are real transactions that cost a fee, so they are folded away
    // rather than dropped.
    if (!showNoise && tx.noise?.noise) return false;
    if (status !== 'all' && tx.status !== status) return false;
    if (kind !== 'all' && txKind(tx) !== kind) return false;
    if (tagFilter && !(tx.tags ?? []).some((tag) => tag.toLowerCase() === tagFilter.toLowerCase())) return false;
    if (cutoff && (tx.submittedAt ?? 0) < cutoff) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [tx.hash, tx.to, tx.from, tx.status, tx.networkName, label(tx), tx.decoded?.name, tx.note, ...(tx.tags ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  if (!activity.length) {
    return (
      <div className="stack">
        <EmptyState
          icon="↗"
          title={elsewhere > 0 ? `Nothing on ${portfolio?.network?.name ?? 'this network'}` : 'No activity yet'}
          body={
            elsewhere > 0
              ? // The most confusing thing a per-chain history can do is look
                // empty while the transaction the user remembers sits on
                // another network. Say where it is.
                `You have ${elsewhere} transaction${elsewhere === 1 ? '' : 's'} on other networks. Activity is kept per network because a nonce, a symbol, and even a contract address mean different things on each.`
              : 'Transactions you send from ADRIX show up here. Incoming transfers need an indexer, which this wallet does not have.'
          }
          action={
            elsewhere > 0 ? (
              <button className="ghost" onClick={() => setScope('all')}>
                Show every network
              </button>
            ) : null
          }
        />
        {elsewhere > 0 && <ChainBreakdown chains={chainSummary} currentChainId={currentChainId} />}
      </div>
    );
  }

  const act = async (type, hash) => {
    setBusy(hash);
    setError('');
    try {
      await call(type, { hash });
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  // Filling a gap costs real gas, so it is priced and confirmed like any other
  // send rather than fired off by one click on a warning banner.
  const openGapQuote = async (nonce) => {
    setBusy('gap');
    setError('');
    try {
      setGapQuote(await call('QUOTE_NONCE_FILL', { nonce }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const confirmGapFill = async (presetKey) => {
    setBusy('gap');
    setError('');
    try {
      await call('FILL_NONCE_GAP', {
        nonce: gapQuote.nonce,
        fees: gapQuote.gasInfo.options[presetKey],
        gas: gapQuote.gasInfo.gasLimit,
      });
      setGapQuote(null);
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  if (gapQuote) {
    return (
      <NonceFillReview
        quote={gapQuote}
        busy={busy === 'gap'}
        error={error}
        onCancel={() => setGapQuote(null)}
        onConfirm={confirmGapFill}
      />
    );
  }

  return (
    <div className="stack">
      <NonceGapWarning info={nonceInfo} onFill={openGapQuote} busy={busy === 'gap'} />
      <UnderpricedWarning info={nonceInfo} onSpeedUp={(hash) => act('SPEED_UP', hash)} busy={Boolean(busy)} />

      {pending.length > 0 && (
        <div className="card accent">
          <div className="between">
            <span className="eyebrow accent-text">Queue · {pending.length} pending</span>
            <span className="spinner" aria-hidden="true" />
          </div>
          <p className="small">
            Ordered by nonce. Nothing behind a stuck low nonce can confirm until that one clears.
          </p>
          <div className="list">
            {pending.map((tx, index) => (
              <div
                className={`item static compact ${nonceInfo?.firstGap != null && tx.nonce > nonceInfo.firstGap ? 'blocked' : ''}`}
                key={tx.hash}
              >
                <span className="queue-index" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="item-main">
                  <span className="item-title">{label(tx)}</span>
                  <span className="item-sub">
                    nonce {tx.nonce} · {timeAgo(tx.submittedAt)}
                  </span>
                  {nonceInfo?.firstGap != null && tx.nonce > nonceInfo.firstGap && (
                    <span className="item-sub" style={{ color: 'var(--danger)' }}>
                      waiting on nonce {nonceInfo.firstGap}
                    </span>
                  )}
                </div>
                <div className="item-right">
                  <button className="link accent" disabled={busy === tx.hash} onClick={() => act('SPEED_UP', tx.hash)}>
                    speed up
                  </button>
                  <button className="link" disabled={busy === tx.hash} onClick={() => act('CANCEL_TX', tx.hash)}>
                    cancel
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card activity-tools">
        <div className="tabs" role="tablist" aria-label="Activity scope">
          <button role="tab" aria-selected={scope === 'current'} onClick={() => setScope('current')}>
            {portfolio?.network?.name ?? 'This network'}
          </button>
          <button role="tab" aria-selected={scope === 'all'} onClick={() => setScope('all')}>
            All networks{elsewhere > 0 ? ` (+${elsewhere})` : ''}
          </button>
        </div>

        {scope === 'all' && (
          <p className="small faint">
            Showing every network. Amounts and nonces are only comparable within a single chain, so each row is
            labelled with the network it belongs to.
          </p>
        )}

        <label className="field">
          <span>Search activity</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Hash, address, note, tag"
            type="search"
          />
        </label>
        <div className="row3">
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="failed">Failed</option>
              <option value="replaced">Replaced</option>
            </select>
          </label>
          <label className="field">
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">All</option>
              <option value="send">Send</option>
              <option value="token">Token</option>
            <option value="nft">NFT</option>
              <option value="approval">Approval</option>
              <option value="contract">Contract</option>
              <option value="replacement">Replacement</option>
            </select>
          </label>
          <label className="field">
            <span>Period</span>
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              <option value="all">All time</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
            </select>
          </label>
        </div>
        {tags.length > 0 && (
          <div className="inline wrap">
            <span className="small faint">Tags:</span>
            {tags.map(({ tag, count }) => (
              <button
                key={tag}
                className={`chip ${tagFilter.toLowerCase() === tag.toLowerCase() ? 'accent' : ''}`}
                aria-pressed={tagFilter.toLowerCase() === tag.toLowerCase()}
                onClick={() => setTagFilter(tagFilter.toLowerCase() === tag.toLowerCase() ? '' : tag)}
              >
                {tag} ({count})
              </button>
            ))}
          </div>
        )}

        {noiseCount > 0 && (
          <label className="check-line">
            <input type="checkbox" checked={showNoise} onChange={(e) => setShowNoise(e.target.checked)} />
            <span className="item-main">
              <span>Show {noiseCount} zero-value transfer{noiseCount === 1 ? '' : 's'}</span>
              <span className="small faint">
                Cancels and nonce fills the wallet sent itself. They cost a fee but move nothing.
              </span>
            </span>
          </label>
        )}

        <div className="between small">
          <span>
            Showing {filtered.length} of {activity.length}
          </span>
          <span className="inline">
            {(status !== 'all' || kind !== 'all' || range !== 'all' || query || tagFilter) && (
              <button
                className="link"
                onClick={() => {
                  setStatus('all');
                  setKind('all');
                  setRange('all');
                  setQuery('');
                  setTagFilter('');
                }}
              >
                clear
              </button>
            )}
            <button className="link accent" disabled={!filtered.length} onClick={() => exportActivityCsv(filtered)}>
              export csv
            </button>
          </span>
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {scope === 'current' && elsewhere > 0 && (
        <ChainBreakdown chains={chainSummary} currentChainId={currentChainId} onShowAll={() => setScope('all')} />
      )}

      {!filtered.length ? (
        <EmptyState icon="⌕" title="No match" body="No transaction matches those filters." />
      ) : (
        <div className="list">
          {filtered.map((tx) => (
            <button className="item" key={tx.hash} onClick={() => onOpen(tx.hash)}>
              <div className="item-main">
                <span className="item-title">
                  {tx.kind === 'cancel' ? 'Cancel' : tx.kind === 'speedup' ? 'Speed up' : label(tx)}
                </span>
                <span className="item-sub">
                  {tx.decoded?.name ? `${tx.decoded.name} · ` : ''}
                  {tx.to ? shorten(tx.to) : 'contract deploy'} · {timeAgo(tx.submittedAt)}
                  {scope === 'all' && ` · ${tx.networkName ?? tx.chainId}`}
                </span>
                {tx.noise?.noise && <span className="small faint">{tx.noise.reason}</span>}
                {tx.note && <span className="small faint">{tx.note}</span>}
                {tx.tags?.length > 0 && (
                  <span className="inline wrap" style={{ marginTop: 4 }}>
                    {tx.tags.map((tag) => (
                      <span
                        className="badge accent"
                        key={tag}
                        role="button"
                        tabIndex={0}
                        title={`Filter by "${tag}"`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTagFilter(tag);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setTagFilter(tag);
                          }
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
                <span className={`badge ${tx.status}`}>{tx.status}</span>
                <span className="caret" aria-hidden="true">
                  ›
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A 24h move, rendered only when there is one. Zero is not the same as absent. */
function PriceChange({ value }) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const change = Number(value);
  return (
    <span className={`price-change ${change >= 0 ? 'up' : 'down'}`}>
      {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
    </span>
  );
}

/** Where an account's history actually lives, network by network. */
function ChainBreakdown({ chains, currentChainId, onShowAll }) {
  if (!chains.length) return null;

  return (
    <div className="card">
      <div className="between">
        <span className="eyebrow">History by network</span>
        {onShowAll && (
          <button className="link accent" onClick={onShowAll}>
            show all
          </button>
        )}
      </div>
      {chains.map((chain) => (
        <div className="kv" key={chain.chainId}>
          <span className="kv-key">
            {chain.networkName}
            {chain.chainId === currentChainId && <span className="badge confirmed" style={{ marginLeft: 6 }}>current</span>}
          </span>
          <span className="kv-value">
            {chain.total} tx
            {chain.pending > 0 && ` · ${chain.pending} pending`}
            {chain.failed > 0 && ` · ${chain.failed} failed`}
            {chain.lastAt ? ` · ${timeAgo(chain.lastAt)}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
function txKind(tx) {
  if (tx.kind === 'cancel' || tx.kind === 'speedup' || tx.replaces) return 'replacement';
  if (tx.kind === 'nftTransfer') return 'nft';
  if (tx.kind === 'approvalRevoke') return 'approval';
  if (tx.decoded?.approval || tx.decoded?.name === 'approve' || tx.decoded?.name === 'setApprovalForAll') {
    return 'approval';
  }
  if (tx.tokenSymbol) return 'token';
  if (tx.data && tx.data !== '0x') return 'contract';
  return 'send';
}

function label(tx) {
  if (tx.kind === 'approvalRevoke') return 'Revoked approval';
  if (tx.kind === 'nftTransfer') {
    const what = tx.nftTitle || `${tx.nftStandard} #${tx.nftTokenId}`;
    return tx.nftAmount && tx.nftAmount !== '1' ? `Sent ${tx.nftAmount} × ${what}` : `Sent ${what}`;
  }
  if (tx.decoded?.label) return tx.decoded.label;
  if (tx.tokenSymbol) return `Sent ${tx.tokenAmount} ${tx.tokenSymbol}`;
  if (tx.data && tx.data !== '0x') return 'Contract interaction';
  return `Sent ${trimAmount(Number(tx.value) / 1e18)} ${tx.symbol ?? ''}`;
}

function approvalTitle(approval) {
  if (approval.standard === 'ERC20') {
    const amount = approval.unlimited ? 'Unlimited' : trimAmount(approval.displayAmount ?? approval.amount);
    return `${amount} ${approval.symbol || 'tokens'}`;
  }
  if (approval.tokenId) return `${approval.name || 'NFT'} #${approval.tokenId}`;
  return `${approval.name || 'NFT collection'} operator`;
}

function exportActivityCsv(rows) {
  const headers = [
    'submitted_at', 'status', 'type', 'label', 'hash', 'from', 'to', 'value_wei',
    'token_symbol', 'token_amount', 'network', 'chain_id', 'nonce', 'gas_used',
    'block_number', 'method', 'note', 'tags',
  ];
  const csv = [
    headers.join(','),
    ...rows.map((tx) =>
      [
        tx.submittedAt ? new Date(tx.submittedAt).toISOString() : '',
        tx.status,
        txKind(tx),
        label(tx),
        tx.hash,
        tx.from,
        tx.to,
        tx.value,
        tx.tokenSymbol,
        tx.tokenAmount,
        tx.networkName,
        tx.chainId,
        tx.nonce,
        tx.gasUsed,
        tx.blockNumber,
        tx.decoded?.name,
        tx.note,
        (tx.tags ?? []).join('|'),
      ]
        .map(csvCell)
        .join(',')
    ),
  ].join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `adrix-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
