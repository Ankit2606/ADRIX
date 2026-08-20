// Localisation scaffolding.
//
// Every user-facing string should come through t('some.key'). Keys are dotted
// and grouped by screen so they stay greppable, and the English catalog is the
// source of truth: a missing key in another locale falls back to English rather
// than rendering blank. Interpolation is {name}-style and escapes nothing,
// because React handles that at the render site.
//
// Adding a locale means adding a catalog below and an entry in LOCALES. No
// other file needs to change.

export const LOCALES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
];

export const DEFAULT_LOCALE = 'en';

const en = {
  // --- common ---
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.back': 'Back',
  'common.done': 'Done',
  'common.remove': 'Remove',
  'common.edit': 'Edit',
  'common.add': 'Add',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.search': 'Search',
  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.somethingWrong': 'Something went wrong',
  'common.unlimited': 'Unlimited',
  'common.none': 'None',

  // --- home ---
  'home.send': 'Send',
  'home.receive': 'Receive',
  'home.swap': 'Swap',
  'home.bridge': 'Bridge',
  'home.buy': 'Buy',
  'home.allAccounts': 'All accounts',
  'home.hideBalance': 'Hide balance',
  'home.showBalance': 'Show balance',
  'home.tabTokens': 'Tokens',
  'home.tabNfts': 'NFTs',
  'home.tabApprovals': 'Approvals',
  'home.tabAccounts': 'Accounts',
  'home.tabActivity': 'Activity',
  'home.searchTokens': 'Search tokens',
  'home.addToken': 'Add token',
  'home.noRate': 'No rate',
  'home.pendingOne': '1 transaction pending',
  'home.pendingMany': '{count} transactions pending',

  // --- backup ---
  'backup.title': 'Back up your recovery phrase',
  'backup.body': 'Without it, losing this browser loses the wallet. It takes a minute.',
  'backup.cta': 'Back up now',
  'backup.dismiss': 'Later',

  // --- onboarding ---
  'onboarding.title': 'Set up your wallet',
  'onboarding.create': 'Create new',
  'onboarding.importPhrase': 'Recovery phrase',
  'onboarding.importKey': 'Private key',
  'onboarding.importKeystore': 'Keystore file',
  'onboarding.password': 'Password',
  'onboarding.confirmPassword': 'Confirm password',
  'onboarding.strength': 'Password strength',
  'onboarding.savePhrase': 'Save your recovery phrase',

  // --- send ---
  'send.title': 'Send',
  'send.from': 'From',
  'send.to': 'To',
  'send.amount': 'Amount',
  'send.asset': 'Asset',
  'send.max': 'Max',
  'send.review': 'Review',
  'send.continue': 'Continue',
  'send.yourAccounts': 'Your accounts',
  'send.contacts': 'Contacts',
  'send.scanQr': 'Scan a QR code',
  'send.recipientPlaceholder': 'Address (0x…) or ENS name',
  'send.available': 'Available {amount} {symbol}',

  // --- settings ---
  'settings.title': 'Settings',
  'settings.security': 'Security',
  'settings.appearance': 'Appearance',
  'settings.currency': 'Currency',
  'settings.language': 'Language',
  'settings.theme': 'Theme',
  'settings.themeDark': 'Dark',
  'settings.themeLight': 'Light',
  'settings.autoLock': 'Auto-lock timer',
  'settings.changePassword': 'Change password',
  'settings.recoveryPhrase': 'Recovery phrase',
  'settings.lockWallet': 'Lock wallet',
  'settings.showTestnets': 'Show test networks',

  // --- networks ---
  'networks.title': 'Networks',
  'networks.add': 'Add a network',
  'networks.edit': 'Edit network',
  'networks.testRpc': 'Test RPC',
  'networks.name': 'Network name',
  'networks.chainId': 'Chain ID',
  'networks.rpc': 'RPC URL',
  'networks.symbol': 'Currency symbol',
  'networks.explorer': 'Block explorer (optional)',

  // --- activity ---
  'activity.empty': 'Nothing here yet. Transactions you send from ADRIX show up on this list.',
  'activity.speedUp': 'Speed up',
  'activity.cancel': 'Cancel',
  'activity.details': 'Details',
  'activity.exportCsv': 'Export CSV',
  'activity.status': 'Status',
  'activity.type': 'Type',
};

