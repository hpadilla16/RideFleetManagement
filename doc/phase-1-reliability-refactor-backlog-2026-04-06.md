# Phase 1 Reliability + Refactor Backlog

Fecha base: 2026-04-06

## Objetivo
Traducir `Phase 1` del roadmap en un backlog tecnico por archivo para fortalecer la base del producto antes de seguir profundizando:

- refactor de hotspots grandes
- mejor estructura de frontend/backend
- pruebas y contratos minimos
- validacion de payloads
- hardening de endpoints publicos
- base mas confiable para `Planner Autopilot`, `Inspection Intelligence 2.0` y `Zubie` real

## Resultado Esperado
Al terminar esta fase, el sistema debe quedar:

- mas facil de mantener
- menos riesgoso de extender
- con mejor cobertura de rutas criticas
- con menos archivos gigantes
- mejor preparado para multi-tenant growth y connected operations

## Scope De Esta Fase
- dividir pantallas y services demasiado cargados
- crear scripts claros de verificacion
- ampliar tests de planner, telematics e inspection intelligence
- agregar validacion estructurada en rutas criticas
- agregar protecciones operacionales basicas a endpoints publicos

Fuera de scope en esta fase:
- partnership real de `Zubie`
- OAuth2 completo de providers
- `Planner Autopilot` aplicando escenarios generados por AI
- rediseño visual profundo del producto
- migracion a TypeScript

## Orden Recomendado De Implementacion
1. scripts y base de verificacion
2. validacion + hardening backend
3. refactor frontend planner
4. refactor frontend settings
5. refactor backend reservations / agreements
6. tests de contrato y smoke tests

## Principios De Implementacion
1. No seguir creciendo archivos de 1k-3k lineas como unidad principal de trabajo.
2. Toda ruta publica o sensible debe tener validacion y respuestas predecibles.
3. Toda integracion externa debe dejar metadata y trazabilidad clara.
4. El planner debe quedarse como modulo explicable y testeable, no como logica dispersa.
5. Antes de meter mas AI, hay que endurecer los bordes del sistema.

## Backlog Por Archivo

## 1. [frontend/package.json](/Users/hectorpadilla/Code/RideFleetManagement/frontend/package.json)

### Cambios
- agregar scripts:
  - `test`
  - `test:planner`
  - `test:smoke`
  - `verify`
  - `lint` si se instala linter

### Objetivo
- que frontend tenga una puerta de calidad clara antes de merge o release

### Riesgos
- seguir dependiendo solo de `npm run build`
- no detectar regresiones funcionales del planner hasta muy tarde

## 2. [backend/package.json](/Users/hectorpadilla/Code/RideFleetManagement/backend/package.json)

### Cambios
- agregar scripts:
  - `test`
  - `test:vehicles`
  - `test:planner`
  - `verify`
- dejar un flujo estandar para correr checks locales

### Objetivo
- que backend tenga una rutina repetible de calidad

### Riesgos
- hoy no hay `test` formal del backend
- demasiada dependencia en checks manuales

## 3. Nuevo helper sugerido: `backend/src/lib/request-validation.js`

### Cambios
- crear helpers minimos para:
  - `requireString`
  - `optionalString`
  - `optionalBoolean`
  - `optionalNumber`
  - `requireDateRange`
  - `assertEnum`

### Objetivo
- evitar validacion repetida y regex sueltas en routes

### Responsabilidades
- normalizar payloads
- lanzar errores claros
- dejar una base para crecer a `zod` o schema validation despues

## 4. Nuevo middleware sugerido: `backend/src/middleware/public-endpoint-guards.js`

### Cambios
- crear middleware reusable para:
  - rate limiting simple en memoria por IP
  - idempotency key opcional
  - request logging de endpoints publicos

### Uso Inicial
- `api/public/booking`
- `api/public/issues`
- `api/public/telematics/zubie/:tenantId/webhook`

### Riesgos
- sin esto, los endpoints publicos quedan muy abiertos para abuse o retries ruidosos

## 5. [backend/src/main.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/main.js)

### Cambios
- registrar guards/middleware de endpoints publicos
- considerar headers basicos de seguridad
- mantener `request id` o al menos punto central de observabilidad

### Objetivo
- endurecer el borde del backend sin rehacer toda la app

### Riesgos
- mantener endpoints publicos sin proteccion comun

## 6. [backend/src/modules/planner/planner.routes.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.routes.js)

