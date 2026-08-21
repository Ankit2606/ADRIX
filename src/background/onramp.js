// Fiat on-ramp: handing off to a provider, correctly.
//
// ADRIX cannot sell anyone cryptocurrency. What it can do is the part that
// actually goes wrong — getting the right address, on the right chain, into the
// right provider, without the user copying it by hand into a browser tab.
// Address entry is the step where on-ramp money is genuinely lost, and it is
// the one step a wallet is uniquely placed to get right.
//
// So this builds a pre-filled deep link and is explicit about what happens
// next: the purchase, the KYC, the payment, and any dispute are between the
// user and the provider. ADRIX is not a party to it, takes no fee, and cannot
// reverse anything.
//
// No API keys are shipped. Providers that require an integrator key still work
// as a plain hand-off; the user can add their own key per provider if they have
// one, which some issue free.

import { local } from './storage.js';

const read = () => local.get('onrampKeys', {});

/**
 * Provider registry.
 *
 * `build` returns the URL to open. Each provider names its own parameters, and
 * getting them wrong silently drops the prefill rather than erroring — hence a
 * per-provider builder rather than one generic template.
 */
export const PROVIDERS = [
  {
    id: 'ramp',
    name: 'Ramp Network',
    hint: 'Cards, bank transfer, Apple Pay. Works without an integrator key.',
    needsKey: false,
    // Ramp asset codes are CHAIN_SYMBOL.
    assetPrefix: { '0x1': 'ETH', '0x89': 'MATIC', '0xa4b1': 'ARBITRUM', '0xa': 'OPTIMISM', '0x2105': 'BASE', '0x38': 'BSC' },
    build({ address, chainId, symbol, fiatAmount, fiatCurrency, apiKey }) {
      const params = new URLSearchParams({ userAddress: address });
      const prefix = this.assetPrefix[chainId];
      if (prefix && symbol) params.set('swapAsset', `${prefix}_${symbol.toUpperCase()}`);
      if (fiatAmount) params.set('fiatValue', String(fiatAmount));
      if (fiatCurrency) params.set('fiatCurrency', fiatCurrency.toUpperCase());
      if (apiKey) params.set('hostApiKey', apiKey);
      return `https://app.ramp.network/?${params}`;
    },
  },
  {
    id: 'moonpay',
    name: 'MoonPay',
    hint: 'Cards and Apple Pay in most countries. Needs an integrator key to skip its landing page.',
    needsKey: true,
    codes: { '0x1': 'eth', '0x89': 'matic_polygon', '0xa4b1': 'eth_arbitrum', '0xa': 'eth_optimism', '0x2105': 'eth_base', '0x38': 'bnb_bsc' },
    build({ address, chainId, fiatAmount, fiatCurrency, apiKey }) {
      const params = new URLSearchParams({ walletAddress: address });
      const code = this.codes[chainId];
      if (code) params.set('currencyCode', code);
      if (fiatAmount) params.set('baseCurrencyAmount', String(fiatAmount));
      if (fiatCurrency) params.set('baseCurrencyCode', fiatCurrency.toLowerCase());
      if (apiKey) params.set('apiKey', apiKey);
      return `https://buy.moonpay.com/?${params}`;
    },
  },
  {
    id: 'coinbase',
    name: 'Coinbase',
    hint: 'Good rates if you already hold a Coinbase account.',
    needsKey: false,
    networks: { '0x1': 'ethereum', '0x89': 'polygon', '0xa4b1': 'arbitrum', '0xa': 'optimism', '0x2105': 'base' },
    build({ address, chainId, symbol }) {
      const network = this.networks[chainId];
      const params = new URLSearchParams();
      // Coinbase takes the destination as a JSON blob of address -> networks.
      if (network) params.set('addresses', JSON.stringify({ [address]: [network] }));
      if (symbol) params.set('assets', JSON.stringify([symbol.toUpperCase()]));
      return `https://pay.coinbase.com/buy/select-asset?${params}`;
    },
  },
  {
    id: 'transak',
    name: 'Transak',
    hint: 'Wide country coverage including bank transfer. Needs an integrator key.',
    needsKey: true,
    networks: { '0x1': 'ethereum', '0x89': 'polygon', '0xa4b1': 'arbitrum', '0xa': 'optimism', '0x2105': 'base', '0x38': 'bsc' },
    build({ address, chainId, symbol, fiatAmount, fiatCurrency, apiKey }) {
      const params = new URLSearchParams({ walletAddress: address });
      const network = this.networks[chainId];
      if (network) params.set('network', network);
      if (symbol) params.set('cryptoCurrencyCode', symbol.toUpperCase());
      if (fiatAmount) params.set('fiatAmount', String(fiatAmount));
      if (fiatCurrency) params.set('fiatCurrency', fiatCurrency.toUpperCase());
      if (apiKey) params.set('apiKey', apiKey);
      return `https://global.transak.com/?${params}`;
    },
  },
];

