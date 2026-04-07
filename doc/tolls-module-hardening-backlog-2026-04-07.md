# Tolls Module Hardening Backlog

Fecha base: 2026-04-07

## Objetivo
Endurecer el modulo de `tolls` para que pueda operar mejor en escenarios reales de rental y loaner:

- matching correcto cuando hay `vehicle swap`
- asignacion de peajes por tramo efectivo del vehiculo, no solo por la reservacion completa
- cola de revision para peajes generados sin `check out` formal
- decision operativa de `despachado / no despachado`
- soporte mas fuerte para `toll package` via `AdditionalService.coversTolls`
- registrar uso de peajes aunque por reglas del tenant no se cobren

## Hallazgos Del Estado Actual
1. El matching actual usa principalmente `reservation.vehicleId` y la ventana `pickupAt/returnAt`.
2. El sistema ya guarda swaps en `RentalAgreementVehicleSwap`, pero `tolls` no usa ese historial como fuente de verdad.
3. No existe un estado formal de `dispatch confirmation required` para peajes que aparecen antes del `CHECKED_OUT`.
4. `coversTolls` ya evita crear cargos, pero no deja un ledger fuerte de uso vs facturacion.
5. La UI actual de `/tolls` y de la reservacion muestra `Needs review`, pero no tiene un subflujo especializado para swaps ni despacho no confirmado.

## Resultado Esperado
Al terminar este hardening, el modulo debe poder:

- decidir que vehiculo era responsable del peaje segun el momento exacto del evento
- asignar peajes al contrato correcto aunque haya swap
- separar `usage` de `billing`
- no cobrar peajes cubiertos por paquete, pero si dejar evidencia de uso
- pedir confirmacion cuando el carro parece generar peajes sin que la renta haya sido despachada formalmente
- dar trazabilidad clara de por que un peaje fue cobrado, cubierto, excluido o disputado

## Scope De Este Trabajo
- matching swap-aware
- ventanas de responsabilidad por vehiculo
- dispatch confirmation review flow
- toll package hardening
- mejores razones de match / review
- UI de revision y reservacion mejor alineada a esos estados
- pruebas del modulo de peajes

Fuera de scope en este corte:
- OCR / AI para tickets
- integraciones nuevas de proveedores de peajes
- cobro automatico a tarjeta
- dispute automation avanzada con terceros

## Principios De Implementacion
1. `usage` y `billing` no son lo mismo.
2. Un `swap` crea tramos de responsabilidad, no solo cambia el `vehicleId` actual.
3. Un peaje previo a `CHECKED_OUT` no debe auto-billarse sin confirmacion operativa.
4. Toda exclusion o cobertura debe dejar rastro explicable.
5. La reservacion debe poder mostrar por que un peaje quedo cobrado, cubierto o excluido.

## Orden Recomendado De Implementacion
1. modelo de decision por tramos de vehiculo
2. matching swap-aware en backend
3. estado `dispatch confirmation required`
4. decision actions `confirm dispatched / mark not dispatched`
5. `usage ledger` para toll packages
6. UI en `/tolls` y en reservacion
7. pruebas

## 1. [backend/src/modules/tolls/tolls.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/tolls/tolls.service.js)

### Cambios
- extraer helpers nuevos para:
  - `listReservationVehicleResponsibilityWindows`
  - `findResponsibleVehicleWindow`
  - `buildDispatchReviewDecision`
  - `buildTollUsageDecision`
- cambiar `listReservationCandidates(...)` para no depender solo de `reservation.vehicleId`
- cambiar `scoreCandidate(...)` para puntuar por:
  - vehiculo exacto en el tramo correcto
  - coincidencia por `plate`
  - coincidencia por `tag`
  - coincidencia por `sello`
  - si el peaje cae antes de `CHECKED_OUT`
  - si el peaje cae despues de un `swap`
- extender `buildMatchSuggestion(...)` con razones mas estructuradas
- endurecer `confirmMatch(...)`, `postToReservation(...)` y `applyReviewAction(...)`
- separar `usage` vs `billing` dentro de `syncReservationTollCharges(...)`

### Responsabilidades Nuevas
- resolver responsabilidad por tramo del contrato
- decidir si un peaje:
  - se cobra
  - se cubre por paquete
  - queda pendiente por confirmacion de despacho
  - se excluye por no despachado
- guardar notas de decision mas explicables

### Riesgos Actuales
- usar solo el `vehicleId` actual de la reservacion para todo
- cobrar peajes anteriores a un swap al vehiculo equivocado
- cobrar peajes que salieron antes de que operaciones confirme que el carro realmente salio

