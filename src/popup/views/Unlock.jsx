import { useEffect, useRef, useState } from 'react';
import { call, useAsyncAction } from '../../lib/ui.js';

// Unlocking is deliberately slow (600k PBKDF2 rounds), which already rate-limits
// guessing. This adds an explicit lockout on top so a script cannot grind the
// vault in the background: the delay grows with each wrong attempt.
const LOCKOUT_AFTER = 5;
const lockoutSeconds = (failures) => Math.min(300, 5 * 2 ** (failures - LOCKOUT_AFTER));

export default function Unlock({ onDone, compact = false }) {
  const [password, setPassword] = useState('');
  const [failures, setFailures] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [mode, setMode] = useState('unlock'); // 'unlock' | 'recover'
  const { busy, error, setError, run } = useAsyncAction();
  const inputRef = useRef(null);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setInterval(() => setCooldown((current) => Math.max(0, current - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const submit = () =>
    run(async () => {
      if (cooldown > 0) throw new Error(`Too many attempts. Wait ${cooldown}s.`);
      try {
        await call('UNLOCK', { password });
        setFailures(0);
        onDone();
      } catch (err) {
        const next = failures + 1;
        setFailures(next);
        setPassword('');
        if (next >= LOCKOUT_AFTER) setCooldown(lockoutSeconds(next));
        inputRef.current?.focus();
        throw err;
      }
    });

  if (mode === 'recover') {
    return <RecoverWallet onCancel={() => setMode('unlock')} onDone={onDone} />;
  }

  return (
    <div className="screen">
      <div className="scroll pad stack" style={{ justifyContent: 'center' }}>
        <div className="spacer" />
        <div className="inline">
          <span className="dot" />
          <b>ADRIX</b>
        </div>
        <h1>Welcome back</h1>
        {compact && <p>A site is waiting on your answer.</p>}

        <label className="field">
          <span className="visually-hidden">Password</span>
          <input
            ref={inputRef}
            type="password"
            autoFocus
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && password && cooldown === 0 && submit()}
            autoComplete="current-password"
            aria-describedby="unlock-error"
          />
        </label>

        {error && (
          <div className="error" id="unlock-error" role="alert">
            {error}
            {failures >= 3 && failures < LOCKOUT_AFTER && (
              <> {LOCKOUT_AFTER - failures} attempt{LOCKOUT_AFTER - failures === 1 ? '' : 's'} before a cooldown.</>
            )}
          </div>
        )}

        {cooldown > 0 && (
          <div className="notice" role="status">
            Locked for {cooldown}s after {failures} wrong attempts.
          </div>
        )}

        <button className="primary" onClick={submit} disabled={busy || !password || cooldown > 0}>
          {busy ? 'Unlocking…' : cooldown > 0 ? `Wait ${cooldown}s` : 'Unlock'}
        </button>

        <div className="spacer" />

        {!compact && (
          <button
            className="link"
            onClick={() => {
              setError('');
              setMode('recover');
            }}
          >
            Forgot password?
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Forgotten password means the vault is unrecoverable — the password is the key.
 * The only way back in is the recovery phrase, so this flow verifies the phrase
 * first, then wipes and restores in one step. Wiping before a valid phrase is
 * entered would destroy a wallet the user could still have reached.
 */
function RecoverWallet({ onCancel, onDone }) {
  const [stage, setStage] = useState('explain');
  const [mnemonic, setMnemonic] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const { busy, error, setError, run } = useAsyncAction();

  const restore = () =>
    run(async () => {
      if (password.length < 8) throw new Error('Use a password of at least 8 characters.');
      if (password !== confirm) throw new Error('The two passwords do not match.');

      // Wipe only once the phrase is in hand; IMPORT_MNEMONIC validates it and
      // throws before anything is destroyed if it is wrong.
      await call('WIPE');
      await call('IMPORT_MNEMONIC', { password, mnemonic });
      onDone();
    });

  if (stage === 'explain') {
    return (
      <div className="screen">
        <div className="scroll pad stack">
          <div className="inline">
            <span className="dot" />
            <b>ADRIX</b>
          </div>
          <h1>Reset with your recovery phrase</h1>

          <div className="notice danger">
            There is no password reset. The password <em>is</em> the encryption key — without it the stored vault
            cannot be opened by anyone, including us.
          </div>

          <p>
            If you have your 12 or 24 word recovery phrase, you can erase this wallet and restore the same accounts
            with a new password. Balances live on-chain, not in this browser, so nothing on-chain is lost.
          </p>

          <div className="card">
            <div className="eyebrow">What gets erased</div>
            <ul className="small plain-list">
              <li>Accounts imported from a private key or keystore</li>
              <li>Watch-only, hardware, and smart accounts</li>
              <li>Custom networks, tracked tokens and NFTs</li>
              <li>Address book, transaction notes, and activity history</li>
              <li>Site connections and permissions</li>
            </ul>
            <p className="small faint">
              Accounts derived from the recovery phrase come back. Everything above does not.
            </p>
          </div>

          <label className="check-line">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            I have my recovery phrase and understand what is erased.
          </label>
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={onCancel}>
              Back
            </button>
            <button className="primary" disabled={!acknowledged} onClick={() => setStage('restore')}>
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="scroll pad stack">
        <h1>Restore your wallet</h1>

        <label className="field">
          <span>Recovery phrase</span>
          <textarea
            value={mnemonic}
            onChange={(e) => setMnemonic(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              setMnemonic(
                e.clipboardData
                  .getData('text')
                  .replace(/\d+[.)]\s*/g, ' ')
                  .replace(/[^\p{L}\s]/gu, ' ')
                  .trim()
                  .toLowerCase()
                  .split(/\s+/)
                  .filter(Boolean)
                  .join(' ')
              );
            }}
            spellCheck="false"
            autoCapitalize="none"
            autoComplete="off"
            rows={3}
            placeholder="12 or 24 words, separated by spaces"
          />
          <span className="small faint">
            {mnemonic.trim() ? `${mnemonic.trim().split(/\s+/).length} words entered` : 'Paste the whole phrase at once'}
          </span>
        </label>

        <label className="field">
          <span>New password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </label>

        {error && <div className="error" role="alert">{error}</div>}
      </div>
      <div className="footer">
        <div className="row2">
          <button
            className="ghost"
            onClick={() => {
              setError('');
              setStage('explain');
            }}
          >
            Back
          </button>
          <button className="danger" onClick={restore} disabled={busy || !mnemonic.trim() || !password}>
            {busy ? 'Restoring…' : 'Erase and restore'}
          </button>
        </div>
      </div>
    </div>
  );
}
