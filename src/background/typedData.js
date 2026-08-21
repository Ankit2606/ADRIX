// EIP-712 typed data, made readable.
//
// The old confirmation screen printed `Object.entries(message)` and
// JSON.stringify'd anything nested. That is a data dump, not a parser: it shows
// `deadline: 1794787200` and `value: 115792089237316195423570985008687907853269984665640564039457584007913129639935`
// where what the user needs to read is "never expires" and "unlimited".
//
// Typed data is the drainer's instrument of choice precisely because it is
// unreadable. A Permit signature costs no gas, appears nowhere on chain, and
// hands over spending rights that the approvals screen will never show. So this
// walks the type definition properly, infers what each field means, and renders
// it in the units a person thinks in.
//
// Pure and synchronous. Anything needing a network read — token decimals, is
// this spender a contract — is resolved by the caller and passed in as context,
// so the parser stays testable and cannot stall a confirmation prompt.

import { TypedDataEncoder, formatUnits, getAddress, isAddress } from 'ethers';

const UNLIMITED_THRESHOLD = 1n << 255n;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 8;

// Schemas worth recognising by name, because each carries a specific meaning
// that its raw fields do not convey.
const SCHEMAS = {
  Permit: {
    kind: 'permit',
    label: 'Token spending permit',
    summary: 'Grants permission to spend your tokens, by signature alone.',
  },
  PermitSingle: { kind: 'permit', label: 'Permit2 spending permit', summary: 'Grants Permit2 spending rights.' },
  PermitBatch: {
    kind: 'permit',
    label: 'Permit2 batch permit',
    summary: 'Grants spending rights over several tokens at once.',
  },
  PermitTransferFrom: {
    kind: 'permit',
    label: 'Permit2 transfer authorisation',
    summary: 'Authorises a specific transfer of your tokens.',
  },
  PermitBatchTransferFrom: {
    kind: 'permit',
    label: 'Permit2 batch transfer',
    summary: 'Authorises several transfers of your tokens.',
  },
  OrderComponents: {
    kind: 'order',
    label: 'Marketplace order',
    summary: 'Offers your assets for sale at the stated price.',
  },
  SafeTx: { kind: 'safe', label: 'Safe transaction', summary: 'Approves a transaction for a Safe multisig.' },
  Delegation: { kind: 'delegation', label: 'Delegation', summary: 'Delegates authority over your account.' },
};

const toBigInt = (value) => {
  try {
    if (value == null || value === '') return null;
    return BigInt(typeof value === 'string' ? value.trim() : value);
  } catch {
    return null;
  }
};

const isDeadlineName = (name) => /deadline|expiry|expiration|validuntil|endtime|expires/i.test(name);
const isAmountName = (name) => /amount|value|price|quantity|allowance|limit/i.test(name);

/**
 * What a field actually is, from its Solidity type plus its name.
 *
 * The type alone cannot distinguish a deadline from an amount — both are
 * uint256 — and rendering a timestamp as a token quantity is exactly the kind
 * of confusion this screen exists to remove.
 */
function classifyField(name, type, types) {
  if (type.endsWith(']')) return 'array';
  if (types[type]) return 'struct';
  if (type === 'address') return 'address';
  if (type === 'bool') return 'boolean';
  if (type === 'string') return 'string';
  if (type.startsWith('bytes')) return 'bytes';
  if (/^u?int/.test(type)) {
    if (/^nonce$/i.test(name)) return 'nonce';
    if (isDeadlineName(name)) return 'deadline';
    if (isAmountName(name)) return 'amount';
    return 'number';
  }
  return 'unknown';
}

