import { HDNodeWallet, Mnemonic, Wallet, getAddress } from 'ethers';
import { local, session } from './storage.js';
import { encryptVault, decryptVault } from './vault.js';

const BASE_PATH = "m/44'/60'/0'/0";

// ---------------------------------------------------------------------------
// Shape of things
//
//   local.vault        encrypted { mnemonic, imported: [privateKey] }
//   local.accounts     [{ address, name, type: 'hd' | 'imported' | 'watch', index }]
//   local.selected     address currently in focus
//   session.secrets    decrypted { mnemonic, imported } - only while unlocked
// ---------------------------------------------------------------------------

export const hasVault = () => local.get('vault').then(Boolean);
export const isUnlocked = () => session.get('secrets').then(Boolean);
export const hasRecoveryPhrase = () => session.get('secrets').then((secrets) => Boolean(secrets?.mnemonic));

async function requireSecrets() {
  const secrets = await session.get('secrets');
  if (!secrets) throw Object.assign(new Error('MiniWallet is locked.'), { code: 4100 });
  return secrets;
}

async function saveSecrets(secrets, password) {
  await session.set({ secrets });
  if (password) await local.set({ vault: await encryptVault(password, secrets) });
}

// Re-encrypting requires the password, so it is passed through on every write
// that changes the secret material. Cached for the session so the user is not
// prompted every time they add an account.
async function reseal(secrets) {
  const password = await session.get('password');
  if (!password) throw new Error('Unlock the wallet first.');
  await local.set({ vault: await encryptVault(password, secrets) });
  await session.set({ secrets });
}

function deriveHd(mnemonic, index) {
  return HDNodeWallet.fromPhrase(mnemonic, undefined, `${BASE_PATH}/${index}`);
}

// ---------------------------------------------------------------------------
export async function createVault(password, importedMnemonic) {
  const mnemonic = importedMnemonic ?? Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(16))).phrase;
  if (!Mnemonic.isValidMnemonic(mnemonic)) throw new Error('That recovery phrase is not valid.');

  const secrets = { mnemonic, imported: [] };
  await saveSecrets(secrets, password);
  await session.set({ password });

  const first = deriveHd(mnemonic, 0);
  const accounts = [{ address: first.address, name: 'Account 1', type: 'hd', index: 0 }];
  await local.set({ accounts, selected: first.address });

  return { mnemonic, address: first.address };
}

export async function createPrivateKeyVault(password, privateKey, name) {
  const clean = privateKey.trim().startsWith('0x') ? privateKey.trim() : `0x${privateKey.trim()}`;
  const wallet = new Wallet(clean);

  const secrets = { mnemonic: null, imported: [wallet.privateKey] };
  await saveSecrets(secrets, password);
  await session.set({ password });

  const account = { address: wallet.address, name: name?.trim() || 'Imported 1', type: 'imported' };
  await local.set({ accounts: [account], selected: account.address });

  return { address: wallet.address };
}

export async function unlock(password) {
  const vault = await local.get('vault');
  if (!vault) throw new Error('No wallet found.');
  const secrets = await decryptVault(password, vault);
  await session.set({ secrets, password });
  return true;
}

export async function lock() {
  await session.clear();
}

export async function changePassword(currentPassword, nextPassword) {
  const vault = await local.get('vault');
  const secrets = await decryptVault(currentPassword, vault);
  await local.set({ vault: await encryptVault(nextPassword, secrets) });
  await session.set({ password: nextPassword });
}

// ---------------------------------------------------------------------------
export async function listAccounts() {
  return local.get('accounts', []);
}

export async function listVisibleAccounts() {
  const accounts = await listAccounts();
  return accounts.filter((account) => !account.hidden);
}

