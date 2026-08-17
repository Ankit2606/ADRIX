import { useState } from 'react';
import { call } from '../../lib/ui.js';

export default function Unlock({ onDone, compact = false }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingWipe, setConfirmingWipe] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await call('UNLOCK', { password });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

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
        <input
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="error">{error}</div>}
        <button className="primary" onClick={submit} disabled={busy || !password}>
          {busy ? 'Unlocking...' : 'Unlock'}
        </button>
        <div className="spacer" />

        {!compact &&
          (confirmingWipe ? (
            <div className="card">
              <p className="small">
                Forgot the password? The only way back in is your recovery phrase. Erasing removes this wallet from the
                browser.
              </p>
              <div className="row2">
                <button className="ghost" onClick={() => setConfirmingWipe(false)}>
                  Keep it
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    await call('WIPE');
                    onDone();
                  }}
                >
                  Erase wallet
                </button>
              </div>
            </div>
          ) : (
            <button className="link" onClick={() => setConfirmingWipe(true)}>
              Forgot password?
            </button>
          ))}
      </div>
    </div>
  );
}
