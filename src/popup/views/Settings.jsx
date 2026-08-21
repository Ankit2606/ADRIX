import { useEffect, useRef, useState } from 'react';
import { call, shorten, timeAgo, formatDateTime, useAsyncAction } from '../../lib/ui.js';
import { LOCALES, localeCoverage } from '../../lib/i18n.js';
import { BackBar, PasswordPrompt, Avatar } from '../components/common.jsx';

export default function Settings({ state, go, refresh }) {
  const [panel, setPanel] = useState(null);
  const [message, setMessage] = useState('');
  const [currencies, setCurrencies] = useState([]);

  useEffect(() => {
    call('GET_CURRENCIES')
      .then((result) => setCurrencies(result.currencies))
      .catch(() => {});
  }, []);

  const toggle = (name) => setPanel(panel === name ? null : name);

  return (
    <div className="screen">
      <BackBar title="Settings" onBack={() => go('home')} />
      <div className="scroll pad stack">
        {state.backup?.needed && <BackupSection refresh={refresh} onDone={() => setMessage('Recovery phrase confirmed.')} />}

        <section className="card">
          <h2>Security</h2>
          <AutoLockControls minutes={state.autoLockMinutes} refresh={refresh} />

          <div className="row2">
            <button className="ghost" onClick={() => toggle('password')} aria-expanded={panel === 'password'}>
              Change password
            </button>
            <button
              className="ghost"
              disabled={!state.hasRecoveryPhrase}
              title={state.hasRecoveryPhrase ? 'Reveal a recovery phrase' : 'This wallet was imported from a private key'}
              onClick={() => toggle('mnemonic')}
              aria-expanded={panel === 'mnemonic'}
            >
              Recovery phrase
            </button>
          </div>

          {!state.hasRecoveryPhrase && (
            <p className="small">
              This wallet was imported from a private key or keystore, so there is no recovery phrase to reveal.
            </p>
          )}

          {panel === 'password' && (
            <ChangePassword
              onDone={() => {
                setPanel(null);
                setMessage('Password changed. The vault was re-encrypted.');
              }}
            />
          )}

          {panel === 'mnemonic' && <RevealPhrase vaults={state.vaults ?? []} onClose={() => setPanel(null)} />}

          {message && <div className="ok">{message}</div>}
        </section>

        <VaultManager
          vaults={state.vaults ?? []}
          presets={state.derivationPresets ?? []}
          open={panel === 'vaults'}
          onToggle={() => toggle('vaults')}
          refresh={refresh}
        />

        <section className="card">
          <h2>Display</h2>

          <div className="field">
            <span>Theme</span>
            <div className="tabs" role="tablist" aria-label="Theme">
              {[
                ['dark', 'Dark'],
                ['light', 'Light'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={(state.theme ?? 'dark') === value}
                  onClick={async () => {
                    await call('SET_THEME', { theme: value });
                    refresh();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <span>Currency</span>
            <select
              value={state.currency ?? 'usd'}
              onChange={async (e) => {
                await call('SET_CURRENCY', { currency: e.target.value });
                refresh();
              }}
            >
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.label} ({currency.code.toUpperCase()})
                </option>
              ))}
            </select>
            <span className="small faint">Balances are converted using live CoinGecko rates.</span>
          </label>

          <label className="field">
            <span>Language</span>
            <select
              value={state.locale ?? 'en'}
              onChange={async (e) => {
                await call('SET_LOCALE', { locale: e.target.value });
                refresh();
              }}
            >
              {LOCALES.map((locale) => {
                const coverage = localeCoverage(locale.code);
                return (
                  <option key={locale.code} value={locale.code}>
                    {locale.native}
                    {locale.code === 'en' ? '' : ` — ${coverage.percent}% translated`}
                  </option>
                );
              })}
            </select>
            <span className="small faint">
              Untranslated strings fall back to English. Contributions go in <code>src/lib/i18n.js</code>.
            </span>
          </label>

          <label className="check-line">
            <input
              type="checkbox"
              checked={Boolean(state.showTestnets)}
              onChange={async (e) => {
                await call('SET_SHOW_TESTNETS', { value: e.target.checked });
                refresh();
              }}
            />
            Show test networks
          </label>

          <label className="check-line">
            <input
              type="checkbox"
              checked={state.ensAvatars !== false}
              onChange={async (e) => {
                await call('SET_ENS_AVATARS', { value: e.target.checked });
                refresh();
              }}
            />
            <span className="item-main">
              <span>Load ENS avatars</span>
              <span className="small faint">
                Avatar images are fetched from whatever host the name's owner chose. That host learns your IP address
                and when your wallet is open. Names still resolve either way.
              </span>
            </span>
          </label>
        </section>

        <ConnectedSites
          sites={state.sites}
          accounts={state.accounts}
          networks={state.allNetworks ?? state.networks}
          currentChainId={state.chainId}
          openPanel={panel}
          onToggle={toggle}
          refresh={refresh}
        />

        <NotificationSettings />

        <SmartAccountSettings state={state} />

        <PhishingProtection />

        <SignatureLog refresh={refresh} />

        <DappHistory
          history={state.connectionHistory ?? []}
          networks={state.allNetworks ?? state.networks}
          sites={state.sites}
          refresh={refresh}
        />

        <AddressBook contacts={state.contacts ?? []} refresh={refresh} />

        <EncryptedBackup refresh={refresh} />

        <section className="card">
          <div className="between">
            <h2>Accounting</h2>
            <button className="link accent" onClick={() => go('accounting')}>
              open
            </button>
          </div>
          <p className="small">
            Portfolio value over time, cost basis, and a per-disposal CSV for tax. Built only from what this wallet
            witnessed — it says how much of the picture is missing rather than filling the gaps in.
          </p>
        </section>

        <section className="card">
          <div className="between">
            <h2>Advanced</h2>
            <button className="link accent" onClick={() => go('advanced')}>
              open
            </button>
          </div>
          <p className="small">
            EIP-7702 delegation, air-gapped QR signing, splitting your recovery phrase into shares, and passkeys. Each
            changes how the wallet is controlled — read what each one says before using it.
          </p>
        </section>

        <section className="card">
          <h2>Not implemented yet</h2>
          <p className="small">
            These appear on the roadmap but have no working implementation. They are listed so the gap is visible
            rather than hidden behind a button that does nothing.
          </p>
          <ul className="small faint plain-list">
            <li>WalletConnect pairing</li>
            <li>Session keys and spending limits</li>
            <li>On-chain guardian recovery — splitting your phrase into shares is offered instead, under Advanced</li>
            <li>USB hardware wallet signing — air-gapped QR signing is offered instead, under Advanced</li>
            <li>Passkeys controlling an account — enrolment works, but no account can verify them yet</li>
            <li>Deploying a smart account — existing ones can be used, new ones cannot be created here</li>
          </ul>
        </section>

        <section className="card">
          <h2>Danger zone</h2>
          <p className="small">
            Erasing removes the encrypted vault, accounts, tokens, and activity from this browser. Only your recovery
            phrase can bring the accounts back.
          </p>
          {panel === 'wipe' ? (
            <div className="stack-sm">
              <div className="notice danger">
                This cannot be undone. Make sure your recovery phrase is written down first.
              </div>
              <div className="row2">
                <button className="ghost" onClick={() => setPanel(null)}>
                  Keep it
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    await call('WIPE');
                    refresh();
                  }}
                >
                  Erase everything
                </button>
              </div>
            </div>
          ) : (
            <button className="danger" onClick={() => setPanel('wipe')}>
              Erase wallet
            </button>
          )}
        </section>

        <div className="center small" style={{ color: 'var(--faint)' }}>
          ADRIX 0.2.0 · testnet use only
        </div>
      </div>

      <div className="footer">
        <button
          className="ghost"
          onClick={async () => {
            await call('LOCK');
            refresh();
          }}
        >
          Lock wallet
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backup reminder + verification
// ---------------------------------------------------------------------------
function BackupSection({ refresh, onDone }) {
  const [stage, setStage] = useState('prompt');
  const [phrase, setPhrase] = useState('');
  const [indices, setIndices] = useState([]);
  const [answers, setAnswers] = useState({});
  const { busy, error, setError, run } = useAsyncAction();

  const reveal = (password) =>
    run(async () => {
      const { mnemonic } = await call('REVEAL_VAULT_MNEMONIC', { id: null, password });
      setPhrase(mnemonic);
      const words = mnemonic.split(' ');
      const chosen = new Set();
      const random = new Uint32Array(8);
      crypto.getRandomValues(random);
      for (const value of random) {
        chosen.add(value % words.length);
        if (chosen.size === 3) break;
      }
      setIndices([...chosen].sort((a, b) => a - b));
      setStage('show');
    });

  const verify = () =>
    run(async () => {
      await call('VERIFY_BACKUP', { words: answers });
      await refresh();
      onDone();
    });

  return (
    <section className="card accent">
      <div className="between">
        <h2>Back up your recovery phrase</h2>
        <span className="badge failed">action needed</span>
      </div>

      {stage === 'prompt' && (
        <>
          <p className="small">
            This wallet's phrase has never been confirmed. If this browser profile is lost, so is the wallet. It takes
            a minute.
          </p>
          <PasswordPrompt cta="Reveal phrase" label="Confirm your password" onSubmit={reveal} />
        </>
      )}

      {stage === 'show' && (
        <>
          <div className="seed-grid">
            {phrase.split(' ').map((word, index) => (
              <div className="seed-word" key={index}>
                <b>{index + 1}</b>
                {word}
              </div>
            ))}
          </div>
          <div className="notice">Write these on paper. A screenshot ends up in a cloud backup.</div>
          <button className="primary" onClick={() => setStage('verify')}>
            I have written it down
          </button>
        </>
      )}

      {stage === 'verify' && (
        <>
          <p className="small">Enter these words to confirm.</p>
          {indices.map((index) => (
            <label className="field" key={index}>
              <span>Word {index + 1}</span>
              <input
                className="mono"
                value={answers[index] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [index]: e.target.value })}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck="false"
              />
            </label>
          ))}
          <div className="row2">
            <button className="ghost" onClick={() => setStage('show')}>
              Show phrase
            </button>
            <button className="primary" onClick={verify} disabled={busy || indices.length !== Object.keys(answers).length}>
              {busy ? 'Checking…' : 'Confirm backup'}
            </button>
          </div>
        </>
      )}

      {error && <div className="error" role="alert">{error}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recovery phrases (multiple vaults)
// ---------------------------------------------------------------------------
function VaultManager({ vaults, presets, open, onToggle, refresh }) {
  const [adding, setAdding] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [name, setName] = useState('');
  const [pathTemplate, setPathTemplate] = useState(presets[0]?.template ?? "m/44'/60'/0'/0/{index}");
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const add = () =>
    run(async () => {
      await call('ADD_VAULT', { mnemonic, name, pathTemplate });
      setMnemonic('');
      setName('');
      setAdding(false);
      await refresh();
    });

  return (
    <section className="card">
      <div className="between">
        <h2>Recovery phrases</h2>
        <button className="link" onClick={onToggle} aria-expanded={open}>
          {open ? 'close' : `manage (${vaults.length})`}
        </button>
      </div>

      {!open ? (
        <p className="small">
          {vaults.length === 0
            ? 'This wallet has no recovery phrase — every account came from an imported key.'
            : `${vaults.length} phrase${vaults.length === 1 ? '' : 's'} in this install.`}
        </p>
      ) : (
        <div className="stack-sm">
          {vaults.map((vault) => (
            <div className="site-row" key={vault.id}>
              <div className="item static">
                <div className="item-main">
                  <span className="item-title">{vault.name}</span>
                  <span className="item-sub">
                    {vault.accountCount} account{vault.accountCount === 1 ? '' : 's'} · {vault.pathTemplate}
                  </span>
                </div>
                <div className="item-right">
                  <button
                    className="link"
                    onClick={() => {
                      setRenaming(renaming === vault.id ? null : vault.id);
                      setRenameValue(vault.name);
                    }}
                  >
                    rename
                  </button>
                  {vaults.length > 1 && (
                    <button className="link" onClick={() => setConfirmRemove(vault.id)}>
                      remove
                    </button>
                  )}
                </div>
              </div>

              {renaming === vault.id && (
                <div className="site-panel">
                  <div className="input-group">
                    <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={40} />
                    <button
                      className="ghost"
                      onClick={() =>
                        run(async () => {
                          await call('RENAME_VAULT', { id: vault.id, name: renameValue });
                          setRenaming(null);
                          await refresh();
                        })
                      }
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}

              {confirmRemove === vault.id && (
                <div className="site-panel stack-sm">
                  <div className="notice danger">
                    Removing this phrase deletes its {vault.accountCount} account
                    {vault.accountCount === 1 ? '' : 's'} from ADRIX. Anything held there is only reachable by
                    re-importing the phrase.
                  </div>
                  <div className="row2">
                    <button className="ghost" onClick={() => setConfirmRemove(null)}>
                      Keep it
                    </button>
                    <button
                      className="danger"
                      onClick={() =>
                        run(async () => {
                          await call('REMOVE_VAULT', { id: vault.id });
                          setConfirmRemove(null);
                          await refresh();
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {adding ? (
            <div className="site-panel stack-sm">
              <label className="field">
                <span>Recovery phrase</span>
                <textarea
                  value={mnemonic}
                  onChange={(e) => setMnemonic(e.target.value)}
                  spellCheck="false"
                  autoCapitalize="none"
                  rows={3}
                  placeholder="12 or 24 words"
                />
              </label>
              <label className="field">
                <span>Label (optional)</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hardware backup, old wallet…" />
              </label>
              <label className="field">
                <span>Derivation path</span>
                <select value={pathTemplate} onChange={(e) => setPathTemplate(e.target.value)}>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.template}>
                      {preset.label} — {preset.template}
                    </option>
                  ))}
                </select>
              </label>
              {error && <div className="error" role="alert">{error}</div>}
              <div className="row2">
                <button
                  className="ghost"
                  onClick={() => {
                    setAdding(false);
                    setError('');
                  }}
                >
                  Cancel
                </button>
                <button className="primary" onClick={add} disabled={busy || !mnemonic.trim()}>
                  {busy ? 'Adding…' : 'Add phrase'}
                </button>
              </div>
            </div>
          ) : (
            <button className="ghost" onClick={() => setAdding(true)}>
              Add another recovery phrase
            </button>
          )}

          {error && !adding && <div className="error" role="alert">{error}</div>}
        </div>
      )}
    </section>
  );
}

function RevealPhrase({ vaults, onClose }) {
  const [selected, setSelected] = useState(vaults[0]?.id ?? null);
  const [phrase, setPhrase] = useState('');

  if (phrase) {
    return (
      <div className="stack-sm">
        <div className="data-block">{phrase}</div>
        <div className="notice danger">Anyone with these words owns every account derived from them.</div>
        <button
          className="ghost"
          onClick={() => {
            setPhrase('');
            onClose();
          }}
        >
          Hide
        </button>
      </div>
    );
  }

  return (
    <div className="stack-sm">
      {vaults.length > 1 && (
        <label className="field">
          <span>Which phrase</span>
          <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {vaults.map((vault) => (
              <option key={vault.id} value={vault.id}>
                {vault.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <PasswordPrompt
        cta="Reveal phrase"
        onCancel={onClose}
        onSubmit={async (password) => {
          const result = await call('REVEAL_VAULT_MNEMONIC', { id: selected, password });
          setPhrase(result.mnemonic);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
function AutoLockControls({ minutes, refresh }) {
  const [custom, setCustom] = useState(minutes > 0 ? String(minutes) : '');
  const [error, setError] = useState('');

  const setMinutes = async (next) => {
    await call('SET_AUTOLOCK', { minutes: next });
    await refresh();
    if (next > 0) setCustom(String(next));
  };

  return (
    <div className="stack-sm">
      <div className="between">
        <span className="small">Auto-lock timer</span>
        <span className="mono small">{minutes > 0 ? `${minutes} min` : 'Off'}</span>
      </div>
      <div className="lock-grid">
        {[1, 5, 15, 60].map((value) => (
          <button className="ghost" key={value} aria-pressed={minutes === value} onClick={() => setMinutes(value)}>
            {value === 60 ? '1 hr' : `${value}m`}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Custom minutes</span>
        <div className="input-group">
          <input
            className="mono"
            inputMode="numeric"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="15"
          />
          <button
            className="ghost"
            onClick={() => {
              const parsed = Number(custom);
              if (!Number.isInteger(parsed) || parsed <= 0) {
                setError('Enter a whole number of minutes above zero.');
                return;
              }
              setError('');
              setMinutes(parsed);
            }}
          >
            Set
          </button>
        </div>
      </label>
      {error && <div className="error">{error}</div>}
      <button className="ghost" onClick={() => setMinutes(0)} aria-pressed={minutes === 0}>
        Disable auto-lock
      </button>
      <p className="small faint">
        The wallet still locks when the browser closes — decrypted keys live in session storage, which never touches
        disk.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
function AddressBook({ contacts, refresh }) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [importReport, setImportReport] = useState(null);
  const fileRef = useRef(null);
  const { error, setError, run } = useAsyncAction();

  const labels = [...new Set(contacts.map((c) => c.label).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  const needle = query.trim().toLowerCase();
  const visible = contacts.filter((contact) => {
    if (labelFilter && contact.label !== labelFilter) return false;
    if (!needle) return true;
    return [contact.name, contact.address, contact.label, contact.ens]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  const exportBook = () =>
    run(async () => {
      const payload = await call('EXPORT_CONTACTS');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `adrix-contacts-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  const importBook = (file) =>
    run(async () => {
      if (!file) return;
      setImportReport(null);
      const report = await call('IMPORT_CONTACTS', { payload: await file.text() });
      setImportReport(report);
      await refresh();
    });

  return (
    <section className="card">
      <div className="between">
        <h2>Address book</h2>
        <button className="link" onClick={() => setAdding(!adding)} aria-expanded={adding}>
          {adding ? 'close' : 'add contact'}
        </button>
      </div>

      {adding && (
        <ContactForm
          cta="Save contact"
          onCancel={() => setAdding(false)}
          onSubmit={async (contact) => {
            await call('ADD_CONTACT', { contact });
            await refresh();
            setAdding(false);
          }}
        />
      )}

      {contacts.length > 4 && (
        <label className="field">
          <span>Search contacts</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, label, ENS, or address"
            type="search"
          />
        </label>
      )}

      {labels.length > 0 && (
        <div className="inline wrap">
          <button
            className={`chip ${labelFilter === '' ? 'accent' : ''}`}
            onClick={() => setLabelFilter('')}
            aria-pressed={labelFilter === ''}
          >
            All ({contacts.length})
          </button>
          {labels.map((label) => (
            <button
              key={label}
              className={`chip ${labelFilter === label ? 'accent' : ''}`}
              onClick={() => setLabelFilter(labelFilter === label ? '' : label)}
              aria-pressed={labelFilter === label}
            >
              {label} ({contacts.filter((c) => c.label === label).length})
            </button>
          ))}
        </div>
      )}

      {!contacts.length && !adding ? (
        <p className="small">Save trusted recipients here so you never have to paste an address twice.</p>
      ) : !visible.length ? (
        <p className="small faint">No contact matches that filter.</p>
      ) : (
        <div className="list">
          {visible.map((contact) => (
            <ContactRow key={contact.id} contact={contact} refresh={refresh} />
          ))}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        onChange={(e) => {
          importBook(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className="row2">
        <button className="ghost" onClick={() => fileRef.current?.click()}>
          Import
        </button>
        <button className="ghost" onClick={exportBook} disabled={!contacts.length}>
          Export
        </button>
      </div>

      {importReport && (
        <div className={importReport.added ? 'ok' : 'notice'}>
          Imported {importReport.added} of {importReport.total}.
          {importReport.skipped.length > 0 && (
            <>
              {' '}
              Skipped {importReport.skipped.length}:{' '}
              {importReport.skipped
                .slice(0, 3)
                .map((row) => `${row.name} (${row.reason})`)
                .join('; ')}
              {importReport.skipped.length > 3 ? '…' : ''}
            </>
          )}
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </section>
  );
}

function ContactRow({ contact, refresh }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  if (editing) {
    return (
      <div className="site-panel stack-sm">
        <ContactForm
          contact={contact}
          cta="Update"
          onCancel={() => {
            setError('');
            setEditing(false);
          }}
          onSubmit={async (next) => {
            setError('');
            try {
              await call('UPDATE_CONTACT', { contact: { ...next, id: contact.id } });
              await refresh();
              setEditing(false);
            } catch (err) {
              setError(err.message);
            }
          }}
        />
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="item static">
      <Avatar address={contact.address} size="lg" />
      <div className="item-main">
        <span className="item-title">
          {contact.favorite ? '★ ' : ''}
          {contact.name}
        </span>
        <span className="item-sub">{contact.ens ?? shorten(contact.address, 10, 8)}</span>
        <span className="inline wrap" style={{ marginTop: 2 }}>
          {contact.label && <span className="badge">{contact.label}</span>}
          {contact.useCount > 0 && (
            <span className="small faint">
              sent {contact.useCount}× · last {timeAgo(contact.lastUsedAt)}
            </span>
          )}
        </span>
      </div>
      <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
        <button
          className={contact.favorite ? 'link accent' : 'link'}
          title={contact.favorite ? 'Remove from favourites' : 'Mark as favourite'}
          aria-pressed={contact.favorite}
          onClick={async () => {
            await call('TOGGLE_CONTACT_FAVORITE', { id: contact.id });
            await refresh();
          }}
        >
          {contact.favorite ? '★ favourite' : '☆ favourite'}
        </button>
        <span className="inline">
          <button className="link" onClick={() => setEditing(true)}>
            edit
          </button>
          <button
            className="link"
            onClick={async () => {
              await call('REMOVE_CONTACT', { id: contact.id });
              await refresh();
            }}
          >
            remove
          </button>
        </span>
      </div>
    </div>
  );
}

function ContactForm({ contact = {}, cta, onCancel, onSubmit }) {
  const [name, setName] = useState(contact.name ?? '');
  const [address, setAddress] = useState(contact.address ?? '');
  const [label, setLabel] = useState(contact.label ?? '');
  const [favorite, setFavorite] = useState(Boolean(contact.favorite));
  const { busy, error, run } = useAsyncAction();

  return (
    <div className="stack-sm">
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <label className="field">
        <span>Address or ENS name</span>
        <input
          className="mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck="false"
          placeholder="0x… or name.eth"
        />
        <span className="small faint">ENS names are resolved and stored as an address.</span>
      </label>
      <label className="field">
        <span>Label (optional)</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Exchange, friend, cold wallet"
          list="contact-labels"
          maxLength={40}
        />
        <datalist id="contact-labels">
          {['Exchange', 'Friend', 'Cold wallet', 'Team', 'Client', 'DeFi'].map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        <span className="small faint">Labels group contacts into filter chips in the address book.</span>
      </label>
      <label className="check-line">
        <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
        Favourite recipient
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row2">
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="primary"
          onClick={() => run(() => onSubmit({ name, address, label, favorite }))}
          disabled={busy || !name || !address}
        >
          {busy ? 'Saving…' : cta}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * Per-site permissions. Each row shows what the site can currently reach and,
 * once expanded, what it has actually done with that access.
 */
function ConnectedSites({ sites, accounts, networks, currentChainId, openPanel, onToggle, refresh }) {
  const [confirmAll, setConfirmAll] = useState(false);
  const { busy, error, run } = useAsyncAction();

  return (
    <section className="card">
      <div className="between">
        <h2>Connected sites</h2>
        {sites.length > 1 && (
          <button className="link" onClick={() => setConfirmAll(!confirmAll)}>
            {confirmAll ? 'cancel' : 'disconnect all'}
          </button>
        )}
      </div>

      {confirmAll && (
        <div className="stack-sm">
          <div className="notice danger">
            This revokes access for all {sites.length} sites. They will each have to ask again.
          </div>
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await call('DISCONNECT_ALL_SITES');
                await refresh();
                setConfirmAll(false);
              })
            }
          >
            {busy ? 'Disconnecting…' : `Disconnect all ${sites.length}`}
          </button>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      {sites.length === 0 ? (
        <p className="small">No sites are connected. Open a dApp and use its connect button.</p>
      ) : (
        <div className="list">
          {sites.map((site) => (
            <ConnectedSite
              key={site.origin}
              site={site}
              accounts={accounts}
              networks={networks}
              currentChainId={currentChainId}
              open={openPanel === `site:${site.origin}`}
              onToggle={() => onToggle(`site:${site.origin}`)}
              refresh={refresh}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** What a site has actually done, pulled on demand when its row is opened. */
function SiteActivity({ origin }) {
  const [activity, setActivity] = useState(null);

  useEffect(() => {
    let cancelled = false;
    call('GET_SITE_ACTIVITY', { origin })
      .then((result) => !cancelled && setActivity(result))
      .catch(() => !cancelled && setActivity(null));
    return () => {
      cancelled = true;
    };
  }, [origin]);

  if (!activity) return <p className="small faint">Loading activity…</p>;
  if (!activity.entries.length) return <p className="small faint">No recorded activity for this site yet.</p>;

  return (
    <div className="stat-grid">
      <div className="stat">
        <span className="stat-value">{activity.transactions}</span>
        <span className="stat-label">Transactions requested</span>
      </div>
      <div className="stat">
        {/* Signing is normal activity, not a fault — highlight it for auditing
            without colouring it as an error. */}
        <span className={`stat-value ${activity.signatures > 0 ? 'accent' : ''}`}>{activity.signatures}</span>
        <span className="stat-label">Signatures requested</span>
      </div>
      <div className="stat">
        <span className="stat-value" style={{ fontSize: 12 }}>
          {activity.firstSeen ? timeAgo(activity.firstSeen) : '--'}
        </span>
        <span className="stat-label">First seen</span>
      </div>
      <div className="stat">
        <span className="stat-value" style={{ fontSize: 12 }}>
          {activity.lastSeen ? timeAgo(activity.lastSeen) : '--'}
        </span>
        <span className="stat-label">Last active</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ConnectedSite({ site, accounts, networks, currentChainId, open, onToggle, refresh }) {
  const [selected, setSelected] = useState(site.accounts);
  const [selectedNetworks, setSelectedNetworks] = useState(site.networks ?? []);
  const { error, run } = useAsyncAction();
  const siteLabel = site.origin.replace(/^https?:\/\//, '');
  const networkList = Object.values(networks);
  // A site granted only other chains is connected but functionally blind right
  // now, which is confusing unless it is stated outright.
  const onCurrentNetwork = (site.networks ?? []).some(
    (chainId) => chainId.toLowerCase() === currentChainId.toLowerCase()
  );
  const currentNetworkName = networks[currentChainId]?.name ?? currentChainId;

  useEffect(() => {
    setSelected(site.accounts);
    setSelectedNetworks(site.networks ?? []);
  }, [site.accounts, site.networks]);

  const toggleAccount = (address) =>
    setSelected((current) =>
      current.some((item) => item.toLowerCase() === address.toLowerCase())
        ? current.filter((item) => item.toLowerCase() !== address.toLowerCase())
        : [...current, address]
    );

  const toggleNetwork = (chainId) =>
    setSelectedNetworks((current) =>
      current.includes(chainId) ? current.filter((item) => item !== chainId) : [...current, chainId]
    );

  return (
    <div className="site-row">
      <button className="item" onClick={onToggle} aria-expanded={open}>
        <div className="item-main">
          <span className="item-title">{siteLabel}</span>
          <span className="item-sub">
            {site.accounts.length} account{site.accounts.length === 1 ? '' : 's'} · {site.networks?.length ?? 0} network
            {site.networks?.length === 1 ? '' : 's'}
          </span>
          <span className="item-sub">
            {site.lastActiveAt ? `active ${timeAgo(site.lastActiveAt)}` : 'never used'}
            {site.connectedAt ? ` · added ${timeAgo(site.connectedAt)}` : ''}
          </span>
          {!onCurrentNetwork && (
            <span className="badge pending" style={{ marginTop: 4, alignSelf: 'flex-start' }}>
              blocked on this network
            </span>
          )}
        </div>
        <span className="link">{open ? 'close' : 'manage'}</span>
      </button>

      {open && (
        <div className="site-panel stack-sm">
          {!onCurrentNetwork && (
            <div className="notice">
              This site is not permitted on {currentNetworkName}. It sees no accounts until you tick that network
              below or switch the wallet to one it is allowed on.
            </div>
          )}

          <div className="eyebrow">Activity</div>
          <SiteActivity origin={site.origin} />

          <div className="eyebrow">Accounts</div>
          <p className="small faint">
            The site sees only what is ticked here, and reads the first as its active account.
          </p>
          {accounts.map((account) => (
            <button className="item compact" key={account.address} onClick={() => toggleAccount(account.address)}>
              <input
                type="checkbox"
                readOnly
                checked={selected.some((address) => address.toLowerCase() === account.address.toLowerCase())}
              />
              <Avatar address={account.address} />
              <div className="item-main">
                <span className="item-title">{account.name}</span>
                <span className="item-sub">{shorten(account.address, 10, 8)}</span>
              </div>
            </button>
          ))}

          <div className="eyebrow">Networks</div>
          {networkList.map((network) => (
            <button className="item compact" key={network.chainId} onClick={() => toggleNetwork(network.chainId)}>
              <input type="checkbox" readOnly checked={selectedNetworks.includes(network.chainId)} />
              <span
                className="dot"
                style={{ background: network.chainId === currentChainId ? 'var(--accent)' : 'var(--line-strong)' }}
              />
              <div className="item-main">
                <span className="item-title">
                  {network.name}
                  {network.chainId === currentChainId ? ' · current' : ''}
                </span>
                <span className="item-sub">
                  {network.chainId} · {network.symbol}
                </span>
              </div>
            </button>
          ))}

          {!selectedNetworks.length && (
            <div className="notice">At least one network must stay ticked, or the site cannot connect at all.</div>
          )}
          {error && <div className="error" role="alert">{error}</div>}
          <div className="row2">
            <button
              className="danger"
              onClick={() =>
                run(async () => {
                  await call('DISCONNECT_SITE', { origin: site.origin });
                  await refresh();
                  onToggle();
                })
              }
            >
              Disconnect
            </button>
            <button
              className="primary"
              disabled={!selected.length || !selectedNetworks.length}
              onClick={() =>
                run(async () => {
                  await call('UPDATE_SITE_ACCOUNTS', { origin: site.origin, accounts: selected });
                  await call('UPDATE_SITE_NETWORKS', { origin: site.origin, networks: selectedNetworks });
                  await refresh();
                  onToggle();
                })
              }
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * Notification preferences.
 *
 * Outgoing notifications came free — the wallet knows what it sent. Incoming
 * ones are a poller over `eth_getLogs` against whatever endpoint is configured,
 * which has real limits, so this states them rather than letting a user wonder
 * why a transfer on another chain went unannounced.
 */
function NotificationSettings() {
  const [status, setStatus] = useState(null);
  const { busy, run } = useAsyncAction();

  const load = async () => setStatus(await call('NOTIFICATION_PREFS'));

  useEffect(() => {
    load().catch(() => {});
  }, []);

  const update = (patch) =>
    run(async () => {
      await call('SET_NOTIFICATION_PREFS', { prefs: patch });
      await load();
    });

  const prefs = status?.prefs;

  return (
    <section className="card">
      <h2>Notifications</h2>

      <label className="check-line">
        <input
          type="checkbox"
          checked={Boolean(prefs?.enabled)}
          onChange={(e) => update({ enabled: e.target.checked })}
          disabled={busy || !prefs}
        />
        <span className="item-main">
          <span>Desktop notifications</span>
          <span className="small faint">Shown by the browser, even when the popup is closed.</span>
        </span>
      </label>

      {prefs?.enabled && (
        <>
          <label className="check-line">
            <input
              type="checkbox"
              checked={Boolean(prefs.outgoing)}
              onChange={(e) => update({ outgoing: e.target.checked })}
              disabled={busy}
            />
            <span className="item-main">
              <span>Transactions you send</span>
              <span className="small faint">When one is submitted and again when it settles.</span>
            </span>
          </label>

          <label className="check-line">
            <input
              type="checkbox"
              checked={Boolean(prefs.incoming)}
              onChange={(e) => update({ incoming: e.target.checked })}
              disabled={busy}
            />
            <span className="item-main">
              <span>Funds arriving</span>
              <span className="small faint">
                Found by polling for transfer logs once a minute. ADRIX has no indexer, so this covers the selected
                network only, and a rate-limited endpoint will delay it.
              </span>
            </span>
          </label>

          {prefs.incoming && (
            <label className="check-line">
              <input
                type="checkbox"
                checked={Boolean(prefs.ignoreSpam)}
                onChange={(e) => update({ ignoreSpam: e.target.checked })}
                disabled={busy}
              />
              <span className="item-main">
                <span>Ignore untracked and spam tokens</span>
                <span className="small faint">
                  Airdropped junk arrives constantly. Without this, notifications become unreadable and get turned off.
                </span>
              </span>
            </label>
          )}

          {status?.watching > 0 && (
            <p className="small faint">
              Watching {status.watching} account/network pair{status.watching === 1 ? '' : 's'}
              {status.lastCheckedAt ? ` · last checked ${timeAgo(status.lastCheckedAt)}` : ''}.
            </p>
          )}

          <div className="row2">
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await call('POLL_INCOMING');
                  await load();
                })
              }
            >
              Check now
            </button>
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await call('RESET_WATCH');
                  await load();
                })
              }
              title="Forget where the scan had reached"
            >
              Reset watermark
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Bundler and paymaster configuration.
 *
 * A user operation cannot be submitted without a bundler, and bundlers are
 * third-party infrastructure. Public keyless ones are offered as defaults so
 * the feature works out of the box, with the trade-off stated.
 */
function SmartAccountSettings({ state }) {
  const [config, setConfig] = useState(null);
  const [bundlerUrl, setBundlerUrl] = useState('');
  const [paymasterUrl, setPaymasterUrl] = useState('');
  const [test, setTest] = useState(null);
  const [open, setOpen] = useState(false);
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => {
    const next = await call('AA_CONFIG', { chainId: state.chainId });
    setConfig(next);
    setBundlerUrl(next.bundlerUrl);
    setPaymasterUrl(next.paymasterUrl);
  };

  useEffect(() => {
    load().catch(() => {});
    setTest(null);
  }, [state.chainId]);

  return (
    <section className="card">
      <div className="between">
        <h2>Smart accounts</h2>
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'close' : 'configure'}
        </button>
      </div>

      <p className="small">
        ERC-4337 accounts submit user operations through a bundler rather than sending transactions directly. One is
        required per network.
      </p>

      {config && (
        <div className="kv">
          <span className="kv-key">{state.network?.name}</span>
          <span className="kv-value mono small">
            {config.bundlerUrl ? new URL(config.bundlerUrl).host : 'not configured'}
            {config.isDefault ? ' (public default)' : ''}
          </span>
        </div>
      )}

      {open && (
        <div className="stack-sm">
          <label className="field">
            <span>Bundler URL</span>
            <input
              className="mono"
              value={bundlerUrl}
              onChange={(e) => {
                setBundlerUrl(e.target.value);
                setTest(null);
                setError('');
              }}
              placeholder="https://…"
              spellCheck="false"
            />
            <span className="small faint">
              {config?.hasDefault
                ? 'Leave empty to use the public default. Public bundlers are rate limited and see every operation you submit.'
                : 'No public default for this network — a bundler URL is required.'}
            </span>
          </label>

          <label className="field">
            <span>Paymaster URL (optional)</span>
            <input
              className="mono"
              value={paymasterUrl}
              onChange={(e) => {
                setPaymasterUrl(e.target.value);
                setError('');
              }}
              placeholder="https://…"
              spellCheck="false"
            />
            <span className="small faint">
              An ERC-7677 endpoint that can sponsor gas. Sponsorship is always requested, never assumed — a refusal
              just means the operation pays for itself.
            </span>
          </label>

          {test && (
            <div className="ok">
              Reachable. EntryPoint v0.7 {test.supportsV07 ? 'supported' : 'NOT supported'}
              {test.supportsV06 ? ', v0.6 also offered' : ''}.
              {!test.supportsV07 && ' ADRIX only implements v0.7, so this bundler cannot be used.'}
            </div>
          )}
          {error && <div className="error" role="alert">{error}</div>}

          <div className="row2">
            <button
              className="ghost"
              disabled={busy || !bundlerUrl.trim()}
              onClick={() =>
                run(async () => {
                  setTest(await call('AA_TEST_BUNDLER', { url: bundlerUrl, chainId: state.chainId }));
                })
              }
            >
              {busy ? 'Testing…' : 'Test bundler'}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await call('AA_SET_CONFIG', { chainId: state.chainId, bundlerUrl, paymasterUrl });
                  await load();
                  setOpen(false);
                })
              }
            >
              Save
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
const KNOWN_FEEDS = [
  {
    name: 'MetaMask eth-phishing-detect',
    url: 'https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/master/src/config.json',
    hint: 'The list most Ethereum wallets use. Tens of thousands of domains, updated continuously.',
  },
];

/**
 * Phishing and malicious-address protection.
 *
 * ADRIX detects impersonation on its own — a domain one character off
 * uniswap.org is catchable without knowing that specific domain in advance,
 * which is the fundamental weakness of blocklists. A community feed covers the
 * rest, opt-in and with its source visible, because a stale list baked into the
 * extension would be worse than an honest empty one.
 */
function PhishingProtection() {
  const [lists, setLists] = useState(null);
  const [url, setUrl] = useState('');
  const [entry, setEntry] = useState('');
  const [kind, setKind] = useState('domain');
  const [open, setOpen] = useState(false);
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => setLists(await call('GET_SECURITY_LISTS'));

  useEffect(() => {
    load().catch(() => {});
  }, []);

  const act = (type, payload) =>
    run(async () => {
      await call(type, payload);
      await load();
    });

  const total =
    (lists?.blockedDomains.length ?? 0) + (lists?.allowedDomains.length ?? 0) + (lists?.blockedAddresses.length ?? 0);
  const feedEntries = lists?.feeds.reduce((sum, feed) => sum + feed.blocklistCount, 0) ?? 0;

  return (
    <section className="card">
      <div className="between">
        <h2>Phishing protection</h2>
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'close' : 'manage'}
        </button>
      </div>

      <p className="small">
        Every site that asks to connect or sign is checked for impersonation — character swaps, added hyphens, wrong
        TLDs, and Unicode lookalikes of {'≈'}70 well-known dApps and explorers. Contracts are checked for being
        deployed in the last day, which is the shape almost every drainer has.
      </p>

      <div className="stat-grid">
        <div className="stat">
          <span className="stat-value">{feedEntries.toLocaleString()}</span>
          <span className="stat-label">Feed domains</span>
        </div>
        <div className="stat">
          <span className="stat-value">{lists?.blockedDomains.length ?? 0}</span>
          <span className="stat-label">You blocked</span>
        </div>
        <div className="stat">
          <span className="stat-value">{lists?.allowedDomains.length ?? 0}</span>
          <span className="stat-label">You trusted</span>
        </div>
        <div className="stat">
          <span className="stat-value">{lists?.blockedAddresses.length ?? 0}</span>
          <span className="stat-label">Blocked addresses</span>
        </div>
      </div>

      {!lists?.feeds.length && (
        <div className="notice">
          No community feed imported. Impersonation detection works without one, but a feed adds the domains already
          known to be malicious.
        </div>
      )}

      {open && (
        <div className="stack-sm">
          <div className="eyebrow">Community feeds</div>
          {lists?.feeds.map((feed) => (
            <div className="item static" key={feed.url}>
              <div className="item-main">
                <span className="item-title">{feed.name}</span>
                <span className="item-sub">
                  {feed.blocklistCount.toLocaleString()} blocked · {feed.allowlistCount.toLocaleString()} allowed
                </span>
                <span className="item-sub faint">updated {timeAgo(feed.fetchedAt)}</span>
              </div>
              <div className="item-right">
                <button
                  className="link accent"
                  disabled={busy}
                  onClick={() => act('IMPORT_SECURITY_FEED', { url: feed.url, name: feed.name })}
                >
                  refresh
                </button>
                <button className="link" disabled={busy} onClick={() => act('REMOVE_SECURITY_FEED', { url: feed.url })}>
                  remove
                </button>
              </div>
            </div>
          ))}

          {KNOWN_FEEDS.filter((known) => !lists?.feeds.some((feed) => feed.url === known.url)).map((known) => (
            <div className="item static" key={known.url}>
              <div className="item-main">
                <span className="item-title">{known.name}</span>
                <span className="item-sub">{known.hint}</span>
              </div>
              <button
                className="link accent"
                disabled={busy}
                onClick={() => act('IMPORT_SECURITY_FEED', { url: known.url, name: known.name })}
              >
                {busy ? 'importing…' : 'import'}
              </button>
            </div>
          ))}

          <label className="field">
            <span>Custom feed URL</span>
            <div className="input-group">
              <input
                className="mono"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError('');
                }}
                placeholder="https://…/config.json"
                spellCheck="false"
              />
              <button
                className="ghost"
                disabled={busy || !url.trim()}
                onClick={() =>
                  run(async () => {
                    await call('IMPORT_SECURITY_FEED', { url });
                    setUrl('');
                    await load();
                  })
                }
              >
                Add
              </button>
            </div>
            <span className="small faint">
              eth-phishing-detect format, or a plain JSON array of hostnames. Must be https.
            </span>
          </label>

          <div className="eyebrow">Your own entries</div>
          <div className="input-group">
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 120 }}>
              <option value="domain">Block site</option>
              <option value="allow">Trust site</option>
              <option value="address">Block address</option>
            </select>
            <input
              className="mono"
              value={entry}
              onChange={(e) => {
                setEntry(e.target.value);
                setError('');
              }}
              placeholder={kind === 'address' ? '0x…' : 'example.com'}
              spellCheck="false"
            />
            <button
              className="ghost"
              disabled={busy || !entry.trim()}
              onClick={() =>
                run(async () => {
                  await call('ADD_SECURITY_ENTRY', { kind, value: entry });
                  setEntry('');
                  await load();
                })
              }
            >
              Add
            </button>
          </div>
          <p className="small faint">
            Trusting a site overrides every other check for it. ADRIX will get some of this wrong in both directions,
            and you should have the last word.
          </p>

          {total > 0 && (
            <div className="list">
              {[
                ['domain', lists.blockedDomains, 'blocked'],
                ['allow', lists.allowedDomains, 'trusted'],
                ['address', lists.blockedAddresses, 'blocked address'],
              ].flatMap(([entryKind, values, label]) =>
                values.map((value) => (
                  <div className="item static compact" key={`${entryKind}:${value}`}>
                    <div className="item-main">
                      <span className="item-title mono small">{value}</span>
                      <span className="item-sub">{label}</span>
                    </div>
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => act('REMOVE_SECURITY_ENTRY', { kind: entryKind, value })}
                    >
                      remove
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {error && <div className="error" role="alert">{error}</div>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
/**
 * Encrypted backup of everything the recovery phrase cannot restore.
 *
 * Restoring a wallet from its phrase brings back the accounts and nothing else:
 * no contact names, no custom networks, no tracked tokens, no transaction
 * notes. This is the file that brings those back — and deliberately holds no
 * key material, because a phrase in a file is a phrase that can be attacked
 * offline forever.
 */
function EncryptedBackup({ refresh }) {
  const [mode, setMode] = useState(null); // null | 'export' | 'import'
  const [sections, setSections] = useState([]);
  const [chosen, setChosen] = useState({});
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [report, setReport] = useState(null);
  const fileRef = useRef(null);
  const { busy, error, setError, run } = useAsyncAction();

  useEffect(() => {
    call('GET_BACKUP_SECTIONS')
      .then((result) => {
        setSections(result.sections);
        setChosen(Object.fromEntries(result.sections.map((s) => [s.key, !s.sensitive])));
      })
      .catch(() => {});
  }, []);

  const reset = () => {
    setMode(null);
    setPassword('');
    setConfirm('');
    setFile(null);
    setPreview(null);
    setError('');
  };

  const doExport = () =>
    run(async () => {
      if (password.length < 8) throw new Error('Use a backup password of at least 8 characters.');
      if (password !== confirm) throw new Error('The two passwords do not match.');

      const payload = await call('EXPORT_BACKUP', { password, sections: chosen });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `adrix-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      reset();
      setReport({ exported: true });
    });

  const doPreview = () =>
    run(async () => {
      setPreview(await call('PREVIEW_BACKUP', { password, file }));
    });

  const doRestore = () =>
    run(async () => {
      const result = await call('RESTORE_BACKUP', { password, file, sections: chosen });
      setReport(result.report);
      setPreview(null);
      setMode(null);
      await refresh();
    });

  const toggle = (key) => setChosen((current) => ({ ...current, [key]: !current[key] }));

  return (
    <section className="card">
      <div className="between">
        <h2>Encrypted backup</h2>
        {mode && (
          <button className="link" onClick={reset}>
            close
          </button>
        )}
      </div>

      {!mode && (
        <>
          <p className="small">
            Your recovery phrase restores the accounts. It does not restore your address book, account names, custom
            networks, tracked tokens, or transaction notes — this file does.
          </p>
          <div className="notice">
            <b>No keys are in this file.</b> Not the recovery phrase, not any private key. A phrase written to a file
            can be copied once and attacked offline forever, at whatever password you chose that day. Keep backing the
            phrase up on paper.
          </div>
          {report?.exported && <div className="ok">Backup downloaded.</div>}
          {report && !report.exported && <RestoreReport report={report} />}
          <div className="row2">
            <button className="ghost" onClick={() => setMode('export')}>
              Create backup
            </button>
            <button className="ghost" onClick={() => setMode('import')}>
              Restore backup
            </button>
          </div>
        </>
      )}

      {mode === 'export' && (
        <div className="stack-sm">
          <div className="eyebrow">What to include</div>
          {sections.map((section) => (
            <label className="check-line" key={section.key}>
              <input type="checkbox" checked={Boolean(chosen[section.key])} onChange={() => toggle(section.key)} />
              <span className="item-main">
                <span>
                  {section.label}
                  {section.sensitive && <span className="badge failed" style={{ marginLeft: 6 }}>sensitive</span>}
                </span>
                <span className="small faint">{section.hint}</span>
              </span>
            </label>
          ))}

          {chosen.sites && (
            <div className="notice danger">
              Site permissions in a backup re-authorise those dApps on restore, without them asking again. Include this
              only if the backup will never leave your own machine.
            </div>
          )}

          <label className="field">
            <span>Backup password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <span className="small faint">
              Independent of your wallet password. There is no recovery for this one either — if you lose it the file
              is unreadable.
            </span>
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>

          {error && <div className="error" role="alert">{error}</div>}
          <button className="primary" onClick={doExport} disabled={busy || password.length < 8}>
            {busy ? 'Encrypting…' : 'Download backup'}
          </button>
        </div>
      )}

      {mode === 'import' && (
        <div className="stack-sm">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            onChange={async (e) => {
              const chosenFile = e.target.files?.[0];
              e.target.value = '';
              if (!chosenFile) return;
              setPreview(null);
              setError('');
              setFile(await chosenFile.text());
            }}
          />
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            {file ? 'Choose a different file' : 'Choose backup file'}
          </button>

          {file && !preview && (
            <>
              <label className="field">
                <span>Backup password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && password && doPreview()}
                  autoComplete="off"
                />
              </label>
              {error && <div className="error" role="alert">{error}</div>}
              <button className="ghost" onClick={doPreview} disabled={busy || !password}>
                {busy ? 'Decrypting…' : 'Open backup'}
              </button>
            </>
          )}

          {preview && (
            <>
              <div className="card">
                <div className="between">
                  <span className="eyebrow">Backup contents</span>
                  <span className="small faint">
                    {preview.createdAt ? formatDateTime(preview.createdAt) : 'unknown date'}
                  </span>
                </div>
                {Object.entries(preview.summary)
                  .filter(([, count]) => count > 0)
                  .map(([key, count]) => (
                    <div className="kv" key={key}>
                      <span className="kv-key">{key}</span>
                      <span className="kv-value">{count}</span>
                    </div>
                  ))}
                <span className="small faint">Written by ADRIX {preview.appVersion}.</span>
              </div>

              <div className="eyebrow">What to restore</div>
              {sections
                .filter((section) => preview.available[section.key])
                .map((section) => (
                  <label className="check-line" key={section.key}>
                    <input
                      type="checkbox"
                      checked={Boolean(chosen[section.key])}
                      onChange={() => toggle(section.key)}
                    />
                    <span className="item-main">
                      <span>{section.label}</span>
                      <span className="small faint">{section.hint}</span>
                    </span>
                  </label>
                ))}

              <div className="notice">
                Restoring merges — anything already here wins, so an old backup cannot roll back something newer.
                Nothing is deleted.
              </div>
              {error && <div className="error" role="alert">{error}</div>}
              <button className="primary" onClick={doRestore} disabled={busy}>
                {busy ? 'Restoring…' : 'Restore selected'}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function RestoreReport({ report }) {
  const lines = [];
  if (report.contacts) lines.push(`${report.contacts.added} contacts added, ${report.contacts.skipped} already present`);
  if (report.accountNames) lines.push(`${report.accountNames.renamed} accounts renamed`);
  if (report.networks) lines.push(`${report.networks.added} networks, ${report.networks.overrides} endpoint overrides`);
  if (report.tokens) lines.push(`${report.tokens.added} tokens added`);
  if (report.nfts) lines.push(`${report.nfts.added} NFTs added`);
  if (report.notes) lines.push(`${report.notes.applied} notes applied`);
  if (report.settings) lines.push('preferences applied');
  if (report.sites) lines.push(`${report.sites.added} site permissions restored`);

  return (
    <div className="ok">
      Restored: {lines.join(' · ')}.
      {report.notes?.orphaned > 0 && (
        <span className="small faint">
          {' '}
          {report.notes.orphaned} notes referred to transactions this install has never seen, so they could not be
          attached.
        </span>
      )}
      {report.tokenLists?.pending?.length > 0 && (
        <span className="small faint">
          {' '}
          {report.tokenLists.pending.length} token list URLs were in the file — re-import them from the Lists tab.
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * What has been signed, for whom, and when.
 *
 * A signature is not a transaction: it costs nothing, appears nowhere on chain,
 * and can be redeemed by someone else weeks later. An off-chain Permit grants
 * spending rights that never show up in the approvals list, which is exactly
 * why it is the drainer's preferred instrument. This log is the only place
 * those are recorded, so it leads with them rather than with raw counts.
 */
function SignatureLog({ refresh }) {
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const { busy, run } = useAsyncAction();

  const load = async () => {
    const result = await call('LIST_SIGNATURES', {});
    setRows(result.signatures ?? []);
    setStats(result.stats ?? null);
  };

  useEffect(() => {
    load().catch(() => {});
  }, []);

  const needle = query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (kind !== 'all' && row.risk?.kind !== kind) return false;
    if (!needle) return true;
    return [row.origin, row.primaryType, row.domainName, row.message, row.risk?.spender]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
  const visible = showAll ? filtered : filtered.slice(0, 8);

  const exportLog = () => {
    const header = ['timestamp', 'origin', 'account', 'network', 'type', 'kind', 'summary', 'spender', 'amount', 'signature'];
    const csv = [
      header.join(','),
      ...filtered.map((row) =>
        [
          row.at ? new Date(row.at).toISOString() : '',
          row.origin,
          row.account,
          row.networkName ?? row.chainId,
          row.type,
          row.risk?.kind ?? '',
          row.type === 'personal' ? (row.message ?? '').slice(0, 300) : (row.primaryType ?? ''),
          row.risk?.spender ?? '',
          row.risk?.amount ?? '',
          row.signature,
        ]
          .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
          .join(',')
      ),
    ].join('\n');

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `adrix-signatures-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="card">
      <div className="between">
        <h2>Signature log</h2>
        {rows.length > 0 && (
          <span className="inline">
            <button className="link" onClick={exportLog}>
              export
            </button>
            <button className="link" onClick={() => setConfirmClear(!confirmClear)}>
              {confirmClear ? 'cancel' : 'clear'}
            </button>
          </span>
        )}
      </div>

      {!rows.length ? (
        <p className="small">
          Nothing signed yet. Every message and typed-data payload you sign for a site is recorded here, including
          Permits — which grant spending rights without ever appearing in the approvals list.
        </p>
      ) : (
        <>
          {stats?.unlimitedPermits > 0 && (
            <div className="notice danger">
              {stats.unlimitedPermits} unlimited Permit signature{stats.unlimitedPermits === 1 ? '' : 's'} in this log.
              A Permit cannot be revoked from the approvals screen — the only way to invalidate one is to use the
              token's nonce, usually by making another approval on chain.
            </div>
          )}

          <div className="stat-grid">
            <div className="stat">
              <span className="stat-value">{stats?.total ?? rows.length}</span>
              <span className="stat-label">Signatures</span>
            </div>
            <div className="stat">
              <span className={`stat-value ${stats?.permits ? 'danger' : ''}`}>{stats?.permits ?? 0}</span>
              <span className="stat-label">Permits</span>
            </div>
            <div className="stat">
              <span className="stat-value">{stats?.logins ?? 0}</span>
              <span className="stat-label">Sign-ins</span>
            </div>
            <div className="stat">
              <span className="stat-value">{stats?.origins ?? 0}</span>
              <span className="stat-label">Sites</span>
            </div>
          </div>

          <div className="row2">
            <label className="field">
              <span>Search</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Site, type, spender"
                type="search"
              />
            </label>
            <label className="field">
              <span>Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="all">Everything</option>
                <option value="permit">Permits</option>
                <option value="order">Marketplace orders</option>
                <option value="siwe">Sign-ins</option>
                <option value="message">Plain messages</option>
                <option value="typed">Other typed data</option>
              </select>
            </label>
          </div>

          {confirmClear && (
            <div className="stack-sm">
              <div className="notice">
                Clearing the log does not invalidate anything you signed. Those signatures still exist and can still be
                redeemed — this only erases your record of them.
              </div>
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await call('CLEAR_SIGNATURES');
                    await load();
                    await refresh();
                    setConfirmClear(false);
                  })
                }
              >
                Clear log
              </button>
            </div>
          )}

          {!filtered.length ? (
            <p className="small faint">No signature matches that filter.</p>
          ) : (
            <div className="list">
              {visible.map((row) => (
                <SignatureRow
                  key={row.id}
                  row={row}
                  open={expanded === row.id}
                  onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                />
              ))}
            </div>
          )}

          {filtered.length > 8 && (
            <button className="link" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
              {showAll ? 'show less' : `show all ${filtered.length}`}
            </button>
          )}

          <p className="small faint">
            The most recent 200 signatures, stored locally and never sent anywhere.
          </p>
        </>
      )}
    </section>
  );
}

const SIGNATURE_LABEL = {
  permit: 'Spending permit',
  order: 'Marketplace order',
  siwe: 'Sign-in',
  delegation: 'Delegation',
  message: 'Message',
  typed: 'Typed data',
};

function SignatureRow({ row, open, onToggle }) {
  const kind = row.risk?.kind ?? 'message';
  const flagged = (row.risk?.warnings?.length ?? 0) > 0;

  return (
    <div className="site-row">
      <button className="item" onClick={onToggle} aria-expanded={open}>
        <span
          className="dot"
          style={{ background: flagged ? 'var(--danger)' : 'var(--line-strong)', boxShadow: 'none' }}
        />
        <div className="item-main">
          <span className="item-title">
            {SIGNATURE_LABEL[kind] ?? kind}
            {row.risk?.unlimited && <span className="badge failed" style={{ marginLeft: 6 }}>unlimited</span>}
            {row.risk?.originMismatch && <span className="badge failed" style={{ marginLeft: 6 }}>origin mismatch</span>}
          </span>
          <span className="item-sub">
            {row.origin?.replace(/^https?:\/\//, '')} · {timeAgo(row.at)}
          </span>
          <span className="item-sub faint">
            {row.primaryType ? `${row.primaryType} · ` : ''}
            {row.networkName ?? row.chainId} · {shorten(row.account, 6, 4)}
          </span>
        </div>
        <span className="link">{open ? 'close' : 'view'}</span>
      </button>

      {open && (
        <div className="site-panel stack-sm">
          {row.risk?.warnings?.map((warning) => (
            <div className="notice danger" key={warning}>
              {warning}
            </div>
          ))}

          {kind === 'permit' && (
            <>
              <div className="kv">
                <span className="kv-key">Spender</span>
                <span className="kv-value mono">{shorten(row.risk.spender, 10, 8)}</span>
              </div>
              <div className="kv">
                <span className="kv-key">Amount</span>
                <span className="kv-value">{row.risk.unlimited ? 'Unlimited' : `${row.risk.amount} (raw)`}</span>
              </div>
              <div className="kv">
                <span className="kv-key">Expires</span>
                <span className="kv-value">
                  {row.risk.deadline ? formatDateTime(Number(row.risk.deadline) * 1000) : 'no expiry'}
                </span>
              </div>
            </>
          )}

          {kind === 'siwe' && row.risk.siwe && (
            <>
              <div className="kv">
                <span className="kv-key">Claimed site</span>
                <span className="kv-value">{row.risk.siwe.domain ?? '--'}</span>
              </div>
              <div className="kv">
                <span className="kv-key">Expires</span>
                <span className="kv-value">{row.risk.siwe.expirationTime ?? 'no expiry'}</span>
              </div>
            </>
          )}

          {row.verifyingContract && (
            <div className="kv">
              <span className="kv-key">Verifying contract</span>
              <span className="kv-value mono">{shorten(row.verifyingContract, 10, 8)}</span>
            </div>
          )}

          {row.type === 'personal' && row.message && (
            <>
              <div className="eyebrow">Message</div>
              <div className="data-block">{row.message}</div>
            </>
          )}

          {row.fields?.length > 0 && (
            <>
              <div className="eyebrow">Contents</div>
              {row.fields.map((field, index) => (
                <div className="kv" key={`${field.key}-${index}`}>
                  <span className="kv-key">{field.key}</span>
                  <span className="kv-value" style={{ maxWidth: '64%' }}>
                    {field.value}
                  </span>
                </div>
              ))}
            </>
          )}

          <div className="eyebrow">Signature</div>
          <div className="data-block">{row.signature}</div>
          <span className="small faint">{formatDateTime(row.at)}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function DappHistory({ history, networks, sites, refresh }) {
  const [expanded, setExpanded] = useState(false);
  const [originFilter, setOriginFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const { busy, run } = useAsyncAction();

  const connectedOrigins = new Set((sites ?? []).map((site) => site.origin));
  const origins = [...new Set(history.map((entry) => entry.origin))];

  // Signing and spending events are the ones worth auditing, so they get their
  // own filter rather than being buried among connect/disconnect noise.
  const SENSITIVE = new Set(['personalSign', 'typedSign', 'transaction']);

  const filtered = history.filter((entry) => {
    if (originFilter && entry.origin !== originFilter) return false;
    if (typeFilter === 'sensitive' && !SENSITIVE.has(entry.type)) return false;
    if (typeFilter === 'permissions' && SENSITIVE.has(entry.type)) return false;
    return true;
  });
  const visible = expanded ? filtered : filtered.slice(0, 8);

  const exportHistory = () => {
    const rows = [
      ['timestamp', 'origin', 'type', 'description', 'chain_id', 'accounts'].join(','),
      ...filtered.map((entry) =>
        [
          entry.at ? new Date(entry.at).toISOString() : '',
          entry.origin,
          entry.type,
          describeHistory(entry, networks),
          entry.chainId ?? '',
          (entry.accounts ?? []).join('|'),
        ]
          .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
          .join(',')
      ),
    ].join('\n');

    const url = URL.createObjectURL(new Blob([rows], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `adrix-dapp-history-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="card">
      <div className="between">
        <h2>dApp history</h2>
        {history.length > 0 && (
          <span className="inline">
            <button className="link" onClick={exportHistory}>
              export
            </button>
            <button className="link" onClick={() => setConfirmClear(!confirmClear)}>
              {confirmClear ? 'cancel' : 'clear'}
            </button>
          </span>
        )}
      </div>

      {confirmClear && (
        <div className="stack-sm">
          <div className="notice">
            Clearing the log does not disconnect anything — it only erases the record of what happened.
          </div>
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await call('CLEAR_HISTORY');
                await refresh();
                setConfirmClear(false);
              })
            }
          >
            {busy ? 'Clearing…' : 'Clear history'}
          </button>
        </div>
      )}

      {!history.length ? (
        <p className="small">Connections, permission changes, signatures, and transactions will appear here.</p>
      ) : (
        <>
          <div className="row2">
            <label className="field">
              <span>Site</span>
              <select value={originFilter} onChange={(e) => setOriginFilter(e.target.value)}>
                <option value="">All sites ({origins.length})</option>
                {origins.map((origin) => (
                  <option key={origin} value={origin}>
                    {origin.replace(/^https?:\/\//, '')}
                    {connectedOrigins.has(origin) ? '' : ' (gone)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Kind</span>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="all">Everything</option>
                <option value="sensitive">Signing and sending</option>
                <option value="permissions">Permission changes</option>
              </select>
            </label>
          </div>

          <div className="between small">
            <span>
              Showing {visible.length} of {filtered.length}
              {filtered.length !== history.length ? ` (${history.length} total)` : ''}
            </span>
            {filtered.length > 8 && (
              <button className="link" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
                {expanded ? 'show less' : 'show all'}
              </button>
            )}
          </div>

          {!filtered.length ? (
            <p className="small faint">No events match that filter.</p>
          ) : (
            <div className="list">
              {visible.map((entry) => (
                <div className="item static compact" key={entry.id}>
                  <span
                    className={`dot ${SENSITIVE.has(entry.type) ? '' : 'muted-dot'}`}
                    style={SENSITIVE.has(entry.type) ? undefined : { background: 'var(--line-strong)', boxShadow: 'none' }}
                  />
                  <div className="item-main">
                    <span className="item-title">{describeHistory(entry, networks)}</span>
                    <span className="item-sub">
                      {entry.origin.replace(/^https?:\/\//, '')} · {timeAgo(entry.at)}
                    </span>
                  </div>
                  {!connectedOrigins.has(entry.origin) && <span className="badge">disconnected</span>}
                </div>
              ))}
            </div>
          )}

          <p className="small faint">
            The log keeps the most recent 120 events. It is stored locally and never leaves this browser.
          </p>
        </>
      )}
    </section>
  );
}

function describeHistory(entry, networks) {
  const chainName = entry.chainId ? networks?.[entry.chainId]?.name ?? entry.chainId : null;
  const labels = {
    connected: 'Connected',
    updated: 'Permissions updated',
    accountsUpdated: 'Account permissions updated',
    networksUpdated: 'Network permissions updated',
    disconnected: 'Disconnected',
    used: 'Connection used',
    personalSign: 'Signed message',
    typedSign: entry.primaryType ? `Signed ${entry.primaryType}` : 'Signed typed data',
    transaction: chainName ? `Transaction on ${chainName}` : 'Transaction requested',
    chainSwitched: chainName ? `Switched to ${chainName}` : 'Switched network',
    networkAdded: entry.name ? `Added ${entry.name}` : 'Added network',
    watchAsset: entry.symbol ? `Added ${entry.symbol}` : 'Added token',
  };
  return labels[entry.type] ?? entry.type;
}

// ---------------------------------------------------------------------------
function ChangePassword({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  const submit = () =>
    run(async () => {
      if (next !== confirm) throw new Error('The new passwords do not match.');
      if (next === current) throw new Error('The new password matches the current one.');
      await call('CHANGE_PASSWORD', { current, next });
      onDone();
    });

  return (
    <div className="stack-sm">
      <label className="field">
        <span>Current password</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        <span>New password</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete="new-password"
        />
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary" disabled={busy || next.length < 8 || !current} onClick={submit}>
        {busy ? 'Re-encrypting…' : 'Change password'}
      </button>
      <p className="small faint">Changing the password re-encrypts the vault. Your accounts and keys are unaffected.</p>
    </div>
  );
}
