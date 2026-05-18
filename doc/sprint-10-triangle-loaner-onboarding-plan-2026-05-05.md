# Sprint 10 — Triangle Loaner Onboarding Plan

Fecha base: 2026-05-05

## Context

Tuvimos meeting con el prospect `Triangle` (dealership, hasta 200 vehiculos en
loaner). La propuesta comercial ya fue enviada (referencia: `Opcion C` en
`doc/dealership-loaner-service-proposal-200-vehicles-2026-03-26.md`).

De ese meeting salieron `7` action items de producto. Este documento:

- consolida esos 7 items dentro del roadmap actual
- los ordena por dependencia y riesgo
- los reparte en `Sprint 10`, `Sprint 11`, `Sprint 12`
- define los agentes/work-streams necesarios para ejecutarlos
- mantiene en flight el cierre de `Phase 3 perf` ya en progreso

## Triangle Action Items — Source

Capturados directamente del meeting:

1. `Finalized proposal` — Enviar al owner. **DONE.**
2. `Inventory separation` — separar inventario de rental vs loaner.
3. `Revenue reporting` — reportes que muestren cuanto revenue genera cada carro.
4. `ID scanner integration` — scanner que auto-popule customer info al preparar contratos.
5. `Loaner module cleanup` — cada seccion del modulo loaner con proposito claro.
6. `CESCO ticket analyzer` — automatizado, matchea tickets a vehiculos del sistema, link a reservation/loaner, daily email al admin.
7. `Reports module overhaul` — Balance Sheet, Reservations, Inventory, P&L, Vehicle Cost vs Revenue.

## Where We Are Today (Code Reality Check)

Verificado contra el codebase actual antes de planear:

- `Loaner` ya existe como `workflowMode = DEALERSHIP_LOANER` en
  `backend/src/modules/dealership-loaner/`. Tiene intake, swaps, extensions,
  borrower packet, dealer statements, accounting closeout.
- `Vehicle` model tiene `fleetMode` enum `RENTAL_ONLY | CAR_SHARING_ONLY | BOTH`,
  pero **no** tiene un program/category que separe `rental` de `loaner`. El
  loaner hoy se infiere por la reservation, no por el vehiculo.
- `Reports` module tiene solo: `Overview`, `Services Sold`, `Contracts Excel`.
  No hay Balance Sheet, P&L, Inventory report, ni Vehicle Cost vs Revenue.
- Per-vehicle revenue: el data model lo soporta (Reservation -> RentalAgreement
  -> Charges, todos con `vehicleId`), pero **no existe** la query de roll-up.
- `Customer` model guarda `licenseNumber`, `idPhotoUrl`, `insuranceDocumentUrl`,
  pero **no** hay OCR ni parsing — son uploads manuales.
- `CESCO` — cero codigo. Modulo no existe.
- Triangle — referenciado en `doc/triangle-dealership-loaner-presentation-2026-03-24.md`.
  Sin estado de signed en codigo.

## Integration With Active Roadmap

El roadmap activo al `2026-05-05` ya tiene en flight:

- `Phase 3 perf L-2` (summary counters) — branch lista para merge
- `Phase 2 perf` mediums (M-1 hydrate parallel, M-4 SWR list, M-5 code-split detail)
- `Sentry sample rate` 0 -> 0.1
- `Prisma slow-query logging`

Reglas de integracion con los 7 nuevos items:

- el merge de `L-2` se mantiene esta semana (low risk, ya esta listo)
- `Phase 2` mediums se intercalan como background, no bloquean Triangle
- los items de Triangle toman prioridad sobre M-3/M-6 (los menos urgentes)
- la decision de `counter scheduler` (background vs reactive) se difiere

## Sequencing Strategy

Tres olas de tres semanas. Optimizadas por:

- dependencias de schema (inventory separation desbloquea casi todo)
- riesgo (CESCO es lo mas incierto, spike primero)
- cierre del deal Triangle (lo que ven en demo y onboarding va primero)
- quick wins que validan que estamos avanzando

### Sprint 10 — Foundations (May 5–11)

Objetivo: poner las bases que todo lo demas necesita, mas un par de quick wins
demoables.

| # | Item | Owner agent | Output |
| --- | --- | --- | --- |
| 10.1 | Merge `L-2` summary counters | Release Agent | `feat/perf-phase3-summary-counters` -> main |
| 10.2 | `Inventory separation` schema | Schema/Migration Agent | `Vehicle.programCategory` enum + migration + backfill |
| 10.3 | Inventory program admin UI | Frontend Agent | bulk-tag flow en `/settings/fleet`, badge en vehicle detail |
| 10.4 | `Per-vehicle revenue` query | Reports/Data Agent | `getVehicleRevenue(tenantId, range)` service + endpoint |
| 10.5 | Per-vehicle revenue card en Overview | Frontend Agent | top-10 earners + bottom-10 underperformers |
| 10.6 | `ID scanner` SDK research spike | Integrations Agent | doc con 3 SDKs comparados (BlinkID, AWS Textract, Stripe Identity) |
| 10.7 | `CESCO` feasibility spike | Integrations Agent | doc con scraping path en cesco.pr.gov + auth model + rate limits |
| 10.8 | `Loaner cleanup` audit doc | Frontend Agent | spec listando cada seccion actual + proposito propuesto |
| 10.9 | Sentry sample rate 0 -> 0.1 | Release Agent | config bump, redeploy |