function describeDeadline(seconds) {
  if (seconds == null) return { display: '--', note: null };

  // Permit2 uses a uint48 sentinel and EIP-2612 payloads often use MaxUint256.
  // Both mean "no expiry", which is the single most important thing to say.
  if (seconds >= 253402300799n || seconds >= UNLIMITED_THRESHOLD) {
    return { display: 'Never expires', note: 'This permission has no end date.', level: 'warn' };
  }
  if (seconds === 0n) return { display: 'No deadline set', note: null, level: 'warn' };

  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) return { display: seconds.toString(), note: null };

  const date = new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const deltaMs = ms - Date.now();

  if (deltaMs < 0) {
    return { display: `${date} (expired)`, note: 'This deadline has already passed.', level: 'info' };
  }

  const minutes = Math.round(deltaMs / 60000);
  const relative =
    minutes < 60
      ? `${minutes} min`
      : minutes < 1440
        ? `${Math.round(minutes / 60)} hours`
        : `${Math.round(minutes / 1440)} days`;

  const level = deltaMs > 365 * 24 * 3600 * 1000 ? 'warn' : null;
  return {
    display: `${date} (in ${relative})`,
    note: level ? 'That is more than a year away, so this is effectively permanent.' : null,
    level,
  };
}

/**
 * The largest value a Solidity integer type can hold.
 *
 * "Unlimited" is not one constant. EIP-2612 permits use uint256 max, but
 * Permit2 declares its amount as uint160 and its sentinel is that type's max —
 * a number nowhere near 2^255. Checking against a single threshold rendered a
 * Permit2 unlimited approval as "1461501637330902918203684832716283019655932.54
 * USDC", which reads as a specific, survivable quantity. It is the opposite.
 */
function typeMax(type) {
  const match = /^u?int(\d*)$/.exec(type ?? '');
  if (!match) return null;
  const bits = match[1] ? Number(match[1]) : 256;
  if (!Number.isInteger(bits) || bits <= 0 || bits > 256) return null;
  return type.startsWith('u') ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
}

function describeAmount(raw, context, type) {
  const value = toBigInt(raw);
  if (value == null) return { display: String(raw), note: null };

  const max = typeMax(type);
  // Half the type's range is already an impossible balance for any real token,
  // so anything at or above it is the "no limit" sentinel however it is spelled.
  const unlimited = max != null ? value >= max / 2n : value >= UNLIMITED_THRESHOLD;

  if (unlimited) {
    return {
      display: 'Unlimited',
      note: `The maximum a ${type ?? 'uint256'} can hold — this is not a quantity, it is "everything, forever".`,
      level: 'danger',
    };
  }
  if (value === 0n) return { display: '0', note: null };

  if (context?.decimals != null) {
    const formatted = formatUnits(value, context.decimals);
    return { display: `${formatted}${context.symbol ? ` ${context.symbol}` : ''}`, note: null };
  }
  // Without decimals the raw integer is the honest rendering. Guessing 18 would
  // be worse than saying so.
  return { display: value.toString(), note: 'Raw value — ADRIX does not know this token\'s decimals.' };
}

function describeAddress(raw, context) {
  let address;
  try {
    address = getAddress(String(raw));
  } catch {
    // A malformed or bad-checksum address inside a payload the user is about to
    // sign is worth saying out loud. Rendering it as ordinary text implies the
    // wallet read and accepted it.
    const text = String(raw ?? '');
    const looksLikeAddress = /^0x[0-9a-fA-F]{40}$/.test(text);
    return {
      display: text,
      note: looksLikeAddress
        ? 'This address fails its EIP-55 checksum — a character is wrong, or it was tampered with.'
        : 'Not a valid address.',
      level: 'danger',
    };
  }

  const known = context?.knownAddresses?.[address.toLowerCase()];
  const short = `${address.slice(0, 10)}…${address.slice(-8)}`;

  if (known) return { display: short, note: known.label, level: known.level ?? null };
  return { display: short, note: null, full: address };
}

