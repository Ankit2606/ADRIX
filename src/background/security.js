const SCAM_DOMAINS = [
  'evil-phishing.com',
  'fake-miniwallet.io',
  'scam-mint.org',
  'claim-airdrop-now.xyz'
];

const MALICIOUS_ADDRESSES = [
  '0xbad0000000000000000000000000000000000000',
  '0x6660000000000000000000000000000000000666'
];

export function isDomainFlagged(origin) {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return SCAM_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

export function isAddressFlagged(address) {
  if (!address) return false;
  return MALICIOUS_ADDRESSES.includes(address.toLowerCase());
}
