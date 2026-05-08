# Triangle Plan — Inventory Separation Design

Fecha base: 2026-05-08
Trigger: Triangle confirmado, arrancando ejecucion
Owner: Hector
Scope: item `#2` de la foto de Triangle — separar rental fleet de loaner fleet
Stage: schema diseñado + migration escrita; falta backend filtering + UI

## Problem Statement

Triangle quiere correr `~200` vehiculos como dealership loaner (item central
de su deal), mas su flota de rental services (numero a confirmar). Hoy el
schema actual NO permite distinguir entre los dos pools: cualquier vehiculo
puede aparecer tanto en booking publico como en intake de loaner. Triangle
necesita:

1. Separar visualmente y operacionalmente las dos pools
2. La busqueda publica de booking nunca muestre un vehiculo loaner
3. El intake de loaner nunca pulle un vehiculo rental
4. Reportes financieros pueden agruparse por pool (revenue por categoria)
5. Algunos vehiculos pueden ser flexibles (BOTH) y aparecer en ambas

## Schema Design (Shipped en este PR)

Vehicle gana un nuevo campo:

```prisma
enum VehicleProgramCategory {
  RENTAL_ONLY
  LOANER_ONLY
  BOTH
}

model Vehicle {
  // ... existing fields
  programCategory VehicleProgramCategory @default(BOTH)
  // ...
  @@index([tenantId, programCategory])
}
```

Decisiones explicas:

- **Es ortogonal a `fleetMode`.** `fleetMode` distingue rental vs car-sharing (modelo de negocio: tradicional vs peer-to-peer). `programCategory` distingue rental vs loaner (programa interno del tenant). Un vehiculo puede ser, por ejemplo, `fleetMode=RENTAL_ONLY` + `programCategory=LOANER_ONLY` (rental tradicional pero usado solo en loaner program).
- **Default `BOTH`.** Los vehiculos existentes en prod no cambian de comportamiento — siguen apareciendo en busqueda y loaner intake. Solo cuando un tenant active el "loaner program" tendra que tagear su flota loaner como `LOANER_ONLY` o `BOTH` y la rental fleet como `RENTAL_ONLY` o `BOTH`.
- **Index compuesto `(tenantId, programCategory)`.** Postgres puede usar este indice para los dos hot paths: public rental search (`programCategory IN (RENTAL_ONLY, BOTH)`) y loaner intake (`programCategory IN (LOANER_ONLY, BOTH)`).
- **No nullable.** Forzar default `BOTH` evita que cualquier flujo nuevo cree vehiculos sin categoria, lo que dejaria comportamiento ambiguo.

### Migration

Archivo: `backend/prisma/migrations/20260508_add_vehicle_program_category/migration.sql`

```sql
CREATE TYPE "VehicleProgramCategory" AS ENUM ('RENTAL_ONLY', 'LOANER_ONLY', 'BOTH');
ALTER TABLE "Vehicle" ADD COLUMN "programCategory" "VehicleProgramCategory" NOT NULL DEFAULT 'BOTH';
CREATE INDEX "Vehicle_tenantId_programCategory_idx" ON "Vehicle"("tenantId", "programCategory");
```

Risk: bajo. Es additive, no rompe queries existentes (no hay query que asuma
ausencia del campo). Backfill automatico via DEFAULT.

Tiempo de migration en Triangle (200 vehicles): `<1` segundo. En prod actual:
prisma db push es instantaneo, indice cb_index puede tomar `~30 segundos` en
tablas grandes pero estamos lejos de ese tamaño.

## Backend Filtering Changes (Pendiente — esta semana)

### 1. Public rental search — filtra LOANER_ONLY

**Archivo:** `backend/src/modules/booking-engine/booking-engine.service.js`
**Funciones afectadas:** `searchRental`, y especificamente la consulta interna
`rentalAvailabilityCount` que cuenta vehiculos disponibles.

```javascript
// Antes
const vehicles = await prisma.vehicle.findMany({
  where: {
    tenantId,
    vehicleTypeId,
    status: { in: ['AVAILABLE', 'ON_RENT', 'RESERVED'] },
    // ...
  }
});

// Despues
const vehicles = await prisma.vehicle.findMany({
  where: {
    tenantId,
    vehicleTypeId,
    status: { in: ['AVAILABLE', 'ON_RENT', 'RESERVED'] },
    programCategory: { in: ['RENTAL_ONLY', 'BOTH'] },  // ← filter aqui
    // ...
  }
});
```

Helper centralizado para no duplicar:

```javascript
// backend/src/lib/program-category.js (nuevo)
export const RENTAL_PROGRAM_FILTER = { in: ['RENTAL_ONLY', 'BOTH'] };
export const LOANER_PROGRAM_FILTER = { in: ['LOANER_ONLY', 'BOTH'] };
```

### 2. Dealership loaner intake — filtra RENTAL_ONLY

**Archivo:** `backend/src/modules/dealership-loaner/dealership-loaner.service.js`
**Funcion afectada:** intake / vehicle assignment paths.

```javascript
// donde quiera que selecciones vehiculos para asignar a un loaner:
const candidates = await prisma.vehicle.findMany({
  where: {
    tenantId,
    status: 'AVAILABLE',
    programCategory: { in: ['LOANER_ONLY', 'BOTH'] }
  }
});
```

### 3. Reports filtering

`backend/src/modules/reports/reports.service.js` y futuro `reports.routes.js`:

