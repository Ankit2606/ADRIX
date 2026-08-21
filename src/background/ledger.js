// Cost basis, disposals, and portfolio history.
//
// The honest framing first, because it determines what this can be used for:
// ADRIX has no indexer and no view of anything that happened before it was
// installed. It can only account for what it witnessed — transactions it sent,
// swaps it routed, transfers its watcher saw arrive, and purchases it handed
// off to an on-ramp. Anything else is a gap, and a gap in a cost basis is not a
// rounding error: it silently turns an unknown acquisition price into zero,
// which reports the entire proceeds as gain.
//
// So every lot carries whether its price is known, disposals against unknown
// basis are reported as unknown rather than as pure profit, and the export says
// how much of the picture is missing. A tax export that quietly guesses is
// worse than no export, because it looks authoritative.

import { local } from './storage.js';

const HISTORY_LIMIT = 2000;
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // hourly is enough to draw a curve
const LEDGER_LIMIT = 2000;

export const LOT_METHODS = [
  { id: 'fifo', label: 'FIFO', hint: 'Oldest holdings sold first. The default in most jurisdictions.' },
  { id: 'lifo', label: 'LIFO', hint: 'Newest first. Not accepted everywhere.' },
  { id: 'hifo', label: 'HIFO', hint: 'Highest cost first, which minimises reported gain.' },
];

const readLedger = () => local.get('ledger', []);
const readHistory = () => local.get('portfolioHistory', []);

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// ---------------------------------------------------------------------------
// Portfolio history
// ---------------------------------------------------------------------------

/**
 * Records one point on the value curve.
 *
 * Throttled to an hour: the portfolio is re-read every fifteen seconds while
 * the popup is open, and storing all of that would fill the quota with a line
 * nobody can see the shape of. Only priced snapshots are kept — a total of
 * "null" is not a data point, it is a missing one, and plotting it as zero
 * would draw a crash that never happened.
 */
export async function recordSnapshot({ address, chainId, totalFiat, currency }) {
  if (totalFiat == null || !Number.isFinite(Number(totalFiat))) return null;
  if (!address) return null;

  const history = await readHistory();
  const key = address.toLowerCase();
  const last = history.find((point) => point.address === key);

  if (last && Date.now() - last.at < SNAPSHOT_INTERVAL_MS) return null;

  const point = {
    at: Date.now(),
    address: key,
    chainId,
    total: Number(totalFiat),
    currency,
  };

  await local.set({ portfolioHistory: [point, ...history].slice(0, HISTORY_LIMIT) });
  return point;
}

/**
 * The value curve for one account.
 *
 * Returns points oldest-first with the gaps left visible. A chart that
 * interpolates across a week the wallet was closed implies data it does not
 * have.
 */
export async function valueHistory({ address, days = 30 }) {
  const history = await readHistory();
  const cutoff = Date.now() - days * 24 * 3600 * 1000;

  const points = history
    .filter((point) => point.address === address?.toLowerCase() && point.at >= cutoff)
    .sort((a, b) => a.at - b.at);

  if (!points.length) return { points: [], days, empty: true };

  const values = points.map((point) => point.total);
  const first = values[0];
  const last = values[values.length - 1];

  return {
    points,
    days,
    empty: false,
    first,
    last,
    min: Math.min(...values),
    max: Math.max(...values),
    change: last - first,
    changePercent: first > 0 ? ((last - first) / first) * 100 : null,
    currency: points[points.length - 1].currency,
    // How much of the window actually has data, so a two-point line is not
    // presented as a month of history.
    coverage: points.length,
    spanHours: Math.round((points[points.length - 1].at - points[0].at) / 3600000),
  };
}

