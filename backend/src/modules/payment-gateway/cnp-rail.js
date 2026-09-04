/**
 * Which rail serves a tenant's CARD-NOT-PRESENT operations (2026-09-04).
 *
 * Two clients talk to Dejavoo money: spin-client.js (the SPIn API — the
 * physical terminal, and token CNP as a fallback) and ipos-transact-client.js
 * (the Transact cloud CNP API). Which one a saved-card operation may use is
 * not a preference — it is a credentials question:
 *
 *   • A TENANT-RESOLVED terminal (per-location registers, or the tenant-level
 *     SPIn block) carries SPIn credentials ONLY. toSpinClientConfig has no
 *     Transact fields to carry, and the Transact client's env fallback would
 *     borrow the PLATFORM's auth token — another merchant's credential, which
 *     is the silent gateway crossing this codebase forbids. Live symptom
 *     before this rule: Corpusa's "Charge card on file" reached the Transact
 *     client with no usable credentials and died as a raw 500 at the counter.
 *
 *   • An EMPTY tenantConfig means the legacy env deployment (IRC), whose
 *     Transact env credentials are its own. That path keeps Transact.
 *
 * The presence of spinTpn on the resolved client config is therefore the
 * discriminator: toSpinClientConfig returns it for source TENANT and returns
 * `{}` for source ENV, by design.
 */
export function usesSpinCnpRail(tenantConfig = {}) {
  return Boolean(tenantConfig?.spinTpn);
}

/**
 * Which rail can VOID a given deposit hold. The hold id itself says how the
 * hold was placed, and only the rail that placed it can see it:
 *
 *   • MANUAL- prefix        → bookkeeping row, nothing at any gateway.
 *   • contains "-DEP-"      → SPIn pre-auth ReferenceId (spin-charge and the
 *                             re-auth tool both mint them that way) → SPIn
 *                             Void, which REQUIRES the original amount
 *                             (2201 without it, proven live 2026-09-04).
 *   • all digits            → Transact RRN (the Transact void key).
 *   • anything else         → the tenant's own CNP rail decides.
 */
export function holdVoidRail(holdId, tenantConfig = {}) {
  const id = String(holdId || '');
  if (id.startsWith('MANUAL-')) return 'MANUAL';
  if (id.includes('-DEP-')) return 'SPIN';
  if (/^\d+$/.test(id)) return 'TRANSACT';
  return usesSpinCnpRail(tenantConfig) ? 'SPIN' : 'TRANSACT';
}
