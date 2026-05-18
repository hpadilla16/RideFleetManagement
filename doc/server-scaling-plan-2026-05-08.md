# Server Scaling Plan — Sustaining Multi-Tenant Load

Fecha base: 2026-05-08
Trigger: Pool resilience plan completed; ready to plan capacity for multiple
tenants like Triangle (200 vehiculos cada uno) en operacion concurrente.
Owner: Hector

## TL;DR

Hoy RideFleet corre en **`1` droplet de 4 vCPU + 8 GB RAM** detrás de nginx,
con Supabase pooler. Capacidad de compute es generosa; el bottleneck real
es **conexiones DB (`20` totales: `5` × `4` workers) y cache que no se
comparte entre workers**.

El compute upgrade del droplet ya fue ejecutado (`1vCPU/2GB → 4vCPU/8GB`).
Lo que falta de Tier A: **Redis para shared cache entre workers, Cloudflare
delante, y verificar/subir el connection_limit en el pool**. Ese trio
duplica la capacidad real sin cambios de arquitectura.

Para `5+` clientes tipo Triangle, cerrar Tier A.
Para `20+`, Tier B (multi-droplet + LB + read replicas).
Para `50+`, Tier C (multi-region + dedicated infra para enterprise).

La buena noticia que descubrimos investigando la competencia: **el mercado
está dominado por monolitos legacy en ASP.NET corriendo en single-region
sin SLAs públicos**. Si ejecutamos bien, RideFleet puede ser el primero
con arquitectura moderna en este nicho.

## Lo Que Encontramos sobre la Competencia

Hicimos research público de los `5` competidores principales:

| Competidor | Tipo de stack inferido | Public SLA | Status page |
| --- | --- | --- | --- |
| Dealerware | ASP.NET legacy detrás de Cloudflare | No publicado | No |
| ARSLoaner | ASP.NET legacy, presencia mínima | No publicado | No |
| RENTALL | Detrás de Cloudflare, JS-heavy | No publicado | No |
| HQ Rental Software | JS frontend con Cloudflare | No publicado | No |
| TSD | Legacy, casi sin presencia web | No publicado | No |

Lo que esto nos dice:

- **Nadie publica SLA** — probable que no garantizan `99.9%` formalmente
- **Nadie publica customer count** — escala probable `500-2,000` rooftops cada uno (no `50K+`)
- **Stacks mayormente legacy** — monolitos verticalmente escalados, no cloud-native
- **Sin status pages** — no hay transparencia operacional

## Lo Que Estamos Hoy

```
DigitalOcean droplet (NYC3) — already resized
  - 4 vCPU
  - 8 GB RAM
  - SSD storage
  - ~$48/mo

Application:
  - Node.js cluster, 4 workers (1 vCPU each, balanced)
  - DATABASE_POOL_SIZE=5 per worker = 20 connections total ← bottleneck #1
  - In-memory cache per worker (Map), 5 min default TTL ← bottleneck #2 (4 islas)
  - No Redis configured (cache state NOT shared between workers)

Database (verificado en dashboard 2026-05-08):
  - Supabase plan: PRO ✓ (paid)
  - Compute size: MICRO (t4g.micro instance)
  - Pooler at aws-1-us-east-1.pooler.supabase.com:6543
  - Region: us-east-1 (N Virginia)
  - max_connections: 60 (NO 100 — depende del compute size)
  - Connections en uso ahora: 11/60 (18%)
  - Headroom: 49 connections disponibles
  - Stats: CPU 3%, Disk 19%, RAM 45%

Reverse proxy:
  - nginx 1.24 en el mismo droplet (no separado)
  - SSL terminado aqui, no Cloudflare delante

Observability:
  - Sentry (Issues + Uptime monitor)
  - Sentry alert rule "Prisma Pool Exhaustion" (creada hoy)
  - PRISMA_SLOW_QUERY_MS=200 → Winston stdout

Deploy:
  - SSH manual al droplet
  - docker compose up -d --build --force-recreate
  - Tagged release per beta version
```

Capacity validada hoy con load test:

