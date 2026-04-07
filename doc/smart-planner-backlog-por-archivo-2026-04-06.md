# Smart Planner Backlog Tecnico Por Archivo

Fecha base: 2026-04-06

## Objetivo
Traducir la vision de `Smart Planner` en un backlog tecnico ejecutable por archivo para convertir el planner actual en un modulo con:

- snapshot por rango
- reglas configurables por tenant
- recomendaciones automaticas
- calculo de `carsNeeded` en overbooking
- simulacion de maintenance y wash buffers
- aplicacion transaccional de planes

## Vision Del Modulo
El planner debe dejar de depender de logica pesada en frontend y convertirse en un modulo real con tres capas:

1. `Planner Snapshot`
2. `Planner Rules Engine`
3. `Planner Recommendation + Actions Engine`

La UI debe consumir resultados calculados por backend, no ser la fuente primaria de decisiones.

## Scope Del Primer Corte
- `PlannerRuleSet`
- `GET /api/planner/rules`
- `PUT /api/planner/rules`
- `GET /api/planner/snapshot`
- `POST /api/planner/simulate-auto-accommodate`
- calculo de `carsNeeded`
- explicacion de recomendaciones por asignacion

Fuera de scope en este corte:
- optimizacion multi-tenant avanzada
- machine learning
- notificaciones automaticas
- publicacion automatica de maintenance plan
- telematics
- simulaciones historicas complejas

## Principios De Implementacion
1. No seguir cargando datasets completos en el frontend para resolver planner logic.
2. No aplicar bulk actions reservation por reservation sin capacidad transaccional.
3. Separar `hard constraints` de `soft scoring`.
4. Toda recomendacion debe incluir `why`.
5. Las reglas deben ser tenant-scoped.
6. El planner debe poder simular antes de aplicar.

## Orden Recomendado De Implementacion
1. `schema.prisma`
2. migration Prisma
3. modulo backend `planner`
4. `planner.rules.service.js`
5. `planner.service.js`
6. `planner.recommendation.service.js`
7. `planner.routes.js`
8. registrar router en `main.js`
9. adaptar `frontend planner` a `snapshot`
10. montar recommendations panel
11. montar `apply-plan` transaccional

## 1. [backend/prisma/schema.prisma](/Users/hectorpadilla/Code/RideFleetManagement/backend/prisma/schema.prisma)

### Cambios
- agregar enum `PlannerActionType`
- agregar enum `PlannerRecommendationType`
- agregar enum `PlannerRuleMode`
- agregar modelo `PlannerRuleSet`
- agregar modelo `PlannerScenario`
- agregar modelo `PlannerScenarioAction`
- agregar modelo `PlannerRecommendationAudit`

### Modelos Recomendados
- `PlannerRuleSet`
  - `tenantId`
  - `minTurnaroundMinutes`
  - `washBufferMinutes`
  - `prepBufferMinutes`
  - `maintenanceBufferMinutes`
  - `lockWindowMinutesBeforePickup`
  - `sameDayReservationBufferMinutes`
  - `allowCrossLocationReassignment`
  - `strictVehicleTypeMatch`
  - `allowUpgrade`
  - `allowDowngrade`
  - `defaultWashRequired`
  - `assignmentMode`
  - `maintenanceMode`
  - `vehicleTypeOverridesJson`
  - `locationOverridesJson`
  - `scoringWeightsJson`

- `PlannerScenario`
  - `tenantId`
  - `startAt`
  - `endAt`
  - `locationId`
  - `vehicleTypeId`
  - `scenarioType`
  - `status`
  - `summaryJson`
  - `rulesSnapshotJson`
  - `createdByUserId`

- `PlannerScenarioAction`
  - `scenarioId`
  - `reservationId`
  - `vehicleId`
  - `actionType`
  - `actionPayloadJson`
  - `reasonSummary`
  - `score`
  - `sortOrder`

- `PlannerRecommendationAudit`
  - `tenantId`
  - `recommendationType`
  - `reservationId`
  - `vehicleId`
  - `scenarioId`
  - `title`
  - `detail`
  - `recommendationJson`
  - `applied`
  - `appliedByUserId`
  - `appliedAt`

### Notas
- `PlannerRuleSet` debe ser `1:1` por tenant
- `rulesSnapshotJson` debe congelar las reglas usadas por la simulacion
- `PlannerScenarioAction` debe servir tanto para assignment como para maintenance/wash actions futuras

### Riesgos
- meter demasiada estructura innecesaria en v1
- no indexar por `tenantId` y rango
- no dejar claro que `scenario` es simulacion y no cambio aplicado

## 2. [backend/prisma/migrations/<nuevo-smart-planner>](/Users/hectorpadilla/Code/RideFleetManagement/backend/prisma/migrations)

### Cambios
- migration SQL para enums nuevos
- tablas nuevas de planner
- indices por `tenantId`
- indices por rango en `PlannerScenario`
- indices por `scenarioId` y `sortOrder` en `PlannerScenarioAction`

### Notas
- mantener esta migration separada de reservations/vehicles
- no mezclar backfills aqui

