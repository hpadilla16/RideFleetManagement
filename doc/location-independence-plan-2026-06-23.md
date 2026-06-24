# Plan — Locations como negocios independientes (multi-location)

**Fecha:** 2026-06-23 · **Pedido por:** Hector (para Triangle) · **Estado:** PLAN (pendiente aprobación)

## Objetivo
Que cada Location dentro de un tenant funcione como un **local independiente**: su propia flota,
sus propios usuarios (que ven SOLO su(s) location(s)), y sus propios rates/fees/services. Con la
opción de que algunos usuarios vean **todas** las locations.

## Estado actual (del mapeo del código)
**YA existe (por-location):**
- `Vehicle.homeLocationId` — flota asignable a location ✓
- `Reservation`/`RentalAgreement`: `pickupLocationId` + `returnLocationId` (requeridos) ✓
- **`FeeRate`**: override de 3 niveles **ya implementado** (location → tenant default → hardcoded),
  con `resolveRate()` + UI de scope ✓ (lo más completo)
- `Rate.locationId`, `AdditionalService.locationId`, `LocationFee` (join) — existen pero **sin
  lógica de resolución/filtrado** (parcial)
- `Location`: tiene `taxRate`, `locationConfig` (JSON), fees asociados

**FALTA de raíz:**
1. **Binding usuario↔location** — el modelo `User` NO tiene ningún campo de location. No hay forma
   de restringir a un usuario a su location.
2. **Enforcement** — `scopeFor()` es **solo por tenant**; NINGUNA lista filtra por location hoy
   (vehicles/reservations/customers devuelven TODO el tenant).
3. **UI** — People no tiene selector de location; la config por-location de rates/services no tiene UI.

## Decisiones de diseño (recomendadas — confirmar)
1. **Modelo de binding:** `User.locationIds` (JSON array de locationIds) en vez de tabla join —
   más simple y se hidrata fácil en la sesión (`req.user.locationIds`) para filtrar queries.
2. **Semántica "todas":** `locationIds` vacío/null = **ve TODAS las locations** (sin restricción).
   → Cero regresión: los usuarios actuales siguen viendo todo hasta que les asignes locations.
3. **ADMIN/SUPER_ADMIN siempre ven todas** (bypass del filtro), como el patrón del rate-limiter.
   El scoping aplica a OPS/AGENT/staff con locationIds asignadas.
4. **Qué se filtra por location:** Vehicles (`homeLocationId`), Reservations (pickup **o** return
   dentro del set permitido), Planner, Maintenance/Repair Orders, Dashboard KPIs.
   **Customers se quedan tenant-wide** (no están atados a location) — confirmar.

---

## FASE 1 — Binding usuario↔location (asignar, sin enforcement aún) · riesgo BAJO
- Migración aditiva: `User.locationIds String?` (JSON).
- Hidratación de sesión (`getSessionUser`/`buildSessionUser`) incluye `locationIds` → `req.user.locationIds`.
- **People UI**: multi-select de locations por usuario (vacío = todas). Backend user create/update
  acepta `locationIds` (valida que pertenezcan al tenant).
- Resultado: ya puedes **asignar** users a locations. Aún no restringe nada (seguro, sin regresión).

## FASE 2 — Enforcement de visibilidad (el corazón) · riesgo MEDIO
- Helper `locationScopeFor(req)` → `{ allowedLocationIds: [...] | null }` (null = todas; admins = null).
- Aplicar el filtro en las listas/queries, cada una con su campo correcto:
  - **Vehicles** → `homeLocationId in allowed`
  - **Reservations** → `pickupLocationId in allowed OR returnLocationId in allowed`
  - **Planner / Maintenance / Repair Orders / Dashboard KPIs** → por su location
- Guardas: un usuario scopeado que abra por id un recurso fuera de su location → 403/404.
- Tests por módulo (un user de location A no ve data de B; un user sin restricción ve todo).

## FASE 3 — Config independiente por location (rates/fees/services) · riesgo MEDIO
- **Fees**: `FeeRate` ya soporta override por location → solo falta **UI** de "setup por location"
  (selector de location en Settings → Fees) para que cada local monte los suyos.
- **Rates**: agregar resolución por-location (location override → tenant default) + UI por location.
- **Services** (`AdditionalService`): filtrar/resolver por location + UI.
- **Location config**: panel "administrar este local" (rates/fees/services/tax de esa location).
- Resultado: cada location monta su operación completa, independiente.

## FASE 4 (opcional) — contexto de location en audit/comisiones
- `AuditLog`/`AgreementCommission` con locationId para reportes y trazabilidad por local.

---

## Entrega
- **Fase 1 primero** (asignar users a locations — desbloquea montar Triangle con la estructura correcta,
  sin riesgo). Migración aditiva + People UI.
- **Fase 2** (enforcement) — el grueso; se prueba módulo por módulo.
- **Fase 3** (config independiente por location).
Cada fase = su propio `beta.NNN`, Hector revisa diff + deploya. Money-adjacent en Fase 3 (rates/fees).

## Para Triangle
Con **Fase 1 + 2** ya tienes lo que pediste: flota por location + users que ven solo su location (o
todas). La **Fase 3** les da el "local completamente independiente" (sus propios rates/fees/services).
