import { Contract, Interface, ZeroAddress, getAddress, formatUnits, parseUnits } from 'ethers';
import { local } from './storage.js';
import { getProvider, getChainId } from './networks.js';
import { decodeKnownCall, selectorOf } from './selectors.js';

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

export const ERC165_ABI = ['function supportsInterface(bytes4 interfaceId) view returns (bool)'];

// EIP-165 interface identifiers.
const IFACE_ERC721 = '0x80ac58cd';
const IFACE_ERC1155 = '0xd9b67a26';
const IFACE_ERC721_METADATA = '0x5b5e139f';

/**
 * Asks the contract what it is via EIP-165 rather than inferring the standard
 * from whether ownerOf happens to throw. A burned or non-existent ERC-721 token
 * makes ownerOf revert, which the old approach misread as "this is an ERC-1155".
 */
export async function detectNftStandard(contractAddress, provider) {
  const probe = new Contract(contractAddress, ERC165_ABI, provider);
  const [is721, is1155] = await Promise.all([
    probe.supportsInterface(IFACE_ERC721).catch(() => null),
    probe.supportsInterface(IFACE_ERC1155).catch(() => null),
  ]);

  if (is721 === true) return { standard: 'ERC721', declared: true };
  if (is1155 === true) return { standard: 'ERC1155', declared: true };
  // Some older collections predate EIP-165 or answer it incorrectly, so fall
  // back to probing behaviour rather than refusing to track them.
  return { standard: null, declared: false };
}

export async function lookupNft({ address, tokenId }, owner, chainId) {
  const chain = chainId ?? (await getChainId());
  const contractAddress = getAddress(address);
  const provider = await getProvider(chain);

  const { standard, declared } = await detectNftStandard(contractAddress, provider);

  const readErc721 = async () => {
    const erc721 = new Contract(contractAddress, ERC721_ABI, provider);
    const [name, symbol, tokenOwner, tokenUri] = await Promise.all([
      erc721.name().catch(() => ''),
      erc721.symbol().catch(() => ''),
      erc721.ownerOf(tokenId),
      erc721.tokenURI(tokenId).catch(() => ''),
    ]);
    return {
      standard: 'ERC721',
      declaredStandard: declared,
      address: contractAddress,
      tokenId: String(tokenId),
      name,
      symbol,
      owner: tokenOwner,
      balance: owner && tokenOwner.toLowerCase() === owner.toLowerCase() ? '1' : '0',
      ...(await readNftMetadata(tokenUri, tokenId)),
    };
  };

  const readErc1155 = async () => {
    const erc1155 = new Contract(contractAddress, ERC1155_ABI, provider);
    const [rawBalance, tokenUri] = await Promise.all([
      owner ? erc1155.balanceOf(owner, tokenId).catch(() => 0n) : Promise.resolve(0n),
      erc1155.uri(tokenId),
    ]);
    return {
      standard: 'ERC1155',
      declaredStandard: declared,
      address: contractAddress,
      tokenId: String(tokenId),
      name: '',
      symbol: '',
      balance: rawBalance.toString(),
      ...(await readNftMetadata(tokenUri, tokenId)),
    };
  };

  if (standard === 'ERC721') return readErc721();
  if (standard === 'ERC1155') return readErc1155();

  try {
    return await readErc721();
  } catch {
    return readErc1155();
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

/**
 * Calldata for moving an NFT.
 *
 * safeTransferFrom is used rather than transferFrom because it calls
 * onERC721Received on a contract recipient — a contract that cannot handle NFTs
 * rejects the transfer instead of swallowing the token forever. That check is
 * the entire reason the "safe" variant exists, and skipping it is how NFTs get
 * permanently stranded in contracts.
 */
export function encodeNftTransfer({ standard, from, to, tokenId, amount = 1 }) {
  const sender = getAddress(from);
  const recipient = getAddress(to);
  const id = BigInt(tokenId);

  if (standard === 'ERC1155') {
    const quantity = BigInt(amount);
    if (quantity <= 0n) throw new Error('Enter a quantity of at least 1.');
    return erc1155Interface.encodeFunctionData('safeTransferFrom', [sender, recipient, id, quantity, '0x']);
  }

  return erc721Interface.encodeFunctionData('safeTransferFrom(address,address,uint256)', [sender, recipient, id]);
}

/**
 * Confirms the account can actually move this token before a transaction is
 * built. Ownership can have changed since the list was last refreshed, and a
 * transfer of a token you no longer hold reverts after costing gas.
 */
export async function checkNftTransferable({ address, tokenId, standard, owner, amount = 1 }, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const contractAddress = getAddress(address);

  if (standard === 'ERC1155') {
    const contract = new Contract(contractAddress, ERC1155_ABI, provider);
    const balance = await contract.balanceOf(owner, tokenId).catch(() => null);
    if (balance == null) throw new Error('Could not read your balance for this token.');
    if (balance <= 0n) throw new Error('This account does not hold that token any more.');
    if (BigInt(amount) > balance) {
      throw new Error(`You hold ${balance.toString()} of this token, not ${amount}.`);
    }
    return { ok: true, balance: balance.toString() };
  }

  const contract = new Contract(contractAddress, ERC721_ABI, provider);
  const currentOwner = await contract.ownerOf(tokenId).catch(() => null);
  if (!currentOwner) throw new Error('Could not read the owner of that token. It may have been burned.');
  if (currentOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`That token is now owned by ${currentOwner.slice(0, 10)}…, not this account.`);
  }
  return { ok: true, owner: currentOwner, balance: '1' };
}

/**
 * Whether a recipient contract can receive NFTs. Sending an ERC-721 to a
 * contract that does not implement the receiver hook is the classic way to lose
 * one permanently, so the send screen warns before it happens.
 */
export async function checkNftRecipient(to, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const recipient = getAddress(to);

  const code = await provider.getCode(recipient).catch(() => null);
  if (code == null) return { isContract: null, canReceive: null };
  if (code === '0x') return { isContract: false, canReceive: true };

  // ERC721Receiver = 0x150b7a02, ERC1155Receiver = 0x4e2312e0
  const probe = new Contract(recipient, ERC165_ABI, provider);
  const [erc721, erc1155] = await Promise.all([
    probe.supportsInterface('0x150b7a02').catch(() => null),
    probe.supportsInterface('0x4e2312e0').catch(() => null),
  ]);

  return {
    isContract: true,
    // A contract that does not answer EIP-165 might still implement the hook,
    // so an unknown answer is reported as unknown rather than as a refusal.
    canReceive: erc721 === true || erc1155 === true ? true : erc721 === false && erc1155 === false ? false : null,
  };
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

/**
 * Identifies a contract call. Token standards are tried first because they
 * carry approval semantics the confirmation screen needs; the wider selector
 * registry covers swaps, permits, batches, and ownership calls.
 *
 * An unrecognised call still returns an object carrying the raw selector, so
 * the UI can show "unknown method 0x1234abcd" — something the user can look up
 * — instead of an anonymous "Contract interaction".
 */
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
        selector: selectorOf(data),
        args,
        namedArgs: parsed.fragment.inputs.map((input, index) => ({
          name: input.name || `arg${index}`,
          type: input.type,
          value: args[index],
        })),
        label: methodLabel(standard, parsed.name, args),
        approval: approvalFromParsed(standard, parsed.name, args),
        known: true,
      };
    } catch {
      /* try the next interface */
    }
  }

  const known = decodeKnownCall(data);
  if (known) {
    return {
      standard: known.group,
      name: known.name,
      signature: known.signature,
      selector: known.selector,
      args: known.args.map((arg) => arg.value),
      namedArgs: known.args,
      label: known.label,
      risk: known.risk,
      approval: null,
      known: true,
    };
  }

  return {
    standard: null,
    name: null,
    signature: null,
    selector: selectorOf(data),
    args: [],
    namedArgs: [],
    label: 'Unrecognised contract call',
    approval: null,
    known: false,
  };
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

