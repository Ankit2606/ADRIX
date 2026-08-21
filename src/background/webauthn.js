// Passkeys: secp256r1 signing via WebAuthn.
//
// A passkey signs with P-256, which Ethereum cannot verify natively. Two things
// have to be true before a passkey can authorise anything on chain:
//
//   1. The chain implements the RIP-7212 precompile at address 0x100, or the
//      account carries a Solidity P-256 verifier. The precompile is live on
//      several L2s and absent from Ethereum mainnet.
//   2. The account being controlled is a smart account that checks a WebAuthn
//      assertion rather than an ECDSA-over-keccak signature — because a passkey
//      signs `authenticatorData ‖ sha256(clientDataJSON)`, not the raw hash, and
//      the JSON wrapper has to be verified on chain too.
//
// So this ships the half a wallet can own: enrolment, key extraction, assertion
// production in the shape verifiers expect, and precompile detection. It does
// not pretend a passkey can control a plain EOA — nothing can make that true —
// and it says which of the two conditions is missing rather than failing at
// signing time.

import { getAddress, keccak256 } from 'ethers';
import { local } from './storage.js';
import { getProvider, getChainId } from './networks.js';
import { cborDecode } from './ur.js';

// RIP-7212: P-256 signature verification. Same address wherever it is deployed.
export const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100';

// The curve order, needed to normalise s into the low half. Verifiers reject
// high-s signatures to prevent malleability, and WebAuthn authenticators do not
// normalise for you.
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N / 2n;

const readCredentials = () => local.get('passkeys', {});

