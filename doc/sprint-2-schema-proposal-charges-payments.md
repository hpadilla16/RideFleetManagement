# Sprint 2 Schema Proposal - Charges + Payments

Fecha base: 2026-03-17

## Objetivo
Introducir un modelo estructurado para charges y payments a nivel de `Reservation`, sin romper la logica existente de `RentalAgreementCharge` y `RentalAgreementPayment`, y eliminando gradualmente la dependencia de:
- `[RES_CHARGES_META]`
- `[RES_DEPOSIT_META]`
- `[SECURITY_DEPOSIT_META]`
- `[PAYMENT <ISO>]`

## Principio De Diseño
No reemplazar todo de golpe.

La propuesta es:
1. Agregar persistencia estructurada en `Reservation`.
2. Hacer dual-read y dual-write temporal.
3. Mantener `RentalAgreementCharge` y `RentalAgreementPayment` como owner del estado final del alquiler.
4. Dejar `Reservation` como owner del estado comercial/pre-rental.

## Problema Actual

### Charges
Hoy los charges a nivel de reservation viven mayormente en `notes` como `[RES_CHARGES_META]` y derivados.

Consecuencias:
- el frontend arma notas concatenando texto
- el backend parsea `notes` para portal, total, depositos y sincronizacion al agreement
- reporting no puede confiar en SQL simple

### Payments
Hoy los pagos OTC o de portal pueden terminar duplicados entre:
- `[PAYMENT ...]` en `Reservation.notes`
- `RentalAgreementPayment`
- `RentalAgreement.paidAmount`

Consecuencias:
- el frontend de pagos parsea notas
- el portal publico append-ea lineas de texto
- el total pagado depende de `max(dbPaid, notePaid)` en algunos lugares

