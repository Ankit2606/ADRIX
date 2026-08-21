// Uniswap-style token lists (https://tokenlists.org).
//
// A token list is third-party JSON that decides what the user sees when they
// search for a token — which makes importing one a trust decision, not a
// convenience. A hostile list needs only one entry claiming to be USDC at an
// address it controls. So: everything here is validated field by field, only
// known fields are kept, and impersonation is checked and surfaced rather than
// assumed away. Nothing is auto-imported and nothing is auto-added to a wallet.

import { isAddress, getAddress } from 'ethers';
import { local } from './storage.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
// A full CoinGecko list runs to several thousand entries across every chain.
// Storing all of them would push chrome.storage.local toward its quota for very
// little benefit, so the tail is dropped and the truncation is reported.
const MAX_TOKENS_PER_LIST = 3000;
const MAX_LISTS = 8;

/** Lists that are widely used and served from a stable URL. Still opt-in. */
export const CURATED_LISTS = [
  {
    name: 'Uniswap Default',
    url: 'https://tokens.uniswap.org',
    hint: 'Conservative, multi-chain. The default most DEX front-ends ship.',
  },
  {
    name: 'CoinGecko',
    url: 'https://tokens.coingecko.com/uniswap/all.json',
    hint: 'Very large. Broad coverage, looser inclusion criteria.',
  },
  {
    name: 'Superchain (OP Stack)',
    url: 'https://static.optimism.io/optimism.tokenlist.json',
    hint: 'Canonical bridged tokens for OP Mainnet and Base.',
  },
  {
    name: 'Arbitrum Bridged',
    url: 'https://bridge.arbitrum.io/token-list-42161.json',
    hint: 'Tokens bridged to Arbitrum One.',
  },
];

const read = () => local.get('tokenLists', {});

const clampText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url ?? '';
  }
}

function normaliseListUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Enter a token list URL.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  // Plain HTTP means anything on the path can rewrite the list — that is, can
  // choose which contract address the user's "USDC" points at.
  if (url.protocol !== 'https:') {
    throw new Error('Token list URLs must use https. An unencrypted list can be rewritten in transit.');
  }
  return url.toString();
}

/** Only https and ipfs logos, resolved to a gateway. Anything else is dropped. */
function normaliseLogo(uri) {
  const value = clampText(uri, 300);
  if (!value) return '';
  if (value.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${value.slice('ipfs://'.length)}`;
  if (value.startsWith('https://')) return value;
  return '';
}

/**
 * Validates one entry. Throws with a reason rather than returning null, so the
 * caller can report *why* rows were dropped instead of silently losing them.
 */
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('not an object');

  const chainId = Number(entry.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('bad chainId');

  // Multi-chain lists carry non-EVM entries too — the Uniswap default list
  // includes Solana tokens with base58 addresses. Those are not malformed, they
  // are simply not for this wallet, and the two need reporting differently.
  const rawAddress = typeof entry.address === 'string' ? entry.address.trim() : '';
  if (!/^0x/i.test(rawAddress)) throw Object.assign(new Error('non-EVM address'), { nonEvm: true });
  if (!isAddress(rawAddress)) throw new Error('bad address');
  const address = getAddress(rawAddress);

  const decimals = Number(entry.decimals);
  // Above 36 the amount maths in parseUnits stops being meaningful, and a
  // wrong decimals value silently misprices every balance and every send.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('bad decimals');

  const symbol = clampText(entry.symbol, 24);
  if (!symbol) throw new Error('missing symbol');

  return {
    chainId: `0x${chainId.toString(16)}`,
    address,
    symbol,
    name: clampText(entry.name, 60) || symbol,
    decimals,
    logoURI: normaliseLogo(entry.logoURI),
  };
}

/**
 * Parses and validates a token list document. Only the fields ADRIX uses are
 * kept; the rest of the document is discarded rather than stored and later
 * rendered.
 */
export function parseTokenList(raw, sourceUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('That is not a token list document.');
  }
  if (!Array.isArray(raw.tokens)) {
    throw new Error('That document has no "tokens" array, so it is not a token list.');
  }

  const version = raw.version
    ? [raw.version.major, raw.version.minor, raw.version.patch].map((part) => Number(part) || 0).join('.')
    : null;

  const byChain = {};
  const seen = new Set();
  let kept = 0;
  let rejected = 0;
  let nonEvm = 0;
  let duplicates = 0;
  let truncated = false;

  for (const entry of raw.tokens) {
    if (kept >= MAX_TOKENS_PER_LIST) {
      truncated = true;
      break;
    }
    let token;
    try {
      token = validateEntry(entry);
    } catch (err) {
      if (err.nonEvm) nonEvm += 1;
      else rejected += 1;
      continue;
    }

    // A list carrying the same contract twice on one chain is malformed; the
    // second entry could differ in decimals, which is how a display bug becomes
    // a lost-funds bug.
    const key = `${token.chainId}:${token.address.toLowerCase()}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    (byChain[token.chainId] ??= []).push(token);
    kept += 1;
  }

  if (!kept) throw new Error('That list contains no usable tokens.');

  return {
    url: sourceUrl,
    name: clampText(raw.name, 60) || hostOf(sourceUrl),
    version,
    logoURI: normaliseLogo(raw.logoURI),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.slice(0, 8).map((word) => clampText(word, 24)) : [],
    tokens: byChain,
    tokenCount: kept,
    chainCount: Object.keys(byChain).length,
    rejected,
    nonEvm,
    duplicates,
    truncated,
    fetchedAt: Date.now(),
  };
}

