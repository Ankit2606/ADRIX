import { Contract, formatEther, formatUnits, getAddress, isAddress, parseEther } from 'ethers';
import { local } from './storage.js';
import { getProvider, getNetwork, getChainId } from './networks.js';
import { getWallet, listAccounts } from './keyring.js';
import * as contacts from './contacts.js';
import * as poisoning from './poisoning.js';
import {
  ERC20_ABI,
  ERC721_ABI,
  ERC165_ABI,
  listTokens,
  decodeContractCall,
  encodeApprovalRevoke,
  getApproval,
  markApprovalRevoked,
  recordApprovalFromTransaction,
} from './tokens.js';

// ---------------------------------------------------------------------------
// Fee history
//
// eth_feeHistory gives the last N blocks of base fees, how full each block was,
// and the priority fees actually paid at chosen percentiles. That is enough to
// stop guessing at two things the old code hardcoded: what a preset should bid,
// and how long that bid will take to land.
// ---------------------------------------------------------------------------
const FEE_HISTORY_BLOCKS = 20;
const REWARD_PERCENTILES = [10, 50, 90];
const FEE_HISTORY_TTL_MS = 12_000;
const BLOCK_TIME_TTL_MS = 5 * 60_000;

const feeHistoryCache = new Map(); // chainId -> { at, data }
const blockTimeCache = new Map(); // chainId -> { at, seconds }

// Per-chain fallbacks, used only when the block times cannot be measured.
const FALLBACK_BLOCK_TIME = {
  '0x1': 12,
  '0xaa36a7': 12,
  '0x89': 2.1,
  '0xa4b1': 0.26,
  '0xa': 2,
  '0x2105': 2,
  '0x38': 3,
};

const minBig = (a, b) => (a < b ? a : b);
const maxBig = (a, b) => (a > b ? a : b);

