/**
 * Mandatory swap photos (2026-07-16).
 *
 * Hector's decision: a vehicle swap requires the app's STANDARD 8-photo set for
 * BOTH cars — the one coming back and the one being handed over (16 total) — and
 * it is a HARD BLOCK. The UI is not the gate: `swapVehicle` calls
 * `validateSwapPhotos` on both inspections and refuses the swap when any slot is
 * missing or is not a real image.
 *
 * ── ADMIN OVERRIDE (Hector, 2026-07-17) ────────────────────────────────────
 * The one exception, added after QA's point: with NO way out, a failed iPad
 * capture at 9pm means nobody can swap a car at all. So ADMIN/SUPER_ADMIN may
 * override — with a MANDATORY free-text reason — and every override writes an
 * AuditLog(ADMIN_OVERRIDE) naming who, both cars, the reason, and WHICH SLOTS
 * WERE MISSING (that last field is how Hector learns whether capture is failing
 * systematically or people are just skipping).
 *
 * The override bypasses the PHOTO requirement and NOTHING else — mirroring the
 * planner's `force` semantics (beta.311): force bypasses rules, never occupancy.
 * Whatever photos WERE captured still go to storage as refs; the no-base64
 * guarantee holds identically on the override path.
 *
 * ── BOTH SWAP PATHS ────────────────────────────────────────────────────────
 * Two live, UI-driven mid-rental swap paths exist and BOTH gate here via
 * `prepareSwapPhotos`:
 *   1. reservations.service.swapVehicle          (POST /api/reservations/:id/swap-vehicle)
 *   2. dealership-loaner.service.swapVehicle     (POST /api/dealership-loaner/reservations/:id/swap-vehicle)
 * A gate on only one of them is not a gate (QA, 2026-07-17).
 *
 * 🚨 STORAGE, NOT BASE64. The 16 photos are uploaded to Supabase Storage and only
 * slim REFS land in `RentalAgreementVehicleSwap.previousInspectionJson` /
 * `nextInspectionJson`. Inlining 16 multi-MB blobs into those JSON columns would
 * recreate the exact incident fixed in beta.310 (base64 `photosJson` blew the
 * planner snapshot up to 38s / 504). `assertNoInlinePhotos` is the belt-and-
 * suspenders check that no caller can regress this.
 *
 * Everything here reuses the existing inspection-photo machinery
 * (`inspection-photos.js` / `inspection-photos-normalize.js`): the same magic-header
 * validation, the same size cap, the same read-back byte verification, the same
 * canonical slot keys. Nothing new is invented.
 *
 * ESM. No new npm deps. No migration — refs ride in the existing JSON columns.
 */

import crypto from 'node:crypto';
import { downloadObject } from '../../lib/storage/supabase-storage.js';
import { canonicalPhotoKey } from '../rental-agreements/inspection-photos-normalize.js';
import {
  decodePhotoValue,
  getPhotosBucket,
  isStorageEnabled,
  normalizePhotosForUpload,
  uploadInspectionPhotosDetailed
} from '../rental-agreements/inspection-photos.js';

/**
 * The app's standard 8 slots — identical to the set the inspection wizard
 * captures (`reservations/[id]/inspection`) so Damage History and the photo
 * intelligence understand swap photos exactly like any other inspection.
 */
export const SWAP_PHOTO_SLOTS = Object.freeze([
  'front',
  'rear',
  'left',
  'right',
  'frontSeat',
  'rearSeat',
  'dashboard',
  'trunk'
]);

export const SWAP_PHOTOS_PER_VEHICLE = SWAP_PHOTO_SLOTS.length; // 8
export const SWAP_PHOTOS_TOTAL = SWAP_PHOTOS_PER_VEHICLE * 2; // 16