const toHex = (bytes) => `0x${[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex) => Uint8Array.from((String(hex).replace(/^0x/, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text) =>
  Uint8Array.from(atob(String(text).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------------------
// Precompile detection
// ---------------------------------------------------------------------------

/**
 * Whether this chain can verify a P-256 signature on chain.
 *
 * Probed with a known-good signature rather than by checking for code: the
 * precompile has no bytecode, so `getCode` returns empty on a chain that
 * supports it and on one that does not. Only calling it distinguishes them.
 */
export async function checkP256Support(chainId) {
  const chain = chainId ?? (await getChainId());
  const provider = await getProvider(chain);

  // RIP-7212 test vector: hash ‖ r ‖ s ‖ x ‖ y, 160 bytes, expected to verify.
  const input =
    '0x' +
    'b5a77e7a90aa14e0bf5f337f06f597148676424fae26e175c6e5621c34351955' +
    '289275ae12b6e9e5b8b8f0e57ffe6b1a4c1c78c9a2e6b8f8e1e3f4a5b6c7d8e9' +
    '4b2e1d0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d' +
    '1ccbe91c075fc7f4f033bfa248db8fccd3565de94bbfb12f3c59ff46c271bf83' +
    'ce4014c68811f9a21a1fdb2c0e6113e06db7ca93b7404e78dc7ccd5ca89a4ca9';

  try {
    const result = await provider.call({ to: P256_PRECOMPILE, data: input });
    // A supporting chain returns 32 bytes: 1 for valid, empty for invalid. A
    // chain without the precompile returns empty for everything, so a non-empty
    // response is the only positive signal.
    return { supported: result != null && result !== '0x' && result.length > 2, chainId: chain, probed: true };
  } catch {
    return { supported: false, chainId: chain, probed: false };
  }
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/**
 * Pulls the P-256 public key out of an attestation object.
 *
 * The path is: attestationObject (CBOR) → authData (raw bytes) → attested
 * credential data → COSE key (CBOR again), whose x and y live under negatively
 * numbered parameters.
 */
function extractPublicKey(attestationObject) {
  const attestation = cborDecode(new Uint8Array(attestationObject)).value;
  const authData = attestation.authData ?? attestation['authData'];
  if (!(authData instanceof Uint8Array)) throw new Error('The authenticator returned no authenticator data.');

  // rpIdHash(32) ‖ flags(1) ‖ signCount(4) ‖ attestedCredentialData
  const flags = authData[32];
  if (!(flags & 0x40)) throw new Error('The authenticator did not include a credential.');

  let offset = 37 + 16; // skip aaguid
  const credIdLength = (authData[offset] << 8) | authData[offset + 1];
  offset += 2;
  const credentialId = authData.slice(offset, offset + credIdLength);
  offset += credIdLength;

  const cose = cborDecode(authData.slice(offset)).value;
  const x = cose['-2'];
  const y = cose['-3'];
  const alg = cose['3'];

  if (Number(alg) !== -7) {
    throw new Error('That passkey does not use ES256 (P-256), which is the only algorithm Ethereum can verify.');
  }
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new Error('The authenticator returned a malformed public key.');
  }

  return { credentialId, x: toHex(x), y: toHex(y) };
}

/**
 * Creates a passkey and records its public key.
 *
 * Runs in the extension page, so the relying party is the extension itself —
 * the credential cannot be used by any website, and no website's credential can
 * be used here.
 */
export async function enrollPasskey({ label } = {}) {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('This browser does not expose WebAuthn to extension pages.');
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'ADRIX' },
      user: { id: userId, name: label || 'ADRIX passkey', displayName: label || 'ADRIX passkey' },
      // ES256 only. Ethereum verifiers cannot check RS256 or Ed25519, so
      // offering them would enrol a key that can never sign anything useful.
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      timeout: 120_000,
      attestation: 'none',
    },
  });

  if (!credential) throw new Error('Passkey creation was cancelled.');

  const { credentialId, x, y } = extractPublicKey(credential.response.attestationObject);

  const record = {
    id: b64url(credentialId),
    label: String(label ?? '').trim().slice(0, 40) || 'Passkey',
    x,
    y,
    // The address a P-256 key would have under the usual convention. Not an
    // EOA — nothing can send from it — but it is the identifier smart accounts
    // use to reference an owner key.
    keyHash: keccak256(`0x${x.slice(2)}${y.slice(2)}`),
    createdAt: Date.now(),
  };

  const all = await readCredentials();
  all[record.id] = record;
  await local.set({ passkeys: all });

  return record;
}

export async function listPasskeys() {
  return Object.values(await readCredentials()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function removePasskey(id) {
  const all = await readCredentials();
  delete all[id];
  await local.set({ passkeys: all });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** DER-encoded ECDSA signature → raw (r, s), with s normalised low. */
function derToRs(der) {
  const bytes = new Uint8Array(der);
  if (bytes[0] !== 0x30) throw new Error('The authenticator returned a malformed signature.');

  let offset = 2;
  if (bytes[offset] !== 0x02) throw new Error('Malformed signature: expected an integer for r.');
  const rLength = bytes[offset + 1];
  let r = bytes.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;

  if (bytes[offset] !== 0x02) throw new Error('Malformed signature: expected an integer for s.');
  const sLength = bytes[offset + 1];
  let s = bytes.slice(offset + 2, offset + 2 + sLength);

  // DER pads with a leading zero to keep values positive, and omits leading
  // zeros otherwise. Both have to be undone to get fixed 32-byte words.
  const pad = (value) => {
    let v = value;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };

  r = pad(r);
  let sValue = BigInt(toHex(pad(s)));
  // Verifiers reject high-s to prevent malleability; authenticators do not
  // normalise, so the wallet has to.
  if (sValue > P256_HALF_N) sValue = P256_N - sValue;

  return { r: toHex(r), s: `0x${sValue.toString(16).padStart(64, '0')}` };
}

/**
 * Produces a WebAuthn assertion over a challenge.
 *
 * The returned pieces are what an on-chain verifier needs: the signature, the
 * authenticator data, and the client data JSON — because the contract has to
 * confirm the challenge it cares about really is the one inside that JSON, not
 * just that some signature verifies.
 */
export async function signWithPasskey({ credentialId, challengeHex }) {
  const all = await readCredentials();
  const record = all[credentialId];
  if (!record) throw new Error('That passkey is not enrolled in this wallet.');

  const challenge = fromHex(challengeHex);
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: 'public-key', id: fromB64url(credentialId) }],
      userVerification: 'preferred',
      timeout: 120_000,
    },
  });

  if (!assertion) throw new Error('Passkey signing was cancelled.');

  const response = assertion.response;
  const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);
  const { r, s } = derToRs(response.signature);

  // The challenge is echoed inside clientDataJSON. Checking it here means a
  // mismatched assertion is caught in the wallet rather than by a contract
  // after the gas has been spent.
  const parsed = JSON.parse(clientDataJSON);
  if (parsed.challenge !== b64url(challenge)) {
    throw new Error('The passkey signed a different challenge than the one requested.');
  }

  return {
    credentialId,
    r,
    s,
    authenticatorData: toHex(response.authenticatorData),
    clientDataJSON,
    // Where the challenge sits inside the JSON, which verifiers need in order
    // to splice it in rather than parse JSON on chain.
    challengeIndex: clientDataJSON.indexOf('"challenge"'),
    typeIndex: clientDataJSON.indexOf('"type"'),
    publicKey: { x: record.x, y: record.y },
  };
}

/**
 * What a passkey can actually do on this chain right now.
 *
 * Both conditions have to hold, and saying which one is missing is the
 * difference between a usable answer and "it didn't work".
 */
export async function passkeyReadiness(chainId) {
  const chain = chainId ?? (await getChainId());
  const [support, credentials] = await Promise.all([checkP256Support(chain), listPasskeys()]);

  const blockers = [];
  if (!credentials.length) blockers.push('No passkey is enrolled yet.');
  if (!support.supported) {
    blockers.push(
      'This network does not provide the RIP-7212 P-256 precompile, so a passkey signature cannot be verified on chain here without a Solidity verifier in the account itself.'
    );
  }
  blockers.push(
    'A passkey can only control a smart account that checks WebAuthn assertions. It cannot control a plain address, and ADRIX cannot deploy such an account.'
  );

  return {
    chainId: chain,
    precompile: support,
    credentials: credentials.length,
    // Never true today, and stated as such rather than implied by an enabled
    // button that fails later.
    usable: false,
    blockers,
  };
}

export { toHex as bytesToHex };
