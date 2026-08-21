import { useEffect, useState } from 'react';
import { call, shorten, timeAgo, useAsyncAction } from '../../lib/ui.js';
import { BackBar, CopyButton, EmptyState } from '../components/common.jsx';

const FIAT = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'JPY', 'BRL'];
const AMOUNTS = [50, 100, 250, 500];

/**
 * Fiat on-ramp.
 *
 * ADRIX cannot sell anyone cryptocurrency, and pretending otherwise is what the
 * screen this replaces did. What it can do is the step that actually goes
 * wrong: getting the right address, on the right chain, into the provider
 * without anyone retyping it. Everything after the hand-off — payment, KYC,
 * rates, disputes — is between the user and the provider.
 */
export default function Buy({ state, go }) {
  const [providers, setProviders] = useState(null);
  const [handoffs, setHandoffs] = useState([]);
  const [fiatAmount, setFiatAmount] = useState('100');
  const [fiatCurrency, setFiatCurrency] = useState('USD');
  const [confirming, setConfirming] = useState(null);
  const [keyFor, setKeyFor] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  const account = state.accounts.find((a) => a.address === state.selected);
  const symbol = state.network?.symbol ?? 'ETH';

  const load = async () => {
    const result = await call('ONRAMP_PROVIDERS', { chainId: state.chainId });
    setProviders(result.providers ?? []);
    setHandoffs(result.handoffs ?? []);
  };

  useEffect(() => {
    load().catch(() => {});
  }, [state.chainId]);

  const open = (provider) =>
    run(async () => {
      const result = await call('ONRAMP_URL', {
        providerId: provider.id,
        symbol,
        fiatAmount: Number(fiatAmount) || undefined,
        fiatCurrency,
      });
      await call('ONRAMP_RECORD', {
        providerId: provider.id,
        symbol,
        fiatAmount: Number(fiatAmount) || null,
        fiatCurrency,
      });
      // Opened in a tab rather than navigated to: the popup closes the moment
      // focus leaves it, and a half-loaded provider page in a 380px popup is
      // not somewhere to enter card details.
      window.open(result.url, '_blank', 'noopener,noreferrer');
      setConfirming(null);
      await load();
    });

  const usable = (providers ?? []).filter((provider) => provider.supported);

  if (confirming) {
    return (
      <div className="screen">
        <BackBar title={`Buy via ${confirming.name}`} onBack={() => setConfirming(null)} />
        <div className="scroll pad stack">
          <div className="card accent">
            <div className="eyebrow accent-text">Funds will be sent to</div>
            {/* Shown in full, unabbreviated. This is the address a stranger's
                payment system is about to send money to, and the abbreviated
                form is exactly what an address-poisoning attack survives. */}
            <div className="data-block">{state.selected}</div>
            <div className="kv">
              <span className="kv-key">Account</span>
              <span className="kv-value">{account?.name ?? 'Account'}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Network</span>
              <span className="kv-value">{state.network?.name}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Asset</span>
              <span className="kv-value">{symbol}</span>
            </div>
            <CopyButton value={state.selected} label="Copy address" className="ghost" />
          </div>

          <div className="notice danger">
            <b>Check the network.</b> {confirming.name} will send {symbol} on <b>{state.network?.name}</b>. Funds sent
            on a different network than the one this address is being used on are not lost, but they will not appear
            here until you switch to that network.
          </div>

          <div className="notice">
            You are leaving ADRIX. The purchase, identity checks, payment, and any refund are between you and{' '}
            {confirming.name} — ADRIX is not a party to it, takes no fee, and cannot reverse or chase anything. Your
            address is shared with them and with their payment processor.
          </div>

          {confirming.needsKey && !confirming.hasKey && (
            <div className="notice">
              {confirming.name} requires integrators to hold an API key, which ADRIX does not ship. You will land on
              their entry page and may need to re-enter the amount — the address should still be pre-filled.
            </div>
          )}

          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </button>
            <button className="primary" onClick={() => open(confirming)} disabled={busy}>
              {busy ? 'Opening…' : `Continue to ${confirming.name}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <BackBar title="Buy crypto" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="card">
          <div className="eyebrow">Receiving</div>
          <div className="between">
            <span className="small">
              {account?.name} · {state.network?.name}
            </span>
            <span className="mono small">{shorten(state.selected, 8, 6)}</span>
          </div>
          <p className="small faint">
            ADRIX pre-fills this address at the provider so it never has to be copied by hand — that step is where
            on-ramp money actually goes missing.
          </p>
        </div>

        <div className="card">
          <div className="eyebrow">Amount (optional)</div>
          <div className="input-group">
            <input
              className="mono"
              inputMode="decimal"
              value={fiatAmount}
              onChange={(e) => {
                setFiatAmount(e.target.value.replace(/[^\d.]/g, ''));
                setError('');
              }}
              placeholder="100"
              aria-label="Fiat amount"
            />
            <select value={fiatCurrency} onChange={(e) => setFiatCurrency(e.target.value)} style={{ maxWidth: 96 }}>
              {FIAT.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="row2" style={{ marginTop: 8 }}>
            {AMOUNTS.map((value) => (
              <button
                key={value}
                className="ghost"
                aria-pressed={fiatAmount === String(value)}
                onClick={() => setFiatAmount(String(value))}
              >
                {value}
              </button>
            ))}
          </div>
          <p className="small faint">
            A starting figure only. The provider sets the final rate, fees, and limits — ADRIX has no visibility into
            any of them and does not quote them here.
          </p>
        </div>

        <div className="card">
          <h2>Providers</h2>
          {!providers ? (
            <p className="small faint">Loading…</p>
          ) : !usable.length ? (
            <EmptyState
              icon="＋"
              title={`No provider covers ${state.network?.name}`}
              body="Switch to a major network to buy directly into this wallet."
              action={
                <button className="ghost" onClick={() => go('networks')}>
                  Switch network
                </button>
              }
            />
          ) : (
            <div className="list">
              {usable.map((provider) => (
                <div className="site-row" key={provider.id}>
                  <button className="item" onClick={() => setConfirming(provider)}>
                    <div className="item-main">
                      <span className="item-title">{provider.name}</span>
                      <span className="item-sub">{provider.hint}</span>
                      {provider.needsKey && !provider.hasKey && (
                        <span className="item-sub faint">No integrator key — you may land on their entry page.</span>
                      )}
                    </div>
                    <span className="item-right">
                      {provider.hasKey && <span className="badge confirmed">key set</span>}
                      <span className="caret" aria-hidden="true">
                        ›
                      </span>
                    </span>
                  </button>
                  {provider.needsKey && (
                    <button
                      className="link item-aside"
                      onClick={() => {
                        setKeyFor(keyFor === provider.id ? null : provider.id);
                        setApiKey('');
                      }}
                    >
                      {provider.hasKey ? 'change key' : 'add key'}
                    </button>
                  )}

                  {keyFor === provider.id && (
                    <div className="site-panel stack-sm">
                      <label className="field">
                        <span>{provider.name} API key</span>
                        <input
                          className="mono"
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder="pk_live_…"
                          spellCheck="false"
                        />
                        <span className="small faint">
                          Only a publishable key belongs here. It is stored locally and sent to nobody but{' '}
                          {provider.name}, in the URL.
                        </span>
                      </label>
                      <div className="row2">
                        <button
                          className="ghost"
                          onClick={() =>
                            run(async () => {
                              await call('ONRAMP_SET_KEY', { id: provider.id, apiKey: '' });
                              setKeyFor(null);
                              await load();
                            })
                          }
                        >
                          Clear
                        </button>
                        <button
                          className="primary"
                          disabled={busy || !apiKey.trim()}
                          onClick={() =>
                            run(async () => {
                              await call('ONRAMP_SET_KEY', { id: provider.id, apiKey });
                              setKeyFor(null);
                              setApiKey('');
                              await load();
                            })
                          }
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {handoffs.length > 0 && (
          <div className="card">
            <div className="between">
              <span className="eyebrow">Recent hand-offs</span>
              <button
                className="link"
                onClick={() =>
                  run(async () => {
                    await call('ONRAMP_CLEAR');
                    await load();
                  })
                }
              >
                clear
              </button>
            </div>
            {handoffs.slice(0, 5).map((entry) => (
              <div className="kv" key={entry.id}>
                <span className="kv-key">{entry.provider}</span>
                <span className="kv-value">
                  {entry.fiatAmount ? `${entry.fiatAmount} ${entry.fiatCurrency} · ` : ''}
                  {timeAgo(entry.at)}
                </span>
              </div>
            ))}
            <p className="small faint">
              None of these providers report back to ADRIX, so this is a record that you went to buy — not that a
              purchase completed. Funds appear as a normal incoming balance when they arrive.
            </p>
          </div>
        )}

        {error && <div className="error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
