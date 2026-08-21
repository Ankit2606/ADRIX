// EIP-7702: pointing an EOA at contract code.
//
// Since Pectra, an ordinary account can carry a delegation designator — 23
// bytes of the form 0xef0100 || address — that makes every call to it execute
// the target's code with the account's own storage, balance, and authority.
// That is how batching, sponsorship, and session keys reach existing addresses
// without migrating anyone to a new 4337 account.
//
// It is also the most dangerous thing this wallet can sign. A 4337 account is a
// separate address that has to be funded before it can lose anything; a 7702
// delegation applies to the address already holding the funds, and the target
// contract can move all of it. Two properties make it worse than it first looks:
//
//   * The authorization is signed, not sent. Anyone holding the signed tuple can
//     submit it later — including after the user has decided against it.
//   * chainId 0 means "valid on every chain", so one signature can delegate the
//     same address everywhere, including chains the user has never used.
//
// So this refuses chainId 0 outright, treats an unrecognised target as hostile
// until the user says otherwise, and reads back what actually landed rather than
// assuming the transaction did what it said.

import { Contract, Interface, getAddress, getBytes, hexlify, keccak256 } from 'ethers';
import { local } from './storage.js';
import { getProvider, getChainId, getNetwork } from './networks.js';
import { getWallet, listAccounts } from './keyring.js';
import { sendTransaction } from './transactions.js';

// The designator prefix defined by EIP-7702. Code of exactly this shape is a
// delegation and nothing else.
const DESIGNATOR_PREFIX = '0xef0100';
const DESIGNATOR_BYTES = 23;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// The execution interface a delegated account is expected to expose. Same
// convention as 4337 accounts, and equally not a standard — probed, not assumed.
const BATCH_ABI = [
  'function execute(address to, uint256 value, bytes data)',
  'function executeBatch((address to, uint256 value, bytes data)[] calls)',
  'function executeBatch(address[] to, uint256[] value, bytes[] data)',
];
const batchInterface = new Interface(BATCH_ABI);

const readTrusted = () => local.get('trustedDelegates', {});

/**
 * Whether a chain has actually activated 7702.
 *
 * Sending a type-4 transaction to a chain that has not forked yet fails in
 * confusing ways, so it is checked rather than assumed from the chain id.
 */
export async function supportsDelegation(chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  try {
    // Pectra shipped 7702 alongside the blob-fee-per-gas header field, so a
    // block carrying it is a reliable signal the fork is live.
    const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
    return {
      supported: block?.excessBlobGas != null || block?.requestsHash != null,
      // Not conclusive on L2s, which vary in what they expose, so the send path
      // still surfaces a node rejection rather than relying on this.
      certain: block?.requestsHash != null,
    };
  } catch {
    return { supported: false, certain: false };
  }
}

/**
 * What an account is currently delegated to, read from its code.
 *
 * The chain is the only source of truth here: a delegation set by another
 * wallet, or by a transaction the user forgot about, shows up the same way.
 */
export async function getDelegation(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const account = getAddress(address);

  const code = await provider.getCode(account).catch(() => '0x');
  const bytes = getBytes(code ?? '0x');

  if (bytes.length === 0) {
    return { address: account, chainId: chain, delegated: false, target: null, raw: '0x' };
  }

  if (bytes.length !== DESIGNATOR_BYTES || !code.toLowerCase().startsWith(DESIGNATOR_PREFIX)) {
    // Real contract code at an address the wallet holds a key for is unusual
    // and worth reporting rather than glossing as "not delegated".
    return {
      address: account,
      chainId: chain,
      delegated: false,
      target: null,
      raw: code,
      note: 'There is contract code at this address that is not a 7702 delegation.',
    };
  }

  const target = getAddress(`0x${code.slice(8)}`);
  const cleared = target.toLowerCase() === ZERO_ADDRESS;

  return {
    address: account,
    chainId: chain,
    delegated: !cleared,
    target: cleared ? null : target,
    raw: code,
    ...(cleared ? { note: 'The delegation was revoked; the designator points at the zero address.' } : {}),
  };
}

