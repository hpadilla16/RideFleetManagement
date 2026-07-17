'use client';

/**
 * The swap capture card — the 8-slot photo grid + the condition/odometer/fuel
 * fields for ONE car.
 *
 * Extracted from `reservations/[id]/swap/page.js` (2026-07-17) unchanged, so the
 * DEALERSHIP-LOANER swap can capture photos EXACTLY as the main swap page does
 * rather than growing a second, subtly-different implementation. The loaner path
 * had no photo gate at all (QA); the fix is one gate AND one capture UI, not a
 * copy of each.
 *
 * Keep this presentational: the gate logic lives in `lib/swap-photos.js` (pure,
 * unit-tested) and the real gate lives in the backend.
 */
import { useTranslation } from 'react-i18next';
import { compressImage, fileToDataUrl } from '../../lib/image-compressor';
import { PHOTOS_PER_VEHICLE, SWAP_PHOTO_SLOTS, emptySwapPhotos } from '../../lib/swap-photos';

export const FUEL_OPTIONS = ['0.000', '0.125', '0.250', '0.375', '0.500', '0.625', '0.750', '0.875', '1.000'];
export const CONDITION_OPTIONS = ['GOOD', 'FAIR', 'POOR'];

export const emptySwapInspection = () => ({
  exterior: 'GOOD',
  interior: 'GOOD',
  tires: 'GOOD',
  lights: 'GOOD',
  windshield: 'GOOD',
  fuelLevel: '1.000',
  odometer: '',
  cleanliness: '5',
  damages: '',
  notes: '',
  photos: emptySwapPhotos()
});

/**
 * 🚨 COMPRESS BEFORE UPLOAD — not optional at 16 photos.
 *
 * A swap posts BOTH cars' 8 photos in ONE request. Raw modern-phone captures run
 * ~3MB each; base64 inflates by ~1.37 → 16 × 3MB × 1.37 ≈ 60-70MB, which blows
 * past express.json({limit:'50mb'}) (backend main.js) and nginx's
 * client_max_body_size. The employee would shoot all 16 and get an opaque 413
 * with nothing saved — the exact surprise-at-the-end the mockup forbids.
 *
 * compressImage lands them ~300KB each (≈5MB total) and, as a bonus, re-encodes
 * to JPEG, which normalizes iOS HEIC captures the backend's magic-header check
 * would otherwise reject.
 */
export const captureToDataUrl = async (file) => {
  const compressed = await compressImage(file, { maxWidth: 1280, quality: 0.7 });
  return String((await fileToDataUrl(compressed)) || '');
};

/**
 * SW-1/SW-2/SW-3: the 8-slot capture grid. Same capture pattern as
 * reservations/[id]/inspection (device camera via capture="environment").
 * Missing slots only turn red once `flagMissing` is true — SW-2's "don't scold
 * from second zero" rule.
 */
export function SwapPhotoGrid({ photos, onPick, flagMissing, onReadError }) {
  const { t } = useTranslation();
  return (
    <div className="swap-photo-grid">
      {SWAP_PHOTO_SLOTS.map((slot) => {
        const filled = Boolean(photos?.[slot]);
        const missing = !filled && flagMissing;
        // The dashboard slot keeps its "odometer + fuel" hint (it's the photo
        // that backs those two fields) AND still says "Missing" when it is.
        const hint = slot === 'dashboard' ? t('vehicleSwap.dashboardHint') : t('vehicleSwap.slotTake');
        return (
          // GD-2: the whole ~96px card is the tap target — an employee taps 16
          // of these standing at the counter, not 16 × 24px "Choose File".
          <label key={slot} className={`swap-slot${filled ? ' filled' : ''}${missing ? ' missing' : ''}`}>
            {filled ? (
              <img className="swap-slot-thumb" src={photos[slot]} alt={t(`vehicleSwap.slot.${slot}`)} />
            ) : (
              <span className="swap-slot-ico" aria-hidden="true">📷</span>
            )}
            <span className="swap-slot-name">{filled ? '✓ ' : ''}{t(`vehicleSwap.slot.${slot}`)}</span>
            <span className="swap-slot-hint">{missing ? `${t('vehicleSwap.slotMissing')} · ${hint}` : hint}</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  onPick(slot, await captureToDataUrl(file));
                } catch {
                  onReadError();
                }
              }}
            />
          </label>
        );
      })}
    </div>
  );
}

export function SwapInspectionCard({ title, plate, value, onChange, flagMissing, onReadError }) {
  const { t } = useTranslation();
  const filled = SWAP_PHOTO_SLOTS.filter((slot) => value.photos?.[slot]).length;
  const complete = filled === PHOTOS_PER_VEHICLE;
  return (
    <section className="glass card stack">
      <div className="row-between" style={{ marginBottom: 0 }}>
        <div style={{ fontWeight: 700 }}>{title}{plate ? ` — ${plate}` : ''}</div>
        <span className={`status-chip ${complete ? 'good' : 'warn'}`}>
          {t('vehicleSwap.perVehicleCount', { filled, total: PHOTOS_PER_VEHICLE })}
        </span>
      </div>
      <div className="grid2">
        {['exterior', 'interior', 'tires', 'lights', 'windshield'].map((key) => (
          <div key={key} className="stack">
            <label className="label">{t(`vehicleSwap.condition.${key}`)}</label>
            <select value={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.value })}>
              {CONDITION_OPTIONS.map((option) => (
                <option key={option} value={option}>{t(`vehicleSwap.conditionValue.${option}`)}</option>
              ))}
            </select>
          </div>
        ))}
        <div className="stack">
          <label className="label">{t('vehicleSwap.fuel')}</label>
          <select value={value.fuelLevel} onChange={(e) => onChange({ ...value, fuelLevel: e.target.value })}>
            {FUEL_OPTIONS.map((option, index) => <option key={option} value={option}>{index}/8</option>)}
          </select>
        </div>
        <div className="stack">
          <label className="label">{t('vehicleSwap.odometer')}</label>
          <input type="number" min="0" value={value.odometer} onChange={(e) => onChange({ ...value, odometer: e.target.value })} />
        </div>
        <div className="stack">
          <label className="label">{t('vehicleSwap.cleanliness')}</label>
          <input type="number" min="1" max="5" value={value.cleanliness} onChange={(e) => onChange({ ...value, cleanliness: e.target.value })} />
        </div>
        <div className="stack">
          <label className="label">{t('vehicleSwap.damages')}</label>
          <input value={value.damages} onChange={(e) => onChange({ ...value, damages: e.target.value })} />
        </div>
      </div>
      <div className="stack">
        <label className="label">{t('vehicleSwap.notes')}</label>
        <textarea rows={3} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} />
      </div>

      <div className="glass card" style={{ padding: 10 }}>
        <h3 style={{ margin: 0 }}>{t('vehicleSwap.requiredPhotos', { count: PHOTOS_PER_VEHICLE })}</h3>
        <SwapPhotoGrid
          photos={value.photos}
          flagMissing={flagMissing}
          onReadError={onReadError}
          onPick={(slot, dataUrl) => onChange({ ...value, photos: { ...value.photos, [slot]: dataUrl } })}
        />
      </div>
    </section>
  );
}
