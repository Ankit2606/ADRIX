// Batch transfers.
//
// The screen this replaces claimed to "execute multiple transfers in a single
// atomic transaction … they all succeed or fail together". A plain EOA cannot
// do that. Atomicity needs either a smart account (ERC-4337) or an EIP-7702
// delegation, and ADRIX has neither — so the claim was false in the way that
// matters: it promised that a partial failure could not happen, which is
// exactly the failure mode this actually has.
//
// What is real and still worth having: sending N transfers back to back with
// explicitly assigned sequential nonces, one review, and honest per-transfer
// reporting. That saves the tedium without inventing a guarantee.
//
// The nonce handling is the substance. Left to itself, each send would read
// `getTransactionCount(pending)` and several dispatched in quick succession
// would collide on the same nonce, so all but one would be dropped or would
// replace each other. Assigning them up front is what makes a batch work at all.

import { getAddress, parseEther, parseUnits } from 'ethers';
import { getProvider, getChainId, getNetwork } from './networks.js';
import { encodeTransfer, listTokens } from './tokens.js';
import { estimateGas, sendTransaction, getNonceInfo } from './transactions.js';
import { resolveRecipient, inspectRecipient } from './transactions.js';

export const MAX_BATCH = 20;

/**
 * Validates and prices a batch before anything is signed.
 *
 * Every recipient is resolved and screened individually: a batch is exactly
 * where a bad address hides, because the user is reviewing a list rather than
 * one transfer they typed.
 */
export async function prepareBatch({ from, chainId, transfers = [], tokenAddress = null }) {
  const chain = chainId ?? (await getChainId());
  if (!transfers.length) throw new Error('Add at least one transfer.');
  if (transfers.length > MAX_BATCH) throw new Error(`A batch is limited to ${MAX_BATCH} transfers.`);

  const network = await getNetwork(chain);
  const provider = await getProvider(chain);

  let token = null;
  if (tokenAddress) {
    const tracked = await listTokens(chain, { includeHidden: true });
    token = tracked.find((entry) => entry.address.toLowerCase() === tokenAddress.toLowerCase()) ?? null;
    if (!token) throw new Error('That token is not tracked on this network.');
  }

  const decimals = token ? Number(token.decimals) : 18;
  const symbol = token ? token.symbol : network.symbol;

  const rows = [];
  const seen = new Map();

  for (const [index, transfer] of transfers.entries()) {
    const row = { index, input: transfer.address, amount: transfer.amount, symbol };

    try {
      row.to = await resolveRecipient(transfer.address);
    } catch (err) {
      rows.push({ ...row, error: err.message });
      continue;
    }

    let raw;
    try {
      raw = token ? parseUnits(String(transfer.amount), decimals) : parseEther(String(transfer.amount));
      if (raw <= 0n) throw new Error('Enter an amount above zero.');
    } catch (err) {
      rows.push({ ...row, error: err.message.includes('above zero') ? err.message : 'That amount is not valid.' });
      continue;
    }
    row.raw = raw.toString();

    // The same address twice in one batch is usually a copy-paste slip, and it
    // is invisible in a list of shortened addresses.
    const key = row.to.toLowerCase();
    if (seen.has(key)) row.duplicateOf = seen.get(key);
    else seen.set(key, index);

    // Screened per row: first-time recipients, contracts, and lookalikes all
    // matter more here than in a single send, because nobody reads twenty rows
    // as carefully as they read one.
    row.inspection = await inspectRecipient(row.to, chain, { tokenAddress }).catch(() => null);

    rows.push(row);
  }

  const valid = rows.filter((row) => !row.error);
  if (!valid.length) throw new Error('None of these transfers are valid.');

  const totalRaw = valid.reduce((sum, row) => sum + BigInt(row.raw), 0n);

  // One representative estimate rather than N. The transfers are the same shape
  // as each other, so estimating each would multiply RPC calls for a number
  // that barely differs.
  const sample = valid[0];
  const gasInfo = await estimateGas({
    from,
    to: token ? token.address : sample.to,
    value: token ? '0x0' : `0x${BigInt(sample.raw).toString(16)}`,
    data: token ? encodeTransfer(sample.to, sample.amount, decimals) : '0x',
    chainId: chain,
  });

  const perTransferGas = BigInt(gasInfo.gasLimit);
  const feeOption = gasInfo.options.market;
  const unitPrice = BigInt(feeOption.maxFeePerGas ?? feeOption.gasPrice ?? 0);
  const totalGasCost = perTransferGas * unitPrice * BigInt(valid.length);

  const balance = await provider.getBalance(from).catch(() => 0n);
  const nativeNeeded = token ? totalGasCost : totalRaw + totalGasCost;

  const nonceInfo = await getNonceInfo(from, chain).catch(() => null);

  return {
    chainId: chain,
    network,
    token: token ? { address: token.address, symbol: token.symbol, decimals } : null,
    rows,
    valid: valid.length,
    invalid: rows.length - valid.length,
    duplicates: rows.filter((row) => row.duplicateOf != null).length,
    totalRaw: totalRaw.toString(),
    symbol,
    decimals,
    gasInfo,
    // Each transfer is its own transaction and pays its own fee. The total is
    // the number that surprises people.
    totalGasCost: totalGasCost.toString(),
    perTransferGas: perTransferGas.toString(),
    affordable: balance >= nativeNeeded,
    balance: balance.toString(),
    nativeNeeded: nativeNeeded.toString(),
    startNonce: nonceInfo?.next ?? null,
    atomic: false,
  };
}