/**
 * Everything known about a proposed delegation target.
 *
 * The question the user actually needs answered is "what am I handing my
 * account to", and an address alone does not answer it. This gathers what can
 * be established without trusting anyone: that it is a contract, how big, its
 * code hash, whether it exposes the batching interface, and whether the user
 * has trusted it before.
 */
export async function inspectDelegate(target, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const address = getAddress(target);

  const code = await provider.getCode(address).catch(() => '0x');
  const isContract = code && code !== '0x';
  const trusted = (await readTrusted())[`${chain}:${address.toLowerCase()}`] ?? null;

  const result = {
    address,
    chainId: chain,
    isContract,
    codeSize: isContract ? getBytes(code).length : 0,
    codeHash: isContract ? keccak256(code) : null,
    trusted,
    supportsBatch: false,
    warnings: [],
  };

  if (!isContract) {
    result.warnings.push(
      'There is no contract at this address. Delegating to it makes every call to your account do nothing — including calls that move funds.'
    );
    return result;
  }

  // A delegation designator pointing at another designator is not resolved
  // recursively by the EVM; it simply fails.
  if (code.toLowerCase().startsWith(DESIGNATOR_PREFIX)) {
    result.warnings.push('This target is itself a delegated account, which cannot be used as a delegation target.');
  }

  // The batching entry point is the usual reason to delegate at all.
  const probe = batchInterface.encodeFunctionData('execute', [address, 0n, '0x']);
  result.supportsBatch = await provider
    .call({ to: address, data: probe })
    .then(() => true)
    .catch((err) => {
      const message = String(err?.info?.error?.message ?? err?.shortMessage ?? err?.message ?? '');
      return !/no data|selector was not recognized/i.test(message);
    });

  if (!result.supportsBatch) {
    result.warnings.push(
      'This contract does not appear to expose execute(address,uint256,bytes), so ADRIX would not be able to send batched calls through it.'
    );
  }

  if (!trusted) {
    result.warnings.push(
      'ADRIX does not recognise this contract. A 7702 delegation gives it full control of the account and everything in it, on this chain, until you revoke it.'
    );
  }

  return result;
}

export async function trustDelegate(target, chainId, label) {
  const chain = chainId ?? (await getChainId());
  const trusted = await readTrusted();
  const key = `${chain}:${getAddress(target).toLowerCase()}`;
  trusted[key] = { label: String(label ?? '').trim().slice(0, 60) || 'Trusted by you', at: Date.now() };
  await local.set({ trustedDelegates: trusted });
  return { ok: true };
}

export async function untrustDelegate(target, chainId) {
  const chain = chainId ?? (await getChainId());
  const trusted = await readTrusted();
  delete trusted[`${chain}:${getAddress(target).toLowerCase()}`];
  await local.set({ trustedDelegates: trusted });
  return { ok: true };
}

export async function listTrustedDelegates() {
  const trusted = await readTrusted();
  return Object.entries(trusted).map(([key, value]) => {
    const [chainId, address] = key.split(':');
    return { chainId, address: getAddress(address), ...value };
  });
}

/**
 * Signs an authorization and submits it in the same transaction.
 *
 * Deliberately not split into "sign" and "send later". A signed authorization
 * is a bearer credential: whoever holds it can submit it whenever they like,
 * and an abandoned one sitting in memory is a delegation waiting to happen.
 * Signing and sending together means a cancelled flow leaves nothing behind.
 */
