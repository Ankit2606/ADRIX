// Vault encryption. PBKDF2-SHA256 to stretch the password, AES-GCM to seal the
// payload. Everything here runs in the service worker; the plaintext never
// leaves it.

const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptVault(password, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(payload))
  );
  return {
    version: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(ciphertext),
  };
}

export async function decryptVault(password, vault) {
  const key = await deriveKey(password, fromBase64(vault.salt));
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(vault.iv) }, key, fromBase64(vault.data));
  } catch {
    // AES-GCM fails authentication on a wrong password. There is no way to
    // tell that apart from a corrupted vault, and no reason to.
    throw Object.assign(new Error('Wrong password.'), { code: 'BAD_PASSWORD' });
  }
  return JSON.parse(decoder.decode(plaintext));
}
