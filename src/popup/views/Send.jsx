import { useEffect, useMemo, useState } from 'react';
import { formatEther, formatUnits, parseEther, parseUnits } from 'ethers';
import {
  call,
  shorten,
  trimAmount,
  formatFiat,
  currencySymbol,
  useDebounced,
  useAsyncAction,
} from '../../lib/ui.js';
import { BackBar, Avatar, QrScanner, EmptyState, Skeleton } from '../components/common.jsx';

export default function Send({ state, go }) {
  const [portfolio, setPortfolio] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [contacts, setContacts] = useState([]);
  const [asset, setAsset] = useState('native');
  const [recipient, setRecipient] = useState('');
  const [resolved, setResolved] = useState('');
  const [amount, setAmount] = useState('');
  const [entryMode, setEntryMode] = useState('token'); // 'token' | 'fiat'
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
  const [scanning, setScanning] = useState(false);
  const [sendTab, setSendTab] = useState('accounts');
  const [inspection, setInspection] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [uriNotice, setUriNotice] = useState('');
  // Set when the amount came from "Max". The spendable balance depends on the
  // fee, so the amount has to be recomputed whenever the fee changes — leaving
  // a stale Max amount is how a send-all silently exceeds the balance.
  const [maxMode, setMaxMode] = useState(false);
  const [nonceInfo, setNonceInfo] = useState(null);

  const { busy, error, setError, run } = useAsyncAction();
  const selectedAccount = state.accounts.find((account) => account.address === state.selected);
  const currency = portfolio?.currency ?? state.currency ?? 'usd';

  const load = async () => {
    try {
      const [nextPortfolio, nextContacts] = await Promise.all([call('GET_PORTFOLIO'), call('LIST_CONTACTS')]);
      setPortfolio(nextPortfolio);
      setContacts(nextContacts);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [state.selected, state.chainId]);

  const token = asset === 'native' ? null : portfolio?.tokens.find((t) => t.address === asset);
  const symbol = token?.symbol ?? portfolio?.native?.symbol ?? '';
  const available = token?.balance ?? portfolio?.native?.balance;
  const unitPrice = token ? token.price : portfolio?.native?.price;

  // --- live recipient validation -------------------------------------------
  const debouncedRecipient = useDebounced(recipient, 450);

  useEffect(() => {
    let cancelled = false;
    if (!debouncedRecipient.trim()) {
      setInspection(null);
      return undefined;
    }
    setInspecting(true);
    call('INSPECT_RECIPIENT', { input: debouncedRecipient })
      .then((result) => !cancelled && setInspection(result))
      .catch(() => !cancelled && setInspection(null))
      .finally(() => !cancelled && setInspecting(false));
    return () => {
      cancelled = true;
    };
  }, [debouncedRecipient]);

  /**
   * Accepts a raw address, an ENS name, or an EIP-681 payment link. Links carry
   * an amount and sometimes a chain, so they pre-fill the rest of the form.
   */
  const applyRecipientInput = async (raw) => {
    const text = String(raw ?? '').trim();
    setUriNotice('');

    if (/^ethereum:/i.test(text)) {
      const { parsed } = await call('PARSE_PAYMENT_URI', { input: text });
      if (!parsed) {
        setError('That payment link could not be read.');
        return;
      }

      if (parsed.chainId && parsed.chainId !== state.chainId) {
        const name = state.allNetworks?.[parsed.chainId]?.name ?? parsed.chainId;
        setUriNotice(`This link is for ${name}. Switch networks before sending.`);
      }

      if (parsed.kind === 'native') {
        setAsset('native');
        setRecipient(parsed.to);
        if (parsed.valueWei) {
          setEntryMode('token');
          setAmount(trimTrailingZeros(formatEther(BigInt(parsed.valueWei))));
        }
        if (parsed.gasLimit) {
          setAdvanced(true);
          setCustomGasLimit(String(parsed.gasLimit));
        }
        setStep('amount');
        return;
      }

      // ERC-20 transfer link: only usable if that token is tracked, because the
      // decimals needed to render the amount come from the token record.
      const known = portfolio?.tokens.find(
        (t) => t.address.toLowerCase() === parsed.tokenAddress.toLowerCase()
      );
      if (!known) {
        setError(`That link pays a token ADRIX does not track yet (${shorten(parsed.tokenAddress)}). Add it first.`);
        return;
      }
      setAsset(known.address);
      if (parsed.to) setRecipient(parsed.to);
      if (parsed.amountRaw) {
        setEntryMode('token');
        setAmount(trimTrailingZeros(formatUnits(BigInt(parsed.amountRaw), known.decimals)));
      }
      setStep('amount');
      return;
    }

    setRecipient(text);
  };

  // --- amount helpers -------------------------------------------------------
  const tokenAmount = useMemo(() => {
    if (entryMode === 'token') return amount;
    if (!amount || !unitPrice) return '';
    const converted = Number(amount) / unitPrice;
    if (!Number.isFinite(converted)) return '';
    return trimTrailingZeros(converted.toFixed(token?.decimals ?? 18));
  }, [amount, entryMode, unitPrice, token]);

  const fiatAmount = useMemo(() => {
    if (entryMode === 'fiat') return amount;
    if (!amount || !unitPrice) return '';
    const value = Number(amount) * unitPrice;
    return Number.isFinite(value) ? value.toFixed(2) : '';
  }, [amount, entryMode, unitPrice]);

  const fillMax = () =>
    run(async () => {
      if (token) {
        setEntryMode('token');
        setAmount(String(available ?? ''));
        return;
      }
      if (!recipient.trim()) throw new Error('Enter a recipient first so ADRIX can estimate gas.');

      const { address } = await call('RESOLVE_RECIPIENT', { input: recipient });
      const info = await call('ESTIMATE_GAS', {
        request: { from: state.selected, to: address, value: '0x0', data: '0x' },
      });
      const fee = estimateFeeWei(info.options[preset] ?? info.options.market, info.gasLimit);
      const balance = BigInt(portfolio?.native?.raw ?? '0');
      const spendable = balance - fee;
      if (spendable <= 0n) throw new Error('Balance is too low to cover the network fee.');

      setEntryMode('token');
      setAmount(trimTrailingZeros(formatEther(spendable)));
      setMaxMode(true);
      applyGasInfo(info);
    });

  const applyGasInfo = (info) => {
    setGasInfo(info);
    setCustomGasLimit(info.gasLimit);
    const market = info.options.market;
    if (market.type === 2) {
      setCustomMaxFee(formatGwei(market.maxFeePerGas));
      setCustomPriorityFee(formatGwei(market.maxPriorityFeePerGas));
    } else {
      setCustomGasPrice(formatGwei(market.gasPrice));
    }
  };

  // The fee the transaction will actually be submitted with, given the current
  // preset or the hand-entered values.
  const activeFees = useMemo(() => {
    if (!gasInfo) return null;
    if (!advanced) return gasInfo.options[preset];
    return safeCustomFees(gasInfo, customGasPrice, customMaxFee, customPriorityFee) ?? gasInfo.options[preset];
  }, [gasInfo, advanced, preset, customGasPrice, customMaxFee, customPriorityFee]);

  const activeGasLimit = advanced ? customGasLimit : gasInfo?.gasLimit;

  // Send-all is a function of the fee, so changing the fee has to move the
  // amount with it. Without this the amount stays at the old maximum and the
  // send fails on insufficient funds at broadcast time.
  useEffect(() => {
    if (!maxMode || token || !gasInfo || !activeFees) return;
    try {
      const fee = estimateFeeWei(activeFees, activeGasLimit);
      const spendable = BigInt(portfolio?.native?.raw ?? '0') - fee;
      const next = spendable > 0n ? trimTrailingZeros(formatEther(spendable)) : '0';
      setEntryMode('token');
      setAmount((current) => (current === next ? current : next));
    } catch {
      /* an unparseable custom fee is reported by the validator instead */
    }
  }, [maxMode, token, gasInfo, activeFees, activeGasLimit, portfolio?.native?.raw]);

  // Live fee sanity check against the current base fee.
  const feeCheck = useMemo(() => {
    if (!gasInfo || !activeFees) return null;
    return validateFeesLocal(activeFees, gasInfo);
  }, [gasInfo, activeFees]);

  // Nonce state is only meaningful once a real account is in play, and only
  // needed on the screens that can change it.
  useEffect(() => {
    if (step === 'form' || !state.selected) return undefined;
    let cancelled = false;
    call('GET_NONCE_INFO', { address: state.selected })
      .then((info) => !cancelled && setNonceInfo(info))
      .catch(() => !cancelled && setNonceInfo(null));
    return () => {
      cancelled = true;
    };
  }, [step, state.selected, state.chainId]);

  const nonceStatus = useMemo(() => {
    if (!advanced || !nonce.trim() || !nonceInfo) return null;
    const entered = Number(nonce);
    if (!Number.isInteger(entered) || entered < 0) return null;

    if (entered < nonceInfo.confirmed) {
      return { tone: 'error', message: `Nonce ${entered} is already confirmed on chain. This will be rejected.` };
    }
    if (nonceInfo.pendingNonces.includes(entered)) {
      return { tone: 'warn', message: `This replaces your pending transaction at nonce ${entered}.` };
    }
    if (entered > nonceInfo.next) {
      return {
        tone: 'warn',
        message: `Nonce ${entered} leaves a gap after ${nonceInfo.next}. It stays queued until ${
          entered - nonceInfo.next === 1 ? `nonce ${nonceInfo.next} is` : `nonces ${nonceInfo.next}–${entered - 1} are`
        } used.`,
      };
    }
    return { tone: 'ok', message: `Nonce ${entered} is the next one in sequence.` };
  }, [advanced, nonce, nonceInfo]);

  const review = () =>
    run(async () => {
      if (selectedAccount?.type === 'watch') throw new Error('Watch-only accounts cannot send transactions.');

      const { address } = await call('RESOLVE_RECIPIENT', { input: recipient });
      setResolved(address);

      const value = tokenAmount;
      if (!value || Number(value) <= 0) throw new Error('Enter an amount greater than zero.');
      if (Number(value) > Number(available ?? 0)) {
        throw new Error(`That is more than the ${trimAmount(available)} ${symbol} available.`);
      }

      const request = token
        ? {
            from: state.selected,
            to: token.address,
            value: '0x0',
            data: (await call('ENCODE_TRANSFER', { to: address, amount: value, decimals: token.decimals })).data,
          }
        : { from: state.selected, to: address, value: '0x' + parseEther(value).toString(16), data: '0x' };

      applyGasInfo(await call('ESTIMATE_GAS', { request }));
      setStep('review');
    });

  const confirm = () =>
    run(async () => {
      const fees = advanced
        ? buildCustomFees(gasInfo, customGasPrice, customMaxFee, customPriorityFee)
        : gasInfo.options[preset];
      const gas = advanced ? validateGasLimit(customGasLimit) : gasInfo.gasLimit;
      const customNonce = advanced ? validateNonce(nonce) : undefined;
      const value = tokenAmount;

      const result = token
        ? await call('SEND_TOKEN', {
            from: state.selected,
            token,
            to: resolved,
            amount: value,
            fees,
            gas,
            nonce: customNonce,
          })
        : await call('SEND_TRANSACTION', {
            request: {
              from: state.selected,
              to: resolved,
              value: '0x' + parseEther(value).toString(16),
              data: '0x',
              gas,
              fees,
              nonce: customNonce,
            },
          });

      setHash(result.hash);
      setStep('sent');
    });

  // -------------------------------------------------------------------------
  if (step === 'sent') {
    return (
      <div className="screen">
        <BackBar title="Sent" onBack={() => go('home')} />
        <div className="scroll pad stack">
          <div className="beam" />
          <h1>Transaction submitted</h1>
          <p>It is in the mempool now. The activity list updates when it confirms.</p>
          <div className="data-block">{hash}</div>
          {portfolio?.network?.explorer && (
            <a
              className="link accent"
              href={`${portfolio.network.explorer}/tx/${hash}`}
              target="_blank"
              rel="noreferrer"
            >
              Open in block explorer ↗
            </a>
          )}
          <div className="spacer" />
        </div>
        <div className="footer">
          <button className="primary" onClick={() => go('home')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (step === 'review') return renderReview();

  if (step === 'amount') return renderAmount();

  // --- step: recipient ------------------------------------------------------
  const recipientList = sendTab === 'accounts' ? state.accounts.filter((a) => a.address !== state.selected) : contacts;

  return (
    <div className="screen">
      <BackBar
        title="Send"
        onBack={() => go('home')}
        right={
          <button className="icon-btn plain" onClick={() => setScanning(true)} aria-label="Scan a QR code" title="Scan a QR code">
            ⛶
          </button>
        }
      />

      <div className="scroll pad stack">
        {scanning ? (
          <QrScanner
            onClose={() => setScanning(false)}
            onResult={async (value) => {
              setScanning(false);
              await applyRecipientInput(value);
            }}
          />
        ) : (
          <>
            <div className="stack-sm">
              <div className="eyebrow">From</div>
              <div className="item static">
                <Avatar address={state.selected} size="lg" src={selectedAccount?.ens?.avatar} />
                <div className="item-main">
                  <span className="item-title">{selectedAccount?.name ?? 'Account'}</span>
                  <span className="item-sub">{shorten(state.selected, 10, 8)}</span>
                </div>
                {portfolio ? (
                  <span className="mono small muted">
                    {trimAmount(portfolio.native.balance)} {portfolio.native.symbol}
                  </span>
                ) : (
                  <Skeleton width={62} height={12} />
                )}
              </div>
              {selectedAccount?.type === 'watch' && (
                <div className="notice">
                  This is a watch-only account. ADRIX can show its balance but cannot sign for it.
                </div>
              )}
            </div>

            <div className="stack-sm">
              <div className="eyebrow">To</div>
              <div className="address-input">
                <input
                  placeholder="Address (0x…), ENS name, or ethereum: link"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData('text');
                    if (/^ethereum:/i.test(text)) {
                      e.preventDefault();
                      applyRecipientInput(text);
                    }
                  }}
                  spellCheck="false"
                  autoCapitalize="none"
                  autoComplete="off"
                  aria-label="Recipient address"
                  aria-describedby="recipient-status"
                />
                {recipient ? (
                  <button className="icon-btn plain" onClick={() => setRecipient('')} aria-label="Clear recipient">
                    ✕
                  </button>
                ) : (
                  <button className="icon-btn plain" onClick={() => setScanning(true)} aria-label="Scan a QR code">
                    ⛶
                  </button>
                )}
              </div>
              <RecipientStatus inspection={inspection} inspecting={inspecting} busy={Boolean(recipient)} />
              {uriNotice && <div className="notice">{uriNotice}</div>}
            </div>

            <div className="tabs" role="tablist" aria-label="Recipient source">
              <button role="tab" aria-selected={sendTab === 'accounts'} onClick={() => setSendTab('accounts')}>
                Your accounts
              </button>
              <button role="tab" aria-selected={sendTab === 'contacts'} onClick={() => setSendTab('contacts')}>
                Contacts{contacts.length ? ` (${contacts.length})` : ''}
              </button>
            </div>

            <div className="list">
              {recipientList.map((entry) => (
                <button
                  key={entry.address}
                  className={`item ${entry.address.toLowerCase() === recipient.trim().toLowerCase() ? 'selected' : ''}`}
                  onClick={() => setRecipient(entry.address)}
                >
                  <Avatar address={entry.address} size="lg" src={entry.ens?.avatar} />
                  <div className="item-main">
                    <span className="item-title">
                      {entry.favorite ? '★ ' : ''}
                      {entry.name}
                    </span>
                    <span className="item-sub">{shorten(entry.address, 10, 8)}</span>
                  </div>
                  {entry.label && <span className="badge">{entry.label}</span>}
                  {entry.type === 'watch' && <span className="badge">watch</span>}
                </button>
              ))}
              {!recipientList.length && (
                <EmptyState
                  icon={sendTab === 'contacts' ? '☆' : '◇'}
                  title={sendTab === 'contacts' ? 'No saved contacts' : 'No other accounts'}
                  body={
                    sendTab === 'contacts'
                      ? 'Save trusted recipients in Settings → Address book so you never paste an address twice.'
                      : 'Add another account from the Accounts screen to send between your own addresses.'
                  }
                />
              )}
            </div>

            {loadError && <div className="error" role="alert">{loadError}</div>}
            {error && <div className="error" role="alert">{error}</div>}
          </>
        )}
      </div>

      {!scanning && (
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => go('home')}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={() => setStep('amount')}
              disabled={!recipient || inspection?.state === 'invalid' || selectedAccount?.type === 'watch'}
            >
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // --- step: amount ---------------------------------------------------------
  function renderAmount() {
    const canConvert = unitPrice != null;
    const fiatSymbol = currencySymbol(currency);
    const overBalance = tokenAmount && Number(tokenAmount) > Number(available ?? 0);

    return (
      <div className="screen">
        <BackBar title="Amount" onBack={() => setStep('form')} />
        <div className="scroll pad stack">
          <div className="item static">
            <Avatar address={resolved || recipient} size="lg" />
            <div className="item-main">
              <span className="item-title">To {inspection?.ens ?? 'recipient'}</span>
              <span className="item-sub">{shorten(inspection?.address ?? recipient, 12, 10)}</span>
            </div>
          </div>

          <label className="field">
            <span>Asset</span>
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="native">
                {portfolio?.native?.symbol ?? 'Native'} — {trimAmount(portfolio?.native?.balance)}
              </option>
              {(portfolio?.tokens ?? []).map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol} — {trimAmount(t.balance)}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <div className="between">
              <span>Amount</span>
              {canConvert && (
                <button
                  className="link accent"
                  onClick={() => {
                    // Carry the converted value across so the number on screen
                    // keeps its meaning when the unit flips.
                    const next = entryMode === 'token' ? fiatAmount : tokenAmount;
                    setEntryMode(entryMode === 'token' ? 'fiat' : 'token');
                    setAmount(next ?? '');
                  }}
                >
                  {entryMode === 'token' ? `Enter in ${currency.toUpperCase()}` : `Enter in ${symbol}`} ⇅
                </button>
              )}
            </div>

            <div className="input-group">
              <div className="amount-input">
                {entryMode === 'fiat' && <span className="amount-prefix">{fiatSymbol}</span>}
                <input
                  className="mono"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => {
                    setMaxMode(false);
                    setAmount(e.target.value.replace(/[^\d.]/g, ''));
                  }}
                  aria-label={entryMode === 'fiat' ? `Amount in ${currency}` : `Amount in ${symbol}`}
                  aria-invalid={Boolean(overBalance)}
                />
                {entryMode === 'token' && <span className="amount-suffix">{symbol}</span>}
              </div>
              <button className="ghost" onClick={fillMax} disabled={busy || selectedAccount?.type === 'watch'}>
                Max
              </button>
            </div>

            <div className="between small">
              <span className="faint">
                {canConvert
                  ? entryMode === 'token'
                    ? `≈ ${formatFiat(Number(fiatAmount || 0), currency)}`
                    : `≈ ${trimAmount(tokenAmount)} ${symbol}`
                  : 'No price feed for this asset'}
              </span>
              <span className={overBalance ? 'error-text' : 'faint'}>
                Available {trimAmount(available)} {symbol}
              </span>
            </div>
          </div>

          {!token && <p className="small">Max sends the balance minus the estimated network fee.</p>}
          {overBalance && <div className="error">That is more than the available balance.</div>}

          <label className="check-line">
            <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
            Advanced controls (gas and nonce)
          </label>

          {advanced && <NoncePanel nonce={nonce} setNonce={setNonce} info={nonceInfo} status={nonceStatus} />}

          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="footer">
          <button
            className="primary"
            onClick={review}
            disabled={busy || !tokenAmount || Number(tokenAmount) <= 0 || overBalance}
          >
            {busy ? 'Estimating…' : 'Review'}
          </button>
        </div>
      </div>
    );
  }

  // --- step: review ---------------------------------------------------------
  function renderReview() {
    const fees = advanced
      ? safeCustomFees(gasInfo, customGasPrice, customMaxFee, customPriorityFee) ?? gasInfo.options[preset]
      : gasInfo.options[preset];
    const estimatedFee = estimateNetworkFee(fees, advanced ? customGasLimit : gasInfo.gasLimit);
    const nativePrice = portfolio?.native?.price;
    const feeFiat = nativePrice != null ? Number(estimatedFee) * nativePrice : null;
    const valueFiat = unitPrice != null ? Number(tokenAmount) * unitPrice : null;

    return (
      <div className="screen">
        <BackBar title="Review" onBack={() => setStep('amount')} />
        <div className="scroll pad stack">
          <div className="eyebrow">Sending</div>
          <div className="balance">
            {trimAmount(tokenAmount, 8)}
            <span>{symbol}</span>
          </div>
          {valueFiat != null && <div className="center small faint">{formatFiat(valueFiat, currency)}</div>}

          <div className="card">
            <div className="between">
              <span className="small">To</span>
              <span className="mono small">{shorten(resolved, 10, 8)}</span>
            </div>
            {inspection?.ens && (
              <div className="between">
                <span className="small">ENS</span>
                <span className="mono small">{inspection.ens}</span>
              </div>
            )}
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
              <span className="mono small">
                ~{trimAmount(estimatedFee, 6)} {gasInfo.symbol}
                {feeFiat != null ? ` · ${formatFiat(feeFiat, currency)}` : ''}
              </span>
            </div>
            {advanced && nonce && (
              <div className="between">
                <span className="small">Nonce</span>
                <span className="mono small">{nonce}</span>
              </div>
            )}
          </div>

          {inspection?.isContract && (
            <div className="notice">
              The recipient is a contract, not a regular wallet. Sending tokens to a token contract usually loses them.
            </div>
          )}
          {inspection?.seenBefore === false && (
            <div className="notice">First time sending to this address. Check it once more.</div>
          )}

          <FeeControls
            gasInfo={gasInfo}
            preset={preset}
            setPreset={setPreset}
            advanced={advanced}
            setAdvanced={setAdvanced}
            customGasLimit={customGasLimit}
            setCustomGasLimit={setCustomGasLimit}
            customGasPrice={customGasPrice}
            setCustomGasPrice={setCustomGasPrice}
            customMaxFee={customMaxFee}
            setCustomMaxFee={setCustomMaxFee}
            customPriorityFee={customPriorityFee}
            setCustomPriorityFee={setCustomPriorityFee}
            feeCheck={feeCheck}
          />

          {advanced && <NoncePanel nonce={nonce} setNonce={setNonce} info={nonceInfo} status={nonceStatus} />}

          {maxMode && (
            <div className="notice info">
              Sending the full balance minus the fee. The amount tracks the fee you pick above.
            </div>
          )}

          {gasInfo.estimateError && (
            <div className="notice danger">
              Gas could not be estimated: {gasInfo.estimateError}. This usually means the transaction would revert and
              still cost the fee.
            </div>
          )}
          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => setStep('amount')}>
              Back
            </button>
            <button
              className="primary"
              onClick={confirm}
              disabled={busy || feeCheck?.problems.length > 0 || nonceStatus?.tone === 'error'}
            >
              {busy ? 'Sending…' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
function RecipientStatus({ inspection, inspecting, busy }) {
  if (!busy) return null;
  if (inspecting && !inspection) {
    return (
      <p className="small faint" id="recipient-status" aria-live="polite">
        Checking address…
      </p>
    );
  }
  if (!inspection || inspection.state === 'empty') return null;

  if (inspection.state === 'invalid') {
    return (
      <div className="error" id="recipient-status" role="alert">
        {inspection.message}
      </div>
    );
  }

  return (
    <div className="inline wrap" id="recipient-status" aria-live="polite">
      <span className="badge confirmed">valid</span>
      {inspection.ens && <span className="badge accent">{inspection.ens}</span>}
      {inspection.isContract === true && <span className="badge failed">contract</span>}
      {inspection.isContract === false && <span className="badge">wallet</span>}
      {inspection.seenBefore === false && <span className="badge pending">first time</span>}
      {inspection.seenBefore === true && <span className="badge">sent before</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * Fee presets plus hand-entered overrides. Presets show both the likely cost at
 * the current base fee and the ceiling the max fee allows, because the gap
 * between the two is exactly what confuses people about EIP-1559.
 */
function FeeControls({
  gasInfo,
  preset,
  setPreset,
  advanced,
  setAdvanced,
  customGasLimit,
  setCustomGasLimit,
  customGasPrice,
  setCustomGasPrice,
  customMaxFee,
  setCustomMaxFee,
  customPriorityFee,
  setCustomPriorityFee,
  feeCheck,
}) {
  const baseFeeGwei = gasInfo.baseFeePerGas ? formatUnits(gasInfo.baseFeePerGas, 'gwei') : null;

  return (
    <div className="stack-sm">
      <div className="between">
        <h3>Network fee</h3>
        <label className="check-line">
          <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
          Custom
        </label>
      </div>

      {baseFeeGwei && (
        <div className="between small faint">
          <span>Current base fee</span>
          <span className="mono">{trimAmount(baseFeeGwei, 3)} gwei</span>
        </div>
      )}

      <div className="gas-grid">
        {['low', 'market', 'fast'].map((key) => {
          const option = gasInfo.options[key];
          return (
            <button
              key={key}
              className="gas-option"
              aria-pressed={!advanced && preset === key}
              onClick={() => {
                setAdvanced(false);
                setPreset(key);
              }}
            >
              <b>{key === 'low' ? 'Slow' : key === 'market' ? 'Market' : 'Fast'}</b>
              <span>~{trimAmount(option.likelyFee ?? option.estimatedFee, 6)}</span>
              {option.etaSeconds && <span className="eta">~{formatEta(option.etaSeconds)}</span>}
            </button>
          );
        })}
      </div>

      {advanced && (
        <div className="card">
          <label className="field">
            <span>Gas limit</span>
            <input
              className="mono"
              inputMode="numeric"
              value={customGasLimit}
              onChange={(e) => setCustomGasLimit(e.target.value)}
            />
            <span className="small faint">
              Estimated {Number(gasInfo.gasLimit).toLocaleString()} including 20% headroom. Unused gas is refunded;
              too little makes the transaction fail and still cost the fee.
            </span>
          </label>

          {gasInfo.supportsEip1559 ? (
            <>
              <div className="row2">
                <label className="field">
                  <span>Max fee (gwei)</span>
                  <input
                    className="mono"
                    inputMode="decimal"
                    value={customMaxFee}
                    onChange={(e) => setCustomMaxFee(e.target.value)}
                    aria-invalid={feeCheck?.problems.length > 0}
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
              <p className="small faint">
                You pay the base fee plus your priority fee, capped at the max fee. The max is a ceiling, not a price.
              </p>
            </>
          ) : (
            <label className="field">
              <span>Gas price (gwei)</span>
              <input
                className="mono"
                inputMode="decimal"
                value={customGasPrice}
                onChange={(e) => setCustomGasPrice(e.target.value)}
                aria-invalid={feeCheck?.problems.length > 0}
              />
              <span className="small faint">This chain has no EIP-1559 fee market, so a flat gas price applies.</span>
            </label>
          )}
        </div>
      )}

      {feeCheck?.problems.map((problem) => (
        <div className="error" role="alert" key={problem}>
          {problem}
        </div>
      ))}
      {feeCheck?.warnings.map((warning) => (
        <div className="notice" key={warning}>
          {warning}
        </div>
      ))}
    </div>
  );
}

/**
 * Nonce controls with the account's real nonce state alongside, so the number
 * being typed can be judged against what the chain and mempool actually hold.
 */
function NoncePanel({ nonce, setNonce, info, status }) {
  return (
    <div className="card">
      <div className="between">
        <span className="eyebrow">Nonce</span>
        {info && (
          <span className="small faint mono">
            confirmed {info.confirmed} · next {info.next}
          </span>
        )}
      </div>

      {info?.gaps.length > 0 && (
        <div className="notice danger">
          Nonce gap at {info.gaps.length === 1 ? info.gaps[0] : info.gaps.join(', ')}. Nothing after it can confirm
          until that nonce is used — send a replacement at {info.gaps[0]} to clear the queue.
        </div>
      )}

      <label className="field">
        <span>Custom nonce (optional)</span>
        <div className="input-group">
          <input
            className="mono"
            inputMode="numeric"
            placeholder={info ? String(info.next) : 'Use next pending nonce'}
            value={nonce}
            onChange={(e) => setNonce(e.target.value.replace(/[^\d]/g, ''))}
            aria-invalid={status?.tone === 'error'}
            aria-describedby="nonce-status"
          />
          {nonce && (
            <button className="ghost" onClick={() => setNonce('')}>
              Auto
            </button>
          )}
        </div>
      </label>

      <div id="nonce-status" aria-live="polite">
        {status ? (
          <div className={status.tone === 'error' ? 'error' : status.tone === 'warn' ? 'notice' : 'ok'}>
            {status.message}
          </div>
        ) : (
          <p className="small faint">
            Left empty, ADRIX uses the next pending nonce. Entering the nonce of a pending transaction replaces it.
          </p>
        )}
      </div>

      {info?.pendingNonces.length > 0 && (
        <div className="inline wrap">
          <span className="small faint">Pending:</span>
          {info.pendingNonces.map((value) => (
            <button className="chip" key={value} onClick={() => setNonce(String(value))}>
              {value}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatEta(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * Mirror of the background validator so the review screen can react as the user
 * types without a message round trip per keystroke. The background copy is the
 * authority; this one only drives the UI.
 */
function validateFeesLocal(fees, gasInfo) {
  const problems = [];
  const warnings = [];

  try {
    if (fees?.type === 2) {
      const maxFee = BigInt(fees.maxFeePerGas ?? 0);
      const priority = BigInt(fees.maxPriorityFeePerGas ?? 0);

      if (maxFee <= 0n) problems.push('Max fee must be above zero.');
      if (priority > maxFee) problems.push('Priority fee cannot exceed the max fee.');

      if (gasInfo?.baseFeePerGas) {
        const base = BigInt(gasInfo.baseFeePerGas);
        if (maxFee < base) {
          problems.push(
            `Max fee is below the current base fee of ${trimAmount(formatUnits(base, 'gwei'), 3)} gwei. This can never be included.`
          );
        } else if (maxFee < (base * 112n) / 100n) {
          warnings.push('Max fee barely clears the base fee. A small rise will stall this transaction.');
        }
        if (maxFee > base * 5n) warnings.push('Max fee is more than 5× the base fee. You will likely overpay.');
      }
      if (priority === 0n) warnings.push('A zero priority fee gives validators no reason to include this.');
    } else if (fees?.gasPrice != null) {
      const gasPrice = BigInt(fees.gasPrice);
      if (gasPrice <= 0n) problems.push('Gas price must be above zero.');
      if (gasInfo?.gasPrice) {
        const suggested = BigInt(gasInfo.gasPrice);
        if (gasPrice < suggested / 2n) warnings.push('Gas price is well below the going rate; this may not confirm.');
        if (gasPrice > suggested * 5n) warnings.push('Gas price is more than 5× the going rate. You will overpay.');
      }
    }
  } catch {
    problems.push('Those fee values are not valid numbers.');
  }

  return { problems, warnings, ok: problems.length === 0 };
}

// ---------------------------------------------------------------------------
function validateGasLimit(value) {
  const trimmed = String(value ?? '').trim();
  if (!/^\d+$/.test(trimmed) || BigInt(trimmed) <= 0n) throw new Error('Enter a valid gas limit.');
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
  return String(value).includes('.') ? String(value).replace(/0+$/, '').replace(/\.$/, '') : String(value);
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
