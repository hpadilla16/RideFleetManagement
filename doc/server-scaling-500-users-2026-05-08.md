# Plan: Sostener 500 Usuarios Concurrentes

Fecha base: 2026-05-08
Trigger: Hector flexibilizando presupuesto, target operacional `500` concurrentes
Owner: Hector
Cost target: `$300-500/mo` (vs `~$50/mo actuales`)

## TL;DR

`500` usuarios concurrentes significa **`~80-150` requests por segundo sostenido**
con picos de `200+ rps`. Para sostener eso sin caerse:

1. **Multi-droplet** (`2-3` droplets `4 vCPU / 8 GB`) detrás de Load Balancer
2. **Redis managed** para shared cache + queue de jobs
3. **Supabase compute MEDIUM** (`200+` connections, mas CPU/RAM)
4. **Cloudflare Pro** delante (DDoS + edge cache + analytics)
5. **Background jobs en worker separado** (no compiten con request handling)
6. **Read replica** para reportes pesados
7. **Sentry full** + status page publica

**Costo total estimado: `$280-380/mo`** (vs `~$50` actuales).
A `5` clientes Triangle = `$8,750/mo revenue` → infra es **~`4%`**.
A `10` clientes = `~$17,500/mo` → infra es **~`2%`**.

## Math: Que Significa 500 Concurrentes

### Distribucion realista

```
500 usuarios concurrentes activos
├── 350 (70%) = visitors publicos navegando booking site
│   ├── ~1 request cada 5-10s mientras navegan
│   └── Carga: ~50 rps publico
├── 125 (25%) = staff de tenants en dashboards
│   ├── ~1 request cada 3-5s en uso activo
│   └── Carga: ~30 rps autenticado
└── 25 (5%) = admins / supervisors haciendo reportes
    ├── ~1 request cada 10s (mas pesado)
    └── Carga: ~3 rps reportes
```

**Total sostenido:** ~`80-100 rps`. **Picos:** `150-200 rps` (todos refrescan a la vez).

### Que necesita el backend para sostener 80 rps

```
Request budget per second:
  80 rps × ~150ms avg server time = 12 connections needed simultaneously
  Para spikes 200 rps: 200 × 150ms = 30 connections simultaneous

Pool needed: 30-40 active + 2x headroom = 60-80 connections total
DB max_connections needed: ~120 (con margen)
CPU: 4 vCPU bastante con cache hits dominantes; bajo cold path 8 vCPU mas seguro
RAM: 8 GB aguanta; per-worker caches con Redis tienen menos memory pressure
Outbound bandwidth: 80 rps × 50KB avg = 4 MB/s peak; ~30 GB/mo (trivial)
```

## Que Va A Romper Si Hacemos Esto Hoy Sin Cambios

Con la infra actual (`1` droplet, `pool=20`, no Redis):

1. **Pool exhausted en 30 segundos** — `80 rps` × `200ms` = `16` active, mas misses cargan caches paralelo en `4` workers (cada uno necesita popular su propio cache) = pool ocupado en `<1 min`
2. **Cache thrashing** — `4` workers con caches independientes, hit rate baja con dispersion de keys, repopulan constantemente
3. **CPU spike `>85%` sostenido** — single droplet maneja request handling + nginx + JSON serialization + workers
4. **502s del frontend** — si backend se atrasa, nginx queue se desborda
5. **Single point of failure** — un crash, restart, o deploy = todos los `500` se caen
6. **DB connections** — Supabase MICRO con `60` cap se llena rapido bajo carga

Resultado: errores cascada, customers ven `503/502/timeout`, `panic`.

## Arquitectura Target (para 500)

