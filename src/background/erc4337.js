// ERC-4337: smart accounts, bundlers, and paymasters.
//
// A user operation is not a transaction. It is a signed intent handed to a
// bundler, which wraps it into a real transaction and submits it to the
// EntryPoint contract. That indirection is what buys sponsorship and batching,
// and it is also why almost none of the wallet's existing transaction machinery
// applies: no nonce from getTransactionCount, no gas from estimateGas, no hash
// until the bundler accepts it.
//
// Three things this is deliberately honest about:
//
//   * A bundler is required and is a third party. Public ones exist; most are
//     keyed. The user supplies the URL, and the wallet says so rather than
//     silently failing when there isn't one.
//   * Call encoding is account-specific. `execute(address,uint256,bytes)` is
//     near-universal across SimpleAccount, Kernel, and friends, but it is a
//     convention, not a standard. An account that does not use it is detected
//     and refused rather than sent calldata it will reject.
//   * A sponsored operation still needs the paymaster to agree. Sponsorship is
//     requested, never assumed, and a refusal is reported as a refusal.

import { Contract, Interface, concat, getAddress, getBytes, toBeHex, zeroPadValue } from 'ethers';
import { local } from './storage.js';
import { getProvider, getChainId } from './networks.js';
import { getWallet, listAccounts } from './keyring.js';

// The canonical EntryPoints. v0.7 is the current one; v0.6 is still widely
// deployed and uses a different UserOperation shape entirely.
export const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
export const ENTRYPOINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

// Public, keyless bundlers. Offered as a default so the feature is usable out
// of the box; the user can point at their own.
const DEFAULT_BUNDLERS = {
  '0x1': 'https://public.pimlico.io/v2/1/rpc',
  '0xaa36a7': 'https://public.pimlico.io/v2/11155111/rpc',
  '0x89': 'https://public.pimlico.io/v2/137/rpc',
  '0xa4b1': 'https://public.pimlico.io/v2/42161/rpc',
  '0xa': 'https://public.pimlico.io/v2/10/rpc',
  '0x2105': 'https://public.pimlico.io/v2/8453/rpc',
};

const ENTRYPOINT_ABI = [
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)',
  'function balanceOf(address account) view returns (uint256)',
];

// The execution interface nearly every 4337 account exposes. Not part of the
// standard — the standard says nothing about how an account executes a call —
// so its presence is verified rather than assumed.
const ACCOUNT_ABI = [
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
  'function entryPoint() view returns (address)',
  'function owner() view returns (address)',
  'function getOwners() view returns (address[])',
];

const accountInterface = new Interface(ACCOUNT_ABI);
const REQUEST_TIMEOUT_MS = 30_000;

const hex = (value) => toBeHex(BigInt(value ?? 0));
const readConfig = () => local.get('aaConfig', {});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export async function getBundlerConfig(chainId) {
  const chain = chainId ?? (await getChainId());
  const config = await readConfig();
  const entry = config[chain] ?? {};
  return {
    chainId: chain,
    bundlerUrl: entry.bundlerUrl || DEFAULT_BUNDLERS[chain] || '',
    paymasterUrl: entry.paymasterUrl || '',
    paymasterContext: entry.paymasterContext || null,
    isDefault: !entry.bundlerUrl && Boolean(DEFAULT_BUNDLERS[chain]),
    hasDefault: Boolean(DEFAULT_BUNDLERS[chain]),
  };
}

export async function setBundlerConfig(chainId, { bundlerUrl, paymasterUrl, paymasterContext }) {
  const chain = chainId ?? (await getChainId());
  for (const url of [bundlerUrl, paymasterUrl]) {
    if (url && !/^https:\/\//i.test(url)) {
      throw new Error('Bundler and paymaster URLs must use https.');
    }
  }
  const config = await readConfig();
  config[chain] = {
    bundlerUrl: String(bundlerUrl ?? '').trim(),
    paymasterUrl: String(paymasterUrl ?? '').trim(),
    paymasterContext: paymasterContext ?? null,
  };
  await local.set({ aaConfig: config });
  return getBundlerConfig(chain);
}

