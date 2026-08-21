// Search across everything the wallet knows locally.
//
// Each screen already has its own filter box, which works only if you already
// know where the thing is. This answers the other question — "I remember an
// address / a symbol / a name, where does it appear?" — across transactions,
// tokens, NFTs, contacts, accounts, connected sites, and the signature log.
//
// Deliberately local-only and cross-chain. Every source is already in storage,
// so a search costs no network calls, and transactions are searched across all
// networks: not knowing which chain something happened on is a large part of
// why someone is searching in the first place.

import { local } from './storage.js';
import { listAccounts } from './keyring.js';
import { getChainId, allNetworks } from './networks.js';

const MAX_PER_GROUP = 8;

const text = (value) => String(value ?? '').toLowerCase();

/**
 * Scores a match so exact hits outrank incidental substrings.
 *
 * Without this, searching for a token symbol returns every transaction whose
 * hash happens to contain those characters before the token itself.
 */
function scoreMatch(needle, fields) {
  let best = 0;
  for (const { value, weight = 1 } of fields) {
    const haystack = text(value);
    if (!haystack) continue;
    if (haystack === needle) best = Math.max(best, 100 * weight);
    else if (haystack.startsWith(needle)) best = Math.max(best, 60 * weight);
    else if (haystack.includes(needle)) best = Math.max(best, 30 * weight);
  }
  return best;
}

function take(rows) {
  return rows
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MAX_PER_GROUP);
}

