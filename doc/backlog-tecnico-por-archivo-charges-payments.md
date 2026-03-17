# Backlog Tecnico Por Archivo - Charges + Payments

Fecha base: 2026-03-17

## Objetivo
Traducir la propuesta de schema para `charges + payments` en un plan de implementación por archivo, con secuencia recomendada, riesgos y pruebas.

## Scope De Este Corte
- `ReservationPricingSnapshot`
- `ReservationCharge`
- `ReservationPayment`
- soporte a `BANK_TRANSFER`
- dual-write
- dual-read
- backfill legacy desde `notes`

Fuera de scope en este corte:
- inspections
- additional drivers
- event log completo
- limpieza final de todos los markers legacy

## Orden Recomendado De Implementacion
1. `schema.prisma`
2. migracion Prisma
3. helpers/backend shared logic
4. `reservations.routes.js`
5. `customer-portal.routes.js`
6. `rental-agreements.service.js`
7. `frontend reservation detail`
8. `frontend reservation payments`
9. smoke tests + backfill

## Backlog Por Archivo

## 1. [backend/prisma/schema.prisma](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/prisma/schema.prisma)

### Cambios
- extender enum `AgreementPaymentMethod` con `BANK_TRANSFER`
- agregar enum `ReservationPaymentOrigin`
- agregar modelo `ReservationPricingSnapshot`
- agregar modelo `ReservationCharge`
- agregar modelo `ReservationPayment`
- agregar relaciones nuevas en `Reservation`

### Notas
- `ReservationCharge` debe espejar lo suficiente de `RentalAgreementCharge`
- `ReservationPayment` debe permitir representar pagos antes y despues de agreement

### Riesgos
- olvidar indices por `reservationId`
- no dejar claro el owner de `depositAmountDue` y `securityDepositAmount`

## 2. `backend/prisma/migrations/<nuevo>` 

### Cambios
- migration SQL para:
  - nuevos enums
  - nuevas tablas
  - nuevas foreign keys
  - indices

### Notas
- separar bien cambios de schema de cualquier backfill de datos
- si Prisma complica enum alter en Postgres, dejarlo manejado en SQL claro

## 3. Nuevo helper sugerido: `backend/src/modules/reservations/reservation-pricing.service.js`

### Cambios
- centralizar logica de:
  - snapshot de pricing
  - persistencia de `ReservationCharge`
  - persistencia de `ReservationPayment`
  - total/subtotal/tax aggregation
  - sync opcional a agreement

### Responsabilidades sugeridas
- `saveReservationPricingSnapshot(reservationId, payload, scope)`
- `listReservationCharges(reservationId, scope)`
- `replaceReservationCharges(reservationId, payload, scope)`
- `postReservationPayment(reservationId, payload, scope, actorUserId)`
- `calculateReservationOutstanding(reservationId, scope)`
- `backfillReservationPricingFromNotes(reservation)`

### Razón
- evitar meter mas logica pesada dentro de `reservations.routes.js` y `customer-portal.routes.js`

## 4. [backend/src/modules/reservations/reservations.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/reservations/reservations.routes.js)

### Cambios
- en create:
  - dejar de escribir `[RES_DEPOSIT_META]` como fuente primaria
  - persistir `ReservationPricingSnapshot`
- agregar endpoints nuevos:
  - `GET /:id/pricing`
  - `PUT /:id/pricing`
  - `GET /:id/payments`
  - `POST /:id/payments`
- en `request-payment`:
  - seguir usando token request
  - leer total desde modelo estructurado, no desde `notes`
- en `send-request-email`:
  - no depender de metadata embebida para link/total
- decidir si `/:id/payments/:paymentId/delete` y refund siguen siendo agreement-level o pasan a reservation-level facade

### Riesgos
- mezclar pagos reservation-level con payment delete/refund agreement-level sin regla clara
- seguir aceptando mutaciones arbitrarias via `PATCH notes`

### Recomendacion
- mantener compatibilidad corta, pero marcar como deprecated cualquier write path que arme metadata en `notes`

## 5. [backend/src/modules/customer-portal/customer-portal.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/customer-portal/customer-portal.routes.js)

### Cambios
- `buildReservationBreakdown(reservation)`:
  - leer primero `ReservationCharge[]`
  - fallback a parsing de `notes`
- `amountDueForReservation(...)`:
  - calcular desde `ReservationPayment[]` y `ReservationPricingSnapshot`
  - fallback legacy si no existe data nueva
- `postPayment(...)`:
  - crear siempre `ReservationPayment`
  - si hay agreement activo, crear `RentalAgreementPayment`
  - dejar de escribir `[PAYMENT ...]` como fuente primaria
- mantener `paymentRequestToken` lifecycle como hoy

### Riesgos
- duplicar pagos entre reservation/agreement
- no hacer idempotencia en pagos del portal

### Recomendacion
- idempotencia por `reservationId + reference + amount`

## 6. [backend/src/modules/rental-agreements/rental-agreements.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/rental-agreements/rental-agreements.service.js)

