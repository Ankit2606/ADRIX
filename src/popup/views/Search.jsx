import { useEffect, useRef, useState } from 'react';
import { call, timeAgo, useDebounced } from '../../lib/ui.js';
import { BackBar, Avatar, EmptyState, Skeleton } from '../components/common.jsx';

const ICONS = {
  transactions: '↗',
  tokens: '◈',
  nfts: '▣',
  contacts: '☆',
  accounts: '◇',
  sites: '⬡',
  signatures: '✎',
};

/**
 * Search across everything held locally.
 *
 * The per-screen filter boxes only help once you know which screen the thing is
 * on. This answers the other question — "I remember an address, where does it
 * appear?" — and searches transactions across every network, because not
 * knowing which chain something happened on is half the reason for looking.
 */
export default function Search({ state, go }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);

  const debounced = useDebounced(query, 250);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (debounced.trim().length < 2) {
      setResult(null);
      return undefined;
    }
    setSearching(true);
    call('GLOBAL_SEARCH', { query: debounced })
      .then((next) => !cancelled && setResult(next))
      .catch(() => !cancelled && setResult(null))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // Every result opens the thing itself, not merely the screen it lives on. A
  // hit that only confirms something exists leaves the user to go and find it
  // again by hand, which is the work the search was meant to save.
  const open = (item) => {
    switch (item.kind) {
      case 'transaction':
        go('home', { tab: 'activity', hash: item.hash });
        break;
      case 'token':
        go('home', { tab: 'tokens' });
        break;
      case 'nft':
        go('home', { tab: 'nfts' });
        break;
      case 'contact':
      case 'site':
      case 'signature':
        go('settings');
        break;
      case 'account':
        go('accounts');
        break;
      default:
        go('home');
    }
  };

  return (
    <div className="screen">
      <BackBar title="Search" onBack={() => go('home')} />
      <div className="scroll pad stack">
        <label className="field">
          <span className="visually-hidden">Search everything</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Address, symbol, name, hash, note, tag…"
            type="search"
            spellCheck="false"
            autoComplete="off"
          />
          <span className="small faint">
            Transactions, tokens, NFTs, contacts, accounts, connected sites, and signatures — across every network.
          </span>
        </label>

        {searching && !result && <Skeleton height={54} radius={12} />}

        {query.trim().length === 1 && <p className="small faint">Keep typing — searches start at two characters.</p>}

        {result && result.total === 0 && (
          <EmptyState
            icon="⌕"
            title="Nothing found"
            body={`No transaction, token, NFT, contact, account, site, or signature matches "${result.query}".`}
          />
        )}

        {result?.otherChains && (
          <div className="notice info">
            Some of these are on a network other than {state.network?.name ?? 'the current one'}. They are labelled
            below.
          </div>
        )}

        {result?.groups.map((group) => (
          <div className="card" key={group.key}>
            <div className="between">
              <span className="eyebrow">
                {ICONS[group.key]} {group.label}
              </span>
              <span className="small faint">{group.items.length}</span>
            </div>
            <div className="list">
              {group.items.map((item) => (
                <button className="item" key={item.id} onClick={() => open(item)}>
                  {item.address && (item.kind === 'contact' || item.kind === 'account') ? (
                    <Avatar address={item.address} size="lg" />
                  ) : (
                    <span className="token-icon sm">{ICONS[group.key]}</span>
                  )}
                  <div className="item-main">
                    <span className="item-title">{item.title}</span>
                    <span className="item-sub">{item.subtitle}</span>
                    {item.at && <span className="item-sub faint">{timeAgo(item.at)}</span>}
                  </div>
                  <div className="item-right">
                    {item.offChain && <span className="badge">{item.networkName ?? 'other network'}</span>}
                    <span className="caret" aria-hidden="true">
                      ›
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}

        {result && result.total > 0 && (
          <p className="small faint">
            Showing the best matches in each group. Everything searched here is stored on this device — no query
            leaves the browser.
          </p>
        )}
      </div>
    </div>
  );
}