export function vehicleDisplayLabel(vehicle = {}) {
  return [
    [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(' ').trim(),
    vehicle?.plate || vehicle?.internalNumber || ''
  ].filter(Boolean).join(' • ');
}

/**
 * 🔒 LINCHPIN — this strict field whitelist is WHY the no-base64 guarantee holds.
 *
 * Everything the client posts is coerced to a scalar here EXCEPT `photos`, which
 * is deliberately the only object that survives — and it is consumed by
 * `uploadSwapPhotos` and then REPLACED by refs before anything is persisted
 * (`assertNoInlinePhotos` then verifies that). Because no other key can carry an
 * object through, there is no second path by which photo bytes can reach
 * `previousInspectionJson` / `nextInspectionJson`.
 *
 * If you ever add an object/array passthrough here (a `metadata` blob, an
 * `extras` map, a spread of `payload`), that guarantee SILENTLY erodes: bytes
 * could ride into the JSON columns via the new key, `assertNoInlinePhotos` would
 * not see them, and beta.310 (base64 photosJson → 38s planner snapshot / 504)
 * comes back. Keep this a whitelist of scalars.
 *
 * Lives here (moved from reservations.service.js, 2026-07-17) rather than in
 * either swap path: it is part of the gate's contract, and the dealership-loaner
 * path needs the identical whitelist. Two copies of a linchpin is zero linchpins.
 */
export function normalizeSwapInspectionPayload(payload = {}) {
  return {
    exterior: String(payload?.exterior || 'GOOD').trim().toUpperCase(),
    interior: String(payload?.interior || 'GOOD').trim().toUpperCase(),
    tires: String(payload?.tires || 'GOOD').trim().toUpperCase(),
    lights: String(payload?.lights || 'GOOD').trim().toUpperCase(),
    windshield: String(payload?.windshield || 'GOOD').trim().toUpperCase(),
    fuelLevel: payload?.fuelLevel === '' || payload?.fuelLevel == null ? null : String(payload.fuelLevel),
    odometer: payload?.odometer === '' || payload?.odometer == null ? null : Number(payload.odometer),
    cleanliness: payload?.cleanliness === '' || payload?.cleanliness == null ? null : Number(payload.cleanliness),
    damages: String(payload?.damages || '').trim() || null,
    notes: String(payload?.notes || '').trim() || null,
    photos: payload?.photos && typeof payload.photos === 'object' ? payload.photos : {}
  };
}

// Test seam (same pattern as economy/nu/tl-international `__test.setFetch`).
// Production leaves these null so the real Supabase Storage client is used.
let uploaderOverride = null;
let downloaderOverride = null;

/**
 * Collapse whatever the client posted into { canonicalSlot: value } using the
 * SAME shape normalizer the inspection write path uses, so the object-map, the
 * array-of-{key,dataUrl}, and the snake_case mobile keys all work here too.
 */
function toSlotMap(photos) {
  const out = {};
  const { items } = normalizePhotosForUpload(photos);
  for (const { slot, value } of items) {
    const key = canonicalPhotoKey(slot);
    // First non-empty value per slot wins; a slot is never overwritten by a
    // later empty one.
    if (out[key] == null && value != null && value !== '') out[key] = value;
  }
  return out;
}

/**
 * HARD GATE (pure — no I/O, no prisma). Verifies that all 8 canonical slots
 * carry a value that actually decodes to a real image within the size cap.
 * A key with junk behind it ("ok", "[object Object]", a 9-byte buffer) does NOT
 * satisfy the slot — `decodePhotoValue` magic-header-validates the bytes.
 *
 * @returns {{ ok: boolean, present: string[], missing: Array<{slot:string, reason:string}> }}
 */
export function validateSwapPhotos(photos) {
  const slotMap = toSlotMap(photos);
  const present = [];
  const missing = [];

  for (const slot of SWAP_PHOTO_SLOTS) {
    const value = slotMap[slot];
    if (value == null || value === '') {
      missing.push({ slot, reason: 'missing' });
      continue;
    }
    // 🚨 A URL NEVER satisfies a swap slot. The inspection wizard accepts an
    // http(s) passthrough because its resume flow legitimately re-posts photos
    // that already live in storage — but this is an EVIDENCE gate, and no
    // legitimate swap caller ever sends a URL (the UI always posts data URLs).
    // Accepting one would let a crafted call post 8 × {"front":"https://evil/x.jpg"}
    // and complete a swap with ZERO bytes stored, after which the read path would
    // serve the attacker's URL back as "the photo". Bytes or nothing.
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      missing.push({ slot, reason: 'invalid' });
      continue;
    }
    let decoded = null;
    try {
      decoded = decodePhotoValue(value);
    } catch (err) {
      // decodePhotoValue throws StorageError(413) when the photo blows the cap.
      missing.push({ slot, reason: err?.status === 413 ? 'too-large' : 'invalid' });
      continue;
    }
    if (!decoded) {
      missing.push({ slot, reason: 'not-an-image' });
      continue;
    }
    present.push(slot);
  }

  return { ok: missing.length === 0, present, missing };
}

