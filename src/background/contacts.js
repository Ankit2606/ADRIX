import { getAddress } from 'ethers';
import { local } from './storage.js';

const read = () => local.get('contacts', []);

export async function listContacts() {
  const contacts = await read();
  return contacts
    .map(normalizeContact)
    .slice()
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function addContact({ name, address, label = '', favorite = false }) {
  const cleanName = name?.trim();
  if (!cleanName) throw new Error('Enter a contact name.');

  const checksum = getAddress(address);
  const contacts = await read();
  if (contacts.some((contact) => contact.address.toLowerCase() === checksum.toLowerCase())) {
    throw new Error('That address is already in your address book.');
  }

  const contact = {
    id: crypto.randomUUID(),
    name: cleanName,
    address: checksum,
    label: cleanLabel(label),
    favorite: Boolean(favorite),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await local.set({ contacts: [...contacts, contact] });
  return contact;
}

export async function updateContact({ id, name, address, label = '', favorite = false }) {
  const contacts = await read();
  const existing = contacts.find((contact) => contact.id === id);
  if (!existing) throw new Error('Contact not found.');

  const cleanName = name?.trim();
  if (!cleanName) throw new Error('Enter a contact name.');

  const checksum = getAddress(address);
  if (
    contacts.some(
      (contact) => contact.id !== id && contact.address.toLowerCase() === checksum.toLowerCase()
    )
  ) {
    throw new Error('That address is already in your address book.');
  }

  const updated = {
    ...normalizeContact(existing),
    name: cleanName,
    address: checksum,
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
  await local.set({ contacts: contacts.filter((contact) => contact.id !== id) });
}

function cleanLabel(label) {
  return String(label ?? '').trim().slice(0, 40);
}

function normalizeContact(contact) {
  return {
    ...contact,
    label: cleanLabel(contact.label),
    favorite: Boolean(contact.favorite),
  };
}
