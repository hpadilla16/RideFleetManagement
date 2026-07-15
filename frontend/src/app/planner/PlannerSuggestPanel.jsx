'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { reservationVehicleTypeLabel } from './planner-utils.mjs';

function rangeLabel(reservation) {
  const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const pickup = new Date(reservation.pickupAt).toLocaleString(undefined, options);
  const dropoff = new Date(reservation.returnAt).toLocaleString(undefined, options);
  return `${pickup} → ${dropoff}`;
}

// PL-3 side panel: reservation summary + ranked suggestions from
// POST /api/planner/suggest, each with an "Assign <plate>" action.
export function PlannerSuggestPanel({
  selected,
  vehicles,
  fetchSuggestions,
  onAssign,
  onClose,
  plannerRunning
}) {
  const { t } = useTranslation();
  const reservation = selected?.reservation || null;
  const reservationId = reservation?.id || '';
  const locked = !!selected?.locked;
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [assigningId, setAssigningId] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    setError('');
    if (!reservationId || locked) return undefined;
    setLoading(true);
    fetchSuggestions(reservationId)
      .then((rows) => {
        if (!cancelled) setSuggestions(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || t('planner.suggestError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reservationId, locked, fetchSuggestions, t]);

  if (!reservation) return null;

  const assignedVehicle = reservation.vehicleId
    ? (vehicles || []).find((vehicle) => vehicle.id === reservation.vehicleId) || reservation.vehicle
    : null;
  const balanceValue = reservation.balance ?? reservation.unpaidBalance ?? null;
  const channel = reservation.channel || reservation.bookingSource || reservation.source || '';
  const customerName = `${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim();

  const handleAssign = async (vehicleId) => {
    setAssigningId(vehicleId);
    try {
      const ok = await onAssign(reservation, vehicleId);
      if (ok) onClose();
    } finally {
      setAssigningId('');
    }
  };

  return (
    <aside className="pl-panel">
      <div className="pl-panel-head">
        <h3>{reservation.reservationNumber}{customerName ? ` · ${customerName}` : ''}</h3>
        <button type="button" className="button-subtle" onClick={onClose}>{t('common.close')}</button>
      </div>
      <div className="pl-panel-sub">
        <span className="pl-pill">{String(reservation.status || '').toUpperCase()}</span>
        {' '}· {reservationVehicleTypeLabel(reservation)} · {rangeLabel(reservation)}
        {reservation.pickupLocation?.name ? ` · ${reservation.pickupLocation.name}` : ''}
      </div>
      <div className="pl-prow">
        <span>{t('planner.assignedVehicle')}</span>
        <b>
          {assignedVehicle
            ? `${assignedVehicle.plate || `#${assignedVehicle.internalNumber || ''}`}`
            : `— ${t('planner.noVehicle')}`}
        </b>
      </div>
      {balanceValue != null && balanceValue !== '' ? (
        <div className="pl-prow"><span>{t('planner.balance')}</span><b>${Number(balanceValue).toFixed(2)}</b></div>
      ) : null}
      {channel ? (
        <div className="pl-prow"><span>{t('planner.channel')}</span><b>{channel}</b></div>
      ) : null}
      {selected.overbooked ? (
        <div className="pl-panel-note pl-panel-note-bad">{t('planner.overbookedNote')}</div>
      ) : null}
      {locked ? (
        <div className="pl-panel-note">{t('planner.lockedReservation')}</div>
      ) : (
        <>
          <div className="pl-panel-section">{t('planner.suggestionsTitle')}</div>
          {loading ? <div className="pl-panel-note">{t('planner.suggestionsLoading')}</div> : null}
          {error ? <div className="pl-panel-note pl-panel-note-bad">{error}</div> : null}
          {!loading && !error && !suggestions.length ? (
            <div className="pl-panel-note">{t('planner.suggestionsEmpty')}</div>
          ) : null}
          {suggestions.map((suggestion, index) => (
            <div key={suggestion.vehicleId || index} className="pl-sugg">
              <div className="pl-sugg-head">
                <span>{index + 1}. {suggestion.plate || ''}{suggestion.label ? ` · ${suggestion.label}` : ''}</span>
                <span className="pl-sugg-score">{suggestion.score ?? ''}</span>
              </div>
              {Array.isArray(suggestion.reasons) && suggestion.reasons.length ? (
                <div className="pl-sugg-why">{suggestion.reasons.join(' · ')}</div>
              ) : null}
              <button
                type="button"
                className="pl-btn-primary pl-sugg-assign"
                disabled={!!assigningId || !!plannerRunning}
                onClick={() => handleAssign(suggestion.vehicleId)}
              >
                {assigningId === suggestion.vehicleId
                  ? t('planner.assigning')
                  : t('planner.assignVehicle', { plate: suggestion.plate || suggestion.label || '' })}
              </button>
            </div>
          ))}
        </>
      )}
      <div className="pl-panel-actions">
        <Link href={`/reservations/${reservation.id}`}>
          <button type="button" className="pl-btn-ghost">{t('planner.viewReservation')} ↗</button>
        </Link>
      </div>
    </aside>
  );
}