export async function listHiddenAccounts() {
  const accounts = await listAccounts();
  return accounts.filter((account) => account.hidden);
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

export async function addAccount(name) {
  const secrets = await requireSecrets();
  if (!secrets.mnemonic) {
    throw new Error('This wallet was imported from a private key. Import another key instead of adding an HD account.');
  }
  const accounts = await listAccounts();
  const nextIndex = accounts.filter((a) => a.type === 'hd').reduce((max, a) => Math.max(max, a.index + 1), 0);

  const wallet = deriveHd(secrets.mnemonic, nextIndex);
  const account = {
    address: wallet.address,
    name: name || `Account ${accounts.length + 1}`,
    type: 'hd',
    index: nextIndex,
  };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

export async function importPrivateKey(privateKey, name) {
  const secrets = await requireSecrets();
  const clean = privateKey.trim().startsWith('0x') ? privateKey.trim() : `0x${privateKey.trim()}`;
  const wallet = new Wallet(clean);

  const accounts = await listAccounts();
  if (accounts.some((a) => a.address.toLowerCase() === wallet.address.toLowerCase())) {
    throw new Error('That account is already in the wallet.');
  }

  secrets.imported = [...secrets.imported, clean];
  await reseal(secrets);

  const account = { address: wallet.address, name: name || `Imported ${secrets.imported.length}`, type: 'imported' };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

export async function addWatchAccount(address, name) {
  const checksum = getAddress(address);
  const accounts = await listAccounts();
  if (accounts.some((a) => a.address.toLowerCase() === checksum.toLowerCase())) {
    throw new Error('That account is already in the wallet.');
  }

  const watchCount = accounts.filter((account) => account.type === 'watch').length + 1;
  const account = {
    address: checksum,
    name: name?.trim() || `Watch ${watchCount}`,
    type: 'watch',
  };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

export async function addHardwareAccount(address, name, vendor) {
  const checksum = getAddress(address);
  const accounts = await listAccounts();
  if (accounts.some((a) => a.address.toLowerCase() === checksum.toLowerCase())) {
    throw new Error('That account is already in the wallet.');
  }

  const hwCount = accounts.filter((account) => account.type === 'hardware').length + 1;
  const account = {
    address: checksum,
    name: name?.trim() || `${vendor === 'ledger' ? 'Ledger' : 'Trezor'} ${hwCount}`,
    type: 'hardware',
    vendor,
  };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

export async function addSmartAccount(address, name) {
  const checksum = getAddress(address);
  const accounts = await listAccounts();
  if (accounts.some((a) => a.address.toLowerCase() === checksum.toLowerCase())) {
    throw new Error('That account is already in the wallet.');
  }

  const scCount = accounts.filter((account) => account.type === 'smart').length + 1;
  const account = {
    address: checksum,
    name: name?.trim() || `Smart Account ${scCount}`,
    type: 'smart',
  };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

export async function addMultisigAccount(address, name) {
  const checksum = getAddress(address);
  const accounts = await listAccounts();
  if (accounts.some((a) => a.address.toLowerCase() === checksum.toLowerCase())) {
    throw new Error('That account is already in the wallet.');
  }

  const msCount = accounts.filter((account) => account.type === 'multisig').length + 1;
  const account = {
    address: checksum,
    name: name?.trim() || `Multisig ${msCount}`,
    type: 'multisig',
  };
  await local.set({ accounts: [...accounts, account], selected: account.address });
  return account;
}

export async function renameAccount(address, name) {
  const accounts = await listAccounts();
  await local.set({
    accounts: accounts.map((a) => (a.address === address ? { ...a, name } : a)),
  });
}

export async function removeAccount(address) {
  const accounts = await listAccounts();
  const target = accounts.find((a) => a.address === address);
  if (!target) throw new Error('Account not found.');
  if (target.type === 'hd') throw new Error('Accounts from the recovery phrase cannot be removed, only hidden.');

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

  const visible = accounts.filter((account) => !account.hidden);
  if (visible.length <= 1) throw new Error('At least one account must stay visible.');

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

  const nextAccounts = accounts.map((account) =>
    account.address.toLowerCase() === checksum.toLowerCase() ? { ...account, hidden: false } : account
  );
  await local.set({ accounts: nextAccounts });
  return { ...target, hidden: false };
}

// ---------------------------------------------------------------------------
export async function getWallet(address) {
  const secrets = await requireSecrets();
  const accounts = await listAccounts();
  const account = accounts.find((a) => a.address.toLowerCase() === address?.toLowerCase());
  if (!account) throw Object.assign(new Error('Unknown account.'), { code: 4100 });

  if (account.type === 'hd') {
    if (!secrets.mnemonic) throw new Error('Recovery phrase key material is missing.');
    const hd = deriveHd(secrets.mnemonic, account.index);
    return new Wallet(hd.privateKey);
  }
  if (account.type === 'watch') {
    throw new Error('Watch-only accounts cannot sign transactions.');
  }
  if (account.type === 'hardware') {
    throw new Error(`Hardware wallet signing is not yet fully implemented for ${account.vendor || 'this device'}.`);
  }
  if (account.type === 'smart') {
    throw new Error('Smart accounts require account abstraction bundlers to sign and dispatch user operations.');
  }
  if (account.type === 'multisig') {
    throw new Error('Multisig accounts require gathering signatures from co-owners before dispatching.');
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
  const vault = await local.get('vault');
  const secrets = await decryptVault(password, vault);
  if (!secrets.mnemonic) throw new Error('This wallet was imported from a private key and has no recovery phrase.');
  return secrets.mnemonic;
}

export async function wipe() {
  await session.clear();
  await local.clear();
}
