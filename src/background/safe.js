// Safe multisig support.
//
// A multisig transaction is not one signature, it is a coordination problem:
// owner A signs, owner B signs, and only when the threshold is met can anyone
// execute. The signatures have to reach each other somehow, and the wallet is
// not a server — so this uses the Safe Transaction Service, which is the shared
// inbox every Safe front-end already uses. Reads and confirmations work without
// an API key.
//
// What the wallet does on its own: reading the Safe's live state from the chain
// (owners, threshold, nonce), computing the SafeTx hash, producing an EIP-712
// signature as an owner, and assembling the concatenated signature blob that
// execTransaction wants. Only the message passing goes through the service, and
// a Safe with no service on its chain still works for signing and executing —
// it just cannot share signatures automatically.

import { Contract, Interface, concat, getAddress, solidityPacked } from 'ethers';
import { getProvider, getChainId } from './networks.js';
import { getWallet, listAccounts } from './keyring.js';

const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function isOwner(address owner) view returns (bool)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function approvedHashes(address owner, bytes32 hash) view returns (uint256)',
];

const safeInterface = new Interface(SAFE_ABI);

// Safe runs one service host per chain. Absent means no shared inbox there.
const SERVICE_HOSTS = {
  '0x1': 'https://safe-transaction-mainnet.safe.global',
  '0xaa36a7': 'https://safe-transaction-sepolia.safe.global',
  '0x89': 'https://safe-transaction-polygon.safe.global',
  '0xa4b1': 'https://safe-transaction-arbitrum.safe.global',
  '0xa': 'https://safe-transaction-optimism.safe.global',
  '0x2105': 'https://safe-transaction-base.safe.global',
  '0x38': 'https://safe-transaction-bsc.safe.global',
};

const ZERO = '0x0000000000000000000000000000000000000000';
const REQUEST_TIMEOUT_MS = 20_000;

export const hasSafeService = (chainId) => Boolean(SERVICE_HOSTS[chainId]);