/** Downloads and validates a list without saving it, so it can be previewed first. */
export async function fetchTokenList(url) {
  const clean = normaliseListUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let text;
  try {
    const response = await fetch(clean, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`The server returned ${response.status}.`);

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_LIST_BYTES) {
      throw new Error(`That list is ${Math.round(declared / 1e6)}MB, which is larger than ADRIX will load.`);
    }
    text = await response.text();
    // content-length is advisory and often absent, so the real body is checked too.
    if (text.length > MAX_LIST_BYTES) throw new Error('That list is larger than ADRIX will load.');
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('That list took too long to download.');
    throw new Error(`Could not fetch that list: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('That URL did not return valid JSON.');
  }

  return parseTokenList(json, clean);
}

export async function listTokenLists() {
  const lists = await read();
  return Object.values(lists)
    .map((list) => ({
      url: list.url,
      name: list.name,
      version: list.version,
      logoURI: list.logoURI,
      tokenCount: list.tokenCount,
      chainCount: list.chainCount,
      truncated: list.truncated,
      fetchedAt: list.fetchedAt,
      enabled: list.enabled !== false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveTokenList(url) {
  const lists = await read();
  const parsed = await fetchTokenList(url);

  if (!lists[parsed.url] && Object.keys(lists).length >= MAX_LISTS) {
    throw new Error(`ADRIX holds at most ${MAX_LISTS} token lists. Remove one first.`);
  }

  lists[parsed.url] = { ...parsed, enabled: true };
  await local.set({ tokenLists: lists });
  return parsed;
}

export async function refreshTokenList(url) {
  const lists = await read();
  const existing = lists[url];
  if (!existing) throw new Error('That list is not imported.');

  const parsed = await fetchTokenList(url);
  lists[url] = { ...parsed, enabled: existing.enabled !== false };
  await local.set({ tokenLists: lists });

  // What actually changed matters: a list that quietly moves a token to a new
  // address is the thing worth noticing on a refresh.
  return { ...parsed, previousCount: existing.tokenCount, previousVersion: existing.version };
}

export async function setTokenListEnabled(url, enabled) {
  const lists = await read();
  if (!lists[url]) throw new Error('That list is not imported.');
  lists[url] = { ...lists[url], enabled: Boolean(enabled) };
  await local.set({ tokenLists: lists });
  return { url, enabled: Boolean(enabled) };
}

export async function removeTokenList(url) {
  const lists = await read();
  if (!lists[url]) throw new Error('That list is not imported.');
  delete lists[url];
  await local.set({ tokenLists: lists });
  return { ok: true };
}

/**
 * Every token an enabled list offers for one chain, tagged with where it came
 * from. Where two lists carry the same contract, the sources are merged onto
 * one row — agreement between independent lists is itself a signal.
 */
export async function listTokensForChain(chainId) {
  const lists = await read();
  const merged = new Map();

  for (const list of Object.values(lists)) {
    if (list.enabled === false) continue;
    for (const token of list.tokens?.[chainId] ?? []) {
      const key = token.address.toLowerCase();
      const existing = merged.get(key);
      if (existing) {
        if (!existing.sources.includes(list.name)) existing.sources.push(list.name);
        continue;
      }
      merged.set(key, { ...token, sources: [list.name] });
    }
  }

  return [...merged.values()];
}

/**
 * Contracts that share a symbol with a different contract on the same chain.
 *
 * Two lists disagreeing about which address is "USDC" is exactly the situation
 * a fake entry creates, and the user cannot see it from a search result alone.
 */
export async function findSymbolCollisions(chainId) {
  const tokens = await listTokensForChain(chainId);
  const bySymbol = new Map();
  for (const token of tokens) {
    const key = token.symbol.toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(token);
  }
  const collisions = new Set();
  for (const [, group] of bySymbol) {
    if (group.length > 1) for (const token of group) collisions.add(token.address.toLowerCase());
  }
  return collisions;
}
