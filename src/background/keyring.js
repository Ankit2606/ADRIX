import { HDNodeWallet, Mnemonic, Wallet, getAddress, isAddress } from 'ethers';
import { local, session } from './storage.js';
import { encryptVault, decryptVault } from './vault.js';

// ---------------------------------------------------------------------------
// Derivation paths
//
// The index goes in a different position depending on the wallet that produced
// the phrase, which is why "my other wallet shows different addresses" is such
// a common support issue. Templates carry {index} wherever it belongs.
// ---------------------------------------------------------------------------
export const DERIVATION_PRESETS = [
  {
    id: 'standard',
    label: 'Default (BIP-44)',
    template: "m/44'/60'/0'/0/{index}",
    hint: 'MetaMask, Rabby, Rainbow, Trust',
  },
  {
    id: 'ledger-live',
    label: 'Ledger Live',
    template: "m/44'/60'/{index}'/0/0",
    hint: 'Accounts created in the Ledger Live app',
  },
  {
    id: 'legacy',
    label: 'Legacy (MEW / MetaMask v6)',
    template: "m/44'/60'/0'/{index}",
    hint: 'Older MyEtherWallet and pre-2018 MetaMask',
  },
];

export const DEFAULT_PATH_TEMPLATE = DERIVATION_PRESETS[0].template;

/** A template must contain {index} exactly once and otherwise look like a path. */
export function validatePathTemplate(template) {
  const clean = String(template ?? '').trim();
  if (!clean.startsWith('m/')) throw new Error("Derivation path must start with m/.");
  if ((clean.match(/\{index\}/g) ?? []).length !== 1) {
    throw new Error('Derivation path must contain {index} exactly once.');
  }
  if (!/^m(\/\d+'?|\/\{index\}'?)+$/.test(clean)) {
    throw new Error("Derivation path may only contain numbers, {index}, / and '.");
  }
  return clean;
}

function derivePath(template, index) {
  return template.replace('{index}', String(index));
}

function deriveHd(mnemonic, index, template = DEFAULT_PATH_TEMPLATE) {
  return HDNodeWallet.fromPhrase(mnemonic, undefined, derivePath(template, index));
}

// ---------------------------------------------------------------------------
// Storage shape
//
//   local.vault      encrypted { vaults: [{ id, name, mnemonic, pathTemplate }],
//                                imported: [privateKey] }
//   local.accounts   [{ address, name, type, index, vaultId }]
//   local.selected   address currently in focus
//   session.secrets  the decrypted payload above — only while unlocked
//
// v1 vaults held { mnemonic, imported } with a single implicit phrase. They are
// migrated on unlock; see migrateSecrets.
// ---------------------------------------------------------------------------

export const hasVault = () => local.get('vault').then(Boolean);
export const isUnlocked = () => session.get('secrets').then(Boolean);

export async function hasRecoveryPhrase() {
  const secrets = await session.get('secrets');
  return Boolean(secrets?.vaults?.length);
}

/** Upgrades a v1 payload in place. Returns [secrets, didChange]. */
function migrateSecrets(raw) {
  if (Array.isArray(raw?.vaults)) return [raw, false];

  const vaults = raw?.mnemonic
    ? [
        {
          id: 'vault-1',
          name: 'Recovery phrase 1',
          mnemonic: raw.mnemonic,
          pathTemplate: DEFAULT_PATH_TEMPLATE,
          createdAt: Date.now(),
        },
      ]
    : [];

  return [{ vaults, imported: raw?.imported ?? [] }, true];
}

/** Attaches vaultId to pre-migration HD accounts so they keep deriving. */
async function migrateAccounts(secrets) {
  const accounts = await listAccounts();
  if (!accounts.some((account) => account.type === 'hd' && !account.vaultId)) return;
  const firstVaultId = secrets.vaults[0]?.id;
  if (!firstVaultId) return;

  await local.set({
    accounts: accounts.map((account) =>
      account.type === 'hd' && !account.vaultId ? { ...account, vaultId: firstVaultId } : account
    ),
  });
}

