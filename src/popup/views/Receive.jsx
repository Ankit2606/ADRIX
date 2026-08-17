import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { BackBar, CopyButton } from '../components/common.jsx';

export default function Receive({ state, go }) {
  const [dataUrl, setDataUrl] = useState('');
  const account = state.accounts.find((a) => a.address === state.selected);

  useEffect(() => {
    if (!state.selected) return;
    QRCode.toDataURL(state.selected, {
      width: 220,
      margin: 0,
      color: { dark: '#0a0f1e', light: '#ffffff' },
    })
      .then(setDataUrl)
      .catch(() => setDataUrl(''));
  }, [state.selected]);

  return (
    <div className="screen">
      <BackBar title="Receive" onBack={() => go('home')} />
      <div className="scroll pad stack center">
        <p>Scan or copy this address to receive funds on {state.network?.name}.</p>
        {dataUrl && <img className="qr" src={dataUrl} alt="Address QR code" width="220" height="220" />}
        <div className="eyebrow">{account?.name}</div>
        <div className="data-block" style={{ textAlign: 'center' }}>
          {state.selected}
        </div>
        <CopyButton value={state.selected} label="Copy address" className="ghost" />
        <div className="notice" style={{ textAlign: 'left' }}>
          The same address works on every EVM chain, but funds sent on one chain only exist on that chain.
        </div>
      </div>
    </div>
  );
}
