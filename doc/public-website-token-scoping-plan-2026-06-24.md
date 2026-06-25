# Plan — Conectar "Rent & Go by VPH Motors" a RFM vía X-Tenant-Token (solo este tenant)

**Fecha:** 2026-06-24 · **Tenant:** `rent-by-vphmotors` · **Estado:** PLAN (pendiente confirmación) · **SEGURIDAD-crítico**

## Hallazgos de la investigación (lo que cambia el plan)

### Hallazgo 1 — El modelo `Tenant` NO tiene token ni logo (hay que migrar)
`Tenant` tiene `slug`, `name`, `status` ✓ — pero **NO** `websiteToken` ni `companyLogoUrl`.
→ Migración aditiva: `websiteTokenHash TEXT` (hash del token, NO el token en claro) + `companyLogoUrl TEXT`.
(`companyName` lo cubre el `name` existente.)

### Hallazgo 2 — Los endpoints públicos existen pero con OTROS nombres/shapes que el contrato del sitio
El sitio espera `rent/search`, `rent/:id`, `booking/bootstrap`, `booking/website-fees`, `booking/checkout`.
La realidad en RFM (`public-booking.routes.js`):

| Sitio espera | RFM real | Shape real (keys) |
|---|---|---|
| `GET booking/bootstrap` | ✓ `GET /api/public/booking/bootstrap` | `{ tenantId, tenants[], locations[], vehicleTypes[], featuredCarSharingListings[], carSharingSearchPlaces[], bookingModes }` |
| `GET rent/search` | `GET /api/public/booking/vehicle-classes?pickupLocationId&pickupAt&returnAt` (o `POST booking/rental-search`) | `{ tenant, pickupAt, returnAt, locationScope[], classes:[{ vehicleType, advertisedDailyRate, availableUnits, available, locations[] }] }` |
| `GET rent/:vehicleTypeId` | **NO existe equivalente directo** (el detalle sale del item de la lista) | — (decidir: ¿añado `GET booking/vehicle-classes/:id`, o el sitio usa el item de la lista?) |
| `GET booking/website-fees` | ✓ `GET /api/public/booking/website-fees?...` | `{ tenantId, fees:[{ id, code, name, amount, mode, taxable, mandatory, displayOnline }] }` ✅ ya machea |
| `POST booking/checkout` | ✓ `POST /api/public/booking/checkout` | `{ reservationNumber, reservationId, status, pickupAt, returnAt, estimatedTotal, paymentStatus }` |

→ Per tu nota ("si los nombres difieren, dime el shape y yo ajusto el mapeo en `api-client.ts`"): **te paso estos shapes reales**; tú adaptas el sitio. Lo único a decidir: el `rent/:id` (detalle de clase) — ¿lo añado al backend o lo derivas de la lista?

### Hallazgo 3 — El fail-closed debe ser RETROCOMPATIBLE (no romper otros tenants / la app Flutter)
Hoy `/api/public/booking/*` se monta **sin requireAuth** y resuelve el tenant por `?tenantSlug=`/`?tenantId=`
(lo usan la app guest Flutter y potencialmente otros). Si hago el `X-Tenant-Token` **obligatorio en todo**
`/api/public/*`, **rompo a esos clientes**. Diseño propuesto (retrocompatible + fail-closed para el sitio):

- Request **CON** `X-Tenant-Token` → se resuelve+valida; si es válido **fuerza** el scope a ESE tenant
  (ignora cualquier `?tenantSlug`); si es **inválido/malformado → 401** (alguien intentó con token malo).
- Request **SIN** el header → comportamiento actual (`?tenantSlug`) para los clientes existentes.
- El **sitio SIEMPRE manda el token y NO manda slug** → sin token, no hay slug → **vacío** (fail-closed natural).
  Esto satisface tu contract test ("sin token → vacío/401") sin tocar a nadie más. ✅

## Diseño del middleware (el corazón)
- Migración: `Tenant.websiteTokenHash` (sha256 del token; comparo hasheando el header — el claro nunca se guarda).
- Middleware `resolvePublicTenantToken` montado ANTES de los routers de `/api/public/booking`:
  lee `X-Tenant-Token` → si está, `sha256` → `prisma.tenant.findFirst({ where:{ websiteTokenHash, status:'ACTIVE' } })`
  → setea `req.publicTokenTenantId`. Header presente pero sin match → **401 fail-closed**.
- En `resolvePublicTenant`/`resolvePublicTenantContext`: si `req.publicTokenTenantId` existe, **se usa ese**
  (override) y se ignora slug/id del query. Todas las queries Prisma de esos endpoints ya scopean por ese tenantId.
- Coexiste con el `Authorization: Bearer`/magic-link (esos flujos no se tocan; el token es ortogonal).

## Entregables (qué construyo yo vs qué corres tú)
**Construyo (código + scripts, tú revisas + deployas):**
1. Migración `websiteTokenHash` + `companyLogoUrl`.
2. Middleware `X-Tenant-Token` + wiring en `/api/public/booking/*` + override en `resolvePublicTenant`.
3. (decisión rent/:id) endpoint de detalle de clase si lo quieres en backend.
4. Script de seed `tenant-seed-rent-vphmotors.mjs` (Tenant ACTIVE + companyName/logo, Locations, Vehicle Classes,
   Rates, Fees con `displayOnline=true`, Taxes) — patrón de `tenant-seed-beta.mjs`.
5. Script `gen-website-token.mjs <slug>` → genera token aleatorio largo, guarda el HASH en el tenant, **imprime el token en claro UNA vez**.
6. Test de aislamiento del token (`v9-website-token-isolation.mjs`): token de A + slug de B → no devuelve data de B; sin token → vacío/401. Lo añado a `run-suite.mjs`.

**Corres tú (necesitan DB/secretos que yo no tengo):**
- Migración por 5432 (staging→prod), seed, `gen-website-token` (te da el token), `run-suite.mjs`, capturar el JSON real de bootstrap.

## Lo que te devuelvo al final (para flippear el sitio)
a) El token (lo genera tu corrida de `gen-website-token`, yo no lo veo). b) `RFM_API_BASE` prod = `https://ridefleetmanager.com` (el de **staging me lo tienes que dar**). c) Confirmación tenant ACTIVE + sembrado. d) JSON real de `bootstrap` (de tu corrida). e) Suite de aislamiento verde.

## Necesito de ti antes de codear
1. **Confirmar el diseño retrocompatible** del Hallazgo 3 (token presente=scoped/fail-closed; ausente=comportamiento actual) — para NO romper la app Flutter/otros.
2. **`rent/:id`**: ¿añado endpoint de detalle de clase en backend, o lo derivas del item de la lista en el sitio?
3. **`RFM_API_BASE` de staging** (URL, sin slash) — para documentarlo. (Prod ya lo sé.)

OUT OF SCOPE (no se construye ahora): loaner, Dejavoo, AutoExpreso.
