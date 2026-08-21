import { JsonRpcProvider, Network } from 'ethers';
import { local } from './storage.js';

// ---------------------------------------------------------------------------
// Chain registry
//
// Every network carries an ordered *list* of RPC endpoints rather than a single
// URL. The first one that answers wins; the rest are failover. A public
// endpoint rate-limiting or going down is the most common way a wallet appears
// broken, and it is entirely survivable when there is somewhere else to ask.
// ---------------------------------------------------------------------------

export const MAX_RPC_URLS = 6;

export const BUILTIN_NETWORKS = {
  '0x1': {
    chainId: '0x1',
    name: 'Ethereum',
    rpcUrls: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
      'https://cloudflare-eth.com',
    ],
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://etherscan.io',
    testnet: false,
  },
  '0xaa36a7': {
    chainId: '0xaa36a7',
    name: 'Sepolia',
    rpcUrls: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
      'https://rpc.sepolia.org',
    ],
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://sepolia.etherscan.io',
    testnet: true,
  },
  '0x89': {
    chainId: '0x89',
    name: 'Polygon',
    rpcUrls: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon-rpc.com',
      'https://polygon.drpc.org',
    ],
    symbol: 'POL',
    decimals: 18,
    explorer: 'https://polygonscan.com',
    testnet: false,
  },
  '0xa4b1': {
    chainId: '0xa4b1',
    name: 'Arbitrum One',
    rpcUrls: [
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.drpc.org',
    ],
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://arbiscan.io',
    testnet: false,
  },
  '0xa': {
    chainId: '0xa',
    name: 'OP Mainnet',
    rpcUrls: [
      'https://optimism-rpc.publicnode.com',
      'https://mainnet.optimism.io',
      'https://optimism.drpc.org',
    ],
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://optimistic.etherscan.io',
    testnet: false,
  },
  '0x2105': {
    chainId: '0x2105',
    name: 'Base',
    rpcUrls: [
      'https://base-rpc.publicnode.com',
      'https://mainnet.base.org',
      'https://base.drpc.org',
    ],
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://basescan.org',
    testnet: false,
  },
  '0x38': {
    chainId: '0x38',
    name: 'BNB Chain',
    rpcUrls: [
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed.bnbchain.org',
      'https://bsc.drpc.org',
    ],
    symbol: 'BNB',
    decimals: 18,
    explorer: 'https://bscscan.com',
    testnet: false,
  },
  '0x7a69': {
    chainId: '0x7a69',
    name: 'Localhost 8545',
    rpcUrls: ['http://127.0.0.1:8545'],
    symbol: 'ETH',
    decimals: 18,
    explorer: '',
    testnet: true,
  },
};

export const DEFAULT_CHAIN = '0xaa36a7';

// ---------------------------------------------------------------------------
// Endpoint health and rotation
//
// State lives in memory only. It is cheap to rebuild, the cooldowns are short,
// and writing it to disk on every failed request would churn storage for no
// benefit — the service worker restarting is not a reason to keep punishing an
// endpoint that may well have recovered.
// ---------------------------------------------------------------------------
const endpointState = new Map(); // url -> { failures, cooldownUntil, latencyMs, lastOkAt, lastError }

const COOLDOWN_BASE_MS = 15_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const RPC_TIMEOUT_MS = 12_000;

function stateFor(url) {
  let state = endpointState.get(url);
  if (!state) {
    state = { failures: 0, cooldownUntil: 0, latencyMs: null, lastOkAt: null, lastError: null };
    endpointState.set(url, state);
  }
  return state;
}

function markOk(url, latencyMs) {
  const state = stateFor(url);
  state.failures = 0;
  state.cooldownUntil = 0;
  state.latencyMs = latencyMs;
  state.lastOkAt = Date.now();
  state.lastError = null;
}

function markFailure(url, error) {
  const state = stateFor(url);
  state.failures += 1;
  // Back off further each time rather than hammering a dead host on every read.
  state.cooldownUntil = Date.now() + Math.min(MAX_COOLDOWN_MS, COOLDOWN_BASE_MS * 2 ** (state.failures - 1));
  state.lastError = error?.message ?? String(error);
}

/**
 * Endpoints in the order they should be tried: healthy ones first in the user's
 * own order, then cooled-down ones by soonest expiry. Every endpoint is always
 * returned — during a total outage a last-resort attempt beats refusing to try.
 */
