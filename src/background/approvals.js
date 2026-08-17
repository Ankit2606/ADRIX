// Queue of things waiting on the user: connect, sign, transaction, add chain,
// switch chain, watch asset.

import { isDomainFlagged, isAddressFlagged } from './security.js';

const queue = new Map(); // id -> { request, resolve, reject, windowId }
let nextId = 1;
let approvalWindowId = null;

export function pendingCount() {
  return queue.size;
}

export function getRequest(id) {
  return queue.get(id)?.request ?? null;
}

export function listRequests() {
  return [...queue.entries()].map(([id, entry]) => ({ id, ...entry.request }));
}

export async function askUser(request) {
  const id = nextId++;

  request.security = {
    isDomainFlagged: request.origin ? isDomainFlagged(request.origin) : false,
    isToAddressFlagged: request.to ? isAddressFlagged(request.to) : false,
    isSpenderFlagged: request.summary?.spender ? isAddressFlagged(request.summary.spender) : false
  };

  const promise = new Promise((resolve, reject) => {
    queue.set(id, { request, resolve, reject, windowId: null });
  });

  // Reuse an open approval window if one is already up, the way MetaMask
  // stacks multiple pending requests into one window.
  if (approvalWindowId !== null) {
    try {
      await chrome.windows.update(approvalWindowId, { focused: true, drawAttention: true });
      queue.get(id).windowId = approvalWindowId;
      broadcastQueueChange();
      return promise;
    } catch {
      approvalWindowId = null;
    }
  }

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`approval.html?id=${id}`),
    type: 'popup',
    width: 400,
    height: 660,
    focused: true,
  });
  approvalWindowId = created.id;
  queue.get(id).windowId = created.id;

  return promise;
}

export function resolveRequest(id, value) {
  const entry = queue.get(id);
  if (!entry) return;
  queue.delete(id);
  entry.resolve(value);
  closeIfDone(entry.windowId);
}

export function rejectRequest(id, error) {
  const entry = queue.get(id);
  if (!entry) return;
  queue.delete(id);
  entry.reject(error ?? Object.assign(new Error('User rejected the request.'), { code: 4001 }));
  closeIfDone(entry.windowId);
}

function closeIfDone(windowId) {
  const stillWaiting = [...queue.values()].some((entry) => entry.windowId === windowId);
  if (stillWaiting) {
    broadcastQueueChange();
    return;
  }
  if (windowId === approvalWindowId) approvalWindowId = null;
  chrome.windows.remove(windowId).catch(() => {});
}

function broadcastQueueChange() {
  chrome.runtime.sendMessage({ type: 'APPROVAL_QUEUE_CHANGED' }).catch(() => {});
}

// Closing the window without answering rejects everything it was showing. The
// port also keeps the service worker alive while the user is deciding.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'approval') return;
  port.onDisconnect.addListener(() => {
    for (const [id, entry] of [...queue.entries()]) {
      if (entry.windowId === approvalWindowId || entry.windowId === null) {
        queue.delete(id);
        entry.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
      }
    }
    approvalWindowId = null;
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== approvalWindowId) return;
  for (const [id, entry] of [...queue.entries()]) {
    if (entry.windowId !== windowId) continue;
    queue.delete(id);
    entry.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
  }
  approvalWindowId = null;
});