- **`5` VUs sostenidos x 30s** desde una sola IP: `0` errores, `p99 < 1.1s` rental-search
- **`50` VUs desde una sola IP**: rate limiter rebota `86%` con `429` (proteccion correcta)
- **Real-world `50` VUs** = `50` IPs distintas, cada una con su budget de rate limit → debería funcionar bien

## Que Va A Romper Primero — En Orden

Conforme crece el load, las cosas se rompen en este orden:

### 1. Single-worker memory pressure (rompe primero, ~10 clientes activos)

Cada worker tiene su propio in-memory cache (Map). Con `4` workers y caches que
guardan `5MB` de payload de bootstrap por tenant + `5MB` de searchRental por
combinación de fechas/locations, el RSS por worker crece rapido.

`2 GB` RAM / `4` workers = `512 MB` per worker. Con `10` tenants activos
cacheando bootstrap (`50MB`) + `5` queries diferentes por tenant
de searchRental (`250MB`), un worker llega a `300+` MB solo en cache.
Mas el JS heap base, mas el peak de procesamiento → OOM probable.

**Sintoma:** worker se reinicia o se queda lento. Sentry muestra spikes
intermitentes.

### 2. Pool exhaustion en endpoints no-cacheados (~20 clientes activos)

Aunque cacheamos los `3` endpoints publicos mas pesados, hay decenas de
endpoints staff no cacheados:
- `/api/reservations/:id/...` (per-reservation)
- `/api/vehicles`, `/api/locations`, `/api/customers/...`
- `/api/dealership-loaner/*`

Bajo concurrencia mas alta, cualquiera de estos puede saturar las `20`
conexiones del pool.

**Sintoma:** vuelve la alerta de Sentry "Prisma Pool Exhaustion".

### 3. CPU saturation (~30 clientes activos)

`1 vCPU` con `4` workers significa que cada worker tiene `~25%` CPU. Bajo
load real, request handling, JSON serialization (los payloads de `5MB`
de searchRental son CPU-intensive), prisma query parsing, y nginx
proxying compiten todos por esa misma CPU.

**Sintoma:** `p95` se dispara a varios segundos, throughput se aplana.

### 4. nginx single-instance (~50+ clientes en pico)

nginx en el mismo droplet maneja ~`30K+` reqs/sec en teoria, pero competimos
con la app por CPU. Si hay un spike, nginx empieza a queue requests y
algunos timeout.

**Sintoma:** `502 Bad Gateway` intermitentes (lo vimos hoy con frontend down).

### 5. Database connections (Tier-dependent)

Supabase Pooler tiene su propio limite por proyecto. En el tier que estamos,
probable es `200-400` connections. Si escalamos a `2-3` droplets cada uno
con `60` connections, llegamos al techo del pooler.

**Sintoma:** `ECIRCUITBREAKER` errors, similares a lo que vimos hoy con
"Unhealthy" status.

## Tiers de Escalamiento

### Tier A — "Sostenible para 5-10 clientes activos" (now → next 3 months)

Objetivo: poder onboardear Triangle + 3-5 tenants similares sin estres.

**Estado real verificado en dashboards 2026-05-08:**

✅ Droplet ya esta en `4 vCPU / 8 GB` (resize ya hecho)
✅ Supabase ya en plan PRO (paid)
❌ Falta Redis para shared cache entre workers
❌ Falta Cloudflare delante del droplet
❌ DATABASE_POOL_SIZE=5 esta sub-utilizando el budget (11/60 conexiones)

**Lo que falta de Tier A:**
| Item | Antes | Despues | Costo/mes |
| --- | --- | --- | --- |
| `DATABASE_POOL_SIZE` env | 5 | **10** | `$0` (env var change) |
| Redis managed | nada | DO Redis 1GB | `$15` |
| Cloudflare | nada | Free plan | `$0` |
| Supabase compute | MICRO | **SMALL** (when 30/60 sustained) | `+$15` (opcional, gating signal) |
| **Total incremental real** | | | `$15-30/mo` |

Mi estimado original de `$89/mo` estaba off — la mayoria del compute upgrade
ya estaba hecho. Lo que falta es solo Redis + Cloudflare + un env tweak.