// ---------------------------------------------------------------------------
// Bundler transport
// ---------------------------------------------------------------------------
async function bundlerCall(url, method, params) {
  if (!url) throw new Error('No bundler configured for this network. Add one in Settings → Smart accounts.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => null);

    if (json?.error) {
      // Bundler rejections are the most informative errors in this whole flow —
      // they name the failing validation step — so the message is preserved.
      throw Object.assign(new Error(json.error.message ?? 'The bundler rejected the operation.'), {
        code: json.error.code,
        data: json.error.data,
      });
    }
    if (!response.ok) throw new Error(`The bundler returned ${response.status}.`);
    return json?.result;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The bundler did not respond in time.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function supportedEntryPoints(chainId) {
  const { bundlerUrl } = await getBundlerConfig(chainId);
  const list = await bundlerCall(bundlerUrl, 'eth_supportedEntryPoints', []);
  return (list ?? []).map((address) => getAddress(address));
}

/** Reachability and capability check, for the settings screen. */
export async function testBundler(url, chainId) {
  const chain = chainId ?? (await getChainId());
  const entryPoints = (await bundlerCall(url, 'eth_supportedEntryPoints', [])).map((a) => getAddress(a));
  const reported = await bundlerCall(url, 'eth_chainId', []).catch(() => null);

  const expected = parseInt(chain, 16);
  if (reported != null && parseInt(reported, 16) !== expected) {
    throw new Error(
      `That bundler serves chain ${parseInt(reported, 16)}, not ${expected}. Operations sent to it would be for the wrong network.`
    );
  }

  return {
    ok: true,
    entryPoints,
    supportsV07: entryPoints.some((a) => a.toLowerCase() === ENTRYPOINT_V07.toLowerCase()),
    supportsV06: entryPoints.some((a) => a.toLowerCase() === ENTRYPOINT_V06.toLowerCase()),
    chainId: chain,
  };
}

// ---------------------------------------------------------------------------
// Account inspection
// ---------------------------------------------------------------------------

/**
 * Works out whether an address is a usable 4337 account and which of the
 * wallet's own keys, if any, can sign for it.
 *
 * An account nobody here can sign for is worth tracking but not worth offering
 * a send button on, and finding that out at signing time is too late.
 */
export async function inspectSmartAccount(address, chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const target = getAddress(address);

  const code = await provider.getCode(target).catch(() => '0x');
  const deployed = code && code !== '0x';

  const result = {
    address: target,
    chainId: chain,
    deployed,
    entryPoint: null,
    owner: null,
    owners: [],
    signer: null,
    canExecute: false,
    notes: [],
  };

  if (!deployed) {
    // Counterfactual accounts are legitimate — they are deployed by their first
    // operation via initCode — but ADRIX has no factory configured, so it
    // cannot construct that initCode and says so.
    result.notes.push(
      'No contract at this address yet. ADRIX cannot deploy a counterfactual account, so it must be deployed before it can be used here.'
    );
    return result;
  }

  const account = new Contract(target, ACCOUNT_ABI, provider);

  const [entryPoint, owner, owners] = await Promise.all([
    account.entryPoint().catch(() => null),
    account.owner().catch(() => null),
    account.getOwners().catch(() => null),
  ]);

  if (entryPoint) result.entryPoint = getAddress(entryPoint);
  if (owner) result.owner = getAddress(owner);
  if (owners) result.owners = owners.map((a) => getAddress(a));

  // `execute` is a convention, not part of ERC-4337. Probing for it is the
  // difference between refusing up front and building calldata the account
  // will reject after the user has approved it.
  const probe = accountInterface.encodeFunctionData('execute', [target, 0n, '0x']);
  const supportsExecute = await provider
    .call({ to: target, data: probe })
    .then(() => true)
    .catch((err) => {
      // A revert proves the selector exists and ran; "function not found" style
      // failures usually surface as an empty return or a decode error.
      const message = String(err?.info?.error?.message ?? err?.shortMessage ?? err?.message ?? '');
      return !/no data|function selector was not recognized|execution reverted$/i.test(message);
    });

  result.canExecute = supportsExecute;
  if (!supportsExecute) {
    result.notes.push(
      'This contract does not expose execute(address,uint256,bytes). ADRIX only knows that convention, so it cannot build calls for this account.'
    );
  }

  if (!result.entryPoint) {
    result.notes.push('This contract does not report an EntryPoint, so it may not be an ERC-4337 account at all.');
  }

  // Which local key can actually sign for it.
  const candidates = new Set([result.owner, ...result.owners].filter(Boolean).map((a) => a.toLowerCase()));
  const accounts = await listAccounts().catch(() => []);
  const signer = accounts.find(
    (entry) =>
      candidates.has(entry.address.toLowerCase()) && (entry.type === 'hd' || entry.type === 'imported')
  );
  if (signer) result.signer = { address: signer.address, name: signer.name };
  else if (candidates.size) {
    result.notes.push('None of this account\'s owners are keys held by ADRIX, so it cannot sign for it.');
  }

  return result;
}

// ---------------------------------------------------------------------------
// UserOperation construction
// ---------------------------------------------------------------------------

/** Packs two uint128s into the bytes32 fields EntryPoint v0.7 expects. */
const packPair = (high, low) =>
  concat([zeroPadValue(toBeHex(BigInt(high ?? 0)), 16), zeroPadValue(toBeHex(BigInt(low ?? 0)), 16)]);

function toPacked(op) {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode: op.factory ? concat([op.factory, op.factoryData ?? '0x']) : '0x',
    callData: op.callData,
    accountGasLimits: packPair(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas ?? 0),
    gasFees: packPair(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData: op.paymaster
      ? concat([
          op.paymaster,
          zeroPadValue(toBeHex(BigInt(op.paymasterVerificationGasLimit ?? 0)), 16),
          zeroPadValue(toBeHex(BigInt(op.paymasterPostOpGasLimit ?? 0)), 16),
          op.paymasterData ?? '0x',
        ])
      : '0x',
    signature: op.signature ?? '0x',
  };
}

/** The RPC form: every quantity as a hex string, optional fields omitted. */
function toRpc(op) {
  const out = {
    sender: op.sender,
    nonce: hex(op.nonce),
    callData: op.callData,
    callGasLimit: hex(op.callGasLimit ?? 0),
    verificationGasLimit: hex(op.verificationGasLimit ?? 0),
    preVerificationGas: hex(op.preVerificationGas ?? 0),
    maxFeePerGas: hex(op.maxFeePerGas ?? 0),
    maxPriorityFeePerGas: hex(op.maxPriorityFeePerGas ?? 0),
    signature: op.signature ?? '0x',
  };
  if (op.factory) {
    out.factory = op.factory;
    out.factoryData = op.factoryData ?? '0x';
  }
  if (op.paymaster) {
    out.paymaster = op.paymaster;
    out.paymasterVerificationGasLimit = hex(op.paymasterVerificationGasLimit ?? 0);
    out.paymasterPostOpGasLimit = hex(op.paymasterPostOpGasLimit ?? 0);
    out.paymasterData = op.paymasterData ?? '0x';
  }
  return out;
}

/** Encodes one call, or several, into the account's execute interface. */
export function encodeAccountCalls(calls) {
  if (!calls?.length) throw new Error('No calls to execute.');

  if (calls.length === 1) {
    const [call] = calls;
    return accountInterface.encodeFunctionData('execute', [
      getAddress(call.to),
      BigInt(call.value ?? 0),
      call.data ?? '0x',
    ]);
  }

  // Batching is the headline reason to use a smart account at all: several
  // calls, one signature, one fee, and atomic.
  return accountInterface.encodeFunctionData('executeBatch', [
    calls.map((call) => getAddress(call.to)),
    calls.map((call) => BigInt(call.value ?? 0)),
    calls.map((call) => call.data ?? '0x'),
  ]);
}

/**
 * Builds, prices, and optionally sponsors a user operation — everything short
 * of signing it.
 */
export async function prepareUserOperation({ sender, calls, chainId, sponsor = true }) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);
  const config = await getBundlerConfig(chain);

  const entryPoints = await supportedEntryPoints(chain);
  const entryPoint = entryPoints.find((a) => a.toLowerCase() === ENTRYPOINT_V07.toLowerCase());
  if (!entryPoint) {
    throw new Error(
      'This bundler does not support EntryPoint v0.7. ADRIX does not implement the older v0.6 operation format.'
    );
  }

  const account = await inspectSmartAccount(sender, chain);
  if (!account.deployed) throw new Error(account.notes[0]);
  if (!account.canExecute) throw new Error(account.notes.find((note) => note.includes('execute')) ?? 'Unsupported account.');
  if (!account.signer) throw new Error('ADRIX holds no key for any owner of this account.');

  const callData = encodeAccountCalls(calls);

  const entry = new Contract(entryPoint, ENTRYPOINT_ABI, provider);
  const nonce = await entry.getNonce(sender, 0n);

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1_000_000_000n;

  let op = {
    sender: getAddress(sender),
    nonce: nonce.toString(),
    callData,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    // A dummy signature of the right length, so gas estimation accounts for the
    // cost of verifying a real one. Estimating with '0x' undercounts.
    signature: `0x${'ff'.repeat(64)}1c`,
  };

  // --- sponsorship (ERC-7677) ------------------------------------------------
  let sponsorship = { requested: false, granted: false, reason: null, paymaster: null };

  if (sponsor && config.paymasterUrl) {
    sponsorship.requested = true;
    try {
      const stub = await bundlerCall(config.paymasterUrl, 'pm_getPaymasterStubData', [
        toRpc(op),
        entryPoint,
        hex(parseInt(chain, 16)),
        config.paymasterContext ?? {},
      ]);
      if (stub?.paymaster) {
        op = { ...op, ...stub };
        sponsorship.granted = true;
        sponsorship.paymaster = getAddress(stub.paymaster);
      } else {
        sponsorship.reason = 'The paymaster returned no sponsorship data.';
      }
    } catch (err) {
      // A refusal is a legitimate answer — policies have limits — so the
      // operation proceeds unsponsored rather than failing.
      sponsorship.reason = err.message;
    }
  } else if (sponsor && !config.paymasterUrl) {
    sponsorship.reason = 'No paymaster configured, so this operation pays its own gas.';
  }

  // --- gas -------------------------------------------------------------------
  const estimate = await bundlerCall(config.bundlerUrl, 'eth_estimateUserOperationGas', [toRpc(op), entryPoint]);

  op.callGasLimit = estimate.callGasLimit;
  op.verificationGasLimit = estimate.verificationGasLimit;
  op.preVerificationGas = estimate.preVerificationGas;
  if (estimate.paymasterVerificationGasLimit) op.paymasterVerificationGasLimit = estimate.paymasterVerificationGasLimit;
  if (estimate.paymasterPostOpGasLimit) op.paymasterPostOpGasLimit = estimate.paymasterPostOpGasLimit;

  // Final paymaster data is requested after estimation, because it commits to
  // the gas values and a stub signed against different limits is rejected.
  if (sponsorship.granted) {
    try {
      const final = await bundlerCall(config.paymasterUrl, 'pm_getPaymasterData', [
        toRpc(op),
        entryPoint,
        hex(parseInt(chain, 16)),
        config.paymasterContext ?? {},
      ]);
      if (final?.paymaster) op = { ...op, ...final };
    } catch (err) {
      sponsorship.granted = false;
      sponsorship.reason = `The paymaster withdrew sponsorship after gas estimation: ${err.message}`;
      delete op.paymaster;
      delete op.paymasterData;
    }
  }

  const totalGas =
    BigInt(op.callGasLimit) +
    BigInt(op.verificationGasLimit) +
    BigInt(op.preVerificationGas) +
    BigInt(op.paymasterVerificationGasLimit ?? 0) +
    BigInt(op.paymasterPostOpGasLimit ?? 0);
  const maxCost = totalGas * BigInt(op.maxFeePerGas);

  return {
    op,
    entryPoint,
    chainId: chain,
    account,
    sponsorship,
    totalGas: totalGas.toString(),
    // What it costs the *user*. Zero when a paymaster is covering it, which is
    // the entire point of sponsorship and worth stating as a number.
    maxCost: (sponsorship.granted ? 0n : maxCost).toString(),
    maxCostUnsponsored: maxCost.toString(),
    calls,
  };
}