## Hallazgo Adicional
Hay un mismatch funcional:
- el frontend ofrece `BANK_TRANSFER` en [payments/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/payments/page.js)
- el enum backend [AgreementPaymentMethod](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/prisma/schema.prisma#L73) no incluye `BANK_TRANSFER`

Eso debe corregirse en el nuevo corte.

## Propuesta Exacta De Schema

## 1. Extender enum de metodo de pago

```prisma
enum AgreementPaymentMethod {
  CASH
  CARD
  ZELLE
  ATH_MOVIL
  BANK_TRANSFER
  OTHER
}
```

Razon:
- evita divergencia entre frontend y backend
- sirve tanto para reservation-level como agreement-level

## 2. Nuevo enum para origen del pago

```prisma
enum ReservationPaymentOrigin {
  OTC
  PORTAL
  IMPORTED
  MIGRATED_NOTE
}
```

Razon:
- distinguir pagos manuales, portal y backfill legacy

## 3. Nuevo modelo `ReservationPricingSnapshot`

```prisma
model ReservationPricingSnapshot {
  id                     String      @id @default(cuid())
  reservationId          String      @unique
  reservation            Reservation @relation(fields: [reservationId], references: [id], onDelete: Cascade)

  dailyRate              Decimal?    @db.Decimal(10, 2)
  taxRate                Decimal?    @db.Decimal(5, 2)

  selectedInsuranceCode  String?
  selectedInsuranceName  String?

  depositRequired        Boolean     @default(false)
  depositMode            String?
  depositValue           Decimal?    @db.Decimal(10, 2)
  depositBasisJson       String?
  depositAmountDue       Decimal     @default(0) @db.Decimal(10, 2)

  securityDepositRequired Boolean    @default(false)
  securityDepositAmount   Decimal    @default(0) @db.Decimal(10, 2)

  source                 String?     // UI_MANUAL, QUOTE_ENGINE, MIGRATED_NOTE
  createdAt              DateTime    @default(now())
  updatedAt              DateTime    @updatedAt
}
```

Razon:
- captura el estado de pricing comercial antes del agreement
- reemplaza la parte global de `[RES_CHARGES_META]`
- evita meter configuracion de deposit/security deposit en `notes`

## 4. Nuevo modelo `ReservationCharge`

```prisma
model ReservationCharge {
  id                String      @id @default(cuid())
  reservationId     String
  reservation       Reservation @relation(fields: [reservationId], references: [id], onDelete: Cascade)

  code              String?
  name              String
  chargeType        ChargeType  @default(UNIT)
  quantity          Decimal     @default(1) @db.Decimal(10, 2)
  rate              Decimal     @default(0) @db.Decimal(10, 2)
  total             Decimal     @default(0) @db.Decimal(10, 2)
  taxable           Boolean     @default(false)
  selected          Boolean     @default(true)
  sortOrder         Int         @default(0)

  source            String?     // DAILY, SERVICE, FEE, INSURANCE, TAX, DEPOSIT, SECURITY_DEPOSIT, MIGRATED_NOTE
  sourceRefId       String?     // additionalServiceId, feeId, insurance code, etc
  notes             String?

  createdAt         DateTime    @default(now())
  updatedAt         DateTime    @updatedAt

  @@index([reservationId, selected, sortOrder])
}
```

Razon:
- es el espejo pre-rental de `RentalAgreementCharge`
- permite dejar de parsear `chargeRows` desde texto
- habilita reportes y portal sin tocar `notes`

## 5. Nuevo modelo `ReservationPayment`

```prisma
model ReservationPayment {
  id                String                   @id @default(cuid())
  reservationId     String
  reservation       Reservation              @relation(fields: [reservationId], references: [id], onDelete: Cascade)

  method            AgreementPaymentMethod
  amount            Decimal                  @db.Decimal(10, 2)
  reference         String?
  status            PaymentStatus            @default(PAID)
  paidAt            DateTime                 @default(now())

  origin            ReservationPaymentOrigin @default(OTC)
  gateway           String?
  notes             String?

  rentalAgreementPaymentId String?

  createdAt         DateTime                 @default(now())
  updatedAt         DateTime                 @updatedAt

  @@index([reservationId, paidAt])
  @@index([reference])
}
```

Razon:
- evita parsear `[PAYMENT ...]`
- permite representar pagos antes o despues de crear agreement
- deja trazabilidad del origen del pago

## 6. Relaciones nuevas en `Reservation`

```prisma
model Reservation {
  ...
  pricingSnapshot   ReservationPricingSnapshot?
  charges           ReservationCharge[]
  payments          ReservationPayment[]
}
```

## Lo Que No Cambia En Este Corte
- `RentalAgreementCharge`
- `RentalAgreementPayment`
- `RentalAgreement.paidAmount`
- `RentalAgreement.balance`

Eso se mantiene para no romper checkout/checkin/close agreement.

## Ownership Propuesto

### Reservation
Owner de:
- precio comercial pre-rental
- composicion de charges antes del agreement
- deposit due at booking
- security deposit expected amount
- pagos asociados a la reservacion

### RentalAgreement
Owner de:
- charges finales de contrato
- pagos contables/finales del contrato
- balance final
- security deposit lifecycle real

## Regla De Sincronizacion

### Al editar charges de reservation
- se actualiza `ReservationPricingSnapshot`
- se reemplaza `ReservationCharge[]`
- si ya existe `RentalAgreement` abierto:
  - se resync hacia `RentalAgreementCharge[]`
  - no se destruyen pagos ya aplicados

### Al registrar un pago en reservation
- se crea `ReservationPayment`
- si existe `RentalAgreement` activo:
  - tambien se crea `RentalAgreementPayment`
  - se recalculan `paidAmount` y `balance`

### Al recibir pago del portal publico
- crear siempre `ReservationPayment`
- si existe `RentalAgreement`, crear tambien `RentalAgreementPayment`
- dejar de escribir `[PAYMENT ...]` en `notes`

## Estrategia De Migracion Incremental

## Fase 1 - Schema
Agregar:
- enum `BANK_TRANSFER`
- enum `ReservationPaymentOrigin`
- `ReservationPricingSnapshot`
- `ReservationCharge`
- `ReservationPayment`

## Fase 2 - Dual write
Seguir escribiendo legacy por compatibilidad corta, pero escribir tambien al modelo nuevo.

Flujos a dual-write:
- reservation detail charges editor
- OTC payments
- portal payment confirmation
- request-payment total breakdown

## Fase 3 - Dual read
Orden recomendado:
1. leer desde tablas nuevas
2. si no hay datos, fallback a parsing de `notes`

Pantallas/rutas:
- reservation detail
- reservation payments page
- customer payment portal
- start-rental sync

## Fase 4 - Backfill
Backfill de legacy:
- `RES_CHARGES_META` -> `ReservationPricingSnapshot` + `ReservationCharge`
- `PAYMENT` lines -> `ReservationPayment`
- `RES_DEPOSIT_META` y `SECURITY_DEPOSIT_META` -> `ReservationPricingSnapshot`

Regla:
- marcar `source = MIGRATED_NOTE`
- no borrar de inmediato el `notes` legacy

## Fase 5 - Cutover
- frontend deja de escribir metadata critica en `notes`
- backend deja de parsear `notes` como fuente primaria
- `notes` queda solo para comentarios humanos y log legacy residual

## Cambios API Recomendados

## Charges
Nuevo endpoint o refactor del existente:
- `GET /api/reservations/:id/pricing`
- `PUT /api/reservations/:id/pricing`

Payload sugerido:
```json
{
  "dailyRate": 49.99,
  "taxRate": 11.5,
  "selectedInsuranceCode": "CDW",
  "depositRequired": true,
  "depositMode": "FIXED",
  "depositValue": 100,
  "depositBasis": ["rate", "services"],
  "depositAmountDue": 100,
  "securityDepositRequired": true,
  "securityDepositAmount": 250,
  "charges": [
    {
      "code": "DAILY",
      "name": "Daily",
      "chargeType": "DAILY",
      "quantity": 3,
      "rate": 49.99,
      "total": 149.97,
      "taxable": true,
      "selected": true,
      "sortOrder": 0,
      "source": "DAILY"
    }
  ]
}
```

## Payments
Nuevo endpoint:
- `GET /api/reservations/:id/payments`
- `POST /api/reservations/:id/payments`

Payload sugerido:
```json
{
  "method": "BANK_TRANSFER",
  "amount": 150,
  "reference": "WIRE-7782",
  "origin": "OTC",
  "gateway": null,
  "notes": "Front desk payment"
}
```

## Backfill Mapping Exacto

### `[RES_CHARGES_META]`
- `dailyRate` -> `ReservationPricingSnapshot.dailyRate`
- `taxRate` -> `ReservationPricingSnapshot.taxRate`
- `selectedInsuranceCode` -> `ReservationPricingSnapshot.selectedInsuranceCode`
- `chargeRows[]` -> `ReservationCharge[]`

### `[RES_DEPOSIT_META]`
- `requireDeposit` -> `depositRequired`
- `depositMode` -> `depositMode`
- `depositValue` -> `depositValue`
- `depositPercentBasis` -> `depositBasisJson`
- `depositAmountDue` -> `depositAmountDue`

### `[SECURITY_DEPOSIT_META]`
- `requireSecurityDeposit` -> `securityDepositRequired`
- `securityDepositAmount` -> `securityDepositAmount`

### `[PAYMENT <ISO>]`
- `paidAt` -> `ReservationPayment.paidAt`
- gateway/method -> `ReservationPayment.gateway` y `method`
- amount -> `ReservationPayment.amount`
- reference -> `ReservationPayment.reference`
- `origin = MIGRATED_NOTE`

## Queries Que Se Simplifican Con Esto
- total de charges por reservacion
- total pagado por reservacion
- unpaid balance pre-rental
- pagos por metodo
- pagos por gateway
- revenue por fecha de pickup
- deposits due vs collected

## Riesgos
- duplicar pagos entre reservation y agreement si no hay reglas claras
- recalcular balance dos veces si el sync no es idempotente
- mantener `notes` como write path demasiado tiempo

## Mitigaciones
- hacer idempotencia por `reference + amount + paidAt`
- usar source/origin para distinguir migrados vs nativos
- definir una sola funcion backend para postear pago y sincronizar agreement

## Recomendacion Final
No empezar por `additional drivers` ni por `inspections`.

El primer corte correcto es:
1. `ReservationPricingSnapshot`
2. `ReservationCharge`
3. `ReservationPayment`
4. dual-read/dual-write

Eso ataca el mayor volumen de deuda y desbloquea reportes, portal y integraciones con el menor riesgo relativo.
