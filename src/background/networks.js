import { JsonRpcProvider, Network } from 'ethers';
import { local } from './storage.js';

export const BUILTIN_NETWORKS = {
  '0x1': {
    chainId: '0x1',
    name: 'Ethereum',
    rpc: 'https://ethereum-rpc.publicnode.com',
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://etherscan.io',
    testnet: false,
  },
  '0xaa36a7': {
    chainId: '0xaa36a7',
    name: 'Sepolia',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://sepolia.etherscan.io',
    testnet: true,
  },
  '0x89': {
    chainId: '0x89',
    name: 'Polygon',
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    symbol: 'POL',
    decimals: 18,
    explorer: 'https://polygonscan.com',
    testnet: false,
  },
  '0xa4b1': {
    chainId: '0xa4b1',
    name: 'Arbitrum One',
    rpc: 'https://arbitrum-one-rpc.publicnode.com',
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://arbiscan.io',
    testnet: false,
  },
  '0xa': {
    chainId: '0xa',
    name: 'OP Mainnet',
    rpc: 'https://optimism-rpc.publicnode.com',
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://optimistic.etherscan.io',
    testnet: false,
  },
  '0x2105': {
    chainId: '0x2105',
    name: 'Base',
    rpc: 'https://base-rpc.publicnode.com',
    symbol: 'ETH',
    decimals: 18,
    explorer: 'https://basescan.org',
    testnet: false,
  },
  '0x38': {
    chainId: '0x38',
    name: 'BNB Chain',
    rpc: 'https://bsc-rpc.publicnode.com',
    symbol: 'BNB',
    decimals: 18,
    explorer: 'https://bscscan.com',
    testnet: false,
  },
  '0x7a69': {
    chainId: '0x7a69',
    name: 'Localhost 8545',
    rpc: 'http://127.0.0.1:8545',
    symbol: 'ETH',
    decimals: 18,
    explorer: '',
    testnet: true,
  },
};

export const DEFAULT_CHAIN = '0xaa36a7';

export async function allNetworks() {
  const custom = await local.get('customNetworks', {});
  // Built-ins can be edited too; overrides are stored separately so a reset
  // restores the shipped defaults without needing them re-entered.
  const overrides = await local.get('networkOverrides', {});
  const merged = { ...BUILTIN_NETWORKS, ...custom };
  for (const [chainId, patch] of Object.entries(overrides)) {
    if (merged[chainId]) merged[chainId] = { ...merged[chainId], ...patch, edited: true };
  }
  return merged;
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
  return networks[id] ?? BUILTIN_NETWORKS[DEFAULT_CHAIN];
}

export async function setChain(chainId) {
  const networks = await allNetworks();
  if (!networks[chainId]) throw Object.assign(new Error('Unrecognised chain.'), { code: 4902 });
  await local.set({ chainId });
  return networks[chainId];
}

