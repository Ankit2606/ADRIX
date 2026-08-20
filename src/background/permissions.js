import { local } from './storage.js';
import { getSelected, listVisibleAccounts } from './keyring.js';
import { getChainId } from './networks.js';

const HISTORY_LIMIT = 120;

// { [origin]: { accounts: string[], networks: string[], connectedAt: number, updatedAt?: number, lastActiveAt?: number } }
const read = () => local.get('permissions', {});

const uniqueLower = (values = []) => [...new Set(values.filter(Boolean).map((value) => value.toLowerCase()))];

async function write(permissions) {
  await local.set({ permissions });
}

async function record(origin, type, detail = {}) {
  const history = await local.get('connectionHistory', []);
  history.unshift({
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    origin,
    type,
    at: Date.now(),
    ...detail,
  });
  await local.set({ connectionHistory: history.slice(0, HISTORY_LIMIT) });
}

/**
 * Grants must be deduped and checked against the wallet before they are stored.
 * Two entries for the same address make a dApp see the account twice, and an
 * address that is not in the wallet is a grant that can never resolve.
 */
async function normaliseAccounts(accounts = []) {
  const known = new Map(
    (await listVisibleAccounts()).map((account) => [account.address.toLowerCase(), account.address])
  );
  const seen = new Set();
  const result = [];
  for (const address of accounts) {
    const key = String(address ?? '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Store the wallet's checksummed form rather than whatever casing arrived.
    if (known.has(key)) result.push(known.get(key));
  }
  return result;
}

export async function grant(origin, accounts, networks = []) {
  const permissions = await read();
  const previous = permissions[origin];
  const allowedAccounts = await normaliseAccounts(accounts);
  if (!allowedAccounts.length) throw Object.assign(new Error('No usable account was granted.'), { code: 4001 });

  const allowedNetworks = uniqueLower(networks.length ? networks : [await getChainId()]);
  const now = Date.now();
  permissions[origin] = {
    accounts: allowedAccounts,
    networks: allowedNetworks,
    connectedAt: previous?.connectedAt ?? now,
    updatedAt: now,
    lastActiveAt: now,
  };
  await write(permissions);
  await record(origin, previous ? 'updated' : 'connected', {
    accounts: allowedAccounts,
    networks: allowedNetworks,
  });
}

export async function updateAccounts(origin, accounts) {
  const permissions = await read();
  const allowedAccounts = await normaliseAccounts(accounts);

  if (!allowedAccounts.length) {
    delete permissions[origin];
    await record(origin, 'disconnected');
  } else {
    const now = Date.now();
    permissions[origin] = {
      ...(permissions[origin] ?? {}),
      accounts: allowedAccounts,
      networks: permissions[origin]?.networks ?? [await getChainId()],
      connectedAt: permissions[origin]?.connectedAt ?? now,
      updatedAt: now,
      lastActiveAt: now,
    };
    await record(origin, 'accountsUpdated', { accounts: allowedAccounts });
  }
  await write(permissions);
}

export async function updateNetworks(origin, networks) {
  const permissions = await read();
  if (!permissions[origin]) throw new Error('That site is not connected.');
  const allowedNetworks = uniqueLower(networks);
  if (!allowedNetworks.length) throw new Error('Choose at least one network.');
  permissions[origin] = {
    ...permissions[origin],
    networks: allowedNetworks,
    updatedAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  await write(permissions);
  await record(origin, 'networksUpdated', { networks: allowedNetworks });
}

export async function grantNetworks(origin, networks) {
  const permissions = await read();
  const existing = permissions[origin];
  if (!existing) return;
  const allowedNetworks = uniqueLower([...(existing.networks ?? []), ...networks]);
  permissions[origin] = {
    ...existing,
    networks: allowedNetworks,
    updatedAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  await write(permissions);
  await record(origin, 'networksUpdated', { networks: allowedNetworks });
}

export async function revoke(origin) {
  const permissions = await read();
  delete permissions[origin];
  await write(permissions);
  await record(origin, 'disconnected');
}

export async function listSites() {
  const permissions = await read();
  const chainId = await getChainId();
  return Object.entries(permissions).map(([origin, value]) => ({
    origin,
    ...value,
    networks: value.networks?.length ? uniqueLower(value.networks) : [chainId],
  }));
}

export async function listHistory() {
  return local.get('connectionHistory', []);
}

export async function hasSite(origin) {
  const permissions = await read();
  return Boolean(permissions[origin]?.accounts?.length);
}

export async function touch(origin, type = 'used', detail = {}) {
  const permissions = await read();
  if (!permissions[origin]) return;
  permissions[origin] = { ...permissions[origin], lastActiveAt: Date.now() };
  await write(permissions);
  await record(origin, type, detail);
}

export async function networksFor(origin) {
  const permissions = await read();
  const granted = permissions[origin]?.networks;
  return granted?.length ? uniqueLower(granted) : [await getChainId()];
}

export async function isNetworkPermitted(origin, chainId = null) {
  if (!(await hasSite(origin))) return true;
  const target = (chainId ?? (await getChainId())).toLowerCase();
  const networks = await networksFor(origin);
  return networks.includes(target);
}

export async function ensureNetworkPermitted(origin, chainId = null) {
  if (!(await isNetworkPermitted(origin, chainId))) {
    throw Object.assign(new Error('This site is not allowed to use the selected network.'), { code: 4901 });
  }
}

/**
 * Accounts a site is allowed to see, with the currently selected account first
 * when it is among them. dApps read accounts[0] as "the" account, so that
 * ordering is what makes the account switcher feel like it works.
 */
export async function accountsFor(origin, { requireNetwork = false } = {}) {
  if (requireNetwork && !(await isNetworkPermitted(origin))) return [];

  const permissions = await read();
  const granted = permissions[origin]?.accounts ?? [];
  if (!granted.length) return [];

  const visibleAccounts = await listVisibleAccounts();
  const visible = new Set(visibleAccounts.map((account) => account.address.toLowerCase()));
  const allowed = granted.filter((address) => visible.has(address.toLowerCase()));
  if (!allowed.length) return [];

  const selected = await getSelected();
  const ordered = allowed.filter((a) => a.toLowerCase() === selected?.toLowerCase());
  return [...ordered, ...allowed.filter((a) => a.toLowerCase() !== selected?.toLowerCase())];
}

export async function isPermitted(origin, address) {
  const accounts = await accountsFor(origin);
  return accounts.some((a) => a.toLowerCase() === address?.toLowerCase());
}

/** Drop an account from every site that had it - used when removing an account. */
export async function purgeAccount(address) {
  const permissions = await read();
  for (const origin of Object.keys(permissions)) {
    const remaining = (permissions[origin].accounts ?? []).filter(
      (a) => a.toLowerCase() !== address.toLowerCase()
    );
    if (remaining.length) permissions[origin].accounts = remaining;
    else delete permissions[origin];
  }
  await local.set({ permissions });
}

/** Drops every site grant at once. */
export async function revokeAll() {
  const permissions = await read();
  const origins = Object.keys(permissions);
  await local.set({ permissions: {} });
  for (const origin of origins) await record(origin, 'disconnected');
  return { revoked: origins.length, origins };
}

/**
 * Everything one origin has done, newest first, plus a tally by type. This is
 * what makes the history answer "what has this site actually been doing" rather
 * than just "when did it connect".
 */
export async function siteActivity(origin) {
  const history = await local.get('connectionHistory', []);
  const entries = history.filter((entry) => entry.origin === origin);
  const counts = {};
  for (const entry of entries) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  return {
    origin,
    entries,
    counts,
    signatures: (counts.personalSign ?? 0) + (counts.typedSign ?? 0),
    transactions: counts.transaction ?? 0,
    firstSeen: entries.length ? entries[entries.length - 1].at : null,
    lastSeen: entries.length ? entries[0].at : null,
  };
}

/** Distinct origins that appear in the history, including disconnected ones. */
export async function listHistoryOrigins() {
  const history = await local.get('connectionHistory', []);
  const permissions = await read();
  const seen = new Map();
  for (const entry of history) {
    const current = seen.get(entry.origin) ?? { origin: entry.origin, events: 0, lastSeen: 0 };
    current.events += 1;
    current.lastSeen = Math.max(current.lastSeen, entry.at ?? 0);
    seen.set(entry.origin, current);
  }
  return [...seen.values()]
    .map((row) => ({ ...row, connected: Boolean(permissions[row.origin]) }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

export async function clearHistory() {
  await local.set({ connectionHistory: [] });
  return { ok: true };
}

/** Drop a network from every site that had it - used when removing a custom network. */
export async function purgeNetwork(chainId) {
  const permissions = await read();
  const target = chainId.toLowerCase();
  const fallback = await getChainId();
  for (const origin of Object.keys(permissions)) {
    const next = (permissions[origin].networks ?? [fallback]).filter((id) => id.toLowerCase() !== target);
    permissions[origin].networks = next.length ? next : [fallback];
  }
  await local.set({ permissions });
}
