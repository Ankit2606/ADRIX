import { useCallback, useEffect, useState } from 'react';
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