export async function globalSearch(query, { address } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle.length < 2) return { query: needle, groups: [], total: 0, tooShort: true };

  const [activity, tokenStore, nftStore, contacts, accounts, permissions, signatureLog, networks, currentChain] =
    await Promise.all([
      local.get('activity', []),
      local.get('tokens', {}),
      local.get('nfts', {}),
      local.get('contacts', []),
      listAccounts(),
      local.get('permissions', {}),
      local.get('signatureLog', []),
      allNetworks(),
      getChainId(),
    ]);

  const nameOf = (chainId) => networks[chainId]?.name ?? chainId;

  // --- transactions, across every chain -------------------------------------
  const mine = address ? activity.filter((tx) => tx.from?.toLowerCase() === address.toLowerCase()) : activity;
  const transactions = take(
    mine.map((tx) => ({
      kind: 'transaction',
      id: tx.hash,
      title: tx.tokenSymbol ? `${tx.tokenAmount} ${tx.tokenSymbol}` : (tx.decoded?.label ?? 'Transfer'),
      subtitle: `${tx.status} · ${nameOf(tx.chainId)}`,
      hash: tx.hash,
      chainId: tx.chainId,
      // Off-chain rows carry the chain badge because the result list mixes
      // networks, which the per-screen activity list never does.
      networkName: nameOf(tx.chainId),
      offChain: tx.chainId !== currentChain,
      at: tx.submittedAt,
      score: scoreMatch(needle, [
        { value: tx.hash, weight: 1.2 },
        { value: tx.to, weight: 1.1 },
        { value: tx.tokenSymbol, weight: 1.3 },
        { value: tx.note, weight: 1.2 },
        { value: (tx.tags ?? []).join(' '), weight: 1.2 },
        { value: tx.decoded?.label },
        { value: tx.decoded?.name },
        { value: tx.networkName },
      ]),
    }))
  );

  // --- tokens, across every chain -------------------------------------------
  const tokenRows = [];
  for (const [chainId, byAddress] of Object.entries(tokenStore)) {
    for (const token of Object.values(byAddress ?? {})) {
      tokenRows.push({
        kind: 'token',
        id: `${chainId}:${token.address}`,
        title: token.symbol,
        subtitle: `${token.name || 'Token'} · ${nameOf(chainId)}${token.hidden ? ' · hidden' : ''}`,
        address: token.address,
        chainId,
        offChain: chainId !== currentChain,
        score: scoreMatch(needle, [
          { value: token.symbol, weight: 1.4 },
          { value: token.name, weight: 1.1 },
          { value: token.address, weight: 1.2 },
        ]),
      });
    }
  }

  // --- NFTs ------------------------------------------------------------------
  const nftRows = [];
  for (const [chainId, byKey] of Object.entries(nftStore)) {
    for (const nft of Object.values(byKey ?? {})) {
      nftRows.push({
        kind: 'nft',
        id: `${chainId}:${nft.address}:${nft.tokenId}`,
        title: nft.title || nft.name || `${nft.standard} #${nft.tokenId}`,
        subtitle: `${nft.standard} · #${nft.tokenId} · ${nameOf(chainId)}`,
        address: nft.address,
        tokenId: nft.tokenId,
        chainId,
        offChain: chainId !== currentChain,
        score: scoreMatch(needle, [
          { value: nft.title, weight: 1.3 },
          { value: nft.name, weight: 1.2 },
          { value: nft.symbol },
          { value: nft.address, weight: 1.1 },
          { value: nft.tokenId },
        ]),
      });
    }
  }

  // --- contacts, accounts, sites, signatures --------------------------------
  const contactRows = contacts.map((contact) => ({
    kind: 'contact',
    id: contact.id,
    title: contact.name,
    subtitle: contact.ens ?? contact.address,
    address: contact.address,
    score: scoreMatch(needle, [
      { value: contact.name, weight: 1.4 },
      { value: contact.ens, weight: 1.3 },
      { value: contact.address, weight: 1.2 },
      { value: contact.label },
    ]),
  }));

  const accountRows = accounts.map((account) => ({
    kind: 'account',
    id: account.address,
    title: account.name,
    subtitle: `${account.type}${account.hidden ? ' · hidden' : ''} · ${account.address}`,
    address: account.address,
    score: scoreMatch(needle, [
      { value: account.name, weight: 1.4 },
      { value: account.address, weight: 1.2 },
      { value: account.ens?.name, weight: 1.3 },
    ]),
  }));

  const siteRows = Object.entries(permissions).map(([origin, grant]) => ({
    kind: 'site',
    id: origin,
    title: origin.replace(/^https?:\/\//, ''),
    subtitle: `${grant.accounts?.length ?? 0} account(s) · ${grant.networks?.length ?? 0} network(s)`,
    origin,
    at: grant.lastActiveAt,
    score: scoreMatch(needle, [{ value: origin, weight: 1.3 }, { value: (grant.accounts ?? []).join(' ') }]),
  }));

  const signatureRows = signatureLog.map((row) => ({
    kind: 'signature',
    id: row.id,
    title: row.risk?.kind === 'permit' ? 'Permit signature' : (row.primaryType ?? 'Signed message'),
    subtitle: `${row.origin?.replace(/^https?:\/\//, '')} · ${row.type}`,
    origin: row.origin,
    at: row.at,
    score: scoreMatch(needle, [
      { value: row.origin, weight: 1.2 },
      { value: row.primaryType, weight: 1.2 },
      { value: row.domainName },
      { value: row.risk?.spender, weight: 1.1 },
      { value: row.message },
    ]),
  }));

  const groups = [
    { key: 'transactions', label: 'Transactions', items: transactions },
    { key: 'tokens', label: 'Tokens', items: take(tokenRows) },
    { key: 'nfts', label: 'NFTs', items: take(nftRows) },
    { key: 'contacts', label: 'Contacts', items: take(contactRows) },
    { key: 'accounts', label: 'Accounts', items: take(accountRows) },
    { key: 'sites', label: 'Connected sites', items: take(siteRows) },
    { key: 'signatures', label: 'Signatures', items: take(signatureRows) },
  ].filter((group) => group.items.length);

  return {
    query: needle,
    groups,
    total: groups.reduce((sum, group) => sum + group.items.length, 0),
    // Whether anything matched outside the chain the wallet is currently on —
    // the case where a user is convinced something is missing.
    otherChains: groups.some((group) => group.items.some((item) => item.offChain)),
  };
}
