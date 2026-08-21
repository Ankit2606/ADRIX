// Phishing domains and malicious addresses.
//
// This replaces a four-entry placeholder list. It cannot be a real threat feed
// — that needs infrastructure this wallet does not have — so it does the two
// things that genuinely work offline:
//
//   1. Impersonation detection against a list of dApps worth impersonating.
//      Nearly every wallet-drainer domain is a near-miss of a real one:
//      character swaps, added hyphens, wrong TLD, or Unicode homographs. That
//      is detectable without knowing the specific domain in advance, which is
//      the whole problem with blocklists.
//   2. Community blocklist import, using the same format as MetaMask's
//      eth-phishing-detect. The user opts in, sees the source, and can refresh
//      it. A stale bundled list would be worse than an honest empty one.
//
// Plus a user-managed allow/block list, because the wallet will get some of
// this wrong in both directions and the user must be able to override it.

import { local } from './storage.js';

// ---------------------------------------------------------------------------
// Reference set: domains an attacker has a reason to imitate.
// ---------------------------------------------------------------------------
const PROTECTED_DOMAINS = [
  'uniswap.org', 'app.uniswap.org', 'aave.com', 'app.aave.com', 'curve.fi',
  'opensea.io', 'blur.io', 'looksrare.org', 'rarible.com', 'magiceden.io',
  'lido.fi', 'stake.lido.fi', 'rocketpool.net', 'etherscan.io', 'arbiscan.io',
  'polygonscan.com', 'basescan.org', 'bscscan.com', 'optimistic.etherscan.io',
  'metamask.io', 'rainbow.me', 'rabby.io', 'zerion.io', 'debank.com',
  'zapper.xyz', 'instadapp.io', 'compound.finance', 'app.compound.finance',
  'makerdao.com', 'oasis.app', 'spark.fi', 'pendle.finance', 'gmx.io',
  'dydx.exchange', 'sushi.com', 'balancer.fi', '1inch.io', 'app.1inch.io',
  'paraswap.io', 'cowswap.exchange', 'swap.cow.fi', 'across.to', 'stargate.finance',
  'hop.exchange', 'synapseprotocol.com', 'bungee.exchange', 'li.fi', 'jumper.exchange',
  'ens.domains', 'app.ens.domains', 'safe.global', 'app.safe.global',
  'coinbase.com', 'binance.com', 'kraken.com', 'ledger.com', 'trezor.io',
  'walletconnect.com', 'chainlist.org', 'revoke.cash', 'tally.xyz', 'snapshot.org',
];

// Registrable roots of the above, for comparison.
const PROTECTED_ROOTS = [...new Set(PROTECTED_DOMAINS.map((domain) => registrableRoot(domain)))];

// TLDs that are cheap, loosely policed, and hugely over-represented in drainer
// campaigns. On their own this means nothing — plenty of real projects use .xyz
// — so it only ever contributes alongside another signal.
const RISKY_TLDS = new Set([
  'xyz', 'top', 'click', 'live', 'gift', 'claim', 'monster', 'cyou', 'icu',
  'rest', 'buzz', 'cfd', 'sbs', 'bond', 'lol', 'quest', 'shop', 'store',
]);

const BAIT_WORDS = /\b(claim|airdrop|reward|giveaway|bonus|mint(?:ing)?|unlock|verify|validate|restore|recover|sync|migrate|connect-?wallet|wallet-?connect|support|refund|presale|whitelist)\b/i;

// Characters that render close enough to ASCII to fool a reader. Cyrillic а/е/о
// and Greek ο are the workhorses of homograph attacks.
const CONFUSABLES = {
  а: 'a', ӓ: 'a', ѕ: 's', е: 'e', ё: 'e', о: 'o', ο: 'o', р: 'p', с: 'c',
  х: 'x', у: 'y', і: 'i', ј: 'j', ԁ: 'd', ɡ: 'g', ł: 'l', ν: 'v', κ: 'k',
  м: 'm', н: 'h', т: 't', в: 'b', '0': 'o', '1': 'l', '3': 'e', '5': 's', '4': 'a',
};