**Beneficios:**
- `4x` CPU = handles spikes con margen
- `4x` RAM = caches por worker pueden crecer libremente
- Redis = cache compartido entre workers (`cache.js` ya soporta REDIS_URL para invalidacion). Cache hit rate sube de `~25%` (4 workers independientes) a `~95%` (worker que reciba la primera request popula para todos).
- Cloudflare = DDoS protection automatico, edge cache para assets, free SSL backup
- Supabase Pro = `60` direct + `200` pooled connections, mas margin

**Trigger para subir a Tier A:** `2do` cliente parecido a Triangle firma. Hacer ANTES de onboarding.

### Tier B — "Multi-tenant maduro, 10-20 clientes" (3-9 months)

Objetivo: real horizontal scaling, separación de concerns.

**Cambios sobre Tier A:**
| Item | Antes | Despues | Costo/mes |
| --- | --- | --- | --- |
| Droplets | 1 grande | **2 droplets 4 vCPU/8GB** | `$96` (`$48` × 2) |
| Load balancer | nginx local | **DO Load Balancer** | `$12` |
| Postgres replica | solo primary | **Read replica en Supabase** | incluido en Pro+ |
| Job queue | inline | **BullMQ + Redis** | usa el Redis que ya tenemos |
| Worker tier | combinado web+job | **Separar workers de jobs** | `$24` (small droplet para jobs) |
| **Total incremental sobre Tier A** | | | `~$132/mo` |

**Beneficios:**
- Zero-downtime deploys (rolling restart entre droplets)
- Background jobs (CESCO scraper, daily reports, image processing) no compiten con request handling
- Read replica = reportes pesados van a replica, no afectan el primary
- Si un droplet muere, el otro sigue sirviendo

**Trigger para subir a Tier B:** alguno de:
- p95 sostenido > `1s` en endpoints staff
- `>3` pool exhaustion alerts/semana
- Necesidad de zero-downtime deploy (cliente firmando enterprise SLA)

### Tier C — "Enterprise grade, 50+ clientes o multi-region" (9-18 months)

Objetivo: matchear las garantias de Dealerware sin su cost structure.

**Cambios sobre Tier B:**
| Item | Antes | Despues | Costo/mes |
| --- | --- | --- | --- |
| Compute | 2 droplets | **3-5 droplets, auto-scaling group** | `$200-300` |
| Multi-region | NYC3 only | **NYC + LON o SFO** (latency for non-east customers) | `+$100-150` |
| Database | shared Supabase | **Dedicated Supabase Team plan or self-managed Postgres on RDS** | `$599+` |
| CDN | Cloudflare free | **Cloudflare Pro o Business** | `$20-200` |
| Logging | Sentry + Winston | **Datadog o equivalent** | `$15/host` |
| **Total incremental** | | | `+$700-1500/mo` |

**Beneficios:**
- `99.9%` SLA real (multi-region failover)
- Sub-100ms p50 latency para customers fuera de US-East
- Database sharding/dedication para tenants enterprise
- Audit logs, compliance posture (SOC 2 ready)

**Trigger para Tier C:** alguno de:
- `>1` cliente enterprise pidiendo SLA `99.9%` formalmente
- Cliente fuera de timezone US-East con queja de latencia
- `>50` tenants activos
- Compliance need (SOC2, HIPAA, PCI-DSS dependiendo del cliente)

## Inversion vs Revenue (mental model)

Pricing actual del proposal Triangle:
- Setup: `$3,500` one-time
- Monthly: `$1,750-2,550` por tenant

A `10` tenants tipo Triangle activos:
- Revenue: `$17,500-25,500/mo`
- Tier A infra cost: `$89/mo` = **`<0.5%` del revenue**
- Tier B infra cost: `$221/mo` = **`<1.3%` del revenue**

A `30` tenants:
- Revenue: `$52,500-76,500/mo`
- Tier B infra: `$221/mo` = **`<0.5%`**
- Tier C infra: `$1,000-1,500/mo` = **`~2%`**

