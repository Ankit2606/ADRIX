import { useState } from 'react';
import { BackBar } from '../components/common.jsx';

export default function Swap({ state, go }) {
  const [fromAsset, setFromAsset] = useState('ETH');
  const [toAsset, setToAsset] = useState('USDC');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const swap = async () => {
    setBusy(true);
    setTimeout(() => {
      alert(`Swapped ${amount} ${fromAsset} for ${toAsset} (Mock)`);
      setBusy(false);
      go('home');
    }, 1000);
  };

  return (
    <div className="screen">
      <BackBar title="Swap tokens" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="card">
          <label className="field">
            <span>Pay</span>
            <div className="row2">
              <input 
                type="number" 
                placeholder="0.0" 
                value={amount} 
                onChange={(e) => setAmount(e.target.value)} 
                style={{ flex: 1 }}
              />
              <select value={fromAsset} onChange={(e) => setFromAsset(e.target.value)} style={{ width: '100px' }}>
                <option value="ETH">ETH</option>
                <option value="USDC">USDC</option>
                <option value="USDT">USDT</option>
                <option value="DAI">DAI</option>
              </select>
            </div>
          </label>

          <div style={{ textAlign: 'center', margin: '8px 0', color: 'var(--muted)' }}>
            ↓
          </div>

          <label className="field">
            <span>Receive (Estimated)</span>
            <div className="row2">
              <input 
                type="text" 
                readOnly 
                value={amount ? (parseFloat(amount) * 3000).toFixed(2) : ''} 
                placeholder="0.0" 
                style={{ flex: 1, backgroundColor: 'var(--surface-2)' }}
              />
              <select value={toAsset} onChange={(e) => setToAsset(e.target.value)} style={{ width: '100px' }}>
                <option value="USDC">USDC</option>
                <option value="ETH">ETH</option>
                <option value="USDT">USDT</option>
                <option value="WBTC">WBTC</option>
              </select>
            </div>
          </label>
        </div>

        <div className="card" style={{ marginTop: '8px' }}>
          <div className="between small">
            <span className="muted">Rate</span>
            <span>1 {fromAsset} = 3000 {toAsset}</span>
          </div>
          <div className="between small">
            <span className="muted">Provider</span>
            <span>1inch Network</span>
          </div>
          <div className="between small">
            <span className="muted">Slippage Tolerance</span>
            <span>0.5%</span>
          </div>
        </div>
      </div>
      <div className="footer">
        <button className="primary" disabled={busy || !amount || parseFloat(amount) <= 0} onClick={swap}>
          {busy ? 'Swapping...' : 'Review Swap'}
        </button>
      </div>
    </div>
  );
}
