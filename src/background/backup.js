// Encrypted backup of everything that is not key material.
//
// What this deliberately does NOT contain: the recovery phrase, any private
// key, and the vault itself. Exporting those to a file turns a
// memory-only-while-unlocked secret into a document that can be copied once and
// attacked offline forever, at whatever password strength the user chose that
// day. The recovery phrase already is the key backup, and it is the only one
// that should exist.
//
// What it does contain is everything the phrase cannot restore: the address
// book, account names, custom networks and their endpoints, tracked tokens and
// NFTs, transaction notes and tags, and display settings. Restore a wallet from
// its phrase and all of that is gone; this is the file that brings it back.

import { local } from './storage.js';
import { encryptVault, decryptVault } from './vault.js';
import * as contacts from './contacts.js';

export const BACKUP_FORMAT = 'adrix-backup';
export const BACKUP_VERSION = 1;

/** Sections a user can include or leave out, independently, in both directions. */
export const BACKUP_SECTIONS = [
  { key: 'contacts', label: 'Address book', hint: 'Names, labels, favourites' },
  { key: 'accountNames', label: 'Account names', hint: 'Labels only — never keys' },
  { key: 'networks', label: 'Custom networks', hint: 'Added chains and edited RPC endpoints' },
  { key: 'tokens', label: 'Tracked tokens and NFTs', hint: 'Per network, including hidden ones' },
  { key: 'tokenLists', label: 'Token list URLs', hint: 'The sources, refetched on restore' },
  { key: 'notes', label: 'Transaction notes and tags', hint: 'Matched back by transaction hash' },
  { key: 'settings', label: 'Preferences', hint: 'Theme, currency, language, auto-lock' },
  {
    key: 'sites',
    label: 'Connected site permissions',
    hint: 'Which dApps may see which accounts',
    // Restoring a grant re-authorises a site without it asking again, so this
    // one is never on unless the user says so.
    sensitive: true,
  },
];

const DEFAULT_SECTIONS = Object.fromEntries(BACKUP_SECTIONS.map((s) => [s.key, !s.sensitive]));

function appVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
}

/** Gathers the selected sections out of local storage. */
async function collect(sections) {
  const payload = {};

  if (sections.contacts) payload.contacts = (await contacts.exportContacts()).contacts;

  if (sections.accountNames) {
    // Addresses and labels only. No index, no vault id, no key material — this
    // is a naming layer applied over accounts the phrase already derived.
    const accounts = await local.get('accounts', []);
    payload.accountNames = accounts.map((account) => ({
      address: account.address,
      name: account.name,
      hidden: Boolean(account.hidden),
    }));
  }

  if (sections.networks) {
    payload.customNetworks = await local.get('customNetworks', {});
    payload.networkOverrides = await local.get('networkOverrides', {});
  }

  if (sections.tokens) {
    payload.tokens = await local.get('tokens', {});
    payload.nfts = await local.get('nfts', {});
  }

  if (sections.tokenLists) {
    // Only the URLs. The bodies are large, refetchable, and would go stale in
    // the file the moment the publisher updated them.
    const lists = await local.get('tokenLists', {});
    payload.tokenLists = Object.values(lists).map((list) => ({ url: list.url, enabled: list.enabled !== false }));
  }

  if (sections.notes) {
    const activity = await local.get('activity', []);
    payload.notes = activity
      .filter((tx) => tx.note || tx.tags?.length)
      .map((tx) => ({ hash: tx.hash, note: tx.note ?? '', tags: tx.tags ?? [] }));
  }

  if (sections.settings) {
    const [theme, currency, locale, autoLockMinutes, showTestnets, ensAvatars] = await Promise.all([
      local.get('theme', 'dark'),
      local.get('fiatCurrency', 'usd'),
      local.get('locale', 'en'),
      local.get('autoLockMinutes', 15),
      local.get('showTestnets', true),
      local.get('ensAvatars', true),
    ]);
    payload.settings = { theme, currency, locale, autoLockMinutes, showTestnets, ensAvatars };
  }

  if (sections.sites) payload.permissions = await local.get('permissions', {});

  return payload;
}

