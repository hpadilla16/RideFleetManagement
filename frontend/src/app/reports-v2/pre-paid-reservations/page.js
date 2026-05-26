'use client';

/**
 * Pre-Paid Reservations Report — 2026-05-25
 *
 * Monthly recap of TL franchise pre-paid bookings, grouped by pickup location.
 * Year + Month picker → table grouped by branch with subtotals + grand total.
 * Excel download via the standard reports-v2 export endpoint.
 *
 * Data: GET /api/reports/pre-paid-reservations?year=YYYY&month=MM
 * Excel: GET /api/reports/pre-paid-reservations/excel?year=YYYY&month=MM
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function defaultYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function fmtDateTimeShort(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}`;
}

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Page() {
  return (
    <AuthGate>
      {({ token, me, logout }) => (
        <AppShell me={me} logout={logout}>
          <PrePaidReservationsReport token={token} />
        </AppShell>
      )}
    </AuthGate>
  );
}

function PrePaidReservationsReport({ token }) {
  const initial = defaultYearMonth();
  // Year/month are bound directly to the dropdowns — selecting a new value
  // triggers the useEffect below and refetches immediately. (No draft state
  // + Search button; that pattern hid the data behind an extra click and
  // confused the user.)
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const out = await api(
          `/api/reports/pre-paid-reservations?year=${year}&month=${month}`,
          { bypassCache: true },
          token
        );
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, year, month]);

  const yearOptions = useMemo(() => {
    const current = new Date().getFullYear();
    const out = [];
    for (let y = current + 1; y >= current - 5; y--) out.push(y);
    return out;
  }, []);

  const downloadExcel = () => {
    const url = `/api/reports/pre-paid-reservations/excel?year=${year}&month=${month}`;
    if (typeof window !== 'undefined') {
      window.open(url + (token ? `&token=${encodeURIComponent(token)}` : ''), '_blank');
    }
  };

  return (
    <div style={{ padding: 16, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Link href="/reports-v2" style={{ textDecoration: 'none', color: '#534AB7' }}>← Reports</Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          <span style={{ background: '#1fc7aa', padding: '4px 8px', borderRadius: 6, marginRight: 8 }}>💳</span>
          Pre-Paid Reservations Report
        </h1>
      </div>

      <section className="glass card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontWeight: 600 }}>▽ Search Transactions</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#6b7280' }}>Year</span>
            <select
              value={year}
              onChange={(e) => setYear(parseInt(e.target.value, 10))}
              style={{ padding: '6px 10px', borderRadius: 6, minWidth: 100 }}
            >
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 200 }}>
            <span style={{ color: '#6b7280' }}>Month</span>
            <select
              value={month}
              onChange={(e) => setMonth(parseInt(e.target.value, 10))}
              style={{ padding: '6px 10px', borderRadius: 6, flex: 1 }}
            >
              {MONTH_LABELS.map((label, idx) => (
                <option key={label} value={idx + 1}>{label}</option>
              ))}
            </select>
          </label>
          {loading ? (
            <span style={{ color: '#6b7280', fontSize: 12 }}>Loading…</span>
          ) : null}
        </div>
      </section>

      <section className="glass card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid #e5e7eb'
        }}>
          <strong>⊞ Pre-Paid Reservations</strong>
          <button
            type="button"
            disabled={!data || loading}
            onClick={downloadExcel}
            style={{
              background: '#86efac', color: '#065f46', border: '1px solid #34d399',
              padding: '6px 12px', borderRadius: 6, fontWeight: 600, cursor: (data && !loading) ? 'pointer' : 'not-allowed',
              opacity: (data && !loading) ? 1 : 0.6,
            }}
          >
            📊 Download Excel
          </button>
        </div>

        {error ? (
          <div style={{ padding: 16, color: '#991b1b', background: '#fee2e2' }}>{error}</div>
        ) : loading ? (
          <div style={{ padding: 16, color: '#6b7280' }}>Loading…</div>
        ) : !data || data.count === 0 ? (
          <div style={{ padding: 16, color: '#6b7280' }}>
            No pre-paid reservations for {MONTH_LABELS[month - 1]} {year}.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#e5e7eb', textTransform: 'uppercase', fontSize: 11, color: '#374151' }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Customer</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Booking Date</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Collection</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Return</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Res No</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {(data.groups || []).map((g) => (
                  <>
                    <tr key={`hdr-${g.locationCode}`} style={{ background: '#a7f3d0', color: '#065f46' }}>
                      <td colSpan={6} style={{ padding: '8px 12px', fontWeight: 700 }}>
                        {g.locationName} {g.locationCode !== g.locationName ? `(${g.locationCode})` : ''}
                      </td>
                    </tr>
                    {g.rows.map((r) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '8px 12px' }}>{r.customer}</td>
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>{fmtDateTimeShort(r.bookingDate)}</td>
                        <td style={{ padding: '8px 12px' }}>{fmtDateTimeShort(r.collectionDate)}</td>
                        <td style={{ padding: '8px 12px' }}>{fmtDateTimeShort(r.returnDate)}</td>
                        <td style={{ padding: '8px 12px' }}><code>{r.externalRef}</code></td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{fmtMoney(r.value)}</td>
                      </tr>
                    ))}
                    <tr key={`sub-${g.locationCode}`} style={{ borderTop: '2px solid #d1d5db', background: '#f9fafb' }}>
                      <td colSpan={5} style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>Subtotal</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(g.subtotal)}</td>
                    </tr>
                  </>
                ))}
                <tr style={{ background: '#a7f3d0', color: '#065f46' }}>
                  <td colSpan={5} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>Totals All Branches</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>{fmtMoney(data.grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data ? (
        <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>
          {data.count} reservation{data.count === 1 ? '' : 's'} · {data.range?.label} · {data.currency || 'USD'}
        </div>
      ) : null}
    </div>
  );
}
