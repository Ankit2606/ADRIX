// A 4-byte selector registry for the calls a wallet actually meets in the wild.
//
// The token interfaces in tokens.js cover ERC-20/721/1155, which is a small
// slice of what a user signs. Everything else previously rendered as "Contract
// interaction" plus a wall of hex. This maps the common selectors to a readable
// name so the confirmation screen can say what is about to happen.
//
// Entries are grouped by protocol and each carries a `risk` note where the call
// is worth flagging. Nothing here is authoritative — an unknown selector is
// reported as unknown rather than guessed at.

import { Interface } from 'ethers';

const SIGNATURES = [
  // --- wrapped native ------------------------------------------------------
  { sig: 'function deposit() payable', label: 'Wrap native token', group: 'WETH' },
  { sig: 'function withdraw(uint256 wad)', label: 'Unwrap to native token', group: 'WETH' },

  // --- EIP-2612 / DAI permit ----------------------------------------------
  {
    sig: 'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
    label: 'Gasless approval (permit)',
    group: 'EIP-2612',
    risk: 'This grants spending permission without a separate approval transaction.',
  },
  {
    sig: 'function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s)',
    label: 'Gasless approval (DAI permit)',
    group: 'DAI',
    risk: 'This grants spending permission without a separate approval transaction.',
  },

  // --- Uniswap V2 style routers -------------------------------------------
  { sig: 'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)', label: 'Swap tokens', group: 'Uniswap V2' },
  { sig: 'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)', label: 'Swap tokens', group: 'Uniswap V2' },
  { sig: 'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable', label: 'Swap native for tokens', group: 'Uniswap V2' },
  { sig: 'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)', label: 'Swap tokens for native', group: 'Uniswap V2' },
  { sig: 'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)', label: 'Add liquidity', group: 'Uniswap V2' },
  { sig: 'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)', label: 'Remove liquidity', group: 'Uniswap V2' },

  // --- Uniswap V3 ----------------------------------------------------------
  { sig: 'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', label: 'Swap tokens', group: 'Uniswap V3' },
  { sig: 'function exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', label: 'Swap tokens', group: 'Uniswap V3' },
  { sig: 'function exactInput((bytes,address,uint256,uint256,uint256))', label: 'Swap tokens (multi-hop)', group: 'Uniswap V3' },
  { sig: 'function exactOutput((bytes,address,uint256,uint256,uint256))', label: 'Swap tokens (multi-hop)', group: 'Uniswap V3' },
  { sig: 'function multicall(bytes[] data)', label: 'Batched calls', group: 'Multicall', risk: 'Several actions are bundled into one transaction. ADRIX cannot show what each one does.' },
  { sig: 'function multicall(uint256 deadline, bytes[] data)', label: 'Batched calls', group: 'Multicall', risk: 'Several actions are bundled into one transaction. ADRIX cannot show what each one does.' },

  // --- Uniswap Universal Router / Permit2 ----------------------------------
  { sig: 'function execute(bytes commands, bytes[] inputs, uint256 deadline)', label: 'Router commands', group: 'Universal Router', risk: 'This is an encoded command batch. Its individual actions are not decodable here.' },
  { sig: 'function execute(bytes commands, bytes[] inputs)', label: 'Router commands', group: 'Universal Router', risk: 'This is an encoded command batch. Its individual actions are not decodable here.' },
  {
    sig: 'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    label: 'Permit2 approval',
    group: 'Permit2',
    risk: 'Permit2 approvals are separate from the token allowance and carry their own expiry.',
  },

  // --- staking / lending ---------------------------------------------------
  { sig: 'function stake(uint256 amount)', label: 'Stake', group: 'Staking' },
  { sig: 'function unstake(uint256 amount)', label: 'Unstake', group: 'Staking' },
  { sig: 'function claim()', label: 'Claim rewards', group: 'Staking' },
  { sig: 'function claimRewards()', label: 'Claim rewards', group: 'Staking' },
  { sig: 'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)', label: 'Supply to lending pool', group: 'Aave' },
  { sig: 'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)', label: 'Borrow', group: 'Aave' },
  { sig: 'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)', label: 'Repay loan', group: 'Aave' },
  { sig: 'function mint(uint256 mintAmount)', label: 'Mint', group: 'Compound' },
  { sig: 'function redeem(uint256 redeemTokens)', label: 'Redeem', group: 'Compound' },

  // --- NFT marketplaces ----------------------------------------------------
  { sig: 'function fulfillBasicOrder((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes)) payable', label: 'Buy NFT', group: 'Seaport' },
  { sig: 'function fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32)', label: 'Buy NFT', group: 'Seaport' },
  { sig: 'function mint(address to, uint256 quantity)', label: 'Mint NFT', group: 'NFT' },
  { sig: 'function mint(uint256 quantity) payable', label: 'Mint NFT', group: 'NFT' },
  { sig: 'function safeMint(address to)', label: 'Mint NFT', group: 'NFT' },

  // --- smart accounts / multisig -------------------------------------------
  {
    sig: 'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
    label: 'Execute Safe transaction',
    group: 'Safe',
  },
  { sig: 'function execute(address to, uint256 value, bytes data)', label: 'Execute call', group: 'Smart account' },
  { sig: 'function executeBatch(address[] to, uint256[] value, bytes[] data)', label: 'Execute batched calls', group: 'Smart account' },

  // --- ownership: rare, and always worth flagging loudly -------------------
  {
    sig: 'function transferOwnership(address newOwner)',
    label: 'Transfer contract ownership',
    group: 'Ownable',
    risk: 'This hands control of a contract to another address. It is almost never something a normal dApp needs.',
  },
  {
    sig: 'function renounceOwnership()',
    label: 'Renounce contract ownership',
    group: 'Ownable',
    risk: 'This permanently gives up control of a contract.',
  },
  { sig: 'function upgradeTo(address newImplementation)', label: 'Upgrade proxy implementation', group: 'Proxy', risk: 'This replaces the code behind a proxy contract.' },

  // --- ENS -----------------------------------------------------------------
  { sig: 'function setName(string name)', label: 'Set ENS reverse record', group: 'ENS' },
  { sig: 'function setAddr(bytes32 node, address a)', label: 'Set ENS address record', group: 'ENS' },
];

