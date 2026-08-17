import { useEffect, useState } from 'react';
import { call, shorten, timeAgo } from '../../lib/ui.js';
import { BackBar, PasswordPrompt, Avatar } from '../components/common.jsx';

export default function Settings({ state, go, refresh }) {
  const [panel, setPanel] = useState(null);
  const [mnemonic, setMnemonic] = useState('');
  const [message, setMessage] = useState('');

  return (
    <div className="screen">
      <BackBar title="Settings" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <section className="card">
          <h2>Security</h2>

          <AutoLockControls minutes={state.autoLockMinutes} refresh={refresh} />

          <div className="row2">
            <button className="ghost" onClick={() => setPanel(panel === 'password' ? null : 'password')}>
              Change password
            </button>
            <button
              className="ghost"
              disabled={!state.hasRecoveryPhrase}
              title={state.hasRecoveryPhrase ? 'Reveal recovery phrase' : 'This wallet was imported from a private key'}
              onClick={() => setPanel(panel === 'mnemonic' ? null : 'mnemonic')}
            >
              Recovery phrase
            </button>
          </div>

          {!state.hasRecoveryPhrase && (
            <p className="small">
              This wallet was imported from a private key, so MiniWallet does not have a recovery phrase to reveal.
            </p>
          )}

          {panel === 'password' && <ChangePassword onDone={() => { setPanel(null); setMessage('Password changed.'); }} />}

          {panel === 'mnemonic' &&
            (mnemonic ? (
              <>
                <div className="data-block">{mnemonic}</div>
                <div className="notice">Anyone with these words owns every account derived from them.</div>
                <button className="ghost" onClick={() => { setMnemonic(''); setPanel(null); }}>
                  Hide
                </button>
              </>
            ) : (
              <PasswordPrompt
                cta="Reveal phrase"
                onCancel={() => setPanel(null)}
                onSubmit={async (password) => {
                  const result = await call('REVEAL_MNEMONIC', { password });
                  setMnemonic(result.mnemonic);
                }}
              />
            ))}

          {message && <div className="ok">{message}</div>}
        </section>

        <section className="card">
          <h2>Session Keys & Limits</h2>
          <p className="small">Set temporary spending limits to allow dApps to process transactions automatically without prompting you every time.</p>
          <div className="row2" style={{ marginTop: 8 }}>
            <button className="ghost" onClick={() => setPanel(panel === 'session' ? null : 'session')}>
              Configure Limits
            </button>
          </div>
          
          {panel === 'session' && (
            <div className="site-panel stack-sm">
              <label className="field">
                <span>Maximum spend limit (USD)</span>
                <input type="number" placeholder="100" />
              </label>
              <label className="field">
                <span>Session duration</span>
                <select>
                  <option>1 Hour</option>
                  <option>4 Hours</option>
                  <option>24 Hours</option>
                </select>
              </label>
              <div className="notice" style={{ marginTop: 8 }}>
                Mock: Setting these limits will deploy a session key module for your smart account.
              </div>
              <button className="primary" onClick={() => setPanel(null)}>
                Save Session Config
              </button>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Social Recovery (Guardians)</h2>
          <p className="small">Set up trusted friends, family, or devices to help recover your smart accounts if you lose access.</p>
          <div className="row2" style={{ marginTop: 8 }}>
            <button className="ghost" onClick={() => setPanel(panel === 'guardians' ? null : 'guardians')}>
              Manage Guardians
            </button>
          </div>
          
          {panel === 'guardians' && (
            <div className="site-panel stack-sm">
              <label className="field">
                <span>Guardian 1 (Address or ENS)</span>
                <input className="mono" placeholder="0x..." />
              </label>
              <label className="field">
                <span>Guardian 2 (Address or ENS)</span>
                <input className="mono" placeholder="0x..." />
              </label>
              <label className="field">
                <span>Guardian 3 (Address or ENS)</span>
                <input className="mono" placeholder="0x..." />
              </label>
              <div className="notice" style={{ marginTop: 8 }}>
                Mock: Adding these guardians will deploy a social recovery module to your smart account. A minimum of 2 out of 3 guardians will be required to approve a wallet recovery.
              </div>
              <button className="primary" onClick={() => setPanel(null)}>
                Save Guardians
              </button>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Push Notifications</h2>
          <p className="small">Receive system alerts when transactions are sent or when you receive incoming transfers.</p>
          <div className="row2" style={{ marginTop: 8 }}>
            <button 
              className="ghost" 
              onClick={() => {
                if (typeof chrome !== 'undefined' && chrome.notifications) {
                  chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'icons/icon48.png',
                    title: 'Incoming Transfer Detected',
                    message: 'You received 0.05 ETH from 0x7a2...3f1'
                  });
                } else {
                  alert('Incoming notification triggered (requires extension environment).');
                }
              }}
            >
              Simulate Incoming
            </button>
          </div>
        </section>

        <section className="card">
          <h2>Appearance</h2>
          <div className="tabs" role="tablist">
            {['dark', 'light'].map((theme) => (
              <button
                key={theme}
                role="tab"
                aria-selected={(state.theme ?? 'dark') === theme}
                onClick={async () => {
                  await call('SET_THEME', { theme });
                  refresh();
                }}
              >
                {theme === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Connected sites</h2>
          {state.sites.length === 0 ? (
            <p className="small">No sites are connected. Open a dApp and click its connect button.</p>
          ) : (
            <div className="list">
              {state.sites.map((site) => (
                <ConnectedSite
                  key={site.origin}
                  site={site}
                  accounts={state.accounts}
                  networks={state.networks}
                  currentChainId={state.chainId}
                  open={panel === `site:${site.origin}`}
                  onToggle={() => setPanel(panel === `site:${site.origin}` ? null : `site:${site.origin}`)}
                  refresh={refresh}
                />
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h2>WalletConnect</h2>
          <p className="small">Connect to dApps across devices by pasting a WalletConnect pairing URI.</p>
          <div className="row2" style={{ marginTop: 8 }}>
            <input 
              placeholder="wc:..." 
              style={{ flex: 1, padding: '8px' }} 
              id="wc-uri" 
            />
            <button 
              className="primary" 
              onClick={() => {
                const uri = document.getElementById('wc-uri').value;
                if (!uri.startsWith('wc:')) return alert('Invalid WalletConnect URI. Must start with wc:');
                alert('WalletConnect Mock: Paired successfully with ' + uri.slice(0, 16) + '...');
                document.getElementById('wc-uri').value = '';
              }}
            >
              Pair
            </button>
          </div>
        </section>

        <DappHistory history={state.connectionHistory ?? []} networks={state.networks} />

        <AddressBook contacts={state.contacts ?? []} refresh={refresh} />

        <section className="card">
          <h2>Danger zone</h2>
          <p className="small">
            Erasing removes the encrypted vault, accounts, tokens, and activity from this browser. Only your recovery
            phrase can bring the accounts back.
          </p>
          {panel === 'wipe' ? (
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
          ) : (
            <button className="danger" onClick={() => setPanel('wipe')}>
              Erase wallet
            </button>
          )}
        </section>

        <div className="center small" style={{ color: 'var(--faint)' }}>
          MiniWallet 0.2.0 · testnet use only
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

function AutoLockControls({ minutes, refresh }) {
  const [custom, setCustom] = useState(minutes > 0 ? String(minutes) : '');

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
          <button
            className="ghost"
            key={value}
            aria-pressed={minutes === value}
            onClick={() => setMinutes(value)}
          >
            {value === 60 ? '1 hr' : `${value} min`}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Custom minutes</span>
        <div className="inline">
          <input
            className="mono"
            inputMode="numeric"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="15"
          />
          <button
            className="ghost"
            style={{ flex: 'none' }}
            onClick={() => {
              const parsed = Number(custom);
              if (Number.isInteger(parsed) && parsed > 0) setMinutes(parsed);
            }}
          >
            Set
          </button>
        </div>
      </label>
      <button className="ghost" onClick={() => setMinutes(0)}>
        Disable auto-lock
      </button>
      <p className="small">The wallet still locks when the browser clears extension session storage.</p>
    </div>
  );
}

function AddressBook({ contacts, refresh }) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="card">
      <div className="between">
        <h2>Address book</h2>
        <button className="link" onClick={() => setAdding(!adding)}>
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

      {!contacts.length && !adding ? (
        <p className="small">Save trusted recipients here so you do not have to paste addresses every time.</p>
      ) : (
        <div className="list">
          {contacts.map((contact) => (
            <ContactRow key={contact.id} contact={contact} refresh={refresh} />
          ))}
        </div>
      )}
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
      <Avatar address={contact.address} />
      <div className="item-main">
        <span className="item-title">
          {contact.favorite ? '* ' : ''}
          {contact.name}
        </span>
        <span className="item-sub">
          {contact.label ? `${contact.label} · ` : ''}
          {shorten(contact.address, 10, 8)}
        </span>
      </div>
      <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
        <button
          className="link accent"
          onClick={async () => {
            await call('TOGGLE_CONTACT_FAVORITE', { id: contact.id });
            await refresh();
          }}
        >
          {contact.favorite ? 'unfavorite' : 'favorite'}
        </button>
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
      </div>
    </div>
  );
}

function ContactForm({ contact = {}, cta, onCancel, onSubmit }) {
  const [name, setName] = useState(contact.name ?? '');
  const [address, setAddress] = useState(contact.address ?? '');
  const [label, setLabel] = useState(contact.label ?? '');
  const [favorite, setFavorite] = useState(Boolean(contact.favorite));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit({ name, address, label, favorite });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Address</span>
        <input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck="false" />
      </label>
      <label className="field">
        <span>Label (optional)</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Exchange, friend, cold wallet" />
      </label>
      <label className="inline small" style={{ color: 'var(--muted)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={favorite}
          onChange={(e) => setFavorite(e.target.checked)}
          style={{ width: 16, height: 16, flex: 'none' }}
        />
        Favorite recipient
      </label>
      {error && <div className="error">{error}</div>}
      <div className="row2">
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" onClick={submit} disabled={busy || !name || !address}>
          {busy ? 'Saving...' : cta}
        </button>
      </div>
    </div>
  );
}

function ConnectedSite({ site, accounts, networks, currentChainId, open, onToggle, refresh }) {
  const [selected, setSelected] = useState(site.accounts);
  const [selectedNetworks, setSelectedNetworks] = useState(site.networks ?? []);
  const [error, setError] = useState('');
  const siteLabel = site.origin.replace(/^https?:\/\//, '');
  const networkList = Object.values(networks);

  useEffect(() => {
    setSelected(site.accounts);
    setSelectedNetworks(site.networks ?? []);
  }, [site.accounts, site.networks]);

  const toggleAccount = (address) => {
    setSelected((current) =>
      current.some((item) => item.toLowerCase() === address.toLowerCase())
        ? current.filter((item) => item.toLowerCase() !== address.toLowerCase())
        : [...current, address]
    );
  };

  const toggleNetwork = (chainId) => {
    setSelectedNetworks((current) =>
      current.includes(chainId) ? current.filter((item) => item !== chainId) : [...current, chainId]
    );
  };

  const save = async () => {
    setError('');
    try {
      await call('UPDATE_SITE_ACCOUNTS', { origin: site.origin, accounts: selected });
      await call('UPDATE_SITE_NETWORKS', { origin: site.origin, networks: selectedNetworks });
      await refresh();
      onToggle();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="site-row">
      <button className="item" onClick={onToggle}>
        <div className="item-main">
          <span className="item-title">{siteLabel}</span>
          <span className="item-sub">
            {site.accounts.length} account{site.accounts.length === 1 ? '' : 's'} · {site.networks?.length ?? 0}{' '}
            network{site.networks?.length === 1 ? '' : 's'}
          </span>
        </div>
        <span className="link">{open ? 'close' : 'manage'}</span>
      </button>

      {open && (
        <div className="site-panel stack-sm">
          <div className="eyebrow">Accounts</div>
          {accounts.map((account) => (
            <button className="item compact" key={account.address} onClick={() => toggleAccount(account.address)}>
              <input
                type="checkbox"
                readOnly
                checked={selected.some((address) => address.toLowerCase() === account.address.toLowerCase())}
                style={{ width: 16, height: 16, flex: 'none' }}
              />
              <Avatar address={account.address} />
              <div className="item-main">
                <span className="item-title">{account.name}</span>
                <span className="item-sub">{account.address}</span>
              </div>
            </button>
          ))}
          <div className="eyebrow">Networks</div>
          {networkList.map((network) => (
            <button className="item compact" key={network.chainId} onClick={() => toggleNetwork(network.chainId)}>
              <input
                type="checkbox"
                readOnly
                checked={selectedNetworks.includes(network.chainId)}
                style={{ width: 16, height: 16, flex: 'none' }}
              />
              <span
                className="dot"
                style={{ background: network.chainId === currentChainId ? 'var(--accent)' : 'var(--line)' }}
              />
              <div className="item-main">
                <span className="item-title">{network.name}</span>
                <span className="item-sub">
                  {network.chainId} · {network.symbol}
                </span>
              </div>
            </button>
          ))}
          {error && <div className="error">{error}</div>}
          <div className="row2">
            <button
              className="danger"
              onClick={async () => {
                await call('DISCONNECT_SITE', { origin: site.origin });
                await refresh();
                onToggle();
              }}
            >
              Disconnect
            </button>
            <button className="primary" onClick={save} disabled={!selected.length || !selectedNetworks.length}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DappHistory({ history, networks }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? history : history.slice(0, 6);

  return (
    <section className="card">
      <div className="between">
        <h2>DApp history</h2>
        {history.length > 6 && (
          <button className="link" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'show less' : 'show all'}
          </button>
        )}
      </div>
      {!history.length ? (
        <p className="small">Connection and permission changes will appear here.</p>
      ) : (
        <div className="list">
          {visible.map((entry) => (
            <div className="item static" key={entry.id}>
              <div className="item-main">
                <span className="item-title">{entry.origin.replace(/^https?:\/\//, '')}</span>
                <span className="item-sub">
                  {describeHistory(entry, networks)} · {timeAgo(entry.at)}
                </span>
              </div>
            </div>
          ))}
        </div>
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

function ChangePassword({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="stack-sm">
      <label className="field">
        <span>Current password</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        <span>New password</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      {error && <div className="error">{error}</div>}
      <button
        className="primary"
        disabled={busy || next.length < 8}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await call('CHANGE_PASSWORD', { current, next });
            onDone();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Re-encrypting...' : 'Change password'}
      </button>
    </div>
  );
}
