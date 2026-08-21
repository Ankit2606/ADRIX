// A log of what was signed, for whom, and when.
//
// The permission history already records *that* a signature happened. That is
// not enough to answer the question people actually ask after something goes
// wrong: what did I authorise? A signature is not a transaction — it costs
// nothing, appears nowhere on chain, and can be redeemed by someone else weeks
// later. An off-chain Permit is the drainer's preferred instrument precisely
// because it leaves no trace the user can go back and read.
//
// So the payload is classified and kept: what kind of signature, which spender,
// how much, and when it expires.

import { local } from './storage.js';

const HISTORY_LIMIT = 200;
const MAX_MESSAGE_CHARS = 2000;
const MAX_FIELDS = 20;

const UINT256_MAX = (1n << 256n) - 1n;
// Several tokens treat any very large allowance as unlimited, so the check is a
// threshold rather than an exact match on MaxUint256.
const UNLIMITED_THRESHOLD = 1n << 255n;

const read = () => local.get('signatureLog', []);

const clampText = (value, max = 200) =>
  typeof value === 'string' ? value.slice(0, max) : value == null ? '' : String(value).slice(0, max);

/** Permit-family primary types, which grant spending rights by signature alone. */
const PERMIT_TYPES = new Set([
  'Permit',
  'PermitSingle',
  'PermitBatch',
  'PermitTransferFrom',
  'PermitBatchTransferFrom',
  'PermitWitnessTransferFrom',
]);

function toBigInt(value) {
  try {
    if (value == null) return null;
    return BigInt(typeof value === 'string' ? value.trim() : value);
  } catch {
    return null;
  }
}

/**
 * Parses an EIP-4361 Sign-In With Ethereum message.
 *
 * SIWE is a login, and the phishing shape is specific: show a message that
 * reads as a sign-in for a site the user trusts while the request comes from
 * somewhere else entirely. The signature is then replayed against the real
 * site. Everything the prompt needs to catch that is in the message itself —
 * the claimed domain, the address, the chain, the URI — so all of it is pulled
 * out rather than left inside a wall of text nobody reads.
 */
export function parseSiwe(message) {
  const text = String(message ?? '');
  if (!/\n\nURI: /.test(text) || !/\nVersion: /.test(text)) return null;

  const lines = text.split('\n');
  const domainMatch = /^([^\n]+?) wants you to sign in with your Ethereum account:/.exec(text);
  const field = (label) => {
    const match = new RegExp(`\\n${label}: ([^\\n]+)`).exec(text);
    return match ? clampText(match[1], 200) : null;
  };

  // Line 2 is the address; the statement, when present, is the block between
  // the address and the first labelled field.
  const address = lines[1]?.trim().match(/^0x[0-9a-fA-F]{40}$/) ? lines[1].trim() : null;
  const uriIndex = lines.findIndex((line) => line.startsWith('URI: '));
  const statement =
    uriIndex > 3 ? clampText(lines.slice(3, uriIndex - 1).join(' ').trim(), 400) : null;

  // Resources are a trailing bullet list, and are worth surfacing: they are
  // where a sign-in quietly claims scope beyond identifying you.
  const resourceIndex = lines.findIndex((line) => line.startsWith('Resources:'));
  const resources =
    resourceIndex >= 0
      ? lines
          .slice(resourceIndex + 1)
          .filter((line) => line.trim().startsWith('- '))
          .map((line) => clampText(line.trim().slice(2), 200))
          .slice(0, 10)
      : [];

  return {
    domain: domainMatch ? clampText(domainMatch[1], 120) : null,
    address,
    statement,
    uri: field('URI'),
    version: field('Version'),
    chainId: field('Chain ID'),
    nonce: field('Nonce'),
    issuedAt: field('Issued At'),
    expirationTime: field('Expiration Time'),
    notBefore: field('Not Before'),
    requestId: field('Request ID'),
    resources,
  };
}

/**
 * Checks a SIWE message against the request that carried it.
 *
 * Each check answers a question the raw text cannot: is the site asking the
 * same one the message names, is the account the same one being asked to sign,
 * is the chain right, and is it still valid. A mismatch on any of them is the
 * signature being farmed for use somewhere else.
 */
