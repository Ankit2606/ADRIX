import { useState } from 'react';
import { call, shorten, useAsyncAction } from '../../lib/ui.js';
import { BackBar, CopyButton } from '../components/common.jsx';

/**
 * Full metadata for one tracked NFT. The image and every text field come from a
 * third-party URI, so nothing here is treated as trusted markup — values render
 * as text and links are shown as text the user can read before following.
 */
export default function NftDetail({ nft, explorer, onBack, onChanged, onSend }) {
  const [imageFailed, setImageFailed] = useState(false);
  const { busy, error, run } = useAsyncAction();

  const traits = nft.traits ?? [];
  const owned = nft.balance != null && BigInt(nft.balance || '0') > 0n;

  const act = (type) =>
    run(async () => {
      await call(type, { nft });
      await onChanged?.();
      onBack();
    });

  return (
    <div className="screen">
      <BackBar title={nft.standard ?? 'NFT'} onBack={onBack} />
      <div className="scroll pad stack">
        {nft.spam?.likelySpam && (
          <div className="notice danger">
            <b>This looks like spam.</b>
            <ul className="plain-list small" style={{ marginTop: 6 }}>
              {nft.spam.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            Do not visit any address in its metadata. Unsolicited NFTs are the standard delivery route for drainer
            sites.
          </div>
        )}

        <div className="nft-hero">
          {nft.image && !imageFailed ? (
            <img src={nft.image} alt={nft.title || `Token ${nft.tokenId}`} onError={() => setImageFailed(true)} />
          ) : (
            <div className="nft-placeholder" style={{ aspectRatio: '1' }}>
              {imageFailed ? 'image unavailable' : nft.standard}
            </div>
          )}
        </div>

        <div className="stack-sm">
          <h1>{nft.title || nft.name || `${nft.standard} #${nft.tokenId}`}</h1>
          <div className="inline wrap">
            <span className="badge">{nft.standard}</span>
            {nft.declaredStandard === false && <span className="badge pending">standard inferred</span>}
            <span className={`badge ${owned ? 'confirmed' : 'failed'}`}>
              {owned ? `${nft.balance} owned` : 'not owned'}
            </span>
          </div>
        </div>

        {nft.description && <p className="small">{nft.description}</p>}

        {traits.length > 0 && (
          <div className="card">
            <span className="eyebrow">Traits</span>
            <div className="trait-grid">
              {traits.map((trait, index) => (
                <div className="trait" key={`${trait.type}-${index}`}>
                  <span className="trait-type">{trait.type || 'trait'}</span>
                  <span className="trait-value">{trait.value || '--'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card">
          <span className="eyebrow">On chain</span>
          <div className="kv">
            <span className="kv-key">Contract</span>
            <span className="kv-value inline" style={{ justifyContent: 'flex-end' }}>
              {shorten(nft.address, 10, 8)}
              <CopyButton value={nft.address} label="⧉" className="link" />
            </span>
          </div>
          <div className="kv">
            <span className="kv-key">Token ID</span>
            <span className="kv-value">{nft.tokenId}</span>
          </div>
          {nft.symbol && (
            <div className="kv">
              <span className="kv-key">Collection</span>
              <span className="kv-value">{nft.symbol}</span>
            </div>
          )}
          {nft.owner && (
            <div className="kv">
              <span className="kv-key">Owner</span>
              <span className="kv-value">{shorten(nft.owner, 10, 8)}</span>
            </div>
          )}
          {nft.error && (
            <div className="notice">Could not read this token from the chain: {nft.error}</div>
          )}
        </div>

        {(nft.tokenUri || nft.metadataUrl || nft.externalUrl) && (
          <div className="card">
            <span className="eyebrow">Metadata source</span>
            {nft.tokenUri && (
              <>
                <span className="small faint">Token URI</span>
                <div className="data-block">{nft.tokenUri}</div>
              </>
            )}
            {nft.externalUrl && (
              <>
                <span className="small faint">External link (shown as text, not a link, deliberately)</span>
                <div className="data-block">{nft.externalUrl}</div>
              </>
            )}
          </div>
        )}

        {error && <div className="error" role="alert">{error}</div>}

        {onSend && (
          <button className="primary" onClick={() => onSend(nft)} disabled={!owned}>
            {owned ? 'Send this NFT' : 'Not owned by this account'}
          </button>
        )}

        <div className="row2">
          {explorer && (
            <a
              className="ghost"
              href={`${explorer}/token/${nft.address}?a=${nft.tokenId}`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: 'none' }}
            >
              Explorer ↗
            </a>
          )}
          <button className="ghost" onClick={() => act('HIDE_NFT')} disabled={busy}>
            {busy ? 'Working…' : 'Hide'}
          </button>
        </div>
        <button className="danger" onClick={() => act('REMOVE_NFT')} disabled={busy}>
          Stop tracking
        </button>
      </div>
    </div>
  );
}
