# Inventory Helper — plan de feature (2026-06-09)

Helper guiado para que los rental agents hagan inventario de la flota paso a paso:
ver toda la flota con su estado, confirmar carro por carro, manejar mismatches, y al
terminar generar un PDF detallado guardado en Reports → Inventory Reports.

Vive bajo el **módulo de vehículos** (lanzador en `/vehicles`), reutilizando piezas que
ya existen en el sistema. No toca código de dinero. Migraciones aditivas.

## Decisiones tomadas (Hector, 2026-06-09)
1. **Alcance:** una sola sesión cubre **toda la flota del tenant**, agrupada/filtrada por
   `homeLocation` (lote). Se puede hacer un lote y seguir con otro en la misma sesión.
2. **Escaneo:** **requerido** para confirmar un carro en el lote (QR / placa / VIN), con
   **fallback manual** que exige una razón (queda registrado en el PDF como "confirmado manual").
3. **Fotos:** **5 por carro en el lote** — 4 esquinas (frente, atrás, izq, der) + odómetro.
4. **Completar:** no se puede cerrar hasta que **cada carro esté confirmado o marcado
   excepción** Y **todos los mismatches ON_RENT estén resueltos**.

## Lo que ya existe y reutilizamos (no reinventar)
- **Escáner** `BarcodeDetector` nativo (beta.138, en el license scanner): PDF417 + Code 39
  → sirve directo para el **barcode VIN** del sticker de la puerta. El **QR** del vehículo ya
  se genera en el perfil (`/vehicles/{id}`). La **placa** va por OCR de cámara (o entrada
  manual como fallback).
- **Sesión reanudable** estilo `CheckoutSession` (event-log en DB + cleanup de abandonadas).
- **Fotos a Supabase** `uploadInspectionPhotos()` + `materializeStorageRefs()`
  (`backend/src/modules/rental-agreements/inspection-photos.js`).
- **Detección de drift** ON_RENT↔CHECKED_OUT: `sweepVehicleStatusDrift()`
  (`backend/src/modules/vehicles/vehicle-status-sweep.poll.js`) — misma lógica para los mismatches.
- **PDF vía puppeteer**: `renderReportPdf(html)` (`backend/src/modules/reports/reports-export.js`)
  + el patrón de HTML del incident report (`incident-report-pdf.js`).
- **Scoping/roles**: `scopeFor(req)` / `crossTenantScopeFor(req)` (`backend/src/lib/tenant-scope.js`),
  `req.user.sub`, `requireModuleAccess('vehicles')`.

## Modelo de datos (3 modelos nuevos + enums; migración aditiva)

### InventorySession — una activa por tenant
`id, tenantId, status (IN_PROGRESS|COMPLETED|ABANDONED|CANCELLED), startedByUserId,
startedAt, lastActivityAt, completedByUserId, completedAt, abandonedAt, abandonedReason,
totalsJson (counts denormalizados para el resume/progress), reportId? (→ InventoryReport)`.
Regla de una-activa-por-tenant: índice parcial único / guard en el servicio. Al lanzar,
si hay una `IN_PROGRESS` → modal Continuar / Wipe & start new.

### InventoryItem — una fila por vehículo en la sesión
`id, sessionId, tenantId, vehicleId, expectedStatus (snapshot de Vehicle.status al iniciar),
expectedMileage, state (PENDING|CONFIRMED|EXCEPTION), locatedStatus (AT_LOT|MAINTENANCE|
OUT_OF_SERVICE|ON_RENT_OK), confirmMethod (QR|PLATE|VIN|MANUAL), confirmReason (si MANUAL),
tiresOk, brakesOk, lightsOk, fluidsOk, cleanOk (bool), mileageConfirmed (bool),
reportedMileage (si lo corrigen), photosJson / storage refs (bucket 'inventory-photos'),
note, maintenanceNote, mismatchType (ON_RENT_OVERDUE|SHOULD_BE_ON_RENT|null),
mismatchResolved (bool), mismatchResolutionNote, confirmedByUserId, confirmedAt`.
`@@unique([sessionId, vehicleId])`. **El estado se persiste a medida que confirman** → salir
y volver no pierde nada; el wizard lee la sesión al montar y reanuda.