```
                                  Internet
                                     │
                              ┌──────▼──────┐
                              │ Cloudflare  │  DDoS, edge cache, bot challenge
                              │   (Pro)     │  $20/mo
                              └──────┬──────┘
                                     │
                            ┌────────▼─────────┐
                            │  DO Load Balancer │  $12/mo, sticky-less
                            │   (HA across AZs) │
                            └────┬───────┬─────┘
                                 │       │
                  ┌──────────────┘       └──────────────┐
                  ▼                                     ▼
        ┌──────────────────┐                ┌──────────────────┐
        │   Droplet web-1  │                │   Droplet web-2  │
        │  4 vCPU / 8 GB   │                │  4 vCPU / 8 GB   │
        │  Node + nginx    │                │  Node + nginx    │
        │  4 cluster works │                │  4 cluster works │
        │  $48/mo          │                │  $48/mo          │
        └────────┬─────────┘                └─────────┬────────┘
                 │                                    │
                 └────────┬───────────────────────────┘
                          │
                  ┌───────▼────────┐         ┌──────────────────┐
                  │  Redis managed │         │   Droplet jobs   │
                  │  1GB plan      │◄────────┤   2 vCPU / 4 GB  │
                  │  $15/mo        │         │   BullMQ workers │
                  │                │         │   Cron / scrapers│
                  └───────┬────────┘         │   $24/mo         │
                          │                  └──────────────────┘
                          │
        ┌─────────────────▼─────────────────────┐
        │           Supabase                    │
        │  Plan: PRO + compute MEDIUM           │
        │  Primary: us-east-1                   │
        │  Read replica: us-east-1 (reports)    │
        │  max_connections: ~200                │
        │  $85/mo (Pro) + Medium compute        │
        └───────────────────────────────────────┘
```

### Por que cada componente