### Riesgos
- dejar enums sin uso claro
- no crear `Cascade` donde el tenant o scenario se borren

## 3. [backend/src/modules/planner/planner.routes.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.routes.js)

### Cambios
- crear router nuevo
- agregar endpoints:
  - `GET /rules`
  - `PUT /rules`
  - `GET /snapshot`
  - `POST /simulate-auto-accommodate`
  - `POST /simulate-maintenance`
  - `POST /simulate-wash-plan`
  - `POST /apply-plan`

### Responsabilidades
- validar query params y payloads
- devolver status codes correctos
- pasar `tenant scope`
- mantener este archivo delgado

### Recomendacion
- no meter scoring ni occupancy logic en routes
- toda logica de planner debe vivir en services dedicados

## 4. [backend/src/modules/planner/planner.rules.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.rules.service.js)

### Cambios
- implementar:
  - `getRuleSet(scope)`
  - `upsertRuleSet(payload, scope)`
  - `resolveEffectiveRules({ scope, locationId, vehicleTypeId })`
  - `validateRulePayload(payload)`
  - `normalizeRulePayload(payload)`

### Reglas Iniciales Recomendadas
- `minTurnaroundMinutes`
- `washBufferMinutes`
- `prepBufferMinutes`
- `maintenanceBufferMinutes`
- `lockWindowMinutesBeforePickup`
- `sameDayReservationBufferMinutes`
- `allowCrossLocationReassignment`
- `strictVehicleTypeMatch`
- `allowUpgrade`
- `allowDowngrade`
- `defaultWashRequired`

### Overrides Recomendados
- `vehicleTypeOverridesJson`
- `locationOverridesJson`
- `scoringWeightsJson`

### Riesgos
- reglas ambiguas entre default y override
- no normalizar booleans e ints
- dejar scoring weights sin fallback seguro

## 5. [backend/src/modules/planner/planner.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.service.js)

### Cambios
- implementar:
  - `getSnapshot({ start, end, locationId, vehicleTypeId }, scope)`
  - `loadPlannerReservations(...)`
  - `loadPlannerVehicles(...)`
  - `loadPlannerBlocks(...)`
  - `buildOccupancyMap(...)`
  - `buildTrackRows(...)`
  - `buildPlannerCounters(...)`
  - `calculateShortage(...)`

### Responsabilidades
- devolver solo la data del rango visible
- construir tracks listos para UI
- marcar reservations:
  - `assigned`
  - `unassigned`
  - `overbooked`
  - `locked`
- calcular:
  - `pickups`
  - `returns`
  - `checkedOut`
  - `serviceHolds`
  - `unassigned`
  - `overbooked`
  - `carsNeeded`

### Recomendacion
- reusar logica util existente de overlap y blocks donde sirva
- no depender de cargar todos los agreements si no son necesarios para snapshot

### Riesgos
- repetir la logica actual del frontend sin limpiarla
- traer payloads demasiado pesados
- no filtrar por rango correctamente

## 6. [backend/src/modules/planner/planner.recommendation.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.recommendation.service.js)

### Cambios
- implementar:
  - `simulateAutoAccommodate(input, scope)`
  - `recommendVehicleForReservation(...)`
  - `scoreVehicleFit(...)`
  - `explainVehicleRecommendation(...)`
  - `simulateMaintenance(input, scope)`
  - `findMaintenanceSlots(...)`
  - `simulateWashPlan(input, scope)`
  - `findWashSlots(...)`

### Hard Constraints
- no overlap
- no mover `CHECKED_OUT`
- respetar `lockWindowMinutesBeforePickup`
- respetar availability blocks
- respetar `strictVehicleTypeMatch` cuando aplique
- respetar `allowCrossLocationReassignment`

### Soft Scoring
- exact match por vehicle type
- misma home location
- menor idle gap
- menor impacto futuro
- menos movimientos
- wash/prep/turnaround con mejor margen

### Output Recomendado
Cada recomendacion debe devolver:
- `reservationId`
- `recommendedVehicleId`
- `score`
- `reasons[]`
- `constraintViolations[]`

### Riesgos
- scoring opaco
- recomendaciones sin explicacion
- mezclar shortage con assignment suggestions en una sola estructura confusa

## 7. [backend/src/modules/planner/planner.actions.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.actions.service.js)

### Cambios
- implementar:
  - `applyScenario({ scenarioId, actions, scope, actorUserId })`
  - `validateScenarioActions(...)`
  - `applyAssignVehicle(...)`
  - `applyUnassignVehicle(...)`
  - `applyCreateWashBlock(...)`
  - `applyCreateMaintenanceBlock(...)`
  - `writePlannerAudit(...)`

### Responsabilidades
- aplicar plan aprobado en transaccion
- revalidar conflictos justo antes del commit
- escribir auditoria del plan aplicado

### Recomendacion
- reemplazar el patron actual de PATCH uno por uno para bulk ops
- dejar `apply-plan` listo para crecer a maintenance/wash sin rediseño

### Riesgos
- aplicar parcialmente si una accion falla
- no revalidar conflictos al final
- no registrar `why` del cambio aplicado