### InventoryReport — el PDF guardado (concepto nuevo: report persistido)
`id, tenantId, sessionId (unique), title, generatedAt, generatedByUserId, storageBucket,
storagePath (Supabase), summaryJson (counts para la lista sin abrir el PDF)`.
Los reports actuales se computan on-the-fly; éste se **persiste** como artefacto descargable.

### FleetReconciliationFlag — mismatch persistido (que NO se pierde)
Cuando un agente **"resuelve con nota"** un mismatch en el wizard, NO arregló el problema de
fondo (el carro sigue ON_RENT/overdue) — solo lo difirió para poder terminar el inventario.
Eso debe quedar registrado y reaparecer hasta arreglarse de verdad. Modelo:
`id, tenantId, vehicleId, reservationId?, type (ON_RENT_OVERDUE|SHOULD_BE_ON_RENT),
status (OPEN|RESOLVED), note (la nota del agente), raisedByInventorySessionId, raisedByUserId,
raisedAt, lastSeenAt, resolvedAt, resolvedByUserId, resolvedReason (CHECKED_IN|SWEEP|MANUAL)`.
`@@unique([tenantId, vehicleId, type])` con status OPEN (un flag abierto por carro+tipo).

Enums: `InventorySessionStatus, InventoryItemState, InventoryLocatedStatus,
InventoryConfirmMethod, InventoryMismatchType, ReconciliationFlagStatus, ReconciliationResolvedReason`.

## Detección de mismatches + tracking (que no se pierdan)
Al iniciar la sesión (y refrescable) se calcula por vehículo, con el mismo invariante del
sweep: **ON_RENT con reserva CHECKED_OUT y `returnAt < now`** → `ON_RENT_OVERDUE` (debería
estar checked-in). **AVAILABLE con reserva CHECKED_OUT** → `SHOULD_BE_ON_RENT`. Ambos se
listan en el paso de mismatches y **bloquean el completar** hasta manejarse. Dos caminos:

- **"Go to check-in"** → deep-link al check-in wizard → arregla de verdad. Al cerrar la renta,
  cualquier `FleetReconciliationFlag` OPEN de ese carro se marca RESOLVED (`resolvedReason=CHECKED_IN`).
- **"Resolve with note"** → permite completar el inventario PERO crea/actualiza un
  `FleetReconciliationFlag` **OPEN** con la nota. El inventario no se traba, y el problema queda
  vivo y visible hasta arreglarse. El `InventoryItem.mismatchResolved=true` solo significa
  "manejado en este inventario", no "el carro ya está bien".

**Auto-resolución (clave para que no se acumule basura):** un flag OPEN se cierra solo cuando
la condición desaparece — el check-in de esa reserva, o el `sweepVehicleStatusDrift` horario que
detecta que el carro ya volvió a estado correcto (`resolvedReason=SWEEP`). También se puede
cerrar manual desde la lista de reconciliación. `lastSeenAt` se bumpea cada vez que el sweep/
inventario lo vuelve a ver, para no duplicar.

## Dashboard — notificación de mismatches (reemplaza Wash Holds)
Hoy el **Workspace Ops Hub** (`frontend/src/app/page.js`, ~línea 534) tiene un tile **"Wash
Holds"** (count de `VehicleAvailabilityBlock` WASH_HOLD) y ya un tile clickable **"Overdue
Returns"** → `/reservations?filter=overdue`. Propuesta: **reemplazar el tile de Wash Holds por
"Status mismatches"** = count de `FleetReconciliationFlag` OPEN, con acento rojo cuando >0 (igual
que Overdue Returns) y click → lista de reconciliación (`/vehicles?filter=mismatch` o una página
dedicada) para arreglarlos (check-in o cerrar manual). Así un mismatch diferido durante inventario
nunca se pierde: vive en el dashboard hasta resolverse.

