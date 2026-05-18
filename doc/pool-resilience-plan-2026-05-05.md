# Pool Resilience Plan — 50 Concurrent Users, Multi-Tenant

Fecha base: 2026-05-05
Trigger: BUG-005 (`/api/public/booking/bootstrap` pool exhaustion, fixed in `v0.9.0-beta.26`)
Dueño: Hector
Scope: prevenir que el patron de BUG-005 vuelva a pasar, especificamente bajo
la carga objetivo de **50 usuarios simultaneos** repartidos entre Triangle (200
loaners) + tenants existentes + tenants futuros.

## Executive Summary

El fix de BUG-005 cerro un solo agujero. El audit del codebase encontro
que la misma clase de bug existe en al menos `5` endpoints publicos mas y
varios staff hot paths. La capacidad real del prod hoy es:

- `5` conexiones por worker × `4` workers = **20 conexiones totales** vs Postgres
- objetivo: `50` usuarios concurrentes
- gap: si los endpoints siguen sin cache, cualquier rafaga supera la capacidad

Este plan ataca el problema en `5` capas (defense in depth) repartido en
`Sprint 10`, `Sprint 11`, `Sprint 12`. Al final del Sprint 12, el sistema
debe sostener `200 VUs` (4x el objetivo) sin pool timeouts.

## Current State Snapshot

### Endpoints publicos — `/api/public/booking/*`

| Endpoint | Queries/req | Cached | Worst case | Risk |
| --- | --- | --- | --- | --- |
| `/bootstrap` | 5 paralelos | ✅ getOrSet 60s | 5 | LOW (BUG-005 cerrado) |
| `/rental-search` | `1 + N×M×6` anidado | ❌ | **121+** (5 loc × 4 types) | **CRITICO** |
| `/car-sharing-search` | 2+ con includes | ❌ | 50+ con lookups | **HIGH** |
| `/vehicle-classes` | 4+ | ❌ | 4+ | **HIGH** |
| `/website-fees` | 2+ | ❌ | 2+ | MEDIUM |
| `/hosts/:id` | 1+ | ❌ | nested includes | MEDIUM |

### Staff hot paths

| Endpoint | Queries/req | Cached | Risk |
| --- | --- | --- | --- |
| `/api/reservations/page` | 2 | ✅ getOrSet | LOW |
| `/api/reservations/summary` | 1 | ✅ getOrSet | LOW |
| `/api/reservations/:id` | 3+ | ⚠️ parcial | MEDIUM |
| `/api/reports/overview` | 9 paralelos | ❌ | MEDIUM |
| `/api/vehicles` | 2+ | ❌ | MEDIUM |
| `/api/dealership-loaner/*` | 1-2 | ❌ | MEDIUM-LOW |

### Pool config (prod hoy)

```
docker-compose.prod.yml
  CLUSTER_WORKERS=4
  DATABASE_POOL_SIZE=5
  postgres max_connections=100

Effective: 5 × 4 = 20 connections application-side
Headroom: 80 connections free at the postgres level
```

### Observability gaps

- `PRISMA_SLOW_QUERY_MS=200` esta seteado pero solo va a Winston stdout
- cero alerting en Sentry para `pool_timeout` errors
- load test solo cubre staff endpoints — toda la superficie publica es ciega

## Threat Model — Que pasa con 50 VUs concurrentes hoy

Si manana 50 usuarios entran al booking site al mismo tiempo (perfectamente
realista cuando Triangle empuje la URL a su sales floor):

```
50 VUs × ~3 endpoints publicos por page load (bootstrap + vehicle-classes + website-fees)
= 150 requests in flight

Bootstrap: cached, 1 query batch share
vehicle-classes: 50 × 4 queries = 200 queries
website-fees: 50 × 2 queries = 100 queries

Pool: 20 connections
Pool timeout: 10s
Average query duration: 100-500ms

Result: pool exhausted within 1-2 seconds, 30%+ requests timeout
```

Y eso es solo la pagina de aterrizaje. Si esos 50 usuarios pegan **search**
una sola vez:

```
50 VUs × searchRental (worst case 121 queries) = 6,050 queries
Pool: 20 connections
Result: pool exhausted, multi-second timeouts, ECIRCUITBREAKER en Supavisor
```

Reproduce exactamente el escenario de BUG-005 a mayor escala.