async function requireSecrets() {
  const secrets = await session.get('secrets');
  if (!secrets) throw Object.assign(new Error('ADRIX is locked.'), { code: 4100 });
  return secrets;
}

/** Re-encrypts after any change to key material. Password is cached for the session. */
async function reseal(secrets) {
  const password = await session.get('password');
  if (!password) throw new Error('Unlock the wallet first.');
  await local.set({ vault: await encryptVault(password, secrets) });
  await session.set({ secrets });
}

const normalisePhrase = (phrase) => String(phrase ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const normaliseKey = (key) => {
  const clean = String(key ?? '').trim();
  return clean.startsWith('0x') ? clean : `0x${clean}`;
};

// ---------------------------------------------------------------------------
// Vault creation and unlock
// ---------------------------------------------------------------------------
export async function createVault(password, importedMnemonic, pathTemplate = DEFAULT_PATH_TEMPLATE) {
  const mnemonic = importedMnemonic ? normalisePhrase(importedMnemonic) : Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(16))).phrase;
  if (!Mnemonic.isValidMnemonic(mnemonic)) throw new Error('That recovery phrase is not valid.');
  const template = validatePathTemplate(pathTemplate);

  const secrets = {
    vaults: [{ id: 'vault-1', name: 'Recovery phrase 1', mnemonic, pathTemplate: template, createdAt: Date.now() }],
    imported: [],
  };
  await session.set({ secrets, password });
  await local.set({ vault: await encryptVault(password, secrets) });

  const first = deriveHd(mnemonic, 0, template);
  const accounts = [{ address: first.address, name: 'Account 1', type: 'hd', index: 0, vaultId: 'vault-1' }];
  await local.set({
    accounts,
    selected: first.address,
    // A generated phrase has not been written down yet; an imported one has.
    backupConfirmed: Boolean(importedMnemonic),
  });

  return { mnemonic, address: first.address };
}

export async function createPrivateKeyVault(password, privateKey, name) {
  const wallet = new Wallet(normaliseKey(privateKey));

  const secrets = { vaults: [], imported: [wallet.privateKey] };
  await session.set({ secrets, password });
  await local.set({ vault: await encryptVault(password, secrets) });

  const account = { address: wallet.address, name: name?.trim() || 'Imported 1', type: 'imported' };
  await local.set({ accounts: [account], selected: account.address, backupConfirmed: true });

  return { address: wallet.address };
}

/**
 * Creates the wallet from a v3 keystore JSON file. Decryption is deliberately
 * done here rather than in the UI so the plaintext key never leaves the worker.
 */
export async function createKeystoreVault(password, keystoreJson, keystorePassword, name) {
  const wallet = await decryptKeystore(keystoreJson, keystorePassword);

  const secrets = { vaults: [], imported: [wallet.privateKey] };
  await session.set({ secrets, password });
  await local.set({ vault: await encryptVault(password, secrets) });

  const account = { address: wallet.address, name: name?.trim() || 'Imported 1', type: 'imported' };
  await local.set({ accounts: [account], selected: account.address, backupConfirmed: true });

  return { address: wallet.address };
}

async function decryptKeystore(keystoreJson, keystorePassword) {
  let parsed;
  try {
    parsed = typeof keystoreJson === 'string' ? JSON.parse(keystoreJson) : keystoreJson;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed?.crypto && !parsed?.Crypto) {
    throw new Error('That does not look like a v3 keystore file.');
  }

  try {
    return await Wallet.fromEncryptedJson(JSON.stringify(parsed), keystorePassword);
  } catch (err) {
    if (/password/i.test(err.message ?? '')) throw new Error('Wrong keystore password.');
    throw new Error('Could not decrypt that keystore file.');
  }
}

export async function unlock(password) {
  const vault = await local.get('vault');
  if (!vault) throw new Error('No wallet found.');

  const raw = await decryptVault(password, vault);
  const [secrets, changed] = migrateSecrets(raw);

  await session.set({ secrets, password });
  if (changed) {
    await local.set({ vault: await encryptVault(password, secrets) });
    await migrateAccounts(secrets);
  }
  return true;
}