## 8. [backend/src/main.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/main.js)

### Cambios
- registrar router nuevo:
  - `app.use('/api/planner', requireAuth, requireModuleAccess('planner'), plannerRouter);`

### Notas
- `planner` ya existe como modulo en access control
- el backend debe honrar ese boundary, no solo el frontend

### Riesgos
- dejar la pagina protegida solo por UI
- mezclar planner con `reservations` route guard unicamente

## 9. [frontend/src/app/planner/page.js](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/planner/page.js)

### Cambios

#### Fase 1
- reemplazar carga inicial por:
  - `GET /api/planner/snapshot`
  - `GET /api/planner/rules`

#### Fase 2
- reemplazar `autoAssignUnassignedReservations` por:
  - `POST /api/planner/simulate-auto-accommodate`

#### Fase 3
- mostrar paneles nuevos:
  - recomendaciones
  - `carsNeeded`
  - shortage por date/location/type

#### Fase 4
- agregar `Apply Plan`
  - `POST /api/planner/apply-plan`

### Responsabilidades Que Deben Salir De Aqui
- scoring
- occupancy truth
- shortage calculation
- multi-step assignment logic
- maintenance slot selection
- wash slot selection

### Riesgos
- seguir creciendo un archivo ya demasiado grande
- mantener fetches legacy y nuevos al mismo tiempo por demasiado tiempo
- mezclar simulation state y applied state sin separacion clara

## 10. [frontend/src/app/planner/PlannerBoard.jsx](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/planner/PlannerBoard.jsx)

### Cambios
- componente nuevo para timeline principal
- recibe `tracks`, `range`, `selectedReservation`, `selectedBlock`, `onDropDraft`

### Responsabilidades
- render del board
- drag/drop visual
- no calcular decisiones

## 11. [frontend/src/app/planner/PlannerOpsSummary.jsx](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/planner/PlannerOpsSummary.jsx)

### Cambios
- componente nuevo para counters principales
- mostrar:
  - pickups
  - returns
  - checkedOut
  - holds
  - unassigned
  - overbooked
  - `carsNeeded`

## 12. [frontend/src/app/planner/PlannerRecommendations.jsx](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/planner/PlannerRecommendations.jsx)

### Cambios
- componente nuevo para recommendations panel
- mostrar:
  - assignment suggestions
  - unresolved reservations
  - shortage summary
  - maintenance slots
  - wash warnings

### Recomendacion
- cada card debe enseñar `why`

## 13. [frontend/src/app/planner/PlannerRulesPanel.jsx](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/planner/PlannerRulesPanel.jsx)

### Cambios
- componente nuevo para editar reglas del tenant
- guardar via `PUT /api/planner/rules`

### Recomendacion
- separar `hard rules` de `optimization preferences`

## 14. [frontend/src/lib/client.js](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/lib/client.js)

### Cambios
- opcionalmente agregar helpers:
  - `getPlannerSnapshot`
  - `getPlannerRules`
  - `savePlannerRules`
  - `simulatePlannerAutoAccommodate`
  - `simulatePlannerMaintenance`
  - `simulatePlannerWashPlan`
  - `applyPlannerPlan`

### Recomendacion
- mantener API surface clara para el planner

## Payloads Recomendados

## `GET /api/planner/snapshot`

Debe devolver:
- `range`
- `filters`
- `counters`
- `tracks`
- `unassignedReservations`
- `overbookedReservations`
- `shortage`
- `recommendationSummary`

## `POST /api/planner/simulate-auto-accommodate`

Debe devolver:
- `scenarioId`
- `summary`
- `actions`
- `unresolved`

## `POST /api/planner/apply-plan`

Debe devolver:
- `applied`
- `appliedCount`
- `auditId`

## Tests / Smoke Tests Sugeridos

### Backend
- `rules` devuelven defaults si no existe config
- `snapshot` devuelve solo data del rango pedido
- `simulate-auto-accommodate` respeta hard constraints
- `carsNeeded` se calcula correctamente en overbooking real
- `apply-plan` es transaccional

### Frontend
- planner renderiza snapshot sin cargar listas globales completas
- recommendations muestran `why`
- simular no aplica cambios
- aplicar plan refresca snapshot correctamente

## Definicion De Done Del Primer Corte
- existe `PlannerRuleSet` por tenant
- el planner puede leer reglas
- el planner puede pedir `snapshot` por rango
- el planner puede simular auto-accommodate
- el planner puede mostrar `carsNeeded`
- cada recomendacion incluye razon legible
- no se requieren listas completas de reservations/vehicles/agreements para la pantalla principal

## Siguiente Paso Recomendado
Empezar por un primer corte pequeno pero de alto impacto:

1. `schema.prisma`
2. migration
3. `planner.rules.service.js`
4. `planner.service.js`
5. `planner.recommendation.service.js`
6. `planner.routes.js`
7. registrar router en `main.js`
8. conectar `frontend planner` a `snapshot`

Ese corte ya nos deja una base real para que el planner evolucione hacia:

- shortage forecasting
- maintenance scheduling
- wash planning
- explainable dispatch recommendations