function medianBig(values) {
  if (!values.length) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Average seconds per block, measured rather than assumed. Chains differ by two
 * orders of magnitude here, so a shared constant would make every time estimate
 * wrong somewhere.
 */
async function getBlockTimeSeconds(chainId, provider, headNumber, oldestNumber) {
  const cached = blockTimeCache.get(chainId);
  if (cached && Date.now() - cached.at < BLOCK_TIME_TTL_MS) return cached.seconds;

  const span = headNumber - oldestNumber;
  if (span > 0) {
    const [head, oldest] = await Promise.all([
      provider.getBlock(headNumber).catch(() => null),
      provider.getBlock(oldestNumber).catch(() => null),
    ]);
    if (head?.timestamp && oldest?.timestamp && head.timestamp > oldest.timestamp) {
      const seconds = (head.timestamp - oldest.timestamp) / span;
      blockTimeCache.set(chainId, { at: Date.now(), seconds });
      return seconds;
    }
  }

  return FALLBACK_BLOCK_TIME[chainId] ?? 12;
}

/**
 * Recent base fees, congestion, and the priority fees people are actually
 * paying. Returns null when the endpoint does not serve eth_feeHistory — every
 * caller degrades to the older multiplier-based behaviour rather than failing.
 */
export async function getFeeHistory(chainId) {
  const chain = chainId ?? (await getChainId());
  const cached = feeHistoryCache.get(chain);
  if (cached && Date.now() - cached.at < FEE_HISTORY_TTL_MS) return cached.data;

  try {
    const provider = await getProvider(chain);
    const raw = await provider.send('eth_feeHistory', [
      `0x${FEE_HISTORY_BLOCKS.toString(16)}`,
      'latest',
      REWARD_PERCENTILES,
    ]);
    if (!raw?.baseFeePerGas?.length) throw new Error('empty fee history');

    const series = raw.baseFeePerGas.map((value) => BigInt(value));
    // eth_feeHistory returns N+1 base fees: the final entry is the *next*
    // block's, already determined by how full the head block was. That one is
    // what a transaction sent now will actually be charged against.
    const nextBaseFee = series[series.length - 1];
    const history = series.slice(0, -1);
    const ratios = (raw.gasUsedRatio ?? []).map(Number);
    const oldestBlock = Number(BigInt(raw.oldestBlock ?? '0x0'));
    const headNumber = oldestBlock + history.length - 1;

    // Median across blocks rather than mean: one empty block reporting a zero
    // priority fee should not drag the whole percentile down.
    const rewardRows = (raw.reward ?? []).map((row) => row.map((value) => BigInt(value)));
    const column = (index) => medianBig(rewardRows.map((row) => row[index] ?? 0n).filter((value) => value > 0n));

    const median = medianBig(history);
    const congestion = ratios.length
      ? ratios.slice(-5).reduce((sum, value) => sum + value, 0) / Math.min(5, ratios.length)
      : 0.5;

    const first = history[0] ?? nextBaseFee;
    const percent = first > 0n ? Number(((nextBaseFee - first) * 10000n) / first) / 100 : 0;
    const direction = percent > 5 ? 'rising' : percent < -5 ? 'falling' : 'flat';

    const blockTimeSeconds = await getBlockTimeSeconds(chain, provider, headNumber, oldestBlock);

    const data = {
      supported: true,
      // Oldest → newest, ready for the sparkline. Strings, because this crosses
      // a chrome.runtime message boundary and BigInt does not survive that.
      baseFees: history.map((value) => value.toString()),
      blocks: history.map((value, index) => ({
        number: oldestBlock + index,
        baseFee: value.toString(),
        ratio: ratios[index] ?? null,
      })),
      nextBaseFee: nextBaseFee.toString(),
      median: median.toString(),
      min: history.reduce((low, value) => minBig(low, value), history[0] ?? 0n).toString(),
      max: history.reduce((high, value) => maxBig(high, value), history[0] ?? 0n).toString(),
      trend: { direction, percent: Math.round(percent * 10) / 10 },
      congestion: Math.round(congestion * 100) / 100,
      blockTimeSeconds: Math.round(blockTimeSeconds * 100) / 100,
      rewards: {
        low: column(0).toString(),
        market: column(1).toString(),
        fast: column(2).toString(),
      },
      advice: feeAdvice(nextBaseFee, median, direction, percent),
      fetchedAt: Date.now(),
    };

    feeHistoryCache.set(chain, { at: Date.now(), data });
    return data;
  } catch {
    const data = { supported: false, fetchedAt: Date.now() };
    // Cached as a miss too, so an endpoint without feeHistory is not re-asked
    // on every keystroke in the fee editor.
    feeHistoryCache.set(chain, { at: Date.now(), data });
    return data;
  }
}

/**
 * Whether it is worth waiting. Only speaks up when the current base fee is
 * meaningfully off its own recent median *and* moving in the helpful direction
 * — a hint that fires constantly is a hint nobody reads.
 */
function feeAdvice(nextBaseFee, median, direction, percent) {
  if (median <= 0n) return null;
  const ratio = Number((nextBaseFee * 100n) / median) / 100;

  if (direction === 'falling' && ratio > 1.1) {
    return {
      action: 'wait',
      message: `The base fee is ${Math.round((ratio - 1) * 100)}% above its 20-block median and falling. Waiting a few blocks will probably cost less.`,
    };
  }
  if (direction === 'rising' && ratio < 0.95) {
    return {
      action: 'send',
      message: `The base fee is below its 20-block median but climbing ${Math.abs(percent)}%. Sending now is likely cheaper than waiting.`,
    };
  }
  if (direction === 'rising' && ratio > 1.25) {
    return {
      action: 'wait',
      message: `The base fee is ${Math.round((ratio - 1) * 100)}% above its recent median and still rising. Unless this is time-sensitive, it is a poor moment to send.`,
    };
  }
  return null;
}

/**
 * How many blocks a given priority fee should wait, from where it sits among
 * the fees recently paid. This is an estimate from observed data, not a
 * prediction service, and the UI says so.
 */
function estimateInclusion(priorityWei, history) {
  const rewards = history?.rewards;
  const blockTime = history?.blockTimeSeconds ?? 12;

  let blocks;
  if (!rewards || BigInt(rewards.fast) === 0n) {
    blocks = 3;
  } else if (priorityWei >= BigInt(rewards.fast)) {
    blocks = 1;
  } else if (priorityWei >= BigInt(rewards.market)) {
    blocks = 2;
  } else if (priorityWei >= BigInt(rewards.low)) {
    blocks = 5;
  } else {
    blocks = 12;
  }

  // Consistently full blocks mean a backlog, so the same bid queues longer.
  const congestion = history?.congestion ?? 0.5;
  if (congestion > 0.9) blocks *= 2;
  else if (congestion < 0.4) blocks = Math.max(1, Math.round(blocks * 0.6));

  return { blocks, seconds: Math.max(1, Math.round(blocks * blockTime)) };
}

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------

// Used only when eth_feeHistory is unavailable.
const PRESET_MULTIPLIERS = { low: 0.85, market: 1, fast: 1.4 };
const PRESET_ETA = { low: 180, market: 45, fast: 15 };

/**
 * Preset shape when fee history *is* available.
 *
 * The priority fee is what actually orders transactions within a block, so it
 * comes straight from the percentile of what recent blocks paid. The max fee is
 * only a ceiling — paying it is not the normal case — so each preset carries
 * enough headroom above the next base fee to survive a rise without the user
 * overpaying for it.
 */
const PRESET_SHAPE = {
  low: { percentile: 'low', headroomPercent: 130n },
  market: { percentile: 'market', headroomPercent: 200n },
  fast: { percentile: 'fast', headroomPercent: 300n },
};

export async function estimateGas({ from, to, value = '0x0', data = '0x', chainId }) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const network = await getNetwork(chain);

  const request = { from, to: to || undefined, value: value || '0x0', data: data || '0x' };

  let gasLimit;
  let estimateError = null;
  try {
    const estimated = await provider.estimateGas(request);
    // 20% headroom, because estimation is a simulation against the current
    // block and state can move before the transaction lands.
    gasLimit = (estimated * 120n) / 100n;
  } catch (err) {
    // A failed estimate usually means the call would revert. Fall back to a
    // sane limit and surface the reason so the user can decide.
    gasLimit = to && (!data || data === '0x') ? 21000n : 150000n;
    estimateError = err.shortMessage ?? err.message;
  }

  const [feeData, feeHistory] = await Promise.all([provider.getFeeData(), getFeeHistory(chain)]);
  const supportsEip1559 = feeData.maxFeePerGas != null;
  const history = feeHistory?.supported ? feeHistory : null;

  // The base fee is what actually gets burned and what a max fee has to clear.
  // Fee history already carries the next block's, which is the one a
  // transaction sent now is charged against; otherwise read the head block.
  let baseFeePerGas = history?.nextBaseFee ?? null;
  if (supportsEip1559 && baseFeePerGas == null) {
    const head = await provider.getBlock('latest').catch(() => null);
    if (head?.baseFeePerGas != null) baseFeePerGas = head.baseFeePerGas.toString();
  }

  const options = {};
  for (const [name, multiplier] of Object.entries(PRESET_MULTIPLIERS)) {
    const scale = (wei) => (wei * BigInt(Math.round(multiplier * 100))) / 100n;

    if (supportsEip1559) {
      const shape = PRESET_SHAPE[name];
      const observed = history ? BigInt(history.rewards[shape.percentile]) : 0n;

      // A chain can legitimately have a zero-tip block, but bidding zero means
      // nothing ever includes you, so fall back to the node's suggestion.
      const priority = observed > 0n ? observed : scale(feeData.maxPriorityFeePerGas ?? 1_000_000_000n);

      const base = baseFeePerGas != null ? BigInt(baseFeePerGas) : 0n;
      const ceiling =
        history && base > 0n ? (base * shape.headroomPercent) / 100n + priority : scale(feeData.maxFeePerGas);
      const maxFee = ceiling > priority ? ceiling : priority + 1n;

      const eta = estimateInclusion(priority, history);

      options[name] = {
        type: 2,
        maxPriorityFeePerGas: priority.toString(),
        maxFeePerGas: maxFee.toString(),
        estimatedFee: formatEther(gasLimit * maxFee),
        // What the transaction most likely costs at the current base fee, as
        // opposed to the worst case the max fee allows.
        likelyFee: baseFeePerGas ? formatEther(gasLimit * minBig(maxFee, base + priority)) : null,
        etaSeconds: history ? eta.seconds : PRESET_ETA[name],
        etaBlocks: history ? eta.blocks : null,
        // Whether the number above came from measurement or from a constant.
        etaSource: history ? 'feeHistory' : 'estimate',
      };
    } else {
      const gasPrice = scale(feeData.gasPrice ?? 1_000_000_000n);
      options[name] = {
        type: 0,
        gasPrice: gasPrice.toString(),
        estimatedFee: formatEther(gasLimit * gasPrice),
        likelyFee: formatEther(gasLimit * gasPrice),
        etaSeconds: PRESET_ETA[name],
        etaBlocks: null,
        etaSource: 'estimate',
      };
    }
  }

  return {
    gasLimit: gasLimit.toString(),
    options,
    symbol: network.symbol,
    supportsEip1559,
    baseFeePerGas,
    suggestedPriorityFee: feeData.maxPriorityFeePerGas?.toString() ?? null,
    gasPrice: feeData.gasPrice?.toString() ?? null,
    feeHistory,
    estimateError,
  };
}

