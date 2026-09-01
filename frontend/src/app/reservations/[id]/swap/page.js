'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
// The capture card lives in components/ (2026-07-17) so the dealership-loaner
// swap uses the IDENTICAL grid rather than a second implementation.
import { SwapInspectionCard, emptySwapInspection } from '../../../../components/reservations/SwapInspectionCard';
import { SwapPhotoOverridePanel } from '../../../../components/reservations/SwapPhotoOverridePanel';
import {
  PHOTOS_PER_VEHICLE,
  PHOTOS_TOTAL,
  SWAP_BLOCKERS,
  shouldFlagMissing,
  swapPhotoGate,
  swapReadiness
} from '../../../../lib/swap-photos';
import { filterAssignableVehicles } from '../../../../lib/vehicle-assignment';

function vehicleLabel(vehicle) {
  if (!vehicle) return '-';
  return [[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' '), vehicle.plate || vehicle.internalNumber || '']
    .filter(Boolean)
    .join(' • ');
}

function plateLabel(vehicle) {
  return vehicle?.plate || vehicle?.internalNumber || '';
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const { t } = useTranslation();
  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [vehicles, setVehicles] = useState([]);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [note, setNote] = useState('');
  const [currentCheckin, setCurrentCheckin] = useState(emptySwapInspection);
  const [nextCheckout, setNextCheckout] = useState(emptySwapInspection);
  // Counter-UX Item 1 (2026-08-31): replacement picker defaults to AVAILABLE
  // units of the reservation's type; "Show all vehicles" is the escape hatch.
  const [showAllVehicles, setShowAllVehicles] = useState(false);

  const reservationTypeId = row?.vehicleTypeId || row?.vehicleType?.id || null;
  const choices = useMemo(() => {
    const base = (Array.isArray(vehicles) ? vehicles : []).filter((vehicle) => String(vehicle?.id || '') !== String(row?.vehicleId || ''));
    // keepIds: the replacement the agent already picked never vanishes from
    // the list when the filter is toggled back on mid-flow.
    return filterAssignableVehicles(base, {
      vehicleTypeId: reservationTypeId,
      keepIds: [vehicleId],
      showAll: showAllVehicles
    });
  }, [vehicles, row?.vehicleId, reservationTypeId, vehicleId, showAllVehicles]);

  const selectedVehicle = choices.find((vehicle) => String(vehicle.id) === String(vehicleId)) || null;

  // SW-1/2/3: the 16/16 gate. Same rule the backend enforces — the button is a
  // courtesy, swapVehicle refuses without the photos either way.
  const gate = useMemo(
    () => swapPhotoGate(currentCheckin.photos, nextCheckout.photos),
    [currentCheckin.photos, nextCheckout.photos]
  );

  const previousPlate = plateLabel(row?.vehicle);
  const nextPlate = plateLabel(selectedVehicle);

  const photoText = useMemo(() => {
    if (gate.complete) return t('vehicleSwap.readyToSwap');
    if (gate.previousMissing.length && gate.nextMissing.length) {
      return t('vehicleSwap.missingBoth', { count: PHOTOS_TOTAL - gate.total });
    }
    if (gate.previousMissing.length) {
      return t('vehicleSwap.missingOne', {
        count: gate.previousMissing.length,
        vehicle: previousPlate || t('vehicleSwap.currentVehicle'),
        role: t('vehicleSwap.roleIncoming')
      });
    }
    return t('vehicleSwap.missingOne', {
      count: gate.nextMissing.length,
      vehicle: nextPlate || t('vehicleSwap.replacement'),
      role: t('vehicleSwap.roleOutgoing')
    });
  }, [gate, previousPlate, nextPlate, t]);

  // GD-4: the disabled button must always explain ITSELF. `swapReadiness` (pure,
  // unit-tested in lib/swap-photos.test.mjs) owns the rule; this only maps the
  // first blocker to copy.
  const readiness = useMemo(() => {
    const state = swapReadiness({
      vehicleSelected: Boolean(String(vehicleId || '').trim()),
      photosComplete: gate.complete,
      currentOdometer: currentCheckin.odometer,
      nextOdometer: nextCheckout.odometer
    });
    const TEXT = {
      [SWAP_BLOCKERS.VEHICLE]: () => t('vehicleSwap.selectReplacement'),
      [SWAP_BLOCKERS.PHOTOS]: () => photoText,
      [SWAP_BLOCKERS.ODOMETER_CURRENT]: () => t('vehicleSwap.odometerRequiredCurrent'),
      [SWAP_BLOCKERS.ODOMETER_NEXT]: () => t('vehicleSwap.odometerRequiredNext')
    };
    return {
      ready: state.ready,
      blockedOnlyByPhotos: state.blockedOnlyByPhotos,
      text: state.first ? TEXT[state.first]() : t('vehicleSwap.readyToSwap')
    };
  }, [vehicleId, gate.complete, photoText, currentCheckin.odometer, nextCheckout.odometer, t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const reservation = await api(`/api/reservations/${id}`, {}, token);
        if (cancelled) return;
        setRow(reservation);
        const available = await api(`/api/reservations/${id}/available-vehicles`, {}, token);
        if (cancelled) return;
        setVehicles(Array.isArray(available) ? available : []);
      } catch (e) {
        if (!cancelled) setMsg(String(e?.message || t('vehicleSwap.loadError')));
      } finally {
        // Until this resolves the page has no reservation and no vehicle list:
        // rendering it raw shows "-" tiles and an empty picker, which reads as
        // "this reservation has no car" rather than "still loading".
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, token, t]);

  /**
   * @param {string|null} overrideReason - set ONLY by the ADMIN override panel.
   *   It relaxes the PHOTO precondition here exactly as it does on the backend;
   *   every other precondition (vehicle chosen, both odometers) still applies,
   *   because the override is about missing photos, not about skipping the form.
   */
  const submit = async (overrideReason = null) => {
    setAttempted(true);
    // `readiness` is the single source of truth for "can this submit?" — it is
    // what disables the button, so re-deriving the checks here (as this used to)
    // is how the two drifted apart in the first place. The backend re-validates
    // regardless: the UI is a courtesy, swapVehicle is the gate.
    if (!readiness.ready && !(overrideReason && readiness.blockedOnlyByPhotos)) {
      return setMsg(readiness.text);
    }
    const nextVehicleId = String(vehicleId || '').trim();
    try {
      setSaving(true);
      setMsg('');
      await api(`/api/reservations/${id}/swap-vehicle`, {
        method: 'POST',
        body: JSON.stringify({
          vehicleId: nextVehicleId,
          note,
          currentCheckin,
          nextCheckout,
          // Presence = "I am asking". The backend decides whether this user MAY,
          // and refuses a blank reason. Omitted entirely on a normal swap so a
          // complete set never looks like an override.
          ...(overrideReason ? { photoOverride: { reason: overrideReason } } : {})
        })
      }, token);
      router.push(`/reservations/${id}/inspection-report`);
    } catch (e) {
      setMsg(String(e?.message || t('vehicleSwap.swapError')));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg stack">
          <span className="eyebrow">{t('vehicleSwap.eyebrow')}</span>
          <p className="ui-muted" aria-live="polite">{t('vehicleSwap.loading')}</p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">{t('vehicleSwap.eyebrow')}</span>
              <h3 style={{ margin: 0 }}>{row?.reservationNumber || `Reservation ${id}`}</h3>
              <p className="ui-muted">{t('vehicleSwap.subtitle')}</p>
            </div>
            {/* SW-1/2/3 header pill: live n/16 counter. aria-live because this
                is the primary progress signal — a screen-reader user gets no
                other confirmation that a capture landed. */}
            <span className={`status-chip ${gate.complete ? 'good' : 'warn'}`} aria-live="polite">
              {t('vehicleSwap.photoCount', { filled: gate.total, total: PHOTOS_TOTAL })}
            </span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">{t('vehicleSwap.currentVehicle')}</span>
              <strong>{vehicleLabel(row?.vehicle)}</strong>
            </div>
            <div className="info-tile">
              <span className="label">{t('vehicleSwap.replacement')}</span>
              <strong>{selectedVehicle ? vehicleLabel(selectedVehicle) : t('vehicleSwap.selectVehicle')}</strong>
            </div>
            <div className="info-tile">
              <span className="label">{t('vehicleSwap.status')}</span>
              <strong>{row?.status || '-'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">{t('vehicleSwap.customer')}</span>
              <strong>{[row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || '-'}</strong>
            </div>
          </div>
        </div>

        <div className="row-between">
          <h2>{t('vehicleSwap.title')}</h2>
          <button type="button" onClick={() => router.push(`/reservations/${id}`)}>{t('vehicleSwap.back')}</button>
        </div>
        {msg ? <div className="swap-alert" role="alert">{msg}</div> : null}

        {/* SW-1 info strip / SW-3 success strip. */}
        <div className={`surface-note${gate.complete ? ' swap-note-complete' : ''}`}>
          {gate.complete ? t('vehicleSwap.completeStrip') : t('vehicleSwap.whyStrip', { count: PHOTOS_PER_VEHICLE })}
        </div>

        <section className="glass card stack">
          <div className="grid2">
            <div className="stack">
              <label className="label">{t('vehicleSwap.replacementVehicle')}</label>
              <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">{t('vehicleSwap.selectAvailable')}</option>
                {choices.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicleLabel(vehicle)}
                  </option>
                ))}
              </select>
              {/* Counter-UX Item 1: filter note + escape hatch (only when the
                  reservation actually has a vehicle type to filter on). */}
              {reservationTypeId ? (
                <span className="ui-muted" style={{ fontSize: 12 }}>
                  {showAllVehicles
                    ? t('vehicleAssign.showingAll')
                    : (row?.vehicleType?.name
                        ? t('vehicleAssign.filterNoteType', { type: row.vehicleType.name })
                        : t('vehicleAssign.filterNote'))}
                  {' · '}
                  <button
                    type="button"
                    onClick={() => setShowAllVehicles((v) => !v)}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit' }}
                  >
                    {showAllVehicles ? t('vehicleAssign.showMatching') : t('vehicleAssign.showAll')}
                  </button>
                </span>
              ) : null}
            </div>
            <div className="stack">
              <label className="label">{t('vehicleSwap.swapNote')}</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('vehicleSwap.swapNotePlaceholder')} />
            </div>
          </div>
        </section>

        <SwapInspectionCard
          title={t('vehicleSwap.cardIncoming')}
          plate={previousPlate}
          value={currentCheckin}
          onChange={setCurrentCheckin}
          flagMissing={shouldFlagMissing({ attempted, otherComplete: gate.nextComplete })}
          onReadError={() => setMsg(t('vehicleSwap.photoReadError'))}
        />
        <SwapInspectionCard
          title={t('vehicleSwap.cardOutgoing')}
          plate={nextPlate}
          value={nextCheckout}
          onChange={setNextCheckout}
          flagMissing={shouldFlagMissing({ attempted, otherComplete: gate.previousComplete })}
          onReadError={() => setMsg(t('vehicleSwap.photoReadError'))}
        />

        {/* SW-1/2/3 footer: says exactly what is missing and from which car.
            GD-3: the error also renders HERE, next to the button. On a tablet
            the top-of-page `msg` is scrolled off by two long cards, so a failure
            on the Confirm tap was invisible exactly when it mattered. */}
        {msg ? <div className="swap-alert" role="alert">{msg}</div> : null}
        <div className="row-between" style={{ marginBottom: 0 }}>
          <span className={`swap-readiness ${readiness.ready ? 'good' : 'warn'}`} aria-live="polite">
            {readiness.text}
          </span>
          <button className="ios-action-btn" type="button" disabled={saving || !readiness.ready} onClick={() => submit()}>
            {saving ? t('vehicleSwap.swapping') : t('vehicleSwap.confirmSwap')}
          </button>
        </div>

        {/* The emergency exit — ADMIN only, and only while photos are actually
            missing. Rendered BELOW the primary action on purpose: it is a way
            out when capture fails in the field, not a peer of "Confirm Swap".
            `blockedOnlyByPhotos` keeps it honest — an admin who hasn't picked a
            car or entered an odometer is still blocked, because the override
            bypasses the PHOTO rule and nothing else. */}
        <SwapPhotoOverridePanel
          me={me}
          missingCount={PHOTOS_TOTAL - gate.total}
          disabled={!readiness.blockedOnlyByPhotos}
          disabledText={readiness.text}
          busy={saving}
          onOverride={(reason) => submit(reason)}
        />
      </section>
    </AppShell>
  );
}