/**
 * Dispatches the batch.
 *
 * Nonces are assigned up front and incremented locally. Reading the pending
 * count per send would return the same value for every transfer dispatched
 * before the first reaches the mempool, and they would collide.
 *
 * A failure stops the run rather than skipping ahead: nonces execute in order,
 * so continuing past a gap would leave every remaining transfer stuck behind a
 * nonce that was never broadcast.
 */
export async function sendBatch({ from, chainId, transfers, tokenAddress = null, fees, gas, onProgress }) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);

  let token = null;
  if (tokenAddress) {
    const tracked = await listTokens(chain, { includeHidden: true });
    token = tracked.find((entry) => entry.address.toLowerCase() === tokenAddress.toLowerCase()) ?? null;
    if (!token) throw new Error('That token is not tracked on this network.');
  }
  const decimals = token ? Number(token.decimals) : 18;

  let nonce = await provider.getTransactionCount(from, 'pending');

  const sent = [];
  const failed = [];
  let stoppedAt = null;

  for (const [index, transfer] of transfers.entries()) {
    let to;
    try {
      to = await resolveRecipient(transfer.address);
    } catch (err) {
      failed.push({ index, address: transfer.address, error: err.message });
      continue;
    }

    try {
      const hash = await sendTransaction({
        from,
        to: token ? token.address : to,
        value: token ? '0x0' : `0x${parseEther(String(transfer.amount)).toString(16)}`,
        data: token ? encodeTransfer(to, transfer.amount, decimals) : '0x',
        nonce,
        fees,
        gas,
        chainId: chain,
        meta: {
          kind: 'batchTransfer',
          batchIndex: index + 1,
          batchSize: transfers.length,
          ...(token ? { tokenSymbol: token.symbol, tokenAmount: String(transfer.amount), tokenTo: to } : {}),
        },
      });

      sent.push({ index, to, amount: transfer.amount, hash, nonce });
      nonce += 1;
      onProgress?.({ index, total: transfers.length, hash });
    } catch (err) {
      failed.push({ index, address: transfer.address, error: err.shortMessage ?? err.message });
      // Stop here. The nonce this transfer would have used is now a gap, and
      // everything dispatched after it would sit behind that gap forever.
      stoppedAt = index;
      break;
    }
  }

  return {
    sent,
    failed,
    total: transfers.length,
    stoppedAt,
    // Named explicitly so no caller can present this as all-or-nothing.
    atomic: false,
    remaining: stoppedAt != null ? transfers.length - sent.length - failed.length : 0,
  };
}

export { getAddress };
