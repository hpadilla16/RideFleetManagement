'use client';

/**
 * Daily Business Report with Posting (2026-08-17).
 *
 * Rent & Go's accounting department consumed this from their previous
 * software; Hector supplied a 42-page sample ("KENN JULIO 2026") as the spec.
 * Two documents in one page:
 *
 *   1. Per location per day: what closed, what was collected, and a summary
 *      that ties charges + deposits to receipts.
 *   2. The GENERAL LEDGER POSTING — the balanced journal accounting actually
 *      posts. It leads the page, because it is the reason the report exists.
 *
 * ACCOUNT NUMBERS are placeholders until the chart of accounts arrives, and
 * the page says so plainly rather than letting someone post 0001 by mistake.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

const isoDay = (d) => d.toISOString().slice(0, 10);
function defaultRange() {
  const t = new Date();
  const from = new Date(t.getFullYear(), t.getMonth(), 1);
  return { from: isoDay(from), to: isoDay(t) };
}
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '';
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const money0 = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DailyBusinessReportPage() {
  const [token, setToken] = useState('');
  const [range, setRange] = useState(defaultRange());
  const [cutoff, setCutoff] = useState('');
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try { setToken(localStorage.getItem('fleet_jwt') || ''); } catch { setToken(''); }
  }, []);

  useEffect(() => {
    if (!token) return;
    api('/api/locations/selectable', {}, token)
      .then((rows) => setLocations(Array.isArray(rows) ? rows : []))
      .catch(() => setLocations([]));
  }, [token]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams({ from: range.from, to: range.to });
      if (cutoff) q.set('cutoff', cutoff);
      if (locationId) q.set('locationId', locationId);
      setData(await api(`/api/reports/daily-business?${q.toString()}`, {}, token));
    } catch (e) {
      setError(e?.message || 'Could not load the report');
      setData(null);
    }
    setLoading(false);
  }, [token, range.from, range.to, cutoff, locationId]);

  useEffect(() => { load(); }, [load]);

  const journal = data?.journal;
  const exportParams = useMemo(
    () => ({ ...(cutoff ? { cutoff } : {}), ...(locationId ? { locationId } : {}) }),
    [cutoff, locationId],
  );

  const filters = (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <label className="label" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        Cutoff
        <input
          type="date"
          value={cutoff}
          onChange={(e) => setCutoff(e.target.value)}
          title="Only transactions recorded on or before this date are counted. Leave blank to use the end of the range."
        />
      </label>
      <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
        <option value="">All locations</option>
        {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </div>
  );

  return (
    <AuthGate>
      <AppShell>
        <ReportPageLayout
          slug="daily-business"
          title="Daily Business Report with Posting"
          description="Daily detail and summary per location, plus the general-ledger journal for accounting."
          category="Accounting"
          token={token}
          range={range}
          onRangeChange={setRange}
          extraFilters={filters}
          extraExportParams={exportParams}
        >
          {error && <div className="surface-note" role="alert" style={{ color: '#b3261e' }}>{error}</div>}
          {loading && <div className="ui-muted">Loading…</div>}

          {data?.accountsArePlaceholders && (
            <div className="surface-note" style={{ background: '#fbf1e8', borderLeft: '4px solid #9a4a1a' }}>
              <strong>Account numbers are placeholders</strong> (0001, 0002…). They are assigned
              consistently so the same books always number the same way, but they are not your
              chart of accounts yet — send us the real numbers and we map them here.
            </div>
          )}

          {journal && (
            <section className="glass card-lg" style={{ marginBottom: 16 }}>
              <div className="row-between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                <h2 style={{ margin: 0 }}>General Ledger Posting</h2>
                <span
                  style={{
                    fontSize: 12.5, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                    background: journal.balanced ? 'rgba(31,138,95,.12)' : 'rgba(179,38,30,.12)',
                    color: journal.balanced ? '#1f8a5f' : '#b3261e',
                  }}
                >
                  {journal.balanced ? 'Balanced' : 'Out of balance — not postable'}
                </span>
              </div>

              {!journal.balanced && (journal.unbalancedLocations || []).map((u) => (
                <div key={u.locationCode} className="surface-note" style={{ marginTop: 8, color: '#b3261e' }}>
                  {u.locationCode}: {u.note}
                </div>
              ))}

              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Account#</th><th>Description</th>
                    <th style={{ textAlign: 'right' }}>Debit</th>
                    <th style={{ textAlign: 'right' }}>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {(journal.lines || []).map((l, i) => (
                    <tr key={`${l.account}-${l.description}-${i}`}>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{l.account}</td>
                      <td>{l.description}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(l.debit)}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(l.credit)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={2}>Totals</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(journal.totalDebit)}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(journal.totalCredit)}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {(data?.days || []).map((d) => (
            <section key={`${d.locationId}-${d.day}`} className="glass card-lg" style={{ marginBottom: 14 }}>
              <div className="row-between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                <h3 style={{ margin: 0 }}>{d.locationName}</h3>
                <span className="ui-muted" style={{ fontSize: 13 }}>{d.day}</span>
              </div>

              {d.closed.length > 0 && (
                <>
                  <div className="label" style={{ marginTop: 10 }}>Contracts closed</div>
                  <table>
                    <thead>
                      <tr>
                        <th>RA#</th><th>Customer</th><th>Unit</th><th>Days</th>
                        <th style={{ textAlign: 'right' }}>Time</th>
                        <th style={{ textAlign: 'right' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.closed.map((c) => (
                        <tr key={c.number}>
                          <td>{c.number}</td>
                          <td>{c.customer}</td>
                          <td>{c.unit}</td>
                          <td>{c.days ?? ''}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(c.time)}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(c.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {d.payments.length > 0 && (
                <>
                  <div className="label" style={{ marginTop: 12 }}>Payments</div>
                  <table>
                    <thead>
                      <tr>
                        <th>RA#</th><th>Customer</th><th>Method</th><th>Reference</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.payments.map((p, i) => (
                        <tr key={`${p.number}-${i}`}>
                          <td>{p.number}</td>
                          <td>{p.customer}</td>
                          <td>{p.method}</td>
                          <td className="ui-muted">{p.reference}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <div className="label" style={{ marginTop: 12 }}>Summary</div>
              <table>
                <tbody>
                  <tr><td>Net time &amp; mileage</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(d.summary.rentalRevenue.netTimeAndMileage)}</td></tr>
                  {d.summary.misc.lines.map((l) => (
                    <tr key={l.key}><td className="ui-muted" style={{ paddingLeft: 18 }}>{l.label}</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(l.total)}</td></tr>
                  ))}
                  <tr><td>Total misc charges</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(d.summary.misc.total)}</td></tr>
                  {d.summary.taxes.lines.map((l) => (
                    <tr key={l.key}><td className="ui-muted" style={{ paddingLeft: 18 }}>{l.label}</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(l.total)}</td></tr>
                  ))}
                  <tr><td>Total fees &amp; taxes</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(d.summary.taxes.total)}</td></tr>
                  <tr><td>Deposits taken</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(d.summary.depositsTaken)}</td></tr>
                  <tr style={{ fontWeight: 700 }}><td>Total of charges &amp; deposits</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(d.summary.totalChargesAndDeposits)}</td></tr>
                  {d.summary.receipts.map((r) => (
                    <tr key={r.method}><td className="ui-muted" style={{ paddingLeft: 18 }}>{r.method}</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(r.total)}</td></tr>
                  ))}
                  <tr style={{ fontWeight: 700 }}><td>Total receipts</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money0(d.summary.totalReceipts)}</td></tr>
                </tbody>
              </table>
            </section>
          ))}

          {!loading && data && (data.days || []).length === 0 && (
            <div className="ui-muted">No activity in this range.</div>
          )}
        </ReportPageLayout>
      </AppShell>
    </AuthGate>
  );
}
