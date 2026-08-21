// Incoming transaction detection.
//
// Outgoing notifications already existed — the wallet knows what it sent. The
// missing half is money arriving, and with no indexer that has to be found the
// hard way: poll `eth_getLogs` for ERC-20 Transfer events addressed to the
// user, and watch the native balance for movement logs cannot explain.
//
// Two constraints shape everything here. Public endpoints cap `eth_getLogs`
// block ranges and rate-limit aggressively, so the scan is bounded, backed off,
// and never tries to catch up across a huge gap in one request. And a wallet
// that pings on every airdropped scam token is a wallet whose notifications get
// switched off, so spam scoring gates what is worth interrupting someone for.

import { Interface, formatEther, formatUnits, getAddress, id } from 'ethers';
import { local } from './storage.js';
import { getProvider, getChainId, getNetwork } from './networks.js';
import { listVisibleAccounts } from './keyring.js';
import { listTokens } from './tokens.js';
import { scoreToken } from './spam.js';

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const transferInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

// Public endpoints commonly cap getLogs at a few thousand blocks. Staying well
// inside that is cheaper than discovering the limit through errors.
const MAX_BLOCK_SPAN = 900;
// Far enough behind and the backlog is not worth reconstructing — the balance
// is already right, and a burst of notifications for week-old transfers is
// noise. The watermark jumps forward instead.
const MAX_CATCHUP_BLOCKS = 5000;
const SEEN_LIMIT = 400;

const DEFAULT_PREFS = {
  enabled: true,
  incoming: true,
  outgoing: true,
  minimumFiat: 0,
  ignoreSpam: true,
};

export async function getNotificationPrefs() {
  return { ...DEFAULT_PREFS, ...(await local.get('notificationPrefs', {})) };
}

export async function setNotificationPrefs(patch) {
  const next = { ...(await getNotificationPrefs()), ...patch };
  await local.set({ notificationPrefs: next });
  // Restarting is how a re-enable takes effect without waiting for the next tick.
  if (next.enabled && next.incoming) scheduleWatch();
  else chrome.alarms.clear('watch-incoming');
  return next;
}

export function scheduleWatch() {
  // 1 minute is the shortest period Chrome honours reliably for a packed
  // extension; anything smaller is silently clamped.
  chrome.alarms.create('watch-incoming', { periodInMinutes: 1 });
}

const readState = () => local.get('watchState', {});
const readSeen = () => local.get('watchSeen', []);

async function markSeen(keys) {
  if (!keys.length) return;
  const seen = await readSeen();
  await local.set({ watchSeen: [...keys, ...seen].slice(0, SEEN_LIMIT) });
}

/**
 * Fires a desktop notification.
 *
 * Every failure path is swallowed: notifications are a courtesy, and a Chrome
 * build that returns undefined instead of a promise must not take down the
 * polling loop that found the transfer.
 */
function notify(id, title, message, contextUrl) {
  try {
    chrome.notifications?.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title,
      message,
      contextMessage: contextUrl ? new URL(contextUrl).host : undefined,
    });
  } catch {
    /* notifications are never a reason to stop */
  }
}

/**
 * One polling pass over the current chain.
 *
 * Scoped to the selected network on purpose. Scanning every chain for every
 * account each minute would multiply requests across endpoints that are already
 * rate-limited, for balances the user is not looking at.
 */
