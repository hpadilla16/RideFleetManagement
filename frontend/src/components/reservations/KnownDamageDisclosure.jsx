'use client';

/**
 * KnownDamageDisclosure (2026-09-06, audit/baseline closers — damage-baseline
 * NOTES §D4 / Mock 3, staff-side slice). A compact READ-ONLY card in the
 * checkout wizard's inspection step listing the vehicle's ACTIVE
 * (HARD_APPROVED) damage-baseline entries, so the agent points them out
 * during the walkthrough and the customer can never later claim they were
 * new. Renders NOTHING unless entries exist — a vehicle with a clean ledger
 * (or an unreadable one) leaves the wizard byte-identical.
 *
 * Data: the same GET /api/customer-inspections/vehicle/:vehicleId read the
 * vehicle profile's Damage-baseline tab uses ({ active: [...] }).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';

const VIEW_FALLBACKS = { FRONT: 'Front', REAR: 'Rear', LEFT: 'Left', RIGHT: 'Right', INTERIOR: 'Interior' };

function fmtDate(d, lang) {
  try {
    return new Date(d).toLocaleDateString(lang === 'es' ? 'es-PR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export function KnownDamageDisclosure({ vehicleId, token }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const [entries, setEntries] = useState(null); // null = loading/none

  useEffect(() => {
    if (!vehicleId) return;
    let alive = true;
    (async () => {
      try {
        const out = await api(`/api/customer-inspections/vehicle/${vehicleId}`, { bypassCache: true }, token);
        if (alive && Array.isArray(out?.active) && out.active.length) setEntries(out.active);
      } catch { /* unreadable ledger → render nothing (zero behavior change) */ }
    })();
    return () => { alive = false; };
  }, [vehicleId, token]);

  if (!entries?.length) return null;

  return (
    <div
      data-testid="known-damage-card"
      style={{
        background: '#FFFFFF', border: '1px solid #E5E7EB', borderLeft: '4px solid #5b3df5',
        borderRadius: 10, padding: '14px 16px', marginBottom: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>
          {t('damageBaseline.disclosure.title', 'Documented marks on this vehicle')}
        </strong>
        <span data-testid="known-damage-count" style={{ fontSize: 12, color: '#6B7280', fontWeight: 700 }}>
          {t('damageBaseline.disclosure.count', { n: entries.length, defaultValue: `${entries.length} on record` })}
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: '#6B7280', margin: '4px 0 10px' }}>
        {t('damageBaseline.disclosure.sub', 'Point these out to the customer during the walkthrough — they are on record and are NOT the customer’s responsibility.')}
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {entries.map((e) => (
          <li key={e.id} data-testid="known-damage-entry" style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
            <span style={{ flex: 'none', background: 'rgba(91,61,245,.08)', color: '#4c31d9', borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>
              {t(`damageBaseline.views.${e.view}`, VIEW_FALLBACKS[e.view] || e.view)}
            </span>
            <span style={{ color: '#111827' }}>{e.description || t('damageBaseline.disclosure.noDesc', 'Documented mark')}</span>
            <span style={{ color: '#9CA3AF', fontSize: 11.5, marginLeft: 'auto', flex: 'none' }}>
              {e.approvedAt ? `${t('damageBaseline.since', 'on record since')} ${fmtDate(e.approvedAt, lang)}` : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