const REASON_TEXT = Object.freeze({
  missing: 'missing',
  'not-an-image': 'not a valid image',
  'too-large': 'over the size limit',
  invalid: 'unreadable'
});

/**
 * Human, actionable one-liner naming WHICH car and WHICH slots are wrong.
 * Contains the word "required" on purpose: the route maps that to a 400.
 *
 * @param {Array<{label:string, vehicleLabel:string, missing:Array}>} groups
 */
export function describeMissingSwapPhotos(groups = []) {
  const parts = [];
  for (const group of groups) {
    if (!group?.missing?.length) continue;
    const detail = group.missing
      .map((m) => (m.reason && m.reason !== 'missing' ? `${m.slot} (${REASON_TEXT[m.reason] || m.reason})` : m.slot))
      .join(', ');
    parts.push(`${group.label}${group.vehicleLabel ? ` (${group.vehicleLabel})` : ''}: ${detail}`);
  }
  if (!parts.length) return null;
  return (
    `Vehicle swap blocked: all ${SWAP_PHOTOS_PER_VEHICLE} photos are required for each vehicle ` +
    `(${SWAP_PHOTO_SLOTS.join(', ')}). ${parts.join(' — ')}.`
  );
}

/**
 * Belt-and-suspenders: refuse to persist anything that still carries photo
 * bytes. Called on the exact object that is about to be JSON.stringify'd into
 * `previousInspectionJson` / `nextInspectionJson` (and into the audit metadata).
 * This is what makes the beta.310 regression structurally impossible rather than
 * merely "we remembered not to".
 */
export function assertNoInlinePhotos(inspection, label = 'swap inspection') {
  const refs = inspection?.photoStorageRefs;
  if (!Array.isArray(refs)) {
    throw new Error(`${label}: photoStorageRefs must be an array before persisting`);
  }
  for (const ref of refs) {
    for (const field of ['dataUrl', 'base64', 'body', 'buffer', 'value']) {
      if (ref && ref[field] != null) {
        throw new Error(`${label}: storage ref for "${ref.key}" carries inline bytes (${field}) — refs only`);
      }
    }
  }
  const photos = inspection?.photos;
  if (photos != null && Object.keys(photos).length > 0) {
    throw new Error(`${label}: inline photos map must be empty — swap photos are stored as refs`);
  }
  return true;
}

/**
 * Upload one car's photos and return the slim refs.
 *
 * FAIL-CLOSED by design (this differs from the inspection wizard, which falls
 * back to base64): a swap is evidence for damage disputes and Hector's rule is a
 * hard block, so a partial/unverified upload must abort the swap rather than
 * silently degrade. There is no base64 fallback here — that is the whole point.
 *
 * `slots` defaults to all 8 and is the set the upload must FULLY deliver. The
 * ADMIN-override path narrows it to the slots that actually validated, so the
 * photos that WERE captured are still stored as real, read-back-verified refs —
 * an override is not an excuse to drop the evidence that does exist. It never
 * widens the set: a slot outside SWAP_PHOTO_SLOTS is ignored.
 *
 * Objects land at:
 *   inspection-photos/tenants/<tenantId>/inspections/<scopeId>/<slot>_<uuid>.<ext>
 * i.e. the same namespace + helper as every other inspection photo, with the
 * swap scoped under its own `swap_<uuid>_previous|next` id.
 *
 * @returns {Promise<Array<{key,path,contentType,size,uploadedAt}>>}
 */