export async function pollIncoming() {
  const prefs = await getNotificationPrefs();
  if (!prefs.enabled || !prefs.incoming) return { skipped: 'disabled' };

  const chainId = await getChainId();
  const provider = await getProvider(chainId);
  const network = await getNetwork(chainId);

  const accounts = await listVisibleAccounts();
  if (!accounts.length) return { skipped: 'no accounts' };

  let head;
  try {
    head = await provider.getBlockNumber();
  } catch {
    return { skipped: 'unreachable' };
  }

  const state = await readState();
  const seen = new Set(await readSeen());
  const tokens = await listTokens(chainId).catch(() => []);
  const tokenByAddress = new Map(tokens.map((token) => [token.address.toLowerCase(), token]));

  const fresh = [];

  for (const account of accounts) {
    const key = `${chainId}:${account.address.toLowerCase()}`;
    const previous = state[key] ?? {};

    // First sight of an account starts the watermark at the head. Backfilling
    // its whole history would notify about transfers from years ago.
    let from = previous.lastBlock ? previous.lastBlock + 1 : head;
    if (head - from > MAX_CATCHUP_BLOCKS) from = head - MAX_CATCHUP_BLOCKS;
    const to = Math.min(head, from + MAX_BLOCK_SPAN - 1);

    if (to >= from) {
      try {
        const logs = await provider.getLogs({
          fromBlock: from,
          toBlock: to,
          // Third topic is the indexed recipient; filtering server-side keeps
          // the response to this account's incoming transfers only.
          topics: [TRANSFER_TOPIC, null, `0x${'0'.repeat(24)}${account.address.slice(2).toLowerCase()}`],
        });

        for (const log of logs) {
          const seenKey = `${log.transactionHash}:${log.index ?? log.logIndex ?? 0}`;
          if (seen.has(seenKey)) continue;

          // Four topics means an indexed token id, i.e. an NFT rather than an
          // ERC-20 amount. Reading its third topic as a quantity would report a
          // token id as a balance.
          const isNft = log.topics.length === 4;
          const token = tokenByAddress.get(log.address.toLowerCase());

          let amountText;
          if (isNft) {
            amountText = `NFT #${BigInt(log.topics[3]).toString()}`;
          } else {
            let value;
            try {
              value = transferInterface.decodeEventLog('Transfer', log.data, log.topics).value;
            } catch {
              continue;
            }
            if (value === 0n) continue; // zero-value dust: the poisoning vector
            amountText = token
              ? `${formatUnits(value, token.decimals)} ${token.symbol}`
              : `${formatUnits(value, 18)} tokens`;
          }

          // An untracked contract sending you something is usually an airdrop,
          // and usually spam. Scoring it keeps notifications worth reading.
          if (prefs.ignoreSpam) {
            const candidate = token ?? { address: log.address, symbol: '', name: '' };
            if (!token || scoreToken(candidate, { chainId }).likelySpam) continue;
          }

          fresh.push({ key: seenKey, hash: log.transactionHash });
          notify(
            `in:${seenKey}`,
            `Received ${amountText}`,
            `${account.name} on ${network.name}`,
            network.explorer ? `${network.explorer}/tx/${log.transactionHash}` : undefined
          );
        }
      } catch {
        // Range too wide, rate limited, or the endpoint refuses getLogs. The
        // watermark is not advanced, so the same span is retried next tick.
        continue;
      }
    }

    // --- native movement -------------------------------------------------
    // Logs cannot see plain ETH arriving, so the balance is compared directly.
    let balance = null;
    try {
      balance = await provider.getBalance(account.address);
    } catch {
      /* leave the previous snapshot in place */
    }

    if (balance != null && previous.nativeBalance != null) {
      const delta = balance - BigInt(previous.nativeBalance);
      if (delta > 0n) {
        notify(
          `nat:${key}:${head}`,
          `Received ${formatEther(delta)} ${network.symbol}`,
          `${account.name} on ${network.name}`
        );
      }
    }

    state[key] = {
      lastBlock: to >= from ? to : (previous.lastBlock ?? head),
      nativeBalance: balance != null ? balance.toString() : previous.nativeBalance,
      checkedAt: Date.now(),
    };
  }

  await local.set({ watchState: state });
  await markSeen(fresh.map((entry) => entry.key));

  if (fresh.length) chrome.runtime.sendMessage({ type: 'STATE_CHANGED' }).catch(() => {});
  return { found: fresh.length, head, chainId };
}

/** Clears watermarks so the next pass starts fresh at the head. */
export async function resetWatch() {
  await local.set({ watchState: {}, watchSeen: [] });
  return { ok: true };
}

export async function watchStatus() {
  const [prefs, state] = await Promise.all([getNotificationPrefs(), readState()]);
  const entries = Object.entries(state);
  return {
    prefs,
    watching: entries.length,
    lastCheckedAt: entries.reduce((latest, [, value]) => Math.max(latest, value.checkedAt ?? 0), 0) || null,
    // Stated plainly: this is a poller, not an indexer, and it only covers the
    // network currently selected.
    scope: 'selected network only',
  };
}