## Strategy — Defense in Depth (5 capas)

Atacar el problema en una sola capa nos vuelve a fallar. Necesitamos:

```
Capa 1: HTTP/Edge cache headers       — corta el trafico antes de llegar
Capa 2: Application cache + coalescing — collapsa concurrencia en una query batch
Capa 3: Query optimization (batching)  — elimina N+1 y nested fan-outs
Capa 4: Pool sizing                    — capacidad real para lo no cacheable
Capa 5: Observability + alerting       — detectar antes que el cliente
```

### Capa 1 — HTTP / Edge cache

Para data verdaderamente publica que cambia poco (vehicle-classes, policies,
location-aware website-fees):

- agregar `Cache-Control: public, max-age=60, stale-while-revalidate=300` headers
- nginx delante puede cachear si configuramos `proxy_cache_path`
- bots y crawlers respetan estos headers — corta trafico antes de que llegue al app

Costo de implementacion: bajo (headers en route). Impacto: alto en bot/crawler load.

### Capa 2 — Application cache + thundering-herd coalescing

`cache.getOrSet` ya esta probada (BUG-005 fix). Usarla en TODOS los endpoints
fan-out:

- coalescing protege incluso en cache miss
- TTL corto (30-120s) mantiene staleness aceptable
- key debe incluir todos los parametros que afectan el response

Es la herramienta principal y la primera que aplicamos.

### Capa 3 — Query optimization

Algunos endpoints no se pueden cachear bien (parametros muy variables) o no
deberian (datos que cambian rapido). Para esos: reducir el numero de queries.

`searchRental` es el caso clasico:

```
Antes (hoy):
  for location in locations:
    vehicleTypes = await prisma.vehicleType.findMany({ tenantId })
    for vehicleType in vehicleTypes:
      [recommendation, count] = await Promise.all([rates, availability])
      [services, plans, fees] = await Promise.all([services, plans, fees])

  Worst case: 1 + N × (1 + M × (2 + 3)) queries
```

```
Despues (target):
  vehicleTypes = await prisma.vehicleType.findMany({
    tenantId: { in: tenantIds }
  })
  recommendations = await ratesService.getBatchRecommendations({ ... })
  availability = await batchRentalAvailability({ ... })
  services = await listAllPublicAdditionalServices({ ... })
  plans = await listAllPublicInsurancePlans({ ... })
  fees = await listAllMandatoryFees({ ... })
  // join in-memory

  Result: 6 queries TOTAL regardless of locations × vehicle types
```

Ese refactor solo no requiere cache para resolver el problema. Cache encima
es el cinturon ademas del pantalon.

### Capa 4 — Pool sizing

Con cache en su lugar, la mayoria del trafico no llega al pool. Pero hay que
tener capacidad real para:

- los misses iniciales
- endpoints que no se pueden cachear (mutations, per-user data)
- imports / exports / reports

Plan: subir `DATABASE_POOL_SIZE` de `5` a `15` en prod, validado en staging.

```
Antes: 5 × 4 = 20 connections
Despues: 15 × 4 = 60 connections (de 100 que permite postgres)
Headroom: 40 connections para migrations, jobs, admin queries
```

Antes de subir hay que confirmar que Supavisor (transaction-mode pooler)
soporta este nivel sin throttling. Test en staging con 200 VUs.

### Capa 5 — Observability + alerting

No queremos enterarnos de la proxima version de este bug por una alerta de
Sentry de cliente. Queremos verlo venir.

- Sentry alert rule: `pool_timeout` errors `>10/min` → page Hector
- Sentry alert rule: `slow_query >2s` `>20/min` → warning
- agregar metric en healthcheck: pool stats (active / idle / pending)
- exponer `/internal/metrics` con conexiones del pool
- log estructurado con `pool.activeConnections` cada 30s

Si el pool sube de `60%` ocupado en sostenido, ya sabemos que estamos cerca.

## Sprint Plan

### Sprint 10 — Stop the bleeding (May 5–11)

Objetivo: cerrar los `3` endpoints publicos mas peligrosos antes que Triangle
o cualquier otro tenant lance trafico real. Esta semana.

