// Splitting a recovery phrase into shares.
//
// A note on what this is not, because the distinction matters and is routinely
// blurred:
//
//   MPC / threshold signatures never assemble the key. Each party holds a share
//   permanently and they run a protocol to produce a signature jointly, so the
//   whole key exists nowhere, ever. That needs at least two live participants
//   exchanging protocol rounds. A browser extension with no counterparty cannot
//   do it, and ADRIX does not.
//
//   Shamir secret sharing, which is what this implements, splits the phrase
//   into N shares of which any T reconstruct it. The key does get assembled —
//   in memory, on one device, at recovery time — so it is a custody scheme, not
//   a signing scheme. It removes the single point of failure in storing a
//   phrase; it does not remove the single point of compromise in using one.
//
// That is a real and useful property, and it is worth having under its own
// name. Calling it MPC would be a lie that matters, because the two have
// different threat models and someone choosing between them needs to know which
// one they got.

import { Mnemonic } from 'ethers';

// --- GF(2^8) ----------------------------------------------------------------
//
// Arithmetic over the AES field. Log/exp tables make multiplication a lookup,
// which keeps the interpolation loop free of conditionals on secret data.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // Multiply by the generator 3: x ^= x<<1, reduced by 0x11b.
    let next = x << 1;
    if (next & 0x100) next ^= 0x11b;
    x = next ^ x;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const gfDiv = (a, b) => {
  if (b === 0) throw new Error('Division by zero in GF(256).');
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
};

// --- Shamir -----------------------------------------------------------------
const MAX_SHARES = 16;

/**
 * Splits one byte string into `total` shares, any `threshold` of which rebuild
 * it.
 *
 * Each byte gets an independent random polynomial whose constant term is the
 * secret byte; a share is that polynomial evaluated at the share's index. With
 * fewer than `threshold` points every possible secret remains equally likely,
 * which is the property that makes this information-theoretically secure rather
 * than merely hard to break.
 */
function splitBytes(secret, threshold, total) {
  if (threshold < 2) throw new Error('The threshold must be at least 2.');
  if (total < threshold) throw new Error('There must be at least as many shares as the threshold.');
  if (total > MAX_SHARES) throw new Error(`At most ${MAX_SHARES} shares can be produced.`);

  const shares = Array.from({ length: total }, (_, i) => ({ index: i + 1, bytes: new Uint8Array(secret.length) }));

  for (let position = 0; position < secret.length; position++) {
    const coefficients = new Uint8Array(threshold);
    coefficients[0] = secret[position];
    // Coefficients above the constant term must be unpredictable; anything less
    // than a CSPRNG here would let shares be guessed from each other.
    crypto.getRandomValues(coefficients.subarray(1));

    for (const share of shares) {
      let value = 0;
      // Horner's method, so each share costs one pass over the coefficients.
      for (let power = threshold - 1; power >= 0; power--) {
        value = gfMul(value, share.index) ^ coefficients[power];
      }
      share.bytes[position] = value;
    }
  }

  return shares;
}

/** Lagrange interpolation at x = 0, which recovers the constant term. */
function combineBytes(shares) {
  const length = shares[0].bytes.length;
  if (shares.some((share) => share.bytes.length !== length)) {
    throw new Error('Those shares are different lengths, so they are not from the same split.');
  }
  if (new Set(shares.map((share) => share.index)).size !== shares.length) {
    throw new Error('Two of those shares have the same index. Each share must be a different one.');
  }

  const out = new Uint8Array(length);

  for (let position = 0; position < length; position++) {
    let accumulator = 0;
    for (const share of shares) {
      let numerator = 1;
      let denominator = 1;
      for (const other of shares) {
        if (other.index === share.index) continue;
        numerator = gfMul(numerator, other.index);
        denominator = gfMul(denominator, share.index ^ other.index);
      }
      accumulator ^= gfMul(share.bytes[position], gfDiv(numerator, denominator));
    }
    out[position] = accumulator;
  }

  return out;
}

// --- Share encoding ---------------------------------------------------------
//
// A share is written as:
//   version(1) ‖ threshold(1) ‖ index(1) ‖ setId(2) ‖ payload ‖ crc(2)
// in hex, grouped for transcription. The header travels with each share so a
// recovery does not depend on remembering the parameters.
//
// The set id is not decoration. Lagrange interpolation over shares from
// *different* splits does not fail — it returns some other 16 or 32 bytes, and
// any bytes at all convert to a syntactically valid BIP-39 phrase. Without this
// field, one wrong share in a recovery yields a perfectly plausible phrase for
// a wallet that has never existed, with nothing to indicate anything went
// wrong. It is derived from the secret, so shares of one phrase agree and
// shares of another do not, while revealing nothing about the phrase itself.
const VERSION = 2;

function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

const groupHex = (hex) => (hex.match(/.{1,4}/g) ?? []).join('-').toUpperCase();

