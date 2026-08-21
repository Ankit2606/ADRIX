import { useEffect, useState } from 'react';
import { call, formatFiat, shorten, timeAgo, trimAmount, useAsyncAction } from '../../lib/ui.js';
import { BackBar, CopyButton, Skeleton } from '../components/common.jsx';

/**
 * Full metadata for one tracked NFT. The image and every text field come from a
 * third-party URI, so nothing here is treated as trusted markup — values render
 * as text and links are shown as text the user can read before following.
 */
export default function NftDetail({ nft, explorer, currency = 'usd', onBack, onChanged, onSend }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [collection, setCollection] = useState(nft.collection ?? null);
  const [loadingFloor, setLoadingFloor] = useState(!nft.collection);
  const { busy, error, run } = useAsyncAction();

  const traits = nft.traits ?? [];
  const owned = nft.balance != null && BigInt(nft.balance || '0') > 0n;

  // Floor data is fetched here rather than with the portfolio: it is a
  // third-party round trip per collection, and this is the one screen where the
  // number is actually being looked at.
  const loadCollection = async (force = false) => {
    setLoadingFloor(true);
    try {
      const result = await call('GET_NFT_COLLECTION', { address: nft.address, force });
      setCollection(result.collection);
    } catch {
      setCollection(null);
    } finally {
      setLoadingFloor(false);
    }
  };

  useEffect(() => {
    loadCollection(false);
  }, [nft.address]);

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

        <CollectionPanel
          collection={collection}
          loading={loadingFloor}
          currency={currency}
          onRefresh={() => loadCollection(true)}
        />

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

        {explorer && (
          <div className="row2">
            <a
              className="ghost"
              href={`${explorer}/token/${nft.address}?a=${nft.tokenId}`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: 'none' }}
            >
              This token ↗
            </a>
            <a
              className="ghost"
              href={`${explorer}/token/${nft.address}`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: 'none' }}
            >
              Collection ↗
            </a>
          </div>
        )}

        <button className="ghost" onClick={() => act('HIDE_NFT')} disabled={busy}>
          {busy ? 'Working…' : 'Hide'}
        </button>
        <button className="danger" onClick={() => act('REMOVE_NFT')} disabled={busy}>
          Stop tracking
        </button>
      </div>
    </div>
  );
}

/**
 * Collection floor and market stats.
 *
 * The floor is the cheapest listing right now, not an appraisal of this
 * particular token — traits move a piece well above or below it, and a thin
 * collection's floor can be one listing deep. Saying so is the difference
 * between useful context and a fake valuation.
 */
function CollectionPanel({ collection, loading, currency, onRefresh }) {
  if (loading && !collection) {
    return (
      <div className="card">
        <span className="eyebrow">Collection</span>
        <Skeleton height={38} radius={10} />
      </div>
    );
  }

  if (!collection) {
    return (
      <div className="card">
        <div className="between">
          <span className="eyebrow">Collection</span>
          <button className="link accent" onClick={onRefresh}>
            retry
          </button>
        </div>
        <p className="small faint">
          No market data for this collection. Floors come from CoinGecko, which indexes major collections on supported
          chains only — an absent floor says nothing about whether the collection is real.
        </p>
      </div>
    );
  }

  const change = collection.floorChange24h;

  return (
    <div className="card">
      <div className="between">
        <span className="eyebrow">Collection{collection.name ? ` · ${collection.name}` : ''}</span>
        <button className="link accent" onClick={onRefresh} disabled={loading}>
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      <div className="floor-row">
        <div className="floor-main">
          <span className="floor-value">
            {collection.floorNative != null
              ? `${trimAmount(collection.floorNative, 4)} ${collection.nativeSymbol ?? ''}`
              : '--'}
          </span>
          <span className="floor-label">Floor price</span>
        </div>
        <div className="floor-side">
          <span className="mono small">{formatFiat(collection.floorFiat, currency, { placeholder: '--' })}</span>
          {change != null && (
            <span className={`badge ${change >= 0 ? 'confirmed' : 'failed'}`}>
              {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% 24h
            </span>
          )}
        </div>
      </div>

      <div className="stat-grid">
        {collection.volume24hNative != null && (
          <div className="stat">
            <span className="stat-value" style={{ fontSize: 14 }}>
              {trimAmount(collection.volume24hNative, 2)} {collection.nativeSymbol ?? ''}
            </span>
            <span className="stat-label">24h volume</span>
          </div>
        )}
        {collection.totalSupply != null && (
          <div className="stat">
            <span className="stat-value" style={{ fontSize: 14 }}>
              {Number(collection.totalSupply).toLocaleString()}
            </span>
            <span className="stat-label">Items</span>
          </div>
        )}
        {collection.owners != null && (
          <div className="stat">
            <span className="stat-value" style={{ fontSize: 14 }}>
              {Number(collection.owners).toLocaleString()}
            </span>
            <span className="stat-label">Owners</span>
          </div>
        )}
      </div>

      <p className="small faint">
        The floor is the cheapest listing in the whole collection, not a valuation of this token — rare traits sell far
        above it and a shallow floor can be a single listing. Via {collection.source}, {timeAgo(collection.fetchedAt)}.
      </p>
    </div>
  );
}