export async function lock() {
  await session.clear();
}

export async function changePassword(currentPassword, nextPassword) {
  if (String(nextPassword ?? '').length < 8) throw new Error('Use a password of at least 8 characters.');
  const vault = await local.get('vault');
  const raw = await decryptVault(currentPassword, vault);
  const [secrets] = migrateSecrets(raw);
  await local.set({ vault: await encryptVault(nextPassword, secrets) });
  await session.set({ secrets, password: nextPassword });
}

// ---------------------------------------------------------------------------
// Multiple vaults
// ---------------------------------------------------------------------------
export async function listVaults() {
  const secrets = await session.get('secrets');
  const accounts = await listAccounts();
  return (secrets?.vaults ?? []).map((vault) => ({
    id: vault.id,
    name: vault.name,
    pathTemplate: vault.pathTemplate,
    createdAt: vault.createdAt ?? null,
    accountCount: accounts.filter((account) => account.vaultId === vault.id).length,
  }));
}

/** Adds a second (or third…) recovery phrase to the same install. */
export async function addVault({ mnemonic, name, pathTemplate = DEFAULT_PATH_TEMPLATE }) {
  const secrets = await requireSecrets();
  const phrase = normalisePhrase(mnemonic);
  if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('That recovery phrase is not valid.');
  if (secrets.vaults.some((vault) => vault.mnemonic === phrase)) {
    throw new Error('That recovery phrase is already in this wallet.');
  }
  const template = validatePathTemplate(pathTemplate);

  const id = `vault-${Date.now().toString(36)}`;
  const vault = {
    id,
    name: name?.trim() || `Recovery phrase ${secrets.vaults.length + 1}`,
    mnemonic: phrase,
    pathTemplate: template,
    createdAt: Date.now(),
  };
  secrets.vaults = [...secrets.vaults, vault];
  await reseal(secrets);

  // Surface the first account immediately; an empty vault is confusing.
  const wallet = deriveHd(phrase, 0, template);
  const accounts = await listAccounts();
  if (!accounts.some((account) => account.address.toLowerCase() === wallet.address.toLowerCase())) {
    const account = {
      address: wallet.address,
      name: `${vault.name} · Account 1`,
      type: 'hd',
      index: 0,
      vaultId: id,
    };
    await local.set({ accounts: [...accounts, account], selected: account.address });
  }

  return { id: vault.id, name: vault.name, pathTemplate: template };
}

export async function renameVault(id, name) {
  const secrets = await requireSecrets();
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Enter a name.');
  if (!secrets.vaults.some((vault) => vault.id === id)) throw new Error('Recovery phrase not found.');

  secrets.vaults = secrets.vaults.map((vault) => (vault.id === id ? { ...vault, name: clean } : vault));
  await reseal(secrets);
  return { id, name: clean };
}

export async function removeVault(id) {
  const secrets = await requireSecrets();
  if (secrets.vaults.length <= 1 && !secrets.imported.length) {
    throw new Error('This is the only key material in the wallet. Erase the wallet instead.');
  }
  if (!secrets.vaults.some((vault) => vault.id === id)) throw new Error('Recovery phrase not found.');

  secrets.vaults = secrets.vaults.filter((vault) => vault.id !== id);
  await reseal(secrets);

  const accounts = await listAccounts();
  const remaining = accounts.filter((account) => account.vaultId !== id);
  const visible = remaining.filter((account) => !account.hidden);
  await local.set({ accounts: remaining, selected: visible[0]?.address ?? null });
  return { ok: true };
}