| # | Item | Layer | Target | ETA |
| --- | --- | --- | --- | --- |
| R1 | Wrap `searchRental` in `cache.getOrSet` | 2 | 60s TTL, key incluye date range + locations | 1d |
| R2 | Wrap `getVehicleClasses` in `cache.getOrSet` | 2 | 60s TTL | 0.5d |
| R3 | Wrap `getWebsiteMandatoryFees` in `cache.getOrSet` | 2 | 60s TTL | 0.5d |
| R4 | Sentry alert rule `pool_timeout >10/min` | 5 | rule en Sentry UI + test | 0.5d |
| R5 | Slow-query alert `>10/min` >2s threshold | 5 | rule en Sentry UI | 0.5d |
| R6 | Extender load test a publico (50 VUs) | 5 | run-public-booking.mjs | 1d |
| R7 | Validar load test pasa con R1-R3 mergeados | 5 | repro 50 VU sostenido | 0.5d |

Definition of done Sprint 10:

- 50 VUs × 60s sobre los `3` endpoints cacheados → cero pool timeouts
- alertas configuradas y verificadas con un test trigger
- el bug-log actualizado con los `3` nuevos fixes (BUG-006, BUG-007, BUG-008
  como mejoras preventivas)

Ship cadence: deploy diario esta semana en lugar de release semanal.

### Sprint 11 — Refactor + capacity (May 12–18)

Objetivo: eliminar el peor offender (searchRental nested loops), subir pool
size, cubrir endpoints staff de alto trafico.

| # | Item | Layer | Target | ETA |
| --- | --- | --- | --- | --- |
| R8 | Refactor `searchRental` a queries batched | 3 | 6 queries totales, no loop multiplier | 2d |
| R9 | Wrap `searchCarSharingListings` in cache | 2 | 60s TTL, key con search params | 0.5d |
| R10 | Wrap `getHostProfile` in cache | 2 | 5min TTL | 0.5d |
| R11 | Cache layer en `/api/reports/overview` | 2 | 30s TTL, key por tenant + date | 0.5d |
| R12 | HTTP `Cache-Control` headers para endpoints estables | 1 | nginx config + route headers | 1d |
| R13 | Subir `DATABASE_POOL_SIZE` a 15 (staging primero) | 4 | validacion 200 VU en staging | 1d |
| R14 | `/internal/metrics` expone pool stats | 5 | active/idle/pending counts | 0.5d |
| R15 | Documentar pool config en `docs/operations/` | 5 | nuevo `prod-database-pool.md` | 0.5d |

Definition of done Sprint 11:

- searchRental sin caching aguanta 100 VUs sostenido
- pool size en prod = 15, sin issues despues de 7 dias
- Sentry alert rate cae en `90%+`
- documentacion del pool config existe y es referenciable

### Sprint 12 — Polish + Triangle-ready (May 19–25)

Objetivo: cubrir los gaps restantes y validar el sistema bajo carga 4x objetivo
(`200 VUs`).

| # | Item | Layer | Target | ETA |
| --- | --- | --- | --- | --- |
| R16 | Cache fix en `/api/reservations/:id` detail | 2 | usar getOrSet en vez de get/set parcial | 1d |
| R17 | Cache `/api/vehicles` list | 2 | 60s TTL, invalidar en write | 0.5d |
| R18 | Cache loaner endpoints high-traffic | 2 | per-tenant, 60s TTL | 1d |
| R19 | Healthcheck refactor (DB-down vs app-broken) | 5 | soft DB ping, evitar restart loop | 1d |
| R20 | Load test 200 VUs (`4x` objetivo) | 5 | sostener 5 min sin timeouts | 1d |
| R21 | Triangle tenant rehearsal con load real | 5 | tenant `triangle-pr` + 50 VU sim | 1d |
| R22 | Dashboard interno con metrics graficados | 5 | grafana o artifact | 1d |

Definition of done Sprint 12:

- 200 VUs × 5min sobre toda la superficie publica + staff → cero timeouts
- Triangle puede ver una demo con `50` usuarios simulados sin degradacion
- existe runbook de "que hacer si pool exhaustion vuelve a pasar"

## Implementation Patterns

### Patron 1 — Wrap an endpoint in cache

