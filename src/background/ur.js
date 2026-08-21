// Uniform Resources (UR) — the QR encoding air-gapped signers speak.
//
// Keystone and similar devices exchange data as `ur:type/payload`, where the
// payload is CBOR wrapped in bytewords with a CRC-32 checksum. This implements
// enough of that to hand a transaction to an offline device and read a
// signature back: bytewords (minimal style), CRC-32, a CBOR subset covering the
// structures actually used, and the `eth-sign-request` / `eth-signature` /
// `crypto-hdkey` types.
//
// What is deliberately not implemented: multi-part fountain encoding. Keystone
// splits large payloads across an animated sequence of QR frames using a
// rateless code, and a partial implementation of that would reassemble some
// payloads and silently corrupt others. Multi-part input is detected and
// refused by name instead, and outgoing payloads are size-checked so the wallet
// never produces a QR it cannot itself read back.

// --- bytewords --------------------------------------------------------------
//
// The 256 four-letter words of BCR-2020-012, one per byte value, in spec order.
// "Minimal" style keeps only each word's first and last letter, giving two
// characters per byte — which is what UR puts on the wire.
//
// Transcribed from the specification rather than written from memory: a single
// wrong word silently corrupts every payload, and the assertion below is what
// caught exactly that mistake.
const BYTEWORDS =
  'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzz' +
  'calmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordown' +
  'drawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflap' +
  'flewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhang' +
  'hardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoin' +
  'joltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegs' +
  'liarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknail' +
  'navyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolpose' +
  'puffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilk' +
  'skewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinugly' +
  'undouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhen' +
  'whizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';

// Word list is fixed at 256 entries of four characters; anything else means the
// constant above was edited wrongly, which would corrupt every encode silently.
const WORD_COUNT = BYTEWORDS.length / 4;
if (WORD_COUNT !== 256) throw new Error(`bytewords table is ${WORD_COUNT} entries, expected 256`);

const MINIMAL = [];
const MINIMAL_INDEX = new Map();
for (let i = 0; i < 256; i++) {
  const word = BYTEWORDS.slice(i * 4, i * 4 + 4);
  const pair = word[0] + word[3];
  MINIMAL.push(pair);
  MINIMAL_INDEX.set(pair, i);
}

// --- CRC-32 -----------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeBytewords(bytes) {
  const checksum = crc32(bytes);
  const withCrc = [
    ...bytes,
    (checksum >>> 24) & 0xff,
    (checksum >>> 16) & 0xff,
    (checksum >>> 8) & 0xff,
    checksum & 0xff,
  ];
  return withCrc.map((byte) => MINIMAL[byte]).join('');
}

export function decodeBytewords(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length % 2 !== 0) throw new Error('Malformed bytewords payload.');

  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    const index = MINIMAL_INDEX.get(clean.slice(i, i + 2));
    if (index === undefined) throw new Error(`Unrecognised byteword "${clean.slice(i, i + 2)}".`);
    bytes.push(index);
  }
  if (bytes.length < 5) throw new Error('Bytewords payload is too short to contain a checksum.');

  const body = Uint8Array.from(bytes.slice(0, -4));
  const expected = ((bytes.at(-4) << 24) | (bytes.at(-3) << 16) | (bytes.at(-2) << 8) | bytes.at(-1)) >>> 0;
  if (crc32(body) !== expected) {
    // A checksum failure on a scanned QR is almost always a misread frame, not
    // a corrupt device — worth saying so rather than reporting bad data.
    throw new Error('Checksum mismatch. The QR code was probably misread — try scanning again.');
  }
  return body;
}

