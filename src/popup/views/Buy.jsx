import { useState } from 'react';
import { BackBar } from '../components/common.jsx';

export default function Buy({ state, go }) {
  const [fiatAmount, setFiatAmount] = useState('');
  const [fiatCurrency, setFiatCurrency] = useState('USD');
  const [cryptoAsset, setCryptoAsset] = useState('ETH');
  const [provider, setProvider] = useState('moonpay');
  const [busy, setBusy] = useState(false);

  const buy = async () => {
    setBusy(true);
    setTimeout(() => {
      alert(`Redirecting to ${provider} to buy ${cryptoAsset} with ${fiatAmount} ${fiatCurrency} (Mock)`);
      setBusy(false);
      go('home');
    }, 1000);
  };

  return (
    <div className="screen">
      <BackBar title="Buy Crypto" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="card">
          <label className="field">
            <span>You pay</span>
            <div className="row2">
              <input 
                type="number" 
                placeholder="100.00" 
                value={fiatAmount} 
                onChange={(e) => setFiatAmount(e.target.value)} 
                style={{ flex: 1 }}
              />
              <select value={fiatCurrency} onChange={(e) => setFiatCurrency(e.target.value)} style={{ width: '100px' }}>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
          </label>

          <div style={{ textAlign: 'center', margin: '8px 0', color: 'var(--muted)' }}>
            ↓
          </div>

          <label className="field">
            <span>You receive (Estimated)</span>
            <div className="row2">
              <input 
                type="text" 
                readOnly 
                value={fiatAmount ? (parseFloat(fiatAmount) / 3000).toFixed(4) : ''} 
                placeholder="0.0" 
                style={{ flex: 1, backgroundColor: 'var(--surface-2)' }}
              />
              <select value={cryptoAsset} onChange={(e) => setCryptoAsset(e.target.value)} style={{ width: '100px' }}>
                <option value="ETH">ETH</option>
                <option value="USDC">USDC</option>
                <option value="USDT">USDT</option>
                <option value="WBTC">WBTC</option>
              </select>
            </div>
          </label>
        </div>

        <div className="card" style={{ marginTop: '8px' }}>
          <label className="field">
            <span>Payment Provider</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="moonpay">MoonPay (Apple Pay, Card)</option>
              <option value="transak">Transak (Bank Transfer)</option>
              <option value="ramp">Ramp (Card)</option>
            </select>
          </label>
        </div>
      </div>
      <div className="footer">
        <button className="primary" disabled={busy || !fiatAmount || parseFloat(fiatAmount) <= 0} onClick={buy}>
          {busy ? 'Connecting...' : `Buy with ${provider === 'moonpay' ? 'MoonPay' : provider === 'transak' ? 'Transak' : 'Ramp'}`}
        </button>
      </div>
    </div>
  );
}
