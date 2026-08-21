import { useEffect, useState } from 'react';
import { call, shorten, timeAgo, useDebounced, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState, Skeleton } from '../components/common.jsx';

export default function AddToken({ state, go }) {
  const [tab, setTab] = useState('token');

  const title = tab === 'token' ? 'Add token' : tab === 'nft' ? 'Track NFT' : 'Token lists';

  return (
    <div className="screen">
      <BackBar title={title} onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="tabs" role="tablist" aria-label="Asset type">
          <button role="tab" aria-selected={tab === 'token'} onClick={() => setTab('token')}>
            Token
          </button>
          <button role="tab" aria-selected={tab === 'nft'} onClick={() => setTab('nft')}>
            NFT
          </button>
          <button role="tab" aria-selected={tab === 'lists'} onClick={() => setTab('lists')}>
            Lists
          </button>
        </div>

        {tab === 'token' ? (
          <TokenTab state={state} go={go} onOpenLists={() => setTab('lists')} />
        ) : tab === 'nft' ? (
          <NftTab go={go} />
        ) : (
          <TokenListsTab />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TokenTab({ state, go, onOpenLists }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState([]);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState(null);
  const [detected, setDetected] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const debouncedQuery = useDebounced(query, 350);

  // Search runs as the user types across the built-in registry and every
  // imported list — all held on device, so there is no network call and no
  // reason to make them press a button.
  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    call('SEARCH_TOKENS', { query: debouncedQuery })
      .then((list) => !cancelled && setResults(list))
      .catch(() => !cancelled && setResults([]))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, state.chainId]);

  const lookup = () =>
    run(async () => {
      setToken(null);
      setDetected(null);
      setToken(await call('LOOKUP_TOKEN', { address }));
    });

  const detect = () =>
    run(async () => {
      setToken(null);
      setDetected(await call('DETECT_TOKENS'));
    });

  const add = (nextToken) =>
    run(async () => {
      await call('ADD_TOKEN', { token: nextToken });
      go('home');
    });

  const toggle = (addr) =>
    setSelected((current) => (current.includes(addr) ? current.filter((a) => a !== addr) : [...current, addr]));

  const addSelected = () =>
    run(async () => {
      const entries = results.filter((row) => selected.includes(row.address));
      const result = await call('ADD_TOKENS', { entries });
      setBulkResult(result);
      setSelected([]);
    });

  const flaggedSelected = results.filter((row) => selected.includes(row.address) && row.suspicious).length;

  return (
    <>
    <div className="card">
        <h2>Add by contract address</h2>
        <label className="field">
          <span>Token contract address</span>
          <input
            className="mono"
            placeholder="0x…"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setError('');
              setToken(null);
            }}
            spellCheck="false"
          />
        </label>
        <button className="ghost" onClick={lookup} disabled={busy || !address}>
          {busy ? 'Reading contract…' : 'Look up token'}
        </button>

        {error && <div className="error" role="alert">{error}</div>}

        {token && (
          <div className="stack-sm">
            <div className="between">
              <span className="small">Name</span>
              <span>{token.name || '--'}</span>
            </div>
            <div className="between">
              <span className="small">Symbol</span>
              <span className="mono">{token.symbol}</span>
            </div>
            <div className="between">
              <span className="small">Decimals</span>
              <span className="mono">{token.decimals}</span>
            </div>
            <div className="between">
              <span className="small">Contract</span>
              <span className="mono small">{shorten(token.address, 8, 6)}</span>
            </div>
            <button className="primary" onClick={() => add(token)} disabled={busy}>
              Add {token.symbol}
            </button>
          </div>
        )}

        <p className="small faint">
          Read straight from the contract, so the symbol and decimals are whatever the token itself reports. Tokens are
          saved per network.
        </p>
      </div>
      <div className="card">
        <div className="between">
          <h2>Find a token</h2>
          <button className="link accent" onClick={detect} disabled={busy}>
            {busy ? 'scanning…' : 'auto-detect'}
          </button>
        </div>
        <p className="small">
          Auto-detect checks your balance for the common tokens on {state.network?.name ?? 'this network'} and adds any
          you hold.
        </p>

        <label className="field">
          <span>Search by name, symbol, or address</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Across the built-in list and any you have imported"
            type="search"
            autoFocus
          />
        </label>

        {detected && (
          <div className={detected.length ? 'ok' : 'notice'}>
            {detected.length
              ? `Added ${detected.length} token${detected.length === 1 ? '' : 's'} with a balance: ${detected
                  .map((t) => t.symbol)
                  .join(', ')}.`
              : 'No common tokens with a balance were found on this network.'}
          </div>
        )}

        {bulkResult && (
          <div className={bulkResult.failed.length ? 'notice' : 'ok'}>
            Added {bulkResult.added} of {bulkResult.total}.
            {bulkResult.failed.length > 0 && ` ${bulkResult.failed.length} failed: ${bulkResult.failed[0].error}`}
          </div>
        )}

        {selected.length > 0 && (
          <div className="card accent">
            <div className="between">
              <span className="small">{selected.length} selected</span>
              <button className="link" onClick={() => setSelected([])}>
                clear
              </button>
            </div>
            {flaggedSelected > 0 && (
              <div className="notice danger">
                {flaggedSelected} of these are flagged. Adding a token is harmless on its own, but sending to the wrong
                contract is not — check the addresses.
              </div>
            )}
            <button className="primary" onClick={addSelected} disabled={busy}>
              {busy ? 'Adding…' : `Add ${selected.length} token${selected.length === 1 ? '' : 's'}`}
            </button>
          </div>
        )}

        {searching && !results.length ? (
          <Skeleton height={44} radius={10} />
        ) : results.length ? (
          <div className="list">
            {results.map((result) => (
              <TokenResult
                key={result.address}
                token={result}
                checked={selected.includes(result.address)}
                onToggle={() => toggle(result.address)}
                onAdd={() => add(result)}
                busy={busy}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon="⌕"
            title={query ? 'No match in your lists' : 'No tokens listed for this network'}
            body="Import a token list for broader coverage, or add one by contract address below."
            action={
              <button className="ghost" onClick={onOpenLists}>
                Import a token list
              </button>
            }
          />
        )}
      </div>

      
    </>
  );
}

/**
 * One search hit.
 *
 * Where the entry came from is shown as prominently as the symbol. A token list
 * is third-party data: two contracts can both call themselves USDC, and the
 * only thing distinguishing them is provenance and the address itself.
 */
function TokenResult({ token, checked, onToggle, onAdd, busy }) {
  const [showWhy, setShowWhy] = useState(false);

  return (
    <div className={`item static compact ${token.suspicious ? 'flagged' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={token.tracked}
        aria-label={`Select ${token.symbol}`}
      />
      {token.logoURI ? (
        <img className="token-logo" src={token.logoURI} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span className="token-icon sm">{token.symbol.charAt(0)}</span>
      )}

      <div className="item-main">
        <span className="item-title">
          {token.symbol}
          {token.builtIn && <span className="badge confirmed" style={{ marginLeft: 6 }}>built in</span>}
          {token.symbolClash && !token.builtIn && (
            <span className="badge failed" style={{ marginLeft: 6 }}>symbol clash</span>
          )}
        </span>
        <span className="item-sub">
          {token.name} · {shorten(token.address, 8, 6)}
        </span>
        <span className="item-sub faint">via {token.sources.join(', ')}</span>

        {token.suspicious && token.reasons.length > 0 && (
          <>
            <button className="link" onClick={() => setShowWhy(!showWhy)} aria-expanded={showWhy}>
              {showWhy ? 'hide' : 'why flagged?'}
            </button>
            {showWhy && (
              <ul className="plain-list small" style={{ color: 'var(--danger)' }}>
                {token.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {token.tracked ? (
        <span className="badge">tracked</span>
      ) : (
        <button className="link accent" onClick={onAdd} disabled={busy}>
          add
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * Token list management.
 *
 * Importing a list is a trust decision, not a convenience: the list decides
 * which contract address the word "USDC" points at in the search box. That is
 * why nothing is imported by default, the preview shows exactly what a list
 * contains before it is saved, and the source URL stays visible afterwards.
 */
function TokenListsTab() {
  const [lists, setLists] = useState([]);
  const [curated, setCurated] = useState([]);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => {
    const result = await call('GET_TOKEN_LISTS');
    setLists(result.lists);
    setCurated(result.curated);
  };

  useEffect(() => {
    load().catch(() => {});
  }, []);

  const previewList = (target) =>
    run(async () => {
      setPreview(null);
      setPreview(await call('PREVIEW_TOKEN_LIST', { url: target }));
    });

  const confirmImport = () =>
    run(async () => {
      await call('ADD_TOKEN_LIST', { url: preview.url });
      setPreview(null);
      setUrl('');
      await load();
    });

  const act = (type, target) =>
    run(async () => {
      await call(type, { url: target });
      await load();
    });

  const imported = new Set(lists.map((list) => list.url));

  if (preview) {
    return (
      <div className="card">
        <div className="between">
          <h2>{preview.name}</h2>
          <button className="link" onClick={() => setPreview(null)}>
            close
          </button>
        </div>

        <div className="stat-grid">
          <div className="stat">
            <span className="stat-value">{preview.tokenCount.toLocaleString()}</span>
            <span className="stat-label">Tokens kept</span>
          </div>
          <div className="stat">
            <span className="stat-value">{preview.chainCount}</span>
            <span className="stat-label">Chains</span>
          </div>
          {preview.rejected > 0 && (
            <div className="stat">
              <span className="stat-value danger">{preview.rejected}</span>
              <span className="stat-label">Malformed</span>
            </div>
          )}
          {preview.nonEvm > 0 && (
            <div className="stat">
              <span className="stat-value">{preview.nonEvm}</span>
              <span className="stat-label">Non-EVM</span>
            </div>
          )}
          {preview.version && (
            <div className="stat">
              <span className="stat-value" style={{ fontSize: 14 }}>
                v{preview.version}
              </span>
              <span className="stat-label">Version</span>
            </div>
          )}
        </div>

        <div className="eyebrow">Source</div>
        <div className="data-block">{preview.url}</div>

        {preview.nonEvm > 0 && (
          <p className="small faint">
            {preview.nonEvm} entries are for non-EVM chains (Solana and similar) and are skipped. That is normal for a
            multi-chain list, not a fault in it.
          </p>
        )}
        {preview.rejected > 0 && (
          <p className="small faint">
            {preview.rejected} entries were dropped for a malformed address, symbol, or decimals value. A list with
            many of these is worth being suspicious of.
          </p>
        )}
        {preview.truncated && (
          <div className="notice">
            This list is longer than ADRIX stores, so only the first {preview.tokenCount.toLocaleString()} entries are
            kept.
          </div>
        )}

        <div className="notice">
          A token list decides which contract a symbol points at. Import only lists whose publisher you would trust with
          that — a hostile list needs one entry claiming to be a token you already hold.
        </div>

        {error && <div className="error" role="alert">{error}</div>}
        <div className="row2">
          <button className="ghost" onClick={() => setPreview(null)}>
            Cancel
          </button>
          <button className="primary" onClick={confirmImport} disabled={busy}>
            {busy ? 'Importing…' : 'Import this list'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>Imported lists</h2>
        {!lists.length ? (
          <p className="small">
            No lists imported. ADRIX ships a small built-in registry of major tokens; a list adds thousands more to the
            search box without adding them to your wallet.
          </p>
        ) : (
          <div className="list">
            {lists.map((list) => (
              <div className="item static" key={list.url}>
                <input
                  type="checkbox"
                  checked={list.enabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    run(async () => {
                      await call('SET_TOKEN_LIST_ENABLED', { url: list.url, enabled });
                      await load();
                    });
                  }}
                  aria-label={`Use ${list.name} in search`}
                />
                <div className="item-main">
                  <span className="item-title">{list.name}</span>
                  <span className="item-sub">
                    {list.tokenCount.toLocaleString()} tokens · {list.chainCount} chains
                    {list.version ? ` · v${list.version}` : ''}
                  </span>
                  <span className="item-sub faint">updated {timeAgo(list.fetchedAt)}</span>
                </div>
                <div className="item-right">
                  <button className="link accent" onClick={() => act('REFRESH_TOKEN_LIST', list.url)} disabled={busy}>
                    refresh
                  </button>
                  <button className="link" onClick={() => act('REMOVE_TOKEN_LIST', list.url)} disabled={busy}>
                    remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Add a list</h2>
        <label className="field">
          <span>Token list URL</span>
          <input
            className="mono"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError('');
            }}
            placeholder="https://tokens.example.org/list.json"
            spellCheck="false"
          />
          <span className="small faint">
            Any tokenlists.org-format JSON. Must be https — an unencrypted list can be rewritten in transit.
          </span>
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="ghost" onClick={() => previewList(url)} disabled={busy || !url.trim()}>
          {busy ? 'Fetching…' : 'Preview list'}
        </button>
      </div>

      <div className="card">
        <h2>Well-known lists</h2>
        <p className="small">
          Widely used and served from stable URLs. Listing them here is not an endorsement of every token they contain.
        </p>
        <div className="list">
          {curated.map((entry) => (
            <div className="item static" key={entry.url}>
              <div className="item-main">
                <span className="item-title">{entry.name}</span>
                <span className="item-sub">{entry.hint}</span>
                <span className="item-sub faint mono">{entry.url}</span>
              </div>
              {imported.has(entry.url) ? (
                <span className="badge confirmed">imported</span>
              ) : (
                <button className="link accent" onClick={() => previewList(entry.url)} disabled={busy}>
                  preview
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function NftTab({ go }) {
  const [address, setAddress] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [nft, setNft] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const lookup = () =>
    run(async () => {
      setNft(null);
      setNft(await call('LOOKUP_NFT', { nft: { address, tokenId } }));
    });

  const add = () =>
    run(async () => {
      await call('ADD_NFT', { nft });
      go('home');
    });

  return (
    <div className="card">
      <h2>Track an NFT</h2>
      <p className="small">
        ADRIX has no NFT indexer, so each token is tracked by contract and ID. ERC-721 and ERC-1155 both work; the
        standard is detected from the contract.
      </p>

      <label className="field">
        <span>NFT contract address</span>
        <input
          className="mono"
          placeholder="0x…"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setError('');
            setNft(null);
          }}
          spellCheck="false"
        />
      </label>
      <label className="field">
        <span>Token ID</span>
        <input
          className="mono"
          inputMode="numeric"
          value={tokenId}
          onChange={(e) => {
            setTokenId(e.target.value);
            setError('');
            setNft(null);
          }}
          placeholder="1"
        />
      </label>

      <button className="ghost" onClick={lookup} disabled={busy || !address || !tokenId}>
        {busy ? 'Reading contract…' : 'Look up NFT'}
      </button>

      {error && <div className="error" role="alert">{error}</div>}

      {nft && (
        <div className="stack-sm">
          <div className="item static">
            {nft.image ? (
              <img className="nft-thumb" src={nft.image} alt="" />
            ) : (
              <span className="token-icon">▣</span>
            )}
            <div className="item-main">
              <span className="item-title">{nft.title || nft.name || `${nft.standard} #${nft.tokenId}`}</span>
              <span className="item-sub">
                {nft.standard} · you own {nft.balance ?? '--'}
              </span>
            </div>
          </div>
          {nft.balance === '0' && (
            <div className="notice">
              The selected account does not currently own this token. You can still track it.
            </div>
          )}
          {nft.description && <p className="small faint">{nft.description.slice(0, 220)}</p>}
          <button className="primary" onClick={add} disabled={busy}>
            Track this NFT
          </button>
        </div>
      )}
    </div>
  );
}
