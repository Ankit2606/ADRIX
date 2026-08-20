import { getAddress } from 'ethers';
import { getProvider } from './networks.js';
import { local } from './storage.js';

// ENS lives on mainnet, so every lookup here targets 0x1 regardless of the
// chain the wallet is currently on.
const ENS_CHAIN = '0x1';

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;
const LOOKUP_TIMEOUT = 3500;

// Concurrent lookups for the same address share one request. Without this,
// enriching eight accounts at once fires eight identical round trips.
const inFlight = new Map();

export function getAvatarsEnabled() {
  return local.get('ensAvatars', true);
}

export async function setAvatarsEnabled(value) {
  await local.set({ ensAvatars: Boolean(value) });
  cache.clear();
  return Boolean(value);
}

export async function profileAddress(address) {
  const checksum = getAddress(address);
  const key = checksum.toLowerCase();

  const cached = cache.get(key);
  if (cached) {
    // A miss is re-checked sooner than a hit: names get registered, and a user
    // who just set one should not wait ten minutes to see it.
    const ttl = cached.profile.name ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - cached.checkedAt < ttl) return cached.profile;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = readProfile(checksum)
    .then((profile) => {
      cache.set(key, { checkedAt: Date.now(), profile });
      return profile;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

export async function enrichAccounts(accounts = []) {
  return Promise.all(
    accounts.map(async (account) => ({
      ...account,
      ens: await profileAddress(account.address).catch(() => null),
    }))
  );
}

/**
 * Reverse lookup, then avatar.
 *
 * A reverse record is set by whoever controls the address, so on its own it
 * proves nothing — anyone can point theirs at "vitalik.eth". What makes it
 * trustworthy is the forward check: resolving the returned name must give back
 * the same address. ethers' lookupAddress performs that check (explicitly on
 * the legacy path, and via the UniversalResolver's ENSIP-19 reverse() on the
 * modern one) and returns null when it fails, so a name reaching this code has
 * already round-tripped.
 */
async function readProfile(address) {
  const empty = { address, name: '', avatar: '', verified: false };

  try {
    const provider = await getProvider(ENS_CHAIN);
    const name = await withTimeout(provider.lookupAddress(address), LOOKUP_TIMEOUT, 'ENS lookup timed out.');
    if (!name) return empty;

    const profile = { address, name, avatar: '', verified: true };

    // Avatar records are arbitrary URLs chosen by the name's owner. Fetching one
    // tells that host the user's IP and that their wallet is open, so it is
    // behind a setting and restricted to https.
    if (await getAvatarsEnabled()) {
      const avatar = await withTimeout(
        provider.getAvatar(name).catch(() => ''),
        LOOKUP_TIMEOUT,
        'ENS avatar lookup timed out.'
      ).catch(() => '');

      if (typeof avatar === 'string' && avatar.startsWith('https://')) {
        profile.avatar = avatar;
      } else if (avatar) {
        // http:// or a data/ipfs form ethers did not normalise — recorded for
        // display as text, never loaded.
        profile.avatarBlocked = true;
      }
    }

    return profile;
  } catch {
    return empty;
  }
}

/** Forward resolution with the reverse record checked back, for display. */
export async function resolveName(name) {
  try {
    const provider = await getProvider(ENS_CHAIN);
    const address = await withTimeout(provider.resolveName(name), LOOKUP_TIMEOUT, 'ENS lookup timed out.');
    if (!address) return null;

    const reverse = await withTimeout(provider.lookupAddress(address), LOOKUP_TIMEOUT, 'timed out').catch(() => null);
    return {
      name,
      address: getAddress(address),
      // A name resolving to an address that does not name it back is legitimate
      // and common — it just means no primary name is set. Worth showing, not
      // worth blocking.
      primary: reverse?.toLowerCase() === name.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function clearEnsCache() {
  cache.clear();
  inFlight.clear();
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
