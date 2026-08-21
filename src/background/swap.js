// Swap and bridge, via the LI.FI aggregator.
//
// Same API for both: a quote where fromChain equals toChain is a swap, and one
// where they differ is a bridge. LI.FI returns a ready-to-sign transaction,
// which is convenient and is also the thing to be careful about — it is
// calldata authored by a third party, aimed at a contract the user has never
// heard of, and the wallet is being asked to sign it.
//
// So nothing here is trusted on presentation:
//
//   * The returned transaction is checked against the quote it claims to
//     fulfil — right chain, right sender, and a `to` that matches the contract
//     the quote named.
//   * It is then simulated locally, with the wallet's own simulator, and the
//     user sees what actually moves rather than what the aggregator says will.
//     A quote promising 2,370 USDC and calldata delivering none looks identical
//     until something executes it.
//   * The minimum-received figure is taken from the quote and shown as the
//     number that matters, because the headline rate is not guaranteed.
//
// ADRIX earns nothing from this. There is no integrator fee attached.

import { Contract, getAddress } from 'ethers';
import { getProvider, getChainId, allNetworks } from './networks.js';
import { ERC20_ABI } from './tokens.js';
import { simulateTransaction } from './simulation.js';
import { sendTransaction } from './transactions.js';

const API = 'https://li.quest/v1';
const REQUEST_TIMEOUT_MS = 25_000;

// LI.FI's marker for a chain's own coin, distinct from any contract.
export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export const DEFAULT_SLIPPAGE = 0.005; // 0.5%
export const MAX_SLIPPAGE = 0.05; //  5%

