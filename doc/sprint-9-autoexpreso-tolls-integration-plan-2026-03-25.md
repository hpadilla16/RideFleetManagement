# Sprint 9 AutoExpreso Tolls Integration Plan

Fecha base: 2026-03-25

## Objetivo

Integrar el software `AutoExpresso_Toll_Matcher_Build` dentro de Ride Fleet como
un modulo opcional por tenant, usando la flota real del tenant en `Vehicle` y
haciendo matching de peajes contra `Reservation` basado en:

- tenant
- vehicle del tenant
- tablilla
- tag
- sello
- fecha y hora de la transaccion
- pickupAt y returnAt de la reservacion

La meta no es incrustar la aplicacion desktop tal cual. La meta es convertir su
motor de importacion, scraping, normalizacion y matching en un modulo backend +
frontend dentro de Ride Fleet.

## Estado Actual Del Software Externo

Proyecto revisado:

- `C:\Projects\AutoExpresso_Toll_Matcher_Build`

Arquitectura actual:

- Python
- Tkinter desktop app
- SQLite local
- Playwright scraper
- scheduler local
- matching logic local

Capacidades utiles actuales:

- importar inventory
- importar reservations
- scrapear AutoExpreso
- normalizar tablilla, tag y sello
- separar assigned y unassigned tolls
- generar reportes basicos

Limitaciones actuales:

- no es multi-tenant
- no usa la base de Ride Fleet
- no usa los vehicles ni reservations reales de Ride Fleet
- depende de GUI desktop
- el scraping actual es fragil y parece tener errores en source actual

## Principio De Integracion

El modulo nuevo debe usar Ride Fleet como fuente de verdad.

Eso significa:

- `Vehicle` del tenant es la flota canonica
- `Reservation` del tenant es el calendario canonico
- `Customer` y `RentalAgreement` siguen siendo el backbone de cobro/cierre

El modulo de peajes solo agrega:

- ingesta de transacciones de peaje
- motor de matching
- cola de revision
- asignacion a reservation
- opcion de cobro o closeout posterior

## Como Debe Funcionar En Ride Fleet

## Activacion

El modulo debe activarse por tenant:

- `tollsEnabled`

Y opcionalmente por usuario mediante `moduleAccess`.

## Flujo Operativo

1. `SUPER_ADMIN` o `ADMIN` activa `Tolls` para el tenant
2. tenant configura provider:
   - AutoExpreso
   - credenciales
   - reglas de matching
3. el sistema importa o scrapea peajes
4. cada peaje entra como `TollTransaction`
5. el sistema intenta matching automatico
6. si el match es fuerte:
   - crea `TollAssignment`
7. si el match no es suficiente:
   - entra a `Unassigned Review Queue`
8. ops revisa y asigna manualmente si hace falta
9. el peaje queda visible en:
   - reservation
   - reports
   - closeout si aplica
10. si el customer disputa:
   - issue center puede intervenir

## Schema Recomendado

## Nuevos Enums

```prisma
enum TollProvider {
  AUTOEXPRESO
}

enum TollTransactionStatus {
  IMPORTED
  MATCHED
  NEEDS_REVIEW
  BILLED
  DISPUTED
  VOID
}

enum TollMatchStatus {
  SUGGESTED
  CONFIRMED
  REJECTED
  AUTO_CONFIRMED
}

enum TollBillingStatus {
  PENDING
  POSTED_TO_RESERVATION
  POSTED_TO_AGREEMENT
  WAIVED
  DISPUTED
}
```

## Nuevos Modelos