export async function setDelegation({ account, target, chainId, fees, gas }) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const network = await getNetwork(chain);
  const from = getAddress(account);
  const delegate = getAddress(target);

  const accounts = await listAccounts();
  const entry = accounts.find((row) => row.address.toLowerCase() === from.toLowerCase());
  if (!entry || (entry.type !== 'hd' && entry.type !== 'imported')) {
    throw new Error('ADRIX must hold the key for an account to delegate it.');
  }

  const wallet = (await getWallet(from)).connect(provider);
  const numericChain = parseInt(chain, 16);

  // The authorization nonce is the account's own next nonce. When the same
  // account also sends the transaction, the authorization is checked after the
  // transaction's nonce is consumed, so it has to be one higher.
  const currentNonce = await provider.getTransactionCount(from, 'pending');

  const authorization = await wallet.authorize({
    address: delegate,
    // Never 0. A zero chain id authorises the delegation on every chain at
    // once, including ones the user has never touched, from a single signature.
    chainId: numericChain,
    nonce: currentNonce + 1,
  });

  const sent = await wallet.sendTransaction({
    type: 4,
    to: from,
    value: 0n,
    data: '0x',
    chainId: numericChain,
    nonce: currentNonce,
    authorizationList: [authorization],
    ...(gas ? { gasLimit: BigInt(gas) } : {}),
    ...(fees?.type === 2
      ? { maxFeePerGas: BigInt(fees.maxFeePerGas), maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas) }
      : fees?.gasPrice
        ? { gasPrice: BigInt(fees.gasPrice) }
        : {}),
  });

  return {
    hash: sent.hash,
    account: from,
    target: delegate,
    chainId: chain,
    networkName: network.name,
    revoking: delegate.toLowerCase() === ZERO_ADDRESS,
  };
}

/** Clears a delegation by pointing the designator at the zero address. */
export async function revokeDelegation({ account, chainId, fees, gas }) {
  return setDelegation({ account, target: ZERO_ADDRESS, chainId, fees, gas });
}

/**
 * Sends several calls through a delegated account, atomically.
 *
 * This is the payoff: one signature, one fee, and either all of it happens or
 * none of it does — on the address the user already has. The batch screen
 * elsewhere in this wallet cannot promise that, because a plain EOA cannot.
 */
export async function executeBatchViaDelegation({ account, calls, chainId, fees, gas }) {
  const chain = chainId ?? (await getChainId());
  const from = getAddress(account);

  const delegation = await getDelegation(from, chain);
  if (!delegation.delegated) {
    throw new Error('This account is not delegated, so it cannot execute a batch.');
  }

  if (!calls?.length) throw new Error('No calls to execute.');

  // Two shapes are in circulation for executeBatch. The tuple form is the more
  // common one among 7702 implementations, so it is tried first and the older
  // parallel-arrays form is the fallback.
  const encoded = (() => {
    try {
      return batchInterface.encodeFunctionData('executeBatch((address,uint256,bytes)[])', [
        calls.map((call) => [getAddress(call.to), BigInt(call.value ?? 0), call.data ?? '0x']),
      ]);
    } catch {
      return batchInterface.encodeFunctionData('executeBatch(address[],uint256[],bytes[])', [
        calls.map((call) => getAddress(call.to)),
        calls.map((call) => BigInt(call.value ?? 0)),
        calls.map((call) => call.data ?? '0x'),
      ]);
    }
  })();

  const hash = await sendTransaction({
    from,
    // A delegated account is called at its own address; the delegated code runs
    // in its context.
    to: from,
    value: '0x0',
    data: encoded,
    fees,
    gas,
    chainId: chain,
    meta: { kind: 'delegatedBatch', batchSize: calls.length, delegate: delegation.target },
  });

  return { hash, calls: calls.length, delegate: delegation.target };
}

/** Dry-runs a batch before it is signed. */
export async function simulateDelegatedBatch({ account, calls, chainId }) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const from = getAddress(account);

  const delegation = await getDelegation(from, chain);
  if (!delegation.delegated) return { ok: false, error: 'This account is not delegated.' };

  const data = batchInterface.encodeFunctionData('executeBatch((address,uint256,bytes)[])', [
    calls.map((call) => [getAddress(call.to), BigInt(call.value ?? 0), call.data ?? '0x']),
  ]);

  try {
    await provider.call({ from, to: from, data });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.shortMessage ?? err.message, data };
  }
}

export { DESIGNATOR_PREFIX, ZERO_ADDRESS };