export function verifySiwe(siwe, { origin, account, chainId } = {}) {
  if (!siwe) return null;
  const problems = [];
  const checks = [];

  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return null;
    }
  })();

  if (siwe.domain && host) {
    // EIP-4361 requires the domain to be the site requesting the signature.
    const match = siwe.domain === host || siwe.domain === host.replace(/^www\./, '');
    checks.push({ label: 'Site', value: siwe.domain, ok: match });
    if (!match) {
      problems.push(
        `This message says you are signing in to ${siwe.domain}, but the request came from ${host}. A signature made here can be replayed against ${siwe.domain}.`
      );
    }
  }

  if (siwe.address && account) {
    const match = siwe.address.toLowerCase() === account.toLowerCase();
    checks.push({ label: 'Account', value: siwe.address, ok: match });
    if (!match) problems.push('The message names a different account than the one being asked to sign.');
  }

  if (siwe.chainId && chainId) {
    const expected = String(parseInt(chainId, 16));
    const match = String(siwe.chainId) === expected;
    checks.push({ label: 'Chain', value: siwe.chainId, ok: match });
    if (!match) problems.push(`The message is for chain ${siwe.chainId}, but the wallet is on chain ${expected}.`);
  }

  if (siwe.expirationTime) {
    const expiry = Date.parse(siwe.expirationTime);
    const valid = Number.isFinite(expiry) && expiry > Date.now();
    checks.push({ label: 'Expires', value: siwe.expirationTime, ok: valid });
    if (!valid) problems.push('This sign-in message has already expired, so signing it achieves nothing.');
  } else {
    // A login with no expiry is a credential that never stops working.
    problems.push('This sign-in has no expiry, so the signature stays valid indefinitely.');
  }

  if (siwe.resources?.length) {
    problems.push(
      `It claims ${siwe.resources.length} resource${siwe.resources.length === 1 ? '' : 's'} beyond identifying you — read them below.`
    );
  }

  return { checks, problems, ok: problems.length === 0 };
}

/**
 * Works out what a typed-data payload actually authorises.
 *
 * The warnings here are the point of the whole log: "signed a Permit" is not
 * useful three weeks later, but "granted unlimited USDC to 0xabc, no expiry" is.
 */
