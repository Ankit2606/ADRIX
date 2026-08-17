import { Contract, Interface, ZeroAddress, getAddress, formatUnits, parseUnits } from 'ethers';
import { local } from './storage.js';
import { getProvider, getChainId } from './networks.js';

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export const ERC721_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address to, uint256 tokenId)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
];

export const ERC1155_ABI = [
  'function uri(uint256 tokenId) view returns (string)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
];

export const erc20Interface = new Interface(ERC20_ABI);
export const erc721Interface = new Interface(ERC721_ABI);
export const erc1155Interface = new Interface(ERC1155_ABI);

const TOKEN_REGISTRY = {
  '0x1': [
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18, name: 'Dai Stablecoin' },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
    { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18, name: 'Chainlink' },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8, name: 'Wrapped BTC' },
  ],
  '0x89': [
    { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC.e', decimals: 6, name: 'Bridged USDC' },
    { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
    { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', symbol: 'WBTC', decimals: 8, name: 'Wrapped BTC' },
  ],
  '0xa4b1': [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', symbol: 'USDC.e', decimals: 6, name: 'Bridged USDC' },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
  ],
  '0xa': [
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', symbol: 'USDC.e', decimals: 6, name: 'Bridged USDC' },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
  ],
  '0x2105': [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
    { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', symbol: 'WBTC', decimals: 8, name: 'Wrapped BTC' },
  ],
  '0x38': [
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18, name: 'Tether USD' },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18, name: 'USD Coin' },
    { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH', decimals: 18, name: 'Ethereum Token' },
    { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', symbol: 'BTCB', decimals: 18, name: 'BTCB Token' },
  ],
};

// Tokens are stored per chain: { [chainId]: { [tokenAddress]: {...} } }
const readAll = () => local.get('tokens', {});
const readNfts = () => local.get('nfts', {});
const readApprovals = () => local.get('approvals', []);
const cleanRegistryToken = (token) => ({ ...token, address: token.address.toLowerCase() });
const approvalId = ({ chainId, owner, contract, spender, standard, tokenId = '' }) =>
  [chainId, owner, contract, spender, standard, tokenId].map((part) => String(part ?? '').toLowerCase()).join(':');

export async function searchTokenRegistry(query = '', chainId) {
  const chain = chainId ?? (await getChainId());
  const needle = query.trim().toLowerCase();
  const tokens = (TOKEN_REGISTRY[chain] ?? []).map(cleanRegistryToken);
  if (!needle) return tokens;
  return tokens.filter(
    (token) =>
      token.symbol.toLowerCase().includes(needle) ||
      token.name.toLowerCase().includes(needle) ||
      token.address.toLowerCase().includes(needle)
  );
}

export async function listTokens(chainId, { includeHidden = false } = {}) {
  const chain = chainId ?? (await getChainId());
  const all = await readAll();
  return Object.values(all[chain] ?? {}).filter((token) => includeHidden || !token.hidden);
}

export async function listHiddenTokens(chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readAll();
  return Object.values(all[chain] ?? {}).filter((token) => token.hidden);
}

export async function readTokenMetadata(address, chainId) {
  const provider = await getProvider(chainId);
  const contract = new Contract(getAddress(address), ERC20_ABI, provider);
  const [symbol, decimals, name] = await Promise.all([
    contract.symbol(),
    contract.decimals(),
    contract.name().catch(() => ''),
  ]);
  return { address: getAddress(address), symbol, decimals: Number(decimals), name };
}

export async function addToken(token, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readAll();
  const metadata = token.symbol && token.decimals != null ? token : await readTokenMetadata(token.address, chain);

  all[chain] = { ...(all[chain] ?? {}), [metadata.address.toLowerCase()]: { ...metadata, chainId: chain, hidden: false } };
  await local.set({ tokens: all });
  return metadata;
}

export async function detectTokens(owner, chainId) {
  const chain = chainId ?? (await getChainId());
  if (!owner) return [];

  const registry = await searchTokenRegistry('', chain);
  const current = await listTokens(chain, { includeHidden: true });
  const saved = new Set(current.map((token) => token.address.toLowerCase()));
  const candidates = registry.filter((token) => !saved.has(token.address.toLowerCase()));
  if (!candidates.length) return [];

  const provider = await getProvider(chain);
  const detected = (
    await Promise.all(
    candidates.map(async (token) => {
      try {
        const contract = new Contract(token.address, ERC20_ABI, provider);
        const raw = await contract.balanceOf(owner);
        if (raw <= 0n) return null;
        return { ...token, raw: raw.toString(), balance: formatUnits(raw, token.decimals) };
      } catch {
        /* registry reads are best effort */
        return null;
      }
    })
  )
  ).filter(Boolean);

  for (const token of detected) {
    await addToken(token, chain);
  }

  return detected.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function removeToken(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readAll();
  if (all[chain]) delete all[chain][address.toLowerCase()];
  await local.set({ tokens: all });
}

export async function hideToken(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readAll();
  const key = address.toLowerCase();
  if (!all[chain]?.[key]) throw new Error('Token is not tracked.');
  all[chain][key] = { ...all[chain][key], hidden: true };
  await local.set({ tokens: all });
  return all[chain][key];
}

export async function unhideToken(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readAll();
  const key = address.toLowerCase();
  if (!all[chain]?.[key]) throw new Error('Token is not tracked.');
  all[chain][key] = { ...all[chain][key], hidden: false };
  await local.set({ tokens: all });
  return all[chain][key];
}

export async function lookupNft({ address, tokenId }, owner, chainId) {
  const chain = chainId ?? (await getChainId());
  const contractAddress = getAddress(address);
  const provider = await getProvider(chain);

  const erc721 = new Contract(contractAddress, ERC721_ABI, provider);
  try {
    const [name, symbol, tokenOwner, tokenUri] = await Promise.all([
      erc721.name().catch(() => ''),
      erc721.symbol().catch(() => ''),
      erc721.ownerOf(tokenId),
      erc721.tokenURI(tokenId).catch(() => ''),
    ]);
    return {
      standard: 'ERC721',
      address: contractAddress,
      tokenId: String(tokenId),
      name,
      symbol,
      owner: tokenOwner,
      balance: owner && tokenOwner.toLowerCase() === owner.toLowerCase() ? '1' : '0',
      ...(await readNftMetadata(tokenUri, tokenId)),
    };
  } catch {
    const erc1155 = new Contract(contractAddress, ERC1155_ABI, provider);
    const [rawBalance, tokenUri] = await Promise.all([
      owner ? erc1155.balanceOf(owner, tokenId).catch(() => 0n) : Promise.resolve(0n),
      erc1155.uri(tokenId),
    ]);
    return {
      standard: 'ERC1155',
      address: contractAddress,
      tokenId: String(tokenId),
      name: '',
      symbol: '',
      balance: rawBalance.toString(),
      ...(await readNftMetadata(tokenUri, tokenId)),
    };
  }
}

export async function addNft(nft, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readNfts();
  const metadata = nft.standard ? nft : await lookupNft(nft, null, chain);
  const key = `${metadata.address.toLowerCase()}:${metadata.tokenId}`;
  all[chain] = { ...(all[chain] ?? {}), [key]: { ...metadata, chainId: chain, hidden: false } };
  await local.set({ nfts: all });
  return metadata;
}

export async function removeNft({ address, tokenId }, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readNfts();
  if (all[chain]) delete all[chain][`${address.toLowerCase()}:${String(tokenId)}`];
  await local.set({ nfts: all });
}

export async function hideNft({ address, tokenId }, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readNfts();
  const key = `${address.toLowerCase()}:${String(tokenId)}`;
  if (!all[chain]?.[key]) throw new Error('NFT is not tracked.');
  all[chain][key] = { ...all[chain][key], hidden: true };
  await local.set({ nfts: all });
  return all[chain][key];
}

export async function unhideNft({ address, tokenId }, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readNfts();
  const key = `${address.toLowerCase()}:${String(tokenId)}`;
  if (!all[chain]?.[key]) throw new Error('NFT is not tracked.');
  all[chain][key] = { ...all[chain][key], hidden: false };
  await local.set({ nfts: all });
  return all[chain][key];
}

export async function listHiddenNfts(chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readNfts();
  return Object.values(all[chain] ?? {}).filter((nft) => nft.hidden);
}

export async function nftBalances(owner, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readNfts();
  const saved = Object.values(all[chain] ?? {}).filter((nft) => !nft.hidden);
  if (!saved.length || !owner) return [];

  return Promise.all(
    saved.map(async (nft) => {
      try {
        const current = await lookupNft(nft, owner, chain);
        return { ...nft, ...current };
      } catch (err) {
        return { ...nft, balance: null, error: err.shortMessage ?? err.message };
      }
    })
  );
}

export async function tokenBalances(owner, chainId) {
  const chain = chainId ?? (await getChainId());
  const tokens = await listTokens(chain);
  if (!tokens.length || !owner) return [];

  const provider = await getProvider(chain);
  return Promise.all(
    tokens.map(async (token) => {
      try {
        const contract = new Contract(token.address, ERC20_ABI, provider);
        const raw = await contract.balanceOf(owner);
        return { ...token, raw: raw.toString(), balance: formatUnits(raw, token.decimals) };
      } catch {
        return { ...token, raw: '0', balance: null, error: true };
      }
    })
  );
}

export function encodeTransfer(to, amount, decimals) {
  return erc20Interface.encodeFunctionData('transfer', [getAddress(to), parseUnits(String(amount), decimals)]);
}

export async function recordApprovalFromTransaction({ chainId, owner, contract, data, hash, origin }) {
  const decoded = decodeContractCall(data);
  if (!decoded?.approval || !contract || !owner) return null;

  const approval = {
    id: approvalId({
      chainId,
      owner,
      contract,
      spender: decoded.approval.spender,
      standard: decoded.standard,
      tokenId: decoded.approval.tokenId ?? '',
    }),
    chainId,
    owner: getAddress(owner),
    contract: getAddress(contract),
    spender: getAddress(decoded.approval.spender),
    standard: decoded.standard,
    method: decoded.name,
    amount: decoded.approval.amount ?? null,
    tokenId: decoded.approval.tokenId ?? null,
    approved: decoded.approval.approved,
    unlimited: decoded.approval.unlimited ?? false,
    hash,
    origin,
    updatedAt: Date.now(),
  };

  const all = await readApprovals();
  const next = all.filter((item) => item.id !== approval.id);
  if (approval.approved) next.unshift(approval);
  else next.unshift({ ...approval, revokedAt: Date.now() });
  await local.set({ approvals: next.slice(0, 300) });
  return approval;
}

export async function listApprovals(owner, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readApprovals();
  const matching = all.filter(
    (approval) =>
      approval.chainId === chain &&
      approval.owner?.toLowerCase() === owner?.toLowerCase() &&
      approval.approved &&
      !approval.revokedAt
  );

  return Promise.all(
    matching.map(async (approval) => {
      try {
        return await withLiveApprovalStatus(approval);
      } catch {
        return { ...approval, live: 'unknown' };
      }
    })
  ).then((items) => items.filter((approval) => approval.live !== 'revoked'));
}

export async function getApproval(id) {
  const all = await readApprovals();
  const approval = all.find((item) => item.id === id);
  if (!approval) throw new Error('Approval not found.');
  return approval;
}

export function encodeApprovalRevoke(approval) {
  if (approval.standard === 'ERC20') return erc20Interface.encodeFunctionData('approve', [approval.spender, 0]);
  if (approval.method === 'approve') return erc721Interface.encodeFunctionData('approve', [ZeroAddress, approval.tokenId]);
  return erc721Interface.encodeFunctionData('setApprovalForAll', [approval.spender, false]);
}

export async function markApprovalRevoked(id, hash = null) {
  const all = await readApprovals();
  await local.set({
    approvals: all.map((approval) =>
      approval.id === id ? { ...approval, approved: false, revokedAt: Date.now(), revokeHash: hash } : approval
    ),
  });
}

/**
 * Best-effort decoding so the confirmation screen can say "Transfer 25 USDC"
 * instead of showing a wall of calldata.
 */
export function decodeErc20Call(data) {
  if (!data || data === '0x') return null;
  try {
    const parsed = erc20Interface.parseTransaction({ data });
    if (!parsed) return null;
    return { name: parsed.name, args: parsed.args.map((a) => a.toString()) };
  } catch {
    return null;
  }
}

export function decodeContractCall(data) {
  if (!data || data === '0x') return null;
  for (const [standard, iface] of [
    ['ERC20', erc20Interface],
    ['ERC721', erc721Interface],
    ['ERC1155', erc1155Interface],
  ]) {
    try {
      const parsed = iface.parseTransaction({ data });
      if (!parsed) continue;
      const args = parsed.args.map((arg) => formatArg(arg));
      return {
        standard,
        name: parsed.name,
        signature: parsed.signature,
        args,
        label: methodLabel(standard, parsed.name, args),
        approval: approvalFromParsed(standard, parsed.name, args),
      };
    } catch {
      /* try the next interface */
    }
  }
  return null;
}

function approvalFromParsed(standard, name, args) {
  if (standard === 'ERC20' && name === 'approve') {
    const amount = args[1];
    return {
      spender: args[0],
      amount,
      approved: BigInt(amount) > 0n,
      unlimited: BigInt(amount) >= 2n ** 255n,
    };
  }
  if (standard === 'ERC721' && name === 'approve') {
    return {
      spender: args[0],
      tokenId: args[1],
      approved: args[0].toLowerCase() !== ZeroAddress.toLowerCase(),
    };
  }
  if ((standard === 'ERC721' || standard === 'ERC1155') && name === 'setApprovalForAll') {
    return { spender: args[0], approved: args[1] === true || args[1] === 'true', operator: true };
  }
  return null;
}

function methodLabel(standard, name, args) {
  const labels = {
    transfer: 'Token transfer',
    approve: standard === 'ERC20' ? 'Token approval' : 'NFT approval',
    transferFrom: standard === 'ERC721' ? 'NFT transfer' : 'Token transfer',
    safeTransferFrom: standard === 'ERC1155' ? 'NFT transfer' : 'NFT transfer',
    safeBatchTransferFrom: 'NFT batch transfer',
    setApprovalForAll: 'NFT operator approval',
  };
  if (name === 'approve' && standard === 'ERC20' && BigInt(args[1]) === 0n) return 'Revoke token approval';
  if (name === 'setApprovalForAll' && (args[1] === false || args[1] === 'false')) return 'Revoke NFT operator';
  return labels[name] ?? name;
}

function formatArg(arg) {
  if (Array.isArray(arg)) return arg.map(formatArg);
  if (typeof arg === 'bigint') return arg.toString();
  return arg?.toString?.() ?? arg;
}

async function withLiveApprovalStatus(approval) {
  const provider = await getProvider(approval.chainId);
  if (approval.standard === 'ERC20') {
    const contract = new Contract(approval.contract, ERC20_ABI, provider);
    const [raw, symbol, decimals] = await Promise.all([
      contract.allowance(approval.owner, approval.spender),
      contract.symbol().catch(() => ''),
      contract.decimals().catch(() => 18),
    ]);
    if (raw === 0n) return { ...approval, live: 'revoked' };
    return {
      ...approval,
      live: 'active',
      amount: raw.toString(),
      symbol,
      decimals: Number(decimals),
      displayAmount: formatUnits(raw, Number(decimals)),
    };
  }

  if (approval.method === 'approve') {
    const contract = new Contract(approval.contract, ERC721_ABI, provider);
    const [spender, name] = await Promise.all([
      contract.getApproved(approval.tokenId),
      contract.name().catch(() => ''),
    ]);
    if (spender.toLowerCase() !== approval.spender.toLowerCase()) return { ...approval, live: 'revoked' };
    return { ...approval, live: 'active', name };
  }

  const contract = new Contract(approval.contract, ERC721_ABI, provider);
  const [active, name] = await Promise.all([
    contract.isApprovedForAll(approval.owner, approval.spender),
    contract.name().catch(() => ''),
  ]);
  return active ? { ...approval, live: 'active', name } : { ...approval, live: 'revoked' };
}

async function readNftMetadata(uri, tokenId) {
  const url = normaliseMetadataUrl(uri, tokenId);
  if (!url) return { tokenUri: uri || '' };
  try {
    const response = await fetch(url);
    const json = await response.json();
    return {
      tokenUri: uri || '',
      metadataUrl: url,
      title: json.name ?? '',
      description: json.description ?? '',
      image: normaliseAssetUrl(json.image ?? json.image_url ?? ''),
    };
  } catch {
    return { tokenUri: uri || '', metadataUrl: url };
  }
}

function normaliseMetadataUrl(uri, tokenId) {
  if (!uri) return '';
  const filled = uri.replaceAll('{id}', BigInt(tokenId).toString(16).padStart(64, '0'));
  return normaliseAssetUrl(filled);
}

function normaliseAssetUrl(uri) {
  if (!uri) return '';
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return '';
}
