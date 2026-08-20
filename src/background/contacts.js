import { getAddress, isAddress } from 'ethers';
import { local } from './storage.js';
import { getProvider } from './networks.js';

const read = () => local.get('contacts', []);
const MAX_LABEL = 40;
const MAX_NAME = 60;

/**
 * Contacts are sorted favourites-first, then by how recently they were used,
 * then alphabetically. Recency matters more than name order once an address
 * book has more than a handful of entries.
 */
export async function listContacts() {
  const contacts = await read();
  return contacts
    .map(normalizeContact)
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
}

/**
 * Accepts a raw address or an ENS name. ENS is resolved here rather than in the
 * UI so the stored value is always a checksummed address — an address book full
 * of unresolved names would break the moment ENS is unreachable.
 */
async function resolveContactAddress(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Enter an address or ENS name.');

  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    const hasUpper = /[A-F]/.test(value.slice(2));
    const hasLower = /[a-f]/.test(value.slice(2));
    if (hasUpper && hasLower) {
      try {
        return { address: getAddress(value), ens: null };
      } catch {
        throw new Error('That address fails its EIP-55 checksum. Re-copy it — a character is wrong.');
      }
    }
    return { address: getAddress(value.toLowerCase()), ens: null };
  }

  if (/^0x/i.test(value)) {
    throw new Error(`An address needs 40 hex characters after 0x; that one has ${value.length - 2}.`);
  }
  if (!value.includes('.')) throw new Error('That does not look like an address or an ENS name.');

  const provider = await getProvider('0x1');
  const resolved = await provider.resolveName(value).catch(() => null);
  if (!resolved) throw new Error(`Could not resolve ${value}. ENS names resolve on Ethereum mainnet.`);
  return { address: getAddress(resolved), ens: value.toLowerCase() };
}