**Cloudflare Pro (`$20/mo`):**
- DDoS protection sin pensar — el pricing menciona casos como [el de hoy](#) donde un spike de bots tumbo el pool
- Edge cache para HTML/CSS/JS/images — corta `60-80%` del trafico de assets
- Bot challenge para abuso obvio (scrapers, login attempts)
- Analytics (que pais, que IP, que paths son mas hit)
- Rate limiting a nivel CDN si configuramos
- Argo Smart Routing (`+$5/mo` opcional) — mejor latencia US-East/PR

**Load Balancer DO (`$12/mo`):**
- Distribuye trafico entre `2+` droplets
- Healthcheck activo — si web-1 muere, LB lo saca y solo manda a web-2
- Zero-downtime deploys (rolling restart un droplet a la vez)
- SSL termination (mueve la carga del nginx local)

**`2x` Droplets web (`$48 × 2 = $96/mo`):**
- Redundancia + capacidad
- Cada uno maneja `~50 rps` comodo, `100 rps` apretado
- Los `2` juntos: `~150 rps` sostenido sin estres
- Si uno se cae, el otro absorbe `100%` (degraded pero sin downtime)

**Redis managed (`$15/mo`):**
- Cache compartido entre los `2 × 4 = 8` workers (vs `8` islas independientes)
- Cache hit rate sube de `~25%` a `~95%` global
- Tambien sirve como queue para BullMQ jobs
- DO Managed Redis incluye HA + backups + monitoring
- `cache.js` ya soporta `REDIS_URL` para invalidacion via pub/sub

**Droplet jobs (`$24/mo`):**
- BullMQ workers separados del web tier
- Para CESCO scraper, daily report email, image processing, queue cleanup, etc.
- No compite con request handling
- Si un job se cuelga, no afecta el web

**Supabase Pro + Compute MEDIUM (`$25 + $60 = $85/mo`):**
- `200+ max_connections` (vs `60` actual)
- Mas CPU/RAM en el Postgres = queries mas rapidos
- Read replica para reports — el endpoint `/api/reports/overview` y otros pesados van a replica, primary queda libre para writes
- Backup automatico + PITR

**Sentry/Better Uptime (`$26/mo`):**
- Sentry team plan ($26) para mas events + retention
- Better Uptime free para status page publica

## Configuracion Aplicacion

Cambios de codigo/config necesarios para esta arquitectura:

### 1. Connection pool bigger

```yaml
# docker-compose.prod.yml en cada web droplet
environment:
  CLUSTER_WORKERS: "4"
  DATABASE_POOL_SIZE: "12"   # 12 × 4 workers × 2 droplets = 96 connections from web tier
  REDIS_URL: "rediss://default:****@redis-host:25061"
```

```
Connection budget:
  Web tier: 12 × 4 × 2 = 96 connections
  Job tier: 5 × 4 = 20 connections
  Migrations / admin / Studio: ~10 connections
  Total: ~126
  Supabase MEDIUM cap: ~200
  Headroom: 74 (37% margin)
```

### 2. Cache strategy maxed

Con Redis activo, `cache.js` automaticamente broadcasta `del/invalidate/clear`
a todos los workers via pub/sub. Solo necesitamos:

- Setear `REDIS_URL` (lib auto-detecta)
- TTLs agresivos donde data es estable (60s for bootstrap, 120s for fees, 30s for reservation list)
- Invalidate explicit en mutations (lo que ya haces)

Verificar que las invalidaciones criticas estan en place:
- `vehicleType.update` → `cache.invalidate('public:bootstrap:')` y `cache.invalidate('public:vehicle-classes:')`
- `fee.update` → `cache.invalidate('public:website-fees:')`
- `reservation.create/update` → `cache.invalidate('staff:reservations:')`

### 3. Read replica routing

Para reportes pesados, mandar queries a la replica en lugar del primary:

```javascript
// backend/src/lib/prisma.js — agregar segundo client
export const prismaReplica = new PrismaClient({
  log: logOptions,
  datasources: { db: { url: appendPoolParams(process.env.DATABASE_REPLICA_URL || process.env.DATABASE_URL) } }
});
```

Cambiar reportes de `prisma.X.findMany` → `prismaReplica.X.findMany` (o helper `forReporting()`).

### 4. Background jobs separados

Crear `backend/src/jobs/` con BullMQ:

```javascript
// backend/src/jobs/index.js
import { Queue, Worker } from 'bullmq';

const connection = { connection: { url: process.env.REDIS_URL } };

export const queues = {
  cescoTickets: new Queue('cesco-tickets', connection),
  dailyReports: new Queue('daily-reports', connection),
  imageProcessing: new Queue('image-processing', connection),
};

// Web tier: solo ENQUEUE jobs (Queue.add)
// Job droplet: solo CONSUME (Worker)
```

Mode separado:
- Web: `node src/main.js` (el actual)
- Jobs: `node src/jobs/runner.js` (nuevo)

### 5. Per-tenant rate limiting

Hoy el rate limiter es solo por IP. A escala con muchos tenants, agregar
budget por tenantId:

```javascript
// extender public-endpoint-guards.js
const tenantRateLimit = createPublicRateLimitGuard({
  name: 'public-booking-tenant',
  maxRequests: 600,     // por tenant por minuto
  windowMs: 60 * 1000,
  keyExtractor: (req) => req.query.tenantSlug || req.body?.tenantSlug || 'unknown'
});
```

Asi un tenant con bot traffic excesivo no afecta a los otros tenants en el
mismo droplet.

### 6. Health metrics endpoint

`/internal/metrics` (auth con shared secret, no publico):
- Active DB connections per worker
- Cache stats (size, hit rate, redis ready)
- Memory/CPU del proceso Node
- Latency p50/p95/p99 de los ultimos `5 min`

Para que un dashboard externo (Grafana, Datadog si subimos) pueda agregarlos.

## Cost Breakdown

| Item | Costo/mo | Comentario |
| --- | --- | --- |
| Droplet web-1 (`4vCPU/8GB`) | `$48` | actual reusado |
| Droplet web-2 (`4vCPU/8GB`) | `$48` | nuevo |
| Droplet jobs (`2vCPU/4GB`) | `$24` | nuevo |
| DO Load Balancer | `$12` | nuevo |
| DO Managed Redis (`1GB`) | `$15` | nuevo |
| Supabase PRO | `$25` | actual |
| Supabase compute MEDIUM | `$60` | upgrade de MICRO |
| Read replica add-on | `~$30` | sobre Pro+Medium |
| Cloudflare Pro | `$20` | nuevo |
| Sentry Team plan | `$26` | upgrade de free (mas events) |
| Better Uptime / status page | `$0` | free tier |
| **Total** | **`$308/mo`** | |

Si nos extendemos:
- Cloudflare Argo (`$5`) para mejor latencia hacia US-East/PR = `$313/mo`
- Datadog APM (`$15/host × 3` hosts) = `$358/mo`
- Multi-region (segundo droplet en LON o SFO) = `+$72/mo` = `$385+/mo`

**Rango realista: `$300-400/mo`** para sostener `500` concurrentes con margen.

## Migration Plan — De Hoy a Target

No hacer todo de una. Por fases, cada una observable.

### Fase 1 — Esta semana (no downtime, `+$15/mo`)

Objetivo: estabilizar lo que ya tienes y prepar el camino.

| # | Cambio | Cost delta | Risk |
| --- | --- | --- | --- |
| 1.1 | Subir `DATABASE_POOL_SIZE` de `5` a `10` en compose | `$0` | Cero (still under 60 cap) |
| 1.2 | Provisionar Redis managed `1GB` en DO | `+$15/mo` | Cero (additive, app no requiere) |
| 1.3 | Setear `REDIS_URL` en .env, redeploy | `$0` | Bajo (`cache.js` valida fallback) |
| 1.4 | Verificar Sentry alerts disparan correcto | `$0` | Cero |
| 1.5 | Cloudflare Free delante del dominio | `$0` | Bajo (DNS propagacion ~24h) |

Resultado fin de Fase 1:
- Pool capacidad efectiva: `40 → 96` (subiendo el limit *y* compartiendo cache via Redis)
- Cache hit rate: `~25% → ~95%`
- DDoS protected
- Cost incremental: `$15/mo`

### Fase 2 — Semana 2-3 (preparing for 200+ users, `+$60/mo`)

Objetivo: subir Supabase compute para mas connection budget.

| # | Cambio | Cost delta | Risk |
| --- | --- | --- | --- |
| 2.1 | Supabase compute MICRO → SMALL | `+$15/mo` | Bajo (`5-10` min downtime durante upgrade) |
| 2.2 | Subir `DATABASE_POOL_SIZE` a `15` | `$0` | Cero |
| 2.3 | Sentry plan upgrade a Team | `+$26/mo` | Cero |
| 2.4 | Cloudflare Pro upgrade | `+$20/mo` | Cero |

Resultado fin de Fase 2:
- Connections: `60 → 120 cap`, `40 → 60 used`
- Visibility: full Sentry retention + analytics
- DDoS + edge cache + analytics

### Fase 3 — Semana 4-5 (real horizontal scale, `+$120/mo`)

Objetivo: salir del SPOF, agregar capacidad.

| # | Cambio | Cost delta | Risk |
| --- | --- | --- | --- |
| 3.1 | Crear droplet web-2 identico | `+$48/mo` | Cero (additive) |
| 3.2 | DO Load Balancer delante de los `2` droplets | `+$12/mo` | Medium (DNS cutover) |
| 3.3 | Supabase MEDIUM (subir mas el compute) | `+$45/mo extra` | Bajo |
| 3.4 | Subir `DATABASE_POOL_SIZE` a `12 × 4 × 2 = 96` total | `$0` | Bajo |
| 3.5 | Test sintetico de failover (matar web-1, ver que LB se recupera) | `$0` | Cero |

Resultado fin de Fase 3:
- Sin SPOF: cualquiera de los `2` droplets puede caer sin downtime
- Capacidad: `100 → 200 rps` sostenidos
- Connections: `~96 from web tier, 100+ headroom`

### Fase 4 — Semana 6-8 (background separation, `+$30/mo`)

Objetivo: aislar jobs del web path para que no compitan.

| # | Cambio | Cost delta | Risk |
| --- | --- | --- | --- |
| 4.1 | Crear droplet jobs (`2 vCPU / 4 GB`) | `+$24/mo` | Cero |
| 4.2 | Implementar BullMQ + queues en `backend/src/jobs/` | `$0` | Medium (refactor) |
| 4.3 | Mover scrapers / daily reports / email a queues | `$0` | Medium |
| 4.4 | Read replica de Supabase para reports | `+$30/mo` | Bajo |

Resultado fin de Fase 4:
- Web tier no se atora por jobs largos
- Reports no compiten con writes
- Listo para `500` concurrentes

### Fase 5 — Semana 8-12 (polish + observability, `$0`)

Objetivo: ver que pasa antes que el cliente lo vea.

| # | Cambio | Cost | Risk |
| --- | --- | --- | --- |
| 5.1 | `/internal/metrics` endpoint con pool stats | `$0` | Cero |
| 5.2 | Dashboards en Sentry / Grafana | `$0` | Cero |
| 5.3 | Per-tenant rate limiting | `$0` | Bajo |
| 5.4 | Status page publica con uptime real | `$0` | Cero |
| 5.5 | Load test `500` VUs sostenido `5 min` (con multi-IP harness) | `$0` | Bajo |
| 5.6 | Runbook de incident response | `$0` | Cero |

Resultado: capaz de sostener `500` con visibilidad, alerting, runbooks.

## Total por fase

| Fase | Cost incremental | Cost total mensual | Capacidad |
| --- | --- | --- | --- |
| Hoy | `$0` | `~$60` | `~50-100` concurrentes con cuidado |
| Fase 1 (semana 1) | `+$15` | `~$75` | `~150-200` concurrentes |
| Fase 2 (semana 2-3) | `+$61` | `~$136` | `~200-250` concurrentes |
| Fase 3 (semana 4-5) | `+$120` | `~$256` | `~350-400` concurrentes |
| Fase 4 (semana 6-8) | `+$54` | `~$310` | `~500` concurrentes (target) |
| Fase 5 (semana 8-12) | `$0` | `~$310` | `500+` con observability |

## Decision Points — Cuando Acelerar / Frenar

Reglas para no over-engineer ni under-engineer:

| Scenario | Action |
| --- | --- |
| Triangle aun no firma despues de Fase 1 | Pausar en Fase 2, esperar |
| `>3` Sentry pool alerts en una semana | Acelerar Fase 3 (multi-droplet) |
| Cache hit rate `<80%` despues de Redis | Investigar antes de Fase 2 |
| Cliente enterprise pidiendo `99.9% SLA` | Saltar a Fase 4 + planear Tier C |
| Crecimiento en clientes mas rapido que esperado (5+ Triangle-tier en `1` mes) | Compactar Fase 3+4 en `2` semanas |
| Carga real `<100 rps` despues de Fase 3 | Pausar Fase 4, validar con load test |

## Lo Que NO Necesitamos (todavia)

A pesar de presupuesto flexible, no agregar cosas que no aportan al stage:

- ❌ **Kubernetes** — `2-3` droplets manuales son fáciles de operar
- ❌ **Multi-region** — solo si cliente fuera de US-East o `>1000` concurrentes
- ❌ **Autoscaling** — DO droplet resize manual basta hasta Tier C
- ❌ **Microservicios** — el monolito esta bien organizado
- ❌ **Search engine (Elasticsearch)** — Postgres GIN indexes alcanzan
- ❌ **Custom CDN edge functions** — Cloudflare hace lo necesario
- ❌ **Dedicated tenant infra** — solo para clientes enterprise especificos

## Open Questions Para Hector

1. ¿`500` es target de `3 meses` o de `12 meses`? Cambia urgencia de fases.
2. ¿Triangle ya firmo? Si si, Fase 1 esta semana, Fase 2 next week.
3. ¿Hay clientes potenciales que pidan SLA formal o uptime guarantees?
4. ¿Deploys actuales son SSH manual? Para multi-droplet quiero automatizarlos en CI.
5. ¿Tienes preferencia entre DO ecosystem (todo DigitalOcean) vs mixto (e.g., Supabase + Railway, Render, etc.)?
6. Los tenants futuros, ¿van a ser todos US-East o tambien Europe/Latam? Define si necesitamos multi-region.

## Recommended Path

Dado que dijiste flexible con costo y target `500`:

**Esta semana arranco Fase 1** (`$15/mo extra`):
- Subir pool a `10`
- Provisionar Redis
- Cloudflare Free

**Si Triangle firma o se acumula otro cliente, Fase 2-3 en las siguientes 2-3 semanas** (`$181/mo total`):
- Supabase MEDIUM
- Cloudflare Pro
- Segundo droplet + LB

**Fase 4 (jobs + read replica) cuando veas alguno:**
- Dashboard de admin lento
- Daily reports tardando minutos
- Reports compitiendo con writes

**Fase 5 (observability) en paralelo con todo lo demas — empezar ya**.

Total target: `~$310/mo` en `~6-8 semanas`. Capaz de sostener `500` concurrentes
con margen para spikes. Headroom suficiente para crecer a `~700-800` antes de
necesitar Tier C.