async function service(chainId, path, options) {
  const host = SERVICE_HOSTS[chainId];
  if (!host) throw new Error('Safe does not run a transaction service on this network.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${host}/api/v1${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', accept: 'application/json', ...(options?.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;

    if (!response.ok) {
      // The service returns field-level validation errors, which are far more
      // useful than the status code on its own.
      const detail =
        json?.detail ??
        json?.nonFieldErrors?.[0] ??
        (json && typeof json === 'object' ? JSON.stringify(json).slice(0, 200) : null);
      throw new Error(detail ?? `The Safe service returned ${response.status}.`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The Safe service did not respond in time.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Reading a Safe
// ---------------------------------------------------------------------------

/**
 * Live Safe state, read from the chain rather than the service.
 *
 * The chain is authoritative: an owner removed five minutes ago is still listed
 * by a stale index, and signing against a stale owner set produces a signature
 * the Safe will reject.
 */
export async function inspectSafe(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const target = getAddress(address);

  const code = await provider.getCode(target).catch(() => '0x');
  if (!code || code === '0x') {
    return { address: target, chainId: chain, isSafe: false, reason: 'There is no contract at this address.' };
  }

  const safe = new Contract(target, SAFE_ABI, provider);
  const [owners, threshold, nonce, version] = await Promise.all([
    safe.getOwners().catch(() => null),
    safe.getThreshold().catch(() => null),
    safe.nonce().catch(() => null),
    safe.VERSION().catch(() => null),
  ]);

  if (!owners || threshold == null) {
    return {
      address: target,
      chainId: chain,
      isSafe: false,
      reason: 'This contract does not expose getOwners() and getThreshold(), so it is not a Safe.',
    };
  }

  const ownerList = owners.map((owner) => getAddress(owner));
  const accounts = await listAccounts().catch(() => []);
  // Which owners this wallet can actually sign as. A Safe nobody here owns is
  // watchable but not signable, and that distinction drives the whole UI.
  const localOwners = accounts
    .filter(
      (account) =>
        (account.type === 'hd' || account.type === 'imported') &&
        ownerList.some((owner) => owner.toLowerCase() === account.address.toLowerCase())
    )
    .map((account) => ({ address: account.address, name: account.name }));

  return {
    address: target,
    chainId: chain,
    isSafe: true,
    owners: ownerList,
    threshold: Number(threshold),
    nonce: Number(nonce ?? 0),
    version: version ?? 'unknown',
    localOwners,
    canSign: localOwners.length > 0,
    serviceAvailable: hasSafeService(chain),
  };
}

/**
 * The EIP-712 domain for a Safe transaction.
 *
 * Safe changed this at 1.3.0: earlier versions omit chainId, so the same
 * payload hashes differently. Getting it wrong produces a signature that
 * validates nowhere.
 */
function safeDomain(safeAddress, chainId, version) {
  const major = Number(String(version ?? '').split('.')[0] ?? 0);
  const minor = Number(String(version ?? '').split('.')[1] ?? 0);
  const includesChainId = major > 1 || (major === 1 && minor >= 3);

  return includesChainId
    ? { chainId: parseInt(chainId, 16), verifyingContract: safeAddress }
    : { verifyingContract: safeAddress };
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

function normaliseSafeTx(input, nonce) {
  return {
    to: getAddress(input.to),
    value: BigInt(input.value ?? 0).toString(),
    data: input.data ?? '0x',
    // Delegate calls run arbitrary code in the Safe's own context and can
    // rewrite its owners. Defaulted off, and flagged loudly when requested.
    operation: Number(input.operation ?? 0),
    safeTxGas: BigInt(input.safeTxGas ?? 0).toString(),
    baseGas: BigInt(input.baseGas ?? 0).toString(),
    gasPrice: BigInt(input.gasPrice ?? 0).toString(),
    gasToken: input.gasToken ? getAddress(input.gasToken) : ZERO,
    refundReceiver: input.refundReceiver ? getAddress(input.refundReceiver) : ZERO,
    nonce: Number(input.nonce ?? nonce),
  };
}

/** Builds a transaction and asks the Safe itself for its hash. */
export async function buildSafeTransaction({ safeAddress, chainId, to, value = 0, data = '0x', operation = 0, nonce }) {
  const chain = chainId ?? (await getChainId());
  const info = await inspectSafe(safeAddress, chain);
  if (!info.isSafe) throw new Error(info.reason);

  const tx = normaliseSafeTx({ to, value, data, operation }, nonce ?? info.nonce);

  const provider = await getProvider(chain);
  const safe = new Contract(info.address, SAFE_ABI, provider);
  // Asked of the contract rather than computed locally, so a version quirk in
  // the domain separator cannot silently produce an unusable hash.
  const safeTxHash = await safe.getTransactionHash(
    tx.to,
    tx.value,
    tx.data,
    tx.operation,
    tx.safeTxGas,
    tx.baseGas,
    tx.gasPrice,
    tx.gasToken,
    tx.refundReceiver,
    tx.nonce
  );

  const warnings = [];
  if (tx.operation === 1) {
    warnings.push(
      'This is a delegate call. It executes another contract\'s code with the Safe\'s own permissions and can change its owners or threshold.'
    );
  }
  if (tx.nonce < info.nonce) {
    warnings.push(`Nonce ${tx.nonce} is below the Safe's current nonce of ${info.nonce}, so this can never execute.`);
  }

  return { safe: info, tx, safeTxHash, warnings, domain: safeDomain(info.address, chain, info.version) };
}

/** Signs a SafeTx as one owner. Produces an EIP-712 signature, not an eth_sign one. */
export async function signSafeTransaction({ safeAddress, chainId, tx, ownerAddress }) {
  const chain = chainId ?? (await getChainId());
  const info = await inspectSafe(safeAddress, chain);
  if (!info.isSafe) throw new Error(info.reason);

  const owner = getAddress(ownerAddress);
  if (!info.owners.some((entry) => entry.toLowerCase() === owner.toLowerCase())) {
    throw new Error('That account is not an owner of this Safe.');
  }

  const wallet = await getWallet(owner);
  const signature = await wallet.signTypedData(
    safeDomain(info.address, chain, info.version),
    SAFE_TX_TYPES,
    normaliseSafeTx(tx, info.nonce)
  );

  return { owner, signature };
}

/**
 * Concatenates owner signatures into the blob execTransaction expects.
 *
 * Safe requires them ordered by owner address ascending and validates that
 * ordering — an unsorted blob is rejected even when every signature in it is
 * valid, which is a genuinely confusing failure to debug.
 */
export function encodeSignatures(confirmations = []) {
  return concat(
    [...confirmations]
      .filter((entry) => entry.signature && entry.owner)
      .sort((a, b) => (a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1))
      .map((entry) => entry.signature)
  );
}

// ---------------------------------------------------------------------------
// The shared inbox
// ---------------------------------------------------------------------------

/** Transactions waiting on signatures, newest nonce last. */
export async function listPendingSafeTransactions(safeAddress, chainId) {
  const chain = chainId ?? (await getChainId());
  if (!hasSafeService(chain)) return { pending: [], serviceAvailable: false };

  const address = getAddress(safeAddress);
  const info = await inspectSafe(address, chain);

  const json = await service(
    chain,
    `/safes/${address}/multisig-transactions/?executed=false&limit=20&ordering=nonce`
  );

  const pending = (json?.results ?? [])
    // The service keeps historical entries below the current nonce that can
    // never execute. Showing them as "pending" would be wrong.
    .filter((entry) => Number(entry.nonce) >= info.nonce)
    .map((entry) => {
      const confirmations = (entry.confirmations ?? []).map((c) => ({
        owner: getAddress(c.owner),
        signature: c.signature,
        submittedAt: c.submissionDate ? Date.parse(c.submissionDate) : null,
      }));
      const required = entry.confirmationsRequired ?? info.threshold;
      const signedByMe = info.localOwners.filter((owner) =>
        confirmations.some((c) => c.owner.toLowerCase() === owner.address.toLowerCase())
      );

      return {
        safeTxHash: entry.safeTxHash,
        nonce: Number(entry.nonce),
        to: entry.to ? getAddress(entry.to) : null,
        value: entry.value ?? '0',
        data: entry.data ?? '0x',
        operation: Number(entry.operation ?? 0),
        safeTxGas: entry.safeTxGas ?? '0',
        baseGas: entry.baseGas ?? '0',
        gasPrice: entry.gasPrice ?? '0',
        gasToken: entry.gasToken ?? ZERO,
        refundReceiver: entry.refundReceiver ?? ZERO,
        submittedAt: entry.submissionDate ? Date.parse(entry.submissionDate) : null,
        proposer: entry.proposer ? getAddress(entry.proposer) : null,
        confirmations,
        confirmationsRequired: required,
        // What the user can actually do with this row, which is the only thing
        // the list is really for.
        ready: confirmations.length >= required,
        needs: Math.max(0, required - confirmations.length),
        signedByMe: signedByMe.map((owner) => owner.address),
        canSign: info.localOwners.length > signedByMe.length,
        // A nonce already taken by another queued transaction means only one of
        // them will ever execute.
        conflictsWithNonce: false,
      };
    });

  // Flag same-nonce collisions, which the Safe UI calls out and people miss.
  const byNonce = new Map();
  for (const entry of pending) byNonce.set(entry.nonce, (byNonce.get(entry.nonce) ?? 0) + 1);
  for (const entry of pending) entry.conflictsWithNonce = (byNonce.get(entry.nonce) ?? 0) > 1;

  return { pending, serviceAvailable: true, safe: info };
}

/** Publishes a new transaction for the other owners to sign. */
export async function proposeSafeTransaction({ safeAddress, chainId, tx, safeTxHash, ownerAddress, signature }) {
  const chain = chainId ?? (await getChainId());
  const address = getAddress(safeAddress);

  await service(chain, `/safes/${address}/multisig-transactions/`, {
    method: 'POST',
    body: JSON.stringify({
      to: tx.to,
      value: String(tx.value),
      data: tx.data === '0x' ? null : tx.data,
      operation: tx.operation,
      safeTxGas: String(tx.safeTxGas),
      baseGas: String(tx.baseGas),
      gasPrice: String(tx.gasPrice),
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: String(tx.nonce),
      contractTransactionHash: safeTxHash,
      sender: getAddress(ownerAddress),
      signature,
      origin: 'ADRIX',
    }),
  });

  return { safeTxHash, proposed: true };
}

/** Adds one more owner's signature to an existing proposal. */
export async function confirmSafeTransaction({ chainId, safeTxHash, signature }) {
  const chain = chainId ?? (await getChainId());
  await service(chain, `/multisig-transactions/${safeTxHash}/confirmations/`, {
    method: 'POST',
    body: JSON.stringify({ signature }),
  });
  return { safeTxHash, confirmed: true };
}

/**
 * Builds the execTransaction calldata once the threshold is met.
 *
 * Executing is an ordinary transaction paid for by whoever submits it — the
 * executor spends their own gas on the Safe's behalf, which is worth being
 * clear about since it is not the Safe's balance being used.
 */
export function encodeExecution({ tx, confirmations }) {
  return safeInterface.encodeFunctionData('execTransaction', [
    tx.to,
    BigInt(tx.value ?? 0),
    tx.data ?? '0x',
    Number(tx.operation ?? 0),
    BigInt(tx.safeTxGas ?? 0),
    BigInt(tx.baseGas ?? 0),
    BigInt(tx.gasPrice ?? 0),
    tx.gasToken ?? ZERO,
    tx.refundReceiver ?? ZERO,
    encodeSignatures(confirmations),
  ]);
}

/** Simulates the execution before it is paid for. */
export async function checkExecutable({ safeAddress, chainId, tx, confirmations, executor }) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const data = encodeExecution({ tx, confirmations });

  try {
    await provider.call({ from: executor, to: getAddress(safeAddress), data, value: 0 });
    return { ok: true, data };
  } catch (err) {
    const message = String(err?.shortMessage ?? err?.message ?? '');
    // Safe's own error codes are famously opaque; the common ones are worth
    // translating rather than passing through.
    const known = {
      GS020: 'Not enough signatures were provided.',
      GS021: 'A signature is malformed.',
      GS022: 'A signature is invalid for this transaction hash.',
      GS023: 'A signature came from an address that is not an owner.',
      GS025: 'The signatures are not sorted by owner address.',
      GS026: 'One of the signatures is invalid.',
      GS013: 'The inner transaction reverted.',
    };
    const code = Object.keys(known).find((entry) => message.includes(entry));
    return { ok: false, data, error: code ? `${code}: ${known[code]}` : message };
  }
}

export { SAFE_TX_TYPES, safeDomain };
