import { useState } from 'react';
import { accountColor, shorten } from '../../lib/ui.js';

export function Avatar({ address, size = 'sm', src = '' }) {
  if (src) {
    return <img className={`avatar ${size === 'lg' ? 'lg' : ''}`} src={src} alt="" referrerPolicy="no-referrer" />;
  }
  return (
    <span
      className={`avatar ${size === 'lg' ? 'lg' : ''}`}
      style={{ background: accountColor(address) }}
      aria-hidden="true"
    />
  );
}

export function TopBar({ state, onOpenAccounts, onOpenNetworks, onOpenSettings }) {
  const account = state.accounts.find((a) => a.address === state.selected);
  const health = state.networkHealth;
  return (
    <header className="mm-topbar">
      <button className="icon-btn" onClick={onOpenNetworks} title={networkHealthTitle(health)} style={{ background: 'var(--surface-2)', borderRadius: '16px', padding: '4px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span className={`dot health ${health?.status ?? 'unknown'}`} />
      </button>
      
      <div className="mm-account-selector" onClick={onOpenAccounts}>
        <div className="mm-account-name">
          {account?.ens?.name ?? account?.name ?? 'Account'} <span style={{fontSize:'10px'}}>▼</span>
        </div>
        <div className="mm-account-address">
          {shorten(state.selected)} <span style={{fontSize:'10px'}}>⎘</span>
        </div>
      </div>
      
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="icon-btn" title="Network">🌐</button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings">☰</button>
      </div>
    </header>
  );
}

function networkHealthTitle(health) {
  if (!health) return 'Network health unknown';
  if (health.status === 'offline') return `Network offline: ${health.error ?? 'RPC unavailable'}`;
  return `Network ${health.status}. Latency ${health.latencyMs}ms. Block ${health.blockNumber ?? '--'}.`;
}

export function BackBar({ title, onBack, right = null }) {
  return (
    <header className="topbar">
      <button className="icon-btn" onClick={onBack} aria-label="Go back">
        ←
      </button>
      <h2>{title}</h2>
      <div className="spacer" />
      {right}
    </header>
  );
}

export function CopyButton({ value, label, className = 'chip address-chip' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      title="Copy to clipboard"
    >
      {copied ? 'Copied' : (label ?? shorten(value, 10, 8))}
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
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="row2">
        {onCancel && (
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="primary" onClick={submit} disabled={busy || !password}>
          {busy ? 'Checking...' : cta}
        </button>
      </div>
    </div>
  );
}