## 2. [backend/src/modules/tolls/tolls.routes.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/tolls/tolls.routes.js)

### Cambios
- agregar endpoints nuevos para review operativa, por ejemplo:
  - `POST /transactions/:id/confirm-dispatch`
  - `POST /transactions/:id/mark-not-dispatched`
  - `GET /transactions/:id/review-context`
- mantener `review-action` para acciones generales, pero no mezclarlo con decisiones de despacho

### Objetivo
- hacer el flujo mas claro para operaciones
- no enterrar decisiones importantes dentro de un solo endpoint generico

## 3. [backend/prisma/schema.prisma](/Users/hectorpadilla/Code/RideFleetManagement/backend/prisma/schema.prisma)

### Cambios Recomendados
- extender `TollTransaction` con campos nuevos si hace falta:
  - `billingDecision`
  - `usageDecision`
  - `dispatchReviewStatus`
  - `dispatchConfirmedAt`
  - `dispatchConfirmedByUserId`
  - `usageRecordedAt`
- considerar `reviewCategory` para distinguir:
  - `SWAP_REVIEW`
  - `DISPATCH_CONFIRMATION_REQUIRED`
  - `LOW_CONFIDENCE_MATCH`
  - `MANUAL_DISPUTE`
- considerar un modelo nuevo tipo `TollUsageRecord` si se quiere separar fuerte usage vs billing

### Recomendacion
- si queremos movernos rapido:
  - arrancar con campos nuevos en `TollTransaction`
- si queremos una base mas premium:
  - crear `TollUsageRecord`

### Riesgos
- meter demasiada estructura sin usarla
- dejar mezclado `status`, `billingStatus`, `needsReview` y decision operativa en un solo campo ambiguo

## 4. [backend/prisma/migrations/<nuevo-tolls-hardening>](/Users/hectorpadilla/Code/RideFleetManagement/backend/prisma/migrations)

### Cambios
- migration para campos nuevos del modulo de peajes
- indices por:
  - `tenantId, dispatchReviewStatus`
  - `tenantId, reservationId, transactionAt`
  - `tenantId, vehicleId, transactionAt`

### Objetivo
- que la cola de revision siga rapida
- que los filtros de peajes por reservacion y vehiculo no se degraden

## 5. [backend/src/modules/reservations/reservations.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/reservations/reservations.service.js)

### Cambios
- exponer helper reutilizable para historial de swaps por reservacion / rental agreement
- dejar una forma clara de consultar:
  - vehiculo inicial
  - fecha efectiva de swap
  - vehiculo nuevo
  - intervalos de responsabilidad

### Objetivo
- evitar que `tolls` duplique logica de swaps

### Riesgos
- hoy el swap se persiste bien, pero no hay una capa clara de lectura orientada a operaciones posteriores

## 6. [backend/src/modules/rental-agreements/rental-agreements.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/rental-agreements/rental-agreements.service.js)

### Cambios
- revisar si conviene publicar helper o query para `RentalAgreementVehicleSwap`
- si existe closeout o posting relacionado a tolls, asegurar que respete:
  - peajes cubiertos
  - peajes excluidos
  - peajes en disputa

### Objetivo
- que contrato y peajes cuenten la misma historia

## 7. Nuevo helper sugerido: [backend/src/modules/tolls/tolls-responsibility.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/tolls)

### Responsabilidades
- construir `vehicle responsibility windows`
- devolver algo como:
  - `vehicleId`
  - `effectiveStartAt`
  - `effectiveEndAt`
  - `source`
  - `swapId`

### Input esperado
- reservacion
- rental agreement
- rentalAgreementVehicleSwap rows

### Objetivo
- que el matching de peajes se base en ventanas reales y no en una sola asignacion final

## 8. Nuevo helper sugerido: [backend/src/modules/tolls/tolls-billing-policy.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/tolls)

### Responsabilidades
- resolver si el peaje:
  - genera cargo
  - solo registra uso
  - dispara fee de toll policy
  - queda cubierto por paquete
- evaluar:
  - `AdditionalService.coversTolls`
  - `tollPolicyEnabled`
  - `tollAdditionalFeeEnabled`
  - reglas del tenant

### Objetivo
- sacar de `tolls.service.js` la logica de policy y package coverage

## 9. Nuevo helper sugerido: [backend/src/modules/tolls/tolls-dispatch-review.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/tolls)

