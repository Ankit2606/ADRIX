import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { call, shorten } from '../../lib/ui.js';
import { BackBar, Avatar, CopyButton, PasswordPrompt } from '../components/common.jsx';

export default function Accounts({ state, go, refresh }) {
  const [panel, setPanel] = useState(null); // 'add' | 'import' | address | 'watch' | 'hardware'
  const [privateKey, setPrivateKey] = useState('');
  const [watchAddress, setWatchAddress] = useState('');
  const [hwAddress, setHwAddress] = useState('');
  const [vendor, setVendor] = useState('ledger');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const managedAccount = [...state.accounts, ...(state.hiddenAccounts ?? [])].find((account) => account.address === panel);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      setPanel(null);
      setPrivateKey('');
      setWatchAddress('');
      setName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <BackBar title="Accounts" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="list">
          {state.accounts.map((account) => (
            <div className="item" key={account.address} onClick={() => run(() => call('SELECT_ACCOUNT', { address: account.address }))}>
              <Avatar address={account.address} size="lg" src={account.ens?.avatar} />
              <div className="item-main">
                <span className="item-title">{account.name}</span>
                <span className="item-sub">
                  {account.ens?.name ? `${account.ens.name} · ` : ''}
                  {shorten(account.address, 8, 6)}
                </span>
              </div>
              <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
                {account.address === state.selected && <span className="badge confirmed">active</span>}
                {account.type === 'watch' && <span className="badge">watch</span>}
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPanel(account.address);
                  }}
                >
                  manage
                </button>
              </div>
            </div>
          ))}
        </div>

        {panel && panel.startsWith('0x') && managedAccount && (
          <ManageAccount
            account={managedAccount}
            onClose={() => setPanel(null)}
            refresh={refresh}
          />
        )}

        {(state.hiddenAccounts ?? []).length > 0 && (
          <div className="card">
            <h2>Hidden accounts</h2>
            <p className="small">Hidden recovery phrase accounts stay recoverable, but they do not appear in the main account switcher.</p>
            <div className="list">
              {state.hiddenAccounts.map((account) => (
                <div className="item static" key={account.address}>
                  <Avatar address={account.address} size="lg" src={account.ens?.avatar} />
                  <div className="item-main">
                    <span className="item-title">{account.name}</span>
                    <span className="item-sub">
                      {account.ens?.name ? `${account.ens.name} · ` : ''}
                      {shorten(account.address, 8, 6)}
                    </span>
                  </div>
                  <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
                    <button
                      className="link"
                      onClick={async () => {
                        await call('UNHIDE_ACCOUNT', { address: account.address });
                        refresh();
                      }}
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

        {panel === 'import' && (
          <div className="card">
            <h2>Import a private key</h2>
            <label className="field">
              <span>Private key</span>
              <input className="mono" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} spellCheck="false" />
            </label>
            <label className="field">
              <span>Name (optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="small">
              Imported accounts are not covered by your recovery phrase. Back the key up separately.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="row2">
              <button className="ghost" onClick={() => setPanel(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || !privateKey}
                onClick={() => run(() => call('IMPORT_PRIVATE_KEY', { privateKey, name }))}
              >
                Import
              </button>
            </div>
          </div>
        )}

        {panel === 'watch' && (
          <div className="card">
            <h2>Add watch-only account</h2>
            <label className="field">
              <span>Address</span>
              <input className="mono" value={watchAddress} onChange={(e) => setWatchAddress(e.target.value)} spellCheck="false" />
            </label>
            <label className="field">
              <span>Name (optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="small">
              Watch-only accounts can show balances and activity, but they cannot sign or send transactions.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="row2">
              <button className="ghost" onClick={() => setPanel(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || !watchAddress}
                onClick={() => run(() => call('ADD_WATCH_ACCOUNT', { address: watchAddress, name }))}
              >
                Add
              </button>
            </div>
          </div>
        )}

        {panel === 'hardware' && (
          <div className="card">
            <h2>Connect hardware wallet</h2>
            <label className="field">
              <span>Vendor</span>
              <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
                <option value="ledger">Ledger</option>
                <option value="trezor">Trezor</option>
              </select>
            </label>
            <label className="field">
              <span>Address (Mock)</span>
              <input className="mono" value={hwAddress} onChange={(e) => setHwAddress(e.target.value)} spellCheck="false" placeholder="0x..." />
            </label>
            <label className="field">
              <span>Name (optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="small">
              Hardware wallets sign transactions securely on the device. (Note: This is a mocked UI step).
            </p>
            {error && <div className="error">{error}</div>}
            <div className="row2">
              <button className="ghost" onClick={() => setPanel(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || !hwAddress}
                onClick={() => run(() => call('ADD_HARDWARE_ACCOUNT', { address: hwAddress, name, vendor }))}
              >
                Connect
              </button>
            </div>
          </div>
        )}

        {panel === 'smart' && (
          <div className="card">
            <h2>Add Smart Account</h2>
            <label className="field">
              <span>Address</span>
              <input className="mono" value={hwAddress} onChange={(e) => setHwAddress(e.target.value)} spellCheck="false" placeholder="0x..." />
            </label>
            <label className="field">
              <span>Name (optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="small">
              Smart accounts use account abstraction (ERC-4337) and support session keys and social recovery.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="row2">
              <button className="ghost" onClick={() => setPanel(null)}>Cancel</button>
              <button className="primary" disabled={busy || !hwAddress} onClick={() => run(() => call('ADD_SMART_ACCOUNT', { address: hwAddress, name }))}>
                Add
              </button>
            </div>
          </div>
        )}

        {panel === 'multisig' && (
          <div className="card">
            <h2>Add Multisig Account</h2>
            <label className="field">
              <span>Address</span>
              <input className="mono" value={hwAddress} onChange={(e) => setHwAddress(e.target.value)} spellCheck="false" placeholder="0x..." />
            </label>
            <label className="field">
              <span>Name (optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="small">
              Multisig accounts require multiple signers for transaction execution.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="row2">
              <button className="ghost" onClick={() => setPanel(null)}>Cancel</button>
              <button className="primary" disabled={busy || !hwAddress} onClick={() => run(() => call('ADD_MULTISIG_ACCOUNT', { address: hwAddress, name }))}>
                Add
              </button>
            </div>
          </div>
        )}

        {!panel && error && <div className="error">{error}</div>}
      </div>

      <div className="footer" style={{ flexDirection: 'column', gap: 8, padding: '16px' }}>
        <div className="row3" style={{ width: '100%' }}>
          <button className="ghost" onClick={() => setPanel('hardware')} style={{ fontSize: '12px' }}>
            Hardware
          </button>
          <button className="ghost" onClick={() => setPanel('watch')} style={{ fontSize: '12px' }}>
            Watch
          </button>
          <button className="ghost" onClick={() => setPanel('import')} style={{ fontSize: '12px' }}>
            Import key
          </button>
        </div>
        <div className="row3" style={{ width: '100%' }}>
          <button className="ghost" onClick={() => setPanel('smart')} style={{ fontSize: '12px' }}>
            Smart Acc
          </button>
          <button className="ghost" onClick={() => setPanel('multisig')} style={{ fontSize: '12px' }}>
            Multisig
          </button>
          <button
            className="primary"
            disabled={busy || !state.hasRecoveryPhrase}
            title={state.hasRecoveryPhrase ? 'Add account from recovery phrase' : 'Import another private key instead'}
            onClick={() => run(() => call('ADD_ACCOUNT', {}))}
            style={{ fontSize: '12px', padding: '0 8px' }}
          >
            Add Account
          </button>
        </div>
      </div>
    </div>
  );
}

function ManageAccount({ account, onClose, refresh }) {
  const [name, setName] = useState(account.name);
  const [mode, setMode] = useState(null); // 'export' | 'remove'
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState('');

  return (
    <div className="card">
      <div className="between">
        <h2>{account.name}</h2>
        <button className="link" onClick={onClose}>
          close
        </button>
      </div>
      {account.ens?.name && <div className="eyebrow">{account.ens.name}</div>}
      <div className="data-block">{account.address}</div>
      <AccountQr address={account.address} />
      <CopyButton value={account.address} label="Copy address" className="ghost" />

      <label className="field">
        <span>Name</span>
        <div className="inline">
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="ghost"
            style={{ flex: 'none' }}
            onClick={async () => {
              await call('RENAME_ACCOUNT', { address: account.address, name });
              refresh();
            }}
          >
            Save
          </button>
        </div>
      </label>

      {account.type === 'watch' ? (
        <div className="stack-sm">
          <div className="notice">This is a watch-only account. ADRIX does not have its private key.</div>
          <button
            className="danger"
            onClick={async () => {
              try {
                await call('REMOVE_ACCOUNT', { address: account.address });
                refresh();
                onClose();
              } catch (err) {
                setError(err.message);
              }
            }}
          >
            Remove
          </button>
        </div>
      ) : privateKey ? (
        <>
          <div className="eyebrow">Private key</div>
          <div className="data-block">{privateKey}</div>
          <div className="notice">Anyone with this key owns the account. Never paste it into a website.</div>
          <button className="ghost" onClick={() => setPrivateKey('')}>
            Hide
          </button>
        </>
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
          <button className="ghost" onClick={() => setMode('export')}>
            Show private key
          </button>
          {account.hidden ? (
            <button
              className="ghost"
              onClick={async () => {
                try {
                  await call('UNHIDE_ACCOUNT', { address: account.address });
                  refresh();
                  onClose();
                } catch (err) {
                  setError(err.message);
                }
              }}
            >
              Unhide
            </button>
          ) : account.type === 'imported' ? (
            <button
              className="danger"
              onClick={async () => {
                try {
                  await call('REMOVE_ACCOUNT', { address: account.address });
                  refresh();
                  onClose();
                } catch (err) {
                  setError(err.message);
                }
              }}
            >
              Remove
            </button>
          ) : (
            <button
              className="ghost"
              onClick={async () => {
                try {
                  await call('HIDE_ACCOUNT', { address: account.address });
                  refresh();
                  onClose();
                } catch (err) {
                  setError(err.message);
                }
              }}
            >
              Hide
            </button>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function AccountQr({ address }) {
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    QRCode.toDataURL(address, {
      width: 176,
      margin: 0,
      color: { dark: '#0a0f1e', light: '#ffffff' },
    })
      .then(setDataUrl)
      .catch(() => setDataUrl(''));
  }, [address]);

  if (!dataUrl) return null;
  return <img className="qr compact-qr" src={dataUrl} alt="Account address QR code" width="176" height="176" />;
}