### Cambios
- `startFromReservation`:
  - leer `ReservationCharge[]` como fuente primaria
  - fallback a `RES_CHARGES_META`
- `parseReservationPaymentsFromNotes`:
  - dejarlo como compatibilidad legacy
- donde hoy importa pagos desde notas:
  - priorizar `ReservationPayment[]`
- sync reservation -> agreement:
  - mapear reservation charges a `RentalAgreementCharge`
  - mapear reservation payments a `RentalAgreementPayment` solo cuando aplique

### Riesgos
- sobreescribir agreement charges cuando ya hay agreement avanzado
- recalcular mal `balance`

### Recomendacion
- sync solo para agreements no cerrados/no cancelados
- no borrar pagos existentes sin reconciliation explicita

## 7. [frontend/src/app/reservations/[id]/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/page.js)

### Cambios
- dejar de construir:
  - `[RES_CHARGES_META]`
  - `[RES_DEPOSIT_META]`
  - `[SECURITY_DEPOSIT_META]`
  en `notes`
- leer charges desde `GET /api/reservations/:id/pricing`
- guardar charges desde `PUT /api/reservations/:id/pricing`
- seguir permitiendo mostrar `notes`, pero solo como comentario humano
- mantener compatibilidad visual con datos legacy mientras haya dual-read

### Sub-bloques a tocar
- editor de charges
- selected services / selected fees
- deposit overrides
- display total / display charge rows

### Riesgos
- mezclar estado viejo (`row.notes`) con estado nuevo (`pricing`)
- romper pantallas que hoy usan helpers locales de parsing

### Recomendacion
- crear un adapter de UI:
  - `pricingViewModelFromApi()`
  - `pricingPayloadFromForm()`

## 8. [frontend/src/app/reservations/[id]/payments/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/payments/page.js)

### Cambios
- dejar de parsear `[PAYMENT ...]`
- leer lista desde `GET /api/reservations/:id/payments`
- registrar OTC payment con `POST /api/reservations/:id/payments`
- leer total desde modelo estructurado de pricing
- soportar `BANK_TRANSFER` de forma consistente

### Riesgos
- si agreement ya existe, UI puede mostrar pagos duplicados si mezcla reservation + agreement sin consolidar

### Recomendacion
- esta pantalla debe trabajar solo con `ReservationPayment[]`
- si quiere mostrar agreement payments, hacerlo como vista consolidada separada

## 9. [frontend/src/app/customer/pay/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/customer/pay/page.js)

### Cambios
- minimo impacto
- validar que el breakdown y amount due salgan de backend ya estructurado
- no necesita armar metadata; solo consumir el API nuevo/ajustado

### Riesgos
- ninguno grande si backend mantiene contrato JSON

## 10. Posible archivo nuevo de backfill
Sugerencia:
- `backend/scripts/backfill-reservation-pricing-payments.mjs`

### Cambios
- recorrer reservations existentes
- parsear:
  - `RES_CHARGES_META`
  - `RES_DEPOSIT_META`
  - `SECURITY_DEPOSIT_META`
  - `[PAYMENT ...]`
- poblar:
  - `ReservationPricingSnapshot`
  - `ReservationCharge`
  - `ReservationPayment`
- marcar registros con `source = MIGRATED_NOTE`

### Riesgos
- duplicar backfill si se corre dos veces

### Recomendacion
- hacerlo idempotente
- no reinsertar si ya existe data estructurada para la reservation

## 11. Tests / smoke tests sugeridos

### Backend
- crear reservation con deposito requerido
- editar pricing desde API nueva
- crear OTC payment
- crear payment via portal
- iniciar rental y verificar sync a agreement
- recalcular balance correctamente

### Frontend
- reservation detail muestra charges sin parsing legacy
- reservation payments muestra `BANK_TRANSFER`
- payment portal sigue funcionando para Stripe/Authorize.Net/Square

### Backfill
- reservation legacy con markers migra bien
- reservation nueva sin markers funciona igual

## Orden De Trabajo Semana A Semana

### Bloque A
- schema Prisma
- migration
- helper/service nuevo

### Bloque B
- endpoints backend de pricing/payments
- dual-write

### Bloque C
- rental agreement sync
- portal payment sync

### Bloque D
- frontend reservation detail
- frontend reservation payments

### Bloque E
- backfill script
- smoke tests

## Decision De Rollout

### Etapa 1
Escribir nuevo + legacy

### Etapa 2
Leer nuevo primero, legacy fallback

### Etapa 3
Frontend deja de escribir metadata en `notes`

### Etapa 4
Backfill completo

### Etapa 5
Desactivar parsing legacy como fuente primaria

## Definicion De Done De Este Corte
- schema nuevo aplicado
- pricing y payments ya se persisten estructurados
- frontend principal deja de construir markers para charges/payments
- portal payment usa `ReservationPayment`
- rental agreement sync sigue funcionando
- fallback legacy sigue operando para data vieja

## Siguiente Paso Recomendado
Convertir este backlog en:
- tareas implementables por archivo
- con checklist
- y luego empezar por `schema.prisma` + migracion