Cualquier upgrade de tier tiene ROI gigante. La pregunta no es **si** subir
sino **cuándo** sin sobre-invertir antes de tiempo.

## Decision Triggers — Cuando Subir

Decidir por metricas, no por intuicion:

| Tier actual | Trigger para subir | Como medirlo |
| --- | --- | --- |
| Hoy → A | `2do` Triangle-tier client firma | Sales pipeline |
| A → B | sostenido `p95 > 1s` en staff endpoints `5+` dias | Sentry transactions dashboard |
| A → B | `>3` pool/circuit breaker alerts/semana | Sentry Alert "Prisma Pool Exhaustion" history |
| B → C | cliente enterprise pide SLA `99.9%` formal en contrato | Sales |
| B → C | `>50` tenants activos | DB query: `SELECT COUNT(*) FROM Tenant WHERE status='ACTIVE'` |

## Acciones Inmediatas — Esta Semana

Sin cambiar tier todavia, podemos cerrar `2` gaps que ya identificamos hoy:

1. **Verificar plan actual de Supabase.** Si estamos en Free, ya estamos al limite — bumpear a Pro (`$25/mo`) inmediatamente.
2. **Setup Cloudflare delante del droplet.** Free plan, `30` minutos de configuracion DNS. Beneficios:
   - DDoS protection automatica (cualquier spike no nos tumba)
   - Edge cache para assets estaticos
   - Backup HTTPS/SSL
   - Visibilidad en bot traffic
3. **Documentar el current pool config.** Crear `docs/operations/prod-database-pool.md` explicando `DATABASE_POOL_SIZE=5`, `CLUSTER_WORKERS=4`, y por que estan asi.
4. **Setup status page basico.** Use [Better Uptime](https://betteruptime.com) (free tier) o el incluido de Sentry. Cuando una alerta dispare, link al status page para clientes.

## Que NO Necesitamos Aun

Cosas que parecen "best practice" pero no aportan al stage actual:

- ❌ **Kubernetes** — over-engineered para escala actual. Docker Compose en VMs hasta `5+` droplets esta bien.
- ❌ **Microservicios** — un monolito bien organizado es mas fácil de operar a esta escala.
- ❌ **Multi-region NOW** — `99%` de los clientes hoy estan en US-East/PR, NYC3 sirve a todos `<50ms`.
- ❌ **Global CDN paid plan** — Cloudflare free hace lo necesario para los assets.
- ❌ **Datadog/New Relic** — Sentry cubre `90%` de lo que necesitamos por una fraccion del costo.
- ❌ **Custom autoscaling** — DO Droplet resize manual es suficiente hasta Tier C.

## Open Questions Para Hector

1. ¿En que tier de Supabase estamos? (Free / Pro / Team / Enterprise) — define cuanto puedo subir `DATABASE_POOL_SIZE` sin riesgo.
2. ¿Cuántos tenants activos tenemos hoy ademas de `internationrentalcorp-fleet`?
3. Triangle ya firmo o todavia esta en proposal stage?
4. Hay algun cliente potencial que pida SLA formal en su contrato?
5. ¿Estas dispuesto a meter `$89/mo` extra de infra ya, o esperamos al `2do` cliente firmado?

## Recommended Next Step

Si la respuesta a las preguntas anteriores es "Triangle firma pronto":

**Esta semana:** Tier A upgrade. Costo `~$89/mo`, sin cambios de codigo. Lo
puedo hacer guiandote remotamente:

1. DO: resize droplet `1vCPU/2GB → 4vCPU/8GB` (`5` minutos downtime)
2. DO: provisionar Redis managed `1GB` plan (`5` minutos)
3. App: setear `REDIS_URL=redis://...` en `.env`, redeploy (`5` minutos)
4. Cloudflare: agregar el dominio, cambiar nameservers (propaga en `1-24` horas)
5. Supabase: confirmar plan, si estamos en Free → upgrade a Pro

Total: `~30` minutos de trabajo activo + propagacion DNS. Costo incremental
mensual: `$64-89` dependiendo del plan de Supabase.

Después seguimos con el plan de Triangle (inventory separation primero).
