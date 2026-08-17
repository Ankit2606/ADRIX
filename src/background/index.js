import { formatEther } from 'ethers';
import { local } from './storage.js';
import * as keyring from './keyring.js';
import * as permissions from './permissions.js';
import * as networks from './networks.js';
import * as tokens from './tokens.js';
import * as txs from './transactions.js';
import * as contacts from './contacts.js';
import * as approvals from './approvals.js';
import * as ens from './ens.js';
import { handleRpc } from './rpc.js';
import { broadcastEvent, notifyUi } from './events.js';

const DEFAULT_AUTOLOCK_MINUTES = 15;

// ---------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------
async function resetAutoLock() {
  if (!(await keyring.isUnlocked())) return;
  const minutes = await local.get('autoLockMinutes', DEFAULT_AUTOLOCK_MINUTES);
  if (minutes <= 0) {
    chrome.alarms.clear('auto-lock');
    return;
  }
  chrome.alarms.create('auto-lock', { delayInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-lock') {
    await keyring.lock();
    notifyUi();
  }
  if (alarm.name === 'poll-receipts') {
    await txs.pollReceipts();
  }
});

chrome.runtime.onStartup.addListener(() => keyring.lock());
chrome.runtime.onInstalled.addListener(() => {
  try {
    // Keeps session storage readable only by the worker and extension pages.
    // This is already the default; setting it explicitly guards against a
    // future default change.
    chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    /* older Chrome without the API */
  }
});

// ---------------------------------------------------------------------------
// State snapshot for the UI
// ---------------------------------------------------------------------------
async function getState() {
  const [
    hasVault,
    unlocked,
    hasRecoveryPhrase,
    accounts,
    hiddenAccounts,
    selected,
    chainId,
    allNetworks,
    networkHealth,
    sites,
    connectionHistory,
    contactList,
    theme,
    autoLockMinutes,
  ] = await Promise.all([
    keyring.hasVault(),
    keyring.isUnlocked(),
    keyring.hasRecoveryPhrase(),
    keyring.listVisibleAccounts(),
    keyring.listHiddenAccounts(),
    keyring.getSelected(),
    networks.getChainId(),
    networks.allNetworks(),
    networks.getNetworkHealth(),
    permissions.listSites(),
    permissions.listHistory(),
    contacts.listContacts(),
    local.get('theme', 'dark'),
    local.get('autoLockMinutes', DEFAULT_AUTOLOCK_MINUTES),
  ]);

  const [profiledAccounts, profiledHiddenAccounts] = await Promise.all([
    ens.enrichAccounts(accounts),
    ens.enrichAccounts(hiddenAccounts),
  ]);

  return {
    hasVault,
    unlocked,
    hasRecoveryPhrase,
    accounts: profiledAccounts,
    hiddenAccounts: profiledHiddenAccounts,
    selected,
    chainId,
    network: allNetworks[chainId] ?? null,
    networkHealth,
    networks: allNetworks,
    sites,
    connectionHistory,
    contacts: contactList,
    theme,
    autoLockMinutes,
    pendingApprovals: approvals.pendingCount(),
  };
}

async function getPortfolio() {
  const address = await keyring.getSelected();
  const chainId = await networks.getChainId();
  const network = await networks.getNetwork(chainId);
  if (!address) return { address: null };

  const provider = await networks.getProvider(chainId);
  const accounts = await keyring.listVisibleAccounts();
  const selectedAccount = accounts.find((account) => account.address.toLowerCase() === address.toLowerCase()) ?? null;
  const { fetchPrices, calculateFiatValue } = await import('./prices.js');
  const prices = await fetchPrices();

  const [balance, tokenList, activity, profile] = await Promise.all([
    provider.getBalance(address).catch(() => 0n),
    tokens.tokenBalances(address, chainId).catch(() => []),
    txs.listActivity(address, chainId),
    ens.profileAddress(address).catch(() => null),
  ]);
  const [nftList, approvals, hiddenTokens, hiddenNfts] = await Promise.all([
    tokens.nftBalances(address, chainId).catch(() => []),
    tokens.listApprovals(address, chainId).catch(() => []),
    tokens.listHiddenTokens(chainId).catch(() => []),
    tokens.listHiddenNfts(chainId).catch(() => []),
  ]);

  const nativeBalanceStr = formatEther(balance);
  const nativeFiat = await calculateFiatValue(network.symbol, nativeBalanceStr);

  const tokensWithFiat = await Promise.all(tokenList.map(async (t) => {
    const fiat = await calculateFiatValue(t.symbol, t.balance);
    return { ...t, fiat };
  }));

  return {
    address,
    account: selectedAccount ? { ...selectedAccount, ens: profile } : null,
    chainId,
    network,
    native: { symbol: network.symbol, balance: nativeBalanceStr, raw: balance.toString(), fiat: nativeFiat },
    tokens: tokensWithFiat,
    nfts: nftList,
    hiddenTokens,
    hiddenNfts,
    approvals,
    activity,
  };
}

