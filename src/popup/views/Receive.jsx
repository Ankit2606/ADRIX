import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { parseEther, parseUnits } from 'ethers';
import { call, shorten, trimAmount } from '../../lib/ui.js';
import { BackBar, CopyButton, Avatar, Skeleton } from '../components/common.jsx';

export default function Receive({ state, go }) {
  const [dataUrl, setDataUrl] = useState('');
  const [portfolio, setPortfolio] = useState(null);
  const [requesting, setRequesting] = useState(false);
  const [asset, setAsset] = useState('native');
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState('');

  const account = state.accounts.find((a) => a.address === state.selected);
  const token = asset === 'native' ? null : portfolio?.tokens.find((t) => t.address === asset);

  useEffect(() => {
    call('GET_PORTFOLIO')
      .then(setPortfolio)
      .catch(() => {});
  }, [state.selected, state.chainId]);

  /**
   * With no amount the QR is the bare address, which every wallet and exchange
   * can read. With an amount it becomes an EIP-681 link so the sender's wallet
   * pre-fills the transfer.
   */
  const payload = useMemo(() => {
    if (!state.selected) return '';
    if (!requesting || !amount || Number(amount) <= 0) return state.selected;

    const chainSuffix = state.chainId ? `@${parseInt(state.chainId, 16)}` : '';
    try {
      if (token) {
        const raw = parseUnits(amount, token.decimals).toString();
        return `ethereum:${token.address}${chainSuffix}/transfer?address=${state.selected}&uint256=${raw}`;
      }
      return `ethereum:${state.selected}${chainSuffix}?value=${parseEther(amount).toString()}`;
    } catch {
      return state.selected;
    }
  }, [state.selected, state.chainId, requesting, amount, token]);

  useEffect(() => {
    if (!payload) return;
    let cancelled = false;
    QRCode.toDataURL(payload, { width: 220, margin: 1, color: { dark: '#12101f', light: '#ffffff' } })
      .then((url) => !cancelled && setDataUrl(url))
      .catch(() => !cancelled && setDataUrl(''));
    return () => {
      cancelled = true;
    };
  }, [payload]);

  const onAmountChange = (value) => {
    const clean = value.replace(/[^\d.]/g, '');
    setAmount(clean);
    if (!clean) return setAmountError('');
    try {
      if (token) parseUnits(clean, token.decimals);
      else parseEther(clean);
      setAmountError('');
    } catch {
      setAmountError(`Too many decimal places for ${token?.symbol ?? state.network?.symbol ?? 'this asset'}.`);
    }
  };

  const isRequestLink = payload.startsWith('ethereum:');

  return (
    <div className="screen">
      <BackBar title="Receive" onBack={() => go('home')} />
      <div className="scroll pad stack center">
        <div className="item static" style={{ width: '100%' }}>
          <Avatar address={state.selected} size="lg" src={account?.ens?.avatar} />
          <div className="item-main">
            <span className="item-title">{account?.name ?? 'Account'}</span>
            <span className="item-sub">on {state.network?.name}</span>
          </div>
        </div>

        {dataUrl ? (
          <img
            className="qr"
            src={dataUrl}
            alt={isRequestLink ? 'Payment request QR code' : 'Address QR code'}
            width="220"
            height="220"
          />
        ) : (
          <Skeleton width={244} height={244} radius={14} />
        )}

        <div className="data-block center" style={{ width: '100%' }}>
          {state.selected}
        </div>

        <div className="row2" style={{ width: '100%' }}>
          <CopyButton value={state.selected} label="Copy address" className="ghost" />
          <button className="ghost" onClick={() => setRequesting(!requesting)} aria-expanded={requesting}>
            {requesting ? 'Plain address' : 'Request amount'}
          </button>
        </div>

        {requesting && (
          <div className="card" style={{ width: '100%', textAlign: 'left' }}>
            <div className="eyebrow">Payment request</div>
            <label className="field">
              <span>Asset</span>
              <select value={asset} onChange={(e) => setAsset(e.target.value)}>
                <option value="native">{portfolio?.native?.symbol ?? state.network?.symbol ?? 'Native'}</option>
                {(portfolio?.tokens ?? []).map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Amount</span>
              <div className="amount-input">
                <input
                  className="mono"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => onAmountChange(e.target.value)}
                  aria-invalid={Boolean(amountError)}
                />
                <span className="amount-suffix">{token?.symbol ?? portfolio?.native?.symbol ?? ''}</span>
              </div>
            </label>
            {amountError && <div className="error">{amountError}</div>}

            {isRequestLink && (
              <>
                <div className="eyebrow">EIP-681 link</div>
                <div className="data-block">{payload}</div>
                <CopyButton value={payload} label="Copy payment link" className="ghost" />
                <p className="small faint">
                  Wallets that understand EIP-681 will pre-fill the recipient and amount. Others fall back to reading
                  the address.
                </p>
              </>
            )}
          </div>
        )}

        <div className="notice" style={{ textAlign: 'left', width: '100%' }}>
          The same address works on every EVM chain, but funds sent on one chain only exist on that chain. This QR is
          for <b>{state.network?.name}</b>.
        </div>

        {portfolio?.native && (
          <p className="small faint">
            Current balance {trimAmount(portfolio.native.balance)} {portfolio.native.symbol} ·{' '}
            {shorten(state.selected, 8, 6)}
          </p>
        )}
      </div>
    </div>
  );
}