export async function uploadSwapPhotos({ photos, tenantId, scopeId, slots = SWAP_PHOTO_SLOTS, logger = console } = {}) {
  const slotMap = toSlotMap(photos);
  const wanted = SWAP_PHOTO_SLOTS.filter((slot) => slots.includes(slot));
  if (!wanted.length) return [];
  const required = {};
  for (const slot of wanted) required[slot] = slotMap[slot];

  const result = await uploadInspectionPhotosDetailed({
    photos: required,
    tenantId,
    inspectionId: scopeId,
    uploader: uploaderOverride || undefined,
    // Read-back byte verification is mandatory here — a write that didn't land
    // must never be recorded as evidence.
    downloader: downloaderOverride || downloadObject,
    logger
  });

  const refs = Array.isArray(result?.refs) ? result.refs : [];

  // Second lock on the same door as validateSwapPhotos' URL rejection.
  // `uploadInspectionPhotosDetailed` emits `{external:true, url}` refs for
  // http(s) values (correct for the inspection wizard's resume flow, wrong
  // here): those bytes were never written by us and were never verified, so
  // they are not evidence. Refuse them even if a future caller slips one past
  // the validator.
  const external = refs.filter((r) => r?.external);
  if (external.length) {
    throw new Error(
      `Vehicle swap blocked: ${external.length} photo(s) were supplied as external URLs ` +
        `(${external.map((r) => canonicalPhotoKey(r.key)).join(', ')}) instead of captured images. ` +
        'Swap photos must be taken in the app — nothing was changed.'
    );
  }

  const gotSlots = new Set(refs.map((r) => canonicalPhotoKey(r.key)));
  const failed = wanted.filter((slot) => !gotSlots.has(slot));
  if (failed.length) {
    throw new Error(
      `Vehicle swap blocked: ${failed.length} photo(s) could not be stored (${failed.join(', ')}). ` +
        'Nothing was changed — please retry the swap.'
    );
  }
  return refs;
}

/**
 * Scope id for one car's photos within a swap.
 *
 * The `swap_<uuid>_previous|next` prefix is a DELIBERATE, SWEEPABLE NAMESPACE,
 * not incidental naming. A swap uploads its 16 objects BEFORE the transaction
 * commits, so an abort (validation failure, read-back mismatch, a rollback
 * downstream) leaves orphaned objects in the bucket. Because every one of them
 * lives under an id matching /^swap_[0-9a-f-]{36}_(previous|next)$/, a future
 * janitor can list the bucket and reap any `swap_*` scope that no
 * RentalAgreementVehicleSwap row references, with zero risk of touching a real
 * inspection's photos. Keep the prefix if you change this.
 */
export function newSwapPhotoScopeId(suffix) {
  return `swap_${crypto.randomUUID()}_${suffix}`;
}

/**
 * The SAME capability predicate Admin Corrections uses
 * (`reservations.routes.js` → `canDoAdminCorrections`, beta.213), lifted here so
 * the two swap paths and the corrections routes cannot drift apart. Routes with a
 * `req` keep calling `canDoAdminCorrections(req)`; services that only hold a
 * `user` (the loaner service) call this directly.
 */
export function isAdminRole(role) {
  const value = String(role || '').toUpperCase();
  return value === 'SUPER_ADMIN' || value === 'ADMIN';
}