function orderedEndpoints(urls) {
  const now = Date.now();
  const ready = [];
  const resting = [];
  for (const url of urls) {
    if (stateFor(url).cooldownUntil > now) resting.push(url);
    else ready.push(url);
  }
  resting.sort((a, b) => stateFor(a).cooldownUntil - stateFor(b).cooldownUntil);
  return [...ready, ...resting];
}

/** One POST to one endpoint. Throws on transport failure; a JSON-RPC error body is a success. */
async function postRpc(url, payload, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${hostOf(url)}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tries each endpoint until one answers.
 *
 * A JSON-RPC *error* — a revert, a bad parameter, an unsupported method — is a
 * real answer and is returned as-is. Rotating on those would turn one node's
 * honest "this call reverts" into a scan across every endpoint, and would hide
 * the revert reason behind whichever node failed last.
 */
async function sendWithFailover(urls, payload) {
  const candidates = orderedEndpoints(urls);
  let lastError = null;

  for (const url of candidates) {
    const started = Date.now();
    try {
      const json = await postRpc(url, payload);
      markOk(url, Date.now() - started);
      return json;
    } catch (err) {
      markFailure(url, err);
      lastError = err;
    }
  }

  throw new Error(
    candidates.length > 1
      ? `All ${candidates.length} RPC endpoints failed. Last error: ${lastError?.message ?? 'unknown'}`
      : (lastError?.message ?? 'The RPC endpoint did not respond.')
  );
}

/**
 * A JsonRpcProvider that rotates across the network's endpoint list.
 *
 * `_send` is the transport seam in ethers v6, so overriding it leaves batching,
 * response matching, and every higher-level method untouched.
 */
class FailoverProvider extends JsonRpcProvider {
  constructor(urls, network, options) {
    super(urls[0], network, options);
    this.adrixUrls = urls;
  }

  async _send(payload) {
    const json = await sendWithFailover(this.adrixUrls, payload);
    return Array.isArray(json) ? json : [json];
  }
}

/**
 * Passthrough for dApp RPC calls the wallet does not handle itself. Goes through
 * the same rotation as everything else, and preserves the JSON-RPC error shape
 * so the dApp sees the node's real error code rather than a wrapped one.
 */
export async function rpcPassthrough(chainId, method, params) {
  const network = await getNetwork(chainId);
  const json = await sendWithFailover(network.rpcUrls, {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });
  const body = Array.isArray(json) ? json[0] : json;
  if (body?.error) {
    throw Object.assign(new Error(body.error.message ?? 'RPC error'), {
      code: body.error.code ?? -32603,
      data: body.error.data,
    });
  }
  return body?.result;
}

/** Live endpoint status for one network, for the UI. Never touches the network. */
export async function peekEndpoints(chainId) {
  const network = await getNetwork(chainId);
  const now = Date.now();
  return network.rpcUrls.map((url, index) => {
    const state = stateFor(url);
    return {
      url,
      host: hostOf(url),
      primary: index === 0,
      resting: state.cooldownUntil > now,
      cooldownMs: Math.max(0, state.cooldownUntil - now),
      failures: state.failures,
      latencyMs: state.latencyMs,
      lastOkAt: state.lastOkAt,
      lastError: state.lastError,
      status: state.cooldownUntil > now ? 'resting' : state.lastOkAt ? 'ok' : 'untried',
    };
  });
}

/** Probes every endpoint of a network independently, for the network editor. */
export async function checkEndpoints(chainId) {
  const network = await getNetwork(chainId);
  return Promise.all(
    network.rpcUrls.map(async (url, index) => {
      const started = Date.now();
      try {
        const json = await postRpc(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, 7000);
        const body = Array.isArray(json) ? json[0] : json;
        if (body?.error) throw new Error(body.error.message);
        const latencyMs = Date.now() - started;
        markOk(url, latencyMs);
        return {
          url,
          host: hostOf(url),
          primary: index === 0,
          ok: true,
          latencyMs,
          blockNumber: body?.result ? parseInt(body.result, 16) : null,
        };
      } catch (err) {
        markFailure(url, err);
        return { url, host: hostOf(url), primary: index === 0, ok: false, error: err.message };
      }
    })
  );
}

export function resetEndpointState(urls) {
  for (const url of urls ?? []) endpointState.delete(url);
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

const cleanUrl = (value) => String(value ?? '').trim();

function uniqueUrls(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const url = cleanUrl(value);
    if (!url) continue;
    const key = url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(url);
  }
  return result.slice(0, MAX_RPC_URLS);
}

/**
 * Gives every network record both shapes: `rpcUrls` (the list) and `rpc` (the
 * primary). Records stored before failover existed carry only `rpc`, and the
 * dApp-facing `wallet_addEthereumChain` still hands over a single URL, so both
 * have to keep working without a storage migration.
 */
function normaliseNetworkRecord(net) {
  const urls = uniqueUrls([...(net.rpcUrls ?? []), net.rpc]);
  return { ...net, rpcUrls: urls, rpc: urls[0] ?? '' };
}

export async function allNetworks() {
  const custom = await local.get('customNetworks', {});
  // Built-ins can be edited too; overrides are stored separately so a reset
  // restores the shipped defaults without needing them re-entered.
  const overrides = await local.get('networkOverrides', {});
  const merged = { ...BUILTIN_NETWORKS, ...custom };
  for (const [chainId, patch] of Object.entries(overrides)) {
    if (merged[chainId]) merged[chainId] = { ...merged[chainId], ...patch, edited: true };
  }
  return Object.fromEntries(Object.entries(merged).map(([chainId, net]) => [chainId, normaliseNetworkRecord(net)]));
}

export function getShowTestnets() {
  return local.get('showTestnets', true);
}

export async function setShowTestnets(value) {
  await local.set({ showTestnets: Boolean(value) });
  // Never strand the user on a hidden network.
  if (!value) {
    const current = await getChainId();
    const networks = await allNetworks();
    if (networks[current]?.testnet) {
      const firstVisible = Object.values(networks).find((net) => !net.testnet);
      if (firstVisible) await local.set({ chainId: firstVisible.chainId });
    }
  }
  return Boolean(value);
}

/** allNetworks filtered by the testnet toggle. The selected chain always stays. */
export async function visibleNetworks() {
  const networks = await allNetworks();
  if (await getShowTestnets()) return networks;
  const current = await getChainId();
  return Object.fromEntries(
    Object.entries(networks).filter(([chainId, net]) => !net.testnet || chainId === current)
  );
}

export async function getChainId() {
  return local.get('chainId', DEFAULT_CHAIN);
}

export async function getNetwork(chainId) {
  const networks = await allNetworks();
  const id = chainId ?? (await getChainId());
  return networks[id] ?? normaliseNetworkRecord(BUILTIN_NETWORKS[DEFAULT_CHAIN]);
}

export async function setChain(chainId) {
  const networks = await allNetworks();
  if (!networks[chainId]) throw Object.assign(new Error('Unrecognised chain.'), { code: 4902 });
  await local.set({ chainId });
  return networks[chainId];
}

// ---------------------------------------------------------------------------
// Registry writes
// ---------------------------------------------------------------------------
function validateNetworkInput(network) {
  const chainId = normaliseChainId(network.chainId);
  const name = String(network.name ?? '').trim();
  if (!name) throw new Error('Enter a network name.');

  const rpcUrls = uniqueUrls([...(network.rpcUrls ?? []), network.rpc]);
  if (!rpcUrls.length) throw new Error('Add at least one RPC URL.');
  for (const url of rpcUrls) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`RPC URL must start with http:// or https:// — "${url}" does not.`);
  }

  const explorer = String(network.explorer ?? '').trim();
  if (explorer && !/^https?:\/\//i.test(explorer)) {
    throw new Error('Block explorer URL must start with http:// or https://.');
  }

  return {
    chainId,
    name,
    rpcUrls,
    rpc: rpcUrls[0],
    symbol: String(network.symbol ?? '').trim() || 'ETH',
    decimals: 18,
    // Trailing slashes double up when explorer links are built, so drop them here.
    explorer: explorer.replace(/\/+$/, ''),
    testnet: Boolean(network.testnet),
  };
}

