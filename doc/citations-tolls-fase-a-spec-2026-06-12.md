# Fase A — Spec técnico: Peajes + Tickets (P1) — 2026-06-12

Spec de arranque de la prioridad P1 (`doc/roadmap-priorities-2026-06-12.md`), aterrizado en
el código real del repo. Planes de contexto: `doc/citations-portal-ingestion-plan-2026-06-12.md`
(ingestión + topología) y `doc/manuel-shop-audit-2026-06-11.md` (SunPass + Citations).

## HALLAZGO CLAVE — el sistema de peajes YA EXISTE
El módulo `backend/src/modules/tolls/` está completo y es la **implementación de referencia**
para Citations. Ya tiene:
- Scrapers **SunPass** + AutoExpreso (`tolls.service.js`, `withPage()` singleton + semáforo).
- Modelos `TollProviderAccount` · `TollImportRun` · `TollTransaction` · `TollAssignment`
  (enums `TollProvider{AUTOEXPRESO,SUNPASS}`, `TollTransactionStatus`, `TollBillingStatus`,
  `TollMatchStatus`).
- Motor de **matching** por placa/tag/sello + ventana de tiempo de la reserva
  (`tolls.service.js`).
- **Posteo de cargos** al `RentalAgreement.balance` vía `syncReservationTollCharges()` →
  `RentalAgreementCharge` (source `TOLL_MODULE`).
- **Scheduler en el worker** (`tolls.scheduler.js`, sweep cada 15 min, gate `tollsEnabled`).
- Patrón de **ingestión por token interno** (`BACKEND_INTERNAL_TOKEN`,
  `pricing-suggestions.routes.js` → `app.use('/api/internal/pricing-engine', ...)`).

→ Por eso P1 se parte en **(A1) Peajes = conectar/verificar lo existente** (casi sin código)
y **(A2) Tickets = módulo nuevo que CLONA `tolls`**.

---

## A1 — PEAJES (SunPass + CFX): conectar la cuenta de prod (OPS, ~0 código)

CFX/E-PASS **no necesita proveedor nuevo**: la cuenta SunPass 91002658 ya recibe los peajes
de las vías de Orlando (SR408/417/528/429/Turnpike) por interoperabilidad estatal — el scraper
de SunPass que ya existe los trae. Verificado: el enum `TollProvider` = {AUTOEXPRESO, SUNPASS}
es suficiente.

Pasos (config + verificación, los hace Hector / smoke en prod):
1. **Crear el `TollProviderAccount`** para el tenant ZEZGO Orlando: `provider=SUNPASS`,
   `accountNumber=91002658`, credenciales (MARIA SOTO / ZEZGO ORLANDO) → `passwordEncrypted`.
   Por UI de Settings de tolls o seed; la contraseña la teclea Hector (regla: agentes no
   teclean passwords).
2. **`tollsEnabled=true`** en ese tenant.
3. **Seed transponder→placa→Vehicle**: poblar `Vehicle.tollTagNumber` (601 transponders del
   "Transponders and Vehicles" de SunPass) para que el matching por tag funcione además del
   matching por placa.
4. **Correr un sync real** (sweep del worker o trigger manual) sobre un rango corto y
   verificar: (a) que aparecen peajes de CFX (SR408/417/528) en `TollTransaction`, (b) que el
   matching ata a reservas activas, (c) la cola NEEDS_REVIEW para carros sitting.
5. **Vigilancia de balance prepaid** (mejora menor): alerta si el balance SunPass cae bajo el
   umbral de Easy Pay (hoy ~$230/día de burn; si la AMEX falla → 601 placas generan
   violations). Se puede colgar del mismo sweep.

Código probable: **ninguno o mínimo** (ajuste del parser de SunPass Activity solo si esta
cuenta pagina distinto a 601 placas). Confirmar en el primer sync real.

**Riesgo:** SunPass puede atar la sesión al IP (igual que TL International / OCSO). Si el
scraper corre desde el droplet de prod y SunPass bloquea, mover el login de SunPass al
scraper-droplet con proxy residencial (mismo patrón). Verificar en el primer sync.

---

## A2 — TICKETS (Citations): módulo nuevo clonando `tolls`

### A2.1 Schema (Prisma, migración ADITIVA — `backend/prisma/schema.prisma`)
Espejo 1:1 de los modelos de tolls. Migración additive-only por puerto 5432 (regla del repo).

