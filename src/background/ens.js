import { getAddress } from 'ethers';
import { getProvider } from './networks.js';

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function profileAddress(address) {
  const checksum = getAddress(address);
  const cached = cache.get(checksum.toLowerCase());
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached.profile;

  const profile = await readProfile(checksum);
  cache.set(checksum.toLowerCase(), { checkedAt: Date.now(), profile });
  return profile;
}

export async function enrichAccounts(accounts = []) {
  return Promise.all(
    accounts.map(async (account) => ({
      ...account,
      ens: await profileAddress(account.address).catch(() => null),
    }))
  );
}

async function readProfile(address) {
  try {
    const provider = await getProvider('0x1');
    const name = await withTimeout(provider.lookupAddress(address), 3500, 'ENS lookup timed out.');
    if (!name) return { address, name: '', avatar: '' };
    const avatar = await withTimeout(provider.getAvatar(name).catch(() => ''), 3500, 'ENS avatar lookup timed out.');
    return { address, name, avatar: avatar || '' };
  } catch {
    return { address, name: '', avatar: '' };
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
