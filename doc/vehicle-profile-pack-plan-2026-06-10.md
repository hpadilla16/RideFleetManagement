# Vehicle Profile Pack — plan de diseño (2026-06-10)

**Estado: APROBADO por Hector 2026-06-10 noche.** Decisiones: (1) depreciación = declining
balance; (2) SÍ guardar documento/foto de la registración; (3) rotación por TIEMPO EN FLOTA o
MILLAJE — **regla a nivel de tenant** (setting), targets por vehículo (`targetFleetMonths` /
`targetFleetMiles`); (4) los tiles nuevos del dashboard REEMPLAZAN "Fee Advisories" y
"Stuck Checkouts".
Tres features del perfil de vehículo pedidas por Hector (specs en Monday, items del grupo Features).

## 0. Qué existe hoy (análisis)

- **Fotos de inventario**: `InventoryItem.photosJson` (Json; Supabase Storage refs con fallback
  base64, mismo flag `INSPECTION_PHOTOS_STORAGE_ENABLED`). Cada item tiene `vehicleId` +
  `sessionId` + `@@index([tenantId, vehicleId])` → el **historial por vehículo ya existe en la
  data**: items del vehículo ordenados por `createdAt`, agrupados por sesión. NO hay UI que lo
  muestre en el perfil (solo dentro del Inventory Helper y el PDF del reporte).
- **Vehicle Profile** (`frontend/src/app/vehicles/[id]/page.js`): tiles de specs (incl. el
  Fuel Tank de beta.156) + mileage history. Carga por `vehicles.service.getById` (include
  completo, sin select — columnas nuevas fluyen solas).
- **Vehicle model**: NO tiene nada de registración ni de costo/valor.
  (`registrationDocumentUrl` existe pero en HostVehicleSubmission — car sharing, otra cosa.)
- **Dashboard**: el Workspace Ops Hub (beta.149) tiene tiles clickables con counts del
  endpoint de summary → patrón listo para copiar.
- **Notificaciones**: no hay sistema in-app de notificaciones; el patrón de la casa =
  tile en dashboard + lista filtrable + mención en el morning-ops-report (8:00 AM).

## 1. Feature 1 — Fotos del inventario en el perfil (con historial)

- Sección nueva **"Inventory photos"** en el Vehicle Profile, SEPARADA del tracker de
  inspecciones: muestra el set de fotos del **último** InventoryItem del vehículo (con fecha
  de la sesión), y un selector/dropdown de sesiones anteriores para ver sets viejos.
- Backend: `GET /api/vehicles/:id/inventory-photos` → lista de sesiones del vehículo
  `{ sessionId, sessionDate, photoCount }` + las fotos de la sesión pedida (`?sessionId=`).
  Reusa el normalizador/los signed URLs que ya usa el Inventory Helper. Select SLIM (nunca
  arrastrar photosJson en el getById del perfil — lección del planner snapshot).
- Cero migración. Read-only.

## 2. Feature 2 — Registration expiration tracker

- Columna additive: `Vehicle.registrationExpiresAt DateTime?` (+ opcional
  `registrationDocumentUrl String?` si Hector quiere guardar foto/PDF del marbete — decisión #2).
- UI: campo fecha en Add/Edit Vehicle + tile "Registration" en el perfil
  (verde >30d · amarillo ≤30d · rojo vencida / "Not set").
- Dashboard: tile **"Registrations ≤30d"** (count, clickable → `/vehicles?registration=expiring`
  filtro nuevo espejo del patrón beta.149). Incluye vencidas.
- morning-ops-report: añade la lista de vehículos con registración por vencer (cambio de
  prompt de la tarea Cowork, sin código).

## 3. Feature 3 — Value tracker + rotación de flota

- Columnas additive en Vehicle:
  - `acquisitionCost Decimal(12,2)?` — costo inicial
  - `acquisitionDate DateTime?`
  - `depreciationAnnualPct Decimal(5,2)?` — "qué tan agresivo" (ej. 15/20/25%/año)
  - `targetFleetMonths Int?` — cuánto tiempo debe estar en flota
- **Valor actual = calculado, no almacenado** (declining balance):
  `currentValue = acquisitionCost × (1 − pct/100) ^ (mesesEnFlota/12)` — decisión #1.
- UI en el perfil: card "Value" con costo inicial, valor estimado hoy, % depreciado,
  meses en flota vs objetivo, y mini-curva de depreciación. Form inline (mismo permiso
  que editar vehículo).
- **Rotación**: vehículo "ready to rotate" cuando `hoy ≥ acquisitionDate + targetFleetMonths`
  (y "approaching" a ≤60 días). Dashboard tile **"Ready to rotate"** (count → lista filtrada
  `/vehicles?rotation=ready`) — esto da los "batches listos para venderse" por las reglas de
  cada compañía. morning-ops-report menciona el batch cuando hay ≥1.

## 4. Fases / ships

1. **Ship 1 (Fases A+B)**: migración additive (1 migración, 4-5 columnas) + endpoints +
   perfil completo (fotos de inventario, tile registration, card value). Migración por 5432.
2. **Ship 2 (Fase C)**: tiles del dashboard + filtros `/vehicles` (code-only).
3. **Fase D**: actualizar el prompt del morning-ops-report (sin deploy).
4. Data entry: el equipo llena registración y costos desde Edit Vehicle (no hay seed posible).

Nada de esto toca money paths (el valor es informativo; no factura). Tests: unit del cálculo
de depreciación + del clasificador de rotación; smoke del perfil por Hector.

## 5. Decisiones que necesito de Hector
1. **Depreciación**: ¿declining balance (% anual sobre el valor restante — recomendado, así
   se comportan los carros) o línea recta (% fijo del costo inicial por año)?
2. ¿Guardar también **documento/foto de la registración** (registrationDocumentUrl)?
3. "Ready to rotate": ¿solo por **tiempo en flota** (recomendado para v1) o también reglas de
   millaje/valor mínimo? (se pueden añadir después como reglas por tenant)
4. Dashboard: ¿los 2 tiles nuevos se AÑADEN al Ops Hub, o reemplazan alguno existente?