/**
 * Checks a hand-entered fee against live network conditions. Returns problems
 * that would stop the transaction confirming, and warnings that would only make
 * it slow or expensive — the caller decides which of those block submission.
 */
export function validateFees(fees, gasInfo) {
  const problems = [];
  const warnings = [];

  if (fees?.type === 2) {
    const maxFee = BigInt(fees.maxFeePerGas ?? 0);
    const priority = BigInt(fees.maxPriorityFeePerGas ?? 0);

    if (maxFee <= 0n) problems.push('Max fee must be above zero.');
    if (priority > maxFee) problems.push('Priority fee cannot exceed the max fee.');

    if (gasInfo?.baseFeePerGas) {
      const base = BigInt(gasInfo.baseFeePerGas);
      if (maxFee < base) {
        problems.push(
          `Max fee is below the current base fee of ${formatUnits(base, 'gwei')} gwei. This can never be included.`
        );
      } else if (maxFee < (base * 112n) / 100n) {
        warnings.push('Max fee barely clears the base fee. A small rise will stall this transaction.');
      }
      if (maxFee > base * 5n) {
        warnings.push('Max fee is more than 5× the base fee. You will likely overpay.');
      }
    }
    if (priority === 0n) warnings.push('A zero priority fee gives validators no reason to include this.');
  } else if (fees?.gasPrice != null) {
    const gasPrice = BigInt(fees.gasPrice);
    if (gasPrice <= 0n) problems.push('Gas price must be above zero.');
    if (gasInfo?.gasPrice) {
      const suggested = BigInt(gasInfo.gasPrice);
      if (gasPrice < suggested / 2n) warnings.push('Gas price is well below the going rate; this may not confirm.');
      if (gasPrice > suggested * 5n) warnings.push('Gas price is more than 5× the going rate. You will overpay.');
    }
  }

  return { problems, warnings, ok: problems.length === 0 };
}

/** The fee a stored transaction was actually sent with, in wei, or null. */
function feeCeilingOf(tx) {
  const raw = tx.maxFeePerGas ?? tx.gasPrice;
  if (raw == null) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Nonce state for an account: what the chain has confirmed, what the mempool
 * expects next, and whether a gap is blocking everything behind it.
 *
 * Nonces execute strictly in order, so one missing number freezes every
 * transaction after it — indefinitely, and silently. It is the single most
 * confusing state a wallet can be in, which is why this reports not just that a
 * gap exists but exactly what it is holding up.
 */
export async function getNonceInfo(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);

  const [confirmed, pendingCount, feeHistory] = await Promise.all([
    provider.getTransactionCount(address, 'latest'),
    provider.getTransactionCount(address, 'pending'),
    getFeeHistory(chain).catch(() => null),
  ]);

  const local = await listPending(address, chain);
  const localNonces = local.map((tx) => tx.nonce).filter((n) => Number.isInteger(n));

  // `pending - latest` is the run of consecutive nonces the mempool already
  // holds starting at the confirmed head, so [confirmed, pendingCount) is
  // accounted for even when those transactions came from another device.
  //
  // A real gap is a nonce at or above that point which nothing fills: the
  // mempool does not have it and neither do we, so it will never be mined, and
  // nothing behind it can be either. Measuring from `confirmed` instead — as
  // this used to — reported every in-flight transaction from another device as
  // a gap, which was a false alarm on the most alarming warning in the wallet.
  const gaps = [];
  if (localNonces.length) {
    const sorted = [...new Set(localNonces)].sort((a, b) => a - b);
    for (let n = pendingCount; n < sorted[0]; n++) gaps.push(n);
    for (let i = 1; i < sorted.length; i++) {
      for (let n = sorted[i - 1] + 1; n < sorted[i]; n++) {
        if (n >= pendingCount) gaps.push(n);
      }
    }
  }

  const uniqueGaps = [...new Set(gaps)].sort((a, b) => a - b);
  const firstGap = uniqueGaps[0] ?? null;

  const describe = (tx) => ({
    hash: tx.hash,
    nonce: tx.nonce,
    submittedAt: tx.submittedAt,
    label: tx.tokenSymbol ? `${tx.tokenAmount} ${tx.tokenSymbol}` : (tx.decoded?.label ?? 'Transfer'),
    maxFeePerGas: tx.maxFeePerGas ?? null,
    gasPrice: tx.gasPrice ?? null,
  });

  // Everything stuck behind the gap. Naming them turns "something is wrong"
  // into "these three transactions are waiting on nonce 42".
  const blocked = firstGap == null ? [] : local.filter((tx) => tx.nonce > firstGap).map(describe);

  // Separately: a transaction whose max fee no longer clears the base fee
  // cannot be included at any point, gap or not. That is a speed-up, not a gap
  // fill, so it is reported as its own condition.
  const base = feeHistory?.supported ? BigInt(feeHistory.nextBaseFee) : null;
  const underpriced =
    base == null
      ? []
      : local
          .filter((tx) => {
            const ceiling = feeCeilingOf(tx);
            return ceiling != null && ceiling < base;
          })
          .map(describe);

  const oldestPendingAt = local.length ? Math.min(...local.map((tx) => tx.submittedAt ?? Date.now())) : null;

  return {
    confirmed,
    next: pendingCount,
    pendingCount: Math.max(0, pendingCount - confirmed),
    // Nonces of our own pending transactions, so the UI can say "this replaces X".
    pendingNonces: [...new Set(localNonces)].sort((a, b) => a - b),
    gaps: uniqueGaps,
    firstGap,
    blocked,
    underpriced,
    oldestPendingAt,
    stuckForMs: oldestPendingAt ? Date.now() - oldestPendingAt : null,
    baseFeePerGas: base?.toString() ?? null,
  };
}