async function getPortfolios() {
  const currentChainId = await networks.getChainId();
  const allNets = await networks.allNetworks();
  const accounts = await ens.enrichAccounts(await keyring.listVisibleAccounts());
  const { fetchPrices, calculateFiatValue } = await import('./prices.js');
  
  let totalNativeRaw = 0n;
  let totalFiat = 0;

  const rows = await Promise.all(
    accounts.map(async (account) => {
      let accTotalFiat = 0;
      
      const chainBalances = await Promise.all(
        Object.values(allNets).map(async (net) => {
          try {
            const provider = await networks.getProvider(net.chainId);
            const balance = await provider.getBalance(account.address).catch(() => 0n);
            const tokenList = await tokens.tokenBalances(account.address, net.chainId).catch(() => []);
            const nftList = await tokens.nftBalances(account.address, net.chainId).catch(() => []);
            
            const balStr = formatEther(balance);
            const fiat = await calculateFiatValue(net.symbol, balStr);
            accTotalFiat += fiat;
            
            const tokensWithFiat = await Promise.all(tokenList.map(async (t) => {
              const tFiat = await calculateFiatValue(t.symbol, t.balance);
              accTotalFiat += tFiat;
              return { ...t, fiat: tFiat };
            }));

            if (net.chainId === currentChainId) {
              totalNativeRaw += balance;
            }

            return {
              chainId: net.chainId,
              network: net,
              native: { symbol: net.symbol, balance: balStr, raw: balance.toString(), fiat },
              tokens: tokensWithFiat.filter((token) => token.raw && BigInt(token.raw) > 0n),
              nfts: nftList.filter((nft) => nft.balance != null && BigInt(nft.balance) > 0n),
            };
          } catch (e) {
            return null;
          }
        })
      );
      
      const validChainBalances = chainBalances.filter(Boolean);
      totalFiat += accTotalFiat;

      return {
        ...account,
        chainBalances: validChainBalances,
        totalFiat,
        native: validChainBalances.find(c => c.chainId === currentChainId)?.native || { symbol: 'ETH', balance: '0', raw: '0', fiat: 0 },
        tokens: validChainBalances.flatMap(c => c.tokens),
        nfts: validChainBalances.flatMap(c => c.nfts),
      };
    })
  );

  const currentNetwork = await networks.getNetwork(currentChainId);
  return {
    chainId: currentChainId,
    network: currentNetwork,
    native: { symbol: currentNetwork.symbol, balance: formatEther(totalNativeRaw), raw: totalNativeRaw.toString() },
    totalFiat,
    accounts: rows,
  };
}