Definition of done Sprint 10:

- Triangle puede ver vehiculos taggeados como `LOANER` vs `RENTAL` en demo
- Owner ve un report "Top earning vehicles last 30 days"
- Tenemos decision tomada sobre que SDK usamos para ID scan
- Tenemos decision tomada sobre como atacamos CESCO (scrape vs portal API si existe)

### Sprint 11 — Build Wave (May 12–18)

Objetivo: ejecutar el grueso del trabajo de loaner + reports + integrations
ahora que las fundaciones existen.

| # | Item | Owner agent | Output |
| --- | --- | --- | --- |
| 11.1 | `Loaner module cleanup` execution | Frontend Agent | navegacion reordenada, cada seccion con purpose label, dead UI removida |
| 11.2 | Reports — `Reservations report` | Reports/Data Agent | Excel + filtros por fecha, status, location, program |
| 11.3 | Reports — `Inventory report` | Reports/Data Agent | Excel: vehicle + program + status + utilization + revenue + cost (si existe) |
| 11.4 | Reports — `Vehicle Cost vs Revenue` | Reports/Data Agent | requiere `VehicleCost` model (acquisition + monthly fixed + maintenance) |
| 11.5 | `VehicleCost` model + admin entry | Schema/Migration Agent + Frontend Agent | nuevo model, migration, UI en vehicle detail |
| 11.6 | `ID scanner` integration — web | Backend Services Agent + Frontend Agent | endpoint `/customers/scan-id` + drop zone en intake |
| 11.7 | `ID scanner` integration — mobile | Mobile Agent | Capacitor camera plugin -> mismo endpoint |
| 11.8 | `CESCO` scraper MVP | Integrations Agent | job que entra a cesco.pr.gov, lista tickets por placa, persiste en `CescoTicket` model |
| 11.9 | `CESCO` matching + daily email | Integrations Agent | match a `Vehicle.plate`, link a reservation/loaner activa, email digest 7am AST |
| 11.10 | Phase 2 perf `M-1` (parallel hydrate) | Backend Services Agent | bandwidth permitiendo |

Definition of done Sprint 11:

- Triangle puede ver el modulo loaner limpio en una sesion de walkthrough
- Owner puede exportar Reservations, Inventory, Vehicle Cost vs Revenue
- Cualquier admin puede escanear una licencia y los campos se rellenan
- El admin de Triangle recibe un email diario con tickets CESCO matcheados

### Sprint 12 — Accounting Polish & Triangle Cutover (May 19–25)

Objetivo: cerrar lo de accounting (que es el mas pesado), pulir CESCO/loaner
con feedback real, y dejar a Triangle listo para go-live.

| # | Item | Owner agent | Output |
| --- | --- | --- | --- |
| 12.1 | `Chart of Accounts` model | Schema/Migration Agent | nuevo `Account` + `JournalEntry` o equivalente |
| 12.2 | Reports — `Balance Sheet` | Reports/Data Agent | snapshot at-date desde journal entries |
| 12.3 | Reports — `P&L` | Reports/Data Agent | range-based income vs expense, breakdown por category |
| 12.4 | `CESCO` polish | Integrations Agent | dispute link en Issue Center, weekly digest option, alertas por monto |
| 12.5 | `ID scanner` polish | Frontend Agent | confidence indicator, manual edit override, audit log |
| 12.6 | Loaner final UX pass | Frontend Agent | feedback de Triangle walkthrough aplicado |
| 12.7 | Triangle tenant rehearsal | QA/Beta Tenant Agent | tenant `triangle-pr` provisionado, 200 vehiculos seed, smoke pass |
| 12.8 | Triangle go-live runbook | Release Agent | checklist de cutover, rollback plan, support escalation |

Definition of done Sprint 12:

- Triangle puede generar Balance Sheet y P&L desde el dashboard
- CESCO emails llevan ya 2 semanas funcionando estables
- Tenant `triangle-pr` esta provisionado y listo para training
- Existe runbook escrito y revisado para el go-live

## Agents Needed

Cada agente es un work-stream con scope claro. Pueden correr en paralelo cuando
las dependencias lo permiten.

### 1. `Schema/Migration Agent`

- Scope: prisma schema changes, migrations, backfill scripts, dual-write logic
- Sprints: 10 (inventory separation), 11 (VehicleCost), 12 (Chart of Accounts)
- Critical path: si esto se atrasa, casi todo lo demas se atrasa
- Tooling: prisma migrate, postgres jobs, tenant-aware backfill scripts

### 2. `Backend Services Agent`

- Scope: module routes/services nuevos (vehicle revenue, customer scan, vehicle cost),
  refactor del loaner module backend
