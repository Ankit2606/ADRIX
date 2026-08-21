// Staking and DeFi position tracking.
//
// No indexer, so positions are read directly from the contracts that hold them.
// That constrains what is possible and shapes the approach: rather than trying
// to enumerate everything an address touches — which needs an archive index —
// this recognises position *types* and reads them where it is told to look.
//
// The generic case is ERC-4626. One standard interface covers a large share of
// yield vaults, and `convertToAssets(balanceOf(you))` answers "what is this
// worth" without knowing anything about the protocol. Where a protocol predates
// or ignores the standard, it needs its own adapter, and only a handful are
// worth hand-writing: liquid staking, Aave, and Uniswap V3 liquidity.
//
// Staking is deliberately a *direct* deposit rather than a swap. Buying stETH
// on a DEX and staking with Lido produce the same token at different prices —
// the DEX route carries slippage and a spread, the deposit does not.

import { Contract, formatEther, formatUnits, getAddress } from 'ethers';
import { local } from './storage.js';
import { getProvider, getChainId, getNetwork } from './networks.js';
import { sendTransaction } from './transactions.js';

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
];

const ERC4626 = [
  ...ERC20,
  'function asset() view returns (address)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
];

const LIDO = [
  'function submit(address _referral) payable returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function getTotalPooledEther() view returns (uint256)',
  'function getTotalShares() view returns (uint256)',
];

const ROCKET_POOL = [
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
  'function getExchangeRate() view returns (uint256)',
];

const UNIV3_POSITIONS = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

// ---------------------------------------------------------------------------
// Staking venues
//
// Only protocols whose deposit path is a single well-known call. Anything
// needing a router, a quote, or an approval dance belongs in the swap flow,
// where slippage is already handled honestly.
// ---------------------------------------------------------------------------
export const STAKING_VENUES = {
  '0x1': [
    {
      id: 'lido',
      name: 'Lido',
      token: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
      symbol: 'stETH',
      kind: 'rebasing',
      abi: LIDO,
      deposit: 'submit',
      hint: 'Balance rebases daily — the stETH number itself grows.',
      withdrawal: 'Withdrawals go through Lido\'s queue and typically take one to five days.',
    },
    {
      id: 'rocketpool',
      name: 'Rocket Pool',
      token: '0xae78736Cd615f374D3085123A210448E74Fc6393',
      depositPool: '0xDD3f50F8A6CafbE9b31a427582963f465E745AF8',
      symbol: 'rETH',
      kind: 'appreciating',
      abi: ROCKET_POOL,
      deposit: 'deposit',
      hint: 'The rETH amount stays fixed; its value against ETH rises.',
      withdrawal: 'rETH can be burned for ETH when the deposit pool has liquidity, or sold on a DEX.',
    },
  ],
};

/** Live rate and position for each venue on this chain. */
export async function listStakingVenues(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const venues = STAKING_VENUES[chain] ?? [];
  if (!venues.length) return { chainId: chain, venues: [], supported: false };

  const provider = await getProvider(chain);

  const rows = await Promise.all(
    venues.map(async (venue) => {
      try {
        const token = new Contract(venue.token, venue.abi, provider);
        const balance = address ? await token.balanceOf(address).catch(() => 0n) : 0n;

        let rate = null;
        if (venue.id === 'rocketpool') {
          const raw = await token.getExchangeRate().catch(() => null);
          if (raw != null) rate = Number(formatEther(raw));
        } else if (venue.id === 'lido') {
          // stETH rebases, so one stETH is one ETH by construction; the yield
          // shows up as the balance itself growing.
          rate = 1;
        }

        return {
          ...venue,
          abi: undefined,
          balanceRaw: balance.toString(),
          balance: formatEther(balance),
          // What the position is worth in the underlying, which is the number
          // that differs between a rebasing and an appreciating token.
          underlying: rate != null ? formatEther((balance * BigInt(Math.round(rate * 1e18))) / 10n ** 18n) : null,
          rate,
          staked: balance > 0n,
        };
      } catch (err) {
        return { ...venue, abi: undefined, error: err.shortMessage ?? err.message };
      }
    })
  );

  return { chainId: chain, venues: rows, supported: true };
}