// --- CBOR (the subset these structures use) ---------------------------------
function cborLength(major, length) {
  const type = major << 5;
  if (length < 24) return [type | length];
  if (length < 0x100) return [type | 24, length];
  if (length < 0x10000) return [type | 25, length >> 8, length & 0xff];
  return [type | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

/**
 * Encodes the value shapes these UR types need: unsigned integers, byte
 * strings, text, arrays, and integer-keyed maps. Deliberately not a general
 * CBOR encoder — the structures are fixed and a partial general implementation
 * would be a liability.
 */
export function cborEncode(value) {
  if (value instanceof Uint8Array) return [...cborLength(2, value.length), ...value];
  if (typeof value === 'string') {
    const utf8 = new TextEncoder().encode(value);
    return [...cborLength(3, utf8.length), ...utf8];
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = Number(value);
    if (n < 0) throw new Error('Negative integers are not used by these UR types.');
    return cborLength(0, n);
  }
  if (Array.isArray(value)) {
    return [...cborLength(4, value.length), ...value.flatMap((entry) => cborEncode(entry))];
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null);
    return [
      ...cborLength(5, entries.length),
      ...entries.flatMap(([key, v]) => [...cborEncode(Number(key)), ...cborEncode(v)]),
    ];
  }
  throw new Error('Unsupported CBOR value.');
}

function readHead(bytes, offset) {
  const initial = bytes[offset];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let value = info;
  let next = offset + 1;

  if (info === 24) {
    value = bytes[next];
    next += 1;
  } else if (info === 25) {
    value = (bytes[next] << 8) | bytes[next + 1];
    next += 2;
  } else if (info === 26) {
    value = ((bytes[next] << 24) | (bytes[next + 1] << 16) | (bytes[next + 2] << 8) | bytes[next + 3]) >>> 0;
    next += 4;
  } else if (info === 27) {
    // 64-bit lengths do not appear in these structures, and treating one as
    // valid would let a malformed payload drive a huge allocation.
    throw new Error('64-bit CBOR lengths are not supported.');
  } else if (info > 27) {
    throw new Error('Malformed CBOR header.');
  }

  return { major, value, next };
}

export function cborDecode(bytes, offset = 0) {
  const { major, value, next } = readHead(bytes, offset);

  if (major === 0) return { value, next };
  // Negative integers, encoded as -1 - n. Absent from the UR types here but
  // required by COSE keys, whose parameters are negatively numbered.
  if (major === 1) return { value: -1 - value, next };
  if (major === 2) return { value: bytes.slice(next, next + value), next: next + value };
  if (major === 3) return { value: new TextDecoder().decode(bytes.slice(next, next + value)), next: next + value };
  if (major === 4) {
    const items = [];
    let cursor = next;
    for (let i = 0; i < value; i++) {
      const entry = cborDecode(bytes, cursor);
      items.push(entry.value);
      cursor = entry.next;
    }
    return { value: items, next: cursor };
  }
  if (major === 5) {
    const map = {};
    let cursor = next;
    for (let i = 0; i < value; i++) {
      const key = cborDecode(bytes, cursor);
      const val = cborDecode(bytes, key.next);
      map[String(key.value)] = val.value;
      cursor = val.next;
    }
    return { value: map, next: cursor };
  }
  if (major === 6) {
    // Tagged value: the tag itself is not needed by any structure here, so the
    // content is returned directly.
    return cborDecode(bytes, next);
  }
  if (major === 7) {
    if (value === 20) return { value: false, next };
    if (value === 21) return { value: true, next };
    if (value === 22) return { value: null, next };
  }
  throw new Error(`Unsupported CBOR major type ${major}.`);
}

// --- UR ---------------------------------------------------------------------
const hexToBytes = (hex) => {
  const clean = String(hex ?? '').replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

// A QR holding much more than this stops being scannable at popup size, and a
// frame the wallet cannot read back is worse than an honest refusal.
export const MAX_SINGLE_PART_BYTES = 600;

export function encodeUr(type, payloadBytes) {
  if (payloadBytes.length > MAX_SINGLE_PART_BYTES) {
    throw new Error(
      `This payload is ${payloadBytes.length} bytes. ADRIX only produces single-frame QR codes, and anything past ${MAX_SINGLE_PART_BYTES} needs the animated multi-part format it does not implement.`
    );
  }
  return `ur:${type}/${encodeBytewords(payloadBytes)}`;
}

export function parseUr(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw.startsWith('ur:')) throw new Error('That QR code is not a UR payload.');

  const parts = raw.slice(3).split('/');
  if (parts.length < 2) throw new Error('Malformed UR: no payload.');

  const type = parts[0];
  // A sequence marker like 1-3 means this is one frame of an animated sequence.
  if (parts.length > 2 && /^\d+-\d+$/.test(parts[1])) {
    const [, total] = parts[1].split('-');
    throw new Error(
      `This is frame ${parts[1]} of a ${total}-part animated QR. ADRIX only reads single-frame codes, so this payload is too large for it.`
    );
  }

  return { type, payload: decodeBytewords(parts[parts.length - 1]) };
}

// --- eth-sign-request -------------------------------------------------------
//
// Keys per the Keystone spec:
//   1 request-id (uuid bytes)  2 sign-data  3 data-type  4 chain-id
//   5 derivation-path          6 address    7 origin
export const SIGN_DATA_TYPE = {
  transaction: 1, // legacy / typed transaction rlp
  typedData: 2, // EIP-712 json
  message: 3, // personal_sign
  typedTransaction: 4, // EIP-1559 and later, rlp with type prefix
};

/** A 16-byte request id, so a returned signature can be matched to its request. */
function requestId() {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Builds the UR an air-gapped signer scans.
 *
 * The derivation path is included because the device holds the key and needs to
 * know which one to use — the address alone is not enough for it to find the
 * right child key without scanning its whole tree.
 */
export function buildSignRequest({ dataHex, dataType, chainId, address, derivationPath, origin }) {
  const id = requestId();
  const map = {
    1: id,
    2: hexToBytes(dataHex),
    3: dataType,
    4: parseInt(chainId, 16),
    ...(derivationPath ? { 5: derivationPath } : {}),
    ...(address ? { 6: hexToBytes(address) } : {}),
    ...(origin ? { 7: String(origin).slice(0, 60) } : {}),
  };

  const payload = Uint8Array.from(cborEncode(map));
  return {
    ur: encodeUr('eth-sign-request', payload),
    requestId: bytesToHex(id),
    bytes: payload.length,
  };
}

/**
 * Reads a signature back off the device.
 *
 * Keys: 1 request-id, 2 signature (65 bytes r‖s‖v), 3 origin.
 */
export function parseSignature(text) {
  const { type, payload } = parseUr(text);
  if (type !== 'eth-signature') {
    throw new Error(`Expected an eth-signature QR, but this one is "${type}".`);
  }

  const { value } = cborDecode(payload);
  const signature = value['2'];
  if (!(signature instanceof Uint8Array) || signature.length < 64) {
    throw new Error('That QR code did not contain a usable signature.');
  }

  const r = bytesToHex(signature.slice(0, 32));
  const s = bytesToHex(signature.slice(32, 64));
  let v = signature.length > 64 ? signature[64] : null;
  // Devices differ: some return the raw recovery id, some the EIP-155 form.
  // Normalising to 27/28 here keeps every caller from having to know.
  if (v != null && v < 27) v += 27;

  return {
    requestId: value['1'] instanceof Uint8Array ? bytesToHex(value['1']) : null,
    signature: bytesToHex(signature),
    r,
    s,
    v,
    origin: typeof value['3'] === 'string' ? value['3'] : null,
  };
}

/**
 * Reads an account exported from a device as a crypto-hdkey UR.
 *
 * Only the fields needed to add a watch account are taken: the key itself, its
 * derivation path, and the chain code. Everything else in the structure is
 * device metadata.
 */
export function parseHdKey(text) {
  const { type, payload } = parseUr(text);
  if (type !== 'crypto-hdkey' && type !== 'hdkey') {
    throw new Error(`Expected a crypto-hdkey QR, but this one is "${type}".`);
  }

  const { value } = cborDecode(payload);
  const keyData = value['3'];
  if (!(keyData instanceof Uint8Array)) throw new Error('That QR code did not contain a public key.');

  // Key 6 is the origin structure; its key 1 holds the path components.
  const origin = value['6'];
  const components = origin?.['1'];
  let path = null;
  if (Array.isArray(components)) {
    const parts = [];
    for (let i = 0; i < components.length; i += 2) {
      const index = components[i];
      const hardened = components[i + 1];
      parts.push(`${index}${hardened ? "'" : ''}`);
    }
    path = `m/${parts.join('/')}`;
  }

  return {
    publicKey: bytesToHex(keyData),
    chainCode: value['4'] instanceof Uint8Array ? bytesToHex(value['4']) : null,
    path,
    // Only compressed SEC1 keys are usable for address derivation.
    usable: keyData.length === 33,
  };
}

export { bytesToHex, hexToBytes, crc32 };
