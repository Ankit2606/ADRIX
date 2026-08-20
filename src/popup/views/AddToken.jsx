import { useEffect, useState } from 'react';
import { call, shorten, useDebounced, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState, Skeleton } from '../components/common.jsx';

export default function AddToken({ state, go }) {
  const [tab, setTab] = useState('token');

  return (
    <div className="screen">
      <BackBar title={tab === 'token' ? 'Add token' : 'Track NFT'} onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="tabs" role="tablist" aria-label="Asset type">
          <button role="tab" aria-selected={tab === 'token'} onClick={() => setTab('token')}>
            ERC-20 token
          </button>
          <button role="tab" aria-selected={tab === 'nft'} onClick={() => setTab('nft')}>
            NFT
          </button>
        </div>

        {tab === 'token' ? <TokenTab state={state} go={go} /> : <NftTab go={go} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TokenTab({ state, go }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState(null);
  const [detected, setDetected] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const debouncedQuery = useDebounced(query, 350);

  // Search runs as the user types against the on-device registry — no network
  // call, so there is no reason to make them press a button.
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
      const result = await call('LOOKUP_TOKEN', { address });
      setToken(result);
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

  return (
    <>
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
            placeholder={`Tokens known on ${state.network?.name ?? 'this network'}`}
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

        {searching && !results.length ? (
          <Skeleton height={44} radius={10} />
        ) : results.length ? (
          <div className="list">
            {results.map((result) => (
              <div className="item static compact" key={result.address}>
                <span className="token-icon sm">{result.symbol.charAt(0)}</span>
                <div className="item-main">
                  <span className="item-title">{result.symbol}</span>
                  <span className="item-sub">
                    {result.name} · {shorten(result.address)}
                  </span>
                </div>
                <button className="link accent" onClick={() => add(result)} disabled={busy}>
                  add
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="⌕"
            title={query ? 'Not in the built-in list' : 'No tokens listed for this network'}
            body="Add it by contract address below — the symbol, name, and decimals are read from the chain."
          />
        )}
      </div>

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
          Tokens are saved per network. The same contract on another chain has to be added there separately.
        </p>
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