/** Deposits native ETH into a staking venue. */
export async function stake({ venueId, amountWei, from, chainId, fees, gas }) {
  const chain = chainId ?? (await getChainId());
  const venue = (STAKING_VENUES[chain] ?? []).find((entry) => entry.id === venueId);
  if (!venue) throw new Error('That staking venue is not available on this network.');
  if (!amountWei || BigInt(amountWei) <= 0n) throw new Error('Enter an amount above zero.');

  const provider = await getProvider(chain);
  // Rocket Pool takes deposits through a separate pool contract; Lido's token
  // is the deposit target itself.
  const target = venue.depositPool ?? venue.token;
  const contract = new Contract(target, venue.abi, provider);

  const data =
    venue.deposit === 'submit'
      ? contract.interface.encodeFunctionData('submit', ['0x0000000000000000000000000000000000000000'])
      : contract.interface.encodeFunctionData('deposit', []);

  const hash = await sendTransaction({
    from,
    to: target,
    value: `0x${BigInt(amountWei).toString(16)}`,
    data,
    fees,
    gas,
    chainId: chain,
    meta: { kind: 'stake', venue: venue.name, stakeSymbol: venue.symbol },
  });

  return { hash, venue: venue.name, symbol: venue.symbol };
}

/** Prices a deposit before it is signed, including what comes back. */
export async function quoteStake({ venueId, amountWei, from, chainId }) {
  const chain = chainId ?? (await getChainId());
  const venue = (STAKING_VENUES[chain] ?? []).find((entry) => entry.id === venueId);
  if (!venue) throw new Error('That staking venue is not available on this network.');

  const provider = await getProvider(chain);
  const target = venue.depositPool ?? venue.token;
  const contract = new Contract(target, venue.abi, provider);

  const data =
    venue.deposit === 'submit'
      ? contract.interface.encodeFunctionData('submit', ['0x0000000000000000000000000000000000000000'])
      : contract.interface.encodeFunctionData('deposit', []);

  let receives = null;
  if (venue.id === 'rocketpool') {
    const token = new Contract(venue.token, ROCKET_POOL, provider);
    const rate = await token.getExchangeRate().catch(() => null);
    // rETH is worth more than ETH, so a deposit returns fewer units than it put
    // in — the opposite of what people expect, and worth showing explicitly.
    if (rate && rate > 0n) receives = formatEther((BigInt(amountWei) * 10n ** 18n) / rate);
  } else {
    receives = formatEther(BigInt(amountWei));
  }

  return {
    venue: { ...venue, abi: undefined },
    target,
    data,
    amountWei: String(amountWei),
    receives,
    receivesSymbol: venue.symbol,
    withdrawal: venue.withdrawal,
  };
}

// ---------------------------------------------------------------------------
// Position tracking
// ---------------------------------------------------------------------------
const readPositions = () => local.get('defiPositions', {});

/**
 * Works out what kind of position lives at an address.
 *
 * ERC-4626 is checked first because it is the only one that is a real standard:
 * an `asset()` plus `convertToAssets()` pair identifies a vault without knowing
 * the protocol, which is what makes this generalise past a hardcoded list.
 */