// ---------------------------------------------------------------------------
// UI message handlers
// ---------------------------------------------------------------------------
const handlers = {
  GET_STATE: () => getState(),
  GET_PORTFOLIO: () => getPortfolio(),
  GET_PORTFOLIOS: () => getPortfolios(),

  // --- vault ---------------------------------------------------------------
  CREATE_WALLET: ({ password }) => keyring.createVault(password),
  IMPORT_MNEMONIC: ({ password, mnemonic }) => keyring.createVault(password, mnemonic.trim().replace(/\s+/g, ' ')),
  IMPORT_PRIVATE_KEY_WALLET: ({ password, privateKey, name }) =>
    keyring.createPrivateKeyVault(password, privateKey, name),
  UNLOCK: async ({ password }) => {
    await keyring.unlock(password);
    await resetAutoLock();
    return { ok: true };
  },
  LOCK: async () => {
    await keyring.lock();
    return { ok: true };
  },
  CHANGE_PASSWORD: ({ current, next }) => keyring.changePassword(current, next),
  WIPE: () => keyring.wipe(),

  // --- accounts ------------------------------------------------------------
  ADD_ACCOUNT: async ({ name }) => {
    const account = await keyring.addAccount(name);
    broadcastEvent('accountsChanged');
    return account;
  },
  IMPORT_PRIVATE_KEY: async ({ privateKey, name }) => {
    const account = await keyring.importPrivateKey(privateKey, name);
    broadcastEvent('accountsChanged');
    return account;
  },
  ADD_WATCH_ACCOUNT: async ({ address, name }) => {
    const account = await keyring.addWatchAccount(address, name);
    broadcastEvent('accountsChanged');
    return account;
  },
  ADD_HARDWARE_ACCOUNT: async ({ address, name, vendor }) => {
    const account = await keyring.addHardwareAccount(address, name, vendor);
    broadcastEvent('accountsChanged');
    return account;
  },
  ADD_SMART_ACCOUNT: async ({ address, name }) => {
    const account = await keyring.addSmartAccount(address, name);
    broadcastEvent('accountsChanged');
    return account;
  },
  ADD_MULTISIG_ACCOUNT: async ({ address, name }) => {
    const account = await keyring.addMultisigAccount(address, name);
    broadcastEvent('accountsChanged');
    return account;
  },
  SELECT_ACCOUNT: async ({ address }) => {
    await keyring.selectAccount(address);
    broadcastEvent('accountsChanged');
    return { ok: true };
  },
  RENAME_ACCOUNT: ({ address, name }) => keyring.renameAccount(address, name),
  REMOVE_ACCOUNT: async ({ address }) => {
    await keyring.removeAccount(address);
    await permissions.purgeAccount(address);
    broadcastEvent('accountsChanged');
    return { ok: true };
  },
  HIDE_ACCOUNT: async ({ address }) => {
    await keyring.hideAccount(address);
    broadcastEvent('accountsChanged');
    return { ok: true };
  },
  UNHIDE_ACCOUNT: async ({ address }) => {
    await keyring.unhideAccount(address);
    return { ok: true };
  },
  EXPORT_PRIVATE_KEY: ({ address, password }) =>
    keyring.exportPrivateKey(address, password).then((privateKey) => ({ privateKey })),
  REVEAL_MNEMONIC: ({ password }) => keyring.revealMnemonic(password).then((mnemonic) => ({ mnemonic })),

  // --- networks ------------------------------------------------------------
  SET_CHAIN: async ({ chainId }) => {
    const network = await networks.setChain(chainId);
    broadcastEvent('chainChanged', chainId);
    return network;
  },
  ADD_NETWORK: ({ network }) => networks.addNetwork(network),
  TEST_RPC: ({ network }) => networks.testRpc(network),
  REMOVE_NETWORK: async ({ chainId }) => {
    await networks.removeNetwork(chainId);
    await permissions.purgeNetwork(chainId);
    broadcastEvent('chainChanged', await networks.getChainId());
    return { ok: true };
  },

  // --- tokens --------------------------------------------------------------
  LOOKUP_TOKEN: ({ address }) => tokens.readTokenMetadata(address),
  SEARCH_TOKENS: ({ query }) => tokens.searchTokenRegistry(query),
  DETECT_TOKENS: async () => tokens.detectTokens(await keyring.getSelected()),
  ADD_TOKEN: ({ token }) => tokens.addToken(token),
  REMOVE_TOKEN: ({ address }) => tokens.removeToken(address),
  HIDE_TOKEN: ({ address }) => tokens.hideToken(address),
  UNHIDE_TOKEN: ({ address }) => tokens.unhideToken(address),
  LOOKUP_NFT: async ({ nft }) => tokens.lookupNft(nft, await keyring.getSelected()),
  ADD_NFT: ({ nft }) => tokens.addNft(nft),
  REMOVE_NFT: ({ nft }) => tokens.removeNft(nft),
  HIDE_NFT: ({ nft }) => tokens.hideNft(nft),
  UNHIDE_NFT: ({ nft }) => tokens.unhideNft(nft),
  LOOKUP_ENS_PROFILE: ({ address }) => ens.profileAddress(address),
  // The Send screen needs calldata before it can estimate gas. It asks here
  // rather than re-implementing the encoding, so the estimate and the real
  // transaction can never drift apart.
  ENCODE_TRANSFER: ({ to, amount, decimals }) => ({ data: tokens.encodeTransfer(to, amount, decimals) }),

  // --- sending -------------------------------------------------------------
  RESOLVE_RECIPIENT: ({ input }) => txs.resolveRecipient(input).then((address) => ({ address })),
  ESTIMATE_GAS: ({ request }) => txs.estimateGas(request),
  SEND_TRANSACTION: async ({ request }) => {
    const hash = await txs.sendTransaction(request);
    return { hash };
  },
  SEND_TOKEN: async ({ from, token, to, amount, fees, gas, nonce }) => {
    const hash = await txs.sendTransaction({
      from,
      to: token.address,
      value: '0x0',
      data: tokens.encodeTransfer(to, amount, token.decimals),
      fees,
      gas,
      nonce,
      meta: { tokenSymbol: token.symbol, tokenAmount: String(amount), tokenTo: to },
    });
    return { hash };
  },
  SPEED_UP: ({ hash }) => txs.speedUp(hash).then((newHash) => ({ hash: newHash })),
  CANCEL_TX: ({ hash }) => txs.cancelTransaction(hash).then((newHash) => ({ hash: newHash })),
  UPDATE_TX_META: ({ hash, note, tags }) => txs.updateActivityMeta({ hash, note, tags }),
  REVOKE_APPROVAL: async ({ id }) => {
    const hash = await txs.revokeApproval({ id, from: await keyring.getSelected() });
    return { hash };
  },

  // --- sites ---------------------------------------------------------------
  DISCONNECT_SITE: async ({ origin }) => {
    await permissions.revoke(origin);
    broadcastEvent('accountsChanged', [], origin);
    return { ok: true };
  },
  UPDATE_SITE_ACCOUNTS: async ({ origin, accounts }) => {
    await permissions.updateAccounts(origin, accounts);
    broadcastEvent('accountsChanged', await permissions.accountsFor(origin, { requireNetwork: true }), origin);
    return { ok: true };
  },
  UPDATE_SITE_NETWORKS: async ({ origin, networks: allowedNetworks }) => {
    await permissions.updateNetworks(origin, allowedNetworks);
    if (await permissions.isNetworkPermitted(origin)) {
      broadcastEvent('chainChanged', await networks.getChainId(), origin);
      broadcastEvent('accountsChanged', await permissions.accountsFor(origin, { requireNetwork: true }), origin);
    } else {
      broadcastEvent('accountsChanged', [], origin);
    }
    return { ok: true };
  },

  // --- contacts ------------------------------------------------------------
  LIST_CONTACTS: () => contacts.listContacts(),
  ADD_CONTACT: ({ contact }) => contacts.addContact(contact),
  UPDATE_CONTACT: ({ contact }) => contacts.updateContact(contact),
  TOGGLE_CONTACT_FAVORITE: ({ id }) => contacts.toggleFavorite({ id }),
  REMOVE_CONTACT: ({ id }) => contacts.removeContact({ id }),

  // --- settings ------------------------------------------------------------
  SET_AUTOLOCK: async ({ minutes }) => {
    await local.set({ autoLockMinutes: minutes });
    await resetAutoLock();
    return { ok: true };
  },
  SET_THEME: async ({ theme }) => {
    if (!['dark', 'light'].includes(theme)) throw new Error('Unknown theme.');
    await local.set({ theme });
    notifyUi();
    return { ok: true };
  },

  // --- approvals -----------------------------------------------------------
  GET_APPROVAL: async ({ id }) => {
    const request = approvals.getRequest(id);
    if (!request) throw new Error('That request already expired. Trigger it again from the site.');
    const accounts = await keyring.listVisibleAccounts();
    return { ...request, unlocked: await keyring.isUnlocked(), accounts, queued: approvals.listRequests() };
  },
  // Both return the next queued request, so a window showing several stacked
  // prompts advances to the next one instead of closing on the first answer.
  APPROVE: ({ id, value }) => {
    approvals.resolveRequest(id, value);
    notifyUi();
    return { next: approvals.listRequests()[0]?.id ?? null };
  },
  REJECT: ({ id }) => {
    approvals.rejectRequest(id);
    notifyUi();
    return { next: approvals.listRequests()[0]?.id ?? null };
  },
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'RPC_REQUEST') {
        let origin;
        try {
          origin = sender.origin ?? new URL(sender.url).origin;
        } catch {
          throw Object.assign(new Error('Unrecognised caller.'), { code: 4100 });
        }
        sendResponse({ result: await handleRpc(message.method, message.params, origin) });
        return;
      }

      const handler = handlers[message?.type];
      if (!handler) throw new Error(`Unknown message: ${message?.type}`);

      // Any UI activity counts as activity for the auto-lock timer.
      resetAutoLock();

      const result = await handler(message);
      sendResponse({ result: result ?? { ok: true } });
    } catch (err) {
      sendResponse({ error: { code: err.code ?? -32603, message: err.message } });
    }
  })();
  return true; // keeps the channel open for the async work above
});

// Restart receipt polling if the worker was torn down with pending txs.
txs.scheduleReceiptPolling();