```javascript
// Antes
async getVehicleClasses({ tenantSlug, pickupAt, returnAt }) {
  const tenant = await resolvePublicTenant({ tenantSlug });
  const [vehicleTypes, availability, rates, fees] = await Promise.all([...]);
  return shape(vehicleTypes, availability, rates, fees);
}

// Despues
async getVehicleClasses({ tenantSlug, pickupAt, returnAt }) {
  const cacheKey = `public:vehicle-classes:tenant=${tenantSlug || ''}:pickup=${pickupAt || ''}:return=${returnAt || ''}`;
  return cache.getOrSet(cacheKey, async () => {
    const tenant = await resolvePublicTenant({ tenantSlug });
    const [vehicleTypes, availability, rates, fees] = await Promise.all([...]);
    return shape(vehicleTypes, availability, rates, fees);
  }, 60_000);
}
```

Reglas para el cache key:

- incluir todos los params que cambian la respuesta
- normalizar fechas a la unidad de cache deseada (e.g. round a 5min para tener mas hits)
- prefijo con el modulo (`public:` o `staff:`) para invalidar selectivamente

### Patron 2 — Refactor nested loop a batched queries

```javascript
// Antes (searchRental)
for (const location of locations) {
  const tenant = await resolvePublicTenantContext({ pickupLocationId: location.id });
  if (!tenant) continue;
  if (!vehicleTypesByTenant.has(tenant.id)) {
    const vt = await prisma.vehicleType.findMany({ where: { tenantId: tenant.id } });
    vehicleTypesByTenant.set(tenant.id, vt);
  }
  for (const vehicleType of vehicleTypesByTenant.get(tenant.id)) {
    const [rec, count] = await Promise.all([
      ratesService.getRevenueRecommendation(...),
      rentalAvailabilityCount(...),
    ]);
    const [services, plans, fees] = await Promise.all([...]);
    results.push(buildResult(...));
  }
}

// Despues
const tenants = await resolveTenantsForLocations(locations);
const tenantIds = tenants.map((t) => t.id);

const [vehicleTypes, availabilityMap, rateMap, services, plans, fees] = await Promise.all([
  prisma.vehicleType.findMany({ where: { tenantId: { in: tenantIds } } }),
  batchRentalAvailability({ tenantIds, locations, pickupDate, returnDate }),
  ratesService.getBatchRecommendations({ tenantIds, vehicleTypeIds: undefined, ... }),
  listAllPublicAdditionalServices({ tenantIds }),
  listAllPublicInsurancePlans({ tenantIds }),
  listAllMandatoryFees({ tenantIds, locations }),
]);

const results = combineInMemory({
  locations, vehicleTypes, availabilityMap, rateMap, services, plans, fees,
});
```

### Patron 3 — Cache invalidation en mutations

Cuando un admin actualiza data que esta cacheada:

```javascript
async updateVehicleType(tenantId, id, data) {
  const updated = await prisma.vehicleType.update({ where: { id }, data });
  cache.invalidate(`public:vehicle-classes:tenant=${tenant.slug}`);
  cache.invalidate(`public:bootstrap:slug=${tenant.slug}`);
  return updated;
}
```

`cache.invalidate(prefix)` ya broadcastea a otros workers via Redis pub/sub
si esta configurado. No requiere setup adicional.

## Success Metrics

Como sabemos que el plan funciono:

| Metric | Baseline (hoy) | Sprint 10 | Sprint 11 | Sprint 12 |
| --- | --- | --- | --- | --- |
| Pool timeouts en `/api/public/*` | crashing en 50 VU | 0 en 50 VU | 0 en 100 VU | 0 en 200 VU |
| p95 latency `/bootstrap` | 5000ms+ | <500ms | <300ms | <300ms |
| p95 latency `/rental-search` | 5000ms+ (timing out) | <2000ms | <500ms | <500ms |
| Slow-query alerts/hr | sin alerting | <5 | <2 | <1 |
| Sentry pool errors/dia | espontaneo | 0 | 0 | 0 |
| DB connections en uso (avg) | 90%+ saturation | <50% | <40% | <30% |
| Cache hit rate publico | 0% | 70%+ | 85%+ | 90%+ |

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Subir `DATABASE_POOL_SIZE` rompe Supavisor | validar en staging primero, rollback inmediato si vemos errores |
| Cache stale data confunde a usuarios | TTLs cortos (60s default), invalidacion explicita en mutations |
| Refactor de searchRental rompe resultados existentes | golden-master test antes y despues, comparar bytes |
| Carga real de Triangle excede 50 VUs | sprint 12 valida 200 VUs (`4x` el target) |
| Sentry alerts spam → noise → ignored | thresholds calibrados con baseline real, snooze rules |
| nginx HTTP cache cachea data sensible | aplicar solo a endpoints `public` con headers explicitos |

