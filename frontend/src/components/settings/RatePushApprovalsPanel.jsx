'use client';

/**
 * Rate-push approval queue (F4, 2026-07-28). MONEY: every row here is a price
 * change waiting to go out to a franchise's live system.
 *
 * A repricing beyond the safety band is held rather than published, and lands
 * here for sign-off. Approving authorises exactly ONE push of that
 * (class, date, value); the band is bypassed for that cell only and the
 * approval is consumed by the next sweep. Rejecting drops it.
 *
 * The table leads with the MONEY (from -> to and the swing), because that is
 * what the decision turns on — not the class code.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/client';

function money(v) {
  if (v === null || v === undefined) return '—';
  return `$${Number(v).toFixed(2)}`;
}

// A bigger swing deserves a louder colour — this is the whole point of the queue.
function deltaTone(pct) {
  if (pct === null || pct === undefined) return 'neutral';
  const abs = Math.abs(Number(pct));
  if (abs >= 100) return 'danger';
  if (abs >= 60) return 'warn';
  return 'neutral';
}

export function RatePushApprovalsPanel({ token, scopedSettingsPath, onPageMsg }) {
  const scoped = scopedSettingsPath || ((p) => p);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [note, setNote] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api(
        scoped('/api/admin/integrations/economy/rate-push/approvals'),
        { bypassCache: true },
        token,
      );
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch (e) {
      setError(e?.message || 'Could not load the approval queue');
    } finally {
      setLoading(false);
    }
  }, [token, scoped]);

  useEffect(() => { reload(); }, [reload]);

  async function decide(id, decision) {
    setBusyId(id);
    try {
      await api(
        scoped(`/api/admin/integrations/economy/rate-push/approvals/${id}`),
        { method: 'POST', body: JSON.stringify({ decision, note: note || undefined }) },
        token,
      );
      setItems((prev) => prev.filter((r) => r.id !== id));
      onPageMsg?.(decision === 'approve'
        ? 'Approved — it will publish on the next sweep.'
        : 'Rejected — nothing will be published for that cell.');
    } catch (e) {
      onPageMsg?.(e?.message || 'Could not record the decision');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="glass card section-card" style={{ borderLeft: '4px solid #f59e0b' }}>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ margin: 0 }}>Rate changes awaiting approval</h3>
            {items.length > 0 ? <span className="chip chip--warn">{items.length} pending</span> : null}
          </div>
          <p className="ui-muted">
            Price moves larger than the safety band are held instead of published. Approving
            authorises that one date and class at that exact price; the next sweep sends it and the
            approval is used up.
          </p>
        </div>
        <button className="btn ghost" type="button" onClick={reload} disabled={loading} style={{ whiteSpace: 'nowrap' }}>
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      {error ? <div className="chip chip--danger" style={{ marginTop: 10 }}>{error}</div> : null}

      {!loading && items.length === 0 ? (
        <div className="surface-note" style={{ padding: '12px 14px', borderRadius: 14, lineHeight: 1.6, fontSize: 13 }}>
          Nothing waiting. Price changes within the band publish on their own; only larger moves stop here.
        </div>
      ) : null}

      {items.length > 0 ? (
        <>
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={{ fontSize: '0.86rem', minWidth: 720, width: '100%' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Class</th>
                  <th style={{ textAlign: 'right' }}>Franchise now</th>
                  <th style={{ textAlign: 'right' }}>RFM proposes</th>
                  <th style={{ textAlign: 'right' }}>Change</th>
                  <th style={{ textAlign: 'right' }}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{String(r.rateDate).slice(0, 10)}</td>
                    <td>
                      <strong>{r.classCode}</strong>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-2)' }}>
                        {r.externalLocationCode}{r.rateCode ? ` · ${r.rateCode}` : ''}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(r.from)}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{money(r.to)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className={`chip chip--${deltaTone(r.deltaPct)}`}>
                        {r.deltaPct === null ? 'new' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%`}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn" type="button" style={{ fontSize: 12.5 }}
                        disabled={busyId === r.id}
                        onClick={() => decide(r.id, 'approve')}
                      >
                        {busyId === r.id ? '…' : 'Approve'}
                      </button>{' '}
                      <button
                        className="btn ghost" type="button" style={{ fontSize: 12.5 }}
                        disabled={busyId === r.id}
                        onClick={() => decide(r.id, 'reject')}
                      >
                        Reject
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label style={{ display: 'block', fontSize: '0.82rem', marginTop: 12, marginBottom: 4 }}>
            Note (optional — saved with the decision)
          </label>
          <input
            className="input" style={{ width: '100%', maxWidth: 520 }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. approved per August pricing review"
          />
        </>
      ) : null}
    </section>
  );
}

export default RatePushApprovalsPanel;
