import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accountColor, call, jazziconData, shorten, t, timeAgo } from '../../lib/ui.js';

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
export function TopBar({ state, onOpenAccounts, onOpenNetworks, onOpenSettings, pending = 0 }) {
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

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setHealth(await call('CHECK_NETWORK_HEALTH', { chainId }));
    } catch (err) {
      setHealth({ status: 'offline', error: err.message, checkedAt: Date.now() });
    } finally {
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

      {health?.checkedAt && <p className="small faint">Checked {timeAgo(health.checkedAt)}.</p>}
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

function formatGwei(wei) {
  try {
    const gwei = Number(BigInt(wei)) / 1e9;
    return gwei < 0.01 ? gwei.toExponential(1) : gwei.toFixed(gwei < 10 ? 2 : 0);
  } catch {
    return '--';
  }
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
