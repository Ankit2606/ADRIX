import { useState } from 'react';
import { BackBar } from '../components/common.jsx';

export default function Bridge({ state, go }) {
  const [fromChain, setFromChain] = useState('Ethereum');
  const [toChain, setToChain] = useState('Arbitrum');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const bridge = async () => {
    setBusy(true);
    setTimeout(() => {
      alert(`Bridging ${amount} ETH from ${fromChain} to ${toChain} (Mock)`);
      setBusy(false);
      go('home');
    }, 1000);
  };

  return (
    <div className="screen">
      <BackBar title="Bridge assets" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="card">
          <label className="field">
            <span>From Network</span>
            <select value={fromChain} onChange={(e) => setFromChain(e.target.value)}>
              <option value="Ethereum">Ethereum</option>
              <option value="Polygon">Polygon</option>
              <option value="Optimism">Optimism</option>
              <option value="Arbitrum">Arbitrum</option>
              <option value="Base">Base</option>
            </select>
          </label>

          <div style={{ textAlign: 'center', margin: '8px 0', color: 'var(--muted)' }}>
            ↓
          </div>

          <label className="field">
            <span>To Network</span>
            <select value={toChain} onChange={(e) => setToChain(e.target.value)}>
              <option value="Arbitrum">Arbitrum</option>
              <option value="Ethereum">Ethereum</option>
              <option value="Polygon">Polygon</option>
              <option value="Optimism">Optimism</option>
              <option value="Base">Base</option>
            </select>
          </label>
        </div>

        <div className="card" style={{ marginTop: '8px' }}>
          <label className="field">
            <span>Amount (ETH)</span>
            <input 
              type="number" 
              placeholder="0.0" 
              value={amount} 
              onChange={(e) => setAmount(e.target.value)} 
            />
          </label>
        </div>

        <div className="card" style={{ marginTop: '8px' }}>
          <div className="between small">
            <span className="muted">Route</span>
            <span>Across Protocol</span>
          </div>
          <div className="between small">
            <span className="muted">Estimated Time</span>
            <span>~2 minutes</span>
          </div>
          <div className="between small">
            <span className="muted">Bridge Fee</span>
            <span>0.001 ETH</span>
          </div>
        </div>
      </div>
      <div className="footer">
        <button className="primary" disabled={busy || !amount || parseFloat(amount) <= 0 || fromChain === toChain} onClick={bridge}>
          {busy ? 'Bridging...' : fromChain === toChain ? 'Same network' : 'Review Bridge'}
        </button>
      </div>
    </div>
  );
}
