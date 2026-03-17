# Sprint 1 Backlog - Metadata Migration Foundation

Fecha base: 2026-03-17

## Objetivo
Eliminar la dependencia de metadata critica embebida en `Reservation.notes` y preparar una base estructurada para reportes, portal cliente, integraciones y automatizacion.

## Hallazgo Principal
Hoy `notes` cumple demasiados roles a la vez:
- observaciones humanas
- metadata operativa
- event log
- fallback de persistencia

Eso vuelve fragiles los reportes, complica integraciones y hace dificil competir con plataformas mas maduras.

## Inventario Actual De Bloques En `notes`

### 1. `[RES_CHARGES_META]`
Uso:
- seleccion de servicios
- seleccion de fees
- insurance seleccionada
- charge rows generadas
- tax rate y daily rate

Escrito en:
- [page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/page.js)

Leido en:
- [page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/page.js)
- [payments/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/payments/page.js)
- [customer-portal.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/customer-portal/customer-portal.routes.js)
- [rental-agreements.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/rental-agreements/rental-agreements.service.js)

Problema:
- ya existen [RentalAgreementCharge](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/prisma/schema.prisma#L456), pero el origen sigue siendo texto embebido

### 2. `[RES_DEPOSIT_META]`
Uso:
- deposito requerido al reservar
- modo de deposito
- valor
- basis
- amount due now

Escrito en:
- [reservations.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/reservations/reservations.routes.js)
- [page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/page.js)

Leido en:
- [page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/page.js)
- [customer-portal.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/customer-portal/customer-portal.routes.js)
- [rental-agreements.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/rental-agreements/rental-agreements.service.js)

Problema:
- mezcla configuracion y estado del deposito en texto libre

### 3. `[SECURITY_DEPOSIT_META]`
Uso:
- security deposit requerido
- monto

Escrito en:
- [page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/page.js)

Leido en:
- [rental-agreements.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/rental-agreements/rental-agreements.service.js)

Problema:
- parte ya vive en [RentalAgreement](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/prisma/schema.prisma#L355), parte aun nace desde texto

### 4. `[RES_ADDITIONAL_DRIVERS]`
Uso:
- additional drivers capturados desde UI

Escrito en:
- [additional-drivers/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/additional-drivers/page.js)

Leido en:
- [additional-drivers/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/additional-drivers/page.js)
- [customer-portal.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/customer-portal/customer-portal.routes.js)
- [rental-agreements.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/rental-agreements/rental-agreements.service.js)

Problema:
- ya existe [AgreementDriver](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/prisma/schema.prisma#L431), pero reservation-level sigue guardado en texto

### 5. `[INSPECTION_REPORT]`
Uso:
- checkout inspection
- checkin inspection
- fotos y danos

Escrito en:
- [rental-agreements.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/rental-agreements/rental-agreements.service.js)

Leido en:
- [rental-agreements.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/rental-agreements/rental-agreements.service.js)
- [inspection-report/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/inspection-report/page.js)
- [vehicles/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/vehicles/page.js)

Problema:
- inspecciones son datos de primer nivel y no deberian vivir embebidas en `notes`

### 6. `[PAYMENT <ISO>]`
Uso:
- OTC/manual payments
- portal payment append-only note line

Escrito en:
- [payments/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/payments/page.js)
- [customer-portal.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/customer-portal/customer-portal.routes.js)

Leido en:
- [payments/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reservations/[id]/payments/page.js)
- [customer-portal.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/customer-portal/customer-portal.routes.js)
- [rental-agreements.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/rental-agreements/rental-agreements.service.js)

Problema:
- ya existe [RentalAgreementPayment](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/prisma/schema.prisma#L477), pero reservation-level sigue usando parsing de texto

### 7. Notas-evento tipo request log
Tipos encontrados:
- `[REQUEST CUSTOMER INFO ...]`
- `[REQUEST SIGNATURE ...]`
- `[REQUEST PAYMENT ...]`
- `[ADMIN OVERRIDE ...]`
- `[UNDERAGE ALERT]`

Escritos en:
- [reservations.routes.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/reservations/reservations.routes.js)
- [reservations.service.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/backend/src/modules/reservations/reservations.service.js)

Problema:
- algunos de estos deberian ser `AuditLog`
- otros deberian ser campos estructurados o alerts persistidos

## Decision De Ownership Propuesta

### Reservation domain
Debe ser owner de:
- quote selections previas al agreement
- reservation deposit requirement
- customer info request tokens y estados
- signature request status
- payment request status
- underage alert estructurado
- additional drivers draft/pre-rental

### Rental agreement domain
Debe ser owner de:
- charges finales
- payments finales
- inspections
- agreement drivers definitivos
- security deposit lifecycle

### Audit/event domain
Debe ser owner de:
- request issued
- request emailed
- admin override
- portal payment completed
- portal signature completed

## Mapa De Migracion Propuesto

### A. Charges metadata
Mover a:
- `ReservationQuoteSnapshot` o `ReservationChargeSelection`
- `ReservationSelectedService`
- `ReservationSelectedFee`
- `ReservationSelectedInsurance`

Si se quiere un primer paso mas pequeno:
- crear solo `ReservationPricingSnapshot` con JSON estructurado en columna propia
- despues normalizar a tablas hijas

### B. Deposit metadata
Mover a:
- campos directos en `Reservation`
  - `depositRequired`
  - `depositMode`
  - `depositValue`
  - `depositBasis`
  - `depositAmountDue`

### C. Security deposit metadata
Mover a:
- `Reservation.securityDepositRequired`
- `Reservation.securityDepositAmount`
- agreement mantiene estado de captura/liberacion

### D. Additional drivers
Mover a:
- tabla `ReservationDriver`

Campos sugeridos:
- reservationId
- firstName
- lastName
- address
- dateOfBirth
- licenseNumber
- licenseImageUrl o documentRef
- status

### E. Inspection report
Mover a:
- tabla `AgreementInspection`

Campos sugeridos:
- rentalAgreementId
- phase (`CHECKOUT` / `CHECKIN`)
- inspectedAt
- inspectedBy
- ipAddress
- odometer
- fuelLevel
- cleanliness
- damagesJson
- photosJson o tabla hija `AgreementInspectionPhoto`

### F. Payment lines
Mover a:
- usar siempre `RentalAgreementPayment` para pagos reales
- crear `ReservationPaymentIntent` o `ReservationPaymentRequest` si hace falta representar pagos antes del agreement

### G. Request/email events
Mover a:
- `AuditLog`
- o tabla nueva `ReservationCommunicationEvent` si se necesita reporting comercial/mensajeria

## Backlog Tecnico De Sprint 1

### Historia 1
Como equipo tecnico, queremos un inventario formal de metadata embebida para dejar de expandir deuda estructural.

Tareas:
- documentar cada marker actual
- documentar donde se escribe
- documentar donde se lee
- marcar si representa metadata, evento o dato final

### Historia 2
Como arquitectura, queremos definir ownership por agregado para evitar duplicidad entre reservation y agreement.

Tareas:
- decidir que datos viven en reservation
- decidir que datos viven en agreement
- decidir que eventos van a audit log

### Historia 3
Como producto/reporting, queremos identificar el minimo de datos estructurados necesarios para reportes v1.

Tareas:
- revenue por vehiculo/dia
- no-show report
- deposit capture/release
- payment channel breakdown
- inspection completion rate

### Historia 4
Como backend, queremos un plan de migracion incremental sin romper flujos actuales.

Tareas:
- definir lectura dual legacy+nueva
- definir backfill de datos existentes
- definir fecha de corte para dejar de escribir markers

### Historia 5
Como frontend, queremos dejar de construir payloads criticos concatenando texto.

Tareas:
- identificar pantallas que hoy ensamblan `notes`
- definir nuevo contrato API para cada flujo

## Tareas Tecnicas Concretas

### Backend / data
- diseñar nuevos modelos Prisma
- mapear campos legacy -> campos nuevos
- definir estrategia de backfill
- definir endpoints que dejaran de aceptar mutaciones por `notes`

### Frontend
- reservation detail charges editor
- reservation payments OTC
- additional drivers page
- inspection report UI

### Reporting
- listar queries que hoy no son confiables por depender de parsing
- priorizar queries que pasaran a leer datos estructurados primero

## Riesgos
- duplicar datos entre reservation y agreement sin owner claro
- migrar inspecciones sin definir storage de fotos
- romper portal publico si pago/request events cambian sin compatibilidad
- seguir agregando mas markers durante el sprint

## Definicion De Done Para Sprint 1
- inventario completo aprobado
- ownership por dominio aprobado
- propuesta de schema aprobada
- plan de lectura dual aprobado
- backlog de Sprint 2 listo
- regla acordada: no introducir nuevos markers en `notes`

## Recomendacion De Ejecucion
1. Cerrar inventario y ownership
2. Diseñar schema nuevo
3. Definir compatibilidad legacy
4. Preparar Sprint 2 con foco en `charges`, `payments` e `inspections`

## Resultado Esperado
Al terminar Sprint 1 todavia puede existir compatibilidad legacy, pero ya no debe haber ambiguedad sobre:
- que vive en `notes`
- que debe migrarse
- quien es owner de cada dato
- cual es el siguiente corte de implementacion
