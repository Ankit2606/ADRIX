import { useEffect, useState } from 'react';
import { call, formatFiat, formatDateTime, timeAgo, trimAmount, useAsyncAction } from '../../lib/ui.js';
import { BackBar, EmptyState, Skeleton, Sparkline } from '../components/common.jsx';

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
];

/**
 * Portfolio value over time and the disposal report built from it.
 *
 * Both rest on the same constraint: ADRIX only knows what it witnessed. It has
 * no indexer and no view of anything predating its installation, so the value
 * curve starts when the wallet was first opened and the cost basis covers only
 * acquisitions it saw. Every screen here states how much is missing rather than
 * presenting a partial picture as a complete one.
 */
export default function Accounting({ state, go }) {
  const [tab, setTab] = useState('value');

  return (
    <div className="screen">
      <BackBar title="Accounting" onBack={() => go('settings')} />
      <div className="scroll pad stack">
        <div className="tabs" role="tablist" aria-label="Accounting sections">
          <button role="tab" aria-selected={tab === 'value'} onClick={() => setTab('value')}>
            Value
          </button>
          <button role="tab" aria-selected={tab === 'basis'} onClick={() => setTab('basis')}>
            Cost basis
          </button>
          <button role="tab" aria-selected={tab === 'tax'} onClick={() => setTab('tax')}>
            Disposals
          </button>
        </div>

        {tab === 'value' && <ValueChart state={state} />}
        {tab === 'basis' && <CostBasis state={state} />}
        {tab === 'tax' && <Disposals state={state} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ValueChart({ state }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);

  useEffect(() => {
    call('VALUE_HISTORY', { days })
      .then(setData)
      .catch(() => setData(null));
  }, [days, state.selected]);

  if (!data) return <Skeleton height={150} radius={14} />;

  if (data.empty) {
    return (
      <EmptyState
        icon="◵"
        title="No history yet"
        body="ADRIX records the portfolio's value roughly once an hour while it is open. There is no way to reconstruct the past — the curve starts from here and fills in as the wallet is used."
      />
    );
  }

  const currency = data.currency ?? state.currency ?? 'usd';
  const up = data.change >= 0;

  return (
    <>
      <div className="card">
        <div className="between">
          <span className="eyebrow">Portfolio value</span>
          <div className="inline">
            {RANGES.map((range) => (
              <button
                key={range.days}
                className={`chip ${days === range.days ? 'accent' : ''}`}
                aria-pressed={days === range.days}
                onClick={() => setDays(range.days)}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>

        <div className="balance">{formatFiat(data.last, currency)}</div>
        <div className="inline">
          <span className={`price-change ${up ? 'up' : 'down'}`}>
            {up ? '▲' : '▼'} {formatFiat(Math.abs(data.change), currency)}
            {data.changePercent != null ? ` · ${Math.abs(data.changePercent).toFixed(1)}%` : ''}
          </span>
          <span className="small faint">over the recorded period</span>
        </div>

        <div className={up ? 'chart-up' : 'chart-down'}>
          <Sparkline
            values={data.points.map((point) => point.total)}
            height={90}
            ariaLabel={`Portfolio value across ${data.coverage} recorded points`}
          />
        </div>

        <div className="between small faint">
          <span>{formatFiat(data.min, currency)}</span>
          <span>{formatFiat(data.max, currency)}</span>
        </div>

        {/* A two-point line across a nominal month is not a month of history,
            and drawing it as one would imply data that does not exist. */}
        <p className="small faint">
          {data.coverage} snapshot{data.coverage === 1 ? '' : 's'} spanning {Math.round(data.spanHours / 24)} day
          {Math.round(data.spanHours / 24) === 1 ? '' : 's'} of the {days} requested. Gaps are periods the wallet was
          closed, not periods the value was flat.
        </p>
      </div>

      <div className="notice info">
        Values come from the fiat total of this account on the network it was on at the time. Switching networks
        changes what is being measured, so the curve tracks the wallet's view rather than a fixed basket.
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function CostBasis({ state }) {
  const [data, setData] = useState(null);
  const [report, setReport] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: 'acquire', symbol: '', quantity: '', unitPrice: '', at: '' });
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => {
    setData(await call('LIST_LEDGER').catch(() => null));
    setReport(await call('DISPOSAL_REPORT', { method: 'fifo' }).catch(() => null));
  };

  useEffect(() => {
    load();
  }, [state.selected]);

  if (!data) return <Skeleton height={140} radius={14} />;

  return (
    <>
      <div className="card">
        <h2>Holdings with a known basis</h2>
        {!report?.holdings?.length ? (
          <p className="small faint">Nothing with a recorded acquisition yet.</p>
        ) : (
          report.holdings.map((holding) => (
            <div className="kv" key={holding.symbol}>
              <span className="kv-key">
                {holding.symbol}
                <span className="faint"> · {holding.lots} lot{holding.lots === 1 ? '' : 's'}</span>
              </span>
              <span className="kv-value mono">
                {trimAmount(holding.quantity, 6)}
                {holding.costBasis != null
                  ? ` · cost ${formatFiat(holding.costBasis, state.currency)}`
                  : ' · basis unknown'}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="between">
          <h2>Ledger ({data.entries.length})</h2>
          <button
            className="link accent"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await call('IMPORT_LEDGER');
                setError(
                  result.added
                    ? `Imported ${result.added} entries${result.unpriced ? `, ${result.unpriced} without a price` : ''}.`
                    : 'Nothing new to import.'
                );
                await load();
              })
            }
          >
            import from activity
          </button>
        </div>

        <p className="small">
          Swaps are recorded automatically with both legs priced. Transfers are recorded with the price captured at the
          time. Anything acquired before ADRIX, or on another wallet, has to be entered by hand — without it a disposal
          has no basis, and no basis is reported as unknown rather than as pure profit.
        </p>

        {error && <div className="ok">{error}</div>}

        {data.entries.slice(0, 12).map((entry) => (
          <div className="kv" key={entry.id}>
            <span className="kv-key">
              <span style={{ color: entry.kind === 'acquire' ? 'var(--good)' : 'var(--danger)' }}>
                {entry.kind === 'acquire' ? '+' : '−'}
              </span>{' '}
              {trimAmount(entry.quantity, 6)} {entry.symbol}
            </span>
            <span className="kv-value small">
              {entry.unitPrice != null ? formatFiat(entry.unitPrice, entry.currency) : 'no price'} ·{' '}
              {timeAgo(entry.at)}
              <button
                className="link"
                style={{ marginLeft: 6 }}
                onClick={() =>
                  run(async () => {
                    await call('REMOVE_LEDGER_ENTRY', { id: entry.id });
                    await load();
                  })
                }
              >
                remove
              </button>
            </span>
          </div>
        ))}

        {adding ? (
          <div className="site-panel stack-sm">
            <div className="row2">
              <label className="field">
                <span>Direction</span>
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  <option value="acquire">Acquired</option>
                  <option value="dispose">Disposed</option>
                </select>
              </label>
              <label className="field">
                <span>Asset</span>
                <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="ETH" />
              </label>
            </div>
            <div className="row2">
              <label className="field">
                <span>Quantity</span>
                <input
                  className="mono"
                  inputMode="decimal"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value.replace(/[^\d.]/g, '') })}
                />
              </label>
              <label className="field">
                <span>Price each</span>
                <input
                  className="mono"
                  inputMode="decimal"
                  value={form.unitPrice}
                  onChange={(e) => setForm({ ...form, unitPrice: e.target.value.replace(/[^\d.]/g, '') })}
                />
              </label>
            </div>
            <label className="field">
              <span>Date</span>
              <input type="date" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />
            </label>
            <div className="row2">
              <button className="ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || !form.symbol || !form.quantity}
                onClick={() =>
                  run(async () => {
                    await call('ADD_LEDGER_ENTRY', {
                      entry: {
                        kind: form.kind,
                        symbol: form.symbol.toUpperCase(),
                        quantity: form.quantity,
                        unitPrice: form.unitPrice ? Number(form.unitPrice) : null,
                        at: form.at ? Date.parse(form.at) : Date.now(),
                        currency: state.currency,
                        source: 'manual',
                        note: 'Entered by hand',
                      },
                    });
                    setForm({ kind: 'acquire', symbol: '', quantity: '', unitPrice: '', at: '' });
                    setAdding(false);
                    await load();
                  })
                }
              >
                Add entry
              </button>
            </div>
          </div>
        ) : (
          <button className="ghost" onClick={() => setAdding(true)}>
            + Add an entry by hand
          </button>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function Disposals({ state }) {
  const [method, setMethod] = useState('fifo');
  const [year, setYear] = useState('');
  const [report, setReport] = useState(null);
  const [methods, setMethods] = useState([]);
  const { busy, run } = useAsyncAction();

  useEffect(() => {
    call('LIST_LEDGER')
      .then((result) => setMethods(result.methods ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    call('DISPOSAL_REPORT', { method, year: year || null })
      .then(setReport)
      .catch(() => setReport(null));
  }, [method, year, state.selected]);

  const exportCsv = () =>
    run(async () => {
      const { csv } = await call('DISPOSAL_CSV', { method, year: year || null });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `adrix-disposals-${year || 'all'}-${method}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  if (!report) return <Skeleton height={140} radius={14} />;

  const currency = state.currency ?? 'usd';

  return (
    <>
      <div className="card">
        <div className="row2">
          <label className="field">
            <span>Lot method</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {methods.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Year</span>
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">All time</option>
              {(report.years ?? []).map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="small faint">{methods.find((entry) => entry.id === method)?.hint}</p>
      </div>

      {!report.disposals.length ? (
        <EmptyState
          icon="▤"
          title="No disposals recorded"
          body="A disposal is a send or the outgoing leg of a swap. They appear here once the ledger has them."
        />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat">
              <span className="stat-value">{report.summary.count}</span>
              <span className="stat-label">Disposals</span>
            </div>
            <div className="stat">
              <span className="stat-value" style={{ fontSize: 14 }}>
                {formatFiat(report.summary.proceeds, currency)}
              </span>
              <span className="stat-label">Proceeds</span>
            </div>
            <div className="stat">
              <span className="stat-value" style={{ fontSize: 14 }}>
                {formatFiat(report.summary.costBasis, currency)}
              </span>
              <span className="stat-label">Cost basis</span>
            </div>
            <div className="stat">
              <span
                className="stat-value"
                style={{ fontSize: 14, color: report.summary.gain >= 0 ? 'var(--good)' : 'var(--danger)' }}
              >
                {formatFiat(report.summary.gain, currency)}
              </span>
              <span className="stat-label">Gain / loss</span>
            </div>
          </div>

          {/* The single most important number on the screen. A report covering
              part of the disposals is not a tax return, and an accountant's
              first question is how much is missing. */}
          {report.summary.coverage < 100 && (
            <div className="notice danger">
              <b>{report.summary.incomplete} of {report.summary.count} disposals have no usable cost basis.</b>
              <p className="small">
                The totals above cover only the {report.summary.coverage}% that do. The rest are in the export marked{' '}
                <code>basis_known=no</code> — they are not zero-cost, they are unknown, and treating them as zero would
                overstate the gain.
              </p>
            </div>
          )}

          {report.warnings.slice(0, 4).map((warning) => (
            <div className="notice" key={warning}>
              {warning}
            </div>
          ))}

          <div className="card">
            <span className="eyebrow">Disposals</span>
            {report.disposals.slice(0, 15).map((row) => (
              <div className="batch-row" key={row.id}>
                <div className="between">
                  <span className="small">
                    {trimAmount(row.quantity, 6)} {row.symbol}
                  </span>
                  <span className="mono small" style={{ color: row.gain == null ? 'var(--faint)' : row.gain >= 0 ? 'var(--good)' : 'var(--danger)' }}>
                    {row.gain != null ? formatFiat(row.gain, currency) : 'basis unknown'}
                  </span>
                </div>
                <span className="small faint">
                  {formatDateTime(row.at)} · {row.lots.length} lot{row.lots.length === 1 ? '' : 's'}
                  {row.longTerm > 0 && row.shortTerm > 0
                    ? ' · split short and long term'
                    : row.longTerm > 0
                      ? ' · long term'
                      : row.shortTerm > 0
                        ? ' · short term'
                        : ''}
                </span>
                {row.uncovered > 0 && (
                  <span className="small" style={{ color: 'var(--danger)' }}>
                    {trimAmount(row.uncovered, 6)} {row.symbol} had no recorded acquisition.
                  </span>
                )}
              </div>
            ))}
          </div>

          <button className="primary" onClick={exportCsv} disabled={busy}>
            {busy ? 'Building…' : 'Export per-disposal CSV'}
          </button>

          <div className="notice">
            One row per matched lot, so each acquisition and its share of the proceeds can be checked independently.
            This is a record of what this wallet observed — not a complete transaction history, and not tax advice.
          </div>
        </>
      )}
    </>
  );
}
