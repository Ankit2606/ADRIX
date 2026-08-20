// Locale preference lives in the background so every surface (popup, approval
// window) reads the same value. The catalogs themselves are in lib/i18n.js.

import { local } from './storage.js';
import { LOCALES, DEFAULT_LOCALE } from '../lib/i18n.js';

export { LOCALES, DEFAULT_LOCALE };

export function getLocale() {
  return local.get('locale', DEFAULT_LOCALE);
}

export async function setLocale(code) {
  if (!LOCALES.some((locale) => locale.code === code)) throw new Error('Unsupported language.');
  await local.set({ locale: code });
  return code;
}