function summarise(payload) {
  const countChainMap = (map) =>
    Object.values(map ?? {}).reduce((sum, byKey) => sum + Object.keys(byKey ?? {}).length, 0);

  return {
    contacts: payload.contacts?.length ?? 0,
    accountNames: payload.accountNames?.length ?? 0,
    customNetworks: Object.keys(payload.customNetworks ?? {}).length,
    networkOverrides: Object.keys(payload.networkOverrides ?? {}).length,
    tokens: countChainMap(payload.tokens),
    nfts: countChainMap(payload.nfts),
    tokenLists: payload.tokenLists?.length ?? 0,
    notes: payload.notes?.length ?? 0,
    settings: payload.settings ? 1 : 0,
    sites: Object.keys(payload.permissions ?? {}).length,
  };
}

/**
 * Produces the file. Everything except the format header is inside the
 * ciphertext — a plaintext summary would leak how many accounts and which
 * networks a wallet has to anyone who finds the file.
 */
export async function exportBackup(password, sections = DEFAULT_SECTIONS) {
  if (String(password ?? '').length < 8) {
    throw new Error('Use a backup password of at least 8 characters.');
  }

  const payload = await collect({ ...DEFAULT_SECTIONS, ...sections });
  const body = { createdAt: Date.now(), appVersion: appVersion(), payload };

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    // Enough to tell two files apart in a downloads folder, and no more.
    createdAt: new Date().toISOString(),
    encrypted: await encryptVault(password, body),
  };
}

