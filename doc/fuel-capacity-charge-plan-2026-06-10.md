# Fuel Capacity & Fuel Charge — plan de diseño (2026-06-10)

**Estado: BORRADOR — esperando aprobación de Hector antes de escribir código.**
**Resuelve el bug #51 / OPEN `fleet-backend-prod__checkin-close-tank-capacity-select-invalid` (P2, MONEY).**

## 1. Cómo funciona HOY (análisis del código)

La buena noticia: la fórmula que pidió Hector **ya es la que implementa el fee engine**
(`fee-engine.service.js → computeFuelRefill`, líneas ~178-198):

1. Ambas lecturas (fuelOut/fuelIn, fracciones 0..1) se **cuantizan al 1/8 más cercano**
   (`toEighth`, fix de 2026-06-04 que eliminó fees fantasma de $0.80).
2. `gap = max(0, out − in)` en octavos.
3. `galones = gap × tankCapacityGallons` (redondeo a 2 decimales).
4. `cobro = galones × rate` donde rate viene de `FeeRate` (FUEL_REFILL, unit PER_GALLON),
   resoluble por location → tenant → fallback hardcoded **$7.00/gal**.

Ejemplo con la póliza de Hector ($9.99/gal, tanque 22 gal, salió full, volvió a 1/2):
`gap 4/8 = 0.5 → 0.5 × 22 = 11 gal → 11 × 9.99 = $109.89` ✔ exacto a su spec.

**Lo roto — la capacity** (`checkin-close.service.js → resolveTankCapacity`, líneas 417-427):

```js
select: { tankCapacityGallons: true, fuelTankSize: true }   // ← NINGUNA existe en el schema
```

Prisma tira validation error, el `.catch(() => null)` se lo traga, `cap = 0` → **fallback 15
galones para TODOS los vehículos, siempre**. Un Suburban de 28 gal cobra casi la mitad de lo
que debe; un compacto de 12 gal cobra de más.

**Captura de fuel por flujo (granularidad):**

| Flujo | Granularidad hoy | Estado |
|---|---|---|
| Check-in wizard desktop (`FuelLevelInput`) | snap a 1/8 | ✅ ya en octavos |
| Checkout wizard v2 desktop (slider 1-8) | 1/8 | ✅ ya en octavos |
| Checkout MÓVIL (`/checkout/mobile/[token]`) | select de 5 opciones (Full/3/4/1/2/1/4/Empty) | ⚠️ solo cuartos |
| `fuelLevelToFraction()` (beta.152) | mapea los 5 enums | ⚠️ extender si el móvil pasa a octavos |

**El rate $9.99/gal**: NO requiere código — es configurar `FeeRate` FUEL_REFILL del tenant
(hoy si no está configurado aplica el hardcoded $7.00). Verificar en Settings → Fees que
International tenga el valor que Hector quiere.

## 2. Qué vamos a construir (spec acordado con Hector)

> "Asegurar que cada carro tenga su fuel capacity, que el sistema la use en check-in/checkout,
> dividida en 1/8s. Tanque de 22 gal entregado full y devuelto a mitad con póliza de $9.99/gal:
> 22/8 = 2.75 gal por octavo × 4 octavos = 11 gal × $9.99 = $109.89."

La fórmula ya existe; el trabajo es **darle la capacity real al engine** y cerrar los gaps de UI.

## 3. Fases

### Fase A — Schema + fix del resolver (MIGRACIÓN ADDITIVE + MONEY-adyacente)
- `Vehicle.fuelTankCapacityGallons Decimal? @db.Decimal(4,1)` (nullable, additive; acepta 16.9).
- `resolveTankCapacity()`: leer la columna real. Si null/0 → fallback 15 **+ `logger.warn`**
  (`[checkin-close] vehicle without fuelTankCapacityGallons — using 15 gal fallback`) para que
  el droplet-log-monitor cuente cuántos check-ins siguen cayendo al fallback.
- El fee line del wizard ya muestra galones y niveles; sin cambios de math.
- ⚠️ Toca `checkin-close.service.js` (input del fee engine, NO la aritmética) → diff para
  revisión línea a línea de Hector, mismo protocolo que beta.154/155.

### Fase B — UI de capacity (frontend + endpoint de update)
- Campo **"Fuel tank capacity (gal)"** en el form de crear/editar vehículo (validación 5–60,
  paso 0.1) + visible en el Vehicle Profile junto a las specs.
- Permitir editarlo inline desde el perfil (mismo permiso que editar vehículo).

### Fase C — Poblar la flota (data, sin deploy)
- Reporte/lista filtrable: **"Vehicles sin tank capacity"** (query simple, se puede exponer como
  filtro en /vehicles o un tile chico en el dashboard mientras haya >0).
- Script `backend/scripts/seed-tank-capacity.mjs` (dry-run default) con mapa make/model→galones
  para los modelos comunes de la flota (rellena SOLO donde está null; el valor manual gana).
- Meta: 100% de la flota activa con capacity antes de considerar quitar el fallback de 15.

### Fase D — Móvil a octavos (opcional, recomendado)
- El select del checkout móvil pasa de 5 a 9 opciones (Full, 7/8 … 1/8, Empty), values nuevos
  `SEVEN_EIGHTHS`, `FIVE_EIGHTHS`, `THREE_EIGHTHS`, `ONE_EIGHTH`.
- `fuelLevelToFraction()` extendido (mantiene los 5 enums viejos — retrocompatible, las filas
  históricas siguen resolviendo).

## 4. Tests
- `test:fees` ya cubre computeFuelRefill; añadir casos: capacity 22 full→half = $109.89 @9.99,
  capacity null→fallback, capacity decimal (16.9).
- Unit test nuevo de `fuelLevelToFraction` con los enums de octavos (Fase D).
- Smoke en prod (Hector): check-in de prueba con carro de capacity conocida ≠ 15 y verificar
  el fee line (galones correctos en la descripción).

## 5. Orden de deploy propuesto
1. **Ship 1 (Fase A+B juntas)**: migración additive + resolver + UI. Migración por puerto 5432.
2. Configurar FeeRate FUEL_REFILL = $9.99 (o lo que aplique por tenant) en Settings — sin código.
3. **Fase C**: correr seed dry→apply + el equipo llena los que falten desde el perfil.
4. **Ship 2 (Fase D)**: móvil a octavos. Code-only.

## 6. Decisiones que necesito de Hector
1. ¿Apruebo Fases A+B+C+D completas, o A+B+C primero y D después?
2. ¿El fallback cuando un carro no tiene capacity se queda en 15 gal (cobra de menos en carros
   grandes) o prefieres que el wizard AVISE al agente "este carro no tiene capacity configurada"
   antes de cerrar el check-in? (Recomendado: warning visible + fallback 15 mientras tanto.)
3. ¿$9.99/gal es el rate para International? ¿Aplica igual en todas las locations?
