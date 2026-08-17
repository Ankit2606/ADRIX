export const local = {
  async get(key, fallback) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? fallback;
  },
  set(patch) {
    return chrome.storage.local.set(patch);
  },
  clear() {
    return chrome.storage.local.clear();
  },
};

// chrome.storage.session lives in memory only and is wiped when the browser
// closes. It is where the decrypted keys go: it survives the service worker
// being torn down (which happens every ~30 seconds of idle in MV3) without
// ever touching disk.
export const session = {
  async get(key, fallback) {
    const result = await chrome.storage.session.get(key);
    return result[key] ?? fallback;
  },
  set(patch) {
    return chrome.storage.session.set(patch);
  },
  clear() {
    return chrome.storage.session.clear();
  },
};