Nota: "Overdue Returns" (reservas pasadas de fecha) y "Status mismatches" (data de estado
inconsistente) se solapan pero NO son lo mismo — un mismatch puede existir sin que la reserva
esté "overdue" en el filtro, y viceversa. Por eso es un tile propio, no el mismo. Wash Holds
sigue visible en el perfil del vehículo y el planner; solo sale del dashboard (es bajo-señal).

## Escaneo (3 métodos, confirmar = identificar)
- **QR**: decodifica la URL del perfil `/vehicles/{id}` → extrae el id → debe matchear el carro.
- **VIN barcode**: el sticker de la puerta (Code 39) → `BarcodeDetector` → matchea por VIN.
- **Placa**: OCR de cámara de los caracteres → matchea por `plate`. Fallback: tipear la placa.
- Si lo escaneado no matchea el carro esperado → warning ("escaneaste Unit 218, esperabas 214").
- Fallback manual (cámara/escáner falla): confirmar igual pero **exige razón** → PDF lo marca
  "confirmado manual".

## Flujo del wizard (frontend) — ver mockup
1. **Lanzar/Reanudar**: si hay sesión activa → Continuar / Wipe & start new.
2. **Overview de flota**: toda la flota con estado actual, agrupada por lote, barra de
   progreso, banner de mismatches arriba, checks verdes a medida que confirman, filtros por
   estado/lote y búsqueda.
3. **Confirmar carro** (según estado esperado):
   - **En el lote (AVAILABLE)**: escanear (QR/placa/VIN) → 5 fotos → verificar tires/brakes/
     lights/fluids/cleaning → mileage matchea (confirmar o corregir) → nota opcional → Confirmar.
   - **Maintenance / Out of service**: sin fotos/checklist; **nota de estado actual requerida** → Confirmar.
   - **On rent legítimo**: confirmar "sigue afuera" (sin fotos).
   - **No se encuentra**: marcar **Excepción** con razón.
4. **Fix mismatches/excepciones**: lista de flagged, cada uno con Fix (→ check-in) o Resolver
   con nota. Completar bloqueado hasta resolver todo.
5. **Revisar y completar**: resumen de counts → Completar → genera PDF → guarda InventoryReport
   → pantalla de éxito con descarga + "Ver en Reports".

## PDF report (contenido)
Header (tenant, fecha/hora, quién lo corrió, alcance). Resumen (total, por estado, confirmados,
excepciones, mismatches encontrados+resueltos). Secciones por lote: cada carro con interno,
placa, VIN, estado esperado vs confirmado, mileage (archivo vs confirmado/corregido), resultado
del checklist, método de confirmación, miniaturas de fotos, notas. Sección de maintenance con
sus notas. Sección de excepciones (no encontrados + razón). Log de mismatches (qué se flageó y
cómo se resolvió). Línea de certificado (agente + timestamp), como el incident report.

## Backend — módulo nuevo `backend/src/modules/inventory/`
- `inventory.service.js`: `getActiveSession(scope)`, `startSession(user, scope, {wipeExisting})`
  (toma snapshot de la flota → crea InventoryItems + corre la detección de mismatches),
  `confirmItem(...)`, `markException(...)`, `addMaintenanceNote(...)`, `resolveMismatch(...)`,
  `completeSession(user, id)` (valida gating → genera PDF → sube a Supabase → crea InventoryReport),
  `listReports(scope)`, `getReportDownloadUrl(id, scope)`.
- `inventory-pdf.js`: `buildInventoryReportHtml(data)` → HTML self-contained (patrón incident-report).
- `inventory.routes.js`: montado bajo `/api/inventory` con `requireAuth + requireModuleAccess('vehicles')`.
  Endpoints: `GET /session/active`, `POST /session` (start/wipe), `POST /session/:id/items/:itemId/confirm`,
  `.../exception`, `.../maintenance-note`, `.../mismatch/resolve`, `POST /session/:id/complete`,
  `GET /reports`, `GET /reports/:id/download`.
- Fotos: `uploadInspectionPhotos({photos, tenantId, inspectionId: itemId, bucket:'inventory-photos'})`.

