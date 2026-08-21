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
import * as prices from './prices.js';
import * as i18n from './i18n.js';
import * as spam from './spam.js';
import * as tokenLists from './tokenLists.js';
import * as signatures from './signatures.js';
import * as backup from './backup.js';
import * as poisoning from './poisoning.js';
import * as security from './security.js';
import * as simulation from './simulation.js';
import * as swap from './swap.js';
import * as onramp from './onramp.js';
import * as defi from './defi.js';
import * as ledger from './ledger.js';
import * as batch from './batch.js';
import * as safe from './safe.js';
import * as aa from './erc4337.js';
import * as watcher from './watcher.js';
import * as delegation from './delegation.js';
import * as ur from './ur.js';
import * as sharding from './sharding.js';
// Only the storage- and chain-backed half is used here. Enrolment and signing
// need navigator.credentials, which a service worker does not have, so the UI
// calls those directly.
import * as webauthn from './webauthn.js';
import { globalSearch } from './search.js';
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
  if (alarm.name === 'watch-incoming') {
    // Incoming detection runs whether or not the wallet is unlocked: arriving
    // funds are public information and the watcher touches no key material.
    await watcher.pollIncoming().catch(() => {});
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
    currency,
    locale,
    showTestnets,
    visibleNets,
    backup,
    vaults,
    ensAvatars,
  ] = await Promise.all([
    keyring.hasVault(),
    keyring.isUnlocked(),
    keyring.hasRecoveryPhrase(),
    keyring.listVisibleAccounts(),
    keyring.listHiddenAccounts(),
    keyring.getSelected(),
    networks.getChainId(),
    networks.allNetworks(),
    networks.peekNetworkHealth(),
    permissions.listSites(),
    permissions.listHistory(),
    contacts.listContacts(),
    local.get('theme', 'dark'),
    local.get('autoLockMinutes', DEFAULT_AUTOLOCK_MINUTES),
    prices.getCurrency(),
    i18n.getLocale(),
    networks.getShowTestnets(),
    networks.visibleNetworks(),
    keyring.getBackupState(),
    keyring.listVaults(),
    ens.getAvatarsEnabled(),
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
    networks: visibleNets,
    allNetworks,
    showTestnets,
    sites,
    connectionHistory,
    contacts: contactList,
    theme,
    autoLockMinutes,
    currency,
    locale,
    backup,
    vaults,
    ensAvatars,
    derivationPresets: keyring.DERIVATION_PRESETS,
    pendingApprovals: approvals.pendingCount(),
  };
}

/**
 * The fiat price of one unit, right now, for the cost-basis ledger.
 *
 * Best-effort: a missing price is recorded as unknown rather than guessed,
 * because an invented acquisition price silently becomes reported profit.
 */
async function currentPrice({ native = false, address = null, chainId = null } = {}) {
  const chain = chainId ?? (await networks.getChainId());
  const currency = await prices.getCurrency();
  if (native) return (await prices.nativeQuote(chain, currency))?.price ?? null;
  if (!address) return null;
  const map = await prices.tokenPrices(chain, [address], currency);
  return map[address.toLowerCase()] ?? null;
}