/**
 * Prices filling a nonce gap without sending it.
 *
 * The fix is a zero-value self-transfer at the missing nonce: the cheapest
 * possible transaction that can occupy that slot and let the queue behind it
 * drain. It still costs 21,000 gas of real money, so the user sees the price
 * first.
 */
export async function quoteNonceGapFill({ nonce, from, chainId }) {
  const chain = chainId ?? (await getChainId());
  const info = await getNonceInfo(from, chain);
  const target = nonce ?? info.firstGap;

  if (target == null) throw new Error('There is no nonce gap to fill on this account.');
  if (!info.gaps.includes(target)) {
    throw new Error(`Nonce ${target} is no longer missing — the queue may have already cleared.`);
  }

  const gasInfo = await estimateGas({ from, to: from, value: '0x0', data: '0x', chainId: chain });

  return {
    nonce: target,
    from,
    chainId: chain,
    gasInfo,
    blocked: info.blocked,
    effect: `Sends an empty transaction to your own address at nonce ${target}, which unblocks the ${info.blocked.length} transaction${info.blocked.length === 1 ? '' : 's'} queued behind it.`,
  };
}

export async function fillNonceGap({ nonce, from, fees, gas, chainId }) {
  const chain = chainId ?? (await getChainId());
  const info = await getNonceInfo(from, chain);
  const target = nonce ?? info.firstGap;

  if (target == null) throw new Error('There is no nonce gap to fill on this account.');
  // Re-checked at send time: the gap may have closed while the user was reading
  // the quote, and sending into a nonce that is no longer free just wastes gas.
  if (!info.gaps.includes(target)) {
    throw new Error(`Nonce ${target} is no longer missing — nothing was sent.`);
  }

  const resolved =
    fees && gas
      ? { fees, gas }
      : await estimateGas({ from, to: from, value: '0x0', data: '0x', chainId: chain }).then((quote) => ({
          fees: quote.options.market,
          gas: quote.gasLimit,
        }));

  return sendTransaction({
    from,
    to: from,
    value: '0x0',
    data: '0x',
    gas: resolved.gas,
    fees: resolved.fees,
    nonce: target,
    chainId: chain,
    meta: { kind: 'nonceFill', filledNonce: target },
  });
}

/**
 * Turns whatever the user typed into a checksummed address.
 *
 * A mixed-case address that fails its EIP-55 checksum is rejected rather than
 * silently normalised: a bad checksum means a typo or a tampered clipboard, and
 * quietly "fixing" it is how funds reach the wrong address. All-lowercase and
 * all-uppercase input carries no checksum, so it is accepted and normalised.
 */
export async function resolveRecipient(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Enter a recipient address.');

  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    const hasUpper = /[A-F]/.test(value.slice(2));
    const hasLower = /[a-f]/.test(value.slice(2));
    if (hasUpper && hasLower) {
      try {
        return getAddress(value);
      } catch {
        throw new Error('That address fails its EIP-55 checksum. Re-copy it — a character is wrong.');
      }
    }
    return getAddress(value.toLowerCase());
  }

  if (/^0x/i.test(value)) {
    throw new Error(`An address needs 40 hex characters after 0x; that one has ${value.length - 2}.`);
  }
  if (!value.includes('.')) throw new Error('That does not look like an address or an ENS name.');

  const provider = await getProvider('0x1');
  const resolved = await provider.resolveName(value).catch(() => null);
  if (!resolved) throw new Error(`Could not resolve ${value}. ENS names resolve on Ethereum mainnet.`);
  return getAddress(resolved);
}

/**
 * Inspects a recipient without throwing, for live feedback as the user types.
 * Also reports whether the target is a contract, which is worth knowing before
 * sending tokens to what might be a token contract itself.
 */
/**
 * Every address the user demonstrably knows: their own accounts, their address
 * book, and anywhere they have successfully sent before. This is the reference
 * set a pasted recipient is screened against.
 */
async function knownAddresses(chainId) {
  const [accounts, contactList, activity] = await Promise.all([
    listAccounts().catch(() => []),
    contacts.listContacts().catch(() => []),
    readActivity().catch(() => []),
  ]);

  const known = new Map();
  const add = (address, label, weight) => {
    if (!address) return;
    const key = address.toLowerCase();
    const existing = known.get(key);
    // A contact label beats "an address you have sent to" when both apply.
    if (!existing || weight > existing.weight) known.set(key, { address, label, weight });
  };

  for (const account of accounts) add(account.address, `your account "${account.name}"`, 3);
  for (const contact of contactList) add(contact.address, `your contact "${contact.name}"`, 2);
  for (const tx of activity) {
    // Only confirmed sends count as an address the user has really used — a
    // failed transaction to a poisoned address should not legitimise it.
    if (tx.status === 'confirmed' && tx.to) add(tx.to, 'an address you have sent to', 1);
  }

  return [...known.values()];
}

/**
 * Inspects a recipient without throwing, for live feedback as the user types.
 *
 * Answers three separate questions the Send screen needs, none of which is
 * visible from the address itself: have I used this before, is it a contract
 * (and specifically a token contract), and is it imitating something of mine.
 */