## Frontend
- `frontend/src/app/vehicles/inventory-helper/page.js` — el wizard (lanzador en la página de vehículos).
- `frontend/src/app/reports-v2/inventory-reports/page.js` — lista de PDFs guardados + descargar.
- Nav (`AppShell.jsx` NAV_ITEMS): entrada "Inventory helper" bajo vehicles, "Inventory reports"
  bajo reports (ambas `moduleKey` correspondiente). **UI en inglés** (consistente con el resto).
- Componente de escáner reutilizado del license scanner (cámara trasera, BarcodeDetector).

## "Qué agents/automatización necesitamos"
- **Cleanup de sesiones abandonadas** (job programado, como `checkout-session.scheduler`):
  marca `IN_PROGRESS` sin actividad por N días como `ABANDONED` para que no bloqueen. Como
  ya damos Continuar/Wipe, es higiene, no crítico.
- **Sinergia con el drift sweep** existente: mantener `Vehicle.status` correcto reduce los
  mismatches que el agente ve. No requiere cambios; ya corre cada hora.
- **(Opcional) recordatorio mensual de inventario** (estilo morning-ops-report) — "toca correr
  inventario". Lo dejamos como follow-up si lo quieres.
- Para *construirlo*: es grande, conviene partirlo en fases/betas (abajo). Cowork prepara +
  verifica; el deploy lo haces tú (o el agente `deployer` en Code).

## Seguridad y reglas
- **Cero código de dinero** (sin pagos/depósitos/gateway). Migración **aditiva**.
- **Access control / roles los defines tú** (regla dura): propuesta inicial = cualquiera con
  acceso al módulo vehicles puede correr/confirmar; revisar si "completar" se limita a ADMIN/OPS.
- Fotos a bucket nuevo `inventory-photos` (mismo patrón que inspección). `env-diff-check` si
  se agrega alguna key (no se prevé ninguna nueva).
- Cowork **no deploya**; cada fase con su ship script atómico, `node --check`, `prisma validate`,
  guards, unit tests, y verificación post-deploy (4 contenedores + boot limpio + /health + migración).

## Fases de entrega (cada una su beta + ship script)
- **Fase A — backend + datos**: 3 modelos + migración aditiva, servicio de sesión (start/wipe/
  resume), snapshot de flota, detección de mismatches, confirm/exception/maintenance/resolve,
  endpoints, tests. (Sin UI todavía.)
- **Fase B — wizard UI**: overview por lote + confirmar carro (escaneo + 5 fotos + checklist +
  mileage + nota) + maintenance + excepción + reanudar. Reusar el escáner.
- **Fase C — completar + reporte**: gating de completar, generación de PDF, InventoryReport +
  subida a Supabase, página Inventory Reports en el módulo de reports, entradas de nav.
- **Fase D — reconciliación + dashboard**: modelo `FleetReconciliationFlag`, crear flag al
  "resolve with note", auto-resolución vía check-in y vía `sweepVehicleStatusDrift`, tile
  "Status mismatches" en el dashboard (reemplaza Wash Holds) + lista de reconciliación para
  arreglarlos. (Puede ir junto con Fase C si prefieres un solo deploy del cierre.)

## Preguntas abiertas / futuro
- ¿"Completar" restringido a ADMIN/OPS, o cualquiera con acceso a vehicles? (tú defines roles).
- ¿OCR de placa nativo en el navegador, o empezamos con QR+VIN y placa = entrada manual en Fase B
  y se le agrega OCR después? (recomiendo lo segundo para no atrasar las fases).
- ¿Recordatorio mensual de inventario? (opcional).
- ¿Inventarios parciales por lote como reportes separados, o siempre un PDF de toda la flota?
  (hoy: un PDF por sesión = toda la flota; se puede agregar filtro por lote en el PDF luego).
- **Dashboard: ¿reemplazar Wash Holds por "Status mismatches", o agregarlo como tile nuevo?**
  (tu lean fue reemplazar; Wash Holds queda en perfil/planner). Tú decides.
- ¿La lista de reconciliación es una página dedicada o un filtro en `/vehicles`? (recomiendo
  empezar con filtro `/vehicles?filter=mismatch` y, si crece, página propia).
