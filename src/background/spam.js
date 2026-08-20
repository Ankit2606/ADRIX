// Heuristics for airdropped junk tokens and NFTs.
//
// Spam tokens exist to get a name into your wallet UI: a URL, a "claim now"
// instruction, or a lookalike of a real symbol. They are pushed to thousands of
// addresses at once and are usually worthless or actively hostile — the claim
// site drains whoever connects.
//
// Nothing here auto-hides anything. Each check returns a reason, the caller
// scores it, and the user decides. A false positive that silently hides a real
// token would be worse than the spam.

// Symbols worth impersonating. A token calling itself USDC at an address that
// is not the real USDC is either a test deployment or bait.
const IMPERSONATED = new Set([
  'ETH', 'WETH', 'BTC', 'WBTC', 'USDC', 'USDT', 'DAI', 'BNB', 'MATIC', 'POL',
  'ARB', 'OP', 'LINK', 'UNI', 'AAVE', 'SOL', 'XRP', 'USDC.E',
]);

// Contracts the wallet already ships as canonical, keyed by chain.
const KNOWN_GOOD = new Set(
  [
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7',
    '0x6b175474e89094c44da98b954eedeac495271d0f', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    '0x514910771af9ca656af840dff83e8264ecf986ca', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607', '0x4200000000000000000000000000000000000006',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
    '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
    // Majors the token registry does not ship but users hold constantly. Their
    // symbols are in IMPERSONATED, so without these the real token would be
    // flagged as impersonating itself.
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', // UNI
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', // AAVE
    '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
    '0x4200000000000000000000000000000000000042', // OP
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH
    '0xae78736cd615f374d3085123a210448e74fc6393', // rETH
    '0xd533a949740bb3306d119cc777fa900ba034cd52', // CRV
    '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', // SHIB
    '0x6982508145454ce325ddbe47a25d4ec3d2311933', // PEPE
    '0x0d8775f648430679a709e98d2b0cb6250d2887ef', // BAT
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', // MKR
    '0xd31a59c85ae9d8edefec411d448f90841571b89c', // SOL (wrapped)
    '0x0000000000000000000000000000000000001010', // POL native proxy
  ].map((a) => a.toLowerCase())
);

const URL_PATTERN = /(https?:\/\/|www\.|\.(com|net|org|io|xyz|finance|app|site|top|click|live|fi|gift|claim)\b)/i;
// Plural and -ing forms matter: "Rewards" and "Claiming" are the common spellings.
const CLAIM_PATTERN = /\b(claim|airdrop|reward|voucher|giveaway|bonus|free|winner|prize|visit|redeem|access|unlock|eligible)(s|ed|ing)?\b/i;
// Zero-width and bidirectional-override characters are used to disguise a name
// as a different one in the UI.
const INVISIBLE_PATTERN = /[​-‏‪-‮⁠-⁤﻿]/;
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/**
 * Signals are weighted rather than counted. A URL in a token name is close to
 * conclusive; a long symbol on its own is not. The threshold is 2, so one
 * strong signal or two weak ones flags the token.
 */
const STRONG = 2;
const WEAK = 1;

export function scoreToken(token, { chainId } = {}) {
  const reasons = [];
  let score = 0;
  const flag = (weight, reason) => {
    score += weight;
    reasons.push(reason);
  };

  const name = String(token?.name ?? '');
  const symbol = String(token?.symbol ?? '');
  const address = String(token?.address ?? '').toLowerCase();
  const haystack = `${name} ${symbol}`;

  // A contract the wallet ships as canonical is never spam.
  if (KNOWN_GOOD.has(address)) return { score: 0, reasons: [], likelySpam: false, trusted: true };

  // A web address in a token name has no legitimate purpose — it exists to be
  // typed into a browser.
  if (URL_PATTERN.test(haystack)) flag(STRONG, 'The name or symbol contains a web address.');
  if (INVISIBLE_PATTERN.test(haystack)) {
    flag(STRONG, 'The name hides invisible or direction-changing characters.');
  }
  // A major symbol at an address the wallet does not recognise is suspicious,
  // but only WEAK: the canonical-address list cannot cover every chain and
  // every bridged variant, so on its own this would flag real holdings. It
  // needs corroborating evidence before the token is called spam.
  if (IMPERSONATED.has(symbol.toUpperCase().trim())) {
    flag(WEAK, `It uses the symbol ${symbol.toUpperCase().trim()} from an address ADRIX does not recognise.`);
  }

  if (CLAIM_PATTERN.test(haystack)) flag(WEAK, 'The name reads like an airdrop or claim prompt.');
  if (EMOJI_PATTERN.test(haystack)) flag(WEAK, 'The name contains emoji, which real tokens rarely use.');
  if (symbol.length > 12) flag(WEAK, 'The symbol is unusually long.');
  if (name.length > 60) flag(WEAK, 'The name is unusually long.');
  if (symbol && symbol !== symbol.trim()) flag(WEAK, 'The symbol is padded with whitespace.');

  // Balances far beyond any plausible supply are a hallmark of junk mints.
  const balance = Number(token?.balance);
  if (Number.isFinite(balance) && balance > 1e12) flag(WEAK, 'The balance is implausibly large.');

  // Decimals outside the normal range break amount rendering everywhere.
  const decimals = Number(token?.decimals);
  if (Number.isFinite(decimals) && (decimals > 24 || decimals < 0)) {
    flag(WEAK, `It declares ${decimals} decimals, which is outside the normal range.`);
  }

  return { score, reasons, likelySpam: score >= 2, trusted: false };
}

/** Same idea for NFTs, where the metadata carries the payload. */
export function scoreNft(nft) {
  const reasons = [];
  let score = 0;
  const flag = (weight, reason) => {
    score += weight;
    reasons.push(reason);
  };

  const haystack = `${nft?.title ?? ''} ${nft?.name ?? ''} ${nft?.symbol ?? ''} ${nft?.description ?? ''}`;

  if (URL_PATTERN.test(haystack)) flag(STRONG, 'The metadata contains a web address.');
  if (INVISIBLE_PATTERN.test(haystack)) flag(STRONG, 'The metadata hides invisible characters.');
  if (CLAIM_PATTERN.test(haystack)) flag(WEAK, 'The metadata reads like an airdrop or claim prompt.');
  if (String(nft?.title ?? '').length > 80) flag(WEAK, 'The title is unusually long.');

  // An NFT that arrived unasked and has no image is almost always a delivery
  // vehicle for the text in its name.
  if (!nft?.image && CLAIM_PATTERN.test(haystack)) flag(WEAK, 'It has no image, only text.');

  return { score, reasons, likelySpam: score >= 2 };
}

/** Annotates a list without changing its order or contents. */
export function annotateTokens(tokens = [], options = {}) {
  return tokens.map((token) => ({ ...token, spam: scoreToken(token, options) }));
}

export function annotateNfts(nfts = []) {
  return nfts.map((nft) => ({ ...nft, spam: scoreNft(nft) }));
}