### Cambios
- mover validaciones de payloads a helpers compartidos
- dejar respuestas mas consistentes entre:
  - `snapshot`
  - `simulate-auto-accommodate`
  - `simulate-maintenance`
  - `simulate-wash-plan`
  - `copilot`
  - `apply-plan`

### Objetivo
- bajar complejidad del router
- dejar cada endpoint mas predecible

### Riesgos
- hoy el archivo esta aceptable, pero va a crecer rapido con `Planner Autopilot`

## 7. [backend/src/modules/planner/planner.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.service.js)

### Cambios
- separar helpers internos en archivos nuevos:
  - `planner-query.service.js`
  - `planner-occupancy.service.js`
  - `planner-shortage.service.js`
  - `planner-track-layout.service.js`

### Objetivo
- que `getSnapshot` quede como orquestador y no como archivo “todo en uno”

### Riesgos
- seguir metiendo mas logica operativa aqui vuelve el modulo fragil

## 8. [backend/src/modules/planner/planner.copilot.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.copilot.service.js)

### Cambios
- separar:
  - heuristics
  - AI request builder
  - AI response normalization
  - usage logging wrapper
- crear archivo nuevo sugerido:
  - `planner.copilot.heuristics.js`
  - `planner.copilot.openai.js`

### Objetivo
- dejar lista una base limpia para `Planner Autopilot`

### Riesgos
- hoy mezcla heuristica, contrato AI, fetch externo y assembly de respuesta

## 9. [backend/src/modules/planner/planner.recommendation.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/planner/planner.recommendation.service.js)

### Cambios
- separar:
  - assignment scoring
  - maintenance recommendation
  - wash recommendation
  - scenario persistence

### Archivos sugeridos
- `planner.assignment.service.js`
- `planner.maintenance.service.js`
- `planner.wash.service.js`
- `planner.scenario.service.js`

### Objetivo
- reducir acoplamiento antes de montar autopilot multi-plan

## 10. [backend/src/modules/vehicles/vehicles.routes.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/vehicles/vehicles.routes.js)

### Cambios
- centralizar validacion de telematics payloads
- endurecer el public webhook de Zubie:
  - documentar headers esperados
  - considerar idempotency por delivery id
  - dejar responses mas diagnosticas

### Objetivo
- preparar la transicion de placeholder a connector real

### Riesgos
- recibir retries duplicados del provider
- debugging dificil sin contrato claro

## 11. [backend/src/modules/vehicles/vehicles.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/vehicles/vehicles.service.js)

### Cambios
- separar subareas en archivos nuevos:
  - `vehicle-telematics.service.js`
  - `vehicle-availability.service.js`
  - `vehicle-profile.service.js`

### Objetivo
- no seguir concentrando vehicle CRUD, telematics, availability y profile assembly en un solo archivo

### Riesgos
- archivo ya esta creciendo rapido por telematics y readiness

## 12. [backend/src/modules/vehicles/vehicle-intelligence.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/vehicles/vehicle-intelligence.service.js)

### Cambios
- dividir:
  - `inspection intelligence`
  - `damage triage`
  - `telematics scoring`
  - `turn-ready scoring`

### Archivos sugeridos
- `vehicle-inspection-intelligence.service.js`
- `vehicle-damage-triage.service.js`
- `vehicle-telematics-signals.service.js`
- `vehicle-turn-ready.service.js`

### Objetivo
- dejar el motor de inteligencia mas modular y mas facil de probar

### Riesgos
- hoy concentra demasiadas decisiones criticas en un solo archivo

## 13. [backend/src/modules/rental-agreements/rental-agreements.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/rental-agreements/rental-agreements.service.js)

### Cambios
- identificar y extraer subservices:
  - agreement lifecycle
  - inspection flows
  - payments/charges
  - document/email assembly

### Objetivo
- bajar el hotspot mas grande del backend

### Riesgos
- cualquier cambio aqui tiene alto riesgo de regresion
- hoy es dificil aislar pruebas utiles por responsabilidad

## 14. [backend/src/modules/reservations/reservations.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/reservations/reservations.service.js)

### Cambios
- separar:
  - reservation updates
  - planner-affecting updates
  - assignment/conflict checks
  - request/payment helpers

### Objetivo
- preparar mejor el contrato entre reservations y planner

### Riesgos
- logica de negocio duplicada entre reservations y planner con el tiempo

