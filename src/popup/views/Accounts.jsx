import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { call, shorten, useAsyncAction } from '../../lib/ui.js';
import { BackBar, Avatar, CopyButton, PasswordPrompt, EmptyState } from '../components/common.jsx';

export default function Accounts({ state, go, refresh }) {
  const [panel, setPanel] = useState(null);
  const [query, setQuery] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  const allAccounts = [...state.accounts, ...(state.hiddenAccounts ?? [])];
  const managedAccount = allAccounts.find((account) => account.address === panel);
  const vaults = state.vaults ?? [];

  const needle = query.trim().toLowerCase();
  const visible = state.accounts.filter(
    (account) =>
      !needle ||
      account.name.toLowerCase().includes(needle) ||
      account.address.toLowerCase().includes(needle) ||
      account.ens?.name?.toLowerCase().includes(needle)
  );

  const close = () => {
    setPanel(null);
    setError('');
  };

  return (
    <div className="screen">
      <BackBar title="Accounts" onBack={() => go('home')} />
      <div className="scroll pad stack">
        {state.accounts.length > 5 && (
          <label className="field">
            <span>Search accounts</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, ENS, or address" type="search" />
          </label>
        )}

        <div className="list">
          {visible.map((account) => (
            // The row and the manage control are siblings rather than nested,
            // so both are reachable by keyboard without one swallowing the other.
            <div className="item-pair" key={account.address}>
              <button
                className={`item ${account.address === state.selected ? 'selected' : ''}`}
                disabled={busy}
                aria-current={account.address === state.selected ? 'true' : undefined}
                onClick={() =>
                  run(async () => {
                    await call('SELECT_ACCOUNT', { address: account.address });
                    await refresh();
                  })
                }
              >
                <Avatar address={account.address} size="lg" src={account.ens?.avatar} />
                <div className="item-main">
                  <span className="item-title">{account.name}</span>
                  <span className="item-sub">
                    {account.ens?.name ? `${account.ens.name} · ` : ''}
                    {shorten(account.address, 8, 6)}
                  </span>
                  {vaults.length > 1 && account.vaultId && (
                    <span className="item-sub">{vaults.find((v) => v.id === account.vaultId)?.name}</span>
                  )}
                </div>
                <span className="item-right">
                  {account.address === state.selected && <span className="badge confirmed">active</span>}
                  {account.type !== 'hd' && <span className="badge">{account.type}</span>}
                </span>
              </button>
              <button
                className="link item-aside"
                onClick={() => setPanel(account.address)}
                aria-label={`Manage ${account.name}`}
              >
                manage
              </button>
            </div>
          ))}
          {needle && !visible.length && <EmptyState icon="⌕" title="No match" body="No account matches that search." />}
        </div>

        {panel?.startsWith?.('0x') && managedAccount && (
          <ManageAccount account={managedAccount} onClose={close} refresh={refresh} />
        )}

        {(state.hiddenAccounts ?? []).length > 0 && (
          <div className="card">
            <h2>Hidden accounts</h2>
            <p className="small">
              Hidden accounts stay derivable from the recovery phrase — they simply do not appear in the switcher.
            </p>
            <div className="list">
              {state.hiddenAccounts.map((account) => (
                <div className="item static" key={account.address}>
                  <Avatar address={account.address} size="lg" src={account.ens?.avatar} />
                  <div className="item-main">
                    <span className="item-title">{account.name}</span>
                    <span className="item-sub">{shorten(account.address, 8, 6)}</span>
                  </div>
                  <div className="item-right">
                    <button
                      className="link accent"
                      onClick={() =>
                        run(async () => {
                          await call('UNHIDE_ACCOUNT', { address: account.address });
                          await refresh();
                        })
                      }
                    >
                      unhide
                    </button>
                    <button className="link" onClick={() => setPanel(account.address)}>
                      details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {panel === 'import' && <ImportKeyPanel onClose={close} refresh={refresh} />}
        {panel === 'keystore' && <ImportKeystorePanel onClose={close} refresh={refresh} />}
        {panel === 'watch' && <AddressOnlyPanel type="watch" onClose={close} refresh={refresh} />}
        {panel === 'hardware' && <AddressOnlyPanel type="hardware" onClose={close} refresh={refresh} />}
        {panel === 'smart' && <AddressOnlyPanel type="smart" onClose={close} refresh={refresh} />}
        {panel === 'multisig' && <AddressOnlyPanel type="multisig" onClose={close} refresh={refresh} />}
        {panel === 'newHd' && <NewHdPanel vaults={vaults} onClose={close} refresh={refresh} />}

        {!panel && error && <div className="error" role="alert">{error}</div>}
      </div>

      <div className="footer">
        <div className="row3">
          <button className="ghost" onClick={() => setPanel('import')}>
            Private key
          </button>
          <button className="ghost" onClick={() => setPanel('keystore')}>
            Keystore
          </button>
          <button className="ghost" onClick={() => setPanel('watch')}>
            Watch-only
          </button>
        </div>
        <div className="row3">
          <button className="ghost" onClick={() => setPanel('hardware')}>
            Hardware
          </button>
          <button className="ghost" onClick={() => setPanel('smart')}>
            Smart / multisig
          </button>
          <button
            className="primary"
            disabled={busy || !state.hasRecoveryPhrase}
            title={state.hasRecoveryPhrase ? 'Derive the next account' : 'This wallet has no recovery phrase'}
            onClick={() => (vaults.length > 1 ? setPanel('newHd') : run(async () => {
              await call('ADD_ACCOUNT', {});
              await refresh();
            }))}
          >
            Add account
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function NewHdPanel({ vaults, onClose, refresh }) {
  const [vaultId, setVaultId] = useState(vaults[0]?.id ?? '');
  const [name, setName] = useState('');
  const { busy, error, run } = useAsyncAction();

  return (
    <div className="card">
      <div className="between">
        <h2>New account</h2>
        <button className="link" onClick={onClose}>
          close
        </button>
      </div>
      <label className="field">
        <span>Derive from</span>
        <select value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
          {vaults.map((vault) => (
            <option key={vault.id} value={vault.id}>
              {vault.name} ({vault.accountCount} account{vault.accountCount === 1 ? '' : 's'})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row2">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await call('ADD_ACCOUNT', { name, vaultId });
              await refresh();
              onClose();
            })
          }
        >
          {busy ? 'Deriving…' : 'Add account'}
        </button>
      </div>
    </div>
  );
}

function ImportKeyPanel({ onClose, refresh }) {
  const [privateKey, setPrivateKey] = useState('');
  const [name, setName] = useState('');
  const [reveal, setReveal] = useState(false);
  const { busy, error, run } = useAsyncAction();

  return (
    <div className="card">
      <div className="between">
        <h2>Import a private key</h2>
        <button className="link" onClick={onClose}>
          close
        </button>
      </div>
      <label className="field">
        <span>Private key</span>
        <div className="input-group">
          <input
            className="mono"
            type={reveal ? 'text' : 'password'}
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            spellCheck="false"
            autoComplete="off"
            placeholder="0x…"
          />
          <button className="ghost" onClick={() => setReveal(!reveal)} aria-label={reveal ? 'Hide key' : 'Show key'}>
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
      </label>
      <label className="field">
        <span>Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <p className="small">Imported accounts are not covered by your recovery phrase. Back the key up separately.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row2">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !privateKey}
          onClick={() =>
            run(async () => {
              await call('IMPORT_PRIVATE_KEY', { privateKey, name });
              await refresh();
              onClose();
            })
          }
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  );
}

function ImportKeystorePanel({ onClose, refresh }) {
  const inputRef = useRef(null);
  const [keystore, setKeystore] = useState('');
  const [fileName, setFileName] = useState('');
  const [summary, setSummary] = useState(null);
  const [keystorePassword, setKeystorePassword] = useState('');
  const [name, setName] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  const readFile = async (file) => {
    if (!file) return;
    setError('');
    try {
      const content = await file.text();
      const parsed = JSON.parse(content);
      if (!parsed.crypto && !parsed.Crypto) throw new Error('not a keystore');
      setKeystore(content);
      setFileName(file.name);
      setSummary({
        address: parsed.address ? `0x${String(parsed.address).replace(/^0x/, '')}` : 'unknown',
        version: parsed.version ?? '?',
        kdf: (parsed.crypto ?? parsed.Crypto)?.kdf ?? '?',
      });
    } catch {
      setKeystore('');
      setFileName('');
      setSummary(null);
      setError('That file is not a valid v3 keystore JSON.');
    }
  };

  return (
    <div className="card">
      <div className="between">
        <h2>Import a keystore file</h2>
        <button className="link" onClick={onClose}>
          close
        </button>
      </div>

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
        <div className="stack-sm">
          <div className="between">
            <span className="small">Address</span>
            <span className="mono small">{shorten(summary.address, 10, 8)}</span>
          </div>
          <div className="between">
            <span className="small">Version / KDF</span>
            <span className="mono small">
              v{summary.version} · {summary.kdf}
            </span>
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
        />
      </label>
      <label className="field">
        <span>Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <p className="small">Decrypting a scrypt keystore is deliberately slow and can take several seconds.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row2">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !keystore || !keystorePassword}
          onClick={() =>
            run(async () => {
              await call('IMPORT_KEYSTORE', { keystore, keystorePassword, name });
              await refresh();
              onClose();
            })
          }
        >
          {busy ? 'Decrypting…' : 'Import'}
        </button>
      </div>
    </div>
  );
}

const ADDRESS_ONLY_COPY = {
  watch: {
    title: 'Add a watch-only account',
    note: 'Watch-only accounts show balances and activity. ADRIX has no key for them and cannot sign.',
    message: 'ADD_WATCH_ACCOUNT',
  },
  hardware: {
    title: 'Add a hardware account',
    note: 'ADRIX can track this address, but signing on the device is not implemented yet — it will refuse to send.',
    message: 'ADD_HARDWARE_ACCOUNT',
  },
  smart: {
    title: 'Add a smart account',
    note: 'Tracked as an address only. Dispatching user operations needs an ERC-4337 bundler, which is not built yet.',
    message: 'ADD_SMART_ACCOUNT',
  },
  multisig: {
    title: 'Add a multisig account',
    note: 'Tracked as an address only. Collecting co-owner signatures is not implemented yet.',
    message: 'ADD_MULTISIG_ACCOUNT',
  },
};

function AddressOnlyPanel({ type, onClose, refresh }) {
  const copy = ADDRESS_ONLY_COPY[type];
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [vendor, setVendor] = useState('ledger');
  const { busy, error, run } = useAsyncAction();

  return (
    <div className="card">
      <div className="between">
        <h2>{copy.title}</h2>
        <button className="link" onClick={onClose}>
          close
        </button>
      </div>

      {type === 'hardware' && (
        <label className="field">
          <span>Vendor</span>
          <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="ledger">Ledger</option>
            <option value="trezor">Trezor</option>
          </select>
        </label>
      )}

      <label className="field">
        <span>Address or ENS name</span>
        <input
          className="mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck="false"
          placeholder="0x…"
        />
      </label>
      <label className="field">
        <span>Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>

      <div className="notice">{copy.note}</div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row2">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !address}
          onClick={() =>
            run(async () => {
              // Accepts an ENS name too, resolved before the account is stored.
              const { address: resolved } = await call('RESOLVE_RECIPIENT', { input: address });
              await call(copy.message, { address: resolved, name, vendor });
              await refresh();
              onClose();
            })
          }
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ManageAccount({ account, onClose, refresh }) {
  const [name, setName] = useState(account.name);
  const [mode, setMode] = useState(null);
  const [privateKey, setPrivateKey] = useState('');
  const [savedName, setSavedName] = useState(false);
  const { busy, error, run } = useAsyncAction();

  useEffect(() => {
    setName(account.name);
    setPrivateKey('');
    setMode(null);
  }, [account.address]);

  const canExport = account.type === 'hd' || account.type === 'imported';

  return (
    <div className="card">
      <div className="between">
        <h2>{account.name}</h2>
        <button className="link" onClick={onClose}>
          close
        </button>
      </div>

      <div className="center stack-sm">
        <Avatar address={account.address} size="xl" src={account.ens?.avatar} />
        {account.ens?.name && <div className="eyebrow">{account.ens.name}</div>}
      </div>

      <AccountQr address={account.address} />
      <div className="data-block center">{account.address}</div>
      <CopyButton value={account.address} label="Copy address" className="ghost" />

      <label className="field">
        <span>Name</span>
        <div className="input-group">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <button
            className="ghost"
            disabled={busy || !name.trim() || name === account.name}
            onClick={() =>
              run(async () => {
                await call('RENAME_ACCOUNT', { address: account.address, name });
                setSavedName(true);
                setTimeout(() => setSavedName(false), 1600);
                await refresh();
              })
            }
          >
            {savedName ? 'Saved' : 'Save'}
          </button>
        </div>
      </label>

      {account.type === 'watch' && mode !== 'upgrade' && (
        <div className="notice">
          Watch-only: ADRIX holds no key for this address. It shows balances and activity but cannot sign anything,
          and connected sites are told the same.
        </div>
      )}

      {account.type === 'watch' && mode === 'upgrade' && (
        <UpgradeWatch account={account} onCancel={() => setMode(null)} refresh={refresh} onDone={onClose} />
      )}

      {privateKey ? (
        <div className="stack-sm">
          <div className="eyebrow">Private key</div>
          <div className="data-block">{privateKey}</div>
          <div className="notice danger">Anyone with this key owns the account. Never paste it into a website.</div>
          <div className="row2">
            <CopyButton value={privateKey} label="Copy key" className="ghost" />
            <button className="ghost" onClick={() => setPrivateKey('')}>
              Hide
            </button>
          </div>
        </div>
      ) : mode === 'export' ? (
        <PasswordPrompt
          cta="Reveal key"
          onCancel={() => setMode(null)}
          onSubmit={async (password) => {
            const result = await call('EXPORT_PRIVATE_KEY', { address: account.address, password });
            setPrivateKey(result.privateKey);
            setMode(null);
          }}
        />
      ) : (
        <div className="row2">
          {account.type === 'watch' ? (
            <button className="ghost" onClick={() => setMode('upgrade')}>
              Add its key
            </button>
          ) : canExport ? (
            <button className="ghost" onClick={() => setMode('export')}>
              Show private key
            </button>
          ) : (
            <button className="ghost" disabled title="ADRIX has no key for this account">
              No key held
            </button>
          )}

          {account.hidden ? (
            <button
              className="ghost"
              onClick={() =>
                run(async () => {
                  await call('UNHIDE_ACCOUNT', { address: account.address });
                  await refresh();
                  onClose();
                })
              }
            >
              Unhide
            </button>
          ) : account.type === 'hd' ? (
            <button
              className="ghost"
              onClick={() =>
                run(async () => {
                  await call('HIDE_ACCOUNT', { address: account.address });
                  await refresh();
                  onClose();
                })
              }
            >
              Hide
            </button>
          ) : (
            <button
              className="danger"
              onClick={() =>
                run(async () => {
                  await call('REMOVE_ACCOUNT', { address: account.address });
                  await refresh();
                  onClose();
                })
              }
            >
              Remove
            </button>
          )}
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

/**
 * Supplies the private key for an address already being watched. The key's
 * derived address is checked against the watched one in the background, so a
 * mistyped key cannot quietly swap the account for a different address.
 */
function UpgradeWatch({ account, onCancel, refresh, onDone }) {
  const [privateKey, setPrivateKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const { busy, error, run } = useAsyncAction();

  return (
    <div className="stack-sm">
      <div className="eyebrow">Turn this into a signing account</div>
      <p className="small">
        Paste the private key for {shorten(account.address, 8, 6)}. It must derive exactly this address or nothing is
        changed.
      </p>
      <label className="field">
        <span>Private key</span>
        <div className="input-group">
          <input
            className="mono"
            type={reveal ? 'text' : 'password'}
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            spellCheck="false"
            autoComplete="off"
            placeholder="0x…"
          />
          <button className="ghost" onClick={() => setReveal(!reveal)}>
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row2">
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !privateKey}
          onClick={() =>
            run(async () => {
              await call('UPGRADE_WATCH_ACCOUNT', { address: account.address, privateKey });
              await refresh();
              onDone();
            })
          }
        >
          {busy ? 'Checking…' : 'Add key'}
        </button>
      </div>
    </div>
  );
}

function AccountQr({ address }) {
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(address, { width: 176, margin: 1, color: { dark: '#12101f', light: '#ffffff' } })
      .then((url) => !cancelled && setDataUrl(url))
      .catch(() => !cancelled && setDataUrl(''));
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!dataUrl) return null;
  return <img className="qr compact-qr" src={dataUrl} alt={`QR code for ${address}`} width="176" height="176" />;
}
