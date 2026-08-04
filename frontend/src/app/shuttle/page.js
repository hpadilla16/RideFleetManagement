'use client';

/**
 * Shuttle queue (Valet arc, 2026-08-05). Landing here IS the "View" action:
 * every READY request on screen gets marked VIEWED (stamping who), which is
 * the only thing that clears the global banner. Floor agents close rows as
 * cancelled / no-show; the happy path (customer picked the car up) closes
 * itself at check-out.
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

function ShuttleQueueInner({ me, token, logout }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async ({ markViewed = false } = {}) => {
    try {
      const out = await api('/api/shuttle-requests?status=open', { bypassCache: true }, token);
      const list = Array.isArray(out?.rows) ? out.rows : [];
      setRows(list);
      if (markViewed) {
        const fresh = list.filter((r) => r.status === 'READY');
        // Viewing the queue is what clears the banner — stamp every READY row.
        await Promise.allSettled(fresh.map((r) => api(`/api/shuttle-requests/${r.id}/view`, { method: 'POST', body: '{}' }, token)));
        if (fresh.length) {
          const out2 = await api('/api/shuttle-requests?status=open', { bypassCache: true }, token);
          setRows(Array.isArray(out2?.rows) ? out2.rows : []);
        }
      }
    } catch (e) {
      setMsg(e.message);
      setRows([]);
    }
  }, [token]);

  useEffect(() => { load({ markViewed: true }); }, [load]);

  const act = async (id, action) => {
    try {
      await api(`/api/shuttle-requests/${id}/${action}`, { method: 'POST', body: '{}' }, token);
      setMsg('');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card">
        <div className="row-between">
          <h2 style={{ margin: 0 }}>{t('shuttle.queueTitle', 'Shuttle requests')}</h2>
          <span className="ui-muted">{t('shuttle.queueSubtitle', 'Customers waiting for airport pickup. Check-out closes these automatically.')}</span>
        </div>
        {msg ? <p className="label" style={{ marginTop: 8 }}>{msg}</p> : null}
        {rows == null ? (
          <p className="ui-muted" style={{ marginTop: 12 }}>{t('shuttle.loading', 'Loading…')}</p>
        ) : rows.length === 0 ? (
          <p className="ui-muted" style={{ marginTop: 12 }}>{t('shuttle.empty', 'No one is waiting right now.')}</p>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {rows.map((r) => {
              const waited = minutesSince(r.createdAt);
              return (
                <div key={r.id} className="row" style={{ alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ minWidth: 74, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {waited != null ? t('shuttle.waitingShort', { defaultValue: '{{minutes}} min', minutes: waited }) : '—'}
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
                    {r.callCount > 1 ? (
                      <span className="status-chip warn" style={{ marginLeft: 6 }}>
                        {t('shuttle.calledTimes', { defaultValue: 'called ×{{count}}', count: r.callCount })}
                      </span>
                    ) : null}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" onClick={() => act(r.id, 'cancel')}>{t('shuttle.cancel', 'Customer cancelled')}</button>
                    <button type="button" onClick={() => act(r.id, 'no-show')}>{t('shuttle.noShow', 'No-show')}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </AppShell>
  );
}

export default function ShuttleQueuePage() {
  return (
    <AuthGate>
      {({ me, token, logout }) => <ShuttleQueueInner me={me} token={token} logout={logout} />}
    </AuthGate>
  );
}