## 15. [frontend/src/app/planner/page.js](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/planner/page.js)

### Cambios
- dividir en componentes:
  - `PlannerBoard.jsx`
  - `PlannerHeader.jsx`
  - `PlannerFilters.jsx`
  - `PlannerSidebar.jsx`
  - `PlannerRecommendations.jsx`
  - `PlannerRulesPanel.jsx`
  - `PlannerCopilotPanel.jsx`
  - `PlannerMaintenancePanel.jsx`
  - `PlannerWashPanel.jsx`

### Objetivo
- bajar complejidad del planner y hacer mas facil meter `Autopilot`

### Riesgos
- seguir extendiendo la misma page vuelve mas caro cualquier cambio

## 16. [frontend/src/app/planner/planner-utils.mjs](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/planner/planner-utils.mjs)

### Cambios
- mantener como capa pura de helpers de UI
- mover cualquier logica no-UI que se cuele hacia backend o adapters

### Objetivo
- no duplicar reglas del planner entre cliente y servidor

## 17. [frontend/src/app/settings/page.js](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/settings/page.js)

### Cambios
- dividir por dominio:
  - `SettingsCompanyPanel.jsx`
  - `SettingsPaymentsPanel.jsx`
  - `SettingsPlannerCopilotPanel.jsx`
  - `SettingsTelematicsPanel.jsx`
  - `SettingsLocationsPanel.jsx`
  - `SettingsRatesPanel.jsx`
  - `SettingsInsurancePanel.jsx`
  - `SettingsTenantModulesPanel.jsx`

### Objetivo
- bajar el archivo mas grande del frontend
- hacer mas facil seguir creciendo tenant features

### Riesgos
- mezclar demasiados estados y loaders en una sola pantalla

## 18. [frontend/src/app/vehicles/[id]/page.js](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/vehicles/[id]/page.js)

### Cambios
- separar bloques:
  - profile summary
  - operational intelligence
  - telematics management
  - reservation timeline

### Objetivo
- dejar el profile listo para cuando llegue `Zubie` real y mas trazabilidad de signals

## 19. Nuevo test backend: `backend/src/modules/planner/planner.snapshot.test.mjs`

### Cobertura sugerida
- rango invalido
- shortage correcto
- overbooked detection
- counters de turn-ready / inspection / telematics

## 20. Nuevo test backend: `backend/src/modules/planner/planner.apply-plan.test.mjs`

### Cobertura sugerida
- apply de assign vehicle valido
- conflicto por overlap
- conflicto por hold activo
- wash/maintenance block conflict
- transaccion no parcial

## 21. Nuevo test backend: `backend/src/modules/planner/planner.copilot.test.mjs`

### Cobertura sugerida
- heuristic fallback
- bloqueo por plan
- bloqueo por model
- cap mensual
- shape de respuesta consistente

## 22. [backend/src/modules/vehicles/telematics-zubie.test.mjs](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/vehicles/telematics-zubie.test.mjs)

### Cambios
- ampliar cobertura para:
  - payload variants
  - missing fields
  - metadata mapping
  - public webhook request metadata
  - payload version normalization

## 23. Nuevo smoke frontend sugerido: `frontend/src/app/planner/planner-smoke.test.mjs`

### Cobertura sugerida
- helpers de render state
- copilot config adapters
- planner rules form adapters
- timeline calculations

## 24. Docs de operacion sugeridos

### Archivo nuevo
- `doc/phase-1-verification-checklist-2026-04-06.md`

### Contenido sugerido
- comandos de verificacion
- areas de smoke manual
- checklist antes de seguir a `Phase 2`

## Riesgos Principales De La Fase
1. Refactor sin tests suficientes.
2. Seguir mezclando UI state, API calls y business logic en pages gigantes.
3. Meter AI/autopilot encima de bordes todavia fragiles.
4. No endurecer endpoints publicos antes de integraciones reales.

## Definition Of Done
- frontend y backend tienen scripts `test` o `verify` claros
- planner y telematics tienen cobertura basica real
- hotspots principales estan divididos
- rutas publicas tienen protecciones minimas
- `npm run build` y suite minima pasan de forma repetible

## Siguiente Paso Recomendado
Arrancar con este orden:

1. `package.json` scripts
2. `request-validation.js` + `public-endpoint-guards.js`
3. refactor de `planner/page.js`
4. tests backend del planner
5. refactor de `settings/page.js`

