// Transaction simulation: what will this actually do to my balances?
//
// eth_estimateGas already tells us whether a transaction reverts. It says
// nothing about what it *moves*, which is the question that matters — a drainer
// approval and a routine swap both estimate cleanly.
//
// Three strategies, best first, because no single RPC method is available
// everywhere:
//
//   1. eth_simulateV1 with traceTransfers. Executes the call and returns every
//      log it emits, including synthesised logs for plain ETH movement. Decoding
//      those gives the complete asset picture — native, ERC-20, ERC-721,
//      ERC-1155 — including transfers to third parties the calldata never
//      mentions. This is the one worth having.
//   2. debug_traceCall with the prestate tracer in diff mode. Gives exact native
//      balance deltas for every touched account, but token balances live in
//      contract storage whose layout is not knowable, so tokens are missed.
//   3. eth_call. Proves whether it reverts and recovers the reason. No transfer
//      information at all; the UI falls back to describing the decoded calldata.
//
// Every result says which strategy produced it and how complete it is. A
// simulation that quietly degrades to "no changes detected" would be worse than
// none at all — that reads as "this transaction is safe".

import { Contract, Interface, formatEther, formatUnits, getAddress, id } from 'ethers';
import { getProvider, getChainId, getNetwork } from './networks.js';
import { ERC20_ABI, listTokens } from './tokens.js';

const TOPIC_TRANSFER = id('Transfer(address,address,uint256)');
const TOPIC_TRANSFER_SINGLE = id('TransferSingle(address,address,address,uint256,uint256)');
const TOPIC_TRANSFER_BATCH = id('TransferBatch(address,address,uint256[],uint256[])');
const TOPIC_APPROVAL = id('Approval(address,address,uint256)');
const TOPIC_APPROVAL_FOR_ALL = id('ApprovalForAll(address,address,bool)');

const UNLIMITED_THRESHOLD = 1n << 255n;

// Addresses that stand in for "the chain's own coin" in a synthesised transfer
// log. Geth's eth_simulateV1 emits native movement from 0xEeee…EEeE, the
// conventional native-token pseudo-address — verified against a live node, not
// assumed. The zero address is accepted too because other implementations use
// it, and reading either one as a real ERC-20 would label every ETH movement as
// an unknown token.
const NATIVE_SENTINELS = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

const isNativeSentinel = (address) => NATIVE_SENTINELS.has(String(address ?? '').toLowerCase());

/**
 * Whether an error means "this node does not serve that method" as opposed to
 * "the method ran and the call failed".
 *
 * The distinction decides whether to try the next strategy or to report the
 * result. Falling through on a real execution failure would downgrade a working
 * simulation to a bare revert check and lose the reason.
 */
function isUnsupported(err) {
  const codes = [err?.code, err?.error?.code, err?.info?.error?.code];
  if (codes.includes(-32601)) return true;
  const message = String(err?.message ?? err?.error?.message ?? '');
  return /does not exist|method not found|not available|not supported|unsupported method/i.test(message);
}

/** Turns a node's execution error into something worth showing a user. */
function humaniseFailure(err) {
  const message = String(err?.error?.message ?? err?.shortMessage ?? err?.message ?? '');
  if (/insufficient funds/i.test(message)) {
    return 'This account does not have enough to cover the amount plus the network fee.';
  }
  if (/nonce too low/i.test(message)) return 'The nonce for this transaction has already been used.';
  if (/gas required exceeds|out of gas/i.test(message)) return 'The transaction runs out of gas at the current limit.';
  return message || 'The node could not execute this transaction.';
}

const eventInterface = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
]);

const addr = (topic) => getAddress(`0x${String(topic).slice(-40)}`);
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

// ---------------------------------------------------------------------------
// Token metadata, cached per chain. A simulation can surface a token the wallet
// has never tracked, and rendering "1000000000000000000 of 0xabc…" is not a
// balance change preview.
// ---------------------------------------------------------------------------
const metadataCache = new Map(); // `${chainId}:${address}` -> { symbol, decimals, name }

