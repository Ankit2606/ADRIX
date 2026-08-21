import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accountColor, call, formatEta, formatGwei, jazziconData, shorten, t, timeAgo } from '../../lib/ui.js';

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------
const SIZES = { sm: 26, lg: 34, xl: 56 };

/**
 * An ENS avatar when the account has one, otherwise a deterministic jazzicon
 * generated from the address. Never a bare colour block — the shapes are what
 * make two accounts distinguishable at a glance.
 */
export function Avatar({ address, size = 'sm', src = '', className = '' }) {
  const px = SIZES[size] ?? SIZES.sm;
  const data = useMemo(() => jazziconData(address), [address]);

  if (src) {
    return (
      <img
        className={`avatar ${size} ${className}`}
        style={{ width: px, height: px }}
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={(event) => {
          event.currentTarget.style.display = 'none';
        }}
      />
    );
  }

  if (!address) {
    return (
      <span
        className={`avatar ${size} ${className}`}
        style={{ width: px, height: px, background: accountColor(address) }}
        aria-hidden="true"
      />
    );
  }

  return (
    <svg
      className={`avatar ${size} ${className}`}
      style={{ width: px, height: px }}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="100" height="100" fill={data.background} />
      {data.shapes.map((shape, index) => (
        <rect
          key={index}
          x="0"
          y="0"
          width="100"
          height="100"
          fill={shape.color}
          transform={`translate(${shape.translateX} ${shape.translateY}) rotate(${shape.rotate} ${shape.center} ${shape.center})`}
        />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------
export function TopBar({ state, onOpenAccounts, onOpenNetworks, onOpenSettings, onOpenSearch, pending = 0 }) {
  const account = state.accounts.find((a) => a.address === state.selected);
  const health = state.networkHealth;

  return (
    <header className="topbar home">
      <button className="chip" onClick={onOpenNetworks} title={networkHealthTitle(health)}>
        <span className={`dot health ${health?.status ?? 'unknown'}`} />
        <span className="chip-label">{state.network?.name ?? 'Network'}</span>
      </button>

      <button className="account-pill" onClick={onOpenAccounts} title="Switch account">
        <Avatar address={state.selected} src={account?.ens?.avatar} />
        <span className="account-pill-text">
          <span className="account-pill-name">{account?.ens?.name ?? account?.name ?? 'Account'}</span>
          <span className="account-pill-address">{shorten(state.selected)}</span>
        </span>
        <span className="caret" aria-hidden="true">
          ▼
        </span>
      </button>

      {onOpenSearch && (
        <button className="icon-btn plain" onClick={onOpenSearch} title="Search everything" aria-label="Search everything">
          ⌕
        </button>
      )}

      <button className="icon-btn plain" onClick={onOpenSettings} title={t('settings.title')} aria-label={t('settings.title')}>
        ☰
        {pending > 0 && <span className="pip" aria-hidden="true" />}
      </button>
    </header>
  );
}

function networkHealthTitle(health) {
  if (!health || health.status === 'unknown') return 'Network health not checked yet';
  if (health.status === 'offline') return `Network offline: ${health.error ?? 'RPC unavailable'}`;
  const parts = [`Network ${health.status}`];
  if (health.latencyMs != null) parts.push(`${health.latencyMs}ms`);
  if (health.blockNumber != null) parts.push(`block ${health.blockNumber}`);
  if (health.stale) parts.push('(cached)');
  return parts.join(' · ');
}

/**
 * Live health readout for one network. Probes on mount and on demand rather
 * than on every state broadcast, so opening the popup is never blocked on an
 * RPC round trip.
 */
export function NetworkHealthPanel({ chainId, name, initial = null }) {
  const [health, setHealth] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [endpoints, setEndpoints] = useState([]);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setHealth(await call('CHECK_NETWORK_HEALTH', { chainId }));
    } catch (err) {
      setHealth({ status: 'offline', error: err.message, checkedAt: Date.now() });
    } finally {
      // Endpoint states are a by-product of the probe above, so they are read
      // after it rather than triggering their own round of requests.
      call('PEEK_ENDPOINTS', { chainId })
        .then((result) => setEndpoints(result.endpoints ?? []))
        .catch(() => setEndpoints([]));
      setChecking(false);
    }
  }, [chainId]);

  useEffect(() => {
    check();
  }, [check]);

  const latency = health?.latencyMs;
  // 2500ms is where getNetworkHealth stops calling an endpoint "slow", so the
  // bar is scaled against that rather than an arbitrary maximum.
  const latencyPercent = latency == null ? 0 : Math.min(100, (latency / 2500) * 100);
  const behind = health?.blockAgeMs != null && health.blockAgeMs > 60_000;

  return (
    <div className="card">
      <div className="between">
        <span className="eyebrow">Network health{name ? ` · ${name}` : ''}</span>
        <button className="link accent" onClick={check} disabled={checking}>
          {checking ? 'checking…' : 'recheck'}
        </button>
      </div>

      <div className="inline">
        <span className={`dot health ${health?.status ?? 'unknown'}`} />
        <b className="small">{describeStatus(health, checking)}</b>
        {health?.rpcHost && <span className="small faint mono">{health.rpcHost}</span>}
      </div>

      {health?.status === 'offline' ? (
        <div className="error" role="alert">
          {health.error ?? 'The RPC endpoint did not respond.'} Edit this network to try a different endpoint.
        </div>
      ) : (
        <>
          <div className="health-grid">
            <div className={`health-metric ${latencyTone(latency)}`}>
              <span className="health-metric-value">{latency == null ? '--' : `${latency}ms`}</span>
              <span className="health-metric-label">Round trip</span>
              <span className={`health-bar ${health?.status ?? ''}`}>
                <span style={{ width: `${latencyPercent}%` }} />
              </span>
            </div>
            <div className={`health-metric ${behind ? 'warn' : ''}`}>
              <span className="health-metric-value">{health?.blockNumber ?? '--'}</span>
              <span className="health-metric-label">
                Head block{health?.blockAgeMs != null ? ` · ${Math.round(health.blockAgeMs / 1000)}s old` : ''}
              </span>
            </div>
            {health?.baseFeePerGas != null && (
              <div className="health-metric">
                <span className="health-metric-value">{formatGwei(health.baseFeePerGas)}</span>
                <span className="health-metric-label">Base fee (gwei)</span>
              </div>
            )}
            {health?.gasPrice != null && (
              <div className="health-metric">
                <span className="health-metric-value">{formatGwei(health.gasPrice)}</span>
                <span className="health-metric-label">Gas price (gwei)</span>
              </div>
            )}
          </div>

          {behind && (
            <div className="notice">
              This endpoint's latest block is {Math.round(health.blockAgeMs / 1000)}s old. It may be lagging behind the
              chain, which makes balances and nonces stale.
            </div>
          )}
        </>
      )}

      {health?.usingFallback && (
        <div className="notice">
          The primary endpoint is not answering, so ADRIX has fallen back to <b>{health.rpcHost}</b>. Everything still
          works; reorder the list in the network editor if you want this one first.
        </div>
      )}

      {endpoints.length > 1 && (
        <div className="stack-sm">
          <div className="between">
            <span className="eyebrow">Endpoints</span>
            <span className="small faint">
              {endpoints.filter((entry) => entry.status !== 'resting').length} of {endpoints.length} available
            </span>
          </div>
          {endpoints.map((entry) => (
            <div className="endpoint-row" key={entry.url}>
              <span className={`dot health ${entry.status === 'ok' ? 'good' : entry.status === 'resting' ? 'offline' : 'unknown'}`} />
              <div className="item-main">
                <span className="item-title mono small">{entry.host}</span>
                <span className="item-sub">
                  {entry.status === 'resting'
                    ? `backing off ${Math.ceil(entry.cooldownMs / 1000)}s after ${entry.failures} failure${entry.failures === 1 ? '' : 's'}`
                    : entry.latencyMs != null
                      ? `${entry.latencyMs}ms · last ok ${timeAgo(entry.lastOkAt)}`
                      : 'not tried yet'}
                </span>
              </div>
              {entry.primary && <span className="badge">primary</span>}
            </div>
          ))}
        </div>
      )}

      {health?.checkedAt && (
        <p className="small faint">
          Checked {timeAgo(health.checkedAt)}
          {endpoints.length > 1 ? ` · failover across ${endpoints.length} endpoints` : ''}.
        </p>
      )}
    </div>
  );
}

function describeStatus(health, checking) {
  if (checking && !health) return 'Checking…';
  switch (health?.status) {
    case 'good':
      return 'Responsive';
    case 'slow':
      return 'Slow but working';
    case 'poor':
      return 'Poor — slow or lagging';
    case 'offline':
      return 'Not responding';
    default:
      return 'Not checked';
  }
}

function latencyTone(latency) {
  if (latency == null) return '';
  if (latency < 900) return 'good';
  if (latency < 2500) return 'warn';
  return 'bad';
}

// ---------------------------------------------------------------------------
// Sparkline
//
// A plain inline SVG: no chart library, no runtime, and it inherits the theme
// through currentColor so it works in both palettes without a second definition.
// ---------------------------------------------------------------------------
export function Sparkline({ values = [], width = 260, height = 46, ariaLabel, className = '' }) {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value));
  if (numbers.length < 2) return null;

  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  // A perfectly flat series would divide by zero and, worse, render as a line
  // pinned to the top of the box. Flat data should look flat and centred.
  const span = max - min || 1;
  const pad = 3;
  const stepX = width / (numbers.length - 1);
  const yFor = (value) =>
    max === min ? height / 2 : height - pad - ((value - min) / span) * (height - pad * 2);

  const points = numbers.map((value, index) => `${(index * stepX).toFixed(2)},${yFor(value).toFixed(2)}`);
  const last = numbers[numbers.length - 1];

  return (
    <svg
      className={`sparkline ${className}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel ?? `Trend across ${numbers.length} points`}
    >
      <polygon className="sparkline-area" points={`0,${height} ${points.join(' ')} ${width},${height}`} />
      <polyline className="sparkline-line" points={points.join(' ')} />
      <circle className="sparkline-head" cx={width} cy={yFor(last)} r="2.6" />
    </svg>
  );
}

/**
 * Recent base fee movement, so the choice between sending now and waiting is
 * made against data rather than a guess. Renders nothing when the endpoint does
 * not serve eth_feeHistory — an empty chart is worse than no chart.
 */
export function BaseFeePanel({ feeHistory, compact = false }) {
  if (!feeHistory?.supported || !feeHistory.baseFees?.length) return null;

  // A throw inside render blanks the whole popup, so a malformed series is
  // dropped rather than trusted — the chart is the least important thing here.
  let gwei;
  try {
    gwei = feeHistory.baseFees.map((wei) => Number(BigInt(wei)) / 1e9);
  } catch {
    return null;
  }
  if (!gwei.every((value) => Number.isFinite(value))) return null;
  const { direction, percent } = feeHistory.trend ?? {};
  const congestionPercent = Math.round((feeHistory.congestion ?? 0) * 100);

  const arrow = direction === 'rising' ? '▲' : direction === 'falling' ? '▼' : '▬';
  const tone = direction === 'rising' ? 'warn' : direction === 'falling' ? 'good' : '';

  return (
    <div className="card fee-history">
      <div className="between">
        <span className="eyebrow">Base fee · last {gwei.length} blocks</span>
        <span className={`badge ${tone === 'good' ? 'confirmed' : tone === 'warn' ? 'pending' : ''}`}>
          {arrow} {percent > 0 ? '+' : ''}
          {percent}%
        </span>
      </div>

      <Sparkline
        values={gwei}
        ariaLabel={`Base fee over the last ${gwei.length} blocks, ${direction}, currently ${formatGwei(feeHistory.nextBaseFee)} gwei`}
      />

      <div className="fee-history-stats">
        <div className="fee-stat">
          <span className="fee-stat-value">{formatGwei(feeHistory.nextBaseFee)}</span>
          <span className="fee-stat-label">Next block</span>
        </div>
        <div className="fee-stat">
          <span className="fee-stat-value">{formatGwei(feeHistory.median)}</span>
          <span className="fee-stat-label">Median</span>
        </div>
        <div className="fee-stat">
          <span className="fee-stat-value">
            {formatGwei(feeHistory.min)}–{formatGwei(feeHistory.max)}
          </span>
          <span className="fee-stat-label">Range (gwei)</span>
        </div>
        {!compact && (
          <div className={`fee-stat ${congestionPercent > 90 ? 'warn' : ''}`}>
            <span className="fee-stat-value">{congestionPercent}%</span>
            <span className="fee-stat-label">Blocks full</span>
          </div>
        )}
      </div>

      {feeHistory.advice && (
        <div className={`notice ${feeHistory.advice.action === 'wait' ? '' : 'info'}`}>{feeHistory.advice.message}</div>
      )}

      {!compact && (
        <p className="small faint">
          Blocks average {feeHistory.blockTimeSeconds}s here. Time estimates come from the priority fees paid in these
          blocks — they are an observation, not a guarantee.
        </p>
      )}
    </div>
  );
}

/**
 * The blocking-nonce warning.
 *
 * Nonces execute in order, so one missing number freezes everything after it
 * forever. That is invisible from the outside — the transactions simply sit
 * there — so this states the cause, names what is stuck, and offers the fix.
 */
export function NonceGapWarning({ info, onFill, busy = false }) {
  if (!info?.gaps?.length) return null;

  const gap = info.firstGap ?? info.gaps[0];
  const blocked = info.blocked ?? [];

  return (
    <div className="notice danger nonce-gap">
      <b>Nonce {gap} is missing, and it is blocking the queue.</b>
      <p className="small">
        Transactions confirm strictly in nonce order. Nothing was ever broadcast at nonce {gap}, so
        {blocked.length > 0
          ? ` the ${blocked.length} transaction${blocked.length === 1 ? '' : 's'} queued behind it cannot be mined`
          : ' anything queued behind it cannot be mined'}
        {info.gaps.length > 1 ? ` (${info.gaps.length} nonces are missing in total)` : ''}.
      </p>

      {blocked.length > 0 && (
        <ul className="plain-list small nonce-gap-list">
          {blocked.slice(0, 4).map((tx) => (
            <li key={tx.hash}>
              nonce {tx.nonce} · {tx.label} · waiting {timeAgo(tx.submittedAt)}
            </li>
          ))}
          {blocked.length > 4 && <li className="faint">+{blocked.length - 4} more</li>}
        </ul>
      )}

      {onFill && (
        <button className="ghost" onClick={() => onFill(gap)} disabled={busy}>
          {busy ? 'Pricing…' : `Fill nonce ${gap} and unblock`}
        </button>
      )}
    </div>
  );
}

/** A pending transaction whose max fee can no longer clear the base fee. */
export function UnderpricedWarning({ info, onSpeedUp, busy = false }) {
  const stuck = info?.underpriced ?? [];
  if (!stuck.length) return null;

  return (
    <div className="notice">
      <b>
        {stuck.length} pending transaction{stuck.length === 1 ? '' : 's'} priced below the current base fee.
      </b>
      <p className="small">
        The base fee has risen to {formatGwei(info.baseFeePerGas)} gwei since {stuck.length === 1 ? 'it was' : 'they were'}{' '}
        sent. A transaction whose max fee is below the base fee cannot be included at any point — it will sit there
        until the base fee falls back, or until you replace it at a higher fee.
      </p>
      {onSpeedUp && (
        <button className="ghost" onClick={() => onSpeedUp(stuck[0].hash)} disabled={busy}>
          {busy ? 'Working…' : `Speed up nonce ${stuck[0].nonce}`}
        </button>
      )}
    </div>
  );
}

/** Fee presets, shared by every screen that submits a transaction. */
export function GasPresetGrid({ gasInfo, preset, onSelect, disabled = false }) {
  if (!gasInfo?.options) return null;

  return (
    <div className="gas-grid">
      {['low', 'market', 'fast'].map((key) => {
        const option = gasInfo.options[key];
        if (!option) return null;
        return (
          <button
            key={key}
            className="gas-option"
            aria-pressed={preset === key}
            disabled={disabled}
            onClick={() => onSelect(key)}
          >
            <b>{key === 'low' ? 'Slow' : key === 'market' ? 'Market' : 'Fast'}</b>
            <span>~{trimFee(option.likelyFee ?? option.estimatedFee)}</span>
            {option.etaSeconds != null && (
              <span className="eta">
                ~{formatEta(option.etaSeconds)}
                {/* A block count is a firmer claim than a clock reading, so show
                    it when the estimate came from real fee history. */}
                {option.etaBlocks ? ` · ${option.etaBlocks} blk` : ''}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function trimFee(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  if (number === 0) return '0';
  if (number < 0.000001) return '<0.000001';
  return number.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * What a transaction will actually move.
 *
 * The honesty rules here matter more than the layout. A simulation that could
 * not see token movement must not render as "no changes" — that reads as
 * "nothing leaves your wallet", which is the exact opposite of what an
 * incomplete result means. So an incomplete simulation says so, in place of the
 * list, and a failed one says that too.
 */
export function BalanceChanges({ simulation, symbol }) {
  if (!simulation) return null;

  if (simulation.reverted) {
    return (
      <div className="notice danger">
        <b>This transaction will fail.</b>
        <p className="small">
          {simulation.revertReason ?? 'It reverted during simulation.'} Sending it anyway costs the gas fee and
          changes nothing.
        </p>
      </div>
    );
  }

  const changes = simulation.changes ?? [];
  const approvals = simulation.approvals ?? [];

  return (
    <div className="card sim">
      <div className="between">
        <span className="eyebrow">Balance changes</span>
        <span className={`badge ${simulation.complete ? 'confirmed' : 'pending'}`}>
          {simulation.complete ? 'simulated' : 'partial'}
        </span>
      </div>

      {!simulation.complete ? (
        <div className="notice">
          {simulation.incompleteReason ??
            'ADRIX could not fully simulate this transaction on this endpoint, so the changes below may be incomplete.'}
        </div>
      ) : changes.length === 0 && approvals.length === 0 ? (
        <p className="small">
          Nothing moves out of or into this account. The transaction still does something on chain — it just does not
          transfer any asset you hold.
        </p>
      ) : null}

      {changes.map((change, index) => (
        <div className={`sim-row ${change.direction}`} key={`${change.standard}-${change.contract}-${index}`}>
          <span className="sim-sign" aria-hidden="true">
            {change.direction === 'out' ? '−' : '+'}
          </span>
          <div className="item-main">
            <span className="sim-amount">
              {change.standard === 'ERC721' || change.standard === 'ERC1155'
                ? `${change.amount} × #${change.tokenId}`
                : (change.amount ?? `${change.raw} (raw)`)}{' '}
              <span className="sim-symbol">
                {change.symbol ?? (change.standard === 'NATIVE' ? symbol : shorten(change.contract, 6, 4))}
              </span>
            </span>
            <span className="item-sub">
              {change.direction === 'out' ? 'leaves this account' : 'arrives in this account'}
              {change.counterparty ? ` · ${shorten(change.counterparty, 6, 4)}` : ''}
            </span>
            {/* An unrecognised token in a simulation is worth flagging: it is
                often the payout leg of a scam that hands over a worthless
                token in exchange for a real one. */}
            {change.standard === 'ERC20' && change.known === false && (
              <span className="item-sub faint">Not a token you track — ADRIX read its symbol from the contract.</span>
            )}
          </div>
        </div>
      ))}

      {approvals.map((approval, index) => (
        <div className="sim-row approval" key={`approval-${index}`}>
          <span className="sim-sign" aria-hidden="true">
            ⚑
          </span>
          <div className="item-main">
            <span className="sim-amount">
              {approval.revoking
                ? 'Revokes approval'
                : approval.operator
                  ? 'Grants control of every NFT in a collection'
                  : approval.unlimited
                    ? `Grants unlimited ${approval.symbol ?? 'token'} spending`
                    : `Grants ${approval.displayAmount ?? approval.amount} ${approval.symbol ?? ''} spending`}
            </span>
            <span className="item-sub">to {shorten(approval.spender, 8, 6)}</span>
          </div>
        </div>
      ))}

      <p className="small faint">
        {simulation.method === 'eth_simulateV1'
          ? 'Simulated against the current chain state with eth_simulateV1. State can change before this is mined.'
          : simulation.method === 'debug_traceCall'
            ? 'Traced against the current chain state. Token movements are not visible with this method.'
            : 'Only a revert check was possible on this endpoint.'}
      </p>
    </div>
  );
}

