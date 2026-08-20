// Live price data from CoinGecko's public API.
//
// Two lookups are needed. Native coins have a CoinGecko *coin id* keyed off the
// chain; ERC-20s are priced by contract address against a CoinGecko *platform
// id*. Everything is cached per (currency, chain) for CACHE_TTL, because the
// free tier rate-limits hard and the popup re-reads the portfolio every 15s.

import { local } from './storage.js';

const API = 'https://api.coingecko.com/api/v3';
const CACHE_TTL = 3 * 60 * 1000;
const REQUEST_TIMEOUT = 8000;

// Fiat currencies CoinGecko quotes directly. Anything here can be offered in
// the settings picker without extra conversion.
export const FIAT_CURRENCIES = [
  { code: 'usd', label: 'US Dollar', symbol: '$' },
  { code: 'eur', label: 'Euro', symbol: '€' },
  { code: 'inr', label: 'Indian Rupee', symbol: '₹' },
  { code: 'gbp', label: 'British Pound', symbol: '£' },
  { code: 'jpy', label: 'Japanese Yen', symbol: '¥' },
  { code: 'aud', label: 'Australian Dollar', symbol: 'A$' },
  { code: 'cad', label: 'Canadian Dollar', symbol: 'C$' },
  { code: 'chf', label: 'Swiss Franc', symbol: 'CHF ' },
  { code: 'cny', label: 'Chinese Yuan', symbol: '¥' },
  { code: 'krw', label: 'South Korean Won', symbol: '₩' },
  { code: 'brl', label: 'Brazilian Real', symbol: 'R$' },
  { code: 'zar', label: 'South African Rand', symbol: 'R' },
];

export const DEFAULT_CURRENCY = 'usd';

export function currencyMeta(code) {
  return FIAT_CURRENCIES.find((c) => c.code === code) ?? FIAT_CURRENCIES[0];
}

export function getCurrency() {
  return local.get('fiatCurrency', DEFAULT_CURRENCY);
}

export async function setCurrency(code) {
  if (!FIAT_CURRENCIES.some((c) => c.code === code)) throw new Error('Unsupported currency.');
  await local.set({ fiatCurrency: code });
  nativeCache.clear();
  tokenCache.clear();
  return code;
}

// chainId -> CoinGecko coin id for that chain's native currency
const NATIVE_IDS = {
  '0x1': 'ethereum',
  '0xaa36a7': null, // Sepolia ETH is not a traded asset
  '0x89': 'matic-network',
  '0xa4b1': 'ethereum',
  '0xa': 'ethereum',
  '0x2105': 'ethereum',
  '0x38': 'binancecoin',
  '0x7a69': null, // local dev chain
};

// chainId -> CoinGecko platform id for contract-address token lookups
const PLATFORM_IDS = {
  '0x1': 'ethereum',
  '0x89': 'polygon-pos',
  '0xa4b1': 'arbitrum-one',
  '0xa': 'optimistic-ethereum',
  '0x2105': 'base',
  '0x38': 'binance-smart-chain',
};

const nativeCache = new Map(); // `${currency}` -> { at, prices: {coinId: number} }
const tokenCache = new Map(); // `${chainId}:${currency}` -> { at, prices: {address: number} }

// The free tier allows only a handful of calls per minute, and the all-accounts
// view asks about every chain at once. Two guards keep that inside the budget:
// identical in-flight requests are shared rather than duplicated, and a 429
// parks every caller until the backoff expires instead of retrying into it.
const inFlight = new Map();
let backoffUntil = 0;

async function getJson(url) {
  if (Date.now() < backoffUntil) throw new Error('Rate limited; using cached prices.');

  const existing = inFlight.get(url);
  if (existing) return existing;

  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (response.status === 429) {
        backoffUntil = Date.now() + 60_000;
        throw new Error('CoinGecko rate limit reached.');
      }
      if (!response.ok) throw new Error(`CoinGecko returned ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, request);
  return request;
}

/** Whether the last request was rate-limited, so the UI can say prices are stale. */
export function isRateLimited() {
  return Date.now() < backoffUntil;
}

/**
 * Price of a chain's native coin in the user's currency, or null when the chain
 * has no traded native asset (testnets, local nodes) or the API is unreachable.
 */
export async function nativePrice(chainId, currency) {
  const vs = currency ?? (await getCurrency());
  const coinId = NATIVE_IDS[chainId];
  if (!coinId) return null;

  const key = vs;
  const cached = nativeCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.prices[coinId] ?? null;

  try {
    const ids = [...new Set(Object.values(NATIVE_IDS).filter(Boolean))].join(',');
    const json = await getJson(`${API}/simple/price?ids=${ids}&vs_currencies=${vs}`);
    const prices = {};
    for (const [id, quote] of Object.entries(json)) {
      if (typeof quote?.[vs] === 'number') prices[id] = quote[vs];
    }
    nativeCache.set(key, { at: Date.now(), prices });
    return prices[coinId] ?? null;
  } catch {
    // Serve a stale value rather than blanking the portfolio on a hiccup.
    return cached?.prices[coinId] ?? null;
  }
}

/**
 * Prices for a set of ERC-20 contract addresses on one chain, as a lowercased
 * address -> number map. Addresses CoinGecko does not know are simply absent.
 */
export async function tokenPrices(chainId, addresses = [], currency) {
  const vs = currency ?? (await getCurrency());
  const platform = PLATFORM_IDS[chainId];
  if (!platform || !addresses.length) return {};

  const key = `${chainId}:${vs}`;
  const cached = tokenCache.get(key);
  const wanted = addresses.map((a) => a.toLowerCase());

  if (cached && Date.now() - cached.at < CACHE_TTL) {
    const covered = wanted.every((address) => address in cached.prices);
    if (covered) return cached.prices;
  }

  try {
    // CoinGecko caps the contract list per request; 100 is comfortably inside it.
    const batch = wanted.slice(0, 100).join(',');
    const json = await getJson(
      `${API}/simple/token_price/${platform}?contract_addresses=${batch}&vs_currencies=${vs}`
    );
    // Record every requested address, including misses, so the "covered" check
    // above does not re-request unknown tokens on every refresh.
    const prices = Object.fromEntries(wanted.map((address) => [address, null]));
    for (const [address, quote] of Object.entries(json)) {
      if (typeof quote?.[vs] === 'number') prices[address.toLowerCase()] = quote[vs];
    }
    tokenCache.set(key, { at: Date.now(), prices });
    return prices;
  } catch {
    return cached?.prices ?? {};
  }
}

/** Multiplies a formatted token amount by its unit price. */
export function fiatValue(amount, price) {
  if (price == null) return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  return parsed * price;
}

export function clearPriceCache() {
  nativeCache.clear();
  tokenCache.clear();
}
