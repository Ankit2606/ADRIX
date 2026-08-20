import { useEffect, useState } from 'react';
import { call, shorten, trimAmount, useDebounced, useAsyncAction } from '../../lib/ui.js';
import { BackBar, Avatar, EmptyState, QrScanner } from '../components/common.jsx';

/**
 * Transferring one NFT. Kept separate from the token send flow because the
 * checks are different in kind: there is no divisible amount for an ERC-721,
 * ownership has to be re-read, and the recipient has to be able to *receive*
 * an NFT — a plain transfer to an unprepared contract loses the token.
 */
export default function SendNft({ nft, state, contacts = [], onBack, onSent }) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1');
  const [step, setStep] = useState('form');
  const [scanning, setScanning] = useState(false);
  const [inspection, setInspection] = useState(null);
  const [checks, setChecks] = useState(null);
  const [gasInfo, setGasInfo] = useState(null);
  const [preset, setPreset] = useState('market');
  const [hash, setHash] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  const isMulti = nft.standard === 'ERC1155';
  const owned = nft.balance != null ? BigInt(nft.balance || '0') : null;
  const debounced = useDebounced(recipient, 450);

  useEffect(() => {
    let cancelled = false;
    if (!debounced.trim()) {
      setInspection(null);
      return undefined;
    }
    call('INSPECT_RECIPIENT', { input: debounced })
      .then((result) => !cancelled && setInspection(result))
      .catch(() => !cancelled && setInspection(null));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const review = () =>
    run(async () => {
      const { address } = await call('RESOLVE_RECIPIENT', { input: recipient });

      if (isMulti) {
        const quantity = Number(amount);
        if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Enter a whole quantity of at least 1.');
        if (owned != null && BigInt(quantity) > owned) {
          throw new Error(`You hold ${owned.toString()} of this token.`);
        }
      }

      const result = await call('CHECK_NFT_TRANSFER', { nft, to: address, amount: isMulti ? Number(amount) : 1 });
      setChecks({ ...result, address });

      setGasInfo(
        await call('ESTIMATE_NFT_TRANSFER', { nft, to: address, amount: isMulti ? Number(amount) : 1 })
      );
      setStep('review');
    });

  const confirm = () =>
    run(async () => {
      const result = await call('SEND_NFT', {
        nft,
        to: checks.address,
        amount: isMulti ? Number(amount) : 1,
        fees: gasInfo.options[preset],
        gas: gasInfo.gasLimit,
      });
      setHash(result.hash);
      setStep('sent');
      onSent?.();
    });

  const title = nft.title || nft.name || `${nft.standard} #${nft.tokenId}`;

  if (step === 'sent') {
    return (
      <div className="screen">
        <BackBar title="Sent" onBack={onBack} />
        <div className="scroll pad stack">
          <div className="beam" />
          <h1>Transfer submitted</h1>
          <p>
            {isMulti ? `${amount} × ` : ''}
            {title} is on its way to {shorten(checks.address, 8, 6)}.
          </p>
          <div className="data-block">{hash}</div>
          {state.network?.explorer && (
            <a className="link accent" href={`${state.network.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
              Open in block explorer ↗
            </a>
          )}
          <div className="spacer" />
        </div>
        <div className="footer">
          <button className="primary" onClick={onBack}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (step === 'review') {
    const option = gasInfo.options[preset];
    const cannotReceive = checks?.recipient?.canReceive === false;
    const unknownReceiver = checks?.recipient?.isContract && checks?.recipient?.canReceive === null;

    return (
      <div className="screen">
        <BackBar title="Review transfer" onBack={() => setStep('form')} />
        <div className="scroll pad stack">
          <div className="item static">
            <NftThumb nft={nft} />
            <div className="item-main">
              <span className="item-title">{title}</span>
              <span className="item-sub">
                {nft.standard} · #{nft.tokenId}
                {isMulti ? ` · sending ${amount}` : ''}
              </span>
            </div>
          </div>

          <div className="card">
            <div className="kv">
              <span className="kv-key">To</span>
              <span className="kv-value">{shorten(checks.address, 10, 8)}</span>
            </div>
            {inspection?.ens && (
              <div className="kv">
                <span className="kv-key">ENS</span>
                <span className="kv-value">{inspection.ens}</span>
              </div>
            )}
            <div className="kv">
              <span className="kv-key">Network</span>
              <span className="kv-value">{state.network?.name}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Network fee</span>
              <span className="kv-value">
                ~{trimAmount(option.likelyFee ?? option.estimatedFee, 6)} {gasInfo.symbol}
              </span>
            </div>
          </div>

          {cannotReceive && (
            <div className="notice danger">
              This recipient is a contract that does not declare NFT receiver support. Sending here will most likely
              revert — and if it did not, the token would be stuck there permanently.
            </div>
          )}
          {unknownReceiver && (
            <div className="notice">
              The recipient is a contract that does not answer EIP-165. ADRIX cannot tell whether it can hold NFTs.
              Only continue if you know it can.
            </div>
          )}
          {inspection?.seenBefore === false && (
            <div className="notice">You have never sent to this address before. Check it once more.</div>
          )}

          <h3>Network fee</h3>
          <div className="gas-grid">
            {['low', 'market', 'fast'].map((key) => (
              <button key={key} className="gas-option" aria-pressed={preset === key} onClick={() => setPreset(key)}>
                <b>{key === 'low' ? 'Slow' : key === 'market' ? 'Market' : 'Fast'}</b>
                <span>~{trimAmount(gasInfo.options[key].likelyFee ?? gasInfo.options[key].estimatedFee, 6)}</span>
              </button>
            ))}
          </div>

          {gasInfo.estimateError && (
            <div className="notice danger">
              This transfer could not be simulated: {gasInfo.estimateError}. It would probably fail and still cost the
              fee.
            </div>
          )}
          {error && <div className="error" role="alert">{error}</div>}

          <div className="notice">
            NFT transfers are final. There is no way to reverse one once it confirms.
          </div>
        </div>
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={() => setStep('form')}>
              Back
            </button>
            <button className="primary" onClick={confirm} disabled={busy || cannotReceive}>
              {busy ? 'Sending…' : 'Send NFT'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const notOwned = owned != null && owned <= 0n;

  return (
    <div className="screen">
      <BackBar
        title="Send NFT"
        onBack={onBack}
        right={
          <button className="icon-btn plain" onClick={() => setScanning(true)} aria-label="Scan a QR code">
            ⛶
          </button>
        }
      />
      <div className="scroll pad stack">
        {scanning ? (
          <QrScanner
            onClose={() => setScanning(false)}
            onResult={(value) => {
              setScanning(false);
              setRecipient(String(value).replace(/^ethereum:/i, '').split(/[@?]/)[0]);
            }}
          />
        ) : (
          <>
            <div className="item static">
              <NftThumb nft={nft} />
              <div className="item-main">
                <span className="item-title">{title}</span>
                <span className="item-sub">
                  {nft.standard} · #{nft.tokenId}
                </span>
                <span className="item-sub">{owned == null ? 'ownership unknown' : `${owned.toString()} owned`}</span>
              </div>
            </div>

            {notOwned && (
              <div className="notice danger">
                This account does not currently hold this token, so it cannot be sent.
              </div>
            )}

            <div className="stack-sm">
              <div className="eyebrow">To</div>
              <div className="address-input">
                <input
                  placeholder="Address (0x…) or ENS name"
                  value={recipient}
                  onChange={(e) => {
                    setRecipient(e.target.value);
                    setError('');
                  }}
                  spellCheck="false"
                  autoComplete="off"
                  aria-label="Recipient address"
                />
                {recipient && (
                  <button className="icon-btn plain" onClick={() => setRecipient('')} aria-label="Clear">
                    ✕
                  </button>
                )}
              </div>
              {inspection?.state === 'invalid' && <div className="error">{inspection.message}</div>}
              {inspection?.state === 'ok' && (
                <div className="inline wrap">
                  <span className="badge confirmed">valid</span>
                  {inspection.ens && <span className="badge accent">{inspection.ens}</span>}
                  {inspection.isContract === true && <span className="badge failed">contract</span>}
                  {inspection.seenBefore === false && <span className="badge pending">first time</span>}
                </div>
              )}
            </div>

            {isMulti && (
              <label className="field">
                <span>Quantity</span>
                <div className="input-group">
                  <input
                    className="mono"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                  />
                  <button className="ghost" onClick={() => setAmount(owned?.toString() ?? '1')}>
                    Max
                  </button>
                </div>
                <span className="small faint">
                  ERC-1155 tokens are fungible within their ID — you hold {owned?.toString() ?? '?'}.
                </span>
              </label>
            )}

            {contacts.length > 0 && (
              <div className="stack-sm">
                <div className="eyebrow">Contacts</div>
                <div className="list">
                  {contacts.slice(0, 4).map((contact) => (
                    <button
                      key={contact.id}
                      className={`item ${contact.address.toLowerCase() === recipient.trim().toLowerCase() ? 'selected' : ''}`}
                      onClick={() => setRecipient(contact.address)}
                    >
                      <Avatar address={contact.address} size="lg" />
                      <div className="item-main">
                        <span className="item-title">
                          {contact.favorite ? '★ ' : ''}
                          {contact.name}
                        </span>
                        <span className="item-sub">{shorten(contact.address, 10, 8)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!contacts.length && (
              <EmptyState
                icon="☆"
                title="No saved contacts"
                body="Add trusted recipients in Settings → Address book to avoid pasting addresses."
              />
            )}

            {error && <div className="error" role="alert">{error}</div>}
          </>
        )}
      </div>

      {!scanning && (
        <div className="footer">
          <div className="row2">
            <button className="ghost" onClick={onBack}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={review}
              disabled={busy || !recipient || notOwned || inspection?.state === 'invalid'}
            >
              {busy ? 'Checking…' : 'Review'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NftThumb({ nft }) {
  if (nft.image) return <img className="nft-thumb" src={nft.image} alt="" />;
  return <span className="token-icon">▣</span>;
}
