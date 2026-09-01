'use client';

/**
 * Maintenance snooze re-prompt (Feature A, 2026-09-01) — the check-OUT half
 * of the snooze contract. A snooze taken in the check-in wizard re-surfaces
 * at the vehicle's NEXT rental event, whichever comes first; this component
 * is that event's reader for the check-out wizard:
 *
 *   on mount → POST /maintenance/vehicles/:id/snooze/consume {event:'CHECKOUT'}
 *   marker present → cleared server-side, then re-evaluated FRESH against the
 *   vehicle's current odometer (GET schedules). Still due → warn banner with
 *   the concrete gaps + who snoozed it and when. Nothing due any more → quiet.
 *
 * Informational by design: check-out has no maintenance gate (the mockup pins
 * the gate to check-in Step 3 only) — the agent sees the reminder while the
 * car is still on the lot and can walk it to the Maintenance hub. Fail-soft:
 * any fetch error renders nothing; a maintenance read must never stand
 * between an agent and a check-out.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';
import { buildDueItems } from '../../lib/maintenance-eval';

export function MaintenanceSnoozeReprompt({ vehicleId, token }) {
  const { t } = useTranslation();
  const [stamp, setStamp] = useState(null);
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!vehicleId) return;
    let on = true;
    (async () => {
      try {
        const res = await api(`/api/maintenance/vehicles/${vehicleId}/snooze/consume`, {
          method: 'POST',
          body: JSON.stringify({ event: 'CHECKOUT' }),
        }, token);
        if (!on || !res?.snoozed) return;
        const sched = await api(`/api/maintenance/vehicles/${vehicleId}/schedules`, { bypassCache: true }, token);
        if (!on) return;
        const due = buildDueItems(sched?.schedules || [], sched?.vehicleMileage ?? null, Date.now());
        if (!due.length) return; // condition cleared itself — stay quiet
        setStamp(res.stamp || null);
        setItems(due);
      } catch {
        // fail-soft — never block a check-out on a maintenance read
      }
    })();
    return () => { on = false; };
  }, [vehicleId, token]);

  if (!items.length) return null;

  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const when = stamp?.at
    ? new Date(stamp.at).toLocaleDateString([], { month: 'short', day: 'numeric' })
    : '—';

  return (
    <div role="alert" data-testid="maint-reprompt" style={{
      margin: '0 0 16px', border: '0.5px solid #F59E0B', borderRadius: 8,
      background: '#FEF3C7', padding: '12px 14px',
    }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: '#92400E' }}>
        🔧 {t('maintCheckin.reprompt.title')}
      </div>
      <div style={{ fontSize: 11.5, color: '#92400E', opacity: 0.9, marginTop: 2 }}>
        {t('maintCheckin.reprompt.body', {
          who: stamp?.byName || '—',
          res: stamp?.reservationNumber || '—',
          when,
        })}{stamp?.note ? ` — “${stamp.note}”` : ''}
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map((item) => (
          <div key={item.serviceType} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, color: '#78350F' }}>
            <strong>{t(`maintCheckin.svc.${item.serviceType}`, { defaultValue: item.serviceType })}</strong>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {item.basis === 'MILES'
                ? (item.state === 'OVERDUE'
                  ? t('maintCheckin.chip.overdueMi', { n: fmt(item.gapMiles) })
                  : t('maintCheckin.chip.dueSoonMi', { n: fmt(item.gapMiles) }))
                : (item.state === 'OVERDUE'
                  ? t('maintCheckin.chip.overdueDays', { n: fmt(item.gapDays) })
                  : t('maintCheckin.chip.dueSoonDays', { n: fmt(item.gapDays) }))}
            </span>
          </div>
        ))}
      </div>
      <a href="/maintenance" style={{ display: 'inline-block', marginTop: 8, fontSize: 12, fontWeight: 700, color: '#92400E', textDecoration: 'underline' }}>
        {t('maintCheckin.reprompt.open')}
      </a>
    </div>
  );
}

export default MaintenanceSnoozeReprompt;
