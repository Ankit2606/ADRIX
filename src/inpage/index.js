// Runs in the page's own JavaScript context (MAIN world), so it can define
// window.ethereum. It has no chrome.* access - everything goes through
// window.postMessage to the content script bridge.

const TO_BRIDGE = 'miniwallet:to-bridge';
const TO_PAGE = 'miniwallet:to-page';

// Some older dApps gate their connect button on `ethereum.isMetaMask`.
// Flip this to true only if you are testing against such an app.
const PRETEND_TO_BE_METAMASK = false;

const ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#0B1020"/><path d="M24 34h48v34a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6z" fill="#2DD4BF"/><path d="M24 34l24-12 24 12" stroke="#2DD4BF" stroke-width="6" fill="none" stroke-linejoin="round"/><circle cx="62" cy="53" r="5" fill="#0B1020"/></svg>`
  );

let requestId = 0;
const inflight = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    inflight.set(id, { resolve, reject });
    window.postMessage({ target: TO_BRIDGE, payload: { id, method, params } }, window.location.origin);
  });
}

class MiniWalletProvider {
  constructor() {
    this.isMiniWallet = true;
    this.isMetaMask = PRETEND_TO_BE_METAMASK;
    this.selectedAddress = null;
    this.chainId = null;
    this.networkVersion = null;
    this._listeners = new Map();
    this._connected = false;
    this._metamask = {
      isUnlocked: () => send('miniwallet_isUnlocked', []),
    };
  }

  async request(args) {
    if (!args || typeof args.method !== 'string') {
      throw Object.assign(new Error('Expected a request object with a method.'), { code: -32602 });
    }
    const result = await send(args.method, args.params ?? []);

    // Keep the convenience properties in sync with what the wallet just told us.
    if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') {
      this.selectedAddress = result[0] ?? null;
    }
    if (args.method === 'eth_chainId') {
      this.chainId = result;
      this.networkVersion = String(parseInt(result, 16));
    }
    return result;
  }

  // --- EIP-1193 events -----------------------------------------------------
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return this;
  }
  addListener(event, handler) {
    return this.on(event, handler);
  }
  once(event, handler) {
    const wrapped = (...args) => {
      this.removeListener(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }
  removeListener(event, handler) {
    this._listeners.get(event)?.delete(handler);
    return this;
  }
  removeAllListeners(event) {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
    return this;
  }
  _emit(event, payload) {
    if (event === 'accountsChanged') {
      this.selectedAddress = payload?.[0] ?? null;
      // No accounts left means the site was disconnected. EIP-1193 asks for a
      // `disconnect` event, and dApps rely on it to clear their UI.
      if (!payload?.length && this._connected) {
        this._connected = false;
        this._emit('disconnect', Object.assign(new Error('Disconnected from MiniWallet.'), { code: 4900 }));
      }
    }
    if (event === 'chainChanged') {
      this.chainId = payload;
      this.networkVersion = String(parseInt(payload, 16));
    }
    for (const handler of this._listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (err) {
        console.error('[MiniWallet] listener threw', err);
      }
    }
  }

  // --- Legacy shims some libraries still reach for --------------------------
  enable() {
    return this.request({ method: 'eth_requestAccounts' });
  }
  isConnected() {
    return true;
  }
  send(methodOrPayload, paramsOrCallback) {
    if (typeof methodOrPayload === 'string') {
      return this.request({ method: methodOrPayload, params: paramsOrCallback ?? [] });
    }
    if (typeof paramsOrCallback === 'function') {
      return this.sendAsync(methodOrPayload, paramsOrCallback);
    }
    return this.request(methodOrPayload);
  }
  sendAsync(payload, callback) {
    this.request(payload).then(
      (result) => callback(null, { id: payload.id, jsonrpc: '2.0', result }),
      (error) => callback(error)
    );
  }
}

const provider = new MiniWalletProvider();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.target !== TO_PAGE) return;

  const { id, result, error, event: eventName, params } = message.payload ?? {};

  if (eventName) {
    provider._emit(eventName, params);
    return;
  }

  const pending = inflight.get(id);
  if (!pending) return;
  inflight.delete(id);

  if (error) {
    pending.reject(Object.assign(new Error(error.message), { code: error.code, data: error.data }));
  } else {
    pending.resolve(result);
  }
});

// --- Expose the provider ---------------------------------------------------
try {
  Object.defineProperty(window, 'ethereum', {
    value: provider,
    writable: true,
    configurable: true,
  });
} catch {
  // Another wallet locked the property down. EIP-6963 below still works.
  console.warn('[MiniWallet] window.ethereum is already taken by another wallet.');
}
window.miniWallet = provider;

// EIP-6963 - how wagmi / RainbowKit / ConnectKit discover wallets without
// fighting over window.ethereum.
const providerInfo = Object.freeze({
  uuid: crypto.randomUUID(),
  name: 'MiniWallet',
  icon: ICON,
  rdns: 'dev.miniwallet.extension',
});

function announce() {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info: providerInfo, provider }),
    })
  );
}

window.addEventListener('eip6963:requestProvider', announce);
announce();

// Tell the page a provider showed up, the way MetaMask does.
window.dispatchEvent(new Event('ethereum#initialized'));

// Prime the chain id and any already-approved account, then fire `connect`.
provider
  .request({ method: 'eth_chainId' })
  .then((chainId) => {
    provider._connected = true;
    provider._emit('connect', { chainId });
    return provider.request({ method: 'eth_accounts' });
  })
  .catch(() => {});
