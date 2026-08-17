import { useState } from 'react';
import { BackBar } from '../components/common.jsx';

export default function BatchSend({ state, go }) {
  const [transfers, setTransfers] = useState([{ address: '', amount: '' }]);
  const [busy, setBusy] = useState(false);

  const addTransfer = () => {
    setTransfers([...transfers, { address: '', amount: '' }]);
  };

  const updateTransfer = (index, field, value) => {
    const next = [...transfers];
    next[index][field] = value;
    setTransfers(next);
  };

  const removeTransfer = (index) => {
    if (transfers.length > 1) {
      setTransfers(transfers.filter((_, i) => i !== index));
    }
  };

  const submitBatch = async () => {
    setBusy(true);
    setTimeout(() => {
      alert(`Batch executed: Sent ${transfers.length} transactions simultaneously (Mock)`);
      setBusy(false);
      go('home');
    }, 1500);
  };

  const isValid = transfers.every((t) => t.address.trim() && parseFloat(t.amount) > 0);

  return (
    <div className="screen">
      <BackBar title="Batch Transfer" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="card">
          <p className="small" style={{ marginBottom: 12 }}>
            Execute multiple transfers in a single atomic transaction. Saves gas and ensures they all succeed or fail together.
          </p>
          
          {transfers.map((t, index) => (
            <div key={index} className="site-panel stack-sm" style={{ marginBottom: 8, padding: 8 }}>
              <div className="between">
                <span className="eyebrow">Transfer {index + 1}</span>
                {transfers.length > 1 && (
                  <button className="link" onClick={() => removeTransfer(index)}>remove</button>
                )}
              </div>
              <label className="field">
                <span>To Address</span>
                <input 
                  className="mono" 
                  placeholder="0x..." 
                  value={t.address} 
                  onChange={(e) => updateTransfer(index, 'address', e.target.value)} 
                />
              </label>
              <label className="field">
                <span>Amount (ETH)</span>
                <input 
                  type="number" 
                  placeholder="0.0" 
                  value={t.amount} 
                  onChange={(e) => updateTransfer(index, 'amount', e.target.value)} 
                />
              </label>
            </div>
          ))}

          <button className="ghost" style={{ width: '100%', marginTop: 8 }} onClick={addTransfer}>
            + Add another recipient
          </button>
        </div>
      </div>
      <div className="footer">
        <button className="primary" disabled={busy || !isValid} onClick={submitBatch}>
          {busy ? 'Executing Batch...' : `Send ${transfers.length} Transactions`}
        </button>
      </div>
    </div>
  );
}
