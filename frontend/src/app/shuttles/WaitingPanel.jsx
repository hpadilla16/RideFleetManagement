'use client';

/**
 * Waiting-customer side panel + the shared assignment picker (Phase 3 STAFF
 * UI, approved mockup Screen 10, 2026-08-25).
 *
 * Rows render the monitor's `waitingCustomers[]` — every open request at the
 * caller's locations, oldest first. Customers actively sharing their
 * location get the 📍 chip (and the map pin, drawn by the page); customers
 * NOT sharing stay in the list without a pin — sharing is never required to
 * be picked up (mockup honesty rule).
 *
 * AssignControl is the compact vehicle picker used here AND on the queue
 * page (/shuttle): POST /api/shuttle-requests/:id/assign {vehicleId} /
 * DELETE …/assign. ON_DEMAND locations only — loop mode has no dispatch, so
 * the control renders nothing there.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';
import {
  initialsOf, shareAgeText, normalizeAssignedVehicle, vehicleOptionsAt, modeAt,
} from '../../lib/shuttle-staff';

const CUST_BLUE = '#1d6ef2'; // mockup .cdot — customer identity color

export function AssignControl({ requestId, assignedVehicle, vehicles = [], mode, token, onChanged }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (mode !== 'ON_DEMAND') return null; // loop mode: no dispatch to pick
  const assigned = normalizeAssignedVehicle(assignedVehicle);

  const assign = async (vehicleId) => {
    if (!vehicleId) return;
    setBusy(true); setErr('');
    try {
      await api(`/api/shuttle-requests/${requestId}/assign`, { method: 'POST', body: { vehicleId } }, token);
      onChanged?.();
    } catch (e) {
      // The row may have closed under us (check-out, another agent) — show
      // the message; the next poll/refresh redraws the truth.
      setErr(e?.message || 'Could not assign');
      onChanged?.();
    } finally { setBusy(false); }
  };

  const unassign = async () => {
    setBusy(true); setErr('');
    try {
      await api(`/api/shuttle-requests/${requestId}/assign`, { method: 'DELETE' }, token);
      onChanged?.();
    } catch (e) {
      setErr(e?.message || 'Could not unassign');
      onChanged?.();
    } finally { setBusy(false); }
  };

  return (
    <span
      data-testid="assign-control"
      onClick={(e) => e.stopPropagation()}
      style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
    >
      {assigned ? (
        <span className="status-chip good" data-testid="assigned-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          🚐 {[assigned.label, assigned.plate].filter(Boolean).join(' · ') || assigned.vehicleId}
          <button
            type="button"
            aria-label={t('shuttleMonitor.unassign', 'Unassign shuttle')}
            title={t('shuttleMonitor.unassign', 'Unassign shuttle')}
            disabled={busy}
            onClick={unassign}
            style={{ background: 'none', border: 'none', boxShadow: 'none', padding: 0, cursor: 'pointer', fontSize: 12, lineHeight: 1, color: 'inherit' }}
          >
            ×
          </button>
        </span>
      ) : vehicles.length ? (
        <select
          aria-label={t('shuttleMonitor.assignLabel', 'Assign a shuttle')}
          disabled={busy}
          value=""
          onChange={(e) => assign(e.target.value)}
          style={{ fontSize: 12, padding: '3px 6px' }}
        >
          <option value="">{t('shuttleMonitor.assignPlaceholder', 'Assign shuttle…')}</option>
          {vehicles.map((v) => (
            <option key={v.vehicleId} value={v.vehicleId}>
              {[v.label, v.plate].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
      ) : null}
      {err ? <span style={{ fontSize: 11, color: 'var(--warn-tx, #8a5606)' }}>{err}</span> : null}
    </span>
  );
}

export function WaitingPanel({
  customers = [], shuttles = [], token, selectedRequestId,
  onFocus, onViewRequests, onChanged,
}) {
  const { t } = useTranslation();

  const partyLine = (c) => {
    const bits = [t('shuttleMonitor.paxCount', { defaultValue: '{{count}} pax', count: c.partySize || 1 })];
    if (Number.isFinite(Number(c.bags)) && c.bags !== null) {
      bits.push(t('shuttleMonitor.bagsCount', { defaultValue: '{{count}} bags', count: Number(c.bags) }));
    }
    return bits.join(' · ');
  };

  return (
    <div data-testid="waiting-panel">
      <span className="label">
        {t('shuttleMonitor.waitingTitle', { defaultValue: 'Waiting customers · {{count}}', count: customers.length })}
      </span>
      {customers.length === 0 ? (
        <p className="ui-muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t('shuttleMonitor.waitingEmpty', 'No one is waiting right now.')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {customers.map((c) => {
            const sharing = c.sharing === true;
            const selected = selectedRequestId === c.requestId;
            const clickable = sharing && !!onFocus;
            const age = shareAgeText(c.ageSeconds);
            return (
              <div
                key={c.requestId}
                data-testid="waiting-row"
                className="glass card"
                onClick={clickable ? () => onFocus(c) : undefined}
                style={{
                  padding: 10,
                  cursor: clickable ? 'pointer' : 'default',
                  border: selected ? `1px solid ${CUST_BLUE}` : undefined,
                }}
              >
                <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 24, height: 24, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                      background: sharing ? CUST_BLUE : 'var(--n-500, #8a819f)',
                      color: '#fff', fontSize: 9, fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    {initialsOf(c.name)}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3 }}>{c.name}</div>
                    <div className="ui-muted" style={{ fontSize: 12 }}>{partyLine(c)}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                  {sharing ? (
                    <span className="status-chip good" data-testid="sharing-chip">
                      {age
                        ? t('shuttleMonitor.sharingAge', { defaultValue: '📍 sharing · {{age}}', age })
                        : t('shuttleMonitor.sharingNow', '📍 sharing')}
                    </span>
                  ) : (
                    <span className="status-chip">{t('shuttleMonitor.notSharing', 'not sharing')}</span>
                  )}
                  {c.waitingMinutes != null ? (
                    <span className={`status-chip ${Number(c.waitingMinutes) >= 10 ? 'warn' : ''}`}>
                      {t('shuttleMonitor.waitingFor', { defaultValue: 'waiting {{count}} min', count: c.waitingMinutes })}
                    </span>
                  ) : null}
                  <AssignControl
                    requestId={c.requestId}
                    assignedVehicle={c.assignedVehicle}
                    vehicles={vehicleOptionsAt(shuttles, c.locationId)}
                    mode={modeAt(shuttles, c.locationId)}
                    token={token}
                    onChanged={onChanged}
                  />
                </div>
                {onViewRequests ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      type="button"
                      style={{ fontSize: 12 }}
                      onClick={(e) => { e.stopPropagation(); onViewRequests(c); }}
                    >
                      {t('shuttleMonitor.viewRequests', 'View requests')}
                    </button>
                    {clickable ? (
                      <button
                        type="button"
                        className="button-subtle"
                        style={{ fontSize: 12 }}
                        onClick={(e) => { e.stopPropagation(); onFocus(c); }}
                      >
                        {t('shuttleMonitor.alertShowOnMap', 'Show on map')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          <p className="ui-muted" style={{ fontSize: 11, lineHeight: 1.55, margin: 0 }}>
            {t('shuttleMonitor.waitingFootnote', 'Customers not sharing stay in the list without a pin — sharing is never required to be picked up.')}
          </p>
        </div>
      )}
    </div>
  );
}