- Reports de rental fleet revenue → filtra por `RENTAL_ONLY, BOTH`
- Reports de loaner fleet utilization → filtra por `LOANER_ONLY, BOTH`
- "Vehicle cost vs revenue generated" report (item `#7`) — agrupa por programCategory

## Admin UI Changes (Pendiente — semana proxima)

### 1. Vehicle list page (`frontend/src/app/vehicles/page.js`)

Agregar:
- **Columna nueva:** "Program" con badge:
  - `RENTAL_ONLY` → badge azul "Rental"
  - `LOANER_ONLY` → badge naranja "Loaner"
  - `BOTH` → badge gris "Flex"
- **Filtro:** dropdown "All programs / Rental only / Loaner only / Flex" en la barra
- **Bulk action:** seleccionar multiple vehiculos → "Set program category" → dropdown con las 3 opciones → confirm

### 2. Vehicle edit form

Agregar al formulario un dropdown "Program category" con las 3 opciones, default BOTH para vehiculos nuevos.

### 3. Vehicle detail page

Mostrar la categoria prominently en el header del vehicle, asi el operador
ve de un vistazo que pool pertenece.

### 4. Onboarding helper

Para Triangle (y futuros tenants con loaner program), un script de bulk-import
que tome un CSV con (`internalNumber, programCategory`) y aplique el tag
masivo. Util para el primer onboarding de los `200` vehiculos.

## Triangle's Onboarding Flow

Una vez shipped el schema + filtering + UI:

1. Tenant `triangle-pr` se crea (o se identifica si ya existe)
2. Triangle importa sus `~200` vehiculos via el bulk-import existente o el helper nuevo
3. Triangle marca su flota loaner como `LOANER_ONLY` (~200 vehiculos)
4. Triangle marca su flota rental como `RENTAL_ONLY` (numero a confirmar)
5. Vehiculos flex (que comparten roles) se quedan en `BOTH`
6. Verificar:
   - Booking publico solo muestra los `RENTAL_ONLY + BOTH`
   - Loaner intake solo asigna de los `LOANER_ONLY + BOTH`
   - Dashboard de Triangle muestra ambas counts separadas

## Test Plan

### Unit / integration

- `backend/src/modules/booking-engine/booking-engine.test.mjs`: agregar test que cree `2` vehicles del mismo vehicleType, uno `RENTAL_ONLY` otro `LOANER_ONLY`, y confirme que `searchRental` solo cuenta el primero.
- `backend/src/modules/dealership-loaner/...test.mjs`: test simétrico — solo el `LOANER_ONLY` aparece en candidates.

### Manual smoke en staging / prod

Despues de deploy:

1. Crear vehicle test con `programCategory=LOANER_ONLY` en un tenant de prueba
2. Hacer search publica → verificar que NO aparece en results
3. Cambiar el campo a `BOTH` → verificar que SI aparece
4. Repetir simétrico para loaner intake

### Performance

Confirmar que el nuevo indice se usa via:
```sql
EXPLAIN ANALYZE
SELECT id FROM "Vehicle" 
WHERE "tenantId" = '...' AND "programCategory" IN ('RENTAL_ONLY','BOTH');
```
Debe usar `Vehicle_tenantId_programCategory_idx`.

## Sequencing — Que Sale Cuando

| Step | Owner agent | Effort | Ship target |
| --- | --- | --- | --- |
| 1. Schema + migration (este commit) | Schema/Migration | 30 min | **hoy** (ahora mismo) |
| 2. Backend filtering en searchRental | Backend Services | 1-2 horas | mañana / pasado |
| 3. Backend filtering en loaner intake | Backend Services | 1 hora | mismo PR |
| 4. Helper centralizado `program-category.js` | Backend Services | 15 min | mismo PR |
| 5. Tests integracion | Backend Services | 1 hora | mismo PR |
| 6. Admin UI vehicle list (column + filter) | Frontend | 2 horas | semana próxima |
| 7. Admin UI vehicle edit form | Frontend | 30 min | semana próxima |
| 8. Bulk action UI | Frontend | 1-2 horas | semana próxima |
| 9. Onboarding helper / bulk import | Backend + Frontend | 2 horas | antes de Triangle go-live |

Total: `~10-12 horas` de trabajo distribuido en `2-3 días` reales.

## Open Questions Para Hector

1. **Default para vehiculos nuevos**: BOTH (lo que tenemos) vs RENTAL_ONLY (mas conservador)? Si Triangle es el primer tenant con loaner activo, BOTH es fine y ellos lo retaggean. Para futuros tenants podriamos dar la opcion en setup.

2. **Vehiculos del mismo tenant en el mismo program**: ¿Triangle quiere ver, en el dashboard, las `2` listas separadas o un toggle "show rental fleet / show loaner fleet"? Esto afecta como armo el UI.

3. **Onboarding**: ¿Vas a tageaarlos manualmente o necesitas el helper de bulk import desde CSV antes que Triangle empiece?

4. **Reports**: revenue por car (item `#3`) — ¿debe estar por programCategory desde el día 1 o es un follow-up?

5. **API publica**: Si Triangle quiere su loaner program accesible via app movil de su personal con un endpoint dedicado, ¿abrimos `/api/dealership-loaner/vehicles?onlyProgram=LOANER_ONLY` o el filter es siempre implicito en los routes de loaner?

## Next Step

Si OK con el design, commit + push el schema change ya. Backend filtering
la siguiente sesion. Total para Triangle inventory separation completo:
`2-3` días de trabajo.
