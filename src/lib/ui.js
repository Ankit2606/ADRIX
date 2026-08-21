import { useCallback, useEffect, useRef, useState } from 'react';
import { setLocale, getLocale, t } from './i18n.js';

export async function call(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (response?.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  return response?.result;
}

/** Re-reads background state whenever the background says something changed. */
export function useBackgroundState(messageType = 'GET_STATE', payload) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setState(await call(messageType, payload));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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

  return { state, error, loading, refresh, setState };
}

/**
 * Keeps the i18n catalog in sync with the stored locale. Returns t so a
 * component re-renders when the language changes.
 */
export function useTranslation(locale) {
  const [, force] = useState(0);

  useEffect(() => {
    if (locale && locale !== getLocale()) {
      setLocale(locale);
      force((n) => n + 1);
    }
  }, [locale]);

  return { t, locale: getLocale() };
}

/** Wraps an async action with busy/error state — the standard screen pattern. */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async (fn) => {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (err) {
      setError(err.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, setError, run };
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

const CURRENCY_SYMBOLS = {
  usd: '$', eur: '€', inr: '₹', gbp: '£', jpy: '¥', aud: 'A$',
  cad: 'C$', chf: 'CHF ', cny: '¥', krw: '₩', brl: 'R$', zar: 'R',
};

/**
 * Formats a fiat value. A null value means "no price available", which is not
 * the same as zero and must not render as $0.00.
 */
export function formatFiat(value, currency = 'usd', { placeholder = '--' } = {}) {
  if (value == null || Number.isNaN(Number(value))) return placeholder;
  const code = String(currency).toLowerCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code.toUpperCase(),
      maximumFractionDigits: Number(value) < 1 && Number(value) > 0 ? 6 : 2,
    }).format(Number(value));
  } catch {
    const symbol = CURRENCY_SYMBOLS[code] ?? '';
    return `${symbol}${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
}

export const currencySymbol = (code) => CURRENCY_SYMBOLS[String(code).toLowerCase()] ?? '';

/** Wei → gwei for display. Sub-0.01 gwei chains exist, so precision adapts. */
export function formatGwei(wei, places) {
  if (wei == null) return '--';
  try {
    const gwei = Number(BigInt(wei)) / 1e9;
    if (gwei === 0) return '0';
    if (gwei < 0.001) return gwei.toExponential(1);
    return gwei.toLocaleString(undefined, { maximumFractionDigits: places ?? (gwei < 1 ? 4 : gwei < 100 ? 2 : 0) });
  } catch {
    return '--';
  }
}

/** "12s", "~2 min", "~1 hr" — the granularity people actually think in. */
export function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '';
  const value = Number(seconds);
  if (value < 60) return `${Math.max(1, Math.round(value))}s`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  return `${Math.round((value / 3600) * 10) / 10} hr`;
}

/**
 * Mirror of the background's inclusion model, so the review screen can re-time a
 * hand-entered priority fee as it is typed rather than after a round trip. The
 * background copy is the authority; this one only drives the UI.
 */
export function estimateInclusion(priorityWei, feeHistory) {
  if (!feeHistory?.supported) return null;
  const blockTime = feeHistory.blockTimeSeconds ?? 12;

  let priority;
  try {
    priority = BigInt(priorityWei ?? 0);
  } catch {
    return null;
  }

  const { low, market, fast } = feeHistory.rewards ?? {};
  if (!fast || BigInt(fast) === 0n) return null;

  let blocks;
  if (priority >= BigInt(fast)) blocks = 1;
  else if (priority >= BigInt(market)) blocks = 2;
  else if (priority >= BigInt(low)) blocks = 5;
  else blocks = 12;

  const congestion = feeHistory.congestion ?? 0.5;
  if (congestion > 0.9) blocks *= 2;
  else if (congestion < 0.4) blocks = Math.max(1, Math.round(blocks * 0.6));

  return { blocks, seconds: Math.max(1, Math.round(blocks * blockTime)) };
}

export function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatDateTime(timestamp) {
  if (!timestamp) return '--';
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Deterministic swatch so accounts are distinguishable at a glance. */
export function accountColor(address) {
  if (!address) return 'hsl(268 60% 45%)';
  const hue = parseInt(address.slice(2, 8), 16) % 360;
  return `hsl(${hue} 62% 52%)`;
}

// ---------------------------------------------------------------------------
// Jazzicon
//
// A small deterministic identicon: the address seeds a PRNG, which picks a
// background plus a few rotated shapes from a rotated palette. Same address
// always produces the same picture, which is the whole point — a user should
// recognise their account by its avatar without reading the hex.
// ---------------------------------------------------------------------------
const JAZZ_PALETTE = [
  '#01888C', '#FC7500', '#034F5D', '#F73F01', '#FC1960', '#C7144C',
  '#F3C100', '#1598F2', '#2465E1', '#F19E02', '#8B5CF6', '#22D3EE',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns { background, shapes[] } for an address — pure, cacheable, no DOM. */
export function jazziconData(address, shapeCount = 4) {
  const seed = parseInt((address ?? '0x0').slice(2, 10), 16) || 1;
  const random = mulberry32(seed);

  // Rotate the whole palette by a seed-derived amount so neighbouring
  // addresses do not land on near-identical colour sets.
  const shift = random() * 30 - 15;
  const palette = JAZZ_PALETTE.map((hex) => rotateHue(hex, shift));

  const remaining = [...palette];
  const take = () => remaining.splice(Math.floor(remaining.length * random()), 1)[0] ?? palette[0];

  const background = take();
  const shapes = Array.from({ length: shapeCount }, (_, index) => {
    const total = shapeCount - 1;
    const center = 50;
    const firstRotation = random();
    const angle = Math.PI * 2 * firstRotation;
    const velocity = (25 * index) / shapeCount + 25 * random();
    return {
      color: take(),
      translateX: Math.cos(angle) * velocity,
      translateY: Math.sin(angle) * velocity,
      rotate: firstRotation * 360 + (index / total) * 360,
      center,
    };
  });

  return { background, shapes };
}

function rotateHue(hex, degrees) {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;

  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return hex;

  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  let hue;
  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;

  hue = (hue * 60 + degrees + 360) % 360;
  return `hsl(${hue.toFixed(1)} ${(saturation * 100).toFixed(1)}% ${(lightness * 100).toFixed(1)}%)`;
}

/** Debounces a fast-changing value — used for live address validation. */
export function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Polling that pauses when the page is hidden and backs off when it fails.
 *
 * A fixed setInterval keeps hammering the RPC while the popup sits behind
 * another window, and on a failing endpoint it retries at full rate forever.
 * Returns the refresh state the UI needs to show what is happening, because a
 * balance that silently stops updating is worse than one that says so.
 */
export function useAutoRefresh(fn, { interval = 15000, enabled = true, deps = [] } = {}) {
  const [refreshing, setRefreshing] = useState(false);
  const [lastAt, setLastAt] = useState(null);
  const [failures, setFailures] = useState(0);
  const busyRef = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(async ({ manual = false } = {}) => {
    // A manual tap while a poll is in flight should not stack a second read.
    if (busyRef.current) return;
    busyRef.current = true;
    if (manual) setRefreshing(true);
    try {
      await fnRef.current();
      setLastAt(Date.now());
      setFailures(0);
    } catch {
      setFailures((count) => count + 1);
    } finally {
      busyRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;

    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      // Exponential backoff to a 2-minute ceiling. A dead endpoint should cost
      // one request every couple of minutes, not four a minute.
      const delay = failures ? Math.min(120_000, interval * 2 ** Math.min(failures, 3)) : interval;
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, delay);
    };

    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
      } else {
        // Coming back to a stale number is the moment a refresh is most wanted.
        refresh();
        schedule();
      }
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, interval, failures, refresh, ...deps]);

  // Memoised: this identity is a dependency of the pull-to-refresh listener
  // effect, and a fresh arrow each render would rebind touch handlers
  // constantly.
  const manualRefresh = useCallback(() => refresh({ manual: true }), [refresh]);

  return { refresh: manualRefresh, refreshing, lastAt, failures };
}

/**
 * Pull-to-refresh for a scroll container.
 *
 * Only arms at the very top of the scroll area, so a normal upward flick in the
 * middle of a long list is never mistaken for a refresh gesture.
 */
export function usePullToRefresh(ref, onRefresh, { threshold = 64, enabled = true } = {}) {
  const [pull, setPull] = useState(0);
  const [armed, setArmed] = useState(false);
  const startRef = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return undefined;

    const onStart = (event) => {
      if (node.scrollTop > 0) return;
      startRef.current = event.touches[0].clientY;
    };

    const onMove = (event) => {
      if (startRef.current == null) return;
      const delta = event.touches[0].clientY - startRef.current;
      if (delta <= 0) {
        startRef.current = null;
        setPull(0);
        setArmed(false);
        return;
      }
      // Resistance, so the sheet does not track the finger one-to-one and the
      // gesture feels like it is pulling against something.
      const eased = Math.min(threshold * 1.5, delta * 0.5);
      setPull(eased);
      setArmed(eased >= threshold * 0.8);
      if (event.cancelable) event.preventDefault();
    };

    const onEnd = () => {
      if (armed) onRefresh();
      startRef.current = null;
      setPull(0);
      setArmed(false);
    };

    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd);
    return () => {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
    };
  }, [ref, onRefresh, threshold, enabled, armed]);

  return { pull, armed };
}

/** True while the browser reports the extension page is offline. */
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export { t };
