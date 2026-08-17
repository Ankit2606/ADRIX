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
  return { ...BUILTIN_NETWORKS, ...custom };
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

export async function addNetwork(network) {
  if (!/^0x[0-9a-f]+$/i.test(network.chainId)) throw new Error('Chain ID must be hex, like 0x1.');
  if (!network.rpc?.startsWith('http')) throw new Error('RPC URL must start with http.');

  const custom = await local.get('customNetworks', {});
  custom[network.chainId.toLowerCase()] = {
    chainId: network.chainId.toLowerCase(),
    name: network.name,
    rpc: network.rpc,
    symbol: network.symbol || 'ETH',
    decimals: 18,
    explorer: network.explorer || '',
    testnet: Boolean(network.testnet),
    custom: true,
  };
  await local.set({ customNetworks: custom });
  return custom[network.chainId.toLowerCase()];
}

export async function removeNetwork(chainId) {
  const custom = await local.get('customNetworks', {});
  delete custom[chainId];
  await local.set({ customNetworks: custom });
  if ((await getChainId()) === chainId) await local.set({ chainId: DEFAULT_CHAIN });
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

export async function getNetworkHealth(chainId) {
  const network = await getNetwork(chainId);
  const cached = healthCache.get(network.chainId);
  if (cached && cached.rpc === network.rpc && Date.now() - cached.checkedAt < HEALTH_TTL_MS) {
    return cached.health;
  }

  const checkedAt = Date.now();
  try {
    const provider = await getProvider(network.chainId);
    const started = Date.now();
    const blockNumber = await withTimeout(provider.getBlockNumber(), 6000, 'RPC timed out.');
    const latencyMs = Date.now() - started;
    const health = {
      status: latencyMs < 900 ? 'good' : latencyMs < 2500 ? 'slow' : 'poor',
      latencyMs,
      blockNumber,
      checkedAt,
    };
    healthCache.set(network.chainId, { rpc: network.rpc, checkedAt, health });
    return health;
  } catch (err) {
    const health = {
      status: 'offline',
      latencyMs: null,
      blockNumber: null,
      checkedAt,
      error: err.shortMessage ?? err.message,
    };
    healthCache.set(network.chainId, { rpc: network.rpc, checkedAt, health });
    return health;
  }
}

export async function testRpc(network) {
  const chainId = normaliseChainId(network.chainId);
  if (!network.rpc?.startsWith('http')) throw new Error('RPC URL must start with http.');

  const provider = new JsonRpcProvider(network.rpc, Network.from(parseInt(chainId, 16)), {
    staticNetwork: true,
  });

  const started = Date.now();
  const [blockNumber, detected] = await Promise.all([
    withTimeout(provider.getBlockNumber(), 7000, 'RPC timed out.'),
    withTimeout(provider.send('eth_chainId', []), 7000, 'Could not read chain ID.'),
  ]);

  const detectedHex = normaliseChainId(detected);
  if (detectedHex !== chainId) {
    throw new Error(`RPC returned chain ${detectedHex}, but the form says ${chainId}.`);
  }

  return {
    ok: true,
    chainId,
    blockNumber,
    latencyMs: Date.now() - started,
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
