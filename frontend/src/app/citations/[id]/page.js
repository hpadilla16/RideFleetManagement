'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

const SOURCE_LABELS = {
  CITATION_PROCESSING_CENTER: 'CPC',
  T2: 'T2',
  OCSO_COMPTROLLER: 'OCSO',
  VIOLATIONINFO: 'Verra',
  MANUAL: 'Manual',
  MAIL_OCR: 'Mailed (OCR)',
};
const STATUS_TONE = {
  NEEDS_REVIEW: 'warn', MATCHED: 'good', BILLED: 'good', PAID: 'good',
  DISPUTED: 'danger', VOID: 'neutral', IMPORTED: 'neutral',
};
const PAY_FALLBACK = [
  [/metropolis/i, 'https://payments.metropolis.io'],
  [/professional parking|paymyviolations|oxygen/i, 'https://paymyviolations.com'],
  [/vanguard|payparkingnotice/i, 'https://payparkingnotice.com'],
  [/citation processing|(^|\W)cpc(\W|$)/i, 'https://www.citationprocessingcenter.com'],
  [/violationinfo|red light|red traffic|automated enforcement|stops|camera|speed/i, 'https://www.violationinfo.com'],
];
function payUrlFor(c) {
  if (c?.externalUrl && /^https?:\/\//i.test(c.externalUrl)) return c.externalUrl;
  const hay = `${c?.agency || ''} ${c?.violationType || ''}`;
  for (const [re, url] of PAY_FALLBACK) { if (re.test(hay)) return url; }
  return null;
}
function money(v) { return `$${Number(Number(v || 0).toFixed(2)).toFixed(2)}`; }
function dateLabel(v) { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(); }
function dateTimeLabel(v) { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(); }

export default function CitationDetailPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const params = useParams();
  const router = useRouter();
  const id = params?.id;
  const [c, setC] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    try { setC(await api(`/api/citations/${id}`, {}, token)); setMsg(''); }
    catch (e) { setMsg(e?.message || 'Failed to load citation'); }
  };
  useEffect(() => { if (id) load(); /* eslint-disable-next-line */ }, [id, token]);

  const viewScan = async () => {
    try {
      const out = await api(`/api/citations/${id}/document`, {}, token);
      if (out?.url) window.open(out.url, '_blank', 'noopener');
      else setMsg('No scanned notice on file for this citation.');
    } catch (e) { setMsg(e?.message || 'Could not open scan'); }
  };

  const review = async (decision) => {
    const note = (decision === 'DISPUTE' || decision === 'VOID')
      ? (window.prompt(`Optional note for ${decision}`, '') || '') : '';
    try {
      setBusy(decision);
      await api(`/api/citations/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, note }) }, token);
      await load();
      setMsg(`Citation → ${decision}`);
    } catch (e) { setMsg(e?.message || 'Review failed'); }
    finally { setBusy(''); }
  };

  if (!c) {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg stack">
          <button type="button" className="button-subtle" onClick={() => router.push('/citations')}>← Back to Citations</button>
          <div className="label">{msg || 'Loading citation…'}</div>
        </section>
      </AppShell>
    );
  }

  const status = String(c.status || '').toUpperCase();
  const payUrl = payUrlFor(c);
  const total = Number(c.amount || 0) + Number(c.fee || 0);
  const renter = c.reservation?.customer ? `${c.reservation.customer.firstName || ''} ${c.reservation.customer.lastName || ''}`.trim() : null;
  const tile = (label, value) => (
    <div className="info-tile"><span className="label">{label}</span><strong>{value}</strong></div>
  );

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <button type="button" className="button-subtle" style={{ alignSelf: 'start' }} onClick={() => router.push('/citations')}>← Back to Citations</button>

        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start' }}>
            <div>
              <span className="eyebrow">Citation</span>
              <h2 className="page-title" style={{ marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{c.citationNo}</h2>
              <p className="ui-muted">{c.agency || '—'}{c.violationType ? ` · ${c.violationType}` : ''}</p>
            </div>
            <span className={`status-chip ${STATUS_TONE[status] || 'neutral'}`}>{status.replace('_', ' ')}</span>
          </div>
        </div>

        {msg ? <div className="label">{msg}</div> : null}

        <div className="app-card-grid compact">
          {tile('Amount', money(c.amount))}
          {tile('Fee', money(c.fee))}
          {tile('Total', money(total))}
          {tile('Source', SOURCE_LABELS[c.source] || c.source)}
          {tile('Citation date', dateLabel(c.issuedAt))}
          {tile('Due date', dateLabel(c.dueAt))}
          {tile('Uploaded', dateLabel(c.createdAt))}
          {tile('Plate', `${c.plateNormalized || c.vehicle?.plate || '—'}${c.plateState ? ` (${c.plateState})` : ''}`)}
          {tile('OCR confidence', c.matchConfidence != null ? `${Number(c.matchConfidence)}%` : '—')}
          {tile('Location', c.location || '—')}
        </div>

        {/* Pay + documents */}
        <div className="glass card section-card">
          <div className="section-title">Pay & documents</div>
          <div className="inline-actions" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {payUrl ? (
              <a href={payUrl} target="_blank" rel="noreferrer" className="button" style={{ background: '#1a7f4b', color: '#fff', padding: '8px 14px', borderRadius: 8, fontWeight: 700, textDecoration: 'none' }}>
                Pay now — {money(total)} ↗
              </a>
            ) : <span className="ui-muted">No payment link captured for this citation.</span>}
            <button type="button" className="button-subtle" onClick={viewScan}>View scanned notice</button>
          </div>
        </div>

        <div className="form-grid-2">
          {/* Vehicle */}
          <div className="glass card section-card">
            <div className="section-title">Vehicle</div>
            {c.vehicle ? (
              <div className="stack" style={{ marginTop: 6 }}>
                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{c.vehicle.plate}</div>
                <div className="ui-muted">{[c.vehicle.year, c.vehicle.make, c.vehicle.model].filter(Boolean).join(' ') || '—'}</div>
                <a href={`/vehicles?focus=${c.vehicle.id}`} style={{ color: '#6e49ff', fontSize: '0.85rem' }}>Open vehicle profile →</a>
              </div>
            ) : (
              <div className="ui-muted" style={{ marginTop: 6 }}>Not matched to a vehicle{c.plateNormalized ? ` (plate ${c.plateNormalized} not in fleet)` : ''}.</div>
            )}
          </div>

          {/* Reservation */}
          <div className="glass card section-card">
            <div className="section-title">Reservation</div>
            {c.reservation ? (
              <div className="stack" style={{ marginTop: 6 }}>
                <div style={{ fontWeight: 700 }}>{c.reservation.reservationNumber}</div>
                {renter ? <div className="ui-muted">{renter}</div> : null}
                <div className="ui-muted" style={{ fontSize: '0.82rem' }}>
                  {dateLabel(c.reservation.pickupAt)} → {dateLabel(c.reservation.returnAt)}
                </div>
                <a href={`/reservations/${c.reservation.id}`} style={{ color: '#6e49ff', fontSize: '0.85rem' }}>Open reservation →</a>
              </div>
            ) : (
              <div className="ui-muted" style={{ marginTop: 6 }}>
                Not matched to a rental{c.issuedAt ? ' (no reservation covered the citation date)' : ' (no citation date to match a rental window)'}.
              </div>
            )}
          </div>
        </div>

        {/* Review */}
        <div className="glass card section-card">
          <div className="section-title">Review</div>
          {c.reviewNotes ? <div className="ui-muted" style={{ margin: '6px 0' }}>Notes: {c.reviewNotes}</div> : null}
          <div className="inline-actions" style={{ gap: 6, marginTop: 8 }}>
            <button type="button" disabled={busy === 'CONFIRM'} onClick={() => review('CONFIRM')}>Confirm match</button>
            <button type="button" className="button-subtle" disabled={busy === 'DISPUTE'} onClick={() => review('DISPUTE')}>Dispute</button>
            <button type="button" className="button-subtle" disabled={busy === 'VOID'} onClick={() => review('VOID')}>Void</button>
          </div>
        </div>

        {/* Timeline */}
        <div className="glass card section-card">
          <div className="section-title">Activity</div>
          <ul className="ui-muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
            <li>Uploaded / imported — {dateTimeLabel(c.createdAt)}</li>
            {c.vehicle ? <li>Matched to vehicle {c.vehicle.plate} by plate</li> : <li>Plate not matched to fleet</li>}
            {c.reservation ? <li>Matched to reservation {c.reservation.reservationNumber}</li> : <li>No rental matched the citation date</li>}
            <li>Current status: {status.replace('_', ' ')}</li>
          </ul>
        </div>
      </section>
    </AppShell>
  );
}