// Partial catalogs: anything absent falls through to English.
const es = {
  'common.cancel': 'Cancelar',
  'common.confirm': 'Confirmar',
  'common.save': 'Guardar',
  'common.close': 'Cerrar',
  'common.back': 'Atrás',
  'common.done': 'Hecho',
  'common.remove': 'Eliminar',
  'common.edit': 'Editar',
  'common.add': 'Añadir',
  'common.copy': 'Copiar',
  'common.copied': 'Copiado',
  'common.search': 'Buscar',
  'common.loading': 'Cargando…',
  'common.retry': 'Reintentar',
  'common.unlimited': 'Ilimitado',
  'home.send': 'Enviar',
  'home.receive': 'Recibir',
  'home.swap': 'Intercambiar',
  'home.bridge': 'Puente',
  'home.buy': 'Comprar',
  'home.tabTokens': 'Tokens',
  'home.tabNfts': 'NFTs',
  'home.tabApprovals': 'Permisos',
  'home.tabAccounts': 'Cuentas',
  'home.tabActivity': 'Actividad',
  'home.addToken': 'Añadir token',
  'send.title': 'Enviar',
  'send.from': 'Desde',
  'send.to': 'Para',
  'send.amount': 'Cantidad',
  'send.max': 'Máx',
  'send.review': 'Revisar',
  'send.continue': 'Continuar',
  'settings.title': 'Ajustes',
  'settings.security': 'Seguridad',
  'settings.appearance': 'Apariencia',
  'settings.currency': 'Moneda',
  'settings.language': 'Idioma',
  'settings.theme': 'Tema',
  'settings.themeDark': 'Oscuro',
  'settings.themeLight': 'Claro',
  'settings.lockWallet': 'Bloquear cartera',
  'networks.title': 'Redes',
};

const hi = {
  'common.cancel': 'रद्द करें',
  'common.confirm': 'पुष्टि करें',
  'common.save': 'सहेजें',
  'common.close': 'बंद करें',
  'common.back': 'वापस',
  'common.done': 'हो गया',
  'common.remove': 'हटाएं',
  'common.edit': 'संपादित करें',
  'common.add': 'जोड़ें',
  'common.copy': 'कॉपी करें',
  'common.copied': 'कॉपी हो गया',
  'common.search': 'खोजें',
  'common.loading': 'लोड हो रहा है…',
  'common.retry': 'पुनः प्रयास करें',
  'common.unlimited': 'असीमित',
  'home.send': 'भेजें',
  'home.receive': 'प्राप्त करें',
  'home.swap': 'स्वैप',
  'home.bridge': 'ब्रिज',
  'home.buy': 'खरीदें',
  'home.tabTokens': 'टोकन',
  'home.tabNfts': 'एनएफटी',
  'home.tabApprovals': 'अनुमतियाँ',
  'home.tabAccounts': 'खाते',
  'home.tabActivity': 'गतिविधि',
  'home.addToken': 'टोकन जोड़ें',
  'send.title': 'भेजें',
  'send.from': 'से',
  'send.to': 'को',
  'send.amount': 'राशि',
  'send.max': 'अधिकतम',
  'send.review': 'समीक्षा',
  'send.continue': 'जारी रखें',
  'settings.title': 'सेटिंग्स',
  'settings.security': 'सुरक्षा',
  'settings.appearance': 'दिखावट',
  'settings.currency': 'मुद्रा',
  'settings.language': 'भाषा',
  'settings.theme': 'थीम',
  'settings.themeDark': 'गहरा',
  'settings.themeLight': 'हल्का',
  'settings.lockWallet': 'वॉलेट लॉक करें',
  'networks.title': 'नेटवर्क',
};

const CATALOGS = { en, es, hi };

let activeLocale = DEFAULT_LOCALE;

export function setLocale(code) {
  activeLocale = CATALOGS[code] ? code : DEFAULT_LOCALE;
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

/**
 * Look up a key in the active locale, falling back to English, then to the key
 * itself so an untranslated string is visible in the UI rather than silent.
 */
export function t(key, params) {
  const template = CATALOGS[activeLocale]?.[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** Count-aware helper for the handful of strings that need it. */
export function tCount(singularKey, pluralKey, count) {
  return t(count === 1 ? singularKey : pluralKey, { count });
}

/** Coverage report — used by the settings screen to show translation progress. */
export function localeCoverage(code) {
  const total = Object.keys(en).length;
  const translated = Object.keys(CATALOGS[code] ?? {}).length;
  return { total, translated, percent: Math.round((translated / total) * 100) };
}
