import { Contract, formatEther, formatUnits, getAddress, isAddress, parseEther } from 'ethers';
import { local } from './storage.js';
import { getProvider, getNetwork, getChainId } from './networks.js';
import { getWallet } from './keyring.js';
import {
  ERC20_ABI,
  ERC721_ABI,
  decodeContractCall,
  encodeApprovalRevoke,
  getApproval,
  markApprovalRevoked,
  recordApprovalFromTransaction,
} from './tokens.js';

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------
const PRESET_MULTIPLIERS = { low: 0.85, market: 1, fast: 1.4 };

// Rough inclusion times. These are honest approximations, not a prediction
// service — they exist so "Slow" means something concrete to the user.
const PRESET_ETA = { low: 180, market: 45, fast: 15 };

export async function estimateGas({ from, to, value = '0x0', data = '0x', chainId }) {
  const provider = await getProvider(chainId);
  const network = await getNetwork(chainId);

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

  const feeData = await provider.getFeeData();
  const supportsEip1559 = feeData.maxFeePerGas != null;

  // The base fee is what actually gets burned and what a max fee has to clear.
  // getFeeData does not expose it directly, so it is read from the head block.
  let baseFeePerGas = null;
  if (supportsEip1559) {
    const head = await provider.getBlock('latest').catch(() => null);
    if (head?.baseFeePerGas != null) baseFeePerGas = head.baseFeePerGas.toString();
  }

  const options = {};
  for (const [name, multiplier] of Object.entries(PRESET_MULTIPLIERS)) {
    const scale = (wei) => (wei * BigInt(Math.round(multiplier * 100))) / 100n;
    if (supportsEip1559) {
      const priority = scale(feeData.maxPriorityFeePerGas ?? 1_000_000_000n);
      const max = scale(feeData.maxFeePerGas);
      const maxFee = max > priority ? max : priority + 1n;
      options[name] = {
        type: 2,
        maxPriorityFeePerGas: priority.toString(),
        maxFeePerGas: maxFee.toString(),
        estimatedFee: formatEther(gasLimit * maxFee),
        // What the transaction most likely costs at the current base fee, as
        // opposed to the worst case the max fee allows.
        likelyFee: baseFeePerGas
          ? formatEther(gasLimit * minBig(maxFee, BigInt(baseFeePerGas) + priority))
          : null,
        etaSeconds: PRESET_ETA[name],
      };
    } else {
      const gasPrice = scale(feeData.gasPrice ?? 1_000_000_000n);
      options[name] = {
        type: 0,
        gasPrice: gasPrice.toString(),
        estimatedFee: formatEther(gasLimit * gasPrice),
        likelyFee: formatEther(gasLimit * gasPrice),
        etaSeconds: PRESET_ETA[name],
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
    estimateError,
  };
}

const minBig = (a, b) => (a < b ? a : b);

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

/**
 * Nonce state for an account: what the chain has confirmed, what the mempool
 * expects next, and whether a gap is blocking everything behind it.
 */
export async function getNonceInfo(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);

  const [confirmed, pendingCount] = await Promise.all([
    provider.getTransactionCount(address, 'latest'),
    provider.getTransactionCount(address, 'pending'),
  ]);

  const local = await listPending(address, chain);
  const localNonces = local.map((tx) => tx.nonce).filter((n) => Number.isInteger(n));

  // A gap means some nonce between the confirmed head and our lowest pending
  // one was never broadcast, so nothing after it can ever be mined.
  const gaps = [];
  if (localNonces.length) {
    const lowest = Math.min(...localNonces);
    for (let n = confirmed; n < lowest; n++) gaps.push(n);
    const sorted = [...new Set(localNonces)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      for (let n = sorted[i - 1] + 1; n < sorted[i]; n++) gaps.push(n);
    }
  }

  return {
    confirmed,
    next: pendingCount,
    pendingCount: Math.max(0, pendingCount - confirmed),
    // Nonces of our own pending transactions, so the UI can say "this replaces X".
    pendingNonces: [...new Set(localNonces)].sort((a, b) => a - b),
    gaps: [...new Set(gaps)].sort((a, b) => a - b),
  };
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
export async function inspectRecipient(input, chainId) {
  const value = String(input ?? '').trim();
  if (!value) return { state: 'empty' };

  let address;
  try {
    address = await resolveRecipient(value);
  } catch (err) {
    return { state: 'invalid', message: err.message };
  }

  const isEns = !value.startsWith('0x');
  const result = { state: 'ok', address, ens: isEns ? value : null };

  try {
    const provider = await getProvider(chainId);
    const code = await provider.getCode(address);
    result.isContract = code && code !== '0x';
  } catch {
    result.isContract = null;
  }

  // "Have I sent here before" — cheap first-time-recipient signal from local history.
  try {
    const all = await readActivity();
    result.seenBefore = all.some((tx) => tx.to?.toLowerCase() === address.toLowerCase());
  } catch {
    result.seenBefore = null;
  }

  return result;
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

export async function listActivity(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const all = await readActivity();
  return all
    .filter((tx) => tx.chainId === chain && tx.from.toLowerCase() === address?.toLowerCase())
    .sort((a, b) => b.submittedAt - a.submittedAt);
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
