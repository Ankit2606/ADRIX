// Address-poisoning defence.
//
// The attack: send the victim a zero-value or dust transfer from an address
// crafted to share the first and last four hex characters of one they really
// use. It shows up in their history next to the genuine one, and every wallet
// UI in existence abbreviates addresses to exactly those characters. Weeks
// later they copy the wrong row.
//
// One thing worth being precise about: ADRIX has no indexer, so *incoming*
// transfers never enter its activity list, and a poisoned entry cannot be
// planted there. That removes one delivery route and leaves the other — the
// user pasting an address copied from a block explorer, where the poisoned row
// absolutely does appear. So the defence that matters here is comparing what
// was pasted against what the user has actually used before, which is what this
// module does. Filtering the history is the smaller half.

const norm = (address) => String(address ?? '').trim().toLowerCase();

/**
 * How two addresses relate.
 *
 * The comparison is deliberately built around the abbreviation wallets show
 * (0x1234…5678) rather than around edit distance: an attacker grinds for a
 * prefix/suffix collision because that is what gets rendered, and a pair can be
 * completely different in the middle while looking identical on screen.
 */
export function compareAddresses(candidate, known) {
  const a = norm(candidate);
  const b = norm(known);
  if (!a || !b || a.length !== 42 || b.length !== 42) return null;
  if (a === b) return { level: 'identical', shared: 40 };

  const bodyA = a.slice(2);
  const bodyB = b.slice(2);

  let prefix = 0;
  while (prefix < 40 && bodyA[prefix] === bodyB[prefix]) prefix += 1;

  let suffix = 0;
  while (suffix < 40 - prefix && bodyA[39 - suffix] === bodyB[39 - suffix]) suffix += 1;

  // Four each end is what a wallet abbreviation reveals, and it is the target
  // an attacker grinds for. Six or more is not chance — it is deliberate work.
  if (prefix >= 6 && suffix >= 6) return { level: 'lookalike', prefix, suffix, confidence: 'high' };
  if (prefix >= 4 && suffix >= 4) return { level: 'lookalike', prefix, suffix, confidence: 'medium' };
  // A long shared prefix alone still defeats a reader who only checks the start.
  if (prefix >= 8 || suffix >= 8) return { level: 'similar', prefix, suffix, confidence: 'low' };
  return null;
}

/**
 * Screens one candidate against every address the user actually knows.
 *
 * Returns the strongest match, because the question is not "how many things
 * does this resemble" but "is this pretending to be something of mine".
 */
export function screenRecipient(candidate, known = []) {
  const target = norm(candidate);
  if (!target) return null;

  let worst = null;
  for (const entry of known) {
    const match = compareAddresses(target, entry.address);
    if (!match || match.level === 'identical') continue;

    const scored = { ...match, against: entry };
    if (
      !worst ||
      (match.level === 'lookalike' && worst.level !== 'lookalike') ||
      (match.level === worst.level && (match.prefix + match.suffix) > (worst.prefix + worst.suffix))
    ) {
      worst = scored;
    }
  }
  return worst;
}

/** The message shown for a lookalike hit. Names what it is imitating. */
export function describeLookalike(match) {
  if (!match) return null;
  const label = match.against.label ?? 'an address you have used';

  if (match.level === 'lookalike') {
    return {
      severity: match.confidence === 'high' ? 'danger' : 'warn',
      title: 'This address imitates one you already use.',
      body:
        `It shares its first ${match.prefix} and last ${match.suffix} characters with ${label}, but it is a different address. ` +
        'That is the signature of address poisoning: an attacker generates a near-match so the abbreviated form looks right, ' +
        'then waits for you to copy the wrong one. Compare the whole address, not the ends.',
    };
  }

  return {
    severity: 'warn',
    title: 'This address closely resembles one you have used.',
    body: `It shares ${Math.max(match.prefix, match.suffix)} consecutive characters with ${label}. Check the full address before sending.`,
  };
}

/**
 * Whether an activity row is housekeeping rather than something the user did.
 *
 * Cancels and nonce-gap fills are zero-value self-sends the wallet generated
 * itself. They are worth keeping — they explain a fee — but they crowd out real
 * activity, so the history offers to fold them away.
 */
export function classifyNoise(tx) {
  const zeroValue = (() => {
    try {
      return BigInt(tx.value ?? 0) === 0n;
    } catch {
      return false;
    }
  })();
  const selfSend = tx.to && tx.from && norm(tx.to) === norm(tx.from);
  const noData = !tx.data || tx.data === '0x';

  if (tx.kind === 'cancel') return { noise: true, reason: 'Cancelled transaction' };
  if (tx.kind === 'nonceFill') return { noise: true, reason: 'Nonce gap fill' };
  if (zeroValue && selfSend && noData) return { noise: true, reason: 'Zero-value self transfer' };
  if (zeroValue && noData) return { noise: true, reason: 'Zero-value transfer' };

  return { noise: false, reason: null };
}

/** Annotates a history list without reordering or dropping anything. */
export function annotateActivity(rows = []) {
  return rows.map((tx) => ({ ...tx, noise: classifyNoise(tx) }));
}