async function tokenMetadata(address, chainId, provider) {
  const key = `${chainId}:${address.toLowerCase()}`;
  const cached = metadataCache.get(key);
  if (cached) return cached;

  // A tracked token already has trustworthy metadata, and the user may have
  // corrected its decimals by hand — that correction should hold here too.
  try {
    const tracked = await listTokens(chainId, { includeHidden: true });
    const match = tracked.find((token) => same(token.address, address));
    if (match) {
      const meta = { symbol: match.symbol, decimals: Number(match.decimals), name: match.name, known: true };
      metadataCache.set(key, meta);
      return meta;
    }
  } catch {
    /* fall through to the chain */
  }

  try {
    const contract = new Contract(address, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([
      contract.symbol().catch(() => null),
      contract.decimals().catch(() => null),
    ]);
    const meta = {
      symbol: symbol ?? null,
      decimals: decimals != null ? Number(decimals) : null,
      name: null,
      known: false,
    };
    metadataCache.set(key, meta);
    return meta;
  } catch {
    const meta = { symbol: null, decimals: null, name: null, known: false };
    metadataCache.set(key, meta);
    return meta;
  }
}

// ---------------------------------------------------------------------------
// Log decoding
// ---------------------------------------------------------------------------

/**
 * Turns one log into a movement, or null if it is not one we understand.
 *
 * ERC-20 and ERC-721 share a topic0 and are told apart by shape: ERC-721
 * indexes the token id, giving four topics and empty data, while ERC-20 leaves
 * the amount in data with three topics. Getting this backwards would report a
 * token id as an amount.
 */
function decodeTransferLog(log) {
  const topics = log.topics ?? [];
  if (!topics.length) return null;
  const contract = log.address;

  if (topics[0] === TOPIC_TRANSFER) {
    // With traceTransfers on, plain ETH movement arrives as a synthetic log
    // attributed to a native-token sentinel address rather than a real contract.
    const isNative = isNativeSentinel(contract);

    if (topics.length === 4) {
      return { standard: 'ERC721', contract, from: addr(topics[1]), to: addr(topics[2]), tokenId: BigInt(topics[3]).toString(), amount: 1n };
    }
    if (topics.length === 3) {
      let value = 0n;
      try {
        value = BigInt(log.data ?? '0x0');
      } catch {
        return null;
      }
      return {
        standard: isNative ? 'NATIVE' : 'ERC20',
        contract: isNative ? null : contract,
        from: addr(topics[1]),
        to: addr(topics[2]),
        amount: value,
      };
    }
    return null;
  }

  if (topics[0] === TOPIC_TRANSFER_SINGLE) {
    try {
      const parsed = eventInterface.decodeEventLog('TransferSingle', log.data, topics);
      return {
        standard: 'ERC1155',
        contract,
        from: parsed.from,
        to: parsed.to,
        tokenId: parsed.id.toString(),
        amount: parsed.value,
      };
    } catch {
      return null;
    }
  }

  if (topics[0] === TOPIC_TRANSFER_BATCH) {
    try {
      const parsed = eventInterface.decodeEventLog('TransferBatch', log.data, topics);
      return parsed.ids.map((tokenId, index) => ({
        standard: 'ERC1155',
        contract,
        from: parsed.from,
        to: parsed.to,
        tokenId: tokenId.toString(),
        amount: parsed.values[index],
      }));
    } catch {
      return null;
    }
  }

  return null;
}

function decodeApprovalLog(log) {
  const topics = log.topics ?? [];
  if (!topics.length) return null;

  if (topics[0] === TOPIC_APPROVAL && topics.length >= 3) {
    // Same shape ambiguity as Transfer: four topics means an NFT token id.
    if (topics.length === 4) {
      return {
        standard: 'ERC721',
        contract: log.address,
        owner: addr(topics[1]),
        spender: addr(topics[2]),
        tokenId: BigInt(topics[3]).toString(),
      };
    }
    let value = 0n;
    try {
      value = BigInt(log.data ?? '0x0');
    } catch {
      return null;
    }
    return {
      standard: 'ERC20',
      contract: log.address,
      owner: addr(topics[1]),
      spender: addr(topics[2]),
      amount: value,
      unlimited: value >= UNLIMITED_THRESHOLD,
      revoking: value === 0n,
    };
  }

  if (topics[0] === TOPIC_APPROVAL_FOR_ALL && topics.length >= 3) {
    let approved = false;
    try {
      approved = BigInt(log.data ?? '0x0') !== 0n;
    } catch {
      approved = false;
    }
    return {
      standard: 'ERC721',
      contract: log.address,
      owner: addr(topics[1]),
      spender: addr(topics[2]),
      operator: true,
      approved,
      revoking: !approved,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

async function viaSimulateV1(provider, request) {
  const call = {
    from: request.from,
    to: request.to || undefined,
    value: request.value && request.value !== '0x0' ? request.value : undefined,
    data: request.data && request.data !== '0x' ? request.data : undefined,
  };

  const result = await provider.send('eth_simulateV1', [
    {
      blockStateCalls: [{ calls: [call] }],
      // Skip fee and nonce checks: the point is what the call does, and a user
      // reviewing a transaction has not funded the gas for it yet.
      validation: false,
      // Synthesises logs for plain ETH movement, which otherwise emits nothing.
      traceTransfers: true,
      returnFullTransactions: false,
    },
    'latest',
  ]);

  const block = Array.isArray(result) ? result[0] : result;
  const callResult = block?.calls?.[0];
  if (!callResult) throw new Error('eth_simulateV1 returned no call result');

  const reverted = callResult.status === '0x0' || callResult.status === 0;

  return {
    method: 'eth_simulateV1',
    complete: true,
    reverted,
    revertReason: reverted ? (callResult.error?.message ?? decodeRevert(callResult.returnData)) : null,
    gasUsed: callResult.gasUsed ? BigInt(callResult.gasUsed).toString() : null,
    logs: callResult.logs ?? [],
    returnData: callResult.returnData ?? null,
  };
}

async function viaTraceCall(provider, request) {
  const trace = await provider.send('debug_traceCall', [
    {
      from: request.from,
      to: request.to || undefined,
      value: request.value && request.value !== '0x0' ? request.value : undefined,
      data: request.data && request.data !== '0x' ? request.data : undefined,
    },
    'latest',
    { tracer: 'prestateTracer', tracerConfig: { diffMode: true } },
  ]);

  const pre = trace?.pre ?? {};
  const post = trace?.post ?? {};
  const nativeDeltas = [];

  for (const address of new Set([...Object.keys(pre), ...Object.keys(post)])) {
    const before = pre[address]?.balance != null ? BigInt(pre[address].balance) : null;
    const after = post[address]?.balance != null ? BigInt(post[address].balance) : null;
    // An account appearing in only one side means that side is unchanged, not
    // zero — prestate diffMode omits fields that did not move.
    if (before == null || after == null || before === after) continue;
    nativeDeltas.push({ address: getAddress(address), delta: after - before });
  }

  return {
    method: 'debug_traceCall',
    // Token movement lives in contract storage whose layout is not knowable, so
    // this strategy sees native value only.
    complete: false,
    incompleteReason: 'This node does not support eth_simulateV1, so only native balance changes could be traced. Token movements are not shown.',
    reverted: false,
    revertReason: null,
    nativeDeltas,
    logs: [],
  };
}

async function viaEthCall(provider, request) {
  try {
    await provider.call({
      from: request.from,
      to: request.to || undefined,
      value: request.value || '0x0',
      data: request.data || '0x',
    });
    return {
      method: 'eth_call',
      complete: false,
      incompleteReason:
        'This node supports neither eth_simulateV1 nor debug_traceCall, so ADRIX could only check that the transaction does not revert. No balance changes could be computed.',
      reverted: false,
      revertReason: null,
      logs: [],
    };
  } catch (err) {
    return {
      method: 'eth_call',
      complete: false,
      incompleteReason: 'Only a revert check was possible on this node.',
      reverted: true,
      revertReason: err.shortMessage ?? err.reason ?? err.message,
      logs: [],
    };
  }
}

function decodeRevert(returnData) {
  if (!returnData || returnData === '0x') return 'The transaction reverted without a reason.';
  try {
    // Error(string) selector
    if (returnData.startsWith('0x08c379a0')) {
      const [reason] = new Interface(['function Error(string)']).decodeFunctionData('Error', returnData);
      return reason;
    }
    if (returnData.startsWith('0x4e487b71')) return 'The transaction reverted with a panic (assertion or overflow).';
  } catch {
    /* fall through */
  }
  return `The transaction reverted (${returnData.slice(0, 10)}).`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Simulates a transaction and reports what it moves for `from`.
 *
 * Never throws: a simulation that fails must degrade into an honest "could not
 * determine", because the confirmation screen has to render either way.
 */
export async function simulateTransaction({ from, to, value = '0x0', data = '0x', chainId }) {
  const chain = chainId ?? (await getChainId());
  const network = await getNetwork(chain);
  const provider = await getProvider(chain);
  const request = { from, to, value, data };

  let outcome = null;
  const attempted = [];

  for (const strategy of [viaSimulateV1, viaTraceCall, viaEthCall]) {
    try {
      outcome = await strategy(provider, request);
      break;
    } catch (err) {
      attempted.push({ method: strategy.name, error: err.shortMessage ?? err.message });

      // Only a missing method justifies trying the next strategy. Anything else
      // means this one ran and the transaction itself failed — which is the
      // answer, not a reason to go looking for a weaker method that will report
      // the same failure with less detail.
      if (!isUnsupported(err)) {
        outcome = {
          method: strategy.name === 'viaSimulateV1' ? 'eth_simulateV1' : 'eth_call',
          complete: true,
          reverted: true,
          revertReason: humaniseFailure(err),
          logs: [],
        };
        break;
      }
    }
  }

  if (!outcome) {
    return {
      ok: false,
      method: null,
      complete: false,
      attempted,
      message: 'The node could not simulate this transaction.',
      changes: [],
      approvals: [],
    };
  }

  const { changes, approvals } = await interpret(outcome, { from, chain, provider, network });

  return {
    ok: !outcome.reverted,
    method: outcome.method,
    complete: outcome.complete,
    incompleteReason: outcome.incompleteReason ?? null,
    reverted: outcome.reverted,
    revertReason: outcome.revertReason,
    gasUsed: outcome.gasUsed ?? null,
    changes,
    approvals,
    attempted,
    simulatedAt: Date.now(),
  };
}

/** Folds raw logs or native deltas into per-asset totals for one address. */
async function interpret(outcome, { from, chain, provider, network }) {
  const movements = [];

  for (const log of outcome.logs ?? []) {
    const decoded = decodeTransferLog(log);
    if (!decoded) continue;
    if (Array.isArray(decoded)) movements.push(...decoded);
    else movements.push(decoded);
  }

  // Net per asset. A swap emits an outgoing and an incoming leg for the same
  // account, and occasionally several legs of the same token through a router —
  // showing those separately would be a trace, not a preview.
  const buckets = new Map();

  const bucketFor = (key, seed) => {
    if (!buckets.has(key)) buckets.set(key, { ...seed, delta: 0n });
    return buckets.get(key);
  };

  for (const move of movements) {
    const outgoing = same(move.from, from);
    const incoming = same(move.to, from);
    if (!outgoing && !incoming) continue;
    // A self-transfer nets to zero and is not worth a row.
    if (outgoing && incoming) continue;

    const sign = incoming ? 1n : -1n;
    const key =
      move.standard === 'NATIVE'
        ? 'native'
        : `${move.standard}:${move.contract?.toLowerCase()}:${move.tokenId ?? ''}`;

    const bucket = bucketFor(key, {
      standard: move.standard,
      contract: move.contract ?? null,
      tokenId: move.tokenId ?? null,
      counterparty: incoming ? move.from : move.to,
    });
    bucket.delta += sign * BigInt(move.amount ?? 0n);
  }

  // The trace strategy has no logs, only native deltas.
  for (const entry of outcome.nativeDeltas ?? []) {
    if (!same(entry.address, from)) continue;
    const bucket = bucketFor('native', { standard: 'NATIVE', contract: null, tokenId: null, counterparty: null });
    bucket.delta += entry.delta;
  }

  const changes = [];
  for (const bucket of buckets.values()) {
    if (bucket.delta === 0n) continue;

    if (bucket.standard === 'NATIVE') {
      changes.push({
        standard: 'NATIVE',
        symbol: network.symbol,
        decimals: 18,
        direction: bucket.delta > 0n ? 'in' : 'out',
        raw: bucket.delta.toString(),
        amount: formatEther(bucket.delta < 0n ? -bucket.delta : bucket.delta),
        counterparty: bucket.counterparty,
      });
      continue;
    }

    if (bucket.standard === 'ERC20') {
      const meta = await tokenMetadata(bucket.contract, chain, provider);
      changes.push({
        standard: 'ERC20',
        contract: bucket.contract,
        symbol: meta.symbol,
        decimals: meta.decimals,
        known: meta.known,
        direction: bucket.delta > 0n ? 'in' : 'out',
        raw: bucket.delta.toString(),
        amount:
          meta.decimals != null
            ? formatUnits(bucket.delta < 0n ? -bucket.delta : bucket.delta, meta.decimals)
            : null,
        counterparty: bucket.counterparty,
      });
      continue;
    }

    changes.push({
      standard: bucket.standard,
      contract: bucket.contract,
      tokenId: bucket.tokenId,
      direction: bucket.delta > 0n ? 'in' : 'out',
      raw: (bucket.delta < 0n ? -bucket.delta : bucket.delta).toString(),
      amount: (bucket.delta < 0n ? -bucket.delta : bucket.delta).toString(),
      counterparty: bucket.counterparty,
    });
  }

  // Approvals the transaction grants. These move nothing now, which is exactly
  // why they need surfacing beside the balance changes rather than under them.
  const approvals = [];
  for (const log of outcome.logs ?? []) {
    const decoded = decodeApprovalLog(log);
    if (!decoded || !same(decoded.owner, from)) continue;

    const meta = decoded.standard === 'ERC20' ? await tokenMetadata(decoded.contract, chain, provider) : null;
    approvals.push({
      ...decoded,
      amount: decoded.amount != null ? decoded.amount.toString() : null,
      symbol: meta?.symbol ?? null,
      decimals: meta?.decimals ?? null,
      displayAmount:
        decoded.amount != null && meta?.decimals != null ? formatUnits(decoded.amount, meta.decimals) : null,
    });
  }

  // Biggest movement first, outgoing before incoming at equal size: what leaves
  // is what the user needs to check.
  changes.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === 'out' ? -1 : 1;
    return 0;
  });

  return { changes, approvals };
}

export function clearSimulationCache() {
  metadataCache.clear();
}