export async function addNetwork(network) {
  const clean = validateNetworkInput(network);
  const custom = await local.get('customNetworks', {});
  if (BUILTIN_NETWORKS[clean.chainId] || custom[clean.chainId]) {
    throw new Error('That chain ID is already in the network list. Edit it instead.');
  }

  custom[clean.chainId] = { ...clean, custom: true };
  await local.set({ customNetworks: custom });
  providerCache.delete(clean.chainId);
  return custom[clean.chainId];
}

/**
 * Edits any network. Custom entries are rewritten in place; built-ins get an
 * override record so the shipped default can be restored later. The chain ID
 * itself is immutable — changing it would orphan every token, permission, and
 * activity row keyed to it.
 */
export async function editNetwork(chainId, patch) {
  const target = normaliseChainId(chainId);
  const existing = (await allNetworks())[target];
  if (!existing) throw new Error('Network not found.');

  // An explicit rpcUrls list in the patch replaces the old one outright, rather
  // than merging — otherwise a removed endpoint would come back.
  const merged = { ...existing, ...patch, chainId: target };
  if (patch.rpcUrls) merged.rpcUrls = patch.rpcUrls;
  const clean = validateNetworkInput(merged);

  if (BUILTIN_NETWORKS[target]) {
    const overrides = await local.get('networkOverrides', {});
    overrides[target] = {
      name: clean.name,
      rpc: clean.rpc,
      rpcUrls: clean.rpcUrls,
      symbol: clean.symbol,
      explorer: clean.explorer,
    };
    await local.set({ networkOverrides: overrides });
  } else {
    const custom = await local.get('customNetworks', {});
    custom[target] = { ...clean, custom: true };
    await local.set({ customNetworks: custom });
  }

  // The cached provider is bound to the old endpoint list. Backoff state is
  // cleared too: editing a network is how a user fixes a broken endpoint, and
  // they should not have to wait out a cooldown earned by the old URL.
  providerCache.delete(target);
  healthCache.delete(target);
  resetEndpointState(clean.rpcUrls);
  return (await allNetworks())[target];
}