/** Walks one value against its type definition, recursively. */
function walk({ name, type, value, types, context, depth = 0, path = '' }) {
  const kind = classifyField(name, type, types);
  const nodePath = path ? `${path}.${name}` : name;
  const node = { name, type, kind, path: nodePath, raw: serialise(value) };

  if (depth >= MAX_DEPTH) {
    return { ...node, kind: 'truncated', display: 'nested too deeply to display', level: 'warn' };
  }

  if (kind === 'array') {
    const inner = type.slice(0, type.lastIndexOf('['));
    const items = Array.isArray(value) ? value : [];
    return {
      ...node,
      display: `${items.length} item${items.length === 1 ? '' : 's'}`,
      children: items
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item, index) =>
          walk({ name: `[${index}]`, type: inner, value: item, types, context, depth: depth + 1, path: nodePath })
        ),
      truncatedItems: Math.max(0, items.length - MAX_ARRAY_ITEMS),
    };
  }

  if (kind === 'struct') {
    const definition = types[type] ?? [];
    return {
      ...node,
      display: type,
      children: definition.map((field) =>
        walk({
          name: field.name,
          type: field.type,
          value: value?.[field.name],
          types,
          context,
          depth: depth + 1,
          path: nodePath,
        })
      ),
    };
  }

  if (kind === 'address') return { ...node, ...describeAddress(value, context) };
  if (kind === 'deadline') return { ...node, ...describeDeadline(toBigInt(value)) };
  if (kind === 'amount') return { ...node, ...describeAmount(value, context, type) };
  if (kind === 'boolean') return { ...node, display: value ? 'Yes' : 'No' };
  if (kind === 'bytes') {
    const hex = String(value ?? '');
    return {
      ...node,
      display: hex.length > 26 ? `${hex.slice(0, 14)}…${hex.slice(-8)}` : hex,
      // Opaque bytes inside a signed payload can carry anything, including an
      // encoded call. Worth naming rather than showing as a tidy short hex.
      note: hex.length > 66 ? 'Opaque data. ADRIX cannot tell you what this contains.' : null,
      level: hex.length > 66 ? 'warn' : null,
    };
  }
  if (kind === 'nonce') return { ...node, display: String(value ?? '') };

  return { ...node, display: value == null ? '--' : String(value) };
}

function serialise(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === 'object') return '{…}';
  return value == null ? null : String(value);
}

/**
 * Parses a typed-data payload into something a person can check.
 *
 * `context` carries anything that needed a network read: token decimals for the
 * verifying contract, and labels for addresses the wallet recognises.
 */
