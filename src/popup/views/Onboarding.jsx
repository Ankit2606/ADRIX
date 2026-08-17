import { useState } from 'react';
import { call } from '../../lib/ui.js';

export default function Onboarding({ onDone }) {
  const [mode, setMode] = useState('create');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mnemonicInput, setMnemonicInput] = useState('');
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [accountName, setAccountName] = useState('');
  const [revealed, setRevealed] = useState('');
  const [confirmationWords, setConfirmationWords] = useState([]);
  const [confirmation, setConfirmation] = useState({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (password.length < 8) return setError('Use a password of at least 8 characters.');
    if (password !== confirm) return setError('The two passwords do not match.');
    if (mode === 'import' && !mnemonicInput.trim()) return setError('Enter your recovery phrase.');
    if (mode === 'privateKey' && !privateKeyInput.trim()) return setError('Enter your private key.');

    setBusy(true);
    try {
      if (mode === 'create') {
        const result = await call('CREATE_WALLET', { password });
        setRevealed(result.mnemonic);
        setConfirmationWords(pickConfirmationWords(result.mnemonic));
      } else if (mode === 'import') {
        await call('IMPORT_MNEMONIC', { password, mnemonic: mnemonicInput });
        onDone();
      } else {
        await call('IMPORT_PRIVATE_KEY_WALLET', {
          password,
          privateKey: privateKeyInput,
          name: accountName,
        });
        onDone();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (revealed) {
    const words = revealed.split(' ');
    const confirmed =
      acknowledged &&
      confirmationWords.length > 0 &&
      confirmationWords.every((index) => confirmation[index]?.trim().toLowerCase() === words[index]);

    return (
      <div className="screen">
        <div className="scroll pad stack">
          <div className="eyebrow">Step 2 of 2</div>
          <h1>Save your recovery phrase</h1>
          <p>
            These 12 words rebuild your wallet on any device. Write them down on paper. Anyone who reads them can take
            everything in this wallet.
          </p>
          <div className="seed-grid">
            {words.map((word, index) => (
              <div className="seed-word" key={index}>
                <b>{index + 1}</b>
                {word}
              </div>
            ))}
          </div>
          <button
            className="link"
            onClick={() => navigator.clipboard.writeText(revealed)}
            style={{ alignSelf: 'flex-start' }}
          >
            Copy to clipboard
          </button>
          <div className="notice">
            MiniWallet cannot recover this for you. There is no reset link and no support desk.
          </div>
          <div className="card">
            <h2>Confirm your phrase</h2>
            <p className="small">Enter the requested words before opening the wallet.</p>
            {confirmationWords.map((index) => (
              <label className="field" key={index}>
                <span>Word {index + 1}</span>
                <input
                  value={confirmation[index] ?? ''}
                  onChange={(e) => setConfirmation({ ...confirmation, [index]: e.target.value })}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
            ))}
          </div>
          <label className="inline small" style={{ color: 'var(--muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              style={{ width: 16, height: 16, flex: 'none' }}
            />
            I have written the phrase down somewhere safe.
          </label>
        </div>
        <div className="footer">
          <button className="primary" onClick={onDone} disabled={!confirmed}>
            Open my wallet
          </button>
        </div>
      </div>
    );
  }

  const strength = passwordStrength(password);

  return (
    <div className="screen">
      <div className="scroll pad stack">
        <div className="inline">
          <span className="dot" />
          <b>MiniWallet</b>
        </div>
        <div className="eyebrow">Step 1 of 2</div>
        <h1>Set up your wallet</h1>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'create'} onClick={() => setMode('create')}>
            Create new
          </button>
          <button role="tab" aria-selected={mode === 'import'} onClick={() => setMode('import')}>
            Import phrase
          </button>
          <button role="tab" aria-selected={mode === 'privateKey'} onClick={() => setMode('privateKey')}>
            Import key
          </button>
        </div>

        {mode === 'import' && (
          <label className="field">
            <span>12 or 24 word recovery phrase</span>
            <textarea
              value={mnemonicInput}
              onChange={(e) => setMnemonicInput(e.target.value)}
              spellCheck="false"
              placeholder="word one two three..."
            />
          </label>
        )}

        {mode === 'privateKey' && (
          <>
            <label className="field">
              <span>Private key</span>
              <input
                className="mono"
                value={privateKeyInput}
                onChange={(e) => setPrivateKeyInput(e.target.value)}
                spellCheck="false"
                placeholder="0x..."
              />
            </label>
            <label className="field">
              <span>Account name (optional)</span>
              <input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
            </label>
            <div className="notice">
              A private-key import has no recovery phrase in MiniWallet. Back up that private key separately.
            </div>
          </>
        )}

        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="strength">
          <div className="strength-bars" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <span key={index} className={index < strength.level ? strength.tone : ''} />
            ))}
          </div>
          <div className="between small">
            <span>Password strength</span>
            <b>{strength.label}</b>
          </div>
        </div>
        <label className="field">
          <span>Confirm password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        <p className="small">
          The password encrypts your keys on this device only. It is never sent anywhere, and it cannot be reset.
        </p>
        {error && <div className="error">{error}</div>}
      </div>

      <div className="footer">
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Encrypting...' : mode === 'create' ? 'Create wallet' : 'Import wallet'}
        </button>
      </div>
    </div>
  );
}

function passwordStrength(password) {
  if (!password) return { level: 0, label: 'Empty', tone: 'weak' };

  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  if (score <= 1) return { level: 1, label: 'Weak', tone: 'weak' };
  if (score === 2) return { level: 2, label: 'Fair', tone: 'fair' };
  if (score <= 4) return { level: 3, label: 'Good', tone: 'good' };
  return { level: 4, label: 'Strong', tone: 'strong' };
}

function pickConfirmationWords(mnemonic) {
  const words = mnemonic.split(' ');
  const selected = new Set();
  const random = new Uint8Array(words.length);
  crypto.getRandomValues(random);

  for (const value of random) {
    selected.add(value % words.length);
    if (selected.size === 3) break;
  }

  for (let index = 0; selected.size < 3 && index < words.length; index++) {
    selected.add(index);
  }

  return [...selected].sort((a, b) => a - b);
}
