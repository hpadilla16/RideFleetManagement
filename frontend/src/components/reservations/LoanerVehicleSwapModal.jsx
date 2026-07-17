'use client';

/**
 * Loaner vehicle swap — now with the SAME 16-photo gate as the main swap page
 * (Hector, 2026-07-17).
 *
 * BEFORE: the "Swap Vehicle" button in the Loaner Operations panel posted
 * `{vehicleId, note}` and moved a customer onto a different car with ZERO photo
 * evidence. It is a live, UI-driven, mid-rental swap — the same event the main
 * swap page hard-blocks — so the "no photos, no swap" rule simply did not hold.
 * (QA found this; a gate on one of two live paths is not a gate.)
 *
 * AFTER: the button opens this modal, which reuses `SwapInspectionCard` (the
 * identical capture grid, compression, and slots) and `SwapPhotoOverridePanel`
 * (the identical ADMIN emergency exit). Nothing about the gate is reimplemented
 * here — the backend re-validates everything regardless.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';
import { SwapInspectionCard, emptySwapInspection } from './SwapInspectionCard';
import { SwapPhotoOverridePanel } from './SwapPhotoOverridePanel';
import {
  PHOTOS_PER_VEHICLE,
  PHOTOS_TOTAL,
  SWAP_BLOCKERS,
  shouldFlagMissing,
  swapPhotoGate,
  swapReadiness
} from '../../lib/swap-photos';

const label = (vehicle) => {
  if (!vehicle) return '';
  return [[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' '), vehicle.plate || vehicle.internalNumber || '']
    .filter(Boolean)
    .join(' • ');
};

export function LoanerVehicleSwapModal({ open, onClose, onDone, token, me, reservation, vehicleId, vehicles = [] }) {
  const { t } = useTranslation();
  const [currentCheckin, setCurrentCheckin] = useState(emptySwapInspection);
  const [nextCheckout, setNextCheckout] = useState(emptySwapInspection);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // GD NIT-3 (2026-07-17): closing mid-capture silently threw away up to 16
  // photos of real field labor on a stray tap. When any photo has been captured,
  // Cancel first shows an inline "Are you sure?" strip — the SAME confirm
  // pattern the inspections review flow uses (inspections/review/page.js: an
  // inline warning strip with Yes/No, not a new dialog system).
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const nextVehicle = (Array.isArray(vehicles) ? vehicles : []).find((v) => String(v.id) === String(vehicleId)) || null;

  const gate = useMemo(
    () => swapPhotoGate(currentCheckin.photos, nextCheckout.photos),
    [currentCheckin.photos, nextCheckout.photos]
  );

  const readiness = useMemo(() => {
    const state = swapReadiness({
      vehicleSelected: Boolean(String(vehicleId || '').trim()),
      photosComplete: gate.complete,
      currentOdometer: currentCheckin.odometer,
      nextOdometer: nextCheckout.odometer
    });
    const TEXT = {
      [SWAP_BLOCKERS.VEHICLE]: () => t('vehicleSwap.selectReplacement'),
      [SWAP_BLOCKERS.PHOTOS]: () =>
        t('vehicleSwap.missingBoth', { count: PHOTOS_TOTAL - gate.total }),
      [SWAP_BLOCKERS.ODOMETER_CURRENT]: () => t('vehicleSwap.odometerRequiredCurrent'),
      [SWAP_BLOCKERS.ODOMETER_NEXT]: () => t('vehicleSwap.odometerRequiredNext')
    };
    return {
      ready: state.ready,
      blockedOnlyByPhotos: state.blockedOnlyByPhotos,
      text: state.first ? TEXT[state.first]() : t('vehicleSwap.readyToSwap')
    };
  }, [vehicleId, gate.complete, gate.total, currentCheckin.odometer, nextCheckout.odometer, t]);

  if (!open) return null;

  // Only prompt when there is labor to lose: with zero captures, Cancel just closes.
  const requestClose = () => {
    if (gate.total > 0) return setConfirmDiscard(true);
    onClose();
  };

  const submit = async (overrideReason = null) => {
    setAttempted(true);
    if (!readiness.ready && !(overrideReason && readiness.blockedOnlyByPhotos)) {
      return setMsg(readiness.text);
    }
    try {
      setSaving(true);
      setMsg('');
      await api(`/api/dealership-loaner/reservations/${reservation.id}/swap-vehicle`, {
        method: 'POST',
        body: JSON.stringify({
          vehicleId: String(vehicleId || '').trim(),
          note,
          currentCheckin,
          nextCheckout,
          ...(overrideReason ? { photoOverride: { reason: overrideReason } } : {})
        })
      }, token);
      onDone?.();
    } catch (e) {
      setMsg(String(e?.message || t('vehicleSwap.swapError')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('vehicleSwap.loanerTitle')}>
      <div className="glass card-lg stack swap-loaner-modal">
        <div className="row-between" style={{ marginBottom: 0 }}>
          <div className="stack" style={{ gap: 6 }}>
            <span className="eyebrow">{t('vehicleSwap.eyebrow')}</span>
            <h3 style={{ margin: 0 }}>{t('vehicleSwap.loanerTitle')}</h3>
          </div>
          <span className={`status-chip ${gate.complete ? 'good' : 'warn'}`} aria-live="polite">
            {t('vehicleSwap.photoCount', { filled: gate.total, total: PHOTOS_TOTAL })}
          </span>
        </div>

        <div className={`surface-note${gate.complete ? ' swap-note-complete' : ''}`}>
          {gate.complete ? t('vehicleSwap.completeStrip') : t('vehicleSwap.whyStrip', { count: PHOTOS_PER_VEHICLE })}
        </div>

        {msg ? <div className="swap-alert" role="alert">{msg}</div> : null}

        <div className="stack">
          <label className="label">{t('vehicleSwap.swapNote')}</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('vehicleSwap.swapNotePlaceholder')} />
        </div>

        <SwapInspectionCard
          title={t('vehicleSwap.cardIncoming')}
          plate={label(reservation?.vehicle)}
          value={currentCheckin}
          onChange={setCurrentCheckin}
          flagMissing={shouldFlagMissing({ attempted, otherComplete: gate.nextComplete })}
          onReadError={() => setMsg(t('vehicleSwap.photoReadError'))}
        />
        <SwapInspectionCard
          title={t('vehicleSwap.cardOutgoing')}
          plate={label(nextVehicle)}
          value={nextCheckout}
          onChange={setNextCheckout}
          flagMissing={shouldFlagMissing({ attempted, otherComplete: gate.previousComplete })}
          onReadError={() => setMsg(t('vehicleSwap.photoReadError'))}
        />

        {msg ? <div className="swap-alert" role="alert">{msg}</div> : null}

        {confirmDiscard ? (
          <div className="swap-discard-confirm" role="alertdialog" aria-label={t('vehicleSwap.discard.title')}>
            <div className="swap-discard-title">
              {t('vehicleSwap.discard.title', { count: gate.total })}
            </div>
            <div className="inline-actions" style={{ marginTop: 8 }}>
              <button type="button" style={{ flex: 1 }} onClick={() => { setConfirmDiscard(false); onClose(); }}>
                {t('vehicleSwap.discard.confirm')}
              </button>
              <button type="button" className="button-subtle" style={{ flex: 1 }} onClick={() => setConfirmDiscard(false)}>
                {t('vehicleSwap.discard.keep')}
              </button>
            </div>
          </div>
        ) : null}

        <div className="row-between" style={{ marginBottom: 0 }}>
          <span className={`swap-readiness ${readiness.ready ? 'good' : 'warn'}`} aria-live="polite">
            {readiness.text}
          </span>
          <div className="inline-actions">
            <button type="button" className="button-subtle" onClick={requestClose} disabled={saving}>
              {t('common.cancel')}
            </button>
            <button className="ios-action-btn" type="button" disabled={saving || !readiness.ready} onClick={() => submit()}>
              {saving ? t('vehicleSwap.swapping') : t('vehicleSwap.confirmSwap')}
            </button>
          </div>
        </div>

        <SwapPhotoOverridePanel
          me={me}
          missingCount={PHOTOS_TOTAL - gate.total}
          disabled={!readiness.blockedOnlyByPhotos}
          disabledText={readiness.text}
          busy={saving}
          onOverride={(reason) => submit(reason)}
        />
      </div>
    </div>
  );
}