export function parseTypedData({
  domain = {},
  types = {},
  primaryType,
  message = {},
  origin = null,
  walletChainId = null,
  context = {},
}) {
  const schema = SCHEMAS[primaryType] ?? { kind: 'unknown', label: primaryType || 'Typed data', summary: null };
  const warnings = [];

  // --- domain --------------------------------------------------------------
  const domainChecks = [];
  const domainChainId = domain.chainId != null ? String(toBigInt(domain.chainId) ?? domain.chainId) : null;
  const walletChainDecimal = walletChainId ? String(parseInt(walletChainId, 16)) : null;

  if (domainChainId && walletChainDecimal && domainChainId !== walletChainDecimal) {
    // A signature is only valid on the chain named in its domain. One naming a
    // different chain is either a mistake or is being farmed for use elsewhere.
    domainChecks.push({
      level: 'danger',
      message: `This signature is for chain ${domainChainId}, but the wallet is on chain ${walletChainDecimal}. It will not work here — it is meant for somewhere else.`,
    });
  }

  if (domain.verifyingContract && !isAddress(String(domain.verifyingContract))) {
    domainChecks.push({ level: 'warn', message: 'The verifying contract is not a valid address.' });
  }

  if (origin && domain.name) {
    const host = (() => {
      try {
        return new URL(origin).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const root = host.split('.').slice(-2, -1)[0] ?? '';
    const domainName = String(domain.name).toLowerCase();
    if (root && !domainName.includes(root) && !root.includes(domainName.split(/[\s-]/)[0])) {
      domainChecks.push({
        level: 'warn',
        message: `The payload names "${domain.name}" but the request came from ${host}. Check the site is who it claims to be acting for.`,
      });
    }
  }

  if (!domain.verifyingContract && schema.kind === 'permit') {
    domainChecks.push({
      level: 'warn',
      message: 'A permit without a verifying contract cannot be tied to a specific token.',
    });
  }

  // --- fields --------------------------------------------------------------
  const definition = types[primaryType] ?? [];
  const fields = definition.map((field) =>
    walk({ name: field.name, type: field.type, value: message[field.name], types, context })
  );

  // Anything a field flagged while being rendered becomes a top-level warning,
  // so the important part is not buried three rows into a table.
  const collect = (nodes) => {
    for (const node of nodes) {
      if (node.level === 'danger' || node.level === 'warn') {
        warnings.push({ level: node.level, message: `${node.name}: ${node.note ?? node.display}` });
      }
      if (node.children) collect(node.children);
    }
  };
  collect(fields);

  // --- schema-specific meaning ----------------------------------------------
  if (schema.kind === 'permit') {
    warnings.unshift({
      level: 'warn',
      message:
        'This is a permission, not a transfer. It costs no gas, produces no on-chain record, and will not appear in the approvals list — but it lets the spender move your tokens whenever they choose.',
    });
  }
  if (schema.kind === 'order') {
    warnings.unshift({
      level: 'warn',
      message: 'Signing this order lets someone take the listed asset at the stated price, without asking again.',
    });
  }
  if (schema.kind === 'unknown' && definition.length) {
    warnings.push({
      level: 'info',
      message: `ADRIX does not recognise the "${primaryType}" schema, so it can show the fields but not what they mean together.`,
    });
  }

  // --- digest ---------------------------------------------------------------
  // The hash that is actually being signed. Publishing it lets a careful user
  // compare against what the site claims, and costs nothing to compute.
  let digest = null;
  try {
    const withoutDomain = { ...types };
    delete withoutDomain.EIP712Domain;
    digest = TypedDataEncoder.hash(domain, withoutDomain, message);
  } catch {
    digest = null;
  }

  const worst = [...domainChecks, ...warnings].reduce(
    (level, entry) =>
      entry.level === 'danger' ? 'danger' : level === 'danger' ? 'danger' : entry.level === 'warn' ? 'warn' : level,
    null
  );

  return {
    primaryType,
    schema,
    domain: {
      name: domain.name ?? null,
      version: domain.version ?? null,
      chainId: domainChainId,
      verifyingContract: domain.verifyingContract ?? null,
      salt: domain.salt ?? null,
      checks: domainChecks,
    },
    fields,
    warnings,
    digest,
    risk: worst,
  };
}

/**
 * The spending grant a permit represents, pulled out of whichever shape it
 * arrived in. EIP-2612 puts it at the top level; Permit2 nests it under
 * `details`, sometimes as an array.
 */
export function extractPermitGrant({ primaryType, domain = {}, message = {} }) {
  if (!SCHEMAS[primaryType] || SCHEMAS[primaryType].kind !== 'permit') return null;

  const details = Array.isArray(message.details) ? message.details[0] : (message.details ?? message);
  const permitted = Array.isArray(message.permitted) ? message.permitted[0] : message.permitted;
  const source = permitted ?? details;

  const amount = toBigInt(source?.amount ?? source?.value ?? message.value);
  const deadline = toBigInt(message.deadline ?? message.sigDeadline ?? details?.expiration);

  return {
    token: source?.token ?? domain.verifyingContract ?? null,
    spender: message.spender ?? details?.spender ?? message.to ?? null,
    amount: amount != null ? amount.toString() : null,
    unlimited: amount != null && amount >= UNLIMITED_THRESHOLD,
    deadline: deadline != null ? deadline.toString() : null,
    batch: Array.isArray(message.details) || Array.isArray(message.permitted),
    batchCount: Array.isArray(message.details)
      ? message.details.length
      : Array.isArray(message.permitted)
        ? message.permitted.length
        : 1,
  };
}

export { UNLIMITED_THRESHOLD };