export async function addContact({ name, address, label = '', favorite = false }) {
  const cleanName = validateName(name);
  const { address: checksum, ens } = await resolveContactAddress(address);

  const contacts = await read();
  const clash = contacts.find((contact) => contact.address.toLowerCase() === checksum.toLowerCase());
  if (clash) throw new Error(`That address is already saved as "${clash.name}".`);
  if (contacts.some((contact) => contact.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error(`You already have a contact called "${cleanName}".`);
  }

  const contact = {
    id: crypto.randomUUID(),
    name: cleanName,
    address: checksum,
    ens,
    label: cleanLabel(label),
    favorite: Boolean(favorite),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: null,
    useCount: 0,
  };
  await local.set({ contacts: [...contacts, contact] });
  return contact;
}

export async function updateContact({ id, name, address, label = '', favorite = false }) {
  const contacts = await read();
  const existing = contacts.find((contact) => contact.id === id);
  if (!existing) throw new Error('Contact not found.');

  const cleanName = validateName(name);
  const { address: checksum, ens } = await resolveContactAddress(address);

  const addressClash = contacts.find(
    (contact) => contact.id !== id && contact.address.toLowerCase() === checksum.toLowerCase()
  );
  if (addressClash) throw new Error(`That address is already saved as "${addressClash.name}".`);
  if (contacts.some((contact) => contact.id !== id && contact.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error(`You already have a contact called "${cleanName}".`);
  }

  const updated = {
    ...normalizeContact(existing),
    name: cleanName,
    address: checksum,
    ens,
    label: cleanLabel(label),
    favorite: Boolean(favorite),
    updatedAt: Date.now(),
  };
  await local.set({ contacts: contacts.map((contact) => (contact.id === id ? updated : contact)) });
  return updated;
}

export async function toggleFavorite({ id }) {
  const contacts = await read();
  const existing = contacts.find((contact) => contact.id === id);
  if (!existing) throw new Error('Contact not found.');

  const updated = { ...normalizeContact(existing), favorite: !existing.favorite, updatedAt: Date.now() };
  await local.set({ contacts: contacts.map((contact) => (contact.id === id ? updated : contact)) });
  return updated;
}

export async function removeContact({ id }) {
  const contacts = await read();
  if (!contacts.some((contact) => contact.id === id)) throw new Error('Contact not found.');
  await local.set({ contacts: contacts.filter((contact) => contact.id !== id) });
  return { ok: true };
}

/** Called after a successful send, so "recently used" ordering reflects reality. */
export async function recordContactUse(address) {
  if (!address) return null;
  const contacts = await read();
  const target = contacts.find((contact) => contact.address.toLowerCase() === address.toLowerCase());
  if (!target) return null;

  const updated = {
    ...normalizeContact(target),
    lastUsedAt: Date.now(),
    useCount: (target.useCount ?? 0) + 1,
  };
  await local.set({ contacts: contacts.map((contact) => (contact.id === target.id ? updated : contact)) });
  return updated;
}

/** Name lookup for an address — lets the UI label a recipient the user knows. */
export async function findContactByAddress(address) {
  if (!address) return null;
  const contacts = await read();
  return contacts.map(normalizeContact).find((c) => c.address.toLowerCase() === address.toLowerCase()) ?? null;
}

/** Every distinct label in use, for the filter chips in the address book. */
export async function listLabels() {
  const contacts = await read();
  return [...new Set(contacts.map((contact) => cleanLabel(contact.label)).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------
export async function exportContacts() {
  const contacts = await listContacts();
  return {
    format: 'adrix-contacts',
    version: 1,
    exportedAt: new Date().toISOString(),
    contacts: contacts.map(({ name, address, label, favorite, ens }) => ({ name, address, label, favorite, ens })),
  };
}

/**
 * Merges an exported file back in. Existing addresses are skipped rather than
 * overwritten, and one bad row does not abort the whole import — the caller
 * gets a per-row report instead.
 */
export async function importContacts(payload) {
  let parsed;
  try {
    parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  const rows = Array.isArray(parsed) ? parsed : parsed?.contacts;
  if (!Array.isArray(rows)) throw new Error('No contact list found in that file.');
  if (rows.length > 500) throw new Error('That file holds more than 500 contacts.');

  const contacts = await read();
  const byAddress = new Map(contacts.map((contact) => [contact.address.toLowerCase(), contact]));
  const usedNames = new Set(contacts.map((contact) => contact.name.toLowerCase()));

  const added = [];
  const skipped = [];

  for (const row of rows) {
    try {
      const name = validateName(row?.name);
      if (!isAddress(String(row?.address ?? '').trim())) throw new Error('address is not valid');
      const checksum = getAddress(String(row.address).trim());

      if (byAddress.has(checksum.toLowerCase())) {
        skipped.push({ name, reason: `already saved as "${byAddress.get(checksum.toLowerCase()).name}"` });
        continue;
      }

      // Names must stay unique, so a collision gets a numeric suffix rather
      // than being dropped.
      let finalName = name;
      let suffix = 2;
      while (usedNames.has(finalName.toLowerCase())) finalName = `${name} ${suffix++}`;

      const contact = {
        id: crypto.randomUUID(),
        name: finalName,
        address: checksum,
        ens: typeof row.ens === 'string' ? row.ens : null,
        label: cleanLabel(row.label),
        favorite: Boolean(row.favorite),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastUsedAt: null,
        useCount: 0,
      };
      contacts.push(contact);
      byAddress.set(checksum.toLowerCase(), contact);
      usedNames.add(finalName.toLowerCase());
      added.push(contact);
    } catch (err) {
      skipped.push({ name: String(row?.name ?? 'unnamed'), reason: err.message });
    }
  }

  await local.set({ contacts });
  return { added: added.length, skipped, total: rows.length };
}

// ---------------------------------------------------------------------------
function validateName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Enter a contact name.');
  if (clean.length > MAX_NAME) throw new Error(`Names are limited to ${MAX_NAME} characters.`);
  return clean;
}

function cleanLabel(label) {
  return String(label ?? '').trim().slice(0, MAX_LABEL);
}

function normalizeContact(contact) {
  return {
    ...contact,
    label: cleanLabel(contact.label),
    favorite: Boolean(contact.favorite),
    ens: contact.ens ?? null,
    lastUsedAt: contact.lastUsedAt ?? null,
    useCount: contact.useCount ?? 0,
  };
}