/** Attaches live fiat values to one chain's native balance and token list. */
async function priceChain(chainId, nativeBalanceStr, tokenList, currency) {
  const [nativeInfo, tokenMap] = await Promise.all([
    prices.nativeQuote(chainId, currency),
    prices.tokenPrices(
      chainId,
      tokenList.map((token) => token.address),
      currency
    ),
  ]);

  const native = nativeInfo?.price ?? null;
  const changes = prices.tokenChanges(chainId, currency);

  const pricedTokens = tokenList.map((token) => {
    const price = tokenMap[token.address.toLowerCase()] ?? null;
    return {
      ...token,
      price,
      change24h: changes[token.address.toLowerCase()] ?? null,
      fiat: prices.fiatValue(token.balance, price),
    };
  });

  return {
    nativePrice: native,
    nativeChange24h: nativeInfo?.change24h ?? null,
    nativeFiat: prices.fiatValue(nativeBalanceStr, native),
    tokens: pricedTokens,
    // Only chains with real price data contribute to a total. A missing price
    // is not zero, so it must not be summed as though it were.
    total: [prices.fiatValue(nativeBalanceStr, native), ...pricedTokens.map((t) => t.fiat)]
      .filter((value) => value != null)
      .reduce((sum, value) => sum + value, 0),
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
  const currency = await prices.getCurrency();

  const [balance, tokenList, activity, profile] = await Promise.all([
    provider.getBalance(address).catch(() => 0n),
    tokens.tokenBalances(address, chainId).catch(() => []),
    txs.listActivity(address, chainId),
    ens.profileAddress(address).catch(() => null),
  ]);
  const [nftList, approvalList, hiddenTokens, hiddenNfts, nonce] = await Promise.all([
    tokens.nftBalances(address, chainId).catch(() => []),
    tokens.listApprovals(address, chainId).catch(() => []),
    tokens.listHiddenTokens(chainId).catch(() => []),
    tokens.listHiddenNfts(chainId).catch(() => []),
    // A blocking nonce gap has to be visible on the home screen, not only in
    // the send screen's advanced panel — the user has no reason to open that
    // when the symptom is "my transactions are just sitting there".
    txs.getNonceInfo(address, chainId).catch(() => null),
  ]);

  const nativeBalanceStr = formatEther(balance);
  const priced = await priceChain(chainId, nativeBalanceStr, tokenList, currency);

  // One point on the value curve. Throttled to hourly inside, so calling it on
  // every 15-second refresh is free.
  ledger.recordSnapshot({ address, chainId, totalFiat: priced.total, currency }).catch(() => {});

  // Floors are read from cache only. Fetching them here would put a
  // third-party round trip per collection inside the 15s home refresh; the NFT
  // detail screen fetches live, and this shows whatever that has already found.
  const nftsWithFloors = spam.annotateNfts(nftList).map((nft) => {
    const collection = prices.peekCollectionFloor(chainId, nft.address);
    return {
      ...nft,
      collection: collection
        ? { ...collection, floorFiat: prices.fiatValue(collection.floorNative, priced.nativePrice) }
        : null,
    };
  });

  return {
    address,
    account: selectedAccount ? { ...selectedAccount, ens: profile } : null,
    chainId,
    network,
    currency,
    native: {
      symbol: network.symbol,
      balance: nativeBalanceStr,
      raw: balance.toString(),
      price: priced.nativePrice,
      change24h: priced.nativeChange24h,
      fiat: priced.nativeFiat,
    },
    // Whether the numbers above can be trusted right now. A rate-limited cache
    // serves hours-old prices that look exactly like fresh ones.
    priceState: prices.priceState(),
    tokens: spam.annotateTokens(priced.tokens, { chainId }),
    totalFiat: priced.total,
    nfts: nftsWithFloors,
    hiddenTokens,
    hiddenNfts,
    approvals: approvalList,
    // Annotated, never filtered here: hiding a row in the background would mean
    // the UI could not offer to show it.
    activity: poisoning.annotateActivity(activity),
    nonce,
    pending: activity.filter((tx) => tx.status === 'pending').length,
  };
}

// The aggregate view is accounts × chains, so its cost multiplies fast. Cached
// briefly: the tab is usually opened, read, and closed again within seconds,
// and re-running the whole fan-out on every state broadcast is what made it
// feel broken.
let portfoliosCache = null;
const PORTFOLIOS_TTL_MS = 45_000;

async function getPortfolios({ force = false } = {}) {
  const currentChainId = await networks.getChainId();
  const allNets = await networks.visibleNetworks();
  const accounts = await ens.enrichAccounts(await keyring.listVisibleAccounts());
  const currency = await prices.getCurrency();

  const cacheKey = `${currentChainId}:${currency}:${accounts.map((a) => a.address).join(',')}:${Object.keys(allNets).join(',')}`;
  if (!force && portfoliosCache && portfoliosCache.key === cacheKey && Date.now() - portfoliosCache.at < PORTFOLIOS_TTL_MS) {
    return { ...portfoliosCache.value, cached: true, fetchedAt: portfoliosCache.at };
  }

  const failures = [];

  const rows = await Promise.all(
    accounts.map(async (account) => {
      const chainBalances = (
        await Promise.all(
          Object.values(allNets).map(async (net) => {
            try {
              const provider = await networks.getProvider(net.chainId);
              const [balance, tokenList, nftList] = await Promise.all([
                provider.getBalance(account.address).catch(() => 0n),
                tokens.tokenBalances(account.address, net.chainId).catch(() => []),
                // Stored records only. nftBalances re-reads ownership and
                // refetches metadata over HTTP for every token, which across
                // accounts × chains turned this screen into hundreds of
                // requests. The single-chain view keeps them accurate.
                tokens.listStoredNfts(net.chainId).catch(() => []),
              ]);

              const balanceStr = formatEther(balance);
              const priced = await priceChain(net.chainId, balanceStr, tokenList, currency);

              return {
                chainId: net.chainId,
                network: net,
                fiat: priced.total,
                native: {
                  symbol: net.symbol,
                  balance: balanceStr,
                  raw: balance.toString(),
                  price: priced.nativePrice,
                  fiat: priced.nativeFiat,
                },
                tokens: priced.tokens.filter((token) => token.raw && BigInt(token.raw) > 0n),
                nfts: nftList,
              };
            } catch (err) {
              // Recorded rather than swallowed. A chain that silently vanishes
              // makes the total quietly wrong, and the user has no way to tell
              // an empty chain from an unreachable one.
              failures.push({
                chainId: net.chainId,
                network: net.name,
                account: account.address,
                error: err.shortMessage ?? err.message,
              });
              return null;
            }
          })
        )
      ).filter(Boolean);

      // Each account's total is its own — not a running sum across the map,
      // which is order-dependent when the callbacks resolve concurrently.
      const accountFiat = chainBalances.reduce((sum, chain) => sum + chain.fiat, 0);

      return {
        ...account,
        chainBalances,
        totalFiat: accountFiat,
        native: chainBalances.find((c) => c.chainId === currentChainId)?.native ?? {
          symbol: allNets[currentChainId]?.symbol ?? 'ETH',
          balance: '0',
          raw: '0',
          fiat: null,
        },
        tokens: chainBalances.flatMap((c) => c.tokens),
        nfts: chainBalances.flatMap((c) => c.nfts),
      };
    })
  );

  const currentNetwork = await networks.getNetwork(currentChainId);
  const totalNativeRaw = rows.reduce((sum, row) => sum + BigInt(row.native.raw ?? '0'), 0n);
  const totalFiat = rows.reduce((sum, row) => sum + row.totalFiat, 0);

  // Where the money actually is, by chain and by asset. The single total
  // answers "how much"; these answer "where", which is the question that
  // decides whether to switch networks or bridge.
  const byChain = new Map();
  const byAsset = new Map();

  for (const row of rows) {
    for (const chain of row.chainBalances) {
      const entry = byChain.get(chain.chainId) ?? {
        chainId: chain.chainId,
        name: chain.network.name,
        symbol: chain.network.symbol,
        fiat: 0,
        nativeRaw: 0n,
        tokenCount: 0,
        nftCount: 0,
        accounts: 0,
      };
      entry.fiat += chain.fiat;
      entry.nativeRaw += BigInt(chain.native.raw ?? '0');
      entry.tokenCount += chain.tokens.length;
      entry.nftCount += chain.nfts.length;
      if (chain.fiat > 0 || BigInt(chain.native.raw ?? '0') > 0n) entry.accounts += 1;
      byChain.set(chain.chainId, entry);

      const nativeKey = `native:${chain.chainId}`;
      const nativeEntry = byAsset.get(nativeKey) ?? { key: nativeKey, symbol: chain.network.symbol, kind: 'native', fiat: 0 };
      nativeEntry.fiat += chain.native.fiat ?? 0;
      byAsset.set(nativeKey, nativeEntry);

      for (const token of chain.tokens) {
        // Grouped by symbol rather than by contract: USDC on four chains is one
        // position from the holder's point of view, not four.
        const key = `token:${(token.symbol ?? token.address).toUpperCase()}`;
        const tokenEntry = byAsset.get(key) ?? { key, symbol: token.symbol ?? '?', kind: 'token', fiat: 0, chains: new Set() };
        tokenEntry.fiat += token.fiat ?? 0;
        tokenEntry.chains.add(chain.chainId);
        byAsset.set(key, tokenEntry);
      }
    }
  }

  const share = (value) => (totalFiat > 0 ? Math.round((value / totalFiat) * 1000) / 10 : null);

  const allocation = {
    chains: [...byChain.values()]
      .map((entry) => ({
        ...entry,
        nativeRaw: entry.nativeRaw.toString(),
        nativeBalance: formatEther(entry.nativeRaw),
        share: share(entry.fiat),
      }))
      .sort((a, b) => b.fiat - a.fiat),
    assets: [...byAsset.values()]
      .map((entry) => ({
        key: entry.key,
        symbol: entry.symbol,
        kind: entry.kind,
        fiat: entry.fiat,
        chainCount: entry.chains ? entry.chains.size : 1,
        share: share(entry.fiat),
      }))
      .filter((entry) => entry.fiat > 0)
      .sort((a, b) => b.fiat - a.fiat)
      .slice(0, 12),
  };

  const value = {
    chainId: currentChainId,
    network: currentNetwork,
    currency,
    native: {
      symbol: currentNetwork.symbol,
      balance: formatEther(totalNativeRaw),
      raw: totalNativeRaw.toString(),
    },
    totalFiat,
    accounts: rows,
    allocation,
    // Chains that could not be read at all. Their balances are missing from the
    // total, and saying so is the difference between a wrong number and an
    // incomplete one.
    failures,
    chainsQueried: Object.keys(allNets).length,
    fetchedAt: Date.now(),
  };

  portfoliosCache = { key: cacheKey, at: Date.now(), value };
  return { ...value, cached: false };
}

// ---------------------------------------------------------------------------
// UI message handlers
// ---------------------------------------------------------------------------
const handlers = {
  GET_STATE: () => getState(),
  GET_PORTFOLIO: () => getPortfolio(),
  GET_PORTFOLIOS: ({ force = false } = {}) => getPortfolios({ force }),

  // --- simulation ----------------------------------------------------------
  SIMULATE: async ({ request }) =>
    simulation.simulateTransaction({ ...request, from: request.from ?? (await keyring.getSelected()) }),

  // --- swap and bridge -----------------------------------------------------
  SWAP_CHAINS: async () => ({ chains: await swap.supportedChains() }),
  SWAP_TOKENS: ({ chainId }) => swap.swapTokens(chainId).then((tokenList) => ({ tokens: tokenList })),
  SWAP_QUOTE: async ({ fromChainId, toChainId, fromToken, toToken, fromAmountRaw, slippage, gasRefuelRaw, fromAddress }) =>
    swap.getQuote({
      fromChainId,
      toChainId,
      fromToken,
      toToken,
      fromAmountRaw,
      slippage,
      gasRefuelRaw,
      fromAddress: fromAddress ?? (await keyring.getSelected()),
    }),
  /** Native balance on the destination chain, to decide whether refuel is needed. */
  DESTINATION_GAS: async ({ chainId }) => {
    const address = await keyring.getSelected();
    const provider = await networks.getProvider(chainId);
    const [balance, net] = await Promise.all([
      provider.getBalance(address).catch(() => null),
      networks.getNetwork(chainId),
    ]);
    return {
      chainId,
      symbol: net.symbol,
      raw: balance != null ? balance.toString() : null,
      // A balance too small to cover a basic transfer is the condition that
      // makes arriving tokens unusable, so that is the threshold reported.
      stranded: balance != null && balance < 300_000_000_000_000n,
    };
  },
  SWAP_ALLOWANCE: async ({ chainId, token, spender, amountRaw }) =>
    swap.checkSwapAllowance({ chainId, token, spender, amountRaw, owner: await keyring.getSelected() }),
  SWAP_APPROVE: async ({ chainId, token, spender, amountRaw, fees, gas }) => {
    const hash = await swap.approveForSwap({
      chainId,
      token,
      spender,
      amountRaw,
      fees,
      gas,
      from: await keyring.getSelected(),
    });
    return { hash };
  },
  SWAP_VERIFY: async ({ quote, allowanceReady }) =>
    swap.verifyQuote(quote, { from: await keyring.getSelected(), allowanceReady }),
  SWAP_EXECUTE: async ({ quote, fees, gas }) => {
    const hash = await swap.executeQuote({ quote, fees, gas, from: await keyring.getSelected() });
    // A swap is a disposal and an acquisition at once, and the aggregator has
    // already priced both legs — so the ledger gets a complete, priced pair
    // rather than a gap it can never fill in afterwards.
    await ledger
      .recordEntry({
        kind: 'dispose',
        symbol: quote.fromToken?.symbol,
        address: quote.fromToken?.address,
        chainId: quote.fromChainId,
        quantity: formatUnits(quote.fromAmountRaw, quote.fromToken?.decimals ?? 18),
        unitPrice: quote.fromToken?.priceUSD ?? null,
        source: 'swap',
        ref: hash,
        note: `Swapped for ${quote.toToken?.symbol}`,
      })
      .catch(() => {});
    await ledger
      .recordEntry({
        kind: 'acquire',
        symbol: quote.toToken?.symbol,
        address: quote.toToken?.address,
        chainId: quote.toChainId,
        quantity: formatUnits(quote.toAmountRaw, quote.toToken?.decimals ?? 18),
        unitPrice: quote.toToken?.priceUSD ?? null,
        source: 'swap',
        ref: hash,
        note: `Swapped from ${quote.fromToken?.symbol}`,
      })
      .catch(() => {});
    return { hash };
  },
  BRIDGE_STATUS: ({ txHash, fromChainId, toChainId, tool }) =>
    swap.bridgeStatus({ txHash, fromChainId, toChainId, tool }),

  // --- fiat on-ramp --------------------------------------------------------
  ONRAMP_PROVIDERS: async ({ chainId }) => ({
    providers: await onramp.listProviders(chainId ?? (await networks.getChainId())),
    handoffs: await onramp.listHandoffs(),
  }),
  ONRAMP_SET_KEY: ({ id, apiKey }) => onramp.setProviderKey(id, apiKey),
  ONRAMP_URL: async ({ providerId, symbol, fiatAmount, fiatCurrency }) => {
    const address = await keyring.getSelected();
    const accounts = await keyring.listAccounts();
    return onramp.buildOnrampUrl({
      providerId,
      address,
      chainId: await networks.getChainId(),
      symbol,
      fiatAmount,
      fiatCurrency,
      // Cross-checked against the wallet's own accounts before the address goes
      // into a URL — a pre-filled wrong address looks authoritative.
      ownedAddresses: accounts.map((account) => account.address),
    });
  },
  ONRAMP_RECORD: async (payload) =>
    onramp.recordHandoff({ ...payload, address: await keyring.getSelected(), chainId: await networks.getChainId() }),
  ONRAMP_CLEAR: () => onramp.clearHandoffs(),
  OFFRAMP_PROVIDERS: async ({ chainId }) => ({
    providers: await onramp.listSellProviders(chainId ?? (await networks.getChainId())),
  }),
  OFFRAMP_URL: async ({ providerId, symbol, fiatCurrency }) =>
    onramp.buildOfframpUrl({ providerId, chainId: await networks.getChainId(), symbol, fiatCurrency }),

  // --- batch transfers -----------------------------------------------------
  BATCH_PREPARE: async ({ transfers, tokenAddress }) =>
    batch.prepareBatch({ from: await keyring.getSelected(), transfers, tokenAddress }),
  BATCH_SEND: async ({ transfers, tokenAddress, fees, gas }) =>
    batch.sendBatch({ from: await keyring.getSelected(), transfers, tokenAddress, fees, gas }),

  // --- Safe multisig -------------------------------------------------------
  SAFE_INSPECT: ({ address, chainId }) => safe.inspectSafe(address, chainId),
  SAFE_PENDING: ({ address, chainId }) => safe.listPendingSafeTransactions(address, chainId),
  SAFE_BUILD: ({ safeAddress, to, value, data, operation, nonce }) =>
    safe.buildSafeTransaction({ safeAddress, to, value, data, operation, nonce }),
  /** Signs and publishes a new proposal in one step — an unshared signature helps nobody. */
  SAFE_PROPOSE: async ({ safeAddress, tx, safeTxHash, ownerAddress }) => {
    const { owner, signature } = await safe.signSafeTransaction({ safeAddress, tx, ownerAddress });
    const result = await safe.proposeSafeTransaction({ safeAddress, tx, safeTxHash, ownerAddress: owner, signature });
    notifyUi();
    return result;
  },
  SAFE_CONFIRM: async ({ safeAddress, tx, safeTxHash, ownerAddress }) => {
    const { signature } = await safe.signSafeTransaction({ safeAddress, tx, ownerAddress });
    const result = await safe.confirmSafeTransaction({ safeTxHash, signature });
    notifyUi();
    return result;
  },
  SAFE_CHECK_EXECUTABLE: async ({ safeAddress, tx, confirmations, executor }) =>
    safe.checkExecutable({
      safeAddress,
      tx,
      confirmations,
      executor: executor ?? (await keyring.getSelected()),
    }),
  SAFE_EXECUTE: async ({ safeAddress, tx, confirmations, fees, gas }) => {
    const from = await keyring.getSelected();
    const hash = await txs.sendTransaction({
      from,
      to: safeAddress,
      value: '0x0',
      data: safe.encodeExecution({ tx, confirmations }),
      fees,
      gas,
      meta: { kind: 'safeExecute', safeAddress, safeNonce: tx.nonce },
    });
    return { hash };
  },

  // --- ERC-4337 smart accounts ---------------------------------------------
  AA_CONFIG: ({ chainId }) => aa.getBundlerConfig(chainId),
  AA_SET_CONFIG: ({ chainId, bundlerUrl, paymasterUrl, paymasterContext }) =>
    aa.setBundlerConfig(chainId, { bundlerUrl, paymasterUrl, paymasterContext }),
  AA_TEST_BUNDLER: ({ url, chainId }) => aa.testBundler(url, chainId),
  AA_INSPECT: ({ address, chainId }) => aa.inspectSmartAccount(address, chainId),
  AA_PREPARE: ({ sender, calls, chainId, sponsor }) =>
    aa.prepareUserOperation({ sender, calls, chainId, sponsor }),
  AA_SEND: ({ prepared }) => aa.sendUserOperation({ prepared }),
  AA_STATUS: ({ userOpHash, chainId }) => aa.userOperationStatus({ userOpHash, chainId }),

  // --- EIP-7702 delegation -------------------------------------------------
  DELEGATION_SUPPORT: ({ chainId }) => delegation.supportsDelegation(chainId),
  GET_DELEGATION: async ({ address, chainId }) =>
    delegation.getDelegation(address ?? (await keyring.getSelected()), chainId),
  INSPECT_DELEGATE: ({ target, chainId }) => delegation.inspectDelegate(target, chainId),
  SET_DELEGATION: async ({ target, fees, gas }) => {
    const result = await delegation.setDelegation({ account: await keyring.getSelected(), target, fees, gas });
    notifyUi();
    return result;
  },
  REVOKE_DELEGATION: async ({ fees, gas }) => {
    const result = await delegation.revokeDelegation({ account: await keyring.getSelected(), fees, gas });
    notifyUi();
    return result;
  },
  TRUST_DELEGATE: ({ target, chainId, label }) => delegation.trustDelegate(target, chainId, label),
  UNTRUST_DELEGATE: ({ target, chainId }) => delegation.untrustDelegate(target, chainId),
  LIST_TRUSTED_DELEGATES: async () => ({ delegates: await delegation.listTrustedDelegates() }),
  SIMULATE_DELEGATED_BATCH: async ({ calls }) =>
    delegation.simulateDelegatedBatch({ account: await keyring.getSelected(), calls }),
  EXECUTE_DELEGATED_BATCH: async ({ calls, fees, gas }) =>
    delegation.executeBatchViaDelegation({ account: await keyring.getSelected(), calls, fees, gas }),

  // --- air-gapped QR signing -----------------------------------------------
  UR_BUILD_REQUEST: ({ dataHex, dataType, chainId, address, derivationPath, origin }) =>
    ur.buildSignRequest({ dataHex, dataType, chainId, address, derivationPath, origin }),
  UR_PARSE_SIGNATURE: ({ text }) => ur.parseSignature(text),
  UR_PARSE_HDKEY: ({ text }) => ur.parseHdKey(text),

  // --- share splitting -----------------------------------------------------
  SPLIT_PHRASE: async ({ password, vaultId, threshold, total }) => {
    // Re-derived from the vault behind a password check rather than accepted
    // from the UI: a phrase travelling through a message just to be split is a
    // phrase in one more place than it needs to be.
    const phrase = await keyring.revealVaultMnemonic(vaultId ?? null, password);
    return sharding.splitPhrase({ phrase, threshold, total });
  },
  COMBINE_SHARES: ({ shares }) => sharding.combineShares(shares),
  INSPECT_SHARE: ({ text }) => sharding.inspectShare(text),

  // --- passkeys ------------------------------------------------------------
  PASSKEY_READINESS: ({ chainId }) => webauthn.passkeyReadiness(chainId),
  PASSKEY_LIST: async () => ({ passkeys: await webauthn.listPasskeys() }),
  PASSKEY_REMOVE: ({ id }) => webauthn.removePasskey(id),
  CHECK_P256: ({ chainId }) => webauthn.checkP256Support(chainId),

  // --- notifications -------------------------------------------------------
  NOTIFICATION_PREFS: () => watcher.watchStatus(),
  SET_NOTIFICATION_PREFS: ({ prefs }) => watcher.setNotificationPrefs(prefs),
  RESET_WATCH: () => watcher.resetWatch(),
  POLL_INCOMING: () => watcher.pollIncoming(),

  // --- staking and DeFi positions ------------------------------------------
  STAKING_VENUES: async ({ chainId }) => defi.listStakingVenues(await keyring.getSelected(), chainId),
  QUOTE_STAKE: async ({ venueId, amountWei }) =>
    defi.quoteStake({ venueId, amountWei, from: await keyring.getSelected() }),
  STAKE: async ({ venueId, amountWei, fees, gas }) =>
    defi.stake({ venueId, amountWei, fees, gas, from: await keyring.getSelected() }),
  LIST_POSITIONS: async ({ chainId }) => defi.listPositions(await keyring.getSelected(), chainId),
  IDENTIFY_POSITION: async ({ address, chainId }) =>
    defi.identifyPosition(address, await keyring.getSelected(), chainId),
  TRACK_POSITION: async ({ address, chainId, label }) => {
    const result = await defi.trackPosition({ address, chainId, label });
    notifyUi();
    return result;
  },
  UNTRACK_POSITION: async ({ address, chainId }) => {
    const result = await defi.untrackPosition({ address, chainId });
    notifyUi();
    return result;
  },

  // --- prices --------------------------------------------------------------
  PRICE_STATE: () => prices.priceState(),

  // --- portfolio history and cost basis ------------------------------------
  VALUE_HISTORY: async ({ days }) => ledger.valueHistory({ address: await keyring.getSelected(), days }),
  CLEAR_VALUE_HISTORY: () => ledger.clearHistory(),
  LIST_LEDGER: async () => ({ entries: await ledger.listEntries(), methods: ledger.LOT_METHODS }),
  ADD_LEDGER_ENTRY: async ({ entry }) => {
    const row = await ledger.recordEntry(entry);
    notifyUi();
    return row ?? { duplicate: true };
  },
  REMOVE_LEDGER_ENTRY: ({ id }) => ledger.removeEntry(id),
  IMPORT_LEDGER: async () => {
    const result = await ledger.importFromActivity();
    notifyUi();
    return result;
  },
  DISPOSAL_REPORT: ({ method, year }) => ledger.buildDisposalReport({ method, year }),
  DISPOSAL_CSV: async ({ method, year }) => ({
    csv: ledger.disposalCsv(await ledger.buildDisposalReport({ method, year })),
  }),
  CLEAR_LEDGER: () => ledger.clearLedger(),

  // --- security lists ------------------------------------------------------
  GET_SECURITY_LISTS: () => security.getSecurityLists(),
  SCREEN_DOMAIN: ({ origin }) => security.screenDomain(origin),
  SCREEN_ADDRESS: async ({ address, chainId }) =>
    security.screenAddress(address, { provider: await networks.getProvider(chainId) }),
  ADD_SECURITY_ENTRY: async ({ kind, value }) => {
    const result = await security.addToList(kind, value);
    notifyUi();
    return result;
  },
  REMOVE_SECURITY_ENTRY: async ({ kind, value }) => {
    const result = await security.removeFromList(kind, value);
    notifyUi();
    return result;
  },
  IMPORT_SECURITY_FEED: async ({ url, name }) => {
    const result = await security.importSecurityFeed(url, name);
    notifyUi();
    return result;
  },
  REMOVE_SECURITY_FEED: async ({ url }) => {
    const result = await security.removeSecurityFeed(url);
    notifyUi();
    return result;
  },

  // --- vault ---------------------------------------------------------------
  CREATE_WALLET: ({ password }) => keyring.createVault(password),
  IMPORT_MNEMONIC: ({ password, mnemonic, pathTemplate }) =>
    keyring.createVault(password, mnemonic, pathTemplate),
  IMPORT_PRIVATE_KEY_WALLET: ({ password, privateKey, name }) =>
    keyring.createPrivateKeyVault(password, privateKey, name),
  IMPORT_KEYSTORE_WALLET: ({ password, keystore, keystorePassword, name }) =>
    keyring.createKeystoreVault(password, keystore, keystorePassword, name),
  PREVIEW_DERIVATION: ({ mnemonic }) => ({ presets: keyring.previewDerivation(mnemonic) }),
  PREVIEW_CUSTOM_DERIVATION: ({ mnemonic, template }) => keyring.previewCustomDerivation(mnemonic, template),

  // --- recovery phrases (vaults) -------------------------------------------
  LIST_VAULTS: () => keyring.listVaults(),
  ADD_VAULT: async ({ mnemonic, name, pathTemplate }) => {
    const vault = await keyring.addVault({ mnemonic, name, pathTemplate });
    broadcastEvent('accountsChanged');
    return vault;
  },
  RENAME_VAULT: ({ id, name }) => keyring.renameVault(id, name),
  REMOVE_VAULT: async ({ id }) => {
    // Capture the addresses before they are dropped, so their site grants can
    // be revoked too — otherwise a re-imported phrase would silently inherit
    // permissions the user granted in a previous session.
    const doomed = (await keyring.listAccounts()).filter((account) => account.vaultId === id);
    await keyring.removeVault(id);
    for (const account of doomed) await permissions.purgeAccount(account.address);
    broadcastEvent('accountsChanged');
    notifyUi();
    return { ok: true };
  },
  REVEAL_VAULT_MNEMONIC: ({ id, password }) =>
    keyring.revealVaultMnemonic(id, password).then((mnemonic) => ({ mnemonic })),

  // --- backup --------------------------------------------------------------
  GET_BACKUP_STATE: () => keyring.getBackupState(),
  VERIFY_BACKUP: ({ words }) => keyring.verifyBackup(words),
  CONFIRM_BACKUP: () => keyring.confirmBackup(),
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
  ADD_ACCOUNT: async ({ name, vaultId }) => {
    const account = await keyring.addAccount(name, vaultId);
    broadcastEvent('accountsChanged');
    return account;
  },
  IMPORT_PRIVATE_KEY: async ({ privateKey, name }) => {
    const account = await keyring.importPrivateKey(privateKey, name);
    broadcastEvent('accountsChanged');
    return account;
  },
  IMPORT_KEYSTORE: async ({ keystore, keystorePassword, name }) => {
    const account = await keyring.importKeystore(keystore, keystorePassword, name);
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
  UPGRADE_WATCH_ACCOUNT: async ({ address, privateKey }) => {
    const account = await keyring.upgradeWatchAccount(address, privateKey);
    broadcastEvent('accountsChanged');
    notifyUi();
    return account;
  },
  SET_ENS_AVATARS: async ({ value }) => {
    await ens.setAvatarsEnabled(value);
    notifyUi();
    return { ok: true };
  },
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
  EDIT_NETWORK: async ({ chainId, network }) => {
    const updated = await networks.editNetwork(chainId, network);
    notifyUi();
    return updated;
  },
  RESET_NETWORK: async ({ chainId }) => {
    const restored = await networks.resetNetwork(chainId);
    notifyUi();
    return restored;
  },
  TEST_RPC: ({ network }) => networks.testRpc(network),
  CHECK_NETWORK_HEALTH: async ({ chainId, force = true }) => networks.getNetworkHealth(chainId, { force }),
  CHECK_ALL_NETWORKS: () => networks.checkAllNetworks(),
  // --- RPC endpoints (failover) --------------------------------------------
  PEEK_ENDPOINTS: async ({ chainId }) => ({ endpoints: await networks.peekEndpoints(chainId) }),
  CHECK_ENDPOINTS: async ({ chainId }) => ({ endpoints: await networks.checkEndpoints(chainId) }),
  REMOVE_NETWORK: async ({ chainId }) => {
    await networks.removeNetwork(chainId);
    await permissions.purgeNetwork(chainId);
    broadcastEvent('chainChanged', await networks.getChainId());
    return { ok: true };
  },
  SET_SHOW_TESTNETS: async ({ value }) => {
    await networks.setShowTestnets(value);
    broadcastEvent('chainChanged', await networks.getChainId());
    notifyUi();
    return { ok: true };
  },

  // --- tokens --------------------------------------------------------------
  LOOKUP_TOKEN: ({ address }) => tokens.readTokenMetadata(address),
  SEARCH_TOKENS: ({ query }) => tokens.searchTokenRegistry(query),
  DETECT_TOKENS: async () => tokens.detectTokens(await keyring.getSelected()),
  ADD_TOKEN: ({ token }) => tokens.addToken(token),
  ADD_TOKENS: async ({ entries }) => {
    const result = await tokens.addTokensFromList(entries);
    notifyUi();
    return result;
  },
  EDIT_TOKEN: async ({ address, patch }) => {
    const result = await tokens.editToken(address, patch);
    notifyUi();
    return result;
  },
  REFRESH_TOKEN_METADATA: async ({ address }) => {
    const result = await tokens.refreshTokenMetadata(address);
    notifyUi();
    return result;
  },
  REMOVE_TOKEN: async ({ address }) => {
    await tokens.removeToken(address);
    notifyUi();
    return { ok: true };
  },

  // --- token lists ---------------------------------------------------------
  GET_TOKEN_LISTS: async () => ({
    lists: await tokenLists.listTokenLists(),
    curated: tokenLists.CURATED_LISTS,
  }),
  PREVIEW_TOKEN_LIST: ({ url }) => tokenLists.fetchTokenList(url),
  ADD_TOKEN_LIST: async ({ url }) => {
    const result = await tokenLists.saveTokenList(url);
    notifyUi();
    return result;
  },
  REFRESH_TOKEN_LIST: async ({ url }) => {
    const result = await tokenLists.refreshTokenList(url);
    notifyUi();
    return result;
  },
  SET_TOKEN_LIST_ENABLED: async ({ url, enabled }) => {
    const result = await tokenLists.setTokenListEnabled(url, enabled);
    notifyUi();
    return result;
  },
  REMOVE_TOKEN_LIST: async ({ url }) => {
    const result = await tokenLists.removeTokenList(url);
    notifyUi();
    return result;
  },
  HIDE_TOKEN: ({ address }) => tokens.hideToken(address),
  HIDE_TOKENS: async ({ addresses }) => {
    for (const address of addresses ?? []) await tokens.hideToken(address).catch(() => {});
    notifyUi();
    return { hidden: (addresses ?? []).length };
  },
  UNHIDE_TOKEN: ({ address }) => tokens.unhideToken(address),
  LOOKUP_NFT: async ({ nft }) => tokens.lookupNft(nft, await keyring.getSelected()),
  ADD_NFT: ({ nft }) => tokens.addNft(nft),
  REMOVE_NFT: ({ nft }) => tokens.removeNft(nft),
  HIDE_NFT: ({ nft }) => tokens.hideNft(nft),
  HIDE_NFTS: async ({ nfts: list }) => {
    for (const nft of list ?? []) await tokens.hideNft(nft).catch(() => {});
    notifyUi();
    return { hidden: (list ?? []).length };
  },
  UNHIDE_NFT: ({ nft }) => tokens.unhideNft(nft),
  LOOKUP_ENS_PROFILE: ({ address }) => ens.profileAddress(address),
  /** Live collection floor for one NFT contract, priced in the user's currency. */
  GET_NFT_COLLECTION: async ({ address, chainId, force = false }) => {
    const chain = chainId ?? (await networks.getChainId());
    const currency = await prices.getCurrency();
    const collection = await prices.collectionFloor(chain, address, { force });
    if (!collection) return { collection: null, currency };

    // The floor is quoted in the chain's native coin, so converting it uses the
    // same native price the rest of the portfolio is valued with — no second
    // rate, and no drift between the two numbers on screen.
    const nativePrice = await prices.nativePrice(chain, currency);
    return {
      currency,
      collection: {
        ...collection,
        floorFiat: prices.fiatValue(collection.floorNative, nativePrice),
        volume24hFiat: prices.fiatValue(collection.volume24hNative, nativePrice),
      },
    };
  },
  // The Send screen needs calldata before it can estimate gas. It asks here
  // rather than re-implementing the encoding, so the estimate and the real
  // transaction can never drift apart.
  ENCODE_TRANSFER: ({ to, amount, decimals }) => ({ data: tokens.encodeTransfer(to, amount, decimals) }),

  // --- sending -------------------------------------------------------------
  RESOLVE_RECIPIENT: ({ input }) => txs.resolveRecipient(input).then((address) => ({ address })),
  INSPECT_RECIPIENT: ({ input, tokenAddress }) => txs.inspectRecipient(input, null, { tokenAddress }),
  PARSE_PAYMENT_URI: ({ input }) => ({ parsed: txs.parsePaymentUri(input) }),
  GET_TRANSACTION_DETAIL: ({ hash }) => txs.getTransactionDetail(hash),
  GET_NONCE_INFO: async ({ address }) => txs.getNonceInfo(address ?? (await keyring.getSelected())),
  GET_FEE_HISTORY: ({ chainId }) => txs.getFeeHistory(chainId),
  QUOTE_NONCE_FILL: async ({ nonce }) => txs.quoteNonceGapFill({ nonce, from: await keyring.getSelected() }),
  FILL_NONCE_GAP: async ({ nonce, fees, gas }) => {
    const hash = await txs.fillNonceGap({ nonce, fees, gas, from: await keyring.getSelected() });
    return { hash };
  },
  VALIDATE_FEES: ({ fees, gasInfo }) => txs.validateFees(fees, gasInfo),
  LIST_PENDING: async () => txs.listPending(await keyring.getSelected()),
  ESTIMATE_GAS: ({ request }) => txs.estimateGas(request),
  SEND_TRANSACTION: async ({ request }) => {
    // The price is captured now, not at report time. Looking it up later gives
    // today's price, which would make every historic disposal wrong by however
    // much the market has moved since.
    const unitPrice = await currentPrice({ native: true }).catch(() => null);
    const hash = await txs.sendTransaction({ ...request, meta: { ...(request.meta ?? {}), unitPrice } });
    await contacts.recordContactUse(request.to);
    return { hash };
  },
  // --- NFT transfer ---------------------------------------------------------
  CHECK_NFT_TRANSFER: async ({ nft, to, amount }) => {
    const owner = await keyring.getSelected();
    const [transferable, recipient] = await Promise.all([
      tokens.checkNftTransferable({ ...nft, owner, amount }),
      to ? tokens.checkNftRecipient(to) : Promise.resolve(null),
    ]);
    return { transferable, recipient };
  },
  ESTIMATE_NFT_TRANSFER: async ({ nft, to, amount }) => {
    const from = await keyring.getSelected();
    const data = tokens.encodeNftTransfer({ standard: nft.standard, from, to, tokenId: nft.tokenId, amount });
    return txs.estimateGas({ from, to: nft.address, value: '0x0', data });
  },
  SEND_NFT: async ({ nft, to, amount, fees, gas, nonce }) => {
    const from = await keyring.getSelected();
    // Re-checked at send time, not just at review time: ownership can change
    // between the two, and the transaction would revert after paying gas.
    await tokens.checkNftTransferable({ ...nft, owner: from, amount });

    const hash = await txs.sendTransaction({
      from,
      to: nft.address,
      value: '0x0',
      data: tokens.encodeNftTransfer({ standard: nft.standard, from, to, tokenId: nft.tokenId, amount }),
      fees,
      gas,
      nonce,
      meta: {
        kind: 'nftTransfer',
        nftAddress: nft.address,
        nftTokenId: String(nft.tokenId),
        nftStandard: nft.standard,
        nftTitle: nft.title || nft.name || '',
        nftAmount: String(amount ?? 1),
        nftTo: to,
      },
    });
    await contacts.recordContactUse(to);
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
      meta: {
        tokenSymbol: token.symbol,
        tokenAmount: String(amount),
        tokenTo: to,
        unitPrice: await currentPrice({ address: token.address }).catch(() => null),
      },
    });
    await contacts.recordContactUse(to);
    return { hash };
  },
  SPEED_UP: ({ hash }) => txs.speedUp(hash).then((newHash) => ({ hash: newHash })),
  CANCEL_TX: ({ hash }) => txs.cancelTransaction(hash).then((newHash) => ({ hash: newHash })),
  UPDATE_TX_META: ({ hash, note, tags }) => txs.updateActivityMeta({ hash, note, tags }),
  LIST_TAGS: async ({ chainId } = {}) =>
    ({ tags: await txs.listTags(await keyring.getSelected(), chainId ?? (await networks.getChainId())) }),
  TOGGLE_TX_TAG: ({ hash, tag }) => txs.toggleActivityTag({ hash, tag }),
  RENAME_TAG: async ({ from, to }) => {
    const result = await txs.renameTag({ from, to });
    notifyUi();
    return result;
  },
  QUOTE_REVOKE: async ({ id }) => txs.quoteRevoke({ id, from: await keyring.getSelected() }),
  REVOKE_APPROVAL: async ({ id, fees, gas }) => {
    const hash = await txs.revokeApproval({ id, fees, gas, from: await keyring.getSelected() });
    return { hash };
  },
  REVOKE_APPROVALS: async ({ ids }) => txs.revokeApprovals({ ids, from: await keyring.getSelected() }),
  INSPECT_APPROVAL: async ({ contract, data, chainId }) =>
    txs.inspectApproval({ owner: await keyring.getSelected(), contract, data, chainId }),

  // --- sites ---------------------------------------------------------------
  DISCONNECT_SITE: async ({ origin }) => {
    await permissions.revoke(origin);
    broadcastEvent('accountsChanged', [], origin);
    notifyUi();
    return { ok: true };
  },
  DISCONNECT_ALL_SITES: async () => {
    const result = await permissions.revokeAll();
    for (const origin of result.origins) broadcastEvent('accountsChanged', [], origin);
    notifyUi();
    return result;
  },
  GET_SITE_ACTIVITY: ({ origin }) => permissions.siteActivity(origin),
  LIST_HISTORY_ORIGINS: async () => ({ origins: await permissions.listHistoryOrigins() }),
  CLEAR_HISTORY: async () => {
    const result = await permissions.clearHistory();
    notifyUi();
    return result;
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

  // --- encrypted backup ----------------------------------------------------
  GET_BACKUP_SECTIONS: () => ({ sections: backup.BACKUP_SECTIONS }),
  EXPORT_BACKUP: ({ password, sections }) => backup.exportBackup(password, sections),
  PREVIEW_BACKUP: ({ password, file }) => backup.previewBackup(password, file),
  RESTORE_BACKUP: async ({ password, file, sections }) => {
    const result = await backup.restoreBackup(password, file, sections);
    // A restore can rename accounts, add networks, and change the theme, so
    // every open surface needs to re-read rather than keep a stale snapshot.
    notifyUi();
    return result;
  },

  // --- signature log -------------------------------------------------------
  // Destructured field by field rather than passed straight through: the router
  // hands the whole message to the handler, and it carries a `type` of its own
  // that would otherwise be read as the signature-type filter and match nothing.
  LIST_SIGNATURES: async ({ origin, account, signatureType, kind, query } = {}) => ({
    signatures: await signatures.listSignatures({ origin, account, type: signatureType, kind, query }),
    stats: await signatures.signatureStats(account),
  }),
  SIGNATURE_STATS: async ({ account }) => signatures.signatureStats(account ?? (await keyring.getSelected())),
  CLEAR_SIGNATURES: async () => {
    const result = await signatures.clearSignatures();
    notifyUi();
    return result;
  },

  // --- search --------------------------------------------------------------
  GLOBAL_SEARCH: async ({ query }) => globalSearch(query, { address: await keyring.getSelected() }),
  ACTIVITY_BY_CHAIN: async ({ address }) => ({
    chains: await txs.activityChainSummary(address ?? (await keyring.getSelected())),
  }),
  LIST_ALL_ACTIVITY: async ({ address }) =>
    poisoning.annotateActivity(
      await txs.listActivity(address ?? (await keyring.getSelected()), null, { allChains: true })
    ),

  // --- contacts ------------------------------------------------------------
  LIST_CONTACTS: () => contacts.listContacts(),
  LIST_CONTACT_LABELS: async () => ({ labels: await contacts.listLabels() }),
  FIND_CONTACT: ({ address }) => contacts.findContactByAddress(address),
  EXPORT_CONTACTS: () => contacts.exportContacts(),
  IMPORT_CONTACTS: async ({ payload }) => {
    const result = await contacts.importContacts(payload);
    notifyUi();
    return result;
  },
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
  SET_CURRENCY: async ({ currency }) => {
    await prices.setCurrency(currency);
    notifyUi();
    return { ok: true };
  },
  SET_LOCALE: async ({ locale }) => {
    await i18n.setLocale(locale);
    notifyUi();
    return { ok: true };
  },
  GET_CURRENCIES: () => ({ currencies: prices.FIAT_CURRENCIES, locales: i18n.LOCALES }),

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

// And the incoming watcher, which otherwise dies with the service worker and
// never restarts — the failure mode being "notifications silently stopped".
watcher
  .getNotificationPrefs()
  .then((prefs) => {
    if (prefs.enabled && prefs.incoming) watcher.scheduleWatch();
  })
  .catch(() => {});