function parseFile(file) {
  let parsed;
  try {
    parsed = typeof file === 'string' ? JSON.parse(file) : file;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (parsed?.format !== BACKUP_FORMAT) {
    throw new Error('That is not an ADRIX backup file.');
  }
  if (Number(parsed.version) > BACKUP_VERSION) {
    throw new Error(`That backup was written by a newer version of ADRIX (format ${parsed.version}).`);
  }
  if (!parsed.encrypted?.data) throw new Error('That backup file is missing its encrypted contents.');
  return parsed;
}

/** Decrypts and reports what is inside, without changing anything. */
export async function previewBackup(password, file) {
  const parsed = parseFile(file);
  const body = await decryptVault(password, parsed.encrypted);

  return {
    createdAt: body.createdAt ?? null,
    appVersion: body.appVersion ?? 'unknown',
    summary: summarise(body.payload ?? {}),
    available: Object.fromEntries(
      BACKUP_SECTIONS.map((section) => [section.key, sectionPresent(section.key, body.payload ?? {})])
    ),
  };
}

function sectionPresent(key, payload) {
  switch (key) {
    case 'contacts':
      return Boolean(payload.contacts?.length);
    case 'accountNames':
      return Boolean(payload.accountNames?.length);
    case 'networks':
      return Boolean(
        Object.keys(payload.customNetworks ?? {}).length || Object.keys(payload.networkOverrides ?? {}).length
      );
    case 'tokens':
      return Boolean(Object.keys(payload.tokens ?? {}).length || Object.keys(payload.nfts ?? {}).length);
    case 'tokenLists':
      return Boolean(payload.tokenLists?.length);
    case 'notes':
      return Boolean(payload.notes?.length);
    case 'settings':
      return Boolean(payload.settings);
    case 'sites':
      return Boolean(Object.keys(payload.permissions ?? {}).length);
    default:
      return false;
  }
}

/**
 * Merges a backup in. Never destructive: existing entries win over the file, so
 * restoring an old backup cannot silently roll back something newer. The report
 * says what was applied and what was skipped rather than claiming success.
 */
export async function restoreBackup(password, file, sections = DEFAULT_SECTIONS) {
  const parsed = parseFile(file);
  const body = await decryptVault(password, parsed.encrypted);
  const payload = body.payload ?? {};
  const chosen = { ...DEFAULT_SECTIONS, ...sections };
  const report = {};

  if (chosen.contacts && payload.contacts?.length) {
    const result = await contacts.importContacts({ contacts: payload.contacts });
    report.contacts = { added: result.added, skipped: result.skipped.length };
  }

  if (chosen.accountNames && payload.accountNames?.length) {
    const accounts = await local.get('accounts', []);
    const byAddress = new Map(payload.accountNames.map((row) => [row.address.toLowerCase(), row]));
    let renamed = 0;
    // Only accounts that already exist are touched. A backup must never be able
    // to conjure an account the current vault cannot actually sign for.
    const next = accounts.map((account) => {
      const row = byAddress.get(account.address.toLowerCase());
      if (!row || row.name === account.name) return account;
      renamed += 1;
      return { ...account, name: row.name, hidden: row.hidden ?? account.hidden };
    });
    await local.set({ accounts: next });
    report.accountNames = { renamed, unmatched: payload.accountNames.length - renamed };
  }

  if (chosen.networks) {
    const custom = await local.get('customNetworks', {});
    let added = 0;
    for (const [chainId, network] of Object.entries(payload.customNetworks ?? {})) {
      if (custom[chainId]) continue;
      custom[chainId] = network;
      added += 1;
    }
    await local.set({ customNetworks: custom });

    const overrides = await local.get('networkOverrides', {});
    let restoredOverrides = 0;
    for (const [chainId, patch] of Object.entries(payload.networkOverrides ?? {})) {
      if (overrides[chainId]) continue;
      overrides[chainId] = patch;
      restoredOverrides += 1;
    }
    await local.set({ networkOverrides: overrides });
    report.networks = { added, overrides: restoredOverrides };
  }

  if (chosen.tokens) {
    report.tokens = { added: await mergeChainMap('tokens', payload.tokens) };
    report.nfts = { added: await mergeChainMap('nfts', payload.nfts) };
  }

  if (chosen.tokenLists && payload.tokenLists?.length) {
    // Recorded as pending rather than fetched here: each list is a network call
    // that can fail, and a restore should not hang or half-fail on one bad URL.
    report.tokenLists = { pending: payload.tokenLists.map((entry) => entry.url) };
  }

  if (chosen.notes && payload.notes?.length) {
    const activity = await local.get('activity', []);
    const byHash = new Map(payload.notes.map((row) => [row.hash, row]));
    let applied = 0;
    const next = activity.map((tx) => {
      const row = byHash.get(tx.hash);
      if (!row) return tx;
      applied += 1;
      return { ...tx, note: tx.note || row.note, tags: tx.tags?.length ? tx.tags : row.tags };
    });
    await local.set({ activity: next });
    // Notes for transactions this install has never seen cannot be attached to
    // anything, and saying so is more honest than reporting a partial success.
    report.notes = { applied, orphaned: payload.notes.length - applied };
  }

  if (chosen.settings && payload.settings) {
    const s = payload.settings;
    await local.set({
      theme: s.theme ?? 'dark',
      fiatCurrency: s.currency ?? 'usd',
      locale: s.locale ?? 'en',
      autoLockMinutes: s.autoLockMinutes ?? 15,
      showTestnets: s.showTestnets ?? true,
      ensAvatars: s.ensAvatars ?? true,
    });
    report.settings = { applied: true };
  }

  if (chosen.sites && payload.permissions) {
    const current = await local.get('permissions', {});
    let added = 0;
    for (const [origin, grant] of Object.entries(payload.permissions)) {
      if (current[origin]) continue;
      current[origin] = grant;
      added += 1;
    }
    await local.set({ permissions: current });
    report.sites = { added };
  }

  return { report, createdAt: body.createdAt ?? null, appVersion: body.appVersion ?? 'unknown' };
}

async function mergeChainMap(key, incoming) {
  if (!incoming || !Object.keys(incoming).length) return 0;
  const existing = await local.get(key, {});
  let added = 0;

  for (const [chainId, entries] of Object.entries(incoming)) {
    existing[chainId] ??= {};
    for (const [entryKey, entry] of Object.entries(entries ?? {})) {
      if (existing[chainId][entryKey]) continue;
      existing[chainId][entryKey] = entry;
      added += 1;
    }
  }

  await local.set({ [key]: existing });
  return added;
}