### Responsabilidades
- detectar peajes que caen:
  - antes de checkout
  - en ventana ambigua
  - sin evidencia clara de despacho
- preparar decision:
  - `CONFIRM_DISPATCHED`
  - `MARK_NOT_DISPATCHED`

### Objetivo
- convertir `needsReview` en una razon operativa clara

## 10. [frontend/src/app/tolls/page.js](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/tolls/page.js)

### Cambios
- mostrar `review category`
- mostrar razon explicable:
  - `matched by tag after swap`
  - `pre-checkout toll requires dispatch confirmation`
  - `covered by toll package`
- agregar botones nuevos:
  - `Confirm Vehicle Was Dispatched`
  - `Mark Not Dispatched`
  - `Open Reservation`
  - `Open Swap Context`
- agregar badge visual para:
  - `Covered`
  - `Usage Only`
  - `Dispatch Review`
  - `Swap Review`

### Objetivo
- que operaciones no tenga que adivinar que hacer

## 11. [frontend/src/app/reservations/[id]/page.js](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/reservations/[id]/page.js)

### Cambios
- mejorar panel `Toll Review` para mostrar:
  - si el peaje fue cubierto por paquete
  - si solo se registro uso
  - si viene de tramo post-swap
  - si esta pendiente de confirmacion de despacho
- agregar CTA para resolver peajes ambiguos desde la reservacion

### Objetivo
- que el agente pueda resolver el caso sin salir obligado a `/tolls`

## 12. [frontend/src/app/reservations/[id]/swap/page.js](/Users/hectorpadilla/Code/RideFleetManagement/frontend/src/app/reservations/[id]/swap/page.js)

### Cambios
- opcionalmente mostrar nota operativa al hacer swap:
  - “future tolls after this timestamp should attach to the new vehicle”
- no necesita cobrar nada aqui, pero si dejar claro el efecto operacional

### Objetivo
- reforzar mental model del equipo

## 13. [backend/src/modules/additional-services/additional-services.service.js](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/additional-services/additional-services.service.js)

### Cambios
- revisar consistencia de `coversTolls`
- asegurar que el servicio pueda ser encontrado de forma confiable en `reservation.charges`
- considerar metadata futura para packages, por ejemplo:
  - `tollCoverageMode`
  - `maxCoveredAmount`
  - `maxCoveredEvents`

### Objetivo
- dejar `coversTolls` listo para crecer mas alla de boolean simple

## 14. [backend/src/modules/tolls/tolls.service.test.mjs](/Users/hectorpadilla/Code/RideFleetManagement/backend/src/modules/tolls)

### Pruebas Recomendadas
- peaje dentro de ventana normal sin swap
- peaje antes del checkout requiere confirmacion
- peaje despues de swap se asigna al tramo nuevo
- peaje antes de swap no se mueve al vehiculo nuevo
- peaje cubierto por package no crea cargo pero si registra uso
- `MARK_NOT_DISPATCHED` excluye el peaje de la reservacion
- `CONFIRM_DISPATCHED` mantiene el peaje y permite sync posterior

### Objetivo
- que este modulo tenga la misma disciplina de pruebas que planner y revenue

## 15. [doc/ridefleet-knowledge-base-2026-03-25.md](/Users/hectorpadilla/Code/RideFleetManagement/doc/ridefleet-knowledge-base-2026-03-25.md)

### Cambios Recomendados
- documentar reglas nuevas:
  - swaps y toll windows
  - dispatch confirmation review
  - toll package usage vs billing

### Objetivo
- alinear operacion, soporte y desarrollo

## MVP Recomendado
Si queremos movernos con impacto rapido:

1. ventanas de responsabilidad por swap
2. dispatch confirmation required
3. confirm / not dispatched actions
4. package coverage sin cobro pero con uso registrado
5. UI basica en `/tolls`

## Definicion De Done
- peajes post-swap se asignan al tramo correcto
- peajes pre-checkout no se auto-billan sin confirmacion
- `coversTolls` registra uso y evita cobro segun reglas
- `/tolls` muestra categorias de review claras
- reservacion muestra peajes cobrados, cubiertos, excluidos o pendientes
- pruebas del modulo cubren swaps, dispatch review y toll package behavior

## Siguiente Paso Recomendado
Implementar primero backend:

1. `tolls-responsibility.service.js`
2. `tolls-dispatch-review.service.js`
3. hardening de `tolls.service.js`
4. rutas nuevas de review
5. luego UI en `/tolls` y reservacion