export async function revealVaultMnemonic(id, password) {
  const vault = await local.get('vault');
  const [secrets] = migrateSecrets(await decryptVault(password, vault));
  const target = secrets.vaults.find((entry) => entry.id === id) ?? secrets.vaults[0];
  if (!target) throw new Error('This wallet has no recovery phrase.');
  return target.mnemonic;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
export async function listAccounts() {
  return local.get('accounts', []);
}

export async function listVisibleAccounts() {
  return (await listAccounts()).filter((account) => !account.hidden);
}

export async function listHiddenAccounts() {
  return (await listAccounts()).filter((account) => account.hidden);
}

export async function getSelected() {
  const accounts = await listVisibleAccounts();
  const selected = await local.get('selected');
  return accounts.find((a) => a.address === selected)?.address ?? accounts[0]?.address ?? null;
}

export async function selectAccount(address) {
  const checksum = getAddress(address);
  const accounts = await listVisibleAccounts();
  if (!accounts.some((account) => account.address.toLowerCase() === checksum.toLowerCase())) {
    throw new Error('That account is hidden or not in this wallet.');
  }
  await local.set({ selected: checksum });
}

export async function addAccount(name, vaultId) {
  const secrets = await requireSecrets();
  if (!secrets.vaults.length) {
    throw new Error('This wallet has no recovery phrase. Import a private key instead.');
  }

  const vault = vaultId ? secrets.vaults.find((entry) => entry.id === vaultId) : secrets.vaults[0];
  if (!vault) throw new Error('Recovery phrase not found.');

  const accounts = await listAccounts();
  const template = vault.pathTemplate ?? DEFAULT_PATH_TEMPLATE;

  // Walk forward from the highest used index until an unused address turns up,
  // so a removed-then-readded account cannot collide.
  const used = new Set(accounts.map((account) => account.address.toLowerCase()));
  let index = accounts
    .filter((account) => account.vaultId === vault.id && account.type === 'hd')
    .reduce((max, account) => Math.max(max, account.index + 1), 0);

  let wallet = deriveHd(vault.mnemonic, index, template);
  while (used.has(wallet.address.toLowerCase()) && index < 1000) {
    index += 1;
    wallet = deriveHd(vault.mnemonic, index, template);
  }

  const sameVaultCount = accounts.filter((account) => account.vaultId === vault.id).length + 1;
  const account = {
    address: wallet.address,
    name: name?.trim() || `Account ${sameVaultCount}`,
    type: 'hd',
    index,
    vaultId: vault.id,
  };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

export async function importPrivateKey(privateKey, name) {
  const secrets = await requireSecrets();
  const clean = normaliseKey(privateKey);
  const wallet = new Wallet(clean);

  const accounts = await listAccounts();
  if (accounts.some((a) => a.address.toLowerCase() === wallet.address.toLowerCase())) {
    throw new Error('That account is already in the wallet.');
  }

  secrets.imported = [...secrets.imported, wallet.privateKey];
  await reseal(secrets);

  const account = { address: wallet.address, name: name?.trim() || `Imported ${secrets.imported.length}`, type: 'imported' };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

/** Imports a v3 keystore file as an extra account in an existing wallet. */
export async function importKeystore(keystoreJson, keystorePassword, name) {
  const secrets = await requireSecrets();
  const wallet = await decryptKeystore(keystoreJson, keystorePassword);

  const accounts = await listAccounts();
  if (accounts.some((a) => a.address.toLowerCase() === wallet.address.toLowerCase())) {
    throw new Error('That account is already in the wallet.');
  }

  secrets.imported = [...secrets.imported, wallet.privateKey];
  await reseal(secrets);

  const account = { address: wallet.address, name: name?.trim() || `Imported ${secrets.imported.length}`, type: 'imported' };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

/**
 * Reads the first N addresses a phrase produces under each preset, so the user
 * can pick the path that shows the addresses they expect instead of guessing.
 */
export function previewDerivation(mnemonic, count = 3) {
  const phrase = normalisePhrase(mnemonic);
  if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('That recovery phrase is not valid.');

  return DERIVATION_PRESETS.map((preset) => ({
    ...preset,
    addresses: Array.from({ length: count }, (_, index) => deriveHd(phrase, index, preset.template).address),
  }));
}

export function previewCustomDerivation(mnemonic, template, count = 3) {
  const phrase = normalisePhrase(mnemonic);
  if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('That recovery phrase is not valid.');
  const clean = validatePathTemplate(template);
  return {
    id: 'custom',
    label: 'Custom',
    template: clean,
    addresses: Array.from({ length: count }, (_, index) => deriveHd(phrase, index, clean).address),
  };
}

async function addNonSigningAccount(address, name, type, extra = {}) {
  const checksum = getAddress(address);
  const accounts = await listAccounts();
  if (accounts.some((a) => a.address.toLowerCase() === checksum.toLowerCase())) {
    throw new Error('That account is already in the wallet.');
  }

  const count = accounts.filter((account) => account.type === type).length + 1;
  const defaults = { watch: 'Watch', hardware: 'Hardware', smart: 'Smart Account', multisig: 'Multisig' };
  const account = { address: checksum, name: name?.trim() || `${defaults[type]} ${count}`, type, ...extra };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

export const addWatchAccount = (address, name) => addNonSigningAccount(address, name, 'watch');
export const addHardwareAccount = (address, name, vendor) =>
  addNonSigningAccount(address, name || (vendor === 'ledger' ? 'Ledger' : 'Trezor'), 'hardware', { vendor });
export const addSmartAccount = (address, name) => addNonSigningAccount(address, name, 'smart');
export const addMultisigAccount = (address, name) => addNonSigningAccount(address, name, 'multisig');

/**
 * Turns a watch-only entry into a signing account by supplying its key. The
 * derived address must match what is being watched — otherwise this would
 * silently replace one account with a different one.
 */
export async function upgradeWatchAccount(address, privateKey) {
  const secrets = await requireSecrets();
  const checksum = getAddress(address);
  const accounts = await listAccounts();

  const target = accounts.find((account) => account.address.toLowerCase() === checksum.toLowerCase());
  if (!target) throw new Error('Account not found.');
  if (target.type !== 'watch') throw new Error('That account is not watch-only.');

  const wallet = new Wallet(normaliseKey(privateKey));
  if (wallet.address.toLowerCase() !== checksum.toLowerCase()) {
    throw new Error(
      `That key belongs to ${wallet.address.slice(0, 10)}…, not the address being watched. Nothing was changed.`
    );
  }

  secrets.imported = [...secrets.imported, wallet.privateKey];
  await reseal(secrets);

  await local.set({
    accounts: accounts.map((account) =>
      account.address.toLowerCase() === checksum.toLowerCase()
        ? { ...account, type: 'imported', watchedSince: account.watchedSince ?? null }
        : account
    ),
  });
  return { address: checksum, type: 'imported' };
}

export async function renameAccount(address, name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Enter an account name.');
  if (clean.length > 40) throw new Error('Account names are limited to 40 characters.');

  const accounts = await listAccounts();
  if (!accounts.some((a) => a.address === address)) throw new Error('Account not found.');

  await local.set({
    accounts: accounts.map((a) => (a.address === address ? { ...a, name: clean } : a)),
  });
  return { address, name: clean };
}

export async function removeAccount(address) {
  const accounts = await listAccounts();
  const target = accounts.find((a) => a.address === address);
  if (!target) throw new Error('Account not found.');
  if (target.type === 'hd') throw new Error('Accounts from a recovery phrase cannot be removed, only hidden.');

  if (target.type === 'imported') {
    const secrets = await requireSecrets();
    secrets.imported = secrets.imported.filter((key) => new Wallet(key).address !== address);
    await reseal(secrets);
  }

  const remaining = accounts.filter((a) => a.address !== address);
  const visible = remaining.filter((account) => !account.hidden);
  await local.set({ accounts: remaining, selected: visible[0]?.address ?? null });
}

export async function hideAccount(address) {
  const checksum = getAddress(address);
  const accounts = await listAccounts();
  const target = accounts.find((account) => account.address.toLowerCase() === checksum.toLowerCase());
  if (!target) throw new Error('Account not found.');
  if (target.type !== 'hd') throw new Error('Only recovery phrase accounts can be hidden.');
  if (target.hidden) return target;

  if (accounts.filter((account) => !account.hidden).length <= 1) {
    throw new Error('At least one account must stay visible.');
  }

  const nextAccounts = accounts.map((account) =>
    account.address.toLowerCase() === checksum.toLowerCase() ? { ...account, hidden: true } : account
  );
  const selected = await getSelected();
  const nextSelected =
    selected?.toLowerCase() === checksum.toLowerCase()
      ? nextAccounts.find((account) => !account.hidden)?.address ?? null
      : selected;
  await local.set({ accounts: nextAccounts, selected: nextSelected });
  return { ...target, hidden: true };
}

export async function unhideAccount(address) {
  const checksum = getAddress(address);
  const accounts = await listAccounts();
  const target = accounts.find((account) => account.address.toLowerCase() === checksum.toLowerCase());
  if (!target) throw new Error('Account not found.');
  if (target.type !== 'hd') throw new Error('Only recovery phrase accounts can be unhidden.');

  await local.set({
    accounts: accounts.map((account) =>
      account.address.toLowerCase() === checksum.toLowerCase() ? { ...account, hidden: false } : account
    ),
  });
  return { ...target, hidden: false };
}

// ---------------------------------------------------------------------------
// Signing material
// ---------------------------------------------------------------------------
export async function getWallet(address) {
  const secrets = await requireSecrets();
  const accounts = await listAccounts();
  const account = accounts.find((a) => a.address.toLowerCase() === address?.toLowerCase());
  if (!account) throw Object.assign(new Error('Unknown account.'), { code: 4100 });

  if (account.type === 'hd') {
    const vault =
      secrets.vaults.find((entry) => entry.id === account.vaultId) ?? (account.vaultId ? null : secrets.vaults[0]);
    if (!vault) throw new Error('Recovery phrase key material is missing for that account.');
    const hd = deriveHd(vault.mnemonic, account.index, vault.pathTemplate ?? DEFAULT_PATH_TEMPLATE);
    return new Wallet(hd.privateKey);
  }
  if (account.type === 'watch') throw new Error('Watch-only accounts cannot sign transactions.');
  if (account.type === 'hardware') {
    throw new Error(`Hardware wallet signing is not yet implemented for ${account.vendor || 'this device'}.`);
  }
  if (account.type === 'smart') {
    throw new Error('Smart accounts require an ERC-4337 bundler to sign and dispatch user operations.');
  }
  if (account.type === 'multisig') {
    throw new Error('Multisig accounts require signatures from co-owners before dispatching.');
  }

  const key = secrets.imported.find((k) => new Wallet(k).address === account.address);
  if (!key) throw new Error('Key material for that account is missing.');
  return new Wallet(key);
}

export async function exportPrivateKey(address, password) {
  const vault = await local.get('vault');
  await decryptVault(password, vault); // password check
  const wallet = await getWallet(address);
  return wallet.privateKey;
}

export async function revealMnemonic(password) {
  return revealVaultMnemonic(null, password);
}

// ---------------------------------------------------------------------------
// Backup state — drives the reminder banner
// ---------------------------------------------------------------------------
export async function getBackupState() {
  const [confirmed, hasPhrase] = await Promise.all([
    local.get('backupConfirmed', false),
    session.get('secrets').then((secrets) => Boolean(secrets?.vaults?.length)),
  ]);
  return { confirmed: Boolean(confirmed), needed: hasPhrase && !confirmed };
}

export async function confirmBackup() {
  await local.set({ backupConfirmed: true });
  return { ok: true };
}

/**
 * Verifies the user can actually reproduce the phrase before marking it backed
 * up. Checking the words rather than trusting a checkbox is the whole point.
 */
export async function verifyBackup(words) {
  const secrets = await requireSecrets();
  const vault = secrets.vaults[0];
  if (!vault) throw new Error('This wallet has no recovery phrase.');

  const expected = vault.mnemonic.split(' ');
  for (const [index, word] of Object.entries(words ?? {})) {
    if (expected[Number(index)] !== String(word).trim().toLowerCase()) {
      throw new Error('Those words do not match the recovery phrase.');
    }
  }
  await local.set({ backupConfirmed: true });
  return { ok: true };
}

export async function wipe() {
  await session.clear();
  await local.clear();
}

export { isAddress };