- Sprints: 10–12
- Inputs: schemas del agent #1
- Outputs: REST endpoints listos para frontend y mobile

### 3. `Reports/Data Agent`

- Scope: queries de aggregation, generacion de Excel, render de reports
- Sprints: 10 (vehicle revenue), 11 (Reservations + Inventory + Cost vs Revenue),
  12 (Balance Sheet + P&L)
- Especialidad: optimizacion de queries con tenants grandes (Triangle = 200 vehiculos),
  uso de los counters de Phase 3 cuando aplique
- Output: cada report con un Excel export ademas del view en pantalla

### 4. `Frontend Agent`

- Scope: Next.js pages, admin UIs, loaner module cleanup
- Sprints: 10–12
- Trabajo paralelo: cleanup audit Sprint 10 (low risk), cleanup execution Sprint 11
- Output: UI consistente, mobile-friendly, con badges de programCategory visibles

### 5. `Mobile Agent`

- Scope: Capacitor wrapper, plugin de camera nativa para ID scan, sync con backend
- Sprints: 11 (build), 12 (polish)
- Pre-req: SDK decision del Sprint 10
- Output: scan de ID desde la app movil con misma calidad que web

### 6. `Integrations Agent`

- Scope: lo de afuera. SDK de ID, scraper CESCO, email digest infrastructure
- Sprints: 10 (spikes), 11 (build), 12 (polish)
- Riesgo principal del proyecto: CESCO no tiene API publica, el scraper puede romperse
- Mitigacion: feature flag, retry/backoff, alerta a admin si falla 2 dias seguidos
- Output: dos integrations productivas (`id-scanner`, `cesco-monitor`)

### 7. `QA/Beta Tenant Agent`

- Scope: setup del tenant `triangle-pr`, seed data, smoke tests, regression
- Sprints: 11 (provisioning), 12 (rehearsal)
- Pre-req: features ya mergeadas, no spec
- Output: tenant que el equipo de Triangle puede tocar antes del go-live

### 8. `Release/DevOps Agent`

- Scope: merges, tags de beta, migrations en prod, monitoreo post-deploy
- Sprints: 10 (L-2 merge, Sentry bump), 11 (continuous), 12 (cutover runbook)
- Output: cero downtime, rollback path documentado para cada release

## Parallelization Plan

Asi se puede correr en paralelo dentro de un Sprint:

```
Sprint 10:
  Schema/Migration ────────► (10.2)
  Backend Services ───────────────► (10.4)
  Reports/Data ──────────────────────► (10.4 query)
  Frontend ─────────► (10.3) ─────────► (10.5) ─────► (10.8)
  Integrations ────────────► (10.6 + 10.7 spikes)
  Release ────► (10.1) ─────────────────────────────► (10.9)
```

Las dependencias duras son:

- 10.3 depende de 10.2
- 10.5 depende de 10.4
- 11.4 depende de 11.5
- 11.7 depende de 10.6 (SDK decision)
- 11.9 depende de 11.8

Todo lo demas es paralelizable.

## Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| CESCO scraper bloqueado por captcha o session | Alto — feature no funciona | spike Sprint 10 valida feasibility, fallback a manual upload diario |
| ID scanner SDK pricing inesperado | Medio — afecta margin | research compara `BlinkID`, `Textract`, `Stripe Identity`, `Mindee` |
| Inventory separation backfill rompe data existente | Alto — todos los tenants afectados | dry-run en staging, default `RENTAL_ONLY` para todos los vehicles existentes |
| Chart of Accounts es mas trabajo del que cabe en Sprint 12 | Medio — Balance Sheet y P&L se atrasan | si pasa, entregar P&L simple (revenue minus costs por category) en Sprint 12 y Balance Sheet completo en Sprint 13 |
| Triangle quiere algo que no esta en los 7 items | Medio — alcance crece | seguimiento weekly con el contacto de Triangle para capturar nuevos requests temprano |
| Phase 2 perf mediums no se hacen | Bajo — perf actual es aceptable | aceptable, retomar en Sprint 13 |

## Open Questions Para Hector

Antes de arrancar Sprint 10 me ayudaria saber:

1. ¿Triangle ya firmo o todavia esta evaluando? Cambia si demo-ready vs production-ready.
2. ¿Hay deadline duro de Triangle (ejemplo: "queremos arrancar el 1 de junio")?
3. ¿Quieres que P&L y Balance Sheet sean accounting-grade (con journal entries) o
   reporting-grade (sumas directas de charges/expenses)? El segundo es mucho mas rapido.
4. Para el ID scanner: ¿prefieres una solucion 100% on-device (BlinkID) o
   cloud-based (Textract/Stripe) para el primer release?
5. CESCO: ¿el daily email va al admin del tenant o a una cuenta central de RideFleet
   que despues distribuye?

## Next Step

Si confirmas el sequencing, abro tickets para los 9 items de Sprint 10 y arranco
con `Schema/Migration Agent` (10.2) y `Release Agent` (10.1) en paralelo manana
mismo.
