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

export async function grant(origin, accounts, networks = []) {
  const permissions = await read();
  const previous = permissions[origin];
  const allowedNetworks = uniqueLower(networks.length ? networks : [await getChainId()]);
  const now = Date.now();
  permissions[origin] = {
    accounts,
    networks: allowedNetworks,
    connectedAt: previous?.connectedAt ?? now,
    updatedAt: now,
    lastActiveAt: now,
  };
  await write(permissions);
  await record(origin, previous ? 'updated' : 'connected', {
    accounts,
    networks: allowedNetworks,
  });
}

export async function updateAccounts(origin, accounts) {
  const permissions = await read();
  if (!accounts.length) {
    delete permissions[origin];
    await record(origin, 'disconnected');
  } else {
    const now = Date.now();
    permissions[origin] = {
      ...(permissions[origin] ?? {}),
      accounts,
      networks: permissions[origin]?.networks ?? [await getChainId()],
      connectedAt: permissions[origin]?.connectedAt ?? now,
      updatedAt: now,
      lastActiveAt: now,
    };
    await record(origin, 'accountsUpdated', { accounts });
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
    permissions[origin].accounts = permissions[origin].accounts.filter(
      (a) => a.toLowerCase() !== address.toLowerCase()
    );
    if (!permissions[origin].accounts.length) delete permissions[origin];
  }
  await local.set({ permissions });
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