/** Signs the prepared operation with the owner key and hands it to the bundler. */
export async function sendUserOperation({ prepared }) {
  const { op, entryPoint, chainId, account } = prepared;
  const provider = await getProvider(chainId);
  const config = await getBundlerConfig(chainId);

  const entry = new Contract(entryPoint, ENTRYPOINT_ABI, provider);
  // Asked of the EntryPoint itself rather than recomputed locally. The hashing
  // rules changed between v0.6 and v0.7 and a local reimplementation that
  // drifts produces a signature that silently fails validation.
  const userOpHash = await entry.getUserOpHash(toPacked(op));

  const wallet = await getWallet(account.signer.address);
  // Accounts in this family verify against the eth-signed-message form of the
  // hash, which is what signMessage over the raw bytes produces.
  const signature = await wallet.signMessage(getBytes(userOpHash));

  const signed = { ...op, signature };
  const hash = await bundlerCall(config.bundlerUrl, 'eth_sendUserOperation', [toRpc(signed), entryPoint]);

  return { userOpHash: hash ?? userOpHash, entryPoint, chainId, sender: op.sender };
}

/**
 * Where a submitted operation got to.
 *
 * A user operation has no transaction hash until a bundler includes it, and it
 * can be dropped without ever getting one — so "not found" is a normal state
 * for a while, not a failure.
 */
export async function userOperationStatus({ userOpHash, chainId }) {
  const chain = chainId ?? (await getChainId());
  const config = await getBundlerConfig(chain);

  const receipt = await bundlerCall(config.bundlerUrl, 'eth_getUserOperationReceipt', [userOpHash]).catch(() => null);
  if (!receipt) return { status: 'pending', userOpHash };

  return {
    status: receipt.success ? 'confirmed' : 'failed',
    userOpHash,
    transactionHash: receipt.receipt?.transactionHash ?? null,
    blockNumber: receipt.receipt?.blockNumber ? parseInt(receipt.receipt.blockNumber, 16) : null,
    actualGasCost: receipt.actualGasCost ? BigInt(receipt.actualGasCost).toString() : null,
    actualGasUsed: receipt.actualGasUsed ? BigInt(receipt.actualGasUsed).toString() : null,
    // Populated when the operation reverted inside the account, which the outer
    // transaction still reports as a success.
    reason: receipt.reason ?? null,
    paymaster: receipt.paymaster && receipt.paymaster !== '0x0000000000000000000000000000000000000000'
      ? getAddress(receipt.paymaster)
      : null,
  };
}

export { DEFAULT_BUNDLERS };
