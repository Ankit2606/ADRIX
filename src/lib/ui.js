import { useCallback, useEffect, useState } from 'react';

export async function call(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (response?.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  return response?.result;
}

/** Re-reads background state whenever the background says something changed. */
export function useBackgroundState(messageType = 'GET_STATE', payload) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setState(await call(messageType, payload));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [messageType, JSON.stringify(payload)]);

  useEffect(() => {
    refresh();
    const listener = (message) => {
      if (message?.type === 'STATE_CHANGED' || message?.type === 'APPROVAL_QUEUE_CHANGED') refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refresh]);

  return { state, error, refresh, setState };
}

export const shorten = (address, lead = 6, tail = 4) =>
  address ? `${address.slice(0, lead)}...${address.slice(-tail)}` : '';

export function trimAmount(value, places = 5) {
  if (value == null) return '--';
  const number = Number(value);
  if (Number.isNaN(number)) return '--';
  if (number === 0) return '0';
  if (number < 0.00001) return '<0.00001';
  return number.toLocaleString(undefined, { maximumFractionDigits: places });
}

export function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Deterministic swatch so accounts are distinguishable at a glance. */
export function accountColor(address) {
  if (!address) return 'hsl(180 60% 45%)';
  const hue = parseInt(address.slice(2, 8), 16) % 360;
  return `hsl(${hue} 62% 52%)`;
}
