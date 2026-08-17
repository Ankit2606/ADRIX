import { formatEther, formatUnits, getAddress, isAddress, parseEther } from 'ethers';
import { local } from './storage.js';
import { getProvider, getNetwork, getChainId } from './networks.js';
import { getWallet } from './keyring.js';
import {
  decodeContractCall,
  decodeErc20Call,
  encodeApprovalRevoke,
  getApproval,
  markApprovalRevoked,
  recordApprovalFromTransaction,
} from './tokens.js';

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------
const PRESET_MULTIPLIERS = { low: 0.85, market: 1, fast: 1.4 };

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

  const options = {};
  for (const [name, multiplier] of Object.entries(PRESET_MULTIPLIERS)) {
    const scale = (wei) => (wei * BigInt(Math.round(multiplier * 100))) / 100n;
    if (supportsEip1559) {
      const priority = scale(feeData.maxPriorityFeePerGas ?? 1_000_000_000n);
      const max = scale(feeData.maxFeePerGas);
      options[name] = {
        type: 2,
        maxPriorityFeePerGas: priority.toString(),
        maxFeePerGas: (max > priority ? max : priority + 1n).toString(),
        estimatedFee: formatEther(gasLimit * (max > priority ? max : priority + 1n)),
      };
    } else {
      const gasPrice = scale(feeData.gasPrice ?? 1_000_000_000n);
      options[name] = {
        type: 0,
        gasPrice: gasPrice.toString(),
        estimatedFee: formatEther(gasLimit * gasPrice),
      };
    }
  }

  return {
    gasLimit: gasLimit.toString(),
    options,
    symbol: network.symbol,
    supportsEip1559,
    estimateError,
  };
}

/** Resolves an ENS name to an address. Only mainnet runs ENS, so others pass through. */
export async function resolveRecipient(input) {
  const value = input?.trim();
  if (!value) throw new Error('Enter a recipient address.');
  if (isAddress(value)) return getAddress(value);
  if (!value.includes('.')) throw new Error('That does not look like an address.');

  const provider = await getProvider('0x1');
  const resolved = await provider.resolveName(value);
  if (!resolved) throw new Error(`Could not resolve ${value}.`);
  return resolved;
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

export async function updateActivityMeta({ hash, note = '', tags = [] }) {
  const cleanTags = Array.isArray(tags)
    ? tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8)
    : String(tags)
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 8);
  await updateActivity(hash, { note: String(note).trim(), tags: cleanTags });
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

export async function revokeApproval({ id, from }) {
  const approval = await getApproval(id);
  if (approval.owner.toLowerCase() !== from.toLowerCase()) throw new Error('That approval belongs to another account.');

  const request = {
    from,
    to: approval.contract,
    value: '0x0',
    data: encodeApprovalRevoke(approval),
    chainId: approval.chainId,
  };
  const gasInfo = await estimateGas(request);
  const hash = await sendTransaction({
    ...request,
    gas: gasInfo.gasLimit,
    fees: gasInfo.options.market,
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
  const decoded = decodeContractCall(tx.data);
  if (decoded?.approval) {
    return {
      action: decoded.label,
      method: decoded.name,
      signature: decoded.signature,
      standard: decoded.standard,
      spender: decoded.approval.spender,
      amount: decoded.approval.amount,
      tokenId: decoded.approval.tokenId,
      unlimited: decoded.approval.unlimited,
      approved: decoded.approval.approved,
      operator: decoded.approval.operator,
    };
  }
  if (decoded) {
    return { action: decoded.label, method: decoded.name, signature: decoded.signature, standard: decoded.standard };
  }

  const erc20Decoded = decodeErc20Call(tx.data);
  if (erc20Decoded?.name === 'transfer') {
    return { action: 'Token transfer', to: erc20Decoded.args[0], amount: erc20Decoded.args[1] };
  }
  if (erc20Decoded?.name === 'approve') {
    const amount = erc20Decoded.args[1];
    return {
      action: 'Token approval',
      spender: erc20Decoded.args[0],
      amount,
      unlimited: BigInt(amount) >= 2n ** 255n,
    };
  }
  if (!tx.to) return { action: 'Contract deployment' };
  if (tx.data && tx.data !== '0x') return { action: 'Contract interaction' };
  return { action: 'Send' };
}

export { formatEther, formatUnits, parseEther };