/** selector -> { iface, fragment, label, group, risk } */
const REGISTRY = new Map();

for (const entry of SIGNATURES) {
  try {
    const iface = new Interface([entry.sig]);
    const fragment = iface.fragments[0];
    const selector = iface.getFunction(fragment.name, fragment.inputs.map((i) => i.type))?.selector;
    if (!selector) continue;
    // First registration wins, so overloads listed earlier stay authoritative.
    if (!REGISTRY.has(selector)) {
      REGISTRY.set(selector, { iface, fragment, label: entry.label, group: entry.group, risk: entry.risk ?? null });
    }
  } catch {
    /* a malformed signature must not take the whole registry down */
  }
}

export const selectorOf = (data) =>
  typeof data === 'string' && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;

/**
 * Decodes a call against the registry. Returns null when the selector is
 * unknown — callers should surface the raw selector rather than inventing a
 * description for calldata nobody recognises.
 */
export function decodeKnownCall(data) {
  const selector = selectorOf(data);
  if (!selector) return null;

  const entry = REGISTRY.get(selector);
  if (!entry) return null;

  let args = [];
  try {
    const decoded = entry.iface.decodeFunctionData(entry.fragment, data);
    args = entry.fragment.inputs.map((input, index) => ({
      name: input.name || `arg${index}`,
      type: input.type,
      value: formatValue(decoded[index]),
    }));
  } catch {
    // A selector match with undecodable body still tells the user more than
    // nothing; the name is reported without arguments.
    args = [];
  }

  return {
    selector,
    name: entry.fragment.name,
    signature: entry.fragment.format('sighash'),
    label: entry.label,
    group: entry.group,
    risk: entry.risk,
    args,
    known: true,
  };
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue);
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && typeof value.toString === 'function') return value.toString();
  return value;
}

export const registrySize = () => REGISTRY.size;