/**
 * Site and address screening verdict.
 *
 * Levels rather than a boolean: "we have never seen this site" and "this site
 * is impersonating uniswap.org" deserve very different amounts of the user's
 * attention, and treating them the same trains people to click through both.
 */
export function SecurityBanner({ security }) {
  if (!security) return null;

  const blocks = [
    { source: security.domain, kind: 'site' },
    { source: security.spender, kind: 'spender' },
    { source: security.target, kind: 'recipient' },
  ].filter((entry) => entry.source && ['caution', 'warn', 'danger'].includes(entry.source.level));

  if (!blocks.length) {
    // Recognising a site is worth stating — it is the only positive signal the
    // user ever gets, and its absence is what makes every prompt feel the same.
    if (security.domain?.level === 'known') {
      return <div className="notice info">ADRIX recognises this site as {security.domain.hostname}.</div>;
    }
    return null;
  }

  return (
    <>
      {blocks.map(({ source, kind }) => (
        <div
          className={source.level === 'danger' ? 'notice danger' : 'notice'}
          key={kind}
          role={source.level === 'danger' ? 'alert' : undefined}
        >
          <b>
            {source.level === 'danger' ? '⚠ ' : ''}
            {kind === 'site'
              ? source.impersonating
                ? `This site is impersonating ${source.impersonating.target}`
                : 'This site is flagged'
              : kind === 'spender'
                ? 'The address being granted access is flagged'
                : 'The recipient is flagged'}
          </b>
          <ul className="plain-list small" style={{ marginTop: 4 }}>
            {source.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

export function BackBar({ title, onBack, right = null }) {
  return (
    <header className="topbar">
      <button className="icon-btn plain" onClick={onBack} aria-label={t('common.back')}>
        ←
      </button>
      <h1 className="topbar-title">{title}</h1>
      {right ?? <span className="icon-btn plain" style={{ visibility: 'hidden' }} aria-hidden="true" />}
    </header>
  );
}

export function CopyButton({ value, label, className = 'chip address-chip' }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard can be denied; the address is on screen regardless */
        }
      }}
      title={t('common.copy')}
      aria-live="polite"
    >
      {copied ? t('common.copied') : (label ?? shorten(value, 10, 8))}
    </button>
  );
}

/** Password gate used before revealing key material. */
export function PasswordPrompt({ label = 'Confirm password', onSubmit, onCancel, cta = 'Confirm' }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit(password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <label className="field">
        <span>{label}</span>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && password && submit()}
        />
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row2">
        {onCancel && (
          <button className="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button className="primary" onClick={submit} disabled={busy || !password}>
          {busy ? 'Checking…' : cta}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Async-state primitives
// ---------------------------------------------------------------------------
export function Skeleton({ width = '100%', height = 14, radius, style }) {
  return (
    <span
      className="skeleton"
      style={{ display: 'block', width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

/** Placeholder rows shaped like the asset list, shown on first load. */
export function SkeletonRows({ count = 3 }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{t('common.loading')}</span>
      {Array.from({ length: count }, (_, index) => (
        <div className="asset-row" key={index}>
          <Skeleton width={34} height={34} radius="50%" />
          <div className="asset-main stack-sm">
            <Skeleton width="45%" height={12} />
            <Skeleton width="28%" height={10} />
          </div>
          <div className="asset-values stack-sm" style={{ alignItems: 'flex-end' }}>
            <Skeleton width={54} height={12} />
            <Skeleton width={38} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon = '◇', title, body, action = null }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      {title && <div className="empty-title">{title}</div>}
      {body && <p className="small">{body}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div className="empty error-state" role="alert">
      <div className="empty-icon" aria-hidden="true">
        !
      </div>
      <div className="empty-title">{t('common.somethingWrong')}</div>
      <p className="small">{message}</p>
      {onRetry && (
        <button className="ghost" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QR scanner
//
// Uses the camera plus the native BarcodeDetector, which Chrome ships. No
// bundled decoder and no frames leaving the machine. The stream is stopped on
// every exit path — a wallet leaving the camera light on is alarming.
// ---------------------------------------------------------------------------
export function QrScanner({ onResult, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };

    const start = async () => {
      if (!('BarcodeDetector' in window)) {
        setError('This browser has no built-in QR decoder. Paste the address instead.');
        return;
      }

      let detector;
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (!formats.includes('qr_code')) {
          setError('This browser cannot decode QR codes. Paste the address instead.');
          return;
        }
        detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        setError('Could not start the QR decoder.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        setError(
          err?.name === 'NotAllowedError'
            ? 'Camera access was denied. Allow it for this extension, or paste the address.'
            : 'No camera available. Paste the address instead.'
        );
        return;
      }

      const tick = async () => {
        if (cancelled || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const value = codes?.[0]?.rawValue;
          if (value) {
            stop();
            onResult(value);
            return;
          }
        } catch {
          /* a dropped frame is not worth reporting */
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [onResult]);

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-label={t('send.scanQr')}>
      <div className="scanner-frame">
        {error ? (
          <div className="scanner-error">
            <p className="small">{error}</p>
          </div>
        ) : (
          <>
            <video ref={videoRef} playsInline muted aria-label="Camera preview" />
            <span className="scanner-reticle" aria-hidden="true" />
          </>
        )}
      </div>
      <p className="small center">Point the camera at an address QR code or payment link.</p>
      <button className="ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
    </div>
  );
}
