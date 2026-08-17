import { useState } from 'react';
import { call, shorten, trimAmount } from '../../lib/ui.js';
import { BackBar } from '../components/common.jsx';

export default function AddToken({ state, go }) {
  const [address, setAddress] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [token, setToken] = useState(null);
  const [nftAddress, setNftAddress] = useState('');
  const [nftTokenId, setNftTokenId] = useState('');
  const [nft, setNft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const lookup = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    setToken(null);
    try {
      setToken(await call('LOOKUP_TOKEN', { address }));
    } catch {
      setError('No ERC-20 token found at that address on this network.');
    } finally {
      setBusy(false);
    }
  };

  const lookupNft = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    setNft(null);
    try {
      setNft(await call('LOOKUP_NFT', { nft: { address: nftAddress, tokenId: nftTokenId } }));
    } catch (err) {
      setError(err.message || 'No ERC-721 or ERC-1155 token found at that address and token ID.');
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setResults(await call('SEARCH_TOKENS', { query }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const detect = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const detected = await call('DETECT_TOKENS');
      setMessage(
        detected.length
          ? `Added ${detected.length} token${detected.length === 1 ? '' : 's'} with a balance.`
          : 'No new common tokens with a balance were found.'
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const add = async (nextToken) => {
    await call('ADD_TOKEN', { token: nextToken });
    go('home');
  };

  const addNft = async () => {
    await call('ADD_NFT', { nft });
    go('home');
  };

  return (
    <div className="screen">
      <BackBar title="Add token" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <div className="card">
          <h2>Search common tokens</h2>
          <label className="field">
            <span>Name, symbol, or address</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              placeholder={`Search on ${state.network?.name ?? 'this network'}`}
            />
          </label>
          <div className="row2">
            <button className="ghost" onClick={detect} disabled={busy}>
              Auto-detect
            </button>
            <button className="primary" onClick={search} disabled={busy}>
              Search
            </button>
          </div>
          {results.length > 0 && (
            <div className="list">
              {results.map((result) => (
                <div className="item static" key={result.address}>
                  <span className="avatar" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }} />
                  <div className="item-main">
                    <span className="item-title">{result.symbol}</span>
                    <span className="item-sub">
                      {result.name} · {shorten(result.address)}
                    </span>
                  </div>
                  <button className="link" onClick={() => add(result)}>
                    add
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="field">
          <span>Token contract address</span>
          <input
            className="mono"
            placeholder="0x..."
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck="false"
          />
        </label>
        <button className="ghost" onClick={lookup} disabled={busy || !address}>
          {busy ? 'Reading contract...' : 'Look up token'}
        </button>

        {error && <div className="error">{error}</div>}
        {message && <div className="ok">{message}</div>}

        {token && (
          <div className="card">
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
            {token.balance && (
              <div className="between">
                <span className="small">Balance</span>
                <span className="mono">{trimAmount(token.balance)}</span>
              </div>
            )}
          </div>
        )}

        <div className="card">
          <h2>Track NFT</h2>
          <label className="field">
            <span>NFT contract address</span>
            <input
              className="mono"
              placeholder="0x..."
              value={nftAddress}
              onChange={(e) => setNftAddress(e.target.value)}
              spellCheck="false"
            />
          </label>
          <label className="field">
            <span>Token ID</span>
            <input
              className="mono"
              inputMode="numeric"
              value={nftTokenId}
              onChange={(e) => setNftTokenId(e.target.value)}
              placeholder="1"
            />
          </label>
          <button className="ghost" onClick={lookupNft} disabled={busy || !nftAddress || !nftTokenId}>
            {busy ? 'Reading NFT...' : 'Look up NFT'}
          </button>
          {nft && (
            <div className="item static">
              {nft.image ? (
                <img className="nft-thumb" src={nft.image} alt="" />
              ) : (
                <span className="avatar" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }} />
              )}
              <div className="item-main">
                <span className="item-title">{nft.title || nft.name || `${nft.standard} #${nft.tokenId}`}</span>
                <span className="item-sub">
                  {nft.standard} · balance {nft.balance ?? '--'}
                </span>
              </div>
              <button className="link accent" onClick={addNft}>
                add
              </button>
            </div>
          )}
        </div>

        <p className="small">
          Tokens and NFTs are saved per network. The same contract on another chain has to be added there separately.
        </p>
      </div>

      <div className="footer">
        <button
          className="primary"
          disabled={!token}
          onClick={() => add(token)}
        >
          Add token
        </button>
      </div>
    </div>
  );
}