```prisma
enum CitationSource {
  CITATION_PROCESSING_CENTER   // CPC — City of Orlando, Sarasota, +
  T2                           // t2hosted.com (Fort Lauderdale, etc.)
  OCSO_COMPTROLLER             // parking.occompt.com
  VIOLATIONINFO                // Verra red-light (solo intake/OCR)
  MANUAL                       // upload manual
}
enum CitationStatus     { IMPORTED  MATCHED  NEEDS_REVIEW  BILLED  DISPUTED  VOID }
enum CitationBillingStatus { PENDING  POSTED_TO_AGREEMENT  WAIVED  DISPUTED }
enum CitationMatchStatus { SUGGESTED  CONFIRMED  REJECTED  AUTO_CONFIRMED }

model CitationSourceAccount {        // ← espejo de TollProviderAccount
  id                String   @id @default(cuid())
  tenantId          String
  tenant            Tenant   @relation(fields:[tenantId], references:[id], onDelete:Cascade)
  source            CitationSource
  isActive          Boolean  @default(true)
  authMode          String   @default("GUEST")   // GUEST | CREDENTIALED | API
  username          String?
  passwordEncrypted String?
  slug              String?                       // "fortlauderdaleparking", "cpc-orlando"
  settingsJson      String?
  lastSyncAt        DateTime?
  lastSyncStatus    String?
  lastSyncMessage   String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@unique([tenantId, source, slug])
}

model CitationImportRun {            // ← espejo de TollImportRun
  id            String   @id @default(cuid())
  tenantId      String
  tenant        Tenant   @relation(fields:[tenantId], references:[id], onDelete:Cascade)
  source        CitationSource
  startedAt     DateTime @default(now())
  completedAt   DateTime?
  sourceType    String   // DROPLET_SCRAPE | MANUAL_IMPORT | OCR
  status        String   // IN_PROGRESS | SUCCESS | FAILED
  importedCount Int      @default(0)
  matchedCount  Int      @default(0)
  reviewCount   Int      @default(0)
  errorMessage  String?
}

model Citation {                     // ← espejo de TollTransaction
  id             String   @id @default(cuid())
  tenantId       String
  tenant         Tenant   @relation(fields:[tenantId], references:[id], onDelete:Cascade)
  source         CitationSource
  importRunId    String?
  citationNo     String
  agency         String                       // "City of Orlando"
  violationType  String?                       // "Expired meter"
  plateRaw       String?
  plateNormalized String?
  plateState     String?                       // "FL"
  issuedAt       DateTime
  amount         Decimal  @db.Decimal(10,2)
  fee            Decimal  @db.Decimal(10,2) @default(0)
  dueAt          DateTime?                      // deadline (sube de precio)
  location       String?
  externalUrl    String?                        // deep-link al portal de la agencia
  documentPath   String?                        // Supabase bucket:path (PDF/foto/OCR)
  vehicleId      String?
  vehicle        Vehicle? @relation(fields:[vehicleId], references:[id])
  reservationId  String?
  reservation    Reservation? @relation(fields:[reservationId], references:[id])
  status         CitationStatus        @default(IMPORTED)
  billingStatus  CitationBillingStatus @default(PENDING)
  matchConfidence Decimal? @db.Decimal(5,2)
  needsReview    Boolean  @default(false)
  sourcePayloadJson String?
  reviewNotes    String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  assignments    CitationAssignment[]
  @@unique([tenantId, source, citationNo])
  @@index([tenantId, plateNormalized, plateState, issuedAt])
  @@index([tenantId, status, issuedAt])
}

model CitationAssignment {           // ← espejo de TollAssignment
  id            String   @id @default(cuid())
  tenantId      String
  citationId    String
  citation      Citation @relation(fields:[citationId], references:[id], onDelete:Cascade)
  reservationId String
  reservation   Reservation @relation(fields:[reservationId], references:[id], onDelete:Cascade)
  vehicleId     String?
  status        CitationMatchStatus
  confidence    Decimal? @db.Decimal(5,2)
  matchReason   String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([tenantId, reservationId, status])
}
```
Más: `Tenant.citationsEnabled Boolean @default(false)` + relaciones inversas
(`citations`, `citationSourceAccounts`, `citationImportRuns`, `citationAssignments`), y en
`Vehicle`/`Reservation` las relaciones inversas `citations CitationS[]`/`citationAssignments`.

### A2.2 Módulo backend (`backend/src/modules/citations/`)
Convención del repo (routes → service, como `customer-inspection/` y `tolls/`):
- **`citations.service.js`**:
  - `ingestBatch(rows, { tenantId, source })` — upsert idempotente por `(tenantId, source,
    citationNo)`; crea `CitationImportRun`; normaliza placa (uppercase, sin guiones). Espejo
    de `createManualTransactions` de tolls.
  - `matchCitation(citation)` — placa+estado normalizada + `issuedAt` dentro de
    `[reservation.pickupAt, reservation.returnAt]` (o ventana del agreement) → `Reservation`
    → `CitationAssignment` (AUTO_CONFIRMED si único match, SUGGESTED si ambiguo). **Amarre de
    dos niveles (spec del audit):** `vehicleId` SIEMPRE por placa; `reservationId` solo si el
    timestamp cae en una renta. Reusar la lógica de scoring de `tolls.service.js`.
  - `getDashboard(scope)` / `list(filters, scope)` / `getDetail(id, scope)` /
    `review(id, decision, scope)` — todo tenant-scoped vía `scopeFor(req)`.
  - `autoResolveSweep()` — re-match de IMPORTED sin reserva (carro pudo entrar a renta tarde),
    espejo del `vehicle-drift-sweep`.
