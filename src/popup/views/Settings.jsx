import { useEffect, useRef, useState } from 'react';
import { call, shorten, timeAgo, useAsyncAction } from '../../lib/ui.js';
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

        <DappHistory
          history={state.connectionHistory ?? []}
          networks={state.allNetworks ?? state.networks}
          sites={state.sites}
          refresh={refresh}
        />

        <AddressBook contacts={state.contacts ?? []} refresh={refresh} />

        <section className="card">
          <h2>Not implemented yet</h2>
          <p className="small">
            These appear on the roadmap but have no working implementation. They are listed so the gap is visible
            rather than hidden behind a button that does nothing.
          </p>
          <ul className="small faint plain-list">
            <li>WalletConnect pairing</li>
            <li>Session keys and spending limits</li>
            <li>Social recovery guardians</li>
            <li>Hardware wallet signing</li>
            <li>Swap, bridge, and fiat on-ramp routing</li>
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
