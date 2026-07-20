# Kiosk → smart-match contract NEEDS (B3g, 2026-07-19)

What the **kiosk** requires from the shared matcher
`backend/src/lib/reservation-smart-match.js` (owned by S30/VozIA). This feeds
the contract freeze — it is what the kiosk consumes, not a spec of the whole
lib. VozIA/Chloe may consume more (name search, broader windows); the kiosk
needs only the subset below.

Single source of truth: the kiosk does **not** implement any code normalizer /
variant generator (rule like `vehicle-status-sync`). Wire-in seam lives at
`backend/src/modules/kiosk/kiosk-smart-match.js` — one line once the lib lands.

## Function the kiosk calls

```
smartMatchReservation({ code?, name?, dateWindow?, tenantId }) =>
  Promise<Array<{
    reservation: { id: string },   // kiosk only reads .id (see re-scope note)
    matchType: 'exact' | 'variant' | 'name',
    confidence: number             // 0–100, used for ranking order
  }>>
```

### Inputs the kiosk passes today
- `code` — the raw confirmation string the guest typed (e.g. OTA gives
  `ZE40809640BA`, the import stored `TL-ZE40809640BA`). Kiosk-side exact match
  runs FIRST; the matcher is only called when exact misses, so its job for the
  kiosk is the **variant** case.
- `tenantId` — the device's tenant. **Hard requirement: tenant-scoped.** The
  kiosk passes it and additionally re-fetches every returned id under its own
  tenant scope, so a cross-tenant leak is impossible even if the matcher
  regressed — but the matcher MUST NOT return other tenants' rows.
- (Not passed by the kiosk yet: `name`, `dateWindow`. The kiosk runs its own
  name + pickup-date DB fallback because those need no normalizer. If the lib
  later wants to own name matching too, the kiosk seam can pass `name`/
  `dateWindow` — additive, no contract change needed now.)

### Output contract the kiosk depends on
1. **Ranked array**, best first (kiosk preserves order; confidence only needs
   to be a monotonic rank hint).
2. Each entry exposes a **stable `reservation.id`** (cuid). The kiosk treats
   the row as an UNTRUSTED ref: it re-fetches `id` through its own
   tenant + location + pickup-window (−12h…+36h) + status(NEW/CONFIRMED)
   scoping before surfacing anything. So the matcher does NOT need to return
   the full row, only `{ id }` — but it MUST return the id.
3. **`matchType`** ∈ `exact | variant | name`. The kiosk branches on it only
   for telemetry today (records `matchType` per lookup to tune variant
   patterns with real data). `exact` from the matcher is fine but redundant —
   the kiosk resolves exact itself first.
4. **Read-only.** The matcher must never write.
5. **Multiple candidates are allowed and expected** (an ambiguous variant maps
   to >1 booking). The kiosk turns >1 into a `NEEDS_MORE_INFO` prompt (asks
   one more datum) and NEVER shows a list — so the matcher returning several
   is correct behavior, not an error.

## Disambiguation case (kiosk-side, informational)
When the matcher (or the name query) yields >1 in-scope candidate, the kiosk
responds `{ status: 'NEEDS_MORE_INFO', needs: 'lastName' | 'pickupDate' }` and
asks the guest for exactly one more field. It never returns reservation
details for an ambiguous match (privacy). The matcher doesn't need to change
for this — it just needs to be able to return multiple ranked candidates.

## Privacy expectation
Every non-exact match the kiosk surfaces is the same masked stub as B1
(`maskedName` + `pickupWindow` + `vehicleClassName` + `channel`) — no full
confirmation number, phone, email, or vehicle pre-verify. The matcher only
supplies ids; masking is entirely the kiosk's job, so the matcher has no PII
obligation beyond "don't leak other tenants / don't write".

## New variant patterns
Any code-format variant the kiosk discovers in the field goes to the shared
lib + this doc, never a local fork.

## Ranking / confidence (aclaración para el freeze — Innovation R1, 2026-07-19)
El kiosk consume el orden ranked (best-first) pero con >1 candidato IN-SCOPE
DESCARTA el ranking y pide un dato más (NEEDS_MORE_INFO). **El kiosk NO auto-
selecciona el top por `confidence` sobre uno de menor confidence** — una variante
ambigua se queda ambigua. Si S30 asume que el consumidor confía en un umbral de
confidence para elegir automáticamente, eso sería drift latente: NO lo hagas. El
`confidence` es solo hint de orden, nunca un cutoff de auto-selección en el kiosk.
El lib DEBE aplicar su propio tenant-scope (el kiosk re-scopea defensivo, pero
jamás debe recibir filas de otro tenant).