function registrableRoot(hostname) {
  const parts = String(hostname ?? '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  // Good enough for the common multi-part suffixes without shipping the whole
  // public suffix list.
  const twoPartTlds = new Set(['co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'com.tr']);
  const lastTwo = parts.slice(-2).join('.');
  return twoPartTlds.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** Folds confusable characters and separators down to a comparable skeleton. */
function skeleton(text) {
  return String(text ?? '')
    .toLowerCase()
    .split('')
    .map((char) => CONFUSABLES[char] ?? char)
    .join('')
    .replace(/[-_.]/g, '');
}

/**
 * Multi-character lookalikes: "vv" for "w", "rn" for "m", "cl" for "d".
 *
 * Kept as a second comparison rather than folded into the primary skeleton,
 * because these rewrites are lossy on real words — "modern" becomes "modem" —
 * and corrupting the main path would trade one false negative for a worse false
 * positive. A domain is compared under both forms and flagged if either lands.
 */
function ligatureSkeleton(text) {
  return skeleton(text).replace(/vv/g, 'w').replace(/rn/g, 'm').replace(/cl/g, 'd');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Single row rather than a full matrix: these are hostnames, but this runs on
  // every connect prompt against every protected domain.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// ---------------------------------------------------------------------------
// Stored lists
// ---------------------------------------------------------------------------
const readLists = () =>
  local.get('securityLists', { blockedDomains: [], allowedDomains: [], blockedAddresses: [], feeds: {} });

export async function getSecurityLists() {
  const lists = await readLists();
  return {
    blockedDomains: lists.blockedDomains ?? [],
    allowedDomains: lists.allowedDomains ?? [],
    blockedAddresses: lists.blockedAddresses ?? [],
    feeds: Object.values(lists.feeds ?? {}).map((feed) => ({
      url: feed.url,
      name: feed.name,
      blocklistCount: feed.blocklist?.length ?? 0,
      allowlistCount: feed.allowlist?.length ?? 0,
      fetchedAt: feed.fetchedAt,
    })),
  };
}

export async function addToList(kind, value) {
  const lists = await readLists();
  const clean = String(value ?? '').trim().toLowerCase();
  if (!clean) throw new Error('Enter a value.');

  const key = { domain: 'blockedDomains', allow: 'allowedDomains', address: 'blockedAddresses' }[kind];
  if (!key) throw new Error('Unknown list.');

  lists[key] = [...new Set([...(lists[key] ?? []), clean])].slice(0, 500);
  await local.set({ securityLists: lists });
  return { kind, value: clean };
}

export async function removeFromList(kind, value) {
  const lists = await readLists();
  const key = { domain: 'blockedDomains', allow: 'allowedDomains', address: 'blockedAddresses' }[kind];
  if (!key) throw new Error('Unknown list.');
  const clean = String(value ?? '').trim().toLowerCase();
  lists[key] = (lists[key] ?? []).filter((entry) => entry !== clean);
  await local.set({ securityLists: lists });
  return { ok: true };
}

const MAX_FEED_ENTRIES = 30_000;
const FEED_TIMEOUT_MS = 20_000;

/**
 * Imports a community phishing feed in eth-phishing-detect format:
 * `{ blacklist: [...], whitelist: [...], fuzzylist: [...] }`. A plain array of
 * domains is accepted too.
 */
export async function importSecurityFeed(url, name) {
  const clean = String(url ?? '').trim();
  if (!/^https:\/\//i.test(clean)) throw new Error('Feed URLs must use https.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  let json;
  try {
    const response = await fetch(clean, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`The server returned ${response.status}.`);
    json = await response.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('That feed took too long to download.');
    throw new Error(`Could not fetch that feed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const normaliseHosts = (value) =>
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry ?? '').trim().toLowerCase())
      .filter((entry) => entry && /^[a-z0-9.-]+$/.test(entry))
      .slice(0, MAX_FEED_ENTRIES);

  const blocklist = normaliseHosts(Array.isArray(json) ? json : (json.blacklist ?? json.blocklist));
  const allowlist = normaliseHosts(json?.whitelist ?? json?.allowlist);

  if (!blocklist.length) throw new Error('That feed contains no usable blocked domains.');

  const lists = await readLists();
  lists.feeds ??= {};
  lists.feeds[clean] = {
    url: clean,
    name: String(name ?? '').trim() || new URL(clean).host,
    blocklist,
    allowlist,
    fetchedAt: Date.now(),
  };
  await local.set({ securityLists: lists });

  return { url: clean, blocklistCount: blocklist.length, allowlistCount: allowlist.length };
}

export async function removeSecurityFeed(url) {
  const lists = await readLists();
  delete lists.feeds?.[url];
  await local.set({ securityLists: lists });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Domain screening
// ---------------------------------------------------------------------------

/**
 * Screens an origin and explains itself.
 *
 * Returns a level and reasons rather than a boolean: "this site is dangerous"
 * and "this site resembles uniswap.org but is not it" call for different
 * responses, and a user who is told only the former learns nothing.
 */
export async function screenDomain(origin) {
  const result = { origin, level: 'unknown', reasons: [], impersonating: null, hostname: null };

  let url;
  try {
    url = new URL(origin);
  } catch {
    return { ...result, level: 'danger', reasons: ['ADRIX could not parse the origin of this request.'] };
  }

  const hostname = url.hostname.toLowerCase();
  result.hostname = hostname;
  const root = registrableRoot(hostname);
  const lists = await readLists();

  // 1. Explicit user allow wins over everything. The wallet will misjudge some
  //    sites and the user must have the last word.
  if ((lists.allowedDomains ?? []).some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    return { ...result, level: 'allowed', reasons: ['You marked this site as trusted.'] };
  }

  // 2. A genuine match against a protected domain is the good case.
  if (PROTECTED_DOMAINS.includes(hostname) || PROTECTED_ROOTS.includes(root)) {
    return { ...result, level: 'known', reasons: ['This is a well-known site ADRIX recognises.'] };
  }

  let level = 'unknown';
  const reasons = [];
  const raise = (next, reason) => {
    const order = { unknown: 0, caution: 1, warn: 2, danger: 3 };
    if (order[next] > order[level]) level = next;
    reasons.push(reason);
  };

  // 3. Explicit blocks — the user's own, then any imported feed.
  if ((lists.blockedDomains ?? []).some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    raise('danger', 'You blocked this site.');
  }
  for (const feed of Object.values(lists.feeds ?? {})) {
    if (feed.allowlist?.includes(hostname)) {
      return { ...result, level: 'known', reasons: [`Listed as legitimate by ${feed.name}.`] };
    }
    if (feed.blocklist?.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
      raise('danger', `Listed as a phishing site by ${feed.name}.`);
    }
  }

  // 4. Transport. An http origin cannot be trusted to be who it says.
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    raise('warn', 'This site is served over unencrypted HTTP, so its identity cannot be verified.');
  }

  // 5. Punycode. A hostname needing IDN encoding is either international or
  //    disguised, and a wallet cannot tell which — so it is always worth saying.
  if (hostname.includes('xn--')) {
    raise(
      'warn',
      'This domain uses non-ASCII characters encoded as punycode. Those can be chosen to look identical to a name you trust.'
    );
  }

  // 6. Impersonation. The main event.
  const impersonation = detectImpersonation(hostname, root);
  if (impersonation) {
    result.impersonating = impersonation;
    raise(
      impersonation.confidence === 'high' ? 'danger' : 'warn',
      `This domain closely resembles ${impersonation.target}, which it is not. ${impersonation.detail}`
    );
  }

  // 7. Weak signals. Only ever compound something else.
  const tld = hostname.split('.').pop();
  const baity = BAIT_WORDS.test(hostname);
  if (baity && RISKY_TLDS.has(tld)) {
    raise('warn', `The domain name contains claim-style wording on a .${tld} address, a combination overwhelmingly used by drainers.`);
  } else if (baity) {
    raise('caution', 'The domain name reads like a claim or airdrop prompt.');
  }
  if (hostname.split('.').length > 4) {
    raise('caution', 'This is a deeply nested subdomain, which is often used to bury a real name inside an unrelated one.');
  }

  return { ...result, level, reasons };
}

/**
 * Whether a hostname is trying to pass as one of the protected domains.
 *
 * Three separate tricks are checked because they defeat each other's detector:
 * a skeleton match catches homographs and digit swaps that leave edit distance
 * at zero, edit distance catches typos the skeleton preserves, and containment
 * catches `uniswap.org.evil.com`, which is neither.
 */
export function detectImpersonation(hostname, root = registrableRoot(hostname)) {
  const hostSkeleton = skeleton(root);
  const hostLigature = ligatureSkeleton(root);
  const labels = hostname.split('.');

  for (const target of PROTECTED_ROOTS) {
    if (root === target) return null;

    // (a) Confusable / digit-substitution match: renders the same, is not the same.
    if (skeleton(target) === hostSkeleton || ligatureSkeleton(target) === hostLigature) {
      return {
        target,
        confidence: 'high',
        detail: 'It differs only in characters that look identical on screen.',
      };
    }

    const targetName = target.split('.')[0];
    const hostName = root.split('.')[0];

    // (b) The same name on a different top-level domain. uniswap.io is not
    //     uniswap.org, and this is one of the most common shapes of all — edit
    //     distance on the name alone scores it zero and would miss it entirely.
    if (skeleton(hostName) === skeleton(targetName) || ligatureSkeleton(hostName) === ligatureSkeleton(targetName)) {
      return {
        target,
        confidence: 'high',
        detail: `It uses the same name as ${target} but a different top-level domain, so it belongs to someone else.`,
      };
    }

    // (c) Small edit distance on a name long enough for it to be meaningful.
    if (targetName.length >= 5) {
      const distance = Math.min(
        levenshtein(skeleton(hostName), skeleton(targetName)),
        levenshtein(ligatureSkeleton(hostName), ligatureSkeleton(targetName))
      );
      if (distance > 0 && distance <= (targetName.length >= 8 ? 2 : 1)) {
        return {
          target,
          confidence: distance === 1 ? 'high' : 'medium',
          detail: `It differs by ${distance} character${distance === 1 ? '' : 's'} from the real name.`,
        };
      }
      // (d) The real name appears anywhere in the hostname as its own token —
      //     as a label, or hyphenated inside one — while the registrable domain
      //     belongs to someone else. `app-uniswap.org.co` is registered by
      //     whoever owns org.co, and reads as Uniswap to everyone else.
      const boundary = new RegExp(`(^|[-_])${targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([-_]|$)`);
      if (
        labels.some((label) => boundary.test(label)) ||
        (hostName.includes(targetName) && hostName !== targetName)
      ) {
        return {
          target,
          confidence: 'medium',
          detail: `It contains "${targetName}", but the domain itself is ${root}, which is unrelated.`,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Address screening
// ---------------------------------------------------------------------------

/**
 * Screens a contract or recipient address.
 *
 * The useful signal here is not a blocklist — a drainer contract is deployed
 * fresh for each campaign and will never be on one in time. It is *age*: a
 * contract that did not exist yesterday and is being handed an unlimited
 * approval today is the entire drainer pattern, and it costs one archive read
 * to check.
 */
export async function screenAddress(address, { chainId, provider, checkAge = true } = {}) {
  const result = { address, level: 'unknown', reasons: [], isContract: null, ageChecked: false };
  if (!address) return result;

  const lower = String(address).toLowerCase();
  const lists = await readLists();

  if ((lists.blockedAddresses ?? []).includes(lower)) {
    return { ...result, level: 'danger', reasons: ['You blocked this address.'] };
  }

  let level = 'unknown';
  const reasons = [];
  const raise = (next, reason) => {
    const order = { unknown: 0, caution: 1, warn: 2, danger: 3 };
    if (order[next] > order[level]) level = next;
    reasons.push(reason);
  };

  if (!provider) return { ...result, level, reasons };

  try {
    const code = await provider.getCode(address);
    result.isContract = code && code !== '0x';

    if (result.isContract && checkAge) {
      const head = await provider.getBlockNumber();
      // ~1 day back on a 12s chain. Cheap, and the answer only has to be
      // "existed / did not exist", not an exact deployment height.
      const probe = Math.max(0, head - 7200);
      const before = await provider.getCode(address, probe).catch(() => null);

      if (before === '0x') {
        result.ageChecked = true;
        result.recentlyDeployed = true;
        raise(
          'warn',
          'This contract did not exist a day ago. Freshly deployed contracts asking for approvals are the standard drainer pattern.'
        );
      } else if (before && before !== '0x') {
        result.ageChecked = true;
        result.recentlyDeployed = false;
      }
      // A null means the node has no archive state that far back, which is
      // common on free endpoints — reported as unchecked rather than as safe.
    }

    if (result.isContract === false) {
      const nonce = await provider.getTransactionCount(address).catch(() => null);
      if (nonce === 0) {
        raise(
          'caution',
          'This address has never sent a transaction. That is normal for a fresh wallet and expected for a drainer collection address.'
        );
      }
    }
  } catch {
    /* screening is advisory; a read failure must not block the prompt */
  }

  return { ...result, level, reasons };
}

/** Kept for the existing call sites; now backed by the user and feed lists. */
export async function isAddressFlagged(address) {
  if (!address) return false;
  const lists = await readLists();
  return (lists.blockedAddresses ?? []).includes(String(address).toLowerCase());
}

export async function isDomainFlagged(origin) {
  const screened = await screenDomain(origin);
  return screened.level === 'danger';
}
