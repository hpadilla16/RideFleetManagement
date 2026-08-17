'use client';

/**
 * Shuttle module (Valet arc; completed 2026-08-07 per Hector's spec).
 *
 * Two views in one page:
 *   - LIVE QUEUE (default): open requests, oldest first. Landing here IS the
 *     "View" action — every READY row gets marked VIEWED, which is the only
 *     thing that clears the global banner. Primary action is COMPLETE (the
 *     driver picked the customer up); cancel / no-show stay secondary.
 *   - HISTORY: every status, date-windowed (defaults to today), per-sede
 *     filter, real pagination, who-viewed / who-closed columns.
 *
 * Rows can change state under the user's feet (check-out auto-completes,
 * another agent acts first): every action just reloads, and an error from a
 * row that moved on shows the message and refreshes rather than breaking.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

function minutesSince(value) {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}
const dt = (v) => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const todayISO = () => new Date().toISOString().slice(0, 10);

const STATUS_TABS = [
  { key: 'open', label: 'Open' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'CANCELLED', label: 'Cancelled' },
  { key: 'NO_SHOW', label: 'No-show' },
  { key: 'all', label: 'All' },
];
const STATUS_TONE = { READY: 'warn', VIEWED: 'neutral', COMPLETED: 'good', CANCELLED: 'neutral', NO_SHOW: 'warn' };
const PAGE_SIZE = 50;

function parseNotices(row) {
  try {
    const list = JSON.parse(row?.delayNoticesJson || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function DelayModal({ row, token, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [eta, setEta] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const notices = parseNotices(row);

  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const out = await api(`/api/shuttle-requests/${row.id}/notify-delay`, {
        method: 'POST',
        body: { reason: reason.trim() || null, etaMinutes: eta ? Number(eta) : null },
      }, token);
      onDone(out);
    } catch (e) {
      // No email on file is a first-class outcome, not a failure: show the
      // phone so the agent can call instead of hitting a dead end.
      const noEmail = e?.body?.code === 'NO_EMAIL' || /no email/i.test(String(e?.message || ''));
      setErr(noEmail
        ? { noEmail: true, phone: e?.body?.customerPhone || row.customerPhone || null }
        : { message: String(e?.message || e) });
    } finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,12,40,.42)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass card-lg" style={{ width: 'min(440px, 94vw)', padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Notify delay — {row.customerName}</h3>
        {notices.length ? (
          <p className="surface-note warn" style={{ fontSize: 12.5 }}>
            Already notified ×{notices.length} — last at {dt(notices[notices.length - 1].at)}
            {notices[notices.length - 1].status === 'FAILED' ? ' (that send FAILED)' : ''}.
          </p>
        ) : null}
        <div className="stack" style={{ gap: 10 }}>
          <div className="stack">
            <label className="label">Reason (optional — goes in the email)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Traffic on the airport loop" disabled={busy} />
          </div>
          <div className="stack">
            <label className="label">Estimated minutes (optional)</label>
            <input type="number" min="1" value={eta} onChange={(e) => setEta(e.target.value)} placeholder="15" disabled={busy} style={{ width: 120 }} />
          </div>
        </div>
        {err ? (
          <p className="surface-note warn" style={{ marginTop: 10 }}>
            {err.noEmail
              ? <>Customer has no email on file. {err.phone ? <>Call them: <strong>{err.phone}</strong></> : 'No phone on file either — open the reservation.'}</>
              : err.message}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="button-subtle" disabled={busy} onClick={onClose}>Close</button>
          <button type="button" disabled={busy} onClick={send}>Send delay notice</button>
        </div>
      </div>
    </div>
  );
}

function ShuttleInner({ me, token, logout }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [tab, setTab] = useState('open');
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [pickupSpots, setPickupSpots] = useState({});
  const [delayRow, setDelayRow] = useState(null);
  const [msg, setMsg] = useState('');

  const isLive = tab === 'open';

  const load = useCallback(async ({ markViewed = false } = {}) => {
    try {
      const params = new URLSearchParams({ status: tab, limit: String(PAGE_SIZE), page: String(page) });
      if (tab !== 'open') { params.set('from', from); params.set('to', to); }
      if (locationId) params.set('locationId', locationId);
      const out = await api(`/api/shuttle-requests?${params}`, { bypassCache: true }, token);
      const list = Array.isArray(out?.rows) ? out.rows : [];
      setRows(list);
      setTotal(Number(out?.total ?? list.length));
      if (markViewed && tab === 'open') {
        const fresh = list.filter((r) => r.status === 'READY');
        // Viewing the queue is what clears the banner — stamp every READY row.
        await Promise.allSettled(fresh.map((r) => api(`/api/shuttle-requests/${r.id}/view`, { method: 'POST', body: '{}' }, token)));
        if (fresh.length) {
          const out2 = await api(`/api/shuttle-requests?${params}`, { bypassCache: true }, token);
          setRows(Array.isArray(out2?.rows) ? out2.rows : []);
        }
      }
    } catch (e) {
      setMsg(e.message);
      setRows([]);
    }
  }, [token, tab, page, from, to, locationId]);

  useEffect(() => { setRows(null); load({ markViewed: true }); }, [load]);
  useEffect(() => { setPage(1); }, [tab, from, to, locationId]);

  useEffect(() => {
    api('/api/locations', {}, token).then((d) => {
      const list = Array.isArray(d) ? d : (d?.locations || []);
      setLocations(list.map((l) => ({ id: l.id, code: l.code, name: l.name })));
      // The shuttle pickup spot per sede — read-only context so the floor sees
      // exactly what the customer waiting at the curb was told.
      Promise.allSettled(list.map(async (l) => {
        const h = await api(`/api/locations/${l.id}/hours`, {}, token);
        return [l.id, String(h?.shuttlePickupInstructions || '').trim()];
      })).then((settled) => {
        const map = {};
        for (const s of settled) if (s.status === 'fulfilled' && s.value[1]) map[s.value[0]] = s.value[1];
        setPickupSpots(map);
      });
    }).catch(() => {});
  }, [token]);

  const act = async (id, action) => {
    try {
      await api(`/api/shuttle-requests/${id}/${action}`, { method: 'POST', body: '{}' }, token);
      setMsg('');
    } catch (e) {
      // The row may have moved on (check-out auto-complete, another agent) —
      // surface it and refresh instead of breaking.
      setMsg(e.message);
    }
    await load();
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card">
        <div className="row-between">
          <h2 style={{ margin: 0 }} data-tour="shuttle-queue">{t('shuttle.queueTitle', 'Shuttle requests')}</h2>
          <span className="ui-muted">{t('shuttle.queueSubtitle', 'Customers waiting for airport pickup. Check-out closes these automatically.')}</span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
          {STATUS_TABS.map((s) => (
            <button key={s.key} type="button" className={tab === s.key ? '' : 'button-subtle'} onClick={() => setTab(s.key)}>{s.label}</button>
          ))}
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ marginLeft: 'auto' }}>
            <option value="">All my locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code || l.name}</option>)}
          </select>
          {!isLive ? (
            <>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="ui-muted">→</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </>
          ) : null}
        </div>

        {msg ? <p className="label" style={{ marginTop: 8 }}>{msg}</p> : null}

        {rows == null ? (
          <p className="ui-muted" style={{ marginTop: 12 }}>{t('shuttle.loading', 'Loading…')}</p>
        ) : rows.length === 0 ? (
          <p className="ui-muted" style={{ marginTop: 12 }}>
            {isLive ? t('shuttle.empty', 'No one is waiting right now.') : 'Nothing in this window.'}
          </p>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {rows.map((r) => {
              const waited = minutesSince(r.createdAt);
              const notices = parseNotices(r);
              const repeat = Number(r.callCount || 1) > 1;
              return (
                <div
                  key={r.id}
                  className="row"
                  style={{
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 4px',
                    borderBottom: '1px solid var(--border-subtle)',
                    ...(repeat && isLive ? { background: 'rgba(240,173,78,0.10)' } : {}),
                  }}
                >
                  <span style={{ minWidth: 96, fontVariantNumeric: 'tabular-nums' }}>
                    {isLive
                      ? <strong>{waited != null ? t('shuttle.waitingShort', { defaultValue: '{{minutes}} min', minutes: waited }) : '—'}</strong>
                      : <span className="ui-muted">{dt(r.createdAt)}</span>}
                  </span>
                  <span style={{ flex: 1 }}>
                    <strong>{r.customerName}</strong>
                    {r.reservation?.reservationNumber ? (
                      <button
                        type="button"
                        className="linklike"
                        style={{ marginLeft: 6, background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--brand-tx)' }}
                        onClick={() => router.push(`/reservations/${r.reservationId}`)}
                      >
                        {r.reservation.reservationNumber}
                      </button>
                    ) : null}
                    <span className="ui-muted">
                      {' · '}{t('shuttle.bannerParty', { defaultValue: '{{count}} pers.', count: r.partySize })}
                      {r.pickupNote ? ` · ${r.pickupNote}` : ''}
                      {r.customerPhone ? ` · ${r.customerPhone}` : ''}
                      {r.location?.name ? ` · ${r.location.name}` : ''}
                    </span>
                    {repeat ? (
                      <span className="status-chip warn" style={{ marginLeft: 6, fontWeight: 800 }}>
                        {t('shuttle.calledTimes', { defaultValue: 'called ×{{count}}', count: r.callCount })}
                      </span>
                    ) : null}
                    {notices.length ? (
                      <span
                        className="status-chip"
                        style={{ marginLeft: 6 }}
                        title={`Last: ${dt(notices[notices.length - 1].at)}${notices[notices.length - 1].reason ? ` — ${notices[notices.length - 1].reason}` : ''}`}
                      >
                        delay notice ×{notices.length}{notices[notices.length - 1].status === 'FAILED' ? ' ⚠' : ''}
                      </span>
                    ) : null}
                    {!isLive ? (
                      <span className="ui-muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                        <span className={`status-chip ${STATUS_TONE[r.status] || ''}`}>{r.status}</span>
                        {r.viewedByName ? ` · viewed by ${r.viewedByName}` : ''}
                        {r.closedAt
                          ? ` · closed ${dt(r.closedAt)}${r.closedByName ? ` by ${r.closedByName}` : ' (auto at check-out)'}${r.closeReason ? ` — ${r.closeReason}` : ''}`
                          : ''}
                      </span>
                    ) : null}
                  </span>
                  {isLive ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" onClick={() => act(r.id, 'complete')} style={{ fontWeight: 800 }}>
                        {t('shuttle.complete', 'Picked up ✓')}
                      </button>
                      <button type="button" className="button-subtle" onClick={() => setDelayRow(r)}>
                        {t('shuttle.notifyDelay', 'Notify delay')}
                      </button>
                      <button type="button" className="button-subtle" onClick={() => act(r.id, 'cancel')}>
                        {t('shuttle.cancel', 'Customer cancelled')}
                      </button>
                      <button type="button" className="button-subtle" onClick={() => act(r.id, 'no-show')}>
                        {t('shuttle.noShow', 'No-show')}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {!isLive && total > PAGE_SIZE ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" className="button-subtle" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>←</button>
            <span className="ui-muted">{page} / {pageCount} · {total} total</span>
            <button type="button" className="button-subtle" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>→</button>
          </div>
        ) : null}

        {Object.keys(pickupSpots).length ? (
          <div className="surface-note" style={{ marginTop: 14, fontSize: 12.5 }}>
            <strong>{t('shuttle.pickupSpots', 'Where customers are told to wait')}:</strong>{' '}
            {locations.filter((l) => pickupSpots[l.id]).map((l) => `${l.code || l.name}: “${pickupSpots[l.id]}”`).join(' · ')}
          </div>
        ) : null}
      </section>

      {delayRow ? (
        <DelayModal
          row={delayRow}
          token={token}
          onClose={() => setDelayRow(null)}
          onDone={() => { setDelayRow(null); setMsg(''); load(); }}
        />
      ) : null}
    </AppShell>
  );
}

export default function ShuttleQueuePage() {
  return (
    <AuthGate>
      {({ me, token, logout }) => <ShuttleInner me={me} token={token} logout={logout} />}
    </AuthGate>
  );
}