/** Providers that can actually deliver to the given chain, with their status. */
export async function listProviders(chainId) {
  const keys = await read();

  return PROVIDERS.map((provider) => {
    const supported =
      !provider.networks && !provider.codes && !provider.assetPrefix
        ? true
        : Boolean(provider.networks?.[chainId] ?? provider.codes?.[chainId] ?? provider.assetPrefix?.[chainId]);

    return {
      id: provider.id,
      name: provider.name,
      hint: provider.hint,
      needsKey: Boolean(provider.needsKey),
      hasKey: Boolean(keys[provider.id]),
      supported,
    };
  });
}

export async function setProviderKey(id, apiKey) {
  if (!PROVIDERS.some((provider) => provider.id === id)) throw new Error('Unknown provider.');
  const keys = await read();
  const clean = String(apiKey ?? '').trim().slice(0, 200);
  if (clean) keys[id] = clean;
  else delete keys[id];
  await local.set({ onrampKeys: keys });
  return { id, hasKey: Boolean(clean) };
}

/**
 * Builds the hand-off URL.
 *
 * The address is re-checked against the wallet's own account list before it is
 * put in a URL. A wallet that pre-fills the wrong address is worse than one
 * that makes you paste it yourself, because it looks authoritative.
 */
export async function buildOnrampUrl({ providerId, address, chainId, symbol, fiatAmount, fiatCurrency, ownedAddresses = [] }) {
  const provider = PROVIDERS.find((entry) => entry.id === providerId);
  if (!provider) throw new Error('Unknown provider.');
  if (!address) throw new Error('No account selected.');

  if (ownedAddresses.length && !ownedAddresses.some((owned) => owned.toLowerCase() === address.toLowerCase())) {
    throw new Error('That address is not one of this wallet\'s accounts. ADRIX will not pre-fill it.');
  }

  const keys = await read();
  const url = provider.build({
    address,
    chainId,
    symbol,
    fiatAmount,
    fiatCurrency,
    apiKey: keys[provider.id],
  });

  return {
    url,
    provider: provider.name,
    // Whether the user will land on a ready-to-pay screen or on the provider's
    // generic entry page. Worth saying, so a landing page is not read as a bug.
    prefilled: !provider.needsKey || Boolean(keys[provider.id]),
    needsKey: Boolean(provider.needsKey) && !keys[provider.id],
  };
}

/**
 * Records that a hand-off happened.
 *
 * There is no callback from any of these providers, so ADRIX cannot know
 * whether a purchase completed. What it can do is remember that the user went
 * to buy, so an arriving balance is not a mystery — and so the record exists if
 * something needs chasing with the provider later.
 */
export async function recordHandoff({ providerId, address, chainId, symbol, fiatAmount, fiatCurrency }) {
  const log = await local.get('onrampLog', []);
  const entry = {
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    at: Date.now(),
    providerId,
    provider: PROVIDERS.find((p) => p.id === providerId)?.name ?? providerId,
    address,
    chainId,
    symbol,
    fiatAmount: fiatAmount ?? null,
    fiatCurrency: fiatCurrency ?? null,
  };
  await local.set({ onrampLog: [entry, ...log].slice(0, 50) });
  return entry;
}

export async function listHandoffs() {
  return local.get('onrampLog', []);
}

export async function clearHandoffs() {
  await local.set({ onrampLog: [] });
  return { ok: true };
}