## Backstop / Emergency Plan

Si pool exhaustion vuelve a pasar antes que terminemos el plan:

1. Verificar Sentry y identificar el endpoint culpable
2. Si es un endpoint nuevo → hot-patch con `cache.getOrSet` (mismo patron que BUG-005)
3. Si es load real sostenido → escalar workers `4 → 8` en docker-compose y subir pool
4. Si Supavisor circuit-broke → restart project en Supabase dashboard
5. Documentar como nuevo BUG-NNN en `doc/known-bugs-2026-04-23.md`

Tiempo objetivo desde alerta a fix shipped: `<30 min` con cualquiera de las
opciones anteriores.

## Updates after smoke test (2026-05-08)

Despues de shippear `v0.9.0-beta.27` (R1 + R2 + R3) hice smoke test contra prod
con tenant `internationrentalcorp-fleet`. Resultados:

| Endpoint | Cache miss TTFB | Cache hit TTFB | Response size |
| --- | --- | --- | --- |
| website-fees | ~300ms | ~200ms | 443 B |
| bootstrap | ~700ms | ~280ms | **5.5 MB** |
| searchRental | **~4.9s** | ~500ms | **16.7 MB** |

Buenas noticias:

- el cache de R1 / R2 / R3 funciona — miss vs hit es 10x diferencia
- pool exhaustion realmente prevenida (cache hits no tocan DB)
- 4 workers se comportan como esperabamos — primeras `4` requests por
  cache key son misses, luego hits

Malas noticias que cambian el plan:

1. **`searchRental` cold = 5 segundos.** El nested loop hace 121 queries que
   tardan 5s en completarse. Cualquier cache miss (TTL expira, o nueva
   variante de search) bloquea 1 conexion del pool por 5 segundos. Con
   `pool_size=5` y `4 workers`, 5 misses simultaneos = pool saturado.
   **R8 sube de Sprint 11 a Sprint 10.**

2. **Payload bloat masivo.** searchRental retorna 16.7 MB. bootstrap retorna
   5.5 MB. Cache no arregla esto — cada hit todavia transmite el payload
   completo. Con 50 VUs en searchRental serian `~835 MB/min` de bandwidth.
   Necesitamos response shape audit y diet. **Nuevo item R23.**

### Sprint 10 ajustado (priority shift)

| # | Item | Priority change | Rationale |
| --- | --- | --- | --- |
| R8 | Refactor `searchRental` a queries batched (6 queries totales en lugar de 121) | Sprint 11 → **Sprint 10** | cold-cache 5s es inaceptable, blockea conexiones por 5s cada miss |
| R23 | Response shape audit en publico (eliminar campos no usados, paginar listings, no incluir 120 search places en bootstrap) | **Nuevo, Sprint 10** | 16.7MB y 5.5MB de payload son insostenibles a escala |

Los demas items de Sprint 10 (R4 alerts, R6 load test publico) se mantienen.
Sprint 11 ya no tiene R8 ni R23 — eso libera tiempo para los otros perf
items.

## Open Questions

Antes de arrancar Sprint 10:

1. ¿Quieres que arranque ya con `R1` (cache wrap de searchRental) hoy mismo?
   El patron es el mismo que BUG-005, puedo shippear como `v0.9.0-beta.27` manana.
2. ¿Las alertas de Sentry deben ir a tu telefono via PagerDuty / SMS o solo email?
3. ¿Tienes algun limite de plan de Supabase que me importe respetar al subir
   `DATABASE_POOL_SIZE`? (free tier vs pro vs enterprise tienen distintos caps)
4. Para el load test publico: ¿usamos un tenant de prod (read-only) o creamos
   un tenant `loadtest-pr` dedicado?
5. ¿La reorganizacion del `searchRental` puede romper algun consumer mobile/web
   que dependa del orden exacto del response? Quiero golden-master test.

## Next Step

Si confirmas el sequencing, abro tickets para R1 a R7 y arranco con R1
(searchRental cache) **hoy** — la cuenta de queries por request es el doble
del que ya nos tumbo, asi que es la prioridad.
