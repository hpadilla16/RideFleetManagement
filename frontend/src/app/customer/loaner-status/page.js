'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { PortalFrame, portalStyles } from '../_components/PortalFrame';

// Public, token-based customer self-service status portal for a dealership
// loaner. The long-lived portalToken IS the auth (no JWT). Borrower sees their
// loaner + service status and can request an extension or schedule a return.
// Targets /api/public/loaner-portal/:token. Mirrors /customer/sign-loaner.

const fmt = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-');

const STAGES = [
  { key: 'dropped', label: 'Dropped off' },
  { key: 'in_service', label: 'In service' },
  { key: 'ready', label: 'Ready' }
];

export default function LoanerStatusPage() {
  const [token, setToken] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [data, setData] = useState(null);
  const [extendAt, setExtendAt] = useState('');
  const [extendNote, setExtendNote] = useState('');
  const [returnAt, setReturnAt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setToken(p.get('token') || '');
  }, []);

  async function load(tok) {
    try {
      const res = await fetch(`${API_BASE}/api/public/loaner-portal/${encodeURIComponent(tok)}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Unable to load your loaner');
      setData(j);
      setLoaded(true);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  useEffect(() => { if (token) load(token); }, [token]);

  async function post(path, body, successMsg) {
    setBusy(true); setError(''); setOk('');
    try {
      const res = await fetch(`${API_BASE}/api/public/loaner-portal/${encodeURIComponent(token)}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Request failed');
      setOk(j?.message || successMsg);
      await load(token);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  const reservationStatus = String(data?.service?.reservationStatus || '').toUpperCase();
  const completed = !!data?.service?.completedAt;
  const stageIndex = completed ? 2 : (reservationStatus ? 1 : 0);

  const notices = (
    <div style={portalStyles.stack}>
      {!loaded && !error ? <div style={{ ...portalStyles.notice, background: 'rgba(79,70,229,0.08)', color: '#4338ca' }}>Loading your loaner…</div> : null}
      {error ? <div style={{ ...portalStyles.notice, background: 'rgba(220,38,38,0.12)', color: '#991b1b' }}>{error}</div> : null}
      {ok ? <div style={{ ...portalStyles.notice, background: 'rgba(22,163,74,0.12)', color: '#166534' }}>{ok}</div> : null}
    </div>
  );

  return (
    <PortalFrame
      eyebrow="Your Loaner"
      title="Loaner Status & Self-Service"
      subtitle="Track your loaner and your vehicle’s service, request more time, or schedule your return."
    >
      {notices}

      {loaded && data ? (
        <>
          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>{data.vehicle?.label || 'Your loaner'}</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Plate</div>
                <div style={portalStyles.statValue}>{data.vehicle?.plate || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Due back</div>
                <div style={portalStyles.statValue}>{fmt(data.returnAt)}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Repair order</div>
                <div style={portalStyles.statValue}>{data.service?.repairOrderNumber || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Advisor</div>
                <div style={portalStyles.statValue}>{data.service?.advisorName || '-'}</div>
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Your vehicle’s service</h2>
            <div style={{ display: 'flex', gap: 8, margin: '6px 0 12px' }}>
              {STAGES.map((s, i) => (
                <div key={s.key} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{
                    height: 6, borderRadius: 4,
                    background: i <= stageIndex ? '#1fc7aa' : 'rgba(102,79,177,0.18)'
                  }} />
                  <div style={{ fontSize: 11, marginTop: 6, color: i <= stageIndex ? '#166534' : '#746294' }}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{ color: '#55456f', lineHeight: 1.6 }}>
              {completed
                ? 'Your vehicle is ready — please schedule your loaner return below.'
                : `Estimated ready: ${fmt(data.service?.estimatedCompletionAt)}. We’ll text you when it’s done.`}
            </div>
          </div>

          {(data.requestedReturnAt || data.returnScheduledAt) ? (
            <div style={{ ...portalStyles.notice, background: 'rgba(79,70,229,0.08)', color: '#4338ca' }}>
              {data.requestedReturnAt ? <div>Extension requested to <strong>{fmt(data.requestedReturnAt)}</strong> — pending confirmation.</div> : null}
              {data.returnScheduledAt ? <div>Return scheduled for <strong>{fmt(data.returnScheduledAt)}</strong>.</div> : null}
            </div>
          ) : null}

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Need more time?</h2>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={portalStyles.sectionTitle}>New return date &amp; time</label>
                <input type="datetime-local" style={portalStyles.input} value={extendAt} onChange={(e) => setExtendAt(e.target.value)} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>Reason (optional)</label>
                <input style={portalStyles.input} value={extendNote} onChange={(e) => setExtendNote(e.target.value)} placeholder="e.g. parts delayed" />
              </div>
              <div>
                <button style={portalStyles.button} disabled={busy || !extendAt} onClick={() => post('extend', { requestedReturnAt: extendAt, note: extendNote }, 'Extension requested.')}>
                  Request extension
                </button>
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Schedule your return</h2>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={portalStyles.sectionTitle}>Return date &amp; time</label>
                <input type="datetime-local" style={portalStyles.input} value={returnAt} onChange={(e) => setReturnAt(e.target.value)} />
              </div>
              <div>
                <button style={portalStyles.secondaryButton} disabled={busy || !returnAt} onClick={() => post('schedule-return', { returnScheduledAt: returnAt }, 'Return scheduled.')}>
                  Schedule return
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </PortalFrame>
  );
}
