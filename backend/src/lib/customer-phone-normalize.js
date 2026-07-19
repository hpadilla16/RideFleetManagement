/**
 * VozIA gap #4 (2026-07-15) — normalized-phone derivation for Customer.
 *
 * RideFleet stores phones as free-form strings ("(787) 555-1234", "787-555-1234",
 * "+1 787 555 1234"). Customer search is a raw ILIKE substring, so a caller who says
 * "7875551234" by voice never matches a stored "(787) 555-1234". The fix is a
 * digits-only `Customer.phoneNormalized` column, derived on every write via a single
 * Prisma query extension (applied in lib/prisma.js) so ALL create/update paths — the
 * customers CRUD plus the 9 other create sites (public-booking, kiosk, dealership-loaner,
 * the 4 booking-source workers, reservations, booking-engine) — stay consistent without
 * being patched individually. customers.service.js search matches against it.
 *
 * Pure + exported so the derivation matrix is unit-testable without Prisma
 * (customer-phone-normalize.test.mjs).
 */

/** Digits-only form of a phone string, or null when there are no digits. */
export function normalizePhone(phone) {
  if (phone === null || phone === undefined) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits || null;
}

/** Unwrap a Prisma update value: `{ set: v }` -> v; a bare scalar passes through. */
function resolvePhoneValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'set' in v) return v.set;
  return v;
}

/**
 * Mutate a Prisma create/update `data` object in place: when it carries a `phone`,
 * derive `phoneNormalized` from it. When `phone` is absent (an update that doesn't
 * touch the phone), leave `phoneNormalized` untouched. Returns the same object.
 */
export function applyPhoneNormalized(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (!('phone' in data)) return data;
  const resolved = resolvePhoneValue(data.phone);
  // Prisma treats `phone: undefined` (and `{ set: undefined }`) as "leave phone
  // unchanged". We must do the same for phoneNormalized — otherwise the two columns
  // desync (phone kept, phoneNormalized wiped), silently breaking the voice search.
  if (resolved === undefined) return data;
  data.phoneNormalized = normalizePhone(resolved);
  return data;
}

/**
 * Prisma client query extension. Intercepts every Customer write operation and derives
 * phoneNormalized before the query runs. Applied once in lib/prisma.js.
 */
export const customerPhoneNormalizeExtension = {
  name: 'customerPhoneNormalize',
  query: {
    customer: {
      create({ args, query }) {
        applyPhoneNormalized(args.data);
        return query(args);
      },
      update({ args, query }) {
        applyPhoneNormalized(args.data);
        return query(args);
      },
      updateMany({ args, query }) {
        applyPhoneNormalized(args.data);
        return query(args);
      },
      upsert({ args, query }) {
        applyPhoneNormalized(args.create);
        applyPhoneNormalized(args.update);
        return query(args);
      },
      createMany({ args, query }) {
        if (Array.isArray(args.data)) args.data.forEach(applyPhoneNormalized);
        else applyPhoneNormalized(args.data);
        return query(args);
      },
    },
  },
};
