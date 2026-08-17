import * as permissions from './permissions.js';

/**
 * Push an EIP-1193 event to pages. With no origin it goes to every connected
 * site; with one, only to that site's tabs.
 */
export async function broadcastEvent(event, params, onlyOrigin = null) {
  const sites = await permissions.listSites();
  const connectedOrigins = new Set(sites.map((s) => s.origin));
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let origin;
    try {
      origin = new URL(tab.url).origin;
    } catch {
      continue;
    }
    if (onlyOrigin ? origin !== onlyOrigin : !connectedOrigins.has(origin)) continue;

    if (event === 'chainChanged') {
      if (await permissions.isNetworkPermitted(origin, params)) {
        chrome.tabs.sendMessage(tab.id, { type: 'WALLET_EVENT', event, params }).catch(() => {});
      } else {
        chrome.tabs.sendMessage(tab.id, { type: 'WALLET_EVENT', event: 'accountsChanged', params: [] }).catch(() => {});
      }
      continue;
    }

    // Each site sees only the accounts it was granted on the selected network.
    const payload =
      event === 'accountsChanged' && !onlyOrigin
        ? await permissions.accountsFor(origin, { requireNetwork: true })
        : params;
    chrome.tabs.sendMessage(tab.id, { type: 'WALLET_EVENT', event, params: payload }).catch(() => {});
  }
}

/** Tells any open extension UI to re-read state. */
export function notifyUi() {
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED' }).catch(() => {});
}
