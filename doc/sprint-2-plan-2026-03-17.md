# Sprint 2 Plan - Structured Data Layer + Swagger Last

Fecha base: 2026-03-17

## Objetivo
Completar la primera capa de datos estructurados para operaciones de renta sin depender de `notes` como fuente primaria, y dejar la recreacion de Swagger para el final del sprint sobre una rama alineada con `main`.

## Contexto
`main` ya contiene el corte grande de migracion:
- `eafc7e2` `Harden auth and tenant-scoped customer flows`
- `154ddc5` `Migrate legacy reservation metadata to structured models`

La rama `dev/swagger-and-docs` no nacio desde ese `main`, por lo que cualquier trabajo de Swagger debe rehacerse al final del sprint sobre una rama correcta para evitar drift.

## Resultado Esperado
- Reporting y portal ya pueden apoyarse en tablas reales.
- Los flujos principales dejan de escribir metadata critica en `notes`.
- Queda una rama nueva de Swagger reconstruida encima de `main`.

## Alineacion Competitiva
Este sprint no intenta ganar todo frente a TSD, Rent Centric, RentALL y HQ.

Su funcion dentro del plan competitivo es:
- dejar la data lista para `reports v1`
- dejar el portal listo para `pre-check-in real`
- preparar base estable para `mobile ops`
- evitar que integraciones/webhooks/reporting se construyan encima de parsing de `notes`

Referencias de producto y priorizacion ampliada:
- `doc/competitive-feature-matrix-2026-03-17.md`

## Scope Principal
1. Validar y cerrar la capa estructurada ya publicada en `main`.
2. Eliminar los write paths legacy que aun usan `notes` como owner.
3. Reducir los read fallbacks legacy a compatibilidad historica minima.
4. Rehacer Swagger al final, partiendo desde `main`.

## Fuera De Scope
- Nuevos modulos de negocio.
- Reportes v1 completos.
- Telemetics, mobile ops o pricing avanzado.
- Refactor total del event log operativo humano.

## Backlog Del Sprint

## Bloque A - Cierre de datos estructurados

### 1. Reservation detail frontend
Archivo:
- `frontend/src/app/reservations/[id]/page.js`

Objetivo:
- dejar de usar `[RES_CHARGES_META]` como flujo principal
- leer desde `GET /api/reservations/:id/pricing`
- guardar con `PUT /api/reservations/:id/pricing`

Definition of done:
- la tabla de charges no depende de parsing de `notes`
- el total mostrado sale del modelo estructurado
- `notes` queda solo para comentario humano

### 2. Additional drivers frontend
Archivo:
- `frontend/src/app/reservations/[id]/additional-drivers/page.js`

Objetivo:
- dejar de persistir `[RES_ADDITIONAL_DRIVERS]`
- leer desde `GET /api/reservations/:id/additional-drivers`
- guardar con `PUT /api/reservations/:id/additional-drivers`

Definition of done:
- agregar, editar y borrar drivers no toca `notes`
- sigue sincronizando bien con agreement cuando aplica

### 3. Inspection report frontend + vehicles history
Archivos:
- `frontend/src/app/reservations/[id]/inspection-report/page.js`
- `frontend/src/app/vehicles/page.js`

Objetivo:
- dejar de reconstruir inspecciones desde `[INSPECTION_REPORT]`
- leer desde `RentalAgreementInspection`

Definition of done:
- `inspection-report` usa endpoint estructurado
- vehicle history no parsea inspeccion legacy como camino principal

## Bloque B - Limpieza backend

### 4. Reservation create/update cleanup
Archivo:
- `backend/src/modules/reservations/reservations.routes.js`

Objetivo:
- dejar de escribir `[RES_DEPOSIT_META]` como owner primario
- revisar cualquier write nuevo de metadata embebida

Definition of done:
- create/update ya no generan metadata critica en `notes`

### 5. Rental agreement legacy cleanup
Archivo:
- `backend/src/modules/rental-agreements/rental-agreements.service.js`

Objetivo:
- mantener compatibilidad legacy solo como fallback historico
- priorizar siempre:
  - `ReservationPricingSnapshot`
  - `ReservationCharge`
  - `ReservationPayment`
  - `ReservationAdditionalDriver`
  - `RentalAgreementInspection`

Definition of done:
- `notes` no es owner principal de charges/payments/drivers/inspection
- los helpers legacy quedan claramente marcados como compatibilidad

### 6. Customer portal legacy cleanup
Archivo:
- `backend/src/modules/customer-portal/customer-portal.routes.js`

Objetivo:
- breakdown y amount due deben salir de tablas nuevas
- pagos publicos no deben depender de `[PAYMENT ...]`
- drivers/depositos no deben depender de markers como camino principal