```prisma
model TollProviderAccount {
  id                    String       @id @default(cuid())
  tenantId              String
  tenant                Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  provider              TollProvider
  isActive              Boolean      @default(true)
  username              String?
  passwordEncrypted     String?
  accountNumber         String?
  settingsJson          String?
  lastSyncAt            DateTime?
  lastSyncStatus        String?
  lastSyncMessage       String?
  createdAt             DateTime     @default(now())
  updatedAt             DateTime     @updatedAt

  importRuns            TollImportRun[]
  transactions          TollTransaction[]

  @@index([tenantId, provider, isActive])
}

model TollImportRun {
  id                    String       @id @default(cuid())
  tenantId              String
  tenant                Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  providerAccountId     String
  providerAccount       TollProviderAccount @relation(fields: [providerAccountId], references: [id], onDelete: Cascade)
  startedAt             DateTime     @default(now())
  completedAt           DateTime?
  sourceType            String
  status                String
  importedCount         Int          @default(0)
  matchedCount          Int          @default(0)
  reviewCount           Int          @default(0)
  errorMessage          String?
  metadataJson          String?
  createdAt             DateTime     @default(now())
  updatedAt             DateTime     @updatedAt

  transactions          TollTransaction[]

  @@index([tenantId, startedAt])
}

model TollTransaction {
  id                    String       @id @default(cuid())
  tenantId              String
  tenant                Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  providerAccountId     String?
  providerAccount       TollProviderAccount? @relation(fields: [providerAccountId], references: [id])
  importRunId           String?
  importRun             TollImportRun? @relation(fields: [importRunId], references: [id])

  externalId            String?
  transactionAt         DateTime
  transactionDate       DateTime?
  transactionTimeRaw    String?
  amount                Decimal      @db.Decimal(10, 2)
  location              String?
  lane                  String?
  direction             String?

  plateRaw              String?
  plateNormalized       String?
  tagRaw                String?
  tagNormalized         String?
  selloRaw              String?
  selloNormalized       String?

  vehicleId             String?
  vehicle               Vehicle?     @relation(fields: [vehicleId], references: [id])
  reservationId         String?
  reservation           Reservation? @relation(fields: [reservationId], references: [id])

  status                TollTransactionStatus @default(IMPORTED)
  matchConfidence       Decimal?     @db.Decimal(5, 2)
  needsReview           Boolean      @default(false)
  billingStatus         TollBillingStatus @default(PENDING)

  sourcePayloadJson     String?
  reviewNotes           String?
  createdAt             DateTime     @default(now())
  updatedAt             DateTime     @updatedAt

  assignments           TollAssignment[]

  @@index([tenantId, transactionAt])
  @@index([tenantId, status, transactionAt])
  @@index([tenantId, plateNormalized, transactionAt])
  @@index([tenantId, tagNormalized, transactionAt])
  @@index([tenantId, selloNormalized, transactionAt])
}

model TollAssignment {
  id                    String       @id @default(cuid())
  tenantId              String
  tenant                Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  tollTransactionId     String
  tollTransaction       TollTransaction @relation(fields: [tollTransactionId], references: [id], onDelete: Cascade)
  reservationId         String
  reservation           Reservation  @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  vehicleId             String?
  vehicle               Vehicle?     @relation(fields: [vehicleId], references: [id])
  status                TollMatchStatus
  confidence            Decimal?     @db.Decimal(5, 2)
  matchedByUserId       String?
  matchedByUser         User?        @relation(fields: [matchedByUserId], references: [id])
  matchReason           String?
  createdAt             DateTime     @default(now())
  updatedAt             DateTime     @updatedAt

  @@index([tenantId, reservationId, status])
  @@index([tollTransactionId, status])
}
```

## Cambios En Modelos Existentes

### Tenant

Agregar:

```prisma
tollsEnabled Boolean @default(false)
tollProviderAccounts TollProviderAccount[]
tollTransactions TollTransaction[]
tollAssignments TollAssignment[]
tollImportRuns TollImportRun[]
```

### Vehicle

No hace falta cambiar la identidad base. Ya tenemos:

- `tenantId`
- `plate`

Opcionalmente luego se puede agregar:

```prisma
tollTagNumber String?
tollStickerNumber String?
```

pero inicialmente se puede soportar esto con `vehicle metadata` o una tabla de
aliases para no tocar demasiado el core.

### Reservation

Agregar relacion:

```prisma
tollTransactions TollTransaction[]
tollAssignments TollAssignment[]
```

Y luego opcionalmente:

```prisma
tollBalance Decimal? @db.Decimal(10,2)
```

si se quiere materializar resumen.

## Reglas De Matching

## Regla Principal

Solo se puede hacer match dentro del mismo tenant.

Filtro base:

- `vehicle.tenantId == toll.tenantId`
- `reservation.tenantId == toll.tenantId`

## Paso 1: Resolver Vehicle Del Tenant

Primero se intenta resolver el `Vehicle` usando la flota del tenant.

Prioridad sugerida:

1. `plateNormalized == vehicle.plate normalized`
2. `tagNormalized == vehicle tollTagNumber normalized`
3. `selloNormalized == vehicle tollStickerNumber normalized`
4. combinacion de 2 o mas señales

Si se resuelve un solo vehicle:

- `vehicleId` se setea en `TollTransaction`

Si no:

- queda `needsReview = true`

## Paso 2: Matching Contra Reservation

Una vez encontrado el vehicle del tenant, se buscan reservaciones activas o
historicas del mismo vehicle donde:

- `reservation.vehicleId == toll.vehicleId`
- `reservation.pickupAt <= toll.transactionAt <= reservation.returnAt`

Con una tolerancia configurable.

## Tolerancias Recomendadas

Por defecto:

- `prePickupGraceMinutes = 120`
- `postReturnGraceMinutes = 180`

Ventana efectiva:

- `reservation.pickupAt - prePickupGraceMinutes`
- `reservation.returnAt + postReturnGraceMinutes`

Esto ayuda cuando:

- el peaje entra tarde
- el return se procesa despues
- el viaje cae muy cerca del pickup/return

## Score De Matching

Score recomendado:

- +60 si match exacto por `vehicleId`
- +25 si match exacto por `plate`
- +20 si match por `tag`
- +20 si match por `sello`
- +25 si `transactionAt` cae dentro de pickup/return exacto
- +10 si cae solo en ventana de gracia
- -30 si hay mas de una reservacion superpuesta candidata

Decision:

- `>= 85` -> `AUTO_CONFIRMED`
- `60 - 84` -> `SUGGESTED`
- `< 60` -> `NEEDS_REVIEW`

## Casos Especiales

### Car Sharing

Para `CAR_SHARING`, el matching debe seguir usando la reservacion enlazada,
porque ya existe `Reservation` canonica creada desde el trip.

### Loaner

Para `DEALERSHIP_LOANER`, el peaje puede seguir la misma logica si el loaner usa
una unidad de flota real asignada a la reservacion.

### Reservation Sin Vehicle Asignado

Si la reservacion existe pero no tiene `vehicleId`:

- no auto-confirmar
- dejar `SUGGESTED` o `NEEDS_REVIEW`

### Conflictos

Si dos reservaciones candidatas del mismo tenant usan la misma unidad en una
ventana conflictiva:

- mandar a review manual
- guardar `matchReason = MULTIPLE_CANDIDATES`

## UI Recomendada

## Nuevo Modulo

Ruta:

- `/tolls`

## Pantallas

### Tolls Dashboard

Tarjetas:

- Imported Today
- Auto-Matched
- Needs Review
- Posted To Billing
- Disputed

### Unassigned Review Queue

Tabla con:

- transaccion
- fecha/hora
- plate/tag/sello
- location
- amount
- vehicle sugerido
- reservation sugerida
- confidence

Acciones:

- Confirm Match
- Search Reservation
- Search Vehicle
- Mark Disputed
- Void

### Provider Connection

En `Settings > Tolls`:

- activar modulo
- guardar credenciales AutoExpreso
- correr `Test Connection`
- correr `Collect Now`

### Reservation Detail

En `/reservations/:id`:

- bloque `Tolls`
- peajes asignados
- total peajes
- estado de billing

### Reports

Agregar:

- tolls by reservation
- tolls pending review
- tolls posted vs disputed

## Billing / Cobro

## Fase Inicial

No cobrar automaticamente al principio.

Hacer:

- review queue
- post manual a reservation/agreement

Esto reduce riesgo.

## Fase 2

Permitir:

- `Post Toll To Reservation`

como `ReservationCharge` con:

- `code = TOLL`
- `source = TOLL_MODULE`
- `sourceRefId = tollTransactionId`

## Fase 3

Opcional:

- cobrar en closeout
- incluir en issue/dispute flow

## Credenciales y Seguridad

No guardar credenciales en texto plano.

Recomendado:

- `passwordEncrypted`
- rotation support
- logs sin exponer password

Y cada `Collect Now` o scheduler debe quedar en:

- `TollImportRun`

para auditoria.

## Estrategia De Implementacion

## Phase 1

Objetivo:

- modulo `Tolls` basico dentro de Ride Fleet

Entregables:

- schema nuevo
- feature flag por tenant
- import manual CSV/PDF
- queue de review
- reservation toll panel

## Phase 2

Objetivo:

- motor de matching automatico usando flota y reservaciones del tenant

Entregables:

- normalizacion de plate/tag/sello
- candidate search por vehicle
- scoring
- auto-confirm y suggested review

## Phase 3

Objetivo:

- AutoExpreso provider integration

Entregables:

- credenciales por tenant
- collector job
- import run logs
- collect now

## Phase 4

Objetivo:

- billing y disputes

Entregables:

- post to reservation charge
- reportes
- dispute linkage a issue center

## Como Reutilizar El Software Existente

## Reusar

- normalizacion de IDs
- heuristicas de matching
- parser de imports
- parte del Playwright scraper

## No Reusar Tal Cual

- Tkinter UI
- SQLite schema como fuente de verdad
- scheduler local desktop
- reportes locales acoplados al desktop

## Ruta Tecnica Recomendada

Crear en Ride Fleet:

- `backend/src/modules/tolls/`
- `backend/src/modules/tolls/providers/autoexpreso/`
- `frontend/src/app/tolls/`

Mover desde el proyecto externo:

- normalizers
- match engine
- import parsers
- scraper adapter

## Reglas De Aceptacion

Se considera bien integrado cuando:

1. solo usa vehicles del tenant para resolver la unidad
2. solo usa reservations del tenant para hacer matching
3. el match principal depende de fecha y hora contra `pickupAt` y `returnAt`
4. los conflictos pasan a review
5. el peaje queda trazable desde import hasta reservation/billing

## Recomendacion Final

Si el objetivo es valor rapido, empezar con:

- import manual
- matching automatico
- review queue
- reservation integration

Y dejar el scraping AutoExpreso como fase posterior.

Eso permite:

- validar el modelo
- usar la flota real del tenant
- usar fechas/horas reales de reservacion
- evitar depender de scraping fragil desde el dia uno