/** Drops a built-in's override, restoring the shipped values. */
export async function resetNetwork(chainId) {
  const target = normaliseChainId(chainId);
  if (!BUILTIN_NETWORKS[target]) throw new Error('Only built-in networks can be reset.');
  const overrides = await local.get('networkOverrides', {});
  delete overrides[target];
  await local.set({ networkOverrides: overrides });
  providerCache.delete(target);
  healthCache.delete(target);
  return normaliseNetworkRecord(BUILTIN_NETWORKS[target]);
}

export async function removeNetwork(chainId) {
  const target = normaliseChainId(chainId);
  if (BUILTIN_NETWORKS[target]) throw new Error('Built-in networks cannot be removed, only edited.');

  const custom = await local.get('customNetworks', {});
  if (!custom[target]) throw new Error('Network not found.');
  delete custom[target];
  await local.set({ customNetworks: custom });
  providerCache.delete(target);
  healthCache.delete(target);
  if ((await getChainId()) === target) await local.set({ chainId: DEFAULT_CHAIN });
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
// Providers are cached per chain, keyed by the endpoint list so an edit rebuilds
// them. `staticNetwork` stops ethers re-detecting the chain on every call.
const providerCache = new Map();
const healthCache = new Map();
const HEALTH_TTL_MS = 30_000;

export async function getProvider(chainId) {
  const network = await getNetwork(chainId);
  const key = network.rpcUrls.join('|');
  const cached = providerCache.get(network.chainId);
  if (cached && cached.key === key) return cached.provider;

  const provider = new FailoverProvider(network.rpcUrls, Network.from(parseInt(network.chainId, 16)), {
    staticNetwork: true,
  });
  providerCache.set(network.chainId, { key, provider });
  return provider;
}

/**
 * Cached health only — never touches the network. getState() calls this on
 * every state broadcast, and awaiting a live RPC round trip there would make
 * the popup take up to six seconds to open on a slow endpoint.
 */
export async function peekNetworkHealth(chainId) {
  const network = await getNetwork(chainId);
  const key = network.rpcUrls.join('|');
  const cached = healthCache.get(network.chainId);
  if (cached && cached.key === key) {
    return { ...cached.health, stale: Date.now() - cached.checkedAt > HEALTH_TTL_MS };
  }
  return {
    status: 'unknown',
    latencyMs: null,
    blockNumber: null,
    checkedAt: null,
    stale: true,
    endpointCount: network.rpcUrls.length,
  };
}

/**
 * Live probe. Measures round-trip latency and reads the head block plus current
 * gas price, so "slow" can be backed by a number the user can see.
 */
export async function getNetworkHealth(chainId, { force = false } = {}) {
  const network = await getNetwork(chainId);
  const key = network.rpcUrls.join('|');
  const cached = healthCache.get(network.chainId);
  if (!force && cached && cached.key === key && Date.now() - cached.checkedAt < HEALTH_TTL_MS) {
    return cached.health;
  }

  const checkedAt = Date.now();
  const endpoints = await peekEndpoints(network.chainId);

  try {
    const provider = await getProvider(network.chainId);
    const started = Date.now();
    const blockNumber = await withTimeout(provider.getBlockNumber(), 6000, 'RPC timed out.');
    const latencyMs = Date.now() - started;

    // Best-effort extras; a failure here should not downgrade a healthy result.
    const [block, feeData] = await Promise.all([
      withTimeout(provider.getBlock(blockNumber), 4000, 'block read timed out').catch(() => null),
      withTimeout(provider.getFeeData(), 4000, 'fee read timed out').catch(() => null),
    ]);

    const blockAgeMs = block?.timestamp ? Date.now() - block.timestamp * 1000 : null;
    // Which endpoint actually served the request — the head of the rotation
    // after the call, since a failover will have reordered it.
    const live = (await peekEndpoints(network.chainId)).find((entry) => entry.status === 'ok') ?? null;

    const health = {
      // A node that answers fast but is behind is worse than a slow current
      // one, so a stale head demotes the status regardless of latency.
      status:
        blockAgeMs != null && blockAgeMs > 180_000
          ? 'poor'
          : latencyMs < 900
            ? 'good'
            : latencyMs < 2500
              ? 'slow'
              : 'poor',
      latencyMs,
      blockNumber,
      blockAgeMs,
      baseFeePerGas: block?.baseFeePerGas?.toString() ?? null,
      gasPrice: feeData?.gasPrice?.toString() ?? null,
      rpcHost: live?.host ?? hostOf(network.rpcUrls[0]),
      // A failover that already happened is worth surfacing: the wallet is
      // working, but not from where the user configured it to.
      usingFallback: Boolean(live && !live.primary),
      endpointCount: network.rpcUrls.length,
      healthyCount: endpoints.filter((entry) => entry.status !== 'resting').length,
      checkedAt,
      stale: false,
    };
    healthCache.set(network.chainId, { key, checkedAt, health });
    return health;
  } catch (err) {
    const health = {
      status: 'offline',
      latencyMs: null,
      blockNumber: null,
      blockAgeMs: null,
      rpcHost: hostOf(network.rpcUrls[0]),
      endpointCount: network.rpcUrls.length,
      healthyCount: 0,
      checkedAt,
      stale: false,
      error: err.shortMessage ?? err.message,
    };
    healthCache.set(network.chainId, { key, checkedAt, health });
    return health;
  }
}

/** Probes every visible network at once, for the network picker. */
export async function checkAllNetworks() {
  const networks = await visibleNetworks();
  const entries = await Promise.all(
    Object.values(networks).map(async (net) => [net.chainId, await getNetworkHealth(net.chainId)])
  );
  return Object.fromEntries(entries);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url ?? '';
  }
}

