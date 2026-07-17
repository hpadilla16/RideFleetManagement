'use client';

/**
 * ADMIN photo override — the EMERGENCY EXIT (Hector, 2026-07-17).
 *
 * WHY it exists: the 16-photo rule was a hard block with no way out. QA's point,
 * which Hector accepted — if the iPad camera fails in the field at 9pm, the
 * failure mode isn't degraded UX: nobody can swap a car at all.
 *
 * WHY it looks like this: it ADDS an exit to a mockup Hector already approved, so
 * it is deliberately understated — an emergency exit, NOT a convenience.
 *   • Collapsed to a single quiet `.button-subtle` link until an admin asks for it.
 *   • Never a peer of the primary action: the real "Confirm Swap" button stays
 *     where it is and stays disabled. This renders BELOW it, visually subordinate.
 *   • Shown only to ADMIN/SUPER_ADMIN, and only while photos are actually missing
 *     — there is nothing to override once the set is complete.
 *   • The confirm restates exactly what is being bypassed and how many photos are
 *     missing, because that is what lands in the permanent audit row.
 *
 * The reason box is required HERE only as a courtesy; the backend rejects an
 * empty/whitespace reason regardless (`resolveSwapPhotoOverride`). The UI is not
 * the gate — same posture as the photo rule itself.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Mirrors the backend's `isAdminRole` / Admin Corrections' canDoAdminCorrections. */
export function canOverrideSwapPhotos(me) {
  const role = String(me?.role || '').toUpperCase();
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

export function SwapPhotoOverridePanel({ me, missingCount, disabled, disabledText, busy, onOverride }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (!canOverrideSwapPhotos(me) || !missingCount) return null;

  const trimmed = reason.trim();

  if (!open) {
    return (
      <div className="swap-override-affordance">
        <button type="button" className="button-subtle swap-override-link" onClick={() => setOpen(true)}>
          {t('vehicleSwap.override.open')}
        </button>
      </div>
    );
  }

  return (
    <section className="swap-override-panel stack" role="group" aria-label={t('vehicleSwap.override.title')}>
      <div>
        <div className="swap-override-title">{t('vehicleSwap.override.title')}</div>
        <p className="swap-override-copy">{t('vehicleSwap.override.explain', { count: missingCount })}</p>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <label className="label" htmlFor="swap-override-reason">{t('vehicleSwap.override.reasonLabel')}</label>
        <textarea
          id="swap-override-reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('vehicleSwap.override.reasonPlaceholder')}
        />
        {/* Says WHY it's disabled rather than just being dead — the same
            "a disabled button must explain itself" rule as GD-4 on the footer.
            `disabledText` covers the case an admin forgets: the override clears
            the PHOTO rule only, so a missing car/odometer still blocks and must
            say so rather than presenting a dead button. */}
        <span className="swap-override-hint" aria-live="polite">
          {disabled ? disabledText : trimmed ? t('vehicleSwap.override.willLog') : t('vehicleSwap.override.reasonRequired')}
        </span>
      </div>
      <div className="inline-actions">
        <button type="button" className="button-subtle" onClick={() => { setOpen(false); setReason(''); }}>
          {t('vehicleSwap.override.cancel')}
        </button>
        <button
          type="button"
          className="button-subtle swap-override-confirm"
          disabled={!trimmed || disabled || busy}
          onClick={() => onOverride(trimmed)}
        >
          {busy ? t('vehicleSwap.swapping') : t('vehicleSwap.override.confirm')}
        </button>
      </div>
    </section>
  );
}