const METADATA_TIMEOUT = 8000;
const MAX_METADATA_BYTES = 512 * 1024;

/**
 * Reads token metadata. Third-party JSON is untrusted input, so the fetch is
 * bounded by a timeout and a size cap, and only known fields are kept — the
 * rest of the document is discarded rather than stored and rendered.
 */
async function readNftMetadata(uri, tokenId) {
  const url = normaliseMetadataUrl(uri, tokenId);
  if (!url) return { tokenUri: uri || '' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { tokenUri: uri || '', metadataUrl: url };

    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_METADATA_BYTES) return { tokenUri: uri || '', metadataUrl: url };

    const text = (await response.text()).slice(0, MAX_METADATA_BYTES);
    const json = JSON.parse(text);

    return {
      tokenUri: uri || '',
      metadataUrl: url,
      title: clampText(json.name, 120),
      description: clampText(json.description, 600),
      image: normaliseAssetUrl(json.image ?? json.image_url ?? json.image_data ?? ''),
      animationUrl: normaliseAssetUrl(json.animation_url ?? ''),
      externalUrl: normaliseAssetUrl(json.external_url ?? ''),
      traits: normaliseTraits(json.attributes ?? json.traits),
    };
  } catch {
    return { tokenUri: uri || '', metadataUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

function clampText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Accepts both the array-of-objects and plain-object trait conventions. */
function normaliseTraits(attributes) {
  if (!attributes) return [];

  const rows = Array.isArray(attributes)
    ? attributes.map((entry) => ({
        type: clampText(entry?.trait_type ?? entry?.traitType ?? entry?.key ?? '', 40),
        value: clampText(String(entry?.value ?? ''), 60),
      }))
    : Object.entries(attributes).map(([type, value]) => ({
        type: clampText(type, 40),
        value: clampText(String(value ?? ''), 60),
      }));

  return rows.filter((row) => row.type || row.value).slice(0, 24);
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