// Methods the wallet actually depends on. An endpoint that answers eth_chainId
// but refuses eth_call looks fine at connect time and then breaks every balance
// read, which is a much worse failure than being rejected up front.
const REQUIRED_METHODS = [
  { method: 'eth_getBalance', params: ['0x0000000000000000000000000000000000000000', 'latest'], label: 'read balances' },
  { method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000000', data: '0x' }, 'latest'], label: 'read contracts' },
  { method: 'eth_estimateGas', params: [{ to: '0x0000000000000000000000000000000000000000', value: '0x0' }], label: 'estimate gas' },
  { method: 'eth_getTransactionCount', params: ['0x0000000000000000000000000000000000000000', 'pending'], label: 'read nonces' },
  { method: 'eth_gasPrice', params: [], label: 'read gas prices' },
  { method: 'eth_feeHistory', params: ['0x5', 'latest', [50]], label: 'read fee history', optional: true },
];

/**
 * Probes one endpoint before it is trusted with the user's addresses and signed
 * transactions. Hard failures throw; everything survivable comes back as a
 * warning so the user can decide.
 */
export async function testRpc(network) {
  const chainId = normaliseChainId(network.chainId);
  const rpc = cleanUrl(network.rpc ?? network.rpcUrls?.[0]);

  let url;
  try {
    url = new URL(rpc);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('RPC URL must use http:// or https://.');
  }

  const warnings = [];
  const isLocal = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname);

  // Plain HTTP exposes every address you query and every signed transaction you
  // broadcast to anything on the path. Tolerable for a local node, not for a
  // remote one.
  if (url.protocol === 'http:' && !isLocal) {
    warnings.push('This endpoint is unencrypted HTTP. Your addresses and transactions travel in the clear.');
  }
  if (url.username || url.password) {
    warnings.push('The URL embeds credentials. They are stored in the extension in plain text.');
  }

  // A URL already registered under a different chain is nearly always a paste
  // error, and it silently produces a network that signs for the wrong chain.
  const existing = await allNetworks();
  const clash = Object.values(existing).find(
    (net) => net.chainId !== chainId && net.rpcUrls.some((entry) => entry.toLowerCase() === rpc.toLowerCase())
  );
  if (clash) warnings.push(`This same URL is already used by "${clash.name}" (${clash.chainId}).`);

  const provider = new JsonRpcProvider(rpc, Network.from(parseInt(chainId, 16)), { staticNetwork: true });

  const started = Date.now();
  let blockNumber;
  let detected;
  try {
    [blockNumber, detected] = await Promise.all([
      withTimeout(provider.getBlockNumber(), 7000, 'RPC timed out reading the block number.'),
      withTimeout(provider.send('eth_chainId', []), 7000, 'RPC did not answer eth_chainId.'),
    ]);
  } catch (err) {
    throw new Error(`Could not reach that endpoint: ${err.shortMessage ?? err.message}`);
  }
  const latencyMs = Date.now() - started;

  const detectedHex = normaliseChainId(detected);
  if (detectedHex !== chainId) {
    const known = existing[detectedHex];
    throw new Error(
      `That endpoint serves chain ${detectedHex}${known ? ` (${known.name})` : ''}, not ${chainId}. ` +
        'Signing against a mismatched chain ID produces transactions valid somewhere you did not intend.'
    );
  }

  // Method support and head freshness, both best-effort.
  const [methodResults, head, clientVersion] = await Promise.all([
    Promise.all(
      REQUIRED_METHODS.map(async ({ method, params, label, optional }) => {
        try {
          await withTimeout(provider.send(method, params), 6000, 'timed out');
          return { method, label, optional: Boolean(optional), ok: true };
        } catch (err) {
          // A revert from eth_call still proves the method is served; only a
          // "method not found" style failure counts as unsupported.
          const message = String(err?.message ?? '');
          const unsupported = /not (found|supported|available)|unsupported|-32601|does not exist/i.test(message);
          return {
            method,
            label,
            optional: Boolean(optional),
            ok: !unsupported,
            error: unsupported ? message : null,
          };
        }
      })
    ),
    withTimeout(provider.getBlock(blockNumber), 6000, 'timed out').catch(() => null),
    withTimeout(provider.send('web3_clientVersion', []), 4000, 'timed out').catch(() => null),
  ]);

  const missing = methodResults.filter((result) => !result.ok && !result.optional);
  if (missing.length) {
    warnings.push(`This endpoint cannot ${missing.map((m) => m.label).join(', ')}. The wallet needs those.`);
  }
  // Fee history drives the base-fee chart and the inclusion estimates. Losing it
  // degrades those to a flat guess rather than breaking anything.
  if (methodResults.some((result) => result.optional && !result.ok)) {
    warnings.push('This endpoint does not serve eth_feeHistory, so fee trends and time estimates will be approximate.');
  }

  const blockAgeMs = head?.timestamp ? Date.now() - head.timestamp * 1000 : null;
  if (blockAgeMs != null && blockAgeMs > 120_000) {
    warnings.push(
      `The latest block is ${Math.round(blockAgeMs / 60000)} minutes old. This node is lagging behind the chain.`
    );
  }
  if (latencyMs > 2500) {
    warnings.push(`Round trip took ${latencyMs}ms. Expect the wallet to feel slow on this endpoint.`);
  }

  return {
    ok: true,
    chainId,
    rpc,
    blockNumber,
    latencyMs,
    blockAgeMs,
    supportsEip1559: head?.baseFeePerGas != null,
    baseFeePerGas: head?.baseFeePerGas?.toString() ?? null,
    clientVersion: typeof clientVersion === 'string' ? clientVersion.slice(0, 80) : null,
    methods: methodResults,
    warnings,
  };
}

function normaliseChainId(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Enter a chain ID.');
  if (/^0x[0-9a-f]+$/i.test(text)) return text.toLowerCase();
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('Chain ID must be hex or a positive number.');
  return `0x${parsed.toString(16)}`;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