export async function clearHistory() {
  await local.set({ portfolioHistory: [] });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * Adds an acquisition or disposal.
 *
 * `unitPrice` is the fiat price of one unit at the moment it happened, and it
 * has to be captured then — looking it up later gives today's price, which
 * would make every historic disposal wrong in whichever direction the market
 * has since moved.
 */
export async function recordEntry(entry) {
  const ledger = await readLedger();

  const row = {
    id: entry.id ?? `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    at: entry.at ?? Date.now(),
    kind: entry.kind, // 'acquire' | 'dispose'
    symbol: String(entry.symbol ?? '').slice(0, 24),
    address: entry.address ?? null,
    chainId: entry.chainId ?? null,
    quantity: String(entry.quantity ?? '0'),
    unitPrice: entry.unitPrice != null && Number.isFinite(Number(entry.unitPrice)) ? Number(entry.unitPrice) : null,
    currency: entry.currency ?? 'usd',
    source: entry.source ?? 'manual',
    ref: entry.ref ?? null,
    note: String(entry.note ?? '').slice(0, 120),
  };

  if (!row.symbol || num(row.quantity) <= 0) throw new Error('An entry needs an asset and a quantity above zero.');
  if (row.kind !== 'acquire' && row.kind !== 'dispose') throw new Error('An entry must be an acquisition or a disposal.');

  // Same transaction, same direction, same asset — already recorded. Sends are
  // logged both by the send path and by the watcher when they land.
  if (row.ref && ledger.some((item) => item.ref === row.ref && item.kind === row.kind && item.symbol === row.symbol)) {
    return null;
  }

  await local.set({ ledger: [row, ...ledger].slice(0, LEDGER_LIMIT) });
  return row;
}

export async function removeEntry(id) {
  const ledger = await readLedger();
  await local.set({ ledger: ledger.filter((entry) => entry.id !== id) });
  return { ok: true };
}

export async function listEntries() {
  return (await readLedger()).sort((a, b) => b.at - a.at);
}

/**
 * Folds the activity log into ledger entries.
 *
 * Only rows carrying a recorded price become priced entries; the rest are still
 * recorded, marked unpriced, because knowing a disposal happened at an unknown
 * price is materially different from not knowing it happened.
 */
export async function importFromActivity() {
  const activity = await local.get('activity', []);
  const ledger = await readLedger();
  const known = new Set(ledger.map((entry) => `${entry.ref}:${entry.kind}:${entry.symbol}`));

  let added = 0;
  let unpriced = 0;

  for (const tx of activity) {
    if (tx.status !== 'confirmed') continue;

    // A swap's outgoing leg is a disposal; its incoming leg an acquisition.
    if (tx.kind === 'swap' && tx.swapFrom && tx.swapTo) {
      for (const [kind, symbol, quantity, price] of [
        ['dispose', tx.swapFrom, tx.swapFromAmount, tx.swapFromPrice],
        ['acquire', tx.swapTo, tx.swapToAmount, tx.swapToPrice],
      ]) {
        if (!symbol || !quantity) continue;
        const key = `${tx.hash}:${kind}:${symbol}`;
        if (known.has(key)) continue;
        await recordEntry({
          at: tx.submittedAt,
          kind,
          symbol,
          chainId: tx.chainId,
          quantity,
          unitPrice: price ?? null,
          source: 'swap',
          ref: tx.hash,
          note: `Swap ${tx.swapFrom} → ${tx.swapTo}`,
        });
        known.add(key);
        added += 1;
        if (price == null) unpriced += 1;
      }
      continue;
    }

    // A plain outgoing transfer.
    const symbol = tx.tokenSymbol ?? tx.symbol;
    const quantity = tx.tokenAmount ?? (tx.value ? String(Number(tx.value) / 1e18) : null);
    if (!symbol || !quantity || num(quantity) <= 0) continue;

    const key = `${tx.hash}:dispose:${symbol}`;
    if (known.has(key)) continue;

    await recordEntry({
      at: tx.submittedAt,
      kind: 'dispose',
      symbol,
      chainId: tx.chainId,
      quantity,
      unitPrice: tx.unitPrice ?? null,
      source: 'send',
      ref: tx.hash,
      note: tx.note || 'Outgoing transfer',
    });
    known.add(key);
    added += 1;
    if (tx.unitPrice == null) unpriced += 1;
  }

  return { added, unpriced };
}

// ---------------------------------------------------------------------------
// Lot matching
// ---------------------------------------------------------------------------

/**
 * Matches disposals against acquisition lots.
 *
 * Processed strictly in time order so a disposal can only consume lots that
 * existed when it happened — matching against a later acquisition would be
 * both wrong and, in most jurisdictions, not a permitted method.
 */
export function matchLots(entries, method = 'fifo') {
  const chronological = [...entries].sort((a, b) => a.at - b.at);
  const open = new Map(); // symbol -> lots
  const disposals = [];
  const warnings = [];

  const pick = (lots) => {
    if (method === 'lifo') return lots.length - 1;
    if (method === 'hifo') {
      // Highest known price first. Unpriced lots are used last, so a disposal
      // is matched against something with a real basis wherever one exists.
      let best = -1;
      let bestPrice = -Infinity;
      lots.forEach((lot, index) => {
        if (lot.unitPrice == null) return;
        if (lot.unitPrice > bestPrice) {
          bestPrice = lot.unitPrice;
          best = index;
        }
      });
      return best >= 0 ? best : 0;
    }
    return 0; // fifo
  };

  for (const entry of chronological) {
    const lots = open.get(entry.symbol) ?? [];

    if (entry.kind === 'acquire') {
      lots.push({
        at: entry.at,
        remaining: num(entry.quantity),
        unitPrice: entry.unitPrice,
        source: entry.source,
        ref: entry.ref,
      });
      open.set(entry.symbol, lots);
      continue;
    }

    let toDispose = num(entry.quantity);
    const matched = [];

    while (toDispose > 1e-18 && lots.length) {
      const index = pick(lots);
      const lot = lots[index];
      const take = Math.min(lot.remaining, toDispose);

      matched.push({
        acquiredAt: lot.at,
        quantity: take,
        unitPrice: lot.unitPrice,
        costBasis: lot.unitPrice != null ? take * lot.unitPrice : null,
        holdingDays: Math.max(0, Math.round((entry.at - lot.at) / 86400000)),
        source: lot.source,
      });

      lot.remaining -= take;
      toDispose -= take;
      if (lot.remaining <= 1e-18) lots.splice(index, 1);
    }

    // More disposed than the ledger ever saw acquired. Normal for a wallet that
    // held assets before ADRIX, and it must not be silently treated as zero-cost.
    const uncovered = toDispose > 1e-12 ? toDispose : 0;
    if (uncovered > 0) {
      warnings.push(
        `${entry.symbol}: ${uncovered.toPrecision(6)} disposed on ${new Date(entry.at).toISOString().slice(0, 10)} with no recorded acquisition. Its cost basis is unknown, not zero.`
      );
    }

    const knownBasis = matched.every((lot) => lot.costBasis != null) && uncovered === 0;
    const costBasis = knownBasis ? matched.reduce((sum, lot) => sum + lot.costBasis, 0) : null;
    const proceeds = entry.unitPrice != null ? num(entry.quantity) * entry.unitPrice : null;

    disposals.push({
      id: entry.id,
      at: entry.at,
      symbol: entry.symbol,
      chainId: entry.chainId,
      quantity: num(entry.quantity),
      unitPrice: entry.unitPrice,
      proceeds,
      costBasis,
      gain: proceeds != null && costBasis != null ? proceeds - costBasis : null,
      // Split out because most jurisdictions tax the two differently, and the
      // boundary is a per-lot property rather than a per-disposal one.
      shortTerm: matched.filter((lot) => lot.holdingDays < 365).reduce((sum, lot) => sum + lot.quantity, 0),
      longTerm: matched.filter((lot) => lot.holdingDays >= 365).reduce((sum, lot) => sum + lot.quantity, 0),
      uncovered,
      lots: matched,
      source: entry.source,
      ref: entry.ref,
      currency: entry.currency,
      complete: knownBasis && proceeds != null,
    });

    open.set(entry.symbol, lots);
  }

  const holdings = [...open.entries()]
    .map(([symbol, lots]) => ({
      symbol,
      quantity: lots.reduce((sum, lot) => sum + lot.remaining, 0),
      costBasis: lots.every((lot) => lot.unitPrice != null)
        ? lots.reduce((sum, lot) => sum + lot.remaining * lot.unitPrice, 0)
        : null,
      lots: lots.length,
    }))
    .filter((row) => row.quantity > 1e-12);

  return { disposals, holdings, warnings, method };
}

/** The full accounting picture for a period. */
export async function buildDisposalReport({ method = 'fifo', year = null } = {}) {
  const entries = await readLedger();
  const result = matchLots(entries, method);

  const inYear = (at) => year == null || new Date(at).getUTCFullYear() === Number(year);
  const disposals = result.disposals.filter((row) => inYear(row.at));

  const complete = disposals.filter((row) => row.complete);
  const incomplete = disposals.length - complete.length;

  return {
    ...result,
    disposals,
    year,
    summary: {
      count: disposals.length,
      complete: complete.length,
      incomplete,
      proceeds: complete.reduce((sum, row) => sum + row.proceeds, 0),
      costBasis: complete.reduce((sum, row) => sum + row.costBasis, 0),
      gain: complete.reduce((sum, row) => sum + row.gain, 0),
      // Stated prominently: a report covering three quarters of the disposals
      // is not a tax return, and the number of gaps is the first thing an
      // accountant will ask about.
      coverage: disposals.length ? Math.round((complete.length / disposals.length) * 100) : 100,
    },
    years: [...new Set(result.disposals.map((row) => new Date(row.at).getUTCFullYear()))].sort((a, b) => b - a),
  };
}

/** Per-disposal CSV, one row per matched lot so each is independently checkable. */
export function disposalCsv(report) {
  const header = [
    'disposed_at',
    'asset',
    'quantity_disposed',
    'proceeds',
    'currency',
    'acquired_at',
    'quantity_from_lot',
    'lot_unit_price',
    'lot_cost_basis',
    'gain_loss',
    'holding_days',
    'term',
    'basis_known',
    'method',
    'source',
    'tx_ref',
  ];

  const rows = [];
  for (const disposal of report.disposals) {
    if (!disposal.lots.length) {
      rows.push([
        new Date(disposal.at).toISOString(),
        disposal.symbol,
        disposal.quantity,
        disposal.proceeds ?? '',
        disposal.currency,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'no',
        report.method,
        disposal.source,
        disposal.ref ?? '',
      ]);
      continue;
    }

    for (const lot of disposal.lots) {
      const proceedsShare =
        disposal.unitPrice != null ? lot.quantity * disposal.unitPrice : null;
      rows.push([
        new Date(disposal.at).toISOString(),
        disposal.symbol,
        lot.quantity,
        proceedsShare ?? '',
        disposal.currency,
        new Date(lot.acquiredAt).toISOString(),
        lot.quantity,
        lot.unitPrice ?? '',
        lot.costBasis ?? '',
        proceedsShare != null && lot.costBasis != null ? proceedsShare - lot.costBasis : '',
        lot.holdingDays,
        lot.holdingDays >= 365 ? 'long' : 'short',
        lot.costBasis != null ? 'yes' : 'no',
        report.method,
        disposal.source,
        disposal.ref ?? '',
      ]);
    }
  }

  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [header.join(','), ...rows.map((row) => row.map(escape).join(','))].join('\n');
}

export async function clearLedger() {
  await local.set({ ledger: [] });
  return { ok: true };
}