function validateNetworkInput(network) {
  const chainId = normaliseChainId(network.chainId);
  const name = String(network.name ?? '').trim();
  if (!name) throw new Error('Enter a network name.');

  const rpc = String(network.rpc ?? '').trim();
  if (!/^https?:\/\//i.test(rpc)) throw new Error('RPC URL must start with http:// or https://.');

  const explorer = String(network.explorer ?? '').trim();
  if (explorer && !/^https?:\/\//i.test(explorer)) {
    throw new Error('Block explorer URL must start with http:// or https://.');
  }

  return {
    chainId,
    name,
    rpc,
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

  const clean = validateNetworkInput({ ...existing, ...patch, chainId: target });

  if (BUILTIN_NETWORKS[target]) {
    const overrides = await local.get('networkOverrides', {});
    overrides[target] = {
      name: clean.name,
      rpc: clean.rpc,
      symbol: clean.symbol,
      explorer: clean.explorer,
    };
    await local.set({ networkOverrides: overrides });
  } else {
    const custom = await local.get('customNetworks', {});
    custom[target] = { ...clean, custom: true };
    await local.set({ customNetworks: custom });
  }

  // The cached provider is bound to the old RPC URL.
  providerCache.delete(target);
  healthCache.delete(target);
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
  return BUILTIN_NETWORKS[target];
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

// Providers are cached per chain. `staticNetwork` stops ethers from
// re-detecting the chain on every single call.
const providerCache = new Map();
const healthCache = new Map();
const HEALTH_TTL_MS = 30_000;

export async function getProvider(chainId) {
  const network = await getNetwork(chainId);
  const cached = providerCache.get(network.chainId);
  if (cached && cached.rpc === network.rpc) return cached.provider;

  const provider = new JsonRpcProvider(network.rpc, Network.from(parseInt(network.chainId, 16)), {
    staticNetwork: true,
  });
  providerCache.set(network.chainId, { rpc: network.rpc, provider });
  return provider;
}

/**
 * Cached health only — never touches the network. getState() calls this on
 * every state broadcast, and awaiting a live RPC round trip there would make
 * the popup take up to six seconds to open on a slow endpoint.
 */
export async function peekNetworkHealth(chainId) {
  const network = await getNetwork(chainId);
  const cached = healthCache.get(network.chainId);
  if (cached && cached.rpc === network.rpc) {
    return { ...cached.health, stale: Date.now() - cached.checkedAt > HEALTH_TTL_MS };
  }
  return { status: 'unknown', latencyMs: null, blockNumber: null, checkedAt: null, stale: true };
}

/**
 * Live probe. Measures round-trip latency and reads the head block plus current
 * gas price, so "slow" can be backed by a number the user can see.
 */
export async function getNetworkHealth(chainId, { force = false } = {}) {
  const network = await getNetwork(chainId);
  const cached = healthCache.get(network.chainId);
  if (!force && cached && cached.rpc === network.rpc && Date.now() - cached.checkedAt < HEALTH_TTL_MS) {
    return cached.health;
  }

  const checkedAt = Date.now();
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
      rpcHost: hostOf(network.rpc),
      checkedAt,
      stale: false,
    };
    healthCache.set(network.chainId, { rpc: network.rpc, checkedAt, health });
    return health;
  } catch (err) {
    const health = {
      status: 'offline',
      latencyMs: null,
      blockNumber: null,
      blockAgeMs: null,
      rpcHost: hostOf(network.rpc),
      checkedAt,
      stale: false,
      error: err.shortMessage ?? err.message,
    };
    healthCache.set(network.chainId, { rpc: network.rpc, checkedAt, health });
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
];

/**
 * Probes an endpoint before it is trusted with the user's addresses and
 * signed transactions. Hard failures throw; everything survivable comes back
 * as a warning so the user can decide.
 */
export async function testRpc(network) {
  const chainId = normaliseChainId(network.chainId);
  const rpc = String(network.rpc ?? '').trim();

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
    (net) => net.chainId !== chainId && net.rpc?.trim().toLowerCase() === rpc.toLowerCase()
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
      REQUIRED_METHODS.map(async ({ method, params, label }) => {
        try {
          await withTimeout(provider.send(method, params), 6000, 'timed out');
          return { method, label, ok: true };
        } catch (err) {
          // A revert from eth_call still proves the method is served; only a
          // "method not found" style failure counts as unsupported.
          const message = String(err?.message ?? '');
          const unsupported = /not (found|supported|available)|unsupported|-32601|does not exist/i.test(message);
          return { method, label, ok: !unsupported, error: unsupported ? message : null };
        }
      })
    ),
    withTimeout(provider.getBlock(blockNumber), 6000, 'timed out').catch(() => null),
    withTimeout(provider.send('web3_clientVersion', []), 4000, 'timed out').catch(() => null),
  ]);

  const missing = methodResults.filter((result) => !result.ok);
  if (missing.length) {
    warnings.push(`This endpoint cannot ${missing.map((m) => m.label).join(', ')}. The wallet needs those.`);
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