export async function inspectRecipient(input, chainId, { tokenAddress } = {}) {
  const value = String(input ?? '').trim();
  if (!value) return { state: 'empty' };

  let address;
  try {
    address = await resolveRecipient(value);
  } catch (err) {
    return { state: 'invalid', message: err.message };
  }

  const chain = chainId ?? (await getChainId());
  const isEns = !value.startsWith('0x');
  const result = { state: 'ok', address, ens: isEns ? value : null };
  const lower = address.toLowerCase();

  // --- history: how well does the user know this address? -------------------
  try {
    const [activity, contact, accounts] = await Promise.all([
      readActivity(),
      contacts.findContactByAddress(address).catch(() => null),
      listAccounts().catch(() => []),
    ]);

    const sends = activity.filter((tx) => tx.to?.toLowerCase() === lower);
    const confirmed = sends.filter((tx) => tx.status === 'confirmed');

    result.sendCount = confirmed.length;
    result.lastSentAt = confirmed.length ? Math.max(...confirmed.map((tx) => tx.submittedAt ?? 0)) : null;
    // Attempted-but-never-confirmed is its own signal: it usually means the
    // address is wrong in some way.
    result.attemptedOnly = confirmed.length === 0 && sends.length > 0;
    result.seenBefore = confirmed.length > 0;
    result.contact = contact ? { name: contact.name, label: contact.label ?? '' } : null;
    result.isOwnAccount = accounts.some((account) => account.address.toLowerCase() === lower);
  } catch {
    result.seenBefore = null;
    result.sendCount = null;
  }

  // --- lookalike screening ---------------------------------------------------
  try {
    // Self-evidently not an impostor if it is already a known address.
    if (!result.seenBefore && !result.contact && !result.isOwnAccount) {
      const known = await knownAddresses(chain);
      const match = poisoning.screenRecipient(address, known);
      result.lookalike = match ? { ...match, ...poisoning.describeLookalike(match) } : null;
    } else {
      result.lookalike = null;
    }
  } catch {
    result.lookalike = null;
  }

  // --- what is at this address? ---------------------------------------------
  try {
    const provider = await getProvider(chain);
    const code = await provider.getCode(address);
    result.isContract = code && code !== '0x';

    if (result.isContract) {
      result.contractKind = await identifyContract(address, chain, provider);
      // The specific catastrophe this guards against: sending a token to its
      // own contract, or to another token's contract. Both are unrecoverable
      // in practice — the contract has no logic to give it back.
      result.isSendingToOwnToken = Boolean(tokenAddress) && tokenAddress.toLowerCase() === lower;
    }
  } catch {
    result.isContract = null;
  }

  return result;
}

/**
 * What kind of contract sits at an address.
 *
 * Only enough to answer "is this somewhere tokens go to die". A tracked token
 * is checked first because that is a local lookup and covers the common case;
 * the on-chain probes are the fallback for contracts the wallet has not seen.
 */
async function identifyContract(address, chainId, provider) {
  const lower = address.toLowerCase();

  try {
    const tracked = await listTokens(chainId, { includeHidden: true });
    const match = tracked.find((token) => token.address.toLowerCase() === lower);
    if (match) return { kind: 'token', standard: 'ERC20', symbol: match.symbol, tracked: true };
  } catch {
    /* fall through to the on-chain probes */
  }

  try {
    const probe = new Contract(address, ERC165_ABI, provider);
    const [is721, is1155] = await Promise.all([
      probe.supportsInterface('0x80ac58cd').catch(() => null),
      probe.supportsInterface('0xd9b67a26').catch(() => null),
    ]);
    if (is721 === true) return { kind: 'nft', standard: 'ERC721' };
    if (is1155 === true) return { kind: 'nft', standard: 'ERC1155' };
  } catch {
    /* not EIP-165 aware */
  }

  try {
    // An address answering both decimals() and symbol() is an ERC-20 for every
    // practical purpose, whether or not it declares an interface.
    const erc20 = new Contract(address, ERC20_ABI, provider);
    const [decimals, symbol] = await Promise.all([erc20.decimals(), erc20.symbol().catch(() => '')]);
    if (decimals != null) return { kind: 'token', standard: 'ERC20', symbol, tracked: false };
  } catch {
    /* not a token */
  }

  return { kind: 'contract', standard: null };
}

/**
 * EIP-681 payment links: `ethereum:0xADDRESS@chainId?value=1e18`, plus the
 * ERC-20 form `ethereum:0xTOKEN@chain/transfer?address=0xTO&uint256=1000000`.
 * Returns null for anything that is not such a link, so callers can fall
 * through to treating the input as a plain address.
 */