const toDecimalChain = (chainId) => parseInt(chainId, 16);
const toHexChain = (numeric) => `0x${Number(numeric).toString(16)}`;
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const json = await response.json().catch(() => null);

    if (!response.ok) {
      // LI.FI puts the useful part in `message`; the HTTP status alone is not
      // something a user can act on.
      throw new Error(json?.message ?? `The quote service returned ${response.status}.`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The quote service did not respond in time.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------
let chainCache = null;
const CHAIN_TTL_MS = 60 * 60 * 1000;

/** Chains the aggregator supports, intersected with the ones ADRIX has. */
export async function supportedChains() {
  if (chainCache && Date.now() - chainCache.at < CHAIN_TTL_MS) return chainCache.value;

  const json = await getJson(`${API}/chains`);
  const supported = new Map((json.chains ?? []).map((chain) => [chain.id, chain]));
  const wallet = await allNetworks();

  const value = Object.values(wallet)
    .filter((net) => supported.has(toDecimalChain(net.chainId)))
    .map((net) => ({
      chainId: net.chainId,
      numericId: toDecimalChain(net.chainId),
      name: net.name,
      symbol: net.symbol,
      testnet: Boolean(net.testnet),
    }));

  chainCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/**
 * Fetches a route and normalises it into the handful of numbers a person
 * actually needs to decide: what goes out, what comes back, the worst case, the
 * cost, and how long it takes.
 */
export async function getQuote({
  fromChainId,
  toChainId,
  fromToken,
  toToken,
  fromAmountRaw,
  fromAddress,
  slippage = DEFAULT_SLIPPAGE,
  gasRefuelRaw = null,
}) {
  if (!fromAddress) throw new Error('No account selected.');
  if (!fromAmountRaw || BigInt(fromAmountRaw) <= 0n) throw new Error('Enter an amount greater than zero.');

  const bounded = Math.min(Math.max(Number(slippage) || DEFAULT_SLIPPAGE, 0.0001), MAX_SLIPPAGE);

  const params = new URLSearchParams({
    fromChain: String(toDecimalChain(fromChainId)),
    toChain: String(toDecimalChain(toChainId)),
    fromToken,
    toToken,
    fromAddress,
    fromAmount: String(fromAmountRaw),
    slippage: String(bounded),
  });

  // Cross-chain gas: part of what is being sent is converted into the
  // destination chain's native coin and delivered alongside it. This is the
  // answer to arriving on a new chain with tokens and no way to move them —
  // the classic bridging dead end, where the funds are there and unusable.
  if (gasRefuelRaw && BigInt(gasRefuelRaw) > 0n) {
    params.set('fromAmountForGas', String(gasRefuelRaw));
  }

  const raw = await getJson(`${API}/quote?${params}`);
  if (!raw?.transactionRequest) {
    throw new Error(raw?.message ?? 'No route was found for that pair and amount.');
  }

  const estimate = raw.estimate ?? {};
  const action = raw.action ?? {};

  const fromUsd = Number(estimate.fromAmountUSD);
  const toUsd = Number(estimate.toAmountUSD);
  // Price impact from the two USD legs. Only meaningful when the aggregator
  // priced both sides; a missing leg gives null rather than a made-up zero.
  const priceImpact =
    Number.isFinite(fromUsd) && Number.isFinite(toUsd) && fromUsd > 0
      ? ((toUsd - fromUsd) / fromUsd) * 100
      : null;

  const gasUsd = (estimate.gasCosts ?? []).reduce((sum, cost) => sum + (Number(cost.amountUSD) || 0), 0);
  const feeUsd = (estimate.feeCosts ?? []).reduce((sum, cost) => sum + (Number(cost.amountUSD) || 0), 0);

  return {
    id: raw.id ?? null,
    kind: same(fromChainId, toChainId) ? 'swap' : 'bridge',
    tool: raw.toolDetails?.name ?? raw.tool ?? 'unknown route',
    toolLogo: raw.toolDetails?.logoURI ?? null,

    fromChainId,
    toChainId,
    fromToken: normaliseToken(action.fromToken),
    toToken: normaliseToken(action.toToken),

    fromAmountRaw: String(action.fromAmount ?? fromAmountRaw),
    toAmountRaw: String(estimate.toAmount ?? '0'),
    // What is actually guaranteed. The headline figure is an estimate; this is
    // the floor the transaction reverts below.
    toAmountMinRaw: String(estimate.toAmountMin ?? '0'),

    fromAmountUsd: Number.isFinite(fromUsd) ? fromUsd : null,
    toAmountUsd: Number.isFinite(toUsd) ? toUsd : null,
    priceImpact,
    gasUsd: gasUsd || null,
    feeUsd: feeUsd || null,
    fees: (estimate.feeCosts ?? []).map((cost) => ({
      name: cost.name,
      amountUsd: Number(cost.amountUSD) || null,
      included: Boolean(cost.included),
    })),

    slippage: bounded,
    gasRefuelRaw: gasRefuelRaw ? String(gasRefuelRaw) : null,
    // The delivered gas leg, when one was requested. Reported separately from
    // route fees because it is not a cost — it is part of the amount, arriving
    // in a different form.
    refuel: (estimate.gasCosts ?? [])
      .filter((cost) => String(cost.type).toUpperCase() === 'SEND')
      .map((cost) => ({ amount: cost.amount, amountUsd: Number(cost.amountUSD) || null, token: cost.token?.symbol ?? null }))[0] ?? null,
    durationSeconds: Number(estimate.executionDuration) || null,
    steps: (raw.includedSteps ?? []).map((step) => ({
      tool: step.toolDetails?.name ?? step.tool,
      type: step.type,
      fromChain: step.action?.fromChainId,
      toChain: step.action?.toChainId,
    })),

    // The ERC-20 spender that needs an allowance. Null for a native-token sale.
    approvalAddress: estimate.approvalAddress ?? null,
    transactionRequest: raw.transactionRequest,
    fetchedAt: Date.now(),
  };
}

function normaliseToken(token) {
  if (!token) return null;
  return {
    address: token.address,
    symbol: token.symbol,
    decimals: Number(token.decimals),
    name: token.name,
    logoURI: token.logoURI ?? null,
    priceUSD: Number(token.priceUSD) || null,
    native: same(token.address, NATIVE_TOKEN),
  };
}

// ---------------------------------------------------------------------------
// Allowance
// ---------------------------------------------------------------------------

/** Whether the router already has enough allowance to pull the input token. */
export async function checkSwapAllowance({ chainId, token, owner, spender, amountRaw }) {
  if (!spender || same(token, NATIVE_TOKEN)) {
    // Selling the chain's own coin needs no allowance; the value rides along
    // with the transaction.
    return { needed: false, allowance: null };
  }

  const provider = await getProvider(chainId);
  const contract = new Contract(getAddress(token), ERC20_ABI, provider);
  const allowance = await contract.allowance(owner, spender).catch(() => 0n);

  return {
    needed: allowance < BigInt(amountRaw),
    allowance: allowance.toString(),
    spender: getAddress(spender),
  };
}

/**
 * Approves exactly the amount being swapped, not an unlimited allowance.
 *
 * An unlimited approval to a router is convenient and is also the single most
 * common way funds are lost long after the fact. The extra approval on the next
 * swap costs gas; leaving a standing unlimited allowance to a contract can cost
 * everything.
 */
export async function approveForSwap({ chainId, token, spender, amountRaw, from, fees, gas }) {
  const provider = await getProvider(chainId);
  const contract = new Contract(getAddress(token), ERC20_ABI, provider);
  const data = contract.interface.encodeFunctionData('approve', [getAddress(spender), BigInt(amountRaw)]);

  return sendTransaction({
    from,
    to: getAddress(token),
    value: '0x0',
    data,
    fees,
    gas,
    chainId,
    meta: { kind: 'swapApproval', swapSpender: getAddress(spender) },
  });
}

// ---------------------------------------------------------------------------
// Verification and execution
// ---------------------------------------------------------------------------

/**
 * Checks the aggregator's transaction against the quote it claims to fulfil,
 * then simulates it locally.
 *
 * The quote and the calldata arrive in the same response from the same server.
 * Reading the quote back to the user and signing the calldata unexamined would
 * verify nothing at all — the whole point is that the wallet forms its own view
 * of what the transaction does.
 */
export async function verifyQuote(quote, { from, allowanceReady = null }) {
  const problems = [];
  const request = quote.transactionRequest ?? {};

  // Whether the router can actually pull the input token yet. Until it can, the
  // swap reverts on the allowance check and the simulation says nothing about
  // whether the route is honest — so the delivery assertion below has to be
  // held back rather than fired as a false alarm that blocks the whole flow.
  const needsApprovalFirst =
    allowanceReady === false && !same(quote.fromToken?.address, NATIVE_TOKEN);

  const expectedChain = toDecimalChain(quote.fromChainId);
  const requestChain = request.chainId != null ? Number(request.chainId) : null;
  if (requestChain !== expectedChain) {
    problems.push(
      `The route is for chain ${expectedChain} but its transaction targets chain ${requestChain}. ADRIX will not sign this.`
    );
  }

  if (request.from && !same(request.from, from)) {
    problems.push('The transaction is addressed from a different account than the one selected.');
  }

  if (!request.to) {
    problems.push('The route did not include a destination contract.');
  } else if (quote.approvalAddress && !same(request.to, quote.approvalAddress)) {
    // Not fatal — LI.FI legitimately routes some orders through a different
    // executor than the approval target — but it is worth stating, because the
    // contract being called is not the one the allowance was granted to.
    problems.push(
      `The transaction calls ${request.to}, which is not the contract the approval was granted to (${quote.approvalAddress}). Check this is expected.`
    );
  }

  const simulation = await simulateTransaction({
    from,
    to: request.to,
    value: request.value ?? '0x0',
    data: request.data ?? '0x',
    chainId: quote.fromChainId,
  }).catch(() => null);

  // Cross-chain routes cannot be verified this way: the input leg burns or
  // locks the token here and the output arrives on another chain, later, in a
  // transaction that does not exist yet. Saying so is better than showing a
  // simulation that appears to lose the money.
  const crossChain = quote.kind === 'bridge';

  let deliveryConfirmed = null;
  if (simulation?.complete && !crossChain && !needsApprovalFirst) {
    const expected = BigInt(quote.toAmountMinRaw || '0');
    const received = (simulation.changes ?? []).find(
      (change) =>
        change.direction === 'in' &&
        (quote.toToken?.native
          ? change.standard === 'NATIVE'
          : same(change.contract, quote.toToken?.address))
    );
    const receivedRaw = received ? BigInt(received.raw) : 0n;
    deliveryConfirmed = expected > 0n ? receivedRaw >= expected : receivedRaw > 0n;

    if (!deliveryConfirmed) {
      problems.push(
        `Simulation shows this returns ${received ? received.amount : 'nothing'} of ${quote.toToken?.symbol ?? 'the output token'}, but the quote promised at least ${quote.toAmountMinRaw}. Do not sign this.`
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    // Suppressed while the route cannot execute: a revert caused by a missing
    // allowance is not evidence about the route, and showing it as one would
    // read as "this transaction fails" for every ERC-20 swap ever made.
    simulation: needsApprovalFirst ? null : simulation,
    crossChain,
    deliveryConfirmed,
    pendingApproval: needsApprovalFirst,
  };
}

export async function executeQuote({ quote, from, fees, gas }) {
  const request = quote.transactionRequest ?? {};

  // Re-checked here rather than trusting the review screen to have done it: the
  // chain can be switched between review and confirm. By this point the
  // allowance must exist, so the delivery assertion is live and authoritative.
  const verification = await verifyQuote(quote, { from, allowanceReady: true });
  const fatal = verification.problems.filter((problem) => /will not sign|do not sign/i.test(problem));
  if (fatal.length) throw new Error(fatal[0]);

  return sendTransaction({
    from,
    to: request.to,
    value: request.value ?? '0x0',
    data: request.data ?? '0x',
    fees,
    // The aggregator's own gas limit is used when the caller has not supplied
    // one: these routes are long and a generic estimate often undershoots.
    gas: gas ?? (request.gasLimit ? BigInt(request.gasLimit).toString() : undefined),
    chainId: quote.fromChainId,
    meta: {
      kind: quote.kind,
      swapTool: quote.tool,
      swapFrom: `${quote.fromToken?.symbol}`,
      swapTo: `${quote.toToken?.symbol}`,
      swapToChain: quote.toChainId,
      swapMinOut: quote.toAmountMinRaw,
      lifiId: quote.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Cross-chain status
// ---------------------------------------------------------------------------

/**
 * Tracks a bridge to its destination.
 *
 * The source transaction confirming means nothing arrived — the funds are in
 * flight and land in a separate transaction on another chain, minutes later. A
 * wallet that shows "confirmed" and stops there is describing half the operation.
 */
export async function bridgeStatus({ txHash, fromChainId, toChainId, tool }) {
  const params = new URLSearchParams({ txHash });
  if (fromChainId) params.set('fromChain', String(toDecimalChain(fromChainId)));
  if (toChainId) params.set('toChain', String(toDecimalChain(toChainId)));
  if (tool) params.set('bridge', tool);

  const json = await getJson(`${API}/status?${params}`);

  return {
    status: json.status ?? 'UNKNOWN', // NOT_FOUND | INVALID | PENDING | DONE | FAILED
    substatus: json.substatus ?? null,
    message: json.substatusMessage ?? null,
    sending: json.sending
      ? { txHash: json.sending.txHash, chainId: json.sending.chainId ? toHexChain(json.sending.chainId) : null }
      : null,
    receiving: json.receiving
      ? {
          txHash: json.receiving.txHash,
          chainId: json.receiving.chainId ? toHexChain(json.receiving.chainId) : null,
          amount: json.receiving.amount ?? null,
          symbol: json.receiving.token?.symbol ?? null,
          decimals: json.receiving.token?.decimals ?? null,
        }
      : null,
    checkedAt: Date.now(),
  };
}

/** Tokens the aggregator knows for one chain, for the asset pickers. */
export async function swapTokens(chainId) {
  const json = await getJson(`${API}/tokens?chains=${toDecimalChain(chainId)}`);
  const list = json?.tokens?.[String(toDecimalChain(chainId))] ?? [];
  return list.slice(0, 300).map((token) => normaliseToken(token)).filter(Boolean);
}

export { toDecimalChain };
