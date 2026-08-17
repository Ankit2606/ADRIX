import { useEffect, useState } from 'react';
import { formatEther, formatUnits, parseEther, parseUnits } from 'ethers';
import { call, shorten, trimAmount } from '../../lib/ui.js';
import { BackBar } from '../components/common.jsx';

export default function Send({ state, go }) {
  const [portfolio, setPortfolio] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [asset, setAsset] = useState('native');
  const [recipient, setRecipient] = useState('');
  const [resolved, setResolved] = useState('');
  const [amount, setAmount] = useState('');
  const [gasInfo, setGasInfo] = useState(null);
  const [preset, setPreset] = useState('market');
  const [advanced, setAdvanced] = useState(false);
  const [customGasLimit, setCustomGasLimit] = useState('');
  const [customGasPrice, setCustomGasPrice] = useState('');
  const [customMaxFee, setCustomMaxFee] = useState('');
  const [customPriorityFee, setCustomPriorityFee] = useState('');
  const [nonce, setNonce] = useState('');
  const [step, setStep] = useState('form');
  const [hash, setHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sponsorGas, setSponsorGas] = useState(false);
  const [sendTab, setSendTab] = useState('accounts');
  const selectedAccount = state.accounts.find((account) => account.address === state.selected);

  useEffect(() => {
    Promise.all([call('GET_PORTFOLIO'), call('LIST_CONTACTS')])
      .then(([nextPortfolio, nextContacts]) => {
        setPortfolio(nextPortfolio);
        setContacts(nextContacts);
      })
      .catch(() => {});
  }, [state.selected, state.chainId]);

  const token = asset === 'native' ? null : portfolio?.tokens.find((t) => t.address === asset);
  const symbol = token?.symbol ?? portfolio?.native?.symbol ?? '';
  const available = token?.balance ?? portfolio?.native?.balance;
  const favorites = contacts.filter((contact) => contact.favorite);

  const fillMax = async () => {
    setError('');
    if (token) {
      setAmount(String(available ?? ''));
      return;
    }
    if (!recipient.trim()) {
      setError('Enter a recipient first so MiniWallet can estimate gas.');
      return;
    }

    setBusy(true);
    try {
      const { address } = await call('RESOLVE_RECIPIENT', { input: recipient });
      const info = await call('ESTIMATE_GAS', {
        request: { from: state.selected, to: address, value: '0x0', data: '0x' },
      });
      const fee = estimateFeeWei(info.options.market, info.gasLimit);
      const balance = BigInt(portfolio?.native?.raw ?? '0');
      const spendable = balance - fee;
      if (spendable <= 0n) throw new Error('Balance is too low to cover the network fee.');
      setAmount(trimTrailingZeros(formatEther(spendable)));
      setGasInfo(info);
      setCustomGasLimit(info.gasLimit);
      const market = info.options.market;
      if (market.type === 2) {
        setCustomMaxFee(formatGwei(market.maxFeePerGas));
        setCustomPriorityFee(formatGwei(market.maxPriorityFeePerGas));
      } else {
        setCustomGasPrice(formatGwei(market.gasPrice));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    setError('');
    setBusy(true);
    try {
      if (selectedAccount?.type === 'watch') throw new Error('Watch-only accounts cannot send transactions.');
      const { address } = await call('RESOLVE_RECIPIENT', { input: recipient });
      setResolved(address);

      if (!amount || Number(amount) <= 0) throw new Error('Enter an amount greater than zero.');

      const request = token
        ? {
            from: state.selected,
            to: token.address,
            value: '0x0',
            data: (await call('ENCODE_TRANSFER', { to: address, amount, decimals: token.decimals })).data,
          }
        : { from: state.selected, to: address, value: '0x' + parseEther(amount).toString(16), data: '0x' };

      const info = await call('ESTIMATE_GAS', { request });
      setGasInfo(info);
      setCustomGasLimit(info.gasLimit);
      const market = info.options.market;
      if (market.type === 2) {
        setCustomMaxFee(formatGwei(market.maxFeePerGas));
        setCustomPriorityFee(formatGwei(market.maxPriorityFeePerGas));
      } else {
        setCustomGasPrice(formatGwei(market.gasPrice));
      }
      setStep('review');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const fees = advanced ? buildCustomFees(gasInfo, customGasPrice, customMaxFee, customPriorityFee) : gasInfo.options[preset];
      const gas = advanced ? validateGasLimit(customGasLimit) : gasInfo.gasLimit;
      const customNonce = advanced ? validateNonce(nonce) : undefined;
      const result = token
        ? await call('SEND_TOKEN', {
            from: state.selected,
            token,
            to: resolved,
            amount,
            fees,
            gas,
            nonce: customNonce,
          })
        : await call('SEND_TRANSACTION', {
            request: {
              from: state.selected,
              to: resolved,
              value: '0x' + parseEther(amount).toString(16),
              data: '0x',
              gas,
              fees,
              nonce: customNonce,
            },
          });
      setHash(result.hash);
      setStep('sent');
    } catch (err) {
      setError(err.message);
      setStep('review');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'sent') {
    return (
      <div className="screen">
        <BackBar title="Sent" onBack={() => go('home')} />
        <div className="scroll pad stack">
          <div className="beam" />
          <h1>Transaction submitted</h1>
          <p>It is in the mempool now. The activity list will update when it confirms.</p>
          <div className="data-block">{hash}</div>
          {portfolio?.network?.explorer && (
            <a
              className="link accent"
              href={`${portfolio.network.explorer}/tx/${hash}`}
              target="_blank"
              rel="noreferrer"
            >
              Open in block explorer
            </a>
          )}
          <div className="spacer" />
          <button className="primary" onClick={() => go('home')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (step === 'review') {
    const fees = advanced
      ? safeCustomFees(gasInfo, customGasPrice, customMaxFee, customPriorityFee) ?? gasInfo.options[preset]
      : gasInfo.options[preset];
    const estimatedFee = estimateNetworkFee(fees, advanced ? customGasLimit : gasInfo.gasLimit);
    return (
      <div className="screen">
        <BackBar title="Review" onBack={() => setStep('form')} />
        <div className="scroll pad stack">
          <div className="eyebrow">Sending</div>
          <div className="balance">
            {amount}
            <span>{symbol}</span>
          </div>

          <div className="card">
            <div className="between">
              <span className="small">To</span>
              <span className="mono small">{shorten(resolved, 10, 8)}</span>
            </div>
            <div className="between">
              <span className="small">Network</span>
              <span className="mono small">{portfolio?.network?.name}</span>
            </div>
            <div className="between">
              <span className="small">Gas limit</span>
              <span className="mono small">{advanced ? customGasLimit : gasInfo.gasLimit}</span>
            </div>
            <div className="between">
              <span className="small">Network fee</span>
              <span className="mono small" style={{ textDecoration: sponsorGas ? 'line-through' : 'none' }}>
                ~{trimAmount(estimatedFee, 6)} {gasInfo.symbol}
              </span>
            </div>
            {sponsorGas && (
              <div className="between">
                <span className="small">Paymaster</span>
                <span className="mono small" style={{ color: 'var(--accent)' }}>Sponsored (Free)</span>
              </div>
            )}
            {selectedAccount?.type === 'smart' && (
              <div style={{ marginTop: 8 }}>
                <label className="inline small" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={sponsorGas}
                    onChange={(e) => setSponsorGas(e.target.checked)}
                    style={{ width: 14, height: 14, flex: 'none', marginRight: 8 }}
                  />
                  Sponsor transaction (ERC-4337 Paymaster)
                </label>
              </div>
            )}
            {advanced && nonce && (
              <div className="between">
                <span className="small">Nonce</span>
                <span className="mono small">{nonce}</span>
              </div>
            )}
          </div>

          {advanced && (
            <div className="stack-sm">
              <label className="field">
                <span>Gas limit</span>
                <input
                  className="mono"
                  inputMode="numeric"
                  value={customGasLimit}
                  onChange={(e) => setCustomGasLimit(e.target.value)}
                />
              </label>
              {gasInfo.supportsEip1559 ? (
                <div className="row2">
                  <label className="field">
                    <span>Max fee (gwei)</span>
                    <input
                      className="mono"
                      inputMode="decimal"
                      value={customMaxFee}
                      onChange={(e) => setCustomMaxFee(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Priority fee (gwei)</span>
                    <input
                      className="mono"
                      inputMode="decimal"
                      value={customPriorityFee}
                      onChange={(e) => setCustomPriorityFee(e.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <label className="field">
                  <span>Gas price (gwei)</span>
                  <input
                    className="mono"
                    inputMode="decimal"
                    value={customGasPrice}
                    onChange={(e) => setCustomGasPrice(e.target.value)}
                  />
                </label>
              )}
              <label className="field">
                <span>Nonce (optional)</span>
                <input
                  className="mono"
                  inputMode="numeric"
                  placeholder="Use next pending nonce"
                  value={nonce}
                  onChange={(e) => setNonce(e.target.value)}
                />
              </label>
            </div>
          )}

          <h3>Fee speed</h3>
          <div className="gas-grid">
            {['low', 'market', 'fast'].map((key) => (
              <button
                key={key}
                className="gas-option"
                aria-pressed={!advanced && preset === key}
                onClick={() => setPreset(key)}
              >
                <b>{key === 'low' ? 'Slow' : key === 'market' ? 'Market' : 'Fast'}</b>
                <span>~{trimAmount(gasInfo.options[key].estimatedFee, 6)}</span>
              </button>
            ))}
          </div>

          {gasInfo.estimateError && (
            <div className="notice">
              Gas could not be simulated: {gasInfo.estimateError}. This often means the transaction would revert.
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => setStep('form')}>
              Back
            </button>
            <button className="primary" onClick={confirm} disabled={busy}>
              {busy ? 'Sending...' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'amount') {
    return (
      <div className="screen">
        <BackBar title="Send" onBack={() => setStep('form')} />
        <div className="scroll pad stack">
          {selectedAccount?.type === 'watch' && (
            <div className="notice">This is a watch-only account. MiniWallet can show balances, but it cannot sign transactions.</div>
          )}
          <label className="field">
            <span>Asset</span>
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="native">
                {portfolio?.native?.symbol ?? 'Native'} - {trimAmount(portfolio?.native?.balance)}
              </option>
              {(portfolio?.tokens ?? []).map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol} - {trimAmount(t.balance)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Amount</span>
            <div className="inline">
              <input
                className="mono"
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button className="ghost" style={{ flex: 'none' }} onClick={fillMax} disabled={busy || selectedAccount?.type === 'watch'}>
                Max
              </button>
            </div>
            <span className="small">
              Available {trimAmount(available)} {symbol}
            </span>
          </label>

          {!token && <p className="small">Max sends your balance minus the estimated market network fee.</p>}

          <label className="inline small" style={{ color: 'var(--muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={advanced}
              onChange={(e) => setAdvanced(e.target.checked)}
              style={{ width: 16, height: 16, flex: 'none' }}
            />
            Advanced controls
          </label>

          {advanced && (
            <label className="field">
              <span>Nonce (optional)</span>
              <input
                className="mono"
                inputMode="numeric"
                placeholder="Use next pending nonce"
                value={nonce}
                onChange={(e) => setNonce(e.target.value)}
              />
            </label>
          )}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="footer">
          <button className="primary" onClick={review} disabled={busy || !recipient || !amount || selectedAccount?.type === 'watch'}>
            {busy ? 'Estimating...' : 'Review'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="mm-topbar" style={{ justifyContent: 'center', position: 'relative' }}>
        <button className="icon-btn" onClick={() => go('home')} style={{ position: 'absolute', left: 16 }}>
          &lt;
        </button>
        <h2 style={{ fontSize: 16 }}>Send</h2>
      </header>

      <div className="scroll pad">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>From</div>
        <div className="mm-send-from-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg, #1e3a8a, #047857)', position: 'relative' }}></div>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text)' }}>{selectedAccount?.name ?? 'Account'}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{shorten(state.selected)}</div>
            </div>
          </div>
          <span style={{ color: 'var(--text)' }}>⌄</span>
        </div>

        <div style={{ fontWeight: 600, marginBottom: 8 }}>To</div>
        <div className="mm-send-input-card">
          <input 
            placeholder="Enter public address (0x) or domain name"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
          <span style={{ color: 'var(--text)', cursor: 'pointer', fontSize: 20 }}>▤</span>
        </div>

        <div className="mm-tabs">
          <button className={`mm-tab ${sendTab === 'accounts' ? 'active' : ''}`} onClick={() => setSendTab('accounts')}>Your accounts</button>
          <button className={`mm-tab ${sendTab === 'contacts' ? 'active' : ''}`} onClick={() => setSendTab('contacts')}>Contacts</button>
        </div>

        <div className="list" style={{ marginTop: 8 }}>
          {sendTab === 'accounts' && state.accounts.map((acc, i) => (
            <div 
              key={acc.address} 
              className={`mm-send-account-item ${acc.address === recipient ? 'active' : ''}`}
              onClick={() => setRecipient(acc.address)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: i % 2 === 0 ? 'linear-gradient(135deg, #1e3a8a, #047857)' : 'linear-gradient(135deg, #ea580c, #2563eb)', position: 'relative' }}>
                  <div style={{ position: 'absolute', bottom: -2, right: -2, width: 10, height: 10, background: '#9CA3AF', borderRadius: '50%', border: '2px solid var(--surface-2)' }}></div>
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>{acc.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{shorten(acc.address)}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 14 }}>{trimAmount(portfolio?.native?.balance)} {portfolio?.native?.symbol ?? 'SepoliaETH'}</div>
                <div style={{ fontSize: 10, marginTop: 4, display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                  <span className="mm-circle-icon" style={{ background: '#f59e0b', color: '#fff', width: 14, height: 14 }}>B</span>
                  <span className="mm-circle-icon" style={{ background: '#3b82f6', color: '#fff', width: 14, height: 14 }}>A</span>
                  <span style={{ color: 'var(--muted)' }}>+2</span>
                </div>
              </div>
            </div>
          ))}
          {sendTab === 'contacts' && (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)' }}>No contacts found</div>
          )}
        </div>
      </div>

      <div className="footer" style={{ borderTop: 'none', padding: 16 }}>
        <div className="row2">
          <button className="ghost" style={{ border: '1px solid var(--line)', borderRadius: 24, padding: '12px 0' }} onClick={() => go('home')}>Cancel</button>
          <button className="primary" style={{ borderRadius: 24, padding: '12px 0', background: '#3b82f6', color: 'white' }} onClick={() => { if(recipient) setStep('amount'); }} disabled={!recipient}>Continue</button>
        </div>
      </div>
    </div>
  );
}

function validateGasLimit(value) {
  const trimmed = String(value ?? '').trim();
  if (!/^\d+$/.test(trimmed) || BigInt(trimmed) <= 0n) {
    throw new Error('Enter a valid gas limit.');
  }
  return trimmed;
}

function validateNonce(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) throw new Error('Enter a valid nonce.');

  const number = Number(trimmed);
  if (!Number.isSafeInteger(number)) throw new Error('Nonce is too large.');
  return number;
}

function parseGweiInput(value, label) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || Number(trimmed) <= 0) throw new Error(`Enter a valid ${label}.`);
  return parseUnits(trimmed, 'gwei').toString();
}

function buildCustomFees(gasInfo, gasPrice, maxFee, priorityFee) {
  if (gasInfo.supportsEip1559) {
    const maxFeePerGas = parseGweiInput(maxFee, 'max fee');
    const maxPriorityFeePerGas = parseGweiInput(priorityFee, 'priority fee');
    if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
      throw new Error('Priority fee cannot be higher than max fee.');
    }
    return { type: 2, maxFeePerGas, maxPriorityFeePerGas };
  }
  return { type: 0, gasPrice: parseGweiInput(gasPrice, 'gas price') };
}

function safeCustomFees(gasInfo, gasPrice, maxFee, priorityFee) {
  try {
    return buildCustomFees(gasInfo, gasPrice, maxFee, priorityFee);
  } catch {
    return null;
  }
}

function formatGwei(value) {
  try {
    return trimTrailingZeros(formatUnits(BigInt(value), 'gwei'));
  } catch {
    return '';
  }
}

function trimTrailingZeros(value) {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function estimateNetworkFee(fees, gasLimit) {
  try {
    return formatEther(estimateFeeWei(fees, gasLimit));
  } catch {
    return fees.estimatedFee;
  }
}

function estimateFeeWei(fees, gasLimit) {
  const limit = BigInt(validateGasLimit(gasLimit));
  const price = fees.maxFeePerGas ? BigInt(fees.maxFeePerGas) : BigInt(fees.gasPrice);
  return limit * price;
}