export function parsePaymentUri(input) {
  const raw = String(input ?? '').trim();
  if (!/^ethereum:/i.test(raw)) return null;

  const body = raw.slice('ethereum:'.length);
  const [targetPart, queryPart = ''] = body.split('?');
  const [addressAndChain, functionName] = targetPart.split('/');
  const [rawAddress, chainPart] = addressAndChain.split('@');

  const address = rawAddress?.startsWith('pay-') ? rawAddress.slice(4) : rawAddress;
  if (!address || !isAddress(address)) return null;

  const params = new URLSearchParams(queryPart);
  const chainId = chainPart ? `0x${Number(chainPart).toString(16)}` : null;

  // Scientific notation is legal in EIP-681 amounts ("2.014e18").
  const toWei = (text) => {
    if (!text) return null;
    const match = /^(\d+(?:\.\d+)?)(?:e(\d+))?$/i.exec(text.trim());
    if (!match) return null;
    const [, mantissa, exponent] = match;
    if (!exponent) return BigInt(Math.round(Number(mantissa))).toString();
    const [whole, fraction = ''] = mantissa.split('.');
    const digits = Number(exponent);
    const padded = (whole + fraction).padEnd(whole.length + digits, '0');
    return BigInt(padded.slice(0, whole.length + digits)).toString();
  };

  if (functionName === 'transfer') {
    return {
      kind: 'token',
      tokenAddress: getAddress(address),
      to: params.get('address') ? getAddress(params.get('address')) : null,
      amountRaw: params.get('uint256') ?? null,
      chainId,
    };
  }

  return {
    kind: 'native',
    to: getAddress(address),
    valueWei: toWei(params.get('value')) ?? null,
    chainId,
    gasLimit: params.get('gas') ?? params.get('gasLimit') ?? null,
  };
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
const readActivity = () => local.get('activity', []);

/**
 * One account's activity on one chain.
 *
 * Scoped to a single chain by default and always has been — the same nonce
 * sequence, token symbol, and even the same contract address mean different
 * things on different networks, so a blended list is actively misleading. What
 * was missing was any way to *see* that scoping, which activityChainSummary
 * below provides.
 */
export async function listActivity(address, chainId, { allChains = false } = {}) {
  const chain = chainId ?? (await getChainId());
  const all = await readActivity();
  return all
    .filter(
      (tx) => (allChains || tx.chainId === chain) && tx.from?.toLowerCase() === address?.toLowerCase()
    )
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

/**
 * Per-chain counts for one account, so the activity screen can say "42 more on
 * other networks" instead of leaving the user to guess whether a transaction
 * they remember is missing or merely elsewhere.
 */
export async function activityChainSummary(address) {
  const all = await readActivity();
  const mine = all.filter((tx) => tx.from?.toLowerCase() === address?.toLowerCase());

  const byChain = new Map();
  for (const tx of mine) {
    const row = byChain.get(tx.chainId) ?? {
      chainId: tx.chainId,
      networkName: tx.networkName ?? tx.chainId,
      symbol: tx.symbol ?? '',
      total: 0,
      pending: 0,
      failed: 0,
      lastAt: 0,
    };
    row.total += 1;
    if (tx.status === 'pending') row.pending += 1;
    if (tx.status === 'failed') row.failed += 1;
    row.lastAt = Math.max(row.lastAt, tx.submittedAt ?? 0);
    // A later row may carry a network name an earlier one lacked.
    if (!row.networkName || row.networkName === tx.chainId) row.networkName = tx.networkName ?? row.networkName;
    byChain.set(tx.chainId, row);
  }

  return [...byChain.values()].sort((a, b) => b.lastAt - a.lastAt);
}

async function recordActivity(entry) {
  const all = await readActivity();
  // Keep the log from growing without bound.
  await local.set({ activity: [entry, ...all].slice(0, 300) });
  scheduleReceiptPolling();
}

async function updateActivity(hash, patch) {
  const all = await readActivity();
  await local.set({ activity: all.map((tx) => (tx.hash === hash ? { ...tx, ...patch } : tx)) });
}

/** Pending transactions for an account, oldest first — the queue view. */
export async function listPending(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readActivity();
  return all
    .filter(
      (tx) =>
        tx.status === 'pending' && tx.chainId === chain && tx.from.toLowerCase() === address?.toLowerCase()
    )
    .sort((a, b) => a.nonce - b.nonce);
}

/**
 * Everything the detail screen shows. Starts from the stored row and enriches
 * it with live chain data — receipt, block timestamp, effective gas price, and
 * the actual fee paid, which is only knowable after inclusion.
 */
export async function getTransactionDetail(hash) {
  const all = await readActivity();
  const stored = all.find((tx) => tx.hash === hash);
  if (!stored) throw new Error('Transaction not found.');

  const detail = { ...stored, feePaid: null, effectiveGasPrice: null, confirmations: null, blockTime: null };

  try {
    const provider = await getProvider(stored.chainId);
    const [receipt, onchain, blockNumber] = await Promise.all([
      provider.getTransactionReceipt(hash).catch(() => null),
      provider.getTransaction(hash).catch(() => null),
      provider.getBlockNumber().catch(() => null),
    ]);

    if (onchain) {
      detail.gasLimit = onchain.gasLimit?.toString() ?? detail.gasLimit ?? null;
      detail.maxFeePerGas = onchain.maxFeePerGas?.toString() ?? null;
      detail.maxPriorityFeePerGas = onchain.maxPriorityFeePerGas?.toString() ?? null;
      detail.gasPrice = onchain.gasPrice?.toString() ?? null;
      detail.type = onchain.type ?? null;
    }

    if (receipt) {
      detail.status = receipt.status === 1 ? 'confirmed' : 'failed';
      detail.blockNumber = receipt.blockNumber;
      detail.gasUsed = receipt.gasUsed.toString();
      detail.effectiveGasPrice = receipt.gasPrice?.toString() ?? null;
      if (receipt.gasPrice != null) {
        detail.feePaid = formatEther(receipt.gasUsed * receipt.gasPrice);
      }
      if (blockNumber != null) detail.confirmations = Math.max(0, blockNumber - receipt.blockNumber + 1);

      const block = await provider.getBlock(receipt.blockNumber).catch(() => null);
      if (block?.timestamp) detail.blockTime = block.timestamp * 1000;
    }
  } catch {
    // Offline or rate-limited: the stored row is still worth showing.
  }

  return detail;
}

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_NOTE_LENGTH = 500;

/**
 * Tags are stored case-preserved but deduped case-insensitively, so "Tax" and
 * "tax" do not become two chips that filter differently.
 */
export function normaliseTags(tags) {
  const raw = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  const seen = new Set();
  const result = [];
  for (const tag of raw) {
    const clean = String(tag).trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

export async function updateActivityMeta({ hash, note = '', tags = [] }) {
  const all = await readActivity();
  if (!all.some((tx) => tx.hash === hash)) throw new Error('Transaction not found.');

  await updateActivity(hash, {
    note: String(note ?? '').trim().slice(0, MAX_NOTE_LENGTH),
    tags: normaliseTags(tags),
    metaUpdatedAt: Date.now(),
  });
  return { ok: true };
}

/**
 * Every tag in use with a count, most-used first. Drives autocomplete and the
 * filter chips, so the user reuses tags instead of inventing near-duplicates.
 */
export async function listTags(address, chainId) {
  const all = await readActivity();
  const scoped = all.filter(
    (tx) =>
      (!address || tx.from?.toLowerCase() === address.toLowerCase()) && (!chainId || tx.chainId === chainId)
  );

  const counts = new Map();
  for (const tx of scoped) {
    for (const tag of tx.tags ?? []) {
      const key = tag.toLowerCase();
      const current = counts.get(key) ?? { tag, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Adds or removes one tag without disturbing the note or the other tags. */
export async function toggleActivityTag({ hash, tag }) {
  const all = await readActivity();
  const target = all.find((tx) => tx.hash === hash);
  if (!target) throw new Error('Transaction not found.');

  const clean = String(tag ?? '').trim().slice(0, MAX_TAG_LENGTH);
  if (!clean) throw new Error('Enter a tag.');

  const current = target.tags ?? [];
  const has = current.some((existing) => existing.toLowerCase() === clean.toLowerCase());
  const next = has
    ? current.filter((existing) => existing.toLowerCase() !== clean.toLowerCase())
    : [...current, clean];

  if (next.length > MAX_TAGS) throw new Error(`A transaction can carry at most ${MAX_TAGS} tags.`);

  await updateActivity(hash, { tags: normaliseTags(next), metaUpdatedAt: Date.now() });
  return { tags: normaliseTags(next) };
}

/** Renames a tag everywhere it appears, or deletes it when newTag is empty. */
export async function renameTag({ from, to }) {
  const all = await readActivity();
  const target = String(from ?? '').trim().toLowerCase();
  if (!target) throw new Error('Enter the tag to rename.');
  const replacement = String(to ?? '').trim().slice(0, MAX_TAG_LENGTH);

  let changed = 0;
  const next = all.map((tx) => {
    if (!tx.tags?.some((tag) => tag.toLowerCase() === target)) return tx;
    changed += 1;
    const swapped = replacement
      ? tx.tags.map((tag) => (tag.toLowerCase() === target ? replacement : tag))
      : tx.tags.filter((tag) => tag.toLowerCase() !== target);
    return { ...tx, tags: normaliseTags(swapped) };
  });

  await local.set({ activity: next });
  return { changed, removed: !replacement };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
export async function sendTransaction({ from, to, value = '0x0', data = '0x', gas, fees, nonce, meta = {}, chainId }) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const network = await getNetwork(chain);
  const wallet = (await getWallet(from)).connect(provider);

  const request = {
    to: to || undefined,
    value: value || 0n,
    data: data || '0x',
    chainId: parseInt(chain, 16),
    nonce: nonce ?? (await provider.getTransactionCount(from, 'pending')),
  };

  if (gas) request.gasLimit = BigInt(gas);
  if (fees?.type === 2) {
    request.maxFeePerGas = BigInt(fees.maxFeePerGas);
    request.maxPriorityFeePerGas = BigInt(fees.maxPriorityFeePerGas);
  } else if (fees?.gasPrice) {
    request.gasPrice = BigInt(fees.gasPrice);
  }

  const sent = await wallet.sendTransaction(request);
  const decoded = decodeContractCall(request.data);

  await recordActivity({
    hash: sent.hash,
    chainId: chain,
    from: getAddress(from),
    to: to ? getAddress(to) : null,
    // Callers pass hex ('0x38d7...') or bigint. Normalise to a decimal wei
    // string so the UI never has to guess which it got.
    value: BigInt(request.value ?? 0).toString(),
    data: request.data,
    decoded,
    nonce: sent.nonce,
    // Stored so a pending transaction can later be checked against the live
    // base fee without a chain read per row. A max fee that no longer clears
    // the base fee is the difference between "waiting" and "will never land".
    gasLimit: request.gasLimit?.toString() ?? null,
    maxFeePerGas: request.maxFeePerGas?.toString() ?? null,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas?.toString() ?? null,
    gasPrice: request.gasPrice?.toString() ?? null,
    status: 'pending',
    submittedAt: Date.now(),
    symbol: network.symbol,
    networkName: network.name,
    explorer: network.explorer,
    ...meta,
  });

  await recordApprovalFromTransaction({
    chainId: chain,
    owner: from,
    contract: to,
    data: request.data,
    hash: sent.hash,
    origin: meta.origin,
  });

  if (typeof chrome !== 'undefined' && chrome.notifications) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Transaction Sent',
      message: `Your transaction to ${to ? to.slice(0, 6) + '...' + to.slice(-4) : 'create a contract'} has been submitted.`
    });
  }

  return sent.hash;
}

function revokeRequestFor(approval, from) {
  return {
    from,
    to: approval.contract,
    value: '0x0',
    data: encodeApprovalRevoke(approval),
    chainId: approval.chainId,
  };
}

/**
 * Costs a revoke without sending it. Revoking is a real transaction that spends
 * real gas, so the user gets a price before a single click broadcasts it.
 */
export async function quoteRevoke({ id, from }) {
  const approval = await getApproval(id);
  if (approval.owner.toLowerCase() !== from.toLowerCase()) {
    throw new Error('That approval belongs to another account.');
  }

  const request = revokeRequestFor(approval, from);
  const gasInfo = await estimateGas(request);

  return {
    id,
    approval,
    gasInfo,
    // What the revoke actually does, spelled out — "revoke" is ambiguous
    // between clearing an allowance and removing an operator.
    effect:
      approval.standard === 'ERC20'
        ? `Sets the allowance for ${approval.spender} to zero.`
        : approval.method === 'approve'
          ? `Clears the approved address for token #${approval.tokenId}.`
          : `Removes ${approval.spender} as an operator for the whole collection.`,
  };
}

export async function revokeApproval({ id, from, fees, gas }) {
  const approval = await getApproval(id);
  if (approval.owner.toLowerCase() !== from.toLowerCase()) throw new Error('That approval belongs to another account.');

  const request = revokeRequestFor(approval, from);
  // Caller-supplied fees come from a quote the user has already seen; without
  // them, price it now rather than guessing.
  const resolved = fees && gas ? { fees, gas } : await estimateGas(request).then((info) => ({
    fees: info.options.market,
    gas: info.gasLimit,
  }));

  const hash = await sendTransaction({
    ...request,
    gas: resolved.gas,
    fees: resolved.fees,
    meta: {
      kind: 'approvalRevoke',
      approvalId: id,
      approvalSpender: approval.spender,
      approvalStandard: approval.standard,
      approvalTokenId: approval.tokenId,
    },
  });
  await markApprovalRevoked(id, hash);
  return hash;
}

/**
 * Revokes several approvals in sequence. They cannot be batched into one
 * transaction without a smart account, so each is sent separately and the
 * result reports which succeeded — a mid-run failure must not hide the ones
 * that already went out.
 */
export async function revokeApprovals({ ids, from }) {
  const sent = [];
  const failed = [];

  for (const id of ids ?? []) {
    try {
      const hash = await revokeApproval({ id, from });
      sent.push({ id, hash });
    } catch (err) {
      failed.push({ id, error: err.shortMessage ?? err.message });
    }
  }

  return { sent, failed, total: (ids ?? []).length };
}

/**
 * Replacement transactions. Same nonce, higher fees. Ethereum requires at least
 * a 10% bump for a node to accept the replacement, so 12.5% is used here.
 */
async function replace(hash, { toSelf }) {
  const all = await readActivity();
  const original = all.find((tx) => tx.hash === hash);
  if (!original) throw new Error('Transaction not found.');
  if (original.status !== 'pending') throw new Error('That transaction already settled.');

  const bump = (wei) => ((BigInt(wei) * 1125n) / 1000n).toString();
  const provider = await getProvider(original.chainId);
  const pendingTx = await provider.getTransaction(hash);

  const fees = pendingTx?.maxFeePerGas
    ? {
        type: 2,
        maxFeePerGas: bump(pendingTx.maxFeePerGas),
        maxPriorityFeePerGas: bump(pendingTx.maxPriorityFeePerGas ?? 1_000_000_000n),
      }
    : { gasPrice: bump(pendingTx?.gasPrice ?? 1_000_000_000n) };

  const newHash = await sendTransaction({
    from: original.from,
    to: toSelf ? original.from : original.to,
    value: toSelf ? '0x0' : original.value,
    data: toSelf ? '0x' : original.data,
    gas: toSelf ? 21000 : undefined,
    fees,
    nonce: original.nonce,
    chainId: original.chainId,
    meta: { kind: toSelf ? 'cancel' : 'speedup', replaces: hash },
  });

  await updateActivity(hash, { status: 'replaced', replacedBy: newHash });
  return newHash;
}

export const speedUp = (hash) => replace(hash, { toSelf: false });
export const cancelTransaction = (hash) => replace(hash, { toSelf: true });

// ---------------------------------------------------------------------------
// Receipt polling
// ---------------------------------------------------------------------------
export function scheduleReceiptPolling() {
  // 0.5 minutes is the shortest period Chrome reliably honours for a packed
  // extension; anything smaller is silently clamped.
  chrome.alarms.create('poll-receipts', { periodInMinutes: 0.5 });
}

export async function pollReceipts() {
  const all = await readActivity();
  const pending = all.filter((tx) => tx.status === 'pending');

  if (!pending.length) {
    chrome.alarms.clear('poll-receipts');
    return;
  }

  for (const tx of pending) {
    try {
      const provider = await getProvider(tx.chainId);
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt) continue;

      const status = receipt.status === 1 ? 'confirmed' : 'failed';
      await updateActivity(tx.hash, {
        status,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        confirmedAt: Date.now(),
      });

      try {
        // In some Chrome builds this returns undefined rather than a promise,
        // so it cannot be chained onto.
        chrome.notifications?.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon48.png'),
          title: status === 'confirmed' ? 'Transaction confirmed' : 'Transaction failed',
          message: `${tx.hash.slice(0, 10)}... on ${tx.networkName ?? `chain ${tx.chainId}`}`,
        });
      } catch {
        /* notifications are a nicety, never a reason to stop */
      }
    } catch {
      // Network hiccup - try again on the next tick.
    }
  }

  chrome.runtime.sendMessage({ type: 'STATE_CHANGED' }).catch(() => {});
}

/** Human-readable summary used by the confirmation screen and activity list. */
export function describeTransaction(tx) {
  if (!tx.to) return { action: 'Contract deployment' };

  const decoded = decodeContractCall(tx.data);
  if (!decoded) return { action: 'Send' };

  const base = {
    action: decoded.label,
    method: decoded.name,
    signature: decoded.signature,
    selector: decoded.selector,
    standard: decoded.standard,
    namedArgs: decoded.namedArgs,
    risk: decoded.risk ?? null,
    known: decoded.known,
  };

  if (decoded.approval) {
    return {
      ...base,
      spender: decoded.approval.spender,
      amount: decoded.approval.amount,
      tokenId: decoded.approval.tokenId,
      unlimited: decoded.approval.unlimited,
      approved: decoded.approval.approved,
      operator: decoded.approval.operator,
    };
  }

  if (decoded.standard === 'ERC20' && decoded.name === 'transfer') {
    return { ...base, to: decoded.args[0], amount: decoded.args[1] };
  }

  return base;
}

/**
 * Reads the on-chain state an approval would change, so the confirmation screen
 * can say what the allowance is *now* rather than only what it is becoming.
 * An increase from 0 and an increase from an existing large allowance are very
 * different things, and the raw calldata does not distinguish them.
 */
export async function inspectApproval({ owner, contract, data, chainId }) {
  const decoded = decodeContractCall(data);
  if (!decoded?.approval || !contract || !owner) return null;

  const chain = chainId ?? (await getChainId());
  const { spender } = decoded.approval;
  const result = {
    standard: decoded.standard,
    spender,
    requested: decoded.approval.amount ?? null,
    tokenId: decoded.approval.tokenId ?? null,
    unlimited: Boolean(decoded.approval.unlimited),
    approved: decoded.approval.approved,
    operator: Boolean(decoded.approval.operator),
    current: null,
    symbol: null,
    decimals: null,
    spenderIsContract: null,
    spenderIsToken: false,
    warnings: [],
  };

  // Approving the token contract itself is a common phishing shape and is never
  // something a legitimate dApp asks for.
  if (spender && contract && spender.toLowerCase() === contract.toLowerCase()) {
    result.spenderIsToken = true;
    result.warnings.push('The spender is the token contract itself. Legitimate dApps do not ask for this.');
  }

  try {
    const provider = await getProvider(chain);

    const code = await provider.getCode(spender).catch(() => null);
    result.spenderIsContract = code != null ? code !== '0x' : null;
    if (result.spenderIsContract === false) {
      result.warnings.push(
        'The spender is a regular wallet address, not a contract. Approvals to a plain address are a common drainer pattern.'
      );
    }

    if (decoded.standard === 'ERC20') {
      const token = new Contract(contract, ERC20_ABI, provider);
      const [allowance, symbol, decimals] = await Promise.all([
        token.allowance(owner, spender).catch(() => null),
        token.symbol().catch(() => null),
        token.decimals().catch(() => null),
      ]);
      if (allowance != null) result.current = allowance.toString();
      result.symbol = symbol;
      result.decimals = decimals != null ? Number(decimals) : null;

      if (result.current != null && result.requested != null) {
        const from = BigInt(result.current);
        const to = BigInt(result.requested);
        result.direction = to > from ? 'increase' : to < from ? 'decrease' : 'unchanged';
        if (from > 0n && to > from) {
          result.warnings.push('This raises an allowance that is already active, rather than replacing it.');
        }
      }
    } else {
      const nft = new Contract(contract, ERC721_ABI, provider);
      const [name, alreadyOperator] = await Promise.all([
        nft.name().catch(() => null),
        result.operator ? nft.isApprovedForAll(owner, spender).catch(() => null) : Promise.resolve(null),
      ]);
      result.symbol = name;
      result.current = alreadyOperator == null ? null : String(alreadyOperator);
      if (alreadyOperator === true && decoded.approval.approved) {
        result.warnings.push('This operator already has collection-wide approval; the transaction changes nothing.');
      }
    }
  } catch {
    // A read failure must not block the prompt — the calldata warnings still
    // apply and the user can decide with less context.
  }

  return result;
}

export { formatEther, formatUnits, parseEther };