/**
 * Resolve an override REQUEST into an authorized override, or refuse.
 *
 * `isAdmin` is computed by the caller from the AUTHENTICATED user — never from
 * the payload. `requested`/`reason` come from the payload and are untrusted:
 * a non-admin posting `{ photoOverride: { reason: 'x' } }` gets a 403, and an
 * admin posting an empty/whitespace reason gets a 400. There is no default
 * reason — a blank one would defeat the entire point of the audit row.
 *
 * @returns {null | { reason: string }}
 */
export function resolveSwapPhotoOverride({ requested, reason, isAdmin } = {}) {
  if (!requested) return null;
  if (!isAdmin) {
    const err = new Error('Vehicle swap blocked: only an ADMIN can override the required swap photos.');
    err.status = 403;
    throw err;
  }
  const clean = String(reason ?? '').trim();
  if (!clean) {
    const err = new Error('Vehicle swap blocked: a reason is required to override the required swap photos.');
    err.status = 400;
    throw err;
  }
  return { reason: clean.slice(0, 500) };
}

/**
 * THE GATE + the upload, in one call — shared verbatim by both swap paths.
 *
 * Validate → (block | override) → fail-closed storage check → upload → build the
 * REF-ONLY objects that are safe to persist → assert no inline bytes.
 *
 * Callers get back exactly what they should write to the DB and nothing they
 * shouldn't. A caller cannot accidentally skip the validation, the read-back
 * verification, or `assertNoInlinePhotos` — they are not optional steps a second
 * call site can forget, which is precisely how the loaner path ended up
 * ungated in the first place.
 *
 * @param {object} args
 * @param {object} args.previousInspection - normalized inspection of the car coming back
 * @param {object} args.nextInspection     - normalized inspection of the car going out
 * @param {string} args.previousVehicleLabel
 * @param {string} args.nextVehicleLabel
 * @param {string} args.tenantId
 * @param {null|{reason:string}} args.override - from resolveSwapPhotoOverride
 * @returns {Promise<{
 *   previousStored:object, nextStored:object,
 *   previousPhotoRefs:Array, nextPhotoRefs:Array,
 *   photoBucket:string|null,
 *   override: null | { reason:string, missingSlots:{previous:string[], next:string[]}, capturedCount:number }
 * }>}
 */
