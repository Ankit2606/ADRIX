import { useMemo, useRef, useState } from 'react';
import { Mnemonic, wordlists } from 'ethers';
import { call } from '../../lib/ui.js';

const ENGLISH_WORDS = wordlists.en;

export default function Onboarding({ onDone }) {
  const [mode, setMode] = useState('create');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [mnemonicInput, setMnemonicInput] = useState('');
  const [pathTemplate, setPathTemplate] = useState(null);

  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [keystoreText, setKeystoreText] = useState('');
  const [keystoreName, setKeystoreName] = useState('');
  const [keystorePassword, setKeystorePassword] = useState('');

  const [accountName, setAccountName] = useState('');
  const [revealed, setRevealed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const phraseCheck = useMemo(() => checkPhrase(mnemonicInput), [mnemonicInput]);
  const strength = passwordStrength(password);

  const submit = async () => {
    setError('');
    if (password.length < 8) return setError('Use a password of at least 8 characters.');
    if (password !== confirm) return setError('The two passwords do not match.');

    if (mode === 'import') {
      if (!phraseCheck.valid) return setError(phraseCheck.message || 'Enter a valid recovery phrase.');
    }
    if (mode === 'privateKey' && !privateKeyInput.trim()) return setError('Enter your private key.');
    if (mode === 'keystore') {
      if (!keystoreText.trim()) return setError('Choose a keystore JSON file.');
      if (!keystorePassword) return setError('Enter the password that encrypts the keystore file.');
    }

    setBusy(true);
    try {
      if (mode === 'create') {
        const result = await call('CREATE_WALLET', { password });
        setRevealed(result.mnemonic);
      } else if (mode === 'import') {
        await call('IMPORT_MNEMONIC', {
          password,
          mnemonic: mnemonicInput,
          pathTemplate: pathTemplate ?? undefined,
        });
        onDone();
      } else if (mode === 'privateKey') {
        await call('IMPORT_PRIVATE_KEY_WALLET', { password, privateKey: privateKeyInput, name: accountName });
        onDone();
      } else {
        await call('IMPORT_KEYSTORE_WALLET', {
          password,
          keystore: keystoreText,
          keystorePassword,
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

  if (revealed) return <SeedBackup mnemonic={revealed} onDone={onDone} />;

  return (
    <div className="screen">
      <div className="scroll pad stack">
        <div className="inline">
          <span className="dot" />
          <b>ADRIX</b>
        </div>
        <div className="eyebrow">Step 1 of 2</div>
        <h1>Set up your wallet</h1>

        <div className="tabs wrap-tabs" role="tablist" aria-label="Setup method">
          {[
            ['create', 'Create'],
            ['import', 'Phrase'],
            ['privateKey', 'Key'],
            ['keystore', 'Keystore'],
          ].map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={mode === value}
              onClick={() => {
                setMode(value);
                setError('');
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'import' && (
          <PhraseImport
            value={mnemonicInput}
            onChange={setMnemonicInput}
            check={phraseCheck}
            pathTemplate={pathTemplate}
            setPathTemplate={setPathTemplate}
          />
        )}

        {mode === 'privateKey' && (
          <>
            <label className="field">
              <span>Private key</span>
              <input
                className="mono"
                type={showPassword ? 'text' : 'password'}
                value={privateKeyInput}
                onChange={(e) => setPrivateKeyInput(e.target.value)}
                spellCheck="false"
                autoComplete="off"
                placeholder="0x…"
              />
            </label>
            <label className="field">
              <span>Account name (optional)</span>
              <input value={accountName} onChange={(e) => setAccountName(e.target.value)} maxLength={40} />
            </label>
            <div className="notice">
              A private-key import has no recovery phrase in ADRIX. Back that key up separately.
            </div>
          </>
        )}

        {mode === 'keystore' && (
          <KeystoreImport
            text={keystoreText}
            setText={setKeystoreText}
            fileName={keystoreName}
            setFileName={setKeystoreName}
            keystorePassword={keystorePassword}
            setKeystorePassword={setKeystorePassword}
            accountName={accountName}
            setAccountName={setAccountName}
            onError={setError}
          />
        )}

        <div className="beam" />

        <label className="field">
          <span>Password</span>
          <div className="input-group">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              aria-describedby="pw-strength"
            />
            <button
              type="button"
              className="ghost"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>

        <div className="strength" id="pw-strength">
          <div className="strength-bars" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <span key={index} className={index < strength.level ? strength.tone : ''} />
            ))}
          </div>
          <div className="between small">
            <span>Password strength</span>
            <b aria-live="polite">{strength.label}</b>
          </div>
          {strength.advice && <p className="small faint">{strength.advice}</p>}
        </div>

        <label className="field">
          <span>Confirm password</span>
          <input
            type={showPassword ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            autoComplete="new-password"
          />
        </label>
        {confirm && confirm !== password && <div className="small" style={{ color: 'var(--warn)' }}>Passwords do not match yet.</div>}

        <p className="small">
          The password encrypts your keys on this device only. It is never sent anywhere, and it cannot be reset.
        </p>
        {error && <div className="error" role="alert">{error}</div>}
      </div>

      <div className="footer">
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Encrypting…' : mode === 'create' ? 'Create wallet' : 'Import wallet'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recovery phrase import
// ---------------------------------------------------------------------------
function PhraseImport({ value, onChange, check, pathTemplate, setPathTemplate }) {
  const [presets, setPresets] = useState(null);
  const [customPath, setCustomPath] = useState("m/44'/60'/0'/0/{index}");
  const [customPreview, setCustomPreview] = useState(null);
  const [pathError, setPathError] = useState('');
  const [loadingPaths, setLoadingPaths] = useState(false);

  const loadPaths = async () => {
    setLoadingPaths(true);
    setPathError('');
    try {
      const result = await call('PREVIEW_DERIVATION', { mnemonic: value });
      setPresets(result.presets);
      if (!pathTemplate) setPathTemplate(result.presets[0].template);
    } catch (err) {
      setPathError(err.message);
    } finally {
      setLoadingPaths(false);
    }
  };

  const previewCustom = async () => {
    setPathError('');
    try {
      const result = await call('PREVIEW_CUSTOM_DERIVATION', { mnemonic: value, template: customPath });
      setCustomPreview(result);
      setPathTemplate(result.template);
    } catch (err) {
      setPathError(err.message);
    }
  };

  return (
    <>
      <label className="field">
        <span>Recovery phrase (12 or 24 words)</span>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            // Paste the whole phrase at once, tolerating newlines, tabs, numbered
            // lists ("1. word") and stray punctuation from a screenshot or PDF.
            e.preventDefault();
            onChange(normalisePastedPhrase(e.clipboardData.getData('text')));
          }}
          spellCheck="false"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          rows={3}
          placeholder="Paste all words at once, or type them separated by spaces"
          aria-describedby="phrase-status"
        />
      </label>

      <div id="phrase-status" aria-live="polite">
        {check.state === 'empty' ? (
          <p className="small faint">Nothing entered yet.</p>
        ) : check.valid ? (
          <div className="ok">Valid {check.count}-word phrase.</div>
        ) : (
          <div className={check.state === 'incomplete' ? 'notice' : 'error'}>{check.message}</div>
        )}
      </div>

      {check.words.length > 0 && (
        <div className="seed-grid" aria-hidden="true">
          {check.words.map((word, index) => (
            <div className={`seed-word ${check.badWords.includes(index) ? 'bad' : ''}`} key={index}>
              <b>{index + 1}</b>
              {word}
            </div>
          ))}
        </div>
      )}

      {check.valid && (
        <div className="card">
          <div className="between">
            <h2>Derivation path</h2>
            {!presets && (
              <button className="link accent" onClick={loadPaths} disabled={loadingPaths}>
                {loadingPaths ? 'reading…' : 'choose'}
              </button>
            )}
          </div>
          <p className="small">
            Different wallets number accounts differently. If the addresses below do not match what you expect, pick
            another path.
          </p>

          {presets?.map((preset) => (
            <button
              key={preset.id}
              className={`item compact ${pathTemplate === preset.template ? 'selected' : ''}`}
              onClick={() => setPathTemplate(preset.template)}
            >
              <div className="item-main">
                <span className="item-title">{preset.label}</span>
                <span className="item-sub">{preset.template}</span>
                <span className="item-sub">{preset.addresses[0]}</span>
              </div>
            </button>
          ))}

          {presets && (
            <>
              <label className="field">
                <span>Custom path</span>
                <div className="input-group">
                  <input
                    className="mono"
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    spellCheck="false"
                  />
                  <button className="ghost" onClick={previewCustom}>
                    Preview
                  </button>
                </div>
              </label>
              {customPreview && (
                <button
                  className={`item compact ${pathTemplate === customPreview.template ? 'selected' : ''}`}
                  onClick={() => setPathTemplate(customPreview.template)}
                >
                  <div className="item-main">
                    <span className="item-title">Custom</span>
                    <span className="item-sub">{customPreview.template}</span>
                    <span className="item-sub">{customPreview.addresses[0]}</span>
                  </div>
                </button>
              )}
            </>
          )}

          {pathError && <div className="error">{pathError}</div>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Keystore import
// ---------------------------------------------------------------------------
function KeystoreImport({
  text,
  setText,
  fileName,
  setFileName,
  keystorePassword,
  setKeystorePassword,
  accountName,
  setAccountName,
  onError,
}) {
  const inputRef = useRef(null);
  const [summary, setSummary] = useState(null);

  const readFile = async (file) => {
    if (!file) return;
    onError('');
    setSummary(null);
    try {
      const content = await file.text();
      const parsed = JSON.parse(content);
      if (!parsed.crypto && !parsed.Crypto) throw new Error('not a keystore');
      setText(content);
      setFileName(file.name);
      setSummary({
        address: parsed.address ? `0x${String(parsed.address).replace(/^0x/, '')}` : 'unknown',
        version: parsed.version ?? '?',
        kdf: (parsed.crypto ?? parsed.Crypto)?.kdf ?? '?',
      });
    } catch {
      setText('');
      setFileName('');
      onError('That file is not a valid v3 keystore JSON.');
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        onChange={(e) => readFile(e.target.files?.[0])}
      />
      <button className="ghost" onClick={() => inputRef.current?.click()}>
        {fileName ? `Selected: ${fileName}` : 'Choose keystore JSON file'}
      </button>

      {summary && (
        <div className="card">
          <div className="between">
            <span className="small">Address</span>
            <span className="mono small">{summary.address}</span>
          </div>
          <div className="between">
            <span className="small">Version</span>
            <span className="mono small">v{summary.version}</span>
          </div>
          <div className="between">
            <span className="small">KDF</span>
            <span className="mono small">{summary.kdf}</span>
          </div>
        </div>
      )}

      <label className="field">
        <span>Keystore password</span>
        <input
          type="password"
          value={keystorePassword}
          onChange={(e) => setKeystorePassword(e.target.value)}
          autoComplete="off"
          placeholder="The password that encrypts the file"
        />
      </label>
      <label className="field">
        <span>Account name (optional)</span>
        <input value={accountName} onChange={(e) => setAccountName(e.target.value)} maxLength={40} />
      </label>
      <div className="notice">
        Decrypting a scrypt keystore is deliberately slow and can take several seconds.
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Seed backup + confirmation quiz
// ---------------------------------------------------------------------------
function SeedBackup({ mnemonic, onDone }) {
  const words = mnemonic.split(' ');
  const [stage, setStage] = useState('reveal');
  const [blurred, setBlurred] = useState(true);
  const [confirmationWords] = useState(() => pickConfirmationWords(words.length));
  const [answers, setAnswers] = useState({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const allCorrect = confirmationWords.every(
    (index) => answers[index]?.trim().toLowerCase() === words[index]
  );

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      // Verified in the background against the stored phrase, so the flag can
      // never be set by a UI that merely thinks the answers were right.
      await call('VERIFY_BACKUP', {
        words: Object.fromEntries(confirmationWords.map((index) => [index, answers[index]])),
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'reveal') {
    return (
      <div className="screen">
        <div className="scroll pad stack">
          <div className="eyebrow">Step 2 of 2</div>
          <h1>Save your recovery phrase</h1>
          <p>
            These {words.length} words rebuild your wallet on any device. Write them on paper. Anyone who reads them
            can take everything in this wallet.
          </p>

          <div className={`seed-grid ${blurred ? 'blurred' : ''}`}>
            {words.map((word, index) => (
              <div className="seed-word" key={index}>
                <b>{index + 1}</b>
                {word}
              </div>
            ))}
          </div>

          {blurred ? (
            <button className="ghost" onClick={() => setBlurred(false)}>
              Tap to reveal
            </button>
          ) : (
            <button className="link" onClick={() => navigator.clipboard.writeText(mnemonic).catch(() => {})}>
              Copy to clipboard
            </button>
          )}

          <div className="notice">
            ADRIX cannot recover this for you. There is no reset link and no support desk. Screenshots end up in cloud
            backups — paper is safer.
          </div>
        </div>
        <div className="footer">
          <button className="primary" disabled={blurred} onClick={() => setStage('confirm')}>
            I have written it down
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="scroll pad stack">
        <div className="eyebrow">Step 2 of 2</div>
        <h1>Confirm your phrase</h1>
        <p>Enter these words from the phrase you just saved.</p>

        {confirmationWords.map((index) => {
          const answer = answers[index] ?? '';
          const wrong = answer.trim().length > 0 && answer.trim().toLowerCase() !== words[index];
          return (
            <label className="field" key={index}>
              <span>Word {index + 1}</span>
              <input
                className="mono"
                value={answer}
                onChange={(e) => setAnswers({ ...answers, [index]: e.target.value })}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck="false"
                aria-invalid={wrong}
              />
              {wrong && <span className="small" style={{ color: 'var(--warn)' }}>Not the word at position {index + 1}.</span>}
            </label>
          );
        })}

        <label className="check-line">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          I understand that losing this phrase means losing the wallet.
        </label>

        {error && <div className="error" role="alert">{error}</div>}
      </div>
      <div className="footer">
        <div className="row2">
          <button className="ghost" onClick={() => setStage('reveal')}>
            Show phrase
          </button>
          <button className="primary" onClick={finish} disabled={!allCorrect || !acknowledged || busy}>
            {busy ? 'Checking…' : 'Open my wallet'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function normalisePastedPhrase(text) {
  return String(text ?? '')
    .replace(/\d+[.)]\s*/g, ' ') // numbered lists
    .replace(/[^\p{L}\s]/gu, ' ') // punctuation, commas, quotes
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** Word-by-word validation: which words are not in the BIP-39 list, and is the checksum good. */
function checkPhrase(input) {
  const words = String(input ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { state: 'empty', valid: false, words: [], badWords: [], count: 0 };

  const badWords = words
    .map((word, index) => (ENGLISH_WORDS.getWordIndex(word) === -1 ? index : -1))
    .filter((index) => index !== -1);

  if (badWords.length) {
    const list = badWords.slice(0, 3).map((index) => `#${index + 1} "${words[index]}"`).join(', ');
    return {
      state: 'badword',
      valid: false,
      words,
      badWords,
      count: words.length,
      message: `Not BIP-39 words: ${list}${badWords.length > 3 ? `, +${badWords.length - 3} more` : ''}.`,
    };
  }

  if (![12, 15, 18, 21, 24].includes(words.length)) {
    return {
      state: 'incomplete',
      valid: false,
      words,
      badWords: [],
      count: words.length,
      message: `${words.length} words so far. A phrase is 12 or 24 words.`,
    };
  }

  if (!Mnemonic.isValidMnemonic(words.join(' '))) {
    return {
      state: 'checksum',
      valid: false,
      words,
      badWords: [],
      count: words.length,
      message: 'Every word is valid, but the phrase checksum fails. A word is in the wrong order or mistyped.',
    };
  }

  return { state: 'valid', valid: true, words, badWords: [], count: words.length };
}

function passwordStrength(password) {
  if (!password) return { level: 0, label: 'Empty', tone: 'weak', advice: '' };

  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  const advice =
    password.length < 12
      ? 'Length matters more than symbols. Aim for 12+ characters.'
      : score < 4
        ? 'Mixing case, digits, or a symbol would strengthen this.'
        : '';

  if (score <= 1) return { level: 1, label: 'Weak', tone: 'weak', advice };
  if (score === 2) return { level: 2, label: 'Fair', tone: 'fair', advice };
  if (score <= 4) return { level: 3, label: 'Good', tone: 'good', advice };
  return { level: 4, label: 'Strong', tone: 'strong', advice };
}

/** Three distinct word positions, chosen with real entropy. */
function pickConfirmationWords(length) {
  const selected = new Set();
  const random = new Uint32Array(length * 2);
  crypto.getRandomValues(random);

  for (const value of random) {
    selected.add(value % length);
    if (selected.size === 3) break;
  }
  for (let index = 0; selected.size < 3 && index < length; index++) selected.add(index);

  return [...selected].sort((a, b) => a - b);
}