export async function identifyPosition(address, owner, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const target = getAddress(address);

  const code = await provider.getCode(target).catch(() => '0x');
  if (!code || code === '0x') throw new Error('There is no contract at that address.');

  // --- ERC-4626 vault -------------------------------------------------------
  const vault = new Contract(target, ERC4626, provider);
  const [asset, shares] = await Promise.all([
    vault.asset().catch(() => null),
    owner ? vault.balanceOf(owner).catch(() => null) : Promise.resolve(null),
  ]);

  if (asset) {
    const [assets, symbol, decimals, name] = await Promise.all([
      shares != null ? vault.convertToAssets(shares).catch(() => null) : Promise.resolve(null),
      vault.symbol().catch(() => ''),
      vault.decimals().catch(() => 18),
      vault.name().catch(() => ''),
    ]);

    const underlying = new Contract(asset, ERC20, provider);
    const [assetSymbol, assetDecimals] = await Promise.all([
      underlying.symbol().catch(() => ''),
      underlying.decimals().catch(() => 18),
    ]);

    return {
      type: 'erc4626',
      typeLabel: 'Yield vault',
      address: target,
      chainId: chain,
      name,
      symbol,
      decimals: Number(decimals),
      shares: shares != null ? formatUnits(shares, Number(decimals)) : null,
      sharesRaw: shares != null ? shares.toString() : null,
      asset: getAddress(asset),
      assetSymbol,
      // The point of the standard: the position's worth in the underlying,
      // which is what has actually grown.
      value: assets != null ? formatUnits(assets, Number(assetDecimals)) : null,
      valueSymbol: assetSymbol,
    };
  }

  // --- Uniswap V3 liquidity -------------------------------------------------
  const univ3 = new Contract(target, UNIV3_POSITIONS, provider);
  const nftCount = owner ? await univ3.balanceOf(owner).catch(() => null) : null;
  if (nftCount != null) {
    const probe = await univ3.positions(1).catch(() => null);
    if (probe) {
      return {
        type: 'univ3',
        typeLabel: 'Uniswap V3 liquidity',
        address: target,
        chainId: chain,
        positionCount: Number(nftCount),
      };
    }
  }

  // --- plain token ----------------------------------------------------------
  const token = new Contract(target, ERC20, provider);
  const [symbol, decimals, balance] = await Promise.all([
    token.symbol().catch(() => null),
    token.decimals().catch(() => null),
    owner ? token.balanceOf(owner).catch(() => null) : Promise.resolve(null),
  ]);

  if (symbol != null && decimals != null) {
    return {
      type: 'token',
      typeLabel: 'Token balance',
      address: target,
      chainId: chain,
      symbol,
      decimals: Number(decimals),
      value: balance != null ? formatUnits(balance, Number(decimals)) : null,
      valueSymbol: symbol,
      // Worth stating: this is not a DeFi position, it is a token, and the
      // Tokens tab already tracks those.
      note: 'This looks like an ordinary token rather than a position contract.',
    };
  }

  throw new Error('ADRIX does not recognise what kind of position that contract holds.');
}

export async function trackPosition({ address, chainId, label }) {
  const chain = chainId ?? (await getChainId());
  const positions = await readPositions();
  const key = `${chain}:${getAddress(address).toLowerCase()}`;
  positions[key] = { address: getAddress(address), chainId: chain, label: String(label ?? '').slice(0, 40), addedAt: Date.now() };
  await local.set({ defiPositions: positions });
  return { ok: true };
}

export async function untrackPosition({ address, chainId }) {
  const chain = chainId ?? (await getChainId());
  const positions = await readPositions();
  delete positions[`${chain}:${getAddress(address).toLowerCase()}`];
  await local.set({ defiPositions: positions });
  return { ok: true };
}

/**
 * Reads every tracked position for one account on one chain.
 *
 * Scoped to the selected chain: each position is several contract reads, and
 * fanning across every network would repeat the cost that made the
 * all-accounts portfolio slow.
 */
export async function listPositions(owner, chainId) {
  const chain = chainId ?? (await getChainId());
  const positions = await readPositions();
  const mine = Object.values(positions).filter((entry) => entry.chainId === chain);
  const network = await getNetwork(chain);

  const rows = await Promise.all(
    mine.map(async (entry) => {
      try {
        const detail = await identifyPosition(entry.address, owner, chain);
        return { ...entry, ...detail, ok: true };
      } catch (err) {
        return { ...entry, ok: false, error: err.shortMessage ?? err.message };
      }
    })
  );

  // Staking positions are read from the venue registry rather than needing to
  // be added by hand — the user already holds them if they staked here.
  const staking = await listStakingVenues(owner, chain).catch(() => ({ venues: [] }));
  const staked = (staking.venues ?? [])
    .filter((venue) => venue.staked)
    .map((venue) => ({
      type: 'staking',
      typeLabel: `${venue.name} staking`,
      address: venue.token,
      chainId: chain,
      symbol: venue.symbol,
      value: venue.balance,
      valueSymbol: venue.symbol,
      underlying: venue.underlying,
      kind: venue.kind,
      ok: true,
      automatic: true,
    }));

  return {
    chainId: chain,
    network: network.name,
    positions: [...staked, ...rows],
    tracked: rows.length,
  };
}