function classifyTyped({ primaryType, domain = {}, message = {}, origin }) {
  const risk = { kind: 'typed', warnings: [] };
  const type = String(primaryType ?? '');

  if (PERMIT_TYPES.has(type)) {
    risk.kind = 'permit';

    // Permit2 nests the grant under `details`; EIP-2612 puts it at the top.
    const details = message.details ?? message;
    const amount = toBigInt(details.amount ?? message.value);
    const spender = details.spender ?? message.spender ?? null;
    const deadline = toBigInt(message.deadline ?? message.sigDeadline ?? details.expiration);

    risk.spender = typeof spender === 'string' ? clampText(spender, 42) : null;
    risk.amount = amount != null ? amount.toString() : null;
    risk.token = clampText(details.token ?? domain.verifyingContract, 42);
    risk.unlimited = amount != null && amount >= UNLIMITED_THRESHOLD;
    risk.deadline = deadline != null ? deadline.toString() : null;

    risk.warnings.push(
      'This signature grants spending permission without an on-chain approval, so it will not appear in the approvals list.'
    );
    if (risk.unlimited) {
      risk.warnings.push('The permitted amount is effectively unlimited.');
    }
    if (deadline != null) {
      const seconds = Number(deadline);
      // A deadline decades out is functionally "forever", which defeats the one
      // safety property a Permit has over a plain approval.
      if (Number.isFinite(seconds) && seconds > Date.now() / 1000 + 365 * 24 * 3600) {
        risk.warnings.push('The expiry is more than a year away, so this grant is effectively permanent.');
      }
    } else {
      risk.warnings.push('No expiry was set on this permission.');
    }
  } else if (/order|seaport|listing/i.test(type) || /seaport/i.test(String(domain.name ?? ''))) {
    risk.kind = 'order';
    risk.warnings.push('This is a marketplace order. Signing it can allow your NFT or tokens to be taken at the stated price.');
  } else if (/delegat/i.test(type)) {
    risk.kind = 'delegation';
    risk.warnings.push('This signature delegates authority over your account.');
  }

  // A typed-data domain names the contract that will accept the signature. If
  // that does not match the site asking, the signature is being farmed for use
  // somewhere else.
  const domainChain = domain.chainId != null ? String(domain.chainId) : null;
  if (domain.name && origin) {
    const host = (() => {
      try {
        return new URL(origin).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const domainName = String(domain.name).toLowerCase();
    const root = host.split('.').slice(-2, -1)[0] ?? '';
    if (root && domainName && !domainName.includes(root) && !root.includes(domainName.split(' ')[0])) {
      risk.originMismatch = true;
    }
  }

  return { risk, domainChain };
}

/** A few readable key/value pairs from a typed message, for the log row. */
function summariseFields(message) {
  if (!message || typeof message !== 'object') return [];
  return Object.entries(message)
    .slice(0, MAX_FIELDS)
    .map(([key, value]) => ({
      key: clampText(key, 40),
      value:
        value && typeof value === 'object' ? clampText(JSON.stringify(value), 200) : clampText(String(value), 200),
    }));
}

export async function recordSignature(entry) {
  const log = await read();

  const base = {
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    at: Date.now(),
    origin: clampText(entry.origin, 200),
    account: clampText(entry.account, 42),
    chainId: entry.chainId ?? null,
    networkName: clampText(entry.networkName, 40),
    type: entry.type,
    // The signature itself is public the moment it is used, and keeping it is
    // what lets a user prove later what they did or did not authorise.
    signature: clampText(entry.signature, 200),
  };

  let row;
  if (entry.type === 'personal') {
    const siwe = parseSiwe(entry.message);
    row = {
      ...base,
      message: clampText(entry.message, MAX_MESSAGE_CHARS),
      raw: clampText(entry.raw, 400),
      risk: siwe
        ? {
            kind: 'siwe',
            siwe,
            warnings:
              // A SIWE prompt naming a different site than the one asking is a
              // login being harvested for somewhere else.
              siwe.domain && entry.origin && !entry.origin.includes(siwe.domain)
                ? [`The sign-in message names ${siwe.domain}, but the request came from ${entry.origin}.`]
                : [],
          }
        : { kind: 'message', warnings: [] },
    };
  } else {
    const { risk, domainChain } = classifyTyped({
      primaryType: entry.primaryType,
      domain: entry.domain ?? {},
      message: entry.message ?? {},
      origin: entry.origin,
    });
    row = {
      ...base,
      primaryType: clampText(entry.primaryType, 60),
      domainName: clampText(entry.domain?.name, 60),
      verifyingContract: clampText(entry.domain?.verifyingContract, 42),
      domainChainId: domainChain,
      fields: summariseFields(entry.message),
      risk,
    };
  }

  await local.set({ signatureLog: [row, ...log].slice(0, HISTORY_LIMIT) });
  return row;
}

export async function listSignatures({ origin, account, type, kind, query } = {}) {
  const log = await read();
  const needle = String(query ?? '').trim().toLowerCase();

  return log.filter((row) => {
    if (origin && row.origin !== origin) return false;
    if (account && row.account?.toLowerCase() !== account.toLowerCase()) return false;
    if (type && row.type !== type) return false;
    if (kind && row.risk?.kind !== kind) return false;
    if (!needle) return true;
    return [row.origin, row.account, row.message, row.primaryType, row.domainName, row.risk?.spender]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

/** Counts by classification, so the log can lead with what matters. */
export async function signatureStats(account) {
  const log = await read();
  const scoped = account ? log.filter((row) => row.account?.toLowerCase() === account.toLowerCase()) : log;

  return {
    total: scoped.length,
    permits: scoped.filter((row) => row.risk?.kind === 'permit').length,
    unlimitedPermits: scoped.filter((row) => row.risk?.unlimited).length,
    orders: scoped.filter((row) => row.risk?.kind === 'order').length,
    logins: scoped.filter((row) => row.risk?.kind === 'siwe').length,
    flagged: scoped.filter((row) => (row.risk?.warnings?.length ?? 0) > 0).length,
    origins: new Set(scoped.map((row) => row.origin)).size,
    lastAt: scoped[0]?.at ?? null,
  };
}

export async function clearSignatures() {
  await local.set({ signatureLog: [] });
  return { ok: true };
}
