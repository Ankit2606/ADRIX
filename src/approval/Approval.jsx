import { useEffect, useRef, useState } from 'react';
import { formatEther, formatUnits } from 'ethers';
import { call, shorten, trimAmount, accountColor } from '../lib/ui.js';
import { BaseFeePanel, GasPresetGrid } from '../popup/components/common.jsx';
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
        <div className="between">
          <span className="inline">
            <span className="dot" />
            <b>ADRIX</b>
          </span>
          {request.queued?.length > 1 && <span className="badge accent">{request.queued.length} pending</span>}
        </div>
        <div className="beam" />
        <div className="eyebrow">Requested by</div>
        <div className="mono accent-text break">{request.origin}</div>

        {request.security?.isDomainFlagged && (
          <div className="notice danger">⚠️ This domain is flagged as a known scam or phishing site.</div>
        )}
        {request.security?.isToAddressFlagged && (
          <div className="notice danger">⚠️ The target contract or address is flagged as malicious.</div>
        )}
        {request.security?.isSpenderFlagged && (
          <div className="notice danger">⚠️ The approved spender address is flagged as malicious.</div>
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
            />
            <span className="avatar" style={{ background: accountColor(account.address) }} />
            <div className="item-main">
              <span className="item-title">{account.name}</span>
              <span className="item-sub">{shorten(account.address, 8, 6)}</span>
            </div>
            {/* A site can read a watch-only account but never get a signature
                from it, which is worth knowing before granting access. */}
            {account.type && account.type !== 'hd' && account.type !== 'imported' && (
              <span className="badge">{account.type === 'watch' ? 'read only' : account.type}</span>
            )}
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
        <div className="card accent">
          <div className="eyebrow accent-text">Permit signature detected</div>
          <p className="small">
            This signature lets a contract spend your tokens without a separate approval transaction.
          </p>
          <div className="between">
            <span className="small">Spender</span>
            <span className="mono small">{shorten(msg.spender, 10, 8)}</span>
          </div>
          <div className="between">
            <span className="small">Value / limit</span>
            <span className="mono small">
              {msg.value === '115792089237316195423570985008687907853269984665640564039457584007913129639935'
                ? 'Unlimited'
                : msg.value}
            </span>
          </div>
          <div className="between">
            <span className="small">Token contract</span>
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
        <div className="eyebrow">Contents</div>
        <div>
          {Object.entries(msg).map(([key, value]) => (
            <div key={key} className="kv">
              <span className="kv-key">{key}</span>
              <span className="kv-value" style={{ maxWidth: '68%' }}>
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
            {/* The likely cost at the current base fee, not the max-fee ceiling.
                Quoting the ceiling makes every transaction look 2-3x pricier
                than it will actually be. */}
            ~{trimAmount(fee?.likelyFee ?? fee?.estimatedFee, 6)} {gas?.symbol}
          </span>
        </div>
        {fee?.likelyFee && fee.estimatedFee !== fee.likelyFee && (
          <div className="between">
            <span className="small faint">Most it could cost</span>
            <span className="mono small faint">
              {trimAmount(fee.estimatedFee, 6)} {gas?.symbol}
            </span>
          </div>
        )}
        <div className="between">
          <span className="small">Total</span>
          <span className="mono small">
            ~{trimAmount(Number(value) + Number(fee?.likelyFee ?? fee?.estimatedFee ?? 0), 6)} {request.symbol}
          </span>
        </div>
        {request.summary?.selector && (
          <div className="between">
            <span className="small">Selector</span>
            <span className="mono small">{request.summary.selector}</span>
          </div>
        )}
      </div>

      {request.summary?.spender && <ApprovalPanel summary={request.summary} context={request.approvalContext} />}
      {request.summary?.namedArgs?.length > 0 && <DecodedArgs args={request.summary.namedArgs} />}
      {request.summary?.risk && <div className="notice">{request.summary.risk}</div>}
      {request.summary?.known === false && (
        <div className="notice danger">
          ADRIX does not recognise this method ({request.summary.selector}). It cannot tell you what this call does —
          only approve it if you trust the site completely.
        </div>
      )}

      <div className="card">
        <div className="between">
          <span className="eyebrow">Gas estimate</span>
          <span className={`badge ${gas?.estimateError ? 'failed' : 'confirmed'}`}>
            {gas?.estimateError ? 'would revert' : 'passes'}
          </span>
        </div>
        {gas?.estimateError && <div className="data-block">{gas.estimateError}</div>}

        {request.summary?.action === 'Token transfer' && (
          <div className="kv">
            <span className="kv-key">Expected change</span>
            <span className="kv-value" style={{ color: 'var(--danger)' }}>
              -{request.summary.amount} (raw)
            </span>
          </div>
        )}
        {!isContract && Number(value) > 0 && (
          <div className="kv">
            <span className="kv-key">Expected change</span>
            <span className="kv-value" style={{ color: 'var(--danger)' }}>
              -{trimAmount(value)} {request.symbol}
            </span>
          </div>
        )}
        {request.summary?.action === 'Token approval' && (
          <div className="kv">
            <span className="kv-key">New allowance</span>
            <span className="kv-value">
              {request.summary.unlimited ? 'Unlimited' : `${request.summary.amount} (raw)`}
            </span>
          </div>
        )}
        <p className="small faint">
          Based on <code>eth_estimateGas</code> only. ADRIX does not yet simulate full balance changes.
        </p>
      </div>

      {gas && (
        <>
          <h3>Fee speed</h3>
          <GasPresetGrid gasInfo={gas} preset={preset} onSelect={setPreset} />
          <BaseFeePanel feeHistory={gas.feeHistory} compact />
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

    </>
  );
}

/**
 * What an approve call actually changes. The raw calldata says only the new
 * value; this pairs it with the allowance already in place, the token's real
 * decimals, and whether the spender is even a contract.
 */
function ApprovalPanel({ summary, context }) {
  const decimals = context?.decimals;
  const symbol = context?.symbol ?? '';

  const show = (raw) => {
    if (raw == null) return '--';
    if (summary.unlimited && raw === summary.amount) return 'Unlimited';
    if (decimals == null) return `${raw} (raw)`;
    try {
      return `${trimAmount(formatUnits(raw, decimals), 6)} ${symbol}`.trim();
    } catch {
      return `${raw} (raw)`;
    }
  };

  const revoking = summary.approved === false;

  return (
    <div className={`card ${revoking ? '' : 'accent'}`}>
      <div className="between">
        <span className="eyebrow accent-text">
          {revoking ? 'Revoking approval' : summary.operator ? 'Operator approval' : 'Spending approval'}
        </span>
        {summary.unlimited && !revoking && <span className="badge failed">unlimited</span>}
      </div>

      <div className="kv">
        <span className="kv-key">{summary.operator ? 'Operator' : 'Spender'}</span>
        <span className="kv-value">{shorten(summary.spender, 10, 8)}</span>
      </div>

      {context?.spenderIsContract === false && <span className="badge failed">spender is a wallet, not a contract</span>}

      {summary.tokenId && (
        <div className="kv">
          <span className="kv-key">Token ID</span>
          <span className="kv-value">#{summary.tokenId}</span>
        </div>
      )}

      {summary.amount != null && (
        <>
          <div className="kv">
            <span className="kv-key">Current allowance</span>
            <span className="kv-value">{context?.current != null ? show(context.current) : 'unknown'}</span>
          </div>
          <div className="kv">
            <span className="kv-key">After this</span>
            <span className="kv-value" style={{ color: summary.unlimited ? 'var(--danger)' : 'var(--text)' }}>
              {show(summary.amount)}
            </span>
          </div>
          {context?.direction && (
            <div className="kv">
              <span className="kv-key">Change</span>
              <span
                className="kv-value"
                style={{ color: context.direction === 'increase' ? 'var(--warn)' : 'var(--good)' }}
              >
                {context.direction}
              </span>
            </div>
          )}
        </>
      )}

      {context?.warnings?.map((warning) => (
        <div className="notice danger" key={warning}>
          {warning}
        </div>
      ))}

      {!revoking && (
        <div className="notice">
          {summary.unlimited
            ? `This lets ${shorten(summary.spender)} move any amount of ${symbol || 'this token'}, at any time, until you revoke it.`
            : summary.operator
              ? 'This lets the operator move every NFT in this collection until you revoke it.'
              : 'This grants spending permission that stays in place until revoked.'}
        </div>
      )}
    </div>
  );
}

/** The decoded arguments, so a named method is not still an opaque call. */
function DecodedArgs({ args }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <div className="between">
        <span className="eyebrow">Decoded parameters</span>
        <button className="link accent" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'hide' : `show ${args.length}`}
        </button>
      </div>
      {open &&
        args.map((arg, index) => (
          <div className="kv" key={`${arg.name}-${index}`}>
            <span className="kv-key">
              {arg.name}
              <span className="faint"> · {arg.type}</span>
            </span>
            <span className="kv-value" style={{ maxWidth: '62%' }}>
              {formatArgValue(arg.value)}
            </span>
          </div>
        ))}
    </div>
  );
}

function formatArgValue(value) {
  if (Array.isArray(value)) return value.length > 3 ? `[${value.length} items]` : value.join(', ');
  const text = String(value ?? '');
  return text.length > 66 ? `${text.slice(0, 30)}…${text.slice(-16)}` : text;
}

/**
 * The dApp-initiated network prompt.
 *
 * Two things make this dangerous and neither is visible from the raw request:
 * an endpoint that serves a chain other than the one it claims, and a silent
 * move between a testnet and a mainnet. So the RPC is probed before this
 * renders, and the change is shown as from → to rather than as a single name
 * the user has to recognise on its own.
 */
function ChainRequest({ request }) {
  const isAdd = request.kind === 'addChain';
  const target = request.network;
  const current = request.current;
  const verification = request.verification;
  const urls = target.rpcUrls?.length ? target.rpcUrls : [target.rpc].filter(Boolean);

  // Crossing the testnet boundary changes whether the money is real.
  const crossingRealMoney = current && current.testnet && target.testnet === false;
  const crossingToTest = current && !current.testnet && target.testnet;

  return (
    <>
      <h1>{isAdd ? 'Add this network' : 'Switch network'}</h1>

      {request.alreadyKnown && (
        <div className="notice info">
          This site asked to add a network ADRIX already has, so nothing will be added — this is a switch.
        </div>
      )}

      <div className="card">
        <div className="chain-hop">
          <div className="chain-hop-side">
            <span className="chain-hop-label">From</span>
            <span className="chain-hop-name">{current?.name ?? 'Not connected'}</span>
            <span className="chain-hop-meta mono">{current?.chainId ?? '--'}</span>
          </div>
          <span className="chain-hop-arrow" aria-hidden="true">
            →
          </span>
          <div className="chain-hop-side">
            <span className="chain-hop-label">To</span>
            <span className="chain-hop-name">{target.name}</span>
            <span className="chain-hop-meta mono">{target.chainId}</span>
          </div>
        </div>
      </div>

      {crossingRealMoney && (
        <div className="notice danger">
          This moves you from a test network to <b>{target.name}</b>, where transactions spend real funds.
        </div>
      )}
      {crossingToTest && (
        <div className="notice">
          This moves you to a test network. Balances there have no value, and anything you send will not appear on{' '}
          {current.name}.
        </div>
      )}

      <div className="card">
        <div className="between">
          <span className="small">Currency</span>
          <span className="mono small">{target.symbol}</span>
        </div>
        {target.explorer && (
          <div className="between">
            <span className="small">Explorer</span>
            <span className="mono small break">{target.explorer}</span>
          </div>
        )}
        <div className="eyebrow">RPC endpoint{urls.length > 1 ? `s (${urls.length})` : ''}</div>
        {urls.map((url) => (
          <div className="data-block" key={url}>
            {url}
          </div>
        ))}
      </div>

      {isAdd && verification && <ChainVerification verification={verification} target={target} />}

      {isAdd && (
        <div className="notice">
          This endpoint will see every address you query and every transaction you broadcast on this network. Add
          networks only from sites you trust.
        </div>
      )}
    </>
  );
}

/** What the pre-flight probe of the offered endpoint found. */
function ChainVerification({ verification, target }) {
  if (!verification.ok) {
    return (
      <div className="notice danger">
        <b>ADRIX could not verify this endpoint.</b>
        <p className="small">{verification.error}</p>
        <p className="small">
          An endpoint that cannot be reached, or that serves a different chain than {target.chainId}, can produce
          signatures valid somewhere you did not intend. Adding it anyway is not recommended.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="between">
        <span className="eyebrow">Endpoint check</span>
        <span className="badge confirmed">chain ID matches</span>
      </div>
      <div className="kv">
        <span className="kv-key">Round trip</span>
        <span className="kv-value">{verification.latencyMs}ms</span>
      </div>
      <div className="kv">
        <span className="kv-key">Head block</span>
        <span className="kv-value">{verification.blockNumber}</span>
      </div>
      <div className="kv">
        <span className="kv-key">Fee market</span>
        <span className="kv-value">{verification.supportsEip1559 ? 'EIP-1559' : 'legacy gas price'}</span>
      </div>
      {verification.warnings?.map((warning) => (
        <div className="notice" key={warning}>
          {warning}
        </div>
      ))}
    </div>
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
