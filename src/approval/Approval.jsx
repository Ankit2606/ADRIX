import { useEffect, useRef, useState } from 'react';
import { formatEther } from 'ethers';
import { call, shorten, trimAmount, accountColor } from '../lib/ui.js';
import Unlock from '../popup/views/Unlock.jsx';

const initialId = Number(new URLSearchParams(window.location.search).get('id'));

// Holding this port open keeps the service worker alive while the user decides,
// and closing the window without answering registers as a rejection.
const port = chrome.runtime.connect({ name: 'approval' });

export default function Approval() {
  const [requestId, setRequestId] = useState(initialId);
  // The message listener below is registered once, so it needs a ref rather
  // than the state value it would otherwise close over.
  const idRef = useRef(initialId);
  const [request, setRequest] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Connect requests let the user choose which accounts to expose.
  const [chosen, setChosen] = useState([]);
  const [chosenNetworks, setChosenNetworks] = useState([]);
  const [gasPreset, setGasPreset] = useState('market');

  const load = async (id = idRef.current) => {
    try {
      const result = await call('GET_APPROVAL', { id });
      setRequest(result);
      if (result.kind === 'connect') {
        setChosen((current) =>
          current.length
            ? current
            : result.grantedAccounts?.length
              ? result.grantedAccounts
              : result.accounts.length
                ? [result.accounts[0].address]
                : []
        );
        setChosenNetworks((current) =>
          current.length
            ? current
            : result.grantedNetworks?.length
              ? result.grantedNetworks
              : result.chainId
                ? [result.chainId]
                : []
        );
      }
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load(initialId);

    // A second site can queue a request behind this one while it is open.
    const listener = (message) => {
      if (message?.type === 'APPROVAL_QUEUE_CHANGED') load();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const decide = async (approved) => {
    setBusy(true);
    try {
      let result;
      if (approved) {
        const value =
          request.kind === 'connect'
            ? { accounts: chosen, networks: chosenNetworks }
            : request.kind === 'transaction'
              ? { fees: request.gasInfo.options[gasPreset], gasLimit: request.gasInfo.gasLimit }
              : true;
        result = await call('APPROVE', { id: requestId, value });
      } else {
        result = await call('REJECT', { id: requestId });
      }

      // Another site was waiting behind this one - show it rather than closing.
      if (result?.next) {
        idRef.current = result.next;
        setRequestId(result.next);
        setRequest(null);
        setChosen([]);
        setChosenNetworks([]);
        setGasPreset('market');
        await load(result.next);
        setBusy(false);
        return;
      }

      port.disconnect();
      window.close();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Shell>
        <h1>Request expired</h1>
        <p>{error}</p>
        <div className="spacer" />
        <button className="ghost" onClick={() => window.close()}>
          Close
        </button>
      </Shell>
    );
  }

  if (!request) {
    return (
      <Shell>
        <p>Loading request...</p>
      </Shell>
    );
  }

  if (!request.unlocked) return <Unlock onDone={load} compact />;

  const cta = {
    connect: 'Connect',
    personalSign: 'Sign',
    typedSign: 'Sign',
    transaction: 'Confirm',
    switchChain: 'Switch network',
    addChain: 'Add network',
    watchAsset: 'Add token',
  }[request.kind];

  return (
    <div className="screen">
      <div className="scroll pad stack">
        <div className="inline">
          <span className="dot" />
          <b>ADRIX</b>
          {request.queued?.length > 1 && (
            <span className="badge" style={{ marginLeft: 'auto' }}>
              {request.queued.length} pending
            </span>
          )}
        </div>
        <div className="beam" />
        <div className="eyebrow">Requested by</div>
        <div className="mono" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
          {request.origin}
        </div>

        {request.security?.isDomainFlagged && (
          <div className="notice" style={{ background: '#3b0000', color: '#ff6b6b', border: '1px solid #ff6b6b' }}>
            ⚠️ WARNING: This domain is flagged as a known scam or phishing site!
          </div>
        )}
        {request.security?.isToAddressFlagged && (
          <div className="notice" style={{ background: '#3b0000', color: '#ff6b6b', border: '1px solid #ff6b6b' }}>
            ⚠️ WARNING: The target contract/address is flagged as malicious!
          </div>
        )}
        {request.security?.isSpenderFlagged && (
          <div className="notice" style={{ background: '#3b0000', color: '#ff6b6b', border: '1px solid #ff6b6b' }}>
            ⚠️ WARNING: The approved spender address is flagged as malicious!
          </div>
        )}

        {request.kind === 'connect' && (
          <Connect
            accounts={request.accounts}
            chosen={chosen}
            setChosen={setChosen}
            networks={request.networks}
            chainId={request.chainId}
            chosenNetworks={chosenNetworks}
            setChosenNetworks={setChosenNetworks}
          />
        )}
        {request.kind === 'personalSign' && <PersonalSign request={request} />}
        {request.kind === 'typedSign' && <TypedSign request={request} />}
        {request.kind === 'transaction' && (
          <TransactionRequest request={request} preset={gasPreset} setPreset={setGasPreset} />
        )}
        {(request.kind === 'switchChain' || request.kind === 'addChain') && <ChainRequest request={request} />}
        {request.kind === 'watchAsset' && <WatchAsset request={request} />}
      </div>

      <div className="footer">
        <div className="row2">
          <button className="ghost" onClick={() => decide(false)} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => decide(true)}
            disabled={busy || (request.kind === 'connect' && (chosen.length === 0 || chosenNetworks.length === 0))}
          >
            {busy ? 'Working...' : cta}
          </button>
        </div>
      </div>
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="screen">
      <div className="scroll pad stack">
        <div className="inline">
          <span className="dot" />
          <b>ADRIX</b>
        </div>
        {children}
      </div>
    </div>
  );
}

function Connect({ accounts, chosen, setChosen, networks = {}, chainId, chosenNetworks, setChosenNetworks }) {
  const toggle = (address) =>
    setChosen(chosen.includes(address) ? chosen.filter((a) => a !== address) : [...chosen, address]);
  const toggleNetwork = (id) =>
    setChosenNetworks(
      chosenNetworks.includes(id) ? chosenNetworks.filter((networkId) => networkId !== id) : [...chosenNetworks, id]
    );
  const networkList = Object.values(networks);

  return (
    <>
      <h1>Connect this site</h1>
      <p className="small">Choose which accounts and networks it can use. You can change this later in Settings.</p>

      <div className="eyebrow">Accounts</div>
      <div className="list">
        {accounts.map((account) => (
          <button className="item" key={account.address} onClick={() => toggle(account.address)}>
            <input
              type="checkbox"
              readOnly
              checked={chosen.includes(account.address)}
              style={{ width: 16, height: 16, flex: 'none' }}
            />
            <span className="avatar" style={{ background: accountColor(account.address) }} />
            <div className="item-main">
              <span className="item-title">{account.name}</span>
              <span className="item-sub">{shorten(account.address, 8, 6)}</span>
            </div>
          </button>
        ))}
      </div>

      <div className="eyebrow">Networks</div>
      <div className="list">
        {networkList.map((network) => (
          <button className="item compact" key={network.chainId} onClick={() => toggleNetwork(network.chainId)}>
            <input
              type="checkbox"
              readOnly
              checked={chosenNetworks.includes(network.chainId)}
              style={{ width: 16, height: 16, flex: 'none' }}
            />
            <span
              className="dot"
              style={{ background: network.chainId === chainId ? 'var(--accent)' : 'var(--line)' }}
            />
            <div className="item-main">
              <span className="item-title">{network.name}</span>
              <span className="item-sub">
                {network.chainId} · {network.symbol}
              </span>
            </div>
          </button>
        ))}
      </div>

      <div className="card">
        <p className="small">Connecting lets the site see your selected address, balance, and activity on allowed networks.</p>
        <p className="small">It cannot move anything without a separate prompt like this one.</p>
      </div>
    </>
  );
}

function PersonalSign({ request }) {
  return (
    <>
      <h1>Sign this message</h1>
      <div className="card">
        <div className="eyebrow">Signing with</div>
        <span className="mono small">{shorten(request.account, 10, 8)}</span>
        <div className="eyebrow">Message</div>
        <div className="data-block">{request.message}</div>
      </div>
      <div className="notice">
        Signatures can authorise actions. Only sign messages you asked a site to produce.
      </div>
    </>
  );
}

function TypedSign({ request }) {
  const isPermit = request.primaryType === 'Permit';
  const msg = request.message || {};

  return (
    <>
      <h1>{isPermit ? 'Token Approval (Permit)' : 'Sign structured data'}</h1>
      
      {isPermit && (
        <div className="card" style={{ marginBottom: 12, border: '1px solid var(--accent)' }}>
          <div className="eyebrow" style={{ color: 'var(--accent)' }}>Permit Signature Detected</div>
          <p className="small">This signature allows a smart contract to spend your tokens without a separate transaction.</p>
          <div className="between" style={{ marginTop: 8 }}>
            <span className="small muted">Spender</span>
            <span className="mono small">{shorten(msg.spender, 10, 8)}</span>
          </div>
          <div className="between">
            <span className="small muted">Value / Limit</span>
            <span className="mono small">{msg.value === '115792089237316195423570985008687907853269984665640564039457584007913129639935' ? 'Unlimited' : msg.value}</span>
          </div>
          <div className="between">
            <span className="small muted">Token Contract</span>
            <span className="mono small">{shorten(request.domain?.verifyingContract, 10, 8)}</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="between">
          <span className="small">Type</span>
          <span className="mono small">{request.primaryType}</span>
        </div>
        <div className="between">
          <span className="small">Domain</span>
          <span className="mono small">{request.domain?.name ?? '--'}</span>
        </div>
        <div className="eyebrow">Contents (Human-Readable)</div>
        <div className="list" style={{ gap: 4 }}>
          {Object.entries(msg).map(([key, value]) => (
            <div key={key} className="between" style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="small faint">{key}</span>
              <span className="mono small" style={{ wordBreak: 'break-all', maxWidth: '70%', textAlign: 'right' }}>
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="notice">
        Signatures can authorise actions. Only sign messages you asked a site to produce.
      </div>
    </>
  );
}

function TransactionRequest({ request, preset, setPreset }) {
  const gas = request.gasInfo;
  const fee = gas?.options?.[preset];
  const value = safeFormat(request.value);
  const isContract = request.data && request.data !== '0x';

  return (
    <>
      <h1>{isContract ? 'Confirm interaction' : 'Confirm transaction'}</h1>

      <div className="balance">
        {trimAmount(value)}
        <span>{request.symbol}</span>
      </div>

      <div className="card">
        {request.summary?.action && (
          <div className="between">
            <span className="small">Action</span>
            <span className="mono small">{request.summary.action}</span>
          </div>
        )}
        {request.summary?.method && (
          <div className="between">
            <span className="small">Method</span>
            <span className="mono small">{request.summary.method}</span>
          </div>
        )}
        <div className="between">
          <span className="small">From</span>
          <span className="mono small">{shorten(request.account, 8, 6)}</span>
        </div>
        <div className="between">
          <span className="small">To</span>
          <span className="mono small">{request.to ? shorten(request.to, 8, 6) : 'New contract'}</span>
        </div>
        <div className="between">
          <span className="small">Network</span>
          <span className="mono small">{request.network}</span>
        </div>
        <div className="between">
          <span className="small">Network fee</span>
          <span className="mono small">
            ~{trimAmount(fee?.estimatedFee, 6)} {gas?.symbol}
          </span>
        </div>
        <div className="between">
          <span className="small">Total</span>
          <span className="mono small">
            ~{trimAmount(Number(value) + Number(fee?.estimatedFee ?? 0), 6)} {request.symbol}
          </span>
        </div>
        {request.summary?.spender && (
          <>
            <div className="between">
              <span className="small">{request.summary.operator ? 'Operator' : 'Spender'}</span>
              <span className="mono small">{shorten(request.summary.spender, 8, 6)}</span>
            </div>
            {request.summary.amount && (
              <div className="between">
                <span className="small">Approval amount</span>
                <span className="mono small">{request.summary.unlimited ? 'Unlimited' : request.summary.amount}</span>
              </div>
            )}
            {request.summary.tokenId && (
              <div className="between">
                <span className="small">Token ID</span>
                <span className="mono small">{request.summary.tokenId}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: '14px' }}>
        <div className="eyebrow" style={{ marginBottom: '8px' }}>Simulation & Balance Preview</div>
        {gas?.estimateError ? (
          <div className="mono small" style={{ color: 'var(--red)' }}>Simulation Failed: {gas.estimateError}</div>
        ) : (
          <div className="mono small" style={{ color: 'var(--green)' }}>Simulation: Success</div>
        )}
        
        <div style={{ marginTop: '12px' }}>
          {request.summary?.action === 'Token transfer' && (
            <div className="between">
              <span className="small">Expected Balance Change</span>
              <span className="mono small" style={{ color: 'var(--red)' }}>-{request.summary.amount} (raw)</span>
            </div>
          )}
          {!isContract && Number(value) > 0 && (
            <div className="between">
              <span className="small">Expected Balance Change</span>
              <span className="mono small" style={{ color: 'var(--red)' }}>-{trimAmount(value)} {request.symbol}</span>
            </div>
          )}
          {request.summary?.action === 'Token approval' && (
            <div className="between">
              <span className="small">New Allowance</span>
              <span className="mono small">{request.summary.unlimited ? 'Unlimited' : request.summary.amount} (raw)</span>
            </div>
          )}
          {request.summary?.action === 'Contract interaction' && (
            <div className="between">
              <span className="small">Expected Balance Change</span>
              <span className="mono small" style={{ color: 'var(--red)' }}>-{trimAmount(value)} {request.symbol}</span>
            </div>
          )}
        </div>
      </div>

      {gas && (
        <>
          <h3>Fee speed</h3>
          <div className="gas-grid">
            {['low', 'market', 'fast'].map((key) => (
              <button key={key} className="gas-option" aria-pressed={preset === key} onClick={() => setPreset(key)}>
                <b>{key === 'low' ? 'Slow' : key === 'market' ? 'Market' : 'Fast'}</b>
                <span>~{trimAmount(gas.options[key].estimatedFee, 6)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {gas?.estimateError && (
        <div className="notice">
          This transaction could not be simulated: {gas.estimateError}. It will probably fail and still cost gas.
        </div>
      )}

      {isContract && (
        <div className="card">
          <div className="eyebrow">Data</div>
          <div className="data-block">{request.data}</div>
        </div>
      )}

      {request.summary?.spender && request.summary?.approved !== false && (
        <div className="notice">
          {request.summary.unlimited
            ? 'This approves a very large token allowance. Only continue if you trust this site and contract.'
            : request.summary.operator
              ? 'This lets the operator move NFTs from this collection until you revoke it.'
              : 'This grants token spending permission. Review the spender before continuing.'}
        </div>
      )}
    </>
  );
}

function ChainRequest({ request }) {
  const isAdd = request.kind === 'addChain';
  return (
    <>
      <h1>{isAdd ? 'Add this network' : 'Switch network'}</h1>
      <div className="card">
        <div className="between">
          <span className="small">Name</span>
          <span>{request.network.name}</span>
        </div>
        <div className="between">
          <span className="small">Chain ID</span>
          <span className="mono small">{request.network.chainId}</span>
        </div>
        <div className="between">
          <span className="small">Currency</span>
          <span className="mono small">{request.network.symbol}</span>
        </div>
        <div className="eyebrow">RPC endpoint</div>
        <div className="data-block">{request.network.rpc}</div>
      </div>
      {isAdd && (
        <div className="notice">
          This endpoint will see your address and the transactions you broadcast. Add networks only from sites you
          trust.
        </div>
      )}
    </>
  );
}

function WatchAsset({ request }) {
  return (
    <>
      <h1>Add this token</h1>
      <div className="card">
        <div className="between">
          <span className="small">Symbol</span>
          <span className="mono">{request.token.symbol}</span>
        </div>
        <div className="between">
          <span className="small">Decimals</span>
          <span className="mono small">{request.token.decimals}</span>
        </div>
        <div className="eyebrow">Contract</div>
        <div className="data-block">{request.token.address}</div>
      </div>
      <p className="small">Adding a token only makes it visible. It grants the site nothing.</p>
    </>
  );
}

function safeFormat(hexValue) {
  try {
    return formatEther(BigInt(hexValue || '0x0'));
  } catch {
    return '0';
  }
}