Definition of done:
- portal usa datos estructurados primero
- fallback legacy queda solo para registros historicos no backfilleados

## Bloque C - Validacion y rollout

### 7. Backfill verification
Archivo:
- `backend/scripts/backfill-legacy-metadata.mjs`

Objetivo:
- correr `dry-run`
- confirmar cero pendientes para data ya migrada
- documentar si aparece algun nuevo caso legacy no contemplado

Definition of done:
- script sigue idempotente
- no hay duplicados al re-ejecutar

### 8. Smoke tests funcionales
Flujos:
- reservation pricing
- reservation payments
- additional drivers
- start rental
- checkout/checkin
- inspection report
- customer payment link

Definition of done:
- local ok
- beta ok antes de merge a `main`

## Bloque D - Swagger al final

### 9. Recreate Swagger on top of main
Rama sugerida:
- `dev/sprint-2-structured-data-and-swagger`

Base:
- `main`

Accion:
- recrear la capa Swagger desde cero encima de `main`
- no reaprovechar la rama vieja `dev/swagger-and-docs` como base final

Entregables:
- `/api/docs`
- `/api/docs/openapi.json`
- cobertura ampliada de endpoints
- ejemplos de request/response

Definition of done:
- Swagger vive sobre una rama derivada del `main` correcto
- no reintroduce drift con la version live

## Bloque E - Continuidad De Roadmap Competitivo

### 10. Dejar listos los siguientes sprints
Este sprint debe salir con los siguientes compromisos ya amarrados:

- `Sprint 3`
  - reports operativos v1
  - revenue por vehiculo/dia
  - utilization
  - no-shows
  - CSV export

- `Sprint 4`
  - pre-check-in real
  - upload de licencia / ID / seguro
  - validacion server-side del token

- `Sprint 5`
  - portal cliente fortalecido
  - timeline de pagos/documentos/agreement
  - inicio de discovery formal para `car sharing`

- `Sprint 6-7`
  - Mobile Agent PWA
  - checkout/checkin/inspection movil

- `Sprint 8`
  - delivery & collection

- `Sprint 9-10`
  - webhooks
  - integraciones
  - accounting / automation
  - insurance verification
  - document verification

- `Sprint 11-12`
  - pricing por reglas
  - telematics adapters
  - MFA real

### 11. Car sharing / Turo-competitor track
No entra como implementacion completa de Sprint 2, pero si entra como lineamiento oficial del roadmap.

Objetivo:
- reutilizar `Fleet Manager` como backoffice de un modulo de car sharing
- competir en una linea tipo Turo sin perder el core de rental ops

Primeros entregables a planificar desde aqui:
- discovery del dominio `car sharing`
- separacion conceptual entre `rental reservation` y `trip / listing booking`
- reglas de disponibilidad y pricing para marketplace
- dependencias minimas:
  - pre-check-in
  - document verification
  - mobile ops
  - telematics / smart key strategy

Recomendacion:
- iniciar discovery en `Sprint 5`
- arquitectura en `Sprint 6`
- MVP operativo en fase posterior a `Sprint 8`

## Orden Recomendado
1. `frontend/src/app/reservations/[id]/page.js`
2. `frontend/src/app/reservations/[id]/additional-drivers/page.js`
3. `frontend/src/app/reservations/[id]/inspection-report/page.js`
4. `frontend/src/app/vehicles/page.js`
5. `backend/src/modules/reservations/reservations.routes.js`
6. `backend/src/modules/rental-agreements/rental-agreements.service.js`
7. `backend/src/modules/customer-portal/customer-portal.routes.js`
8. `backend/scripts/backfill-legacy-metadata.mjs`
9. smoke tests
10. recrear Swagger desde `main`

## Riesgos Principales
- mezclar ramas viejas con `main` y perder el estado real publicado
- dejar algun write path oculto que siga generando metadata en `notes`
- duplicar pagos si conviven reservation/agreement sin regla clara
- romper portal publico si el cleanup elimina compatibilidad demasiado pronto

## Criterio De Cierre Del Sprint
El sprint se considera cerrado cuando:
- los flujos operativos principales funcionan sin depender de metadata embebida
- `notes` queda como comentario humano o fallback historico minimo
- beta pasa smoke tests completos
- Swagger queda rehecho sobre una rama basada en `main`
- quedan amarrados los siguientes sprints competitivos y el track de `car sharing`

## Rama Recomendada Para El Trabajo
Cuando arranque implementacion real:

```bash
git checkout main
git pull origin main
git checkout -b dev/sprint-2-structured-data-and-swagger
```

Y al final del sprint:
- aplicar limpieza funcional
- correr QA
- recrear Swagger
- preparar PR unica
