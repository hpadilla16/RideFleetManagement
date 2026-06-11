'use client';

/**
 * Damage approval queue (2026-06-11, customer-led inspection Fase B).
 * Plan: doc/customer-inspection-plan-2026-06-11.md — mockups 3/4 approved.
 *
 * Left: customer inspections with status SUBMITTED (pending reports).
 * Right: the SAME per-view diagram the customer annotated, with their dots,
 * plus one card per damage report: photo + description + two actions:
 *   • Soft approve — acknowledged only; never hits the vehicle record.
 *   • Hard approve — "Are you sure?" → goes to the vehicle's damage history
 *     (Fase C diagram) until marked FIXED.
 * When the last report is decided the inspection flips to REVIEWED and
 * leaves the queue (and the dashboard count drops).
 */

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { diagramFor, DIAGRAM_VIEWBOX, DIAGRAM_W, DIAGRAM_H, VIEW_LABELS } from '../../../components/vehicleDiagrams';

const VIEWS = ['LEFT', 'RIGHT', 'FRONT', 'REAR', 'INTERIOR'];

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <ReviewInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function ReviewInner({ token, me, logout }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState('');

  const loadList = async () => {
    try {
      const out = await api('/api/customer-inspections?status=SUBMITTED', { bypassCache: true }, token);
      setList(Array.isArray(out) ? out : []);
    } catch (e) {
      setMsg(e?.message || 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id) => {
    setSelectedId(id);
    setDetail(null);
    try {
      setDetail(await api(`/api/customer-inspections/${id}`, { bypassCache: true }, token));
    } catch (e) {
      setMsg(e?.message || 'Failed to load inspection');
    }
  };

  useEffect(() => { loadList(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const onReviewed = async (reviewedAll) => {
    if (reviewedAll) {
      setSelectedId(null);
      setDetail(null);
      await loadList();
    } else if (selectedId) {
      await loadDetail(selectedId);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card">
        <div className="row-between">
          <h2>Inspections to Review</h2>
          <span className="status-chip neutral">{list.length} pending</span>
        </div>
        <p className="ui-muted" style={{ marginTop: 0 }}>
          Damage reports submitted by customers during their checkout inspection. Soft approve =
          acknowledged only. Hard approve = added to the vehicle&apos;s damage history until fixed.
        </p>
        {msg ? <div className="surface-note">{msg}</div> : null}

        {loading ? (
          <div className="surface-note">Loading…</div>
        ) : list.length === 0 ? (
          <div className="surface-note">No customer inspections waiting for review. All clear.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => loadDetail(row.id)}
                  style={{
                    textAlign: 'left', padding: 12, borderRadius: 10,
                    border: row.id === selectedId ? '2px solid #5b3df5' : '1px solid #E5E7EB',
                    background: '#FFFFFF', cursor: 'pointer', color: '#111827',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {row.vehicle?.label || row.vehicle?.internalNumber || 'Vehicle'}
                    {row.vehicle?.plate ? ` · ${row.vehicle.plate}` : ''}
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280' }}>
                    {row.reservationNumber ? `#${row.reservationNumber} · ` : ''}
                    {row.pendingCount} of {row.reportCount} report{row.reportCount === 1 ? '' : 's'} pending
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280' }}>
                    Submitted {row.submittedAt ? new Date(row.submittedAt).toLocaleString() : '—'}
                  </div>
                </button>
              ))}
            </div>

            <div>
              {!selectedId ? (
                <div className="surface-note">Select an inspection to review its damage reports.</div>
              ) : !detail ? (
                <div className="surface-note">Loading inspection…</div>
              ) : (
                <InspectionDetail token={token} detail={detail} onReviewed={onReviewed} />
              )}
            </div>
          </div>
        )}
      </section>
    </AppShell>
  );
}

function InspectionDetail({ token, detail, onReviewed }) {
  const viewsWithReports = VIEWS.filter((v) => detail.reports.some((r) => r.view === v));
  const [view, setView] = useState(viewsWithReports[0] || 'LEFT');
  const [confirming, setConfirming] = useState(null); // reportId pending hard confirm
  const [busy, setBusy] = useState('');

  const act = async (reportId, action) => {
    setBusy(reportId + action);
    try {
      const out = await api(`/api/customer-inspections/${detail.id}/reports/${reportId}/review`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      }, token);
      setConfirming(null);
      await onReviewed(!!out?.inspectionReviewed);
    } catch (e) {
      alert(e?.message || 'Failed to review');
    } finally {
      setBusy('');
    }
  };

  const viewReports = detail.reports.filter((r) => r.view === view);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <strong style={{ fontSize: 15 }}>
          {detail.vehicle?.label} {detail.vehicle?.plate ? `· ${detail.vehicle.plate}` : ''}
          {detail.reservationNumber ? ` · #${detail.reservationNumber}` : ''}
        </strong>
        <span className="ui-muted" style={{ fontSize: 12 }}>
          Reported by customer · {detail.submittedAt ? new Date(detail.submittedAt).toLocaleString() : '—'}
        </span>
      </div>

      <div style={{ display: 'flex', border: '1px solid #E5E7EB', borderRadius: 999, overflow: 'hidden', marginBottom: 10, maxWidth: 480 }}>
        {VIEWS.map((v) => {
          const n = detail.reports.filter((r) => r.view === v).length;
          return (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              style={{
                flex: 1, fontSize: 12, padding: '7px 2px', border: 'none', borderRadius: 0,
                background: v === view ? '#5b3df5' : 'transparent',
                color: v === view ? '#FFFFFF' : '#6B7280', cursor: 'pointer',
              }}
            >
              {VIEW_LABELS[v]}{n ? ` · ${n}` : ''}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(280px, 1.1fr)', gap: 14, alignItems: 'start' }}>
        <svg viewBox={DIAGRAM_VIEWBOX} style={{ width: '100%', background: '#F6F4FE', borderRadius: 14 }} xmlns="http://www.w3.org/2000/svg">
          <g dangerouslySetInnerHTML={{ __html: diagramFor(detail.vehicle?.diagramType, view) }} />
          <g>
            {viewReports.map((r, i) => (
              <g key={r.id}>
                <circle cx={(r.xPct / 100) * DIAGRAM_W} cy={(r.yPct / 100) * DIAGRAM_H} r="10" fill={r.status === 'REPORTED' ? '#E24B4A' : '#1D9E75'} stroke="#FFFFFF" strokeWidth="2" />
                <text x={(r.xPct / 100) * DIAGRAM_W} y={(r.yPct / 100) * DIAGRAM_H + 3.5} textAnchor="middle" fill="#FFFFFF" fontSize="11" fontWeight="600">{i + 1}</text>
              </g>
            ))}
          </g>
        </svg>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {viewReports.length === 0 ? (
            <div className="surface-note">No reports on this view — switch tabs.</div>
          ) : viewReports.map((r, i) => (
            <div key={r.id} style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: 12 }}>
              <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                {r.photoUrl ? (
                  <a href={r.photoUrl} target="_blank" rel="noreferrer">
                    <img src={r.photoUrl} alt="damage" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8 }} />
                  </a>
                ) : (
                  <div style={{ width: 72, height: 72, background: '#F3F4F6', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9CA3AF' }}>No photo</div>
                )}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>#{i + 1} — {r.description || 'No description'}</div>
                  <div style={{ fontSize: 12, color: '#6B7280' }}>{VIEW_LABELS[r.view]} view · {new Date(r.createdAt).toLocaleString()}</div>
                  {r.status !== 'REPORTED' ? (
                    <div style={{ fontSize: 12, fontWeight: 600, color: r.status === 'HARD_APPROVED' ? '#B91C1C' : '#047857', marginTop: 4 }}>
                      {r.status === 'HARD_APPROVED' ? '✓ Hard approved — on the vehicle record' : '✓ Soft approved — acknowledged only'}
                    </div>
                  ) : null}
                </div>
              </div>
              {r.status === 'REPORTED' ? (
                confirming === r.id ? (
                  <div style={{ background: '#FEF3C7', borderRadius: 8, padding: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#92400E', marginBottom: 8 }}>
                      Are you sure? This goes to the vehicle&apos;s permanent damage history (must be fixed to clear).
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" style={{ flex: 1 }} disabled={!!busy} onClick={() => act(r.id, 'hard')}>
                        {busy === r.id + 'hard' ? 'Saving…' : 'Yes, hard approve'}
                      </button>
                      <button type="button" className="btn-ghost" style={{ flex: 1 }} onClick={() => setConfirming(null)}>No</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" style={{ flex: 1 }} disabled={!!busy} onClick={() => act(r.id, 'soft')}>
                      {busy === r.id + 'soft' ? 'Saving…' : 'Soft approve'}
                    </button>
                    <button type="button" style={{ flex: 1 }} disabled={!!busy} onClick={() => setConfirming(r.id)}>
                      Hard approve
                    </button>
                  </div>
                )
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