- **`citations.routes.js`** — dos routers (patrón `pricing-suggestions`):
  - `citationsRouter` (authed): `GET /` (list+filtros placa/agencia/source/status/fechas) ·
    `GET /:id` · `POST /:id/review` · `POST /manual-import` (staff) · `GET /vehicle/:id`
    (historial en el perfil). Montado: `app.use('/api/citations', requireAuth, tenantRateLimit,
    requireModuleAccess('citations'), citationsRouter)`.
  - `citationsInternalRouter`: `POST /ingest` con `requireInternalToken` (BACKEND_INTERNAL_TOKEN).
    Montado: `app.use('/api/internal/citations', citationsInternalRouter)` (espejo exacto de
    `/api/internal/pricing-engine`). **Este es el puente del scraper-droplet.**
- **`citations.scheduler.js`** (opcional Fase A) — sweep en el worker que corre
  `autoResolveSweep()` + notificación de nuevas matched-to-active. NO scrapea (eso vive en el
  droplet). Registrar en `worker.js` junto a los demás schedulers, gate `citationsEnabled`.

### A2.3 Lado scraper-droplet (NO en este repo — extiende `ridefleet-scraper-prod`)
Adapters Python/Browserbase, **piloto = Citation Processing Center**:
- `discover(plate, state)` → POST a `/citizen-search-citation.aspx` (mantener `__VIEWSTATE`/
  `__EVENTVALIDATION`), parsear tabla → `fetchDetail` por citación.
- Normalizar → `POST {BACKEND_URL}/api/internal/citations/ingest` con
  `Authorization: Bearer $BACKEND_INTERNAL_TOKEN`, body `{ tenantId, source:"CITATION_PROCESSING_CENTER",
  rows:[{citationNo, plate, plateState, agency, issuedAt, amount, fee, violationType, location,
  externalUrl, documentUrl, raw}] }`.
- Cadencia: por placa activa, gate por `lastSuccessAt`, splay (lección del scraper). Proxy
  residencial donde el portal bloquee (OCSO sí; CPC aparentemente no).
- T2 (Fort Lauderdale) y OCSO = adapters 2 y 3, mismo contrato.

### A2.4 Billing (Fase E, NO en Fase A — MONEY, gate duro)
`syncReservationCitationCharges()` espejo de `syncReservationTollCharges()` →
`RentalAgreementCharge` (source `CITATION_MODULE`, `sourceRefId=citation.id`) + admin fee vía
`fee-engine resolveRate({feeType:'CITATION_ADMIN'})`. **Diferido**: requiere aprobación
explícita de Hector + revisión de diff (regla de dinero, como beta.155). En Fase A las
citations llegan, matchean y se muestran; NO cobran.

### A2.5 Notificación inmediata (spec del audit)
Al matchear una citation a una **renta activa** (carro sin devolver): WhatsApp al ops (canal
del monitor existente) + card "Citations" en el dashboard + evento en el timeline del vehículo
y la reserva. Reusar el patrón de notificación del autocharge/ops-monitor.

---

## Orden de ejecución de Fase A
1. **A1 peajes** primero (casi sin código): crear el `TollProviderAccount` de prod, seed de
   transponders, sync real, verificar CFX + matching. Valor inmediato, valida el patrón.
2. **A2 schema** de Citations (migración aditiva) + **endpoint de ingestión** interno.
3. **A2 adapter CPC** en el droplet → primer ingest real de Orlando end-to-end.
4. **A2 matching + UI** (lista/detalle/perfil, mockups ya aprobados en
   `doc/citations-mockup-2026-06-12.html`).
5. Notificación inmediata.
6. (Fase E, aparte) billing con aprobación de Hector.

## Reglas de entrega (del CLAUDE.md)
- **Cowork NO deploya** — prepara+verifica el bundle; Hector o el agente `deployer` (Claude
  Code) hace push+deploy. Migración aditiva por **puerto 5432** (no pgbouncer 6543).
- Ship script atómico con **FILES[] explícito** (todo import top-level nuevo en `main.js`/
  `worker.js` debe estar en el FILES[] o el backend no bootea — causa #1 de crashes).
- `bash scripts/env-diff-check.sh` antes del deploy (añadir `BACKEND_INTERNAL_TOKEN` si falta,
  y las keys de credenciales de fuentes).
- Verificar post-deploy: 3 contenedores healthy + boot limpio + /health 200.
- Credenciales (SunPass, OCSO) → `.env` del droplet / vault, nunca en tabla en claro;
  `redactSensitive()` cubre los nuevos campos sensibles.