function encodeShare({ threshold, index, setId, bytes }) {
  const body = Uint8Array.from([VERSION, threshold, index, (setId >> 8) & 0xff, setId & 0xff, ...bytes]);
  const checksum = crc16(body);
  const full = Uint8Array.from([...body, (checksum >> 8) & 0xff, checksum & 0xff]);
  return groupHex([...full].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

function decodeShare(text) {
  const clean = String(text ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (clean.length < 16 || clean.length % 2) throw new Error('That does not look like an ADRIX share.');

  const bytes = Uint8Array.from(clean.match(/../g).map((b) => parseInt(b, 16)));
  const body = bytes.slice(0, -2);
  const expected = (bytes.at(-2) << 8) | bytes.at(-1);

  if (crc16(body) !== expected) {
    // Almost always a transcription slip rather than a corrupt share, and
    // saying so points the user at the right thing to re-check.
    throw new Error('That share failed its checksum — a character was probably mistyped.');
  }
  if (body[0] !== VERSION) throw new Error(`That share is format version ${body[0]}, which this version cannot read.`);

  return {
    threshold: body[1],
    index: body[2],
    setId: (body[3] << 8) | body[4],
    bytes: body.slice(5),
  };
}

const setIdFor = (entropy) => crc16(entropy);

// --- Public API -------------------------------------------------------------

/**
 * Splits a recovery phrase.
 *
 * The phrase's entropy is split rather than its words: entropy is a fixed
 * length, reconstructs to exactly the same phrase, and keeps the shares
 * compact. A malformed phrase is rejected up front, because discovering it at
 * recovery time — when the original is gone — is unrecoverable.
 */
export function splitPhrase({ phrase, threshold, total }) {
  const clean = String(phrase ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!Mnemonic.isValidMnemonic(clean)) {
    throw new Error('That is not a valid BIP-39 recovery phrase, so it cannot be split.');
  }

  const mnemonic = Mnemonic.fromPhrase(clean);
  const entropy = Uint8Array.from(mnemonic.entropy.slice(2).match(/../g).map((b) => parseInt(b, 16)));

  const shares = splitBytes(entropy, Number(threshold), Number(total));
  const setId = setIdFor(entropy);

  return {
    threshold: Number(threshold),
    total: Number(total),
    wordCount: clean.split(' ').length,
    shares: shares.map((share) => ({
      index: share.index,
      text: encodeShare({ threshold: Number(threshold), index: share.index, setId, bytes: share.bytes }),
    })),
    // Printed on each share so a holder can confirm a set belongs together
    // without revealing anything about the phrase itself.
    setId: setId.toString(16).padStart(4, '0').toUpperCase(),
  };
}

/** Rebuilds a phrase from enough shares. */
export function combineShares(texts) {
  const parsed = (texts ?? [])
    .map((text) => String(text ?? '').trim())
    .filter(Boolean)
    .map(decodeShare);

  if (!parsed.length) throw new Error('Enter at least one share.');

  const threshold = parsed[0].threshold;
  if (parsed.some((share) => share.threshold !== threshold)) {
    throw new Error('Those shares came from different splits — their thresholds disagree.');
  }

  // Checked before any interpolation. Mixing splits does not fail arithmetically
  // — it returns different bytes, which become a valid-looking phrase for a
  // wallet that never existed. Catching it here is the difference between an
  // error and a silently wrong recovery.
  const setId = parsed[0].setId;
  const stray = parsed.find((share) => share.setId !== setId);
  if (stray) {
    throw new Error(
      `Share ${stray.index} belongs to a different split (set ${stray.setId
        .toString(16)
        .padStart(4, '0')
        .toUpperCase()}, not ${setId.toString(16).padStart(4, '0').toUpperCase()}). Combining them would produce a valid-looking phrase for the wrong wallet.`
    );
  }

  if (parsed.length < threshold) {
    throw new Error(`This split needs ${threshold} shares; you have entered ${parsed.length}.`);
  }

  // Extra shares beyond the threshold are harmless but add nothing, so only the
  // first `threshold` are used.
  const entropy = combineBytes(parsed.slice(0, threshold));

  // The set id is derived from the secret, so recomputing it proves the
  // reconstruction actually produced the phrase these shares were made from.
  if (setIdFor(entropy) !== setId) {
    throw new Error('Those shares did not reconstruct the phrase they were made from. One of them is corrupt.');
  }

  const hex = `0x${[...entropy].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  let mnemonic;
  try {
    mnemonic = Mnemonic.fromEntropy(hex);
  } catch {
    throw new Error('Those shares did not reconstruct a valid phrase.');
  }

  return { phrase: mnemonic.phrase, wordCount: mnemonic.phrase.split(' ').length, sharesUsed: threshold };
}

/** Checks a share is readable and reports what it belongs to, without combining. */
export function inspectShare(text) {
  const share = decodeShare(text);
  return {
    index: share.index,
    threshold: share.threshold,
    bytes: share.bytes.length,
    // 16 bytes of entropy is a 12-word phrase, 32 is 24 words.
    impliedWords: share.bytes.length === 16 ? 12 : share.bytes.length === 32 ? 24 : null,
  };
}

export { splitBytes, combineBytes, MAX_SHARES };
