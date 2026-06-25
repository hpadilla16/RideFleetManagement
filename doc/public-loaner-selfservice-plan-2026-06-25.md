# Public Loaner Self-Service — build spec (2026-06-25)

Endpoints públicos para el flujo de loaner self-service del website Rent & Go (tenant
`rent-by-vphmotors`). Router nuevo `/api/public/loaner` detrás de `resolvePublicTenantToken`
(mismo del booking) + `createPublicRateLimitGuard`. Fail-closed sin token.

## Decisiones (confirmadas por Hector)
1. **/reserve → estado PENDING** (asesor aprueba antes de entregar llaves).
2. **Firma inline** en /reserve (el sitio manda dataURL PNG en el body).
3. **Modelo nuevo `LoanerRequest`** para el formulario "Solicitar cortesía" (#3).

## Módulo existente (mapeado)
- `dealershipLoanerService.intake(user, payload)` (service.js:837) crea una **Reservation**
  `workflowMode:DEALERSHIP_LOANER`, `status:CONFIRMED`, con `repairOrderNumber` + contexto de
  servicio (serviceVehicle*, serviceAdvisor*, estimatedServiceCompletionAt, pickup/returnLocation).
- `dealershipLoanerService.getIntakeOptions(user)` (service.js:779) lista loaners disponibles:
  `vehicles[] = { id, year, make, model, internalNumber, plate, status, vehicleType:{id,name,code} }`
  (filtrados status NOT IN MAINTENANCE/OUT_OF_SERVICE + programCategory loaner). Scope por `user`
  → hace falta variante pública por `tenantId` del token.
- RO: `Reservation.repairOrderNumber` (String indexado). Dashboard busca por él (matchesQuery).
  **No hay** modelo "appointment" — el "appointment" = una Reservation de loaner existente con ese RO.
- Firma legal hoy vive en `LoanerAgreement.signatureDataUrl`, creada en CHECK-OUT (DRAFT→ACTIVE).
- Status Reservation: NEW, CONFIRMED, CHECKED_OUT, CHECKED_IN, CHECKED_IN_UNPAID, CANCELLED, NO_SHOW.
- Guard público: `attachPublicRequestMeta(name)` + `createPublicRateLimitGuard({name,maxRequests,windowMs})`
  (ver loaner-agreement.routes.js:111). Montar el router en main.js como /api/public/booking.

## Endpoints

### 1) POST /api/public/loaner/lookup  (read-only)
body `{ repairOrderNumber?, lastName?, phone? }`
- Busca Reservation `workflowMode:DEALERSHIP_LOANER` + `tenantId` (del token) + match por RO
  (insensitive) y opcional lastName/phone del customer. Toma la más reciente.
- 200 `{ appointment: {id, vehicle, dateTime, location, advisor, repairOrderNumber} | null,
  loaners: LoanerOption[] }`. `vehicle` = serviceVehicle (year/make/model/plate). `dateTime` =
  estimatedServiceCompletionAt ?? pickupAt. `location` = pickupLocation.name. `advisor` =
  serviceAdvisorName.
- `loaners`: variante pública de getIntakeOptions (scope tenantId) → map a LoanerOption.
- Sin match → `appointment:null` (el sitio muestra "no encontrado → solicita una"), `loaners` igual.

### 2) POST /api/public/loaner/reserve  (actualiza el appointment, PENDING + firma inline)
body `{ appointmentId, loanerId, signature /* dataURL PNG */ }`
- **A (CONFIRMADO): ACTUALIZA la reserva-appointment** — busca la reserva por `appointmentId` +
  tenant del token, valida que `loanerId` sea un vehículo loaner disponible del tenant, lo asigna como
  `vehicleId`, y marca la selección como pendiente de aprobación del asesor (NO crea otra reserva).
- **B (CONFIRMADO): LoanerAgreement DRAFT temprano** — crear el LoanerAgreement en `DRAFT` ligado a la
  reserva con `signatureDataUrl` = la firma inline (+ signerName del customer, signedAt, ip). El asesor
  luego revisa y al check-out pasa DRAFT→ACTIVE. (Reusar el patrón de LoanerAgreement existente.)
- **Estado PENDING:** marcar la reserva como "self-service pendiente" para que el asesor la apruebe.
  Recomendado: campo additive `Reservation.loanerSelfServiceSubmittedAt DateTime?` (timestamp) → el
  dashboard filtra "loaner self-service pendiente de aprobar". La reserva-appointment mantiene su status
  (el asesor aprueba = check-out). Confirmar si se prefiere un flag/estado distinto.
- 200 `{ confirmationNumber: reservationNumber, reservationId }`.

### 3) POST /api/public/loaner/request  (lead → asesor)
body `{ name, phone, email?, repairOrderNumber?, preferredDate?, notes? }`
- Crea `LoanerRequest` (modelo nuevo) status `RECEIVED`, tenantId del token. NO crea reserva.
- 200 `{ requestId, status:"RECEIVED" }`.
- Visible en el dashboard del asesor (endpoint/listado autenticado — follow-up frontend).

## Modelo nuevo (migración aditiva)
```prisma
model LoanerRequest {
  id                String   @id @default(cuid())
  tenantId          String?
  tenant            Tenant?  @relation(fields:[tenantId], references:[id])
  name              String
  phone             String
  email             String?
  repairOrderNumber String?
  preferredDate     DateTime?
  notes             String?
  status            String   @default("RECEIVED") // RECEIVED | CONTACTED | CONVERTED | CLOSED
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@index([tenantId, status])
}
```

## LoanerOption (shape que el sitio espera en `loaners`)
`{ id, name, classLabel?, imageUrl?, passengers?, bags?, transmission?, costPerDay /*0=cubierto*/, recommended? }`
→ map desde getIntakeOptions.vehicles + el VehicleType (passengers/bags/transmission/imageUrl ya en
beta.228). costPerDay = 0 para COURTESY/WARRANTY/INTERNAL.

## Archivos a tocar
- prisma/schema.prisma + migración 20260625_loaner_request
- backend/src/modules/dealership-loaner/public-loaner.service.js (nuevo) — lookupByRO,
  getPublicIntakeOptions(tenantId), publicReserve, createPublicRequest
- backend/src/modules/dealership-loaner/public-loaner.routes.js (nuevo) — router /api/public/loaner
- backend/src/main.js — montar tras resolvePublicTenantToken
- ship script (con migración) + curls deliverable (lookup/reserve/request con el header)

## ENTREGABLE
curl real (con X-Tenant-Token) de los 3: un lookup con appointment+loaners, un reserve OK, un request OK.

## ESTADO: spec 100% cerrado (decisiones 1/2/3 + A/B confirmadas). Listo para build enfocado.
Orden sugerido de build: (1) modelo LoanerRequest + Reservation.loanerSelfServiceSubmittedAt +
migración · (2) public-loaner.service (getPublicIntakeOptions, lookupByRO, createPublicRequest,
publicReserve) · (3) public-loaner.routes + main.js wiring · (4) ship script + curls deliverable.
