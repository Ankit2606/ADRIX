import { useEffect, useState } from 'react';
import { call, shorten, trimAmount, timeAgo } from '../../lib/ui.js';
import { TopBar, CopyButton, Avatar } from '../components/common.jsx';

const formatFiat = (val) => val ? `$${val.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '$0.00';

export default function Home({ state, go, refresh }) {
  const [portfolio, setPortfolio] = useState(null);
  const [portfolios, setPortfolios] = useState(null);
  const [tab, setTab] = useState('tokens');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [nextPortfolio, nextPortfolios] = await Promise.all([call('GET_PORTFOLIO'), call('GET_PORTFOLIOS')]);
      setPortfolio(nextPortfolio);
      setPortfolios(nextPortfolios);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [state.selected, state.chainId]);

  const totalFiat = portfolio?.native?.fiat 
    ? portfolio.native.fiat + (portfolio.tokens || []).reduce((sum, t) => sum + (t.fiat || 0), 0)
    : 0;

  return (
    <div className="screen">
      <TopBar
        state={state}
        onOpenAccounts={() => go('accounts')}
        onOpenNetworks={() => go('networks')}
        onOpenSettings={() => go('settings')}
      />

      <div className="scroll" style={{ padding: 0 }}>
        <div className="mm-balance-section">
          <div className="mm-balance-amount">
            {loading && !portfolio ? '0.0000' : trimAmount(portfolio?.native?.balance)} {portfolio?.native?.symbol ?? 'ETH'} <span style={{fontSize: '16px', cursor: 'pointer', color: 'var(--muted)'}}>👁</span>
          </div>
          <div className="mm-balance-fiat">
            {loading && !portfolio ? '+$0 (+0.00%)' : `+${formatFiat(totalFiat)} (+0.00%)`} <a href="#" className="mm-portfolio-link" onClick={(e) => { e.preventDefault(); setTab('portfolio'); }}>Portfolio ↗</a>
          </div>
          {error && <div className="error">{error}</div>}
        </div>

        <div className="mm-actions">
          <button className="mm-action-btn" onClick={() => go('buy')}>
            <div className="mm-action-icon">⇋</div>
            <span style={{fontSize: '12px'}}>Buy/Sell</span>
          </button>
          <button className="mm-action-btn" onClick={() => go('swap')}>
            <div className="mm-action-icon">⇌</div>
            <span style={{fontSize: '12px'}}>Swap</span>
          </button>
          <button className="mm-action-btn" onClick={() => go('bridge')}>
            <div className="mm-action-icon">🌉</div>
            <span style={{fontSize: '12px'}}>Bridge</span>
          </button>
          <button className="mm-action-btn" onClick={() => go('send')}>
            <div className="mm-action-icon">↗</div>
            <span style={{fontSize: '12px', fontWeight: 'bold'}}>Send</span>
          </button>
          <button className="mm-action-btn" onClick={() => go('receive')}>
            <div className="mm-action-icon">▤</div>
            <span style={{fontSize: '12px', fontWeight: 'bold'}}>Receive</span>
          </button>
        </div>

        <div className="mm-banner">
          <div>
            <div style={{fontWeight: 'bold'}}>Start using smart accounts</div>
            <div style={{fontSize: '12px', color: 'var(--muted)'}}>Same address, smarter features</div>
          </div>
          <button style={{background: 'none', border: 'none', color: 'white', cursor: 'pointer'}}>✕</button>
        </div>

        <div className="mm-tabs">
          <button className={`mm-tab ${tab === 'tokens' ? 'active' : ''}`} onClick={() => setTab('tokens')}>Tokens</button>
          <button className={`mm-tab ${tab === 'portfolio' ? 'active' : ''}`} onClick={() => setTab('portfolio')}>DeFi</button>
          <button className={`mm-tab ${tab === 'nfts' ? 'active' : ''}`} onClick={() => setTab('nfts')}>NFTs</button>
          <button className={`mm-tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>Activity</button>
        </div>

        <div className="mm-token-list">
          {tab === 'tokens' ? (
            <Tokens portfolio={portfolio} go={go} onChange={load} />
          ) : tab === 'nfts' ? (
            <Nfts portfolio={portfolio} go={go} onChange={load} />
          ) : tab === 'portfolio' ? (
            <AccountPortfolio portfolios={portfolios} selected={state.selected} go={go} />
          ) : tab === 'activity' ? (
            <Activity portfolio={portfolio} onChange={load} />
          ) : (
            <ApprovalsTab portfolio={portfolio} onChange={load} />
          )}
        </div>
      </div>
    </div>
  );
}