export async function prepareSwapPhotos({
  previousInspection,
  nextInspection,
  previousVehicleLabel = null,
  nextVehicleLabel = null,
  tenantId,
  override = null,
  logger = console
} = {}) {
  const previousCheck = validateSwapPhotos(previousInspection?.photos);
  const nextCheck = validateSwapPhotos(nextInspection?.photos);
  const complete = previousCheck.ok && nextCheck.ok;

  // HARD BLOCK — the default, and still the only outcome for a non-admin.
  if (!complete && !override) {
    throw new Error(
      describeMissingSwapPhotos([
        { label: 'Vehicle coming back', vehicleLabel: previousVehicleLabel, missing: previousCheck.missing },
        { label: 'Replacement vehicle', vehicleLabel: nextVehicleLabel, missing: nextCheck.missing }
      ])
    );
  }

  // An override on a COMPLETE set is a no-op, not an override: there is nothing
  // to bypass, so no ADMIN_OVERRIDE row is written. Otherwise an admin who
  // opened the panel and then shot all 16 anyway would pollute the very signal
  // ("is capture failing systematically?") the audit row exists to produce.
  const effectiveOverride = complete ? null : override;

  const capturedSlots = {
    previous: effectiveOverride ? previousCheck.present : SWAP_PHOTO_SLOTS,
    next: effectiveOverride ? nextCheck.present : SWAP_PHOTO_SLOTS
  };
  const capturedCount = capturedSlots.previous.length + capturedSlots.next.length;

  // Fail closed rather than inline base64. Prod has
  // INSPECTION_PHOTOS_STORAGE_ENABLED=true since 2026-06-10; if it is ever off,
  // the swap stops with an operator-readable message instead of stuffing 16
  // multi-MB blobs into the inspection JSON — that is the exact shape of the
  // beta.310 planner-snapshot outage (38s / 504).
  //
  // An override does NOT relax this: bytes we hold must go to storage or not be
  // held at all. It is only skipped when there are literally zero photos to
  // store (a total capture failure — the case the override exists for), where
  // storage is simply not involved.
  if (capturedCount > 0 && !isStorageEnabled()) {
    throw new Error(
      'Vehicle swap blocked: photo storage is not enabled, so the 16 required swap photos cannot be stored. ' +
        'Set INSPECTION_PHOTOS_STORAGE_ENABLED=true (bucket "inspection-photos") and retry.'
    );
  }

  // Upload BEFORE any transaction — never hold a DB transaction open across
  // network I/O. Each upload is read-back byte-verified; a shortfall throws and
  // nothing is mutated.
  const photoBucket = capturedCount > 0 ? getPhotosBucket() : null;
  const previousPhotoRefs = await uploadSwapPhotos({
    photos: previousInspection?.photos,
    tenantId,
    scopeId: newSwapPhotoScopeId('previous'),
    slots: capturedSlots.previous,
    logger
  });
  const nextPhotoRefs = await uploadSwapPhotos({
    photos: nextInspection?.photos,
    tenantId,
    scopeId: newSwapPhotoScopeId('next'),
    slots: capturedSlots.next,
    logger
  });

  // What actually gets persisted: everything EXCEPT the bytes. `photos` is
  // emptied and replaced by `photoStorageRefs` + `photoBucket`. Identical on the
  // override path — a partial set is still refs-only.
  const previousStored = { ...previousInspection, photos: {}, photoBucket, photoStorageRefs: previousPhotoRefs };
  const nextStored = { ...nextInspection, photos: {}, photoBucket, photoStorageRefs: nextPhotoRefs };
  assertNoInlinePhotos(previousStored, 'swap previous inspection');
  assertNoInlinePhotos(nextStored, 'swap next inspection');

  return {
    previousStored,
    nextStored,
    previousPhotoRefs,
    nextPhotoRefs,
    photoBucket,
    override: effectiveOverride
      ? {
          reason: effectiveOverride.reason,
          // The field that makes the log worth having.
          missingSlots: {
            previous: previousCheck.missing.map((m) => m.slot),
            next: nextCheck.missing.map((m) => m.slot)
          },
          capturedCount
        }
      : null
  };
}

/**
 * The AuditLog(ADMIN_OVERRIDE) row for a photo override — one shape, both paths.
 * Mirrors Admin Corrections (beta.213): action ADMIN_OVERRIDE, the mandatory
 * reason in the `reason` COLUMN (sliced 500), the specifics in `metadata`.
 *
 * Refs only in metadata — never `*Stored`-sized payloads of bytes.
 */
export function buildSwapPhotoOverrideAudit({
  tenantId = null,
  reservationId,
  actorUserId = null,
  actorIp = null,
  previousVehicleId = null,
  nextVehicleId = null,
  previousVehicleLabel = null,
  nextVehicleLabel = null,
  path,
  override
}) {
  return {
    tenantId: tenantId || null,
    reservationId,
    actorUserId: actorUserId || null,
    action: 'ADMIN_OVERRIDE',
    reason: override.reason,
    metadata: JSON.stringify({
      kind: 'swap_photo_override',
      path, // 'reservation_swap' | 'dealership_loaner_swap'
      previousVehicleId,
      nextVehicleId,
      previousVehicleLabel,
      nextVehicleLabel,
      actorIp: actorIp || null,
      missingSlots: override.missingSlots,
      missingCount: override.missingSlots.previous.length + override.missingSlots.next.length,
      capturedCount: override.capturedCount,
      requiredCount: SWAP_PHOTOS_TOTAL
    })
  };
}

export { isStorageEnabled, getPhotosBucket };

export const __test = {
  setStorageAdapter({ uploader = null, downloader = null } = {}) {
    uploaderOverride = uploader;
    downloaderOverride = downloader;
  },
  reset() {
    uploaderOverride = null;
    downloaderOverride = null;
  },
  toSlotMap
};