function Tokens({ portfolio, go, onChange }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const tokens = (portfolio?.tokens ?? []).filter(
    (token) =>
      !needle ||
      token.symbol?.toLowerCase().includes(needle) ||
      token.name?.toLowerCase().includes(needle) ||
      token.address.toLowerCase().includes(needle)
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {portfolio?.network?.name ?? 'Sepolia'} <span style={{fontSize: 10, color: 'var(--muted)'}}>▼</span>
        </div>
        <div style={{ display: 'flex', gap: 12, color: 'var(--muted)' }}>
          <span style={{cursor: 'pointer'}}>≡</span>
          <span style={{cursor: 'pointer'}}>⋮</span>
        </div>
      </div>

      <div className="mm-token-item">
        <div className="mm-token-info">
          <div style={{ position: 'relative' }}>
            <div className="mm-token-avatar">S</div>
            <div style={{ position: 'absolute', bottom: -2, right: -2, background: 'var(--surface)', fontSize: 8, padding: 2, borderRadius: '50%' }}>S</div>
          </div>
          <span style={{ fontWeight: 600 }}>{portfolio?.native?.symbol ?? 'SepoliaETH'}</span>
        </div>
        <div className="mm-token-values">
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {portfolio?.native?.fiat ? formatFiat(portfolio.native.fiat) : 'No conversion rate available'}
          </div>
          <div style={{ fontWeight: 600 }}>{trimAmount(portfolio?.native?.balance)} {portfolio?.native?.symbol ?? 'SepoliaETH'}</div>
        </div>
      </div>

      {tokens.map((token) => (
        <div className="mm-token-item" key={token.address}>
          <div className="mm-token-info">
            <div style={{ position: 'relative' }}>
              <div className="mm-token-avatar">{token.symbol?.charAt(0) ?? 'U'}</div>
              <div style={{ position: 'absolute', bottom: -2, right: -2, background: 'var(--surface)', fontSize: 8, padding: 2, borderRadius: '50%' }}>S</div>
            </div>
            <span style={{ fontWeight: 600 }}>{token.symbol}</span>
          </div>
          <div className="mm-token-values">
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {token.fiat ? formatFiat(token.fiat) : 'No conversion rate available'}
            </div>
            <div style={{ fontWeight: 600 }}>{token.error ? '--' : trimAmount(token.balance)} {token.symbol}</div>
          </div>
        </div>
      ))}

      {needle && tokens.length === 0 && <div className="empty">No saved token matches that search.</div>}

      {(portfolio?.hiddenTokens ?? []).length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Hidden tokens</h2>
          <div className="list">
            {portfolio.hiddenTokens.map((token) => (
              <div className="item static compact" key={token.address}>
                <div className="item-main">
                  <span className="item-title">{token.symbol}</span>
                  <span className="item-sub">{shorten(token.address)}</span>
                </div>
                <button
                  className="link accent"
                  onClick={async () => {
                    await call('UNHIDE_TOKEN', { address: token.address });
                    onChange();
                  }}
                >
                  unhide
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <button className="ghost" style={{ marginTop: 14 }} onClick={() => go('addToken')}>
        Add token
      </button>
    </div>
  );
}

function ApprovalsTab({ portfolio, onChange }) {
  const approvals = portfolio?.approvals ?? [];
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');

  const revoke = async (approval) => {
    setBusy(approval.id);
    try {
      await call('REVOKE_APPROVAL', { id: approval.id });
      await onChange();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy('');
    }
  };

  const needle = query.trim().toLowerCase();
  const filtered = approvals.filter(
    (app) => 
      !needle || 
      app.symbol?.toLowerCase().includes(needle) || 
      app.spender?.toLowerCase().includes(needle) ||
      app.name?.toLowerCase().includes(needle)
  );

  const unlimitedCount = approvals.filter(app => app.unlimited).length;

  return (
    <div className="list">
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="eyebrow">Allowance Dashboard</div>
        <div className="row2" style={{ marginTop: 8 }}>
          <div>
            <span className="mono" style={{ fontSize: 24, display: 'block' }}>{approvals.length}</span>
            <span className="small faint">Active Approvals</span>
          </div>
          <div>
            <span className="mono" style={{ fontSize: 24, display: 'block', color: unlimitedCount > 0 ? 'var(--red)' : 'var(--text)' }}>{unlimitedCount}</span>
            <span className="small faint">Unlimited Risk</span>
          </div>
        </div>
      </div>

      <label className="field" style={{ margin: '8px 0 6px' }}>
        <span>Search approvals</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Token symbol, name, or spender" />
      </label>

      <div className="list" style={{ marginTop: 8 }}>
        {!approvals.length ? (
          <div className="empty">No active token or NFT approvals found for this account.</div>
        ) : !filtered.length ? (
          <div className="empty">No approvals match that search.</div>
        ) : (
          filtered.map((approval) => (
            <div className="item static" key={approval.id} style={{ alignItems: 'flex-start' }}>
              <div className="item-main">
                <span className="item-title" style={{ color: approval.unlimited ? 'var(--red)' : 'inherit' }}>
                  {approvalTitle(approval)}
                </span>
                <span className="item-sub" style={{ marginTop: 4 }}>
                  {approval.standard} · spender {shorten(approval.spender, 6, 4)}
                </span>
              </div>
              <button className="link accent" disabled={busy === approval.id} onClick={() => revoke(approval)}>
                {busy === approval.id ? 'revoking' : 'revoke'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Nfts({ portfolio, go, onChange }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const nfts = (portfolio?.nfts ?? []).filter((nft) => {
    if (!needle) return true;
    return [nft.title, nft.name, nft.symbol, nft.address, nft.tokenId, nft.standard]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  return (
    <div className="list">
      <label className="field" style={{ margin: '8px 0 6px' }}>
        <span>Search NFTs</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, contract, token ID" />
      </label>

      {!portfolio?.nfts?.length ? (
        <div className="empty">No NFTs tracked yet. Add a contract and token ID to display it here.</div>
      ) : (
        <div className="nft-grid">
          {nfts.map((nft) => (
            <div className="nft-card" key={`${nft.address}:${nft.tokenId}`}>
              {nft.image ? (
                <img src={nft.image} alt="" />
              ) : (
                <div className="nft-placeholder">{nft.standard}</div>
              )}
              <div className="stack-sm">
                <div className="item-title">{nft.title || nft.name || `${nft.standard} #${nft.tokenId}`}</div>
                <div className="item-sub">
                  #{nft.tokenId} · {nft.balance == null ? '--' : `${nft.balance} owned`}
                </div>
                <div className="between">
                  <span className="badge">{nft.standard}</span>
                  <button
                    className="link"
                    onClick={async () => {
                      await call('HIDE_NFT', { nft });
                      onChange();
                    }}
                  >
                    hide
                  </button>
                </div>
              </div>
            </div>
          ))}
          {needle && !nfts.length && <div className="empty">No tracked NFT matches that search.</div>}
        </div>
      )}

      {(portfolio?.hiddenNfts ?? []).length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Hidden NFTs</h2>
          <div className="list">
            {portfolio.hiddenNfts.map((nft) => (
              <div className="item static compact" key={`${nft.address}:${nft.tokenId}`}>
                <div className="item-main">
                  <span className="item-title">{nft.title || nft.name || `${nft.standard} #${nft.tokenId}`}</span>
                  <span className="item-sub">
                    {shorten(nft.address)} · #{nft.tokenId}
                  </span>
                </div>
                <button
                  className="link accent"
                  onClick={async () => {
                    await call('UNHIDE_NFT', { nft });
                    onChange();
                  }}
                >
                  unhide
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <button className="ghost" style={{ marginTop: 14 }} onClick={() => go('addToken')}>
        Add NFT
      </button>
    </div>
  );
}

function AccountPortfolio({ portfolios, selected, go }) {
  const accounts = portfolios?.accounts ?? [];
  if (!accounts.length) return <div className="empty">No visible accounts to show.</div>;

  return (
    <div className="list">
      <div className="card" style={{ marginTop: 8 }}>
        <div className="eyebrow">All accounts (Multichain)</div>
        <div className="balance" style={{ fontSize: 24 }}>
          {formatFiat(portfolios?.totalFiat)}
        </div>
      </div>

      {accounts.map((account) => (
        <div className="item static" key={account.address}>
          <Avatar address={account.address} size="lg" src={account.ens?.avatar} />
          <div className="item-main">
            <span className="item-title">
              {account.name}
              {account.type === 'watch' ? ' · watch' : ''}
            </span>
            <span className="item-sub">
              {account.ens?.name ? `${account.ens.name} · ` : ''}
              {shorten(account.address, 8, 6)}
            </span>
            <span className="item-sub">
              {account.tokens.length} token{account.tokens.length === 1 ? '' : 's'} · {account.nfts.length} NFT
              {account.nfts.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
            {account.address === selected && <span className="badge confirmed">active</span>}
            <span className="mono small">
              {formatFiat(account.totalFiat)}
            </span>
          </div>
        </div>
      ))}

      <button className="ghost" style={{ marginTop: 14 }} onClick={() => go('accounts')}>
        Manage accounts
      </button>
    </div>
  );
}

function Activity({ portfolio, onChange }) {
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const activity = portfolio?.activity ?? [];
  const filtered = activity.filter((tx) => {
    if (status !== 'all' && tx.status !== status) return false;
    if (kind !== 'all' && txKind(tx) !== kind) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [tx.hash, tx.to, tx.from, tx.status, tx.networkName, label(tx), tx.decoded?.name, tx.note, ...(tx.tags ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  if (!activity.length) {
    return <div className="empty">Nothing here yet. Transactions you send from ADRIX show up on this list.</div>;
  }

  const act = async (type, hash) => {
    setBusy(hash);
    try {
      await call(type, { hash });
      onChange();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="list">
      <div className="card activity-tools">
        <label className="field">
          <span>Search activity</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Hash, address, status, network" />
        </label>
        <div className="row2">
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="failed">Failed</option>
              <option value="replaced">Replaced</option>
            </select>
          </label>
          <label className="field">
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">All</option>
              <option value="send">Send</option>
              <option value="token">Token</option>
              <option value="approval">Approval</option>
              <option value="contract">Contract</option>
              <option value="replacement">Replacement</option>
            </select>
          </label>
        </div>
        <div className="between small">
          <span>
            Showing {filtered.length} of {activity.length}
          </span>
          <button className="link accent" disabled={!filtered.length} onClick={() => exportActivityCsv(filtered)}>
            export csv
          </button>
        </div>
      </div>

      {filtered.map((tx) => (
        <ActivityRow key={tx.hash} tx={tx} busy={busy} act={act} onChange={onChange} />
      ))}
      {!filtered.length && <div className="empty">No transactions match those filters.</div>}
    </div>
  );
}

function ActivityRow({ tx, busy, act, onChange }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(tx.note ?? '');
  const [tags, setTags] = useState((tx.tags ?? []).join(', '));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await call('UPDATE_TX_META', { hash: tx.hash, note, tags });
      await onChange();
      setEditing(false);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="site-row">
      <div className="item static">
        <div className="item-main">
          <span className="item-title">
            {tx.kind === 'cancel' ? 'Cancel' : tx.kind === 'speedup' ? 'Speed up' : label(tx)}
          </span>
          <span className="item-sub">
            {tx.decoded?.name ? `${tx.decoded.name} · ` : ''}
            {tx.to ? shorten(tx.to) : 'contract deploy'} · {timeAgo(tx.submittedAt)}
          </span>
          {tx.note && <span className="small">{tx.note}</span>}
          {tx.tags?.length > 0 && (
            <span className="inline" style={{ marginTop: 4, flexWrap: 'wrap' }}>
              {tx.tags.map((tag) => (
                <span className="badge" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          )}
          <span className="inline" style={{ marginTop: 6 }}>
            {tx.status === 'pending' && (
              <>
                <button className="link accent" disabled={busy === tx.hash} onClick={() => act('SPEED_UP', tx.hash)}>
                  speed up
                </button>
                <button className="link" disabled={busy === tx.hash} onClick={() => act('CANCEL_TX', tx.hash)}>
                  cancel
                </button>
              </>
            )}
            <button className="link" onClick={() => setEditing(!editing)}>
              {editing ? 'close' : 'notes'}
            </button>
          </span>
        </div>
        <div className="item-right stack-sm" style={{ alignItems: 'flex-end' }}>
          <span className={`badge ${tx.status}`}>{tx.status}</span>
          {tx.explorer && (
            <a
              className="link"
              href={`${tx.explorer}/tx/${tx.hash}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--faint)' }}
            >
              view
            </a>
          )}
        </div>
      </div>
      {editing && (
        <div className="site-panel stack-sm">
          <label className="field">
            <span>Note</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this transaction matters" />
          </label>
          <label className="field">
            <span>Tags</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="swap, tax, client" />
          </label>
          <button className="primary" disabled={saving} onClick={save}>
            {saving ? 'Saving...' : 'Save notes'}
          </button>
        </div>
      )}
    </div>
  );
}

function txKind(tx) {
  if (tx.kind === 'cancel' || tx.kind === 'speedup' || tx.replaces) return 'replacement';
  if (tx.kind === 'approvalRevoke') return 'approval';
  if (tx.decoded?.approval || tx.decoded?.name === 'approve' || tx.decoded?.name === 'setApprovalForAll') {
    return 'approval';
  }
  if (tx.tokenSymbol) return 'token';
  if (tx.data && tx.data !== '0x') return 'contract';
  return 'send';
}

function label(tx) {
  if (tx.kind === 'approvalRevoke') return 'Revoked approval';
  if (tx.decoded?.label) return tx.decoded.label;
  if (tx.tokenSymbol) return `Sent ${tx.tokenAmount} ${tx.tokenSymbol}`;
  if (tx.data && tx.data !== '0x') return 'Contract interaction';
  return `Sent ${trimAmount(Number(tx.value) / 1e18)} ${tx.symbol ?? ''}`;
}

function approvalTitle(approval) {
  if (approval.standard === 'ERC20') {
    const amount = approval.unlimited ? 'Unlimited' : trimAmount(approval.displayAmount ?? approval.amount);
    return `${amount} ${approval.symbol || 'tokens'}`;
  }
  if (approval.tokenId) return `${approval.name || 'NFT'} #${approval.tokenId}`;
  return `${approval.name || 'NFT collection'} operator`;
}

function exportActivityCsv(rows) {
  const headers = [
    'submitted_at',
    'status',
    'type',
    'label',
    'hash',
    'from',
    'to',
    'value_wei',
    'token_symbol',
    'token_amount',
    'network',
    'chain_id',
    'nonce',
    'method',
    'note',
    'tags',
  ];
  const csv = [
    headers.join(','),
    ...rows.map((tx) =>
      [
        tx.submittedAt ? new Date(tx.submittedAt).toISOString() : '',
        tx.status,
        txKind(tx),
        label(tx),
        tx.hash,
        tx.from,
        tx.to,
        tx.value,
        tx.tokenSymbol,
        tx.tokenAmount,
        tx.networkName,
        tx.chainId,
        tx.nonce,
        tx.decoded?.name,
        tx.note,
        (tx.tags ?? []).join('|'),
      ]
        .map(csvCell)
        .join(',')
    ),
  ].join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `adrix-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
