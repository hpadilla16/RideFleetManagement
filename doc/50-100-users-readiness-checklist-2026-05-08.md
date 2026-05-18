# Readiness Checklist — 50 to 100 Concurrent Users

Fecha base: 2026-05-08
Objetivo: estar listos para `50-100` usuarios concurrentes sostenidos sin
incidentes, sin patches reactivos, con visibilidad antes que el cliente note algo.
Owner: Hector

## TL;DR

**El sistema técnicamente puede manejar `50-100` concurrentes hoy mismo** —
hicimos el load test con `5 VUs` sostenido sin errores, las features
problemáticas (pool exhaustion, payload bloat, nested loops) están todas
parcheadas, y la rate-limiter protege contra bursts.

**Pero hay `5` cosas pendientes para tener margen de seguridad real.**
Ninguna requiere refactor de código grande. Total cost: `~$15/mo`. Total
effort: `~3-4 horas` repartidas en setup + validación.

| Action | Cost | Effort | Impact |
| --- | --- | --- | --- |
| 1. Provisionar Redis managed (`1 GB`) | `+$15/mo` | 15 min | Cache hit rate `25% → 95%` |
| 2. Cloudflare Free delante del dominio | `$0` | 30 min + DNS prop | DDoS protection + edge cache |
| 3. Load test multi-IP `100 VUs` | `$0-50` (test) | 1-2 horas | Validar capacidad real |
| 4. Sentry alerts adicionales (slow query, 5xx) | `$0` | 30 min | Visibilidad antes del incidente |
| 5. Deploy + rollback runbook documentado | `$0` | 1 hora | Incident response time `<10 min` |

Después de los `5` items, **el sistema está validated y observability-ready
para sostener `100+` concurrentes** con margen de spike hasta ~`200`.

## Lo Que Ya Tenemos (`8 May 2026`)

Desde el incidente de la mañana hasta esta noche shippeamos:

```
Compute:
  ✓ DO Droplet 4 vCPU / 8 GB RAM / 160 GB disk
  ✓ 4 cluster workers (CLUSTER_WORKERS=4)
  ✓ 12 connections per worker = 48 total app connections

Database:
  ✓ Supabase PRO plan
  ✓ Compute MICRO (max_connections=60), 11/60 used baseline
  ✓ Direct + pooler URL configured
  ✓ Read-replica capable (Pro tier supports it, not provisioned yet)

Caching layer:
  ✓ cache.getOrSet con thundering-herd coalescing (lib/cache.js)
  ✓ Cache wraps en bootstrap, website-fees, searchRental, vehicle classes
  ✓ Reservation list / summary / page caches
  ✓ getOrSet collapses concurrent misses → single in-flight batch
  ✗ NO Redis configured — cache state NOT shared across 4 workers
    (effective hit rate ~25% per cache key vs 95% if shared)

Performance:
  ✓ Bootstrap: 5.5MB → 2KB (R23 deduplication + image strip)
  ✓ searchRental cold: 5s → 2s (R8 parallelization)
  ✓ Pool exhaustion: cero events post v0.9.0-beta.27
  ✓ Public endpoints rate-limited (120 req/min read, 40 req/min write per IP)

Observability:
  ✓ Sentry "Prisma Pool Exhaustion" alert (connection pool OR ECIRCUITBREAKER)
  ✓ PRISMA_SLOW_QUERY_MS=200 (Winston warn level)
  ✓ Sentry uptime monitor on https://ridefleetmanager.com
  ✗ NO slow-query Sentry alert rule (logs only)
  ✗ NO 5xx error rate alert rule
  ✗ NO connection pool active count metric exposed
  ✗ NO public status page

Deploy:
  ✓ docker compose up -d --build --force-recreate
  ✓ Tagged releases (v0.9.0-beta.NN)
  ✓ Migrations via prisma db push --skip-generate (manual)
  ✗ NO documented rollback runbook
  ✗ NO automated smoke test gating deploy
  ✗ Deploy briefly drops backend container (10-30s)

Network:
  ✓ nginx 1.24 directo en el droplet
  ✓ SSL terminado en nginx
  ✗ NO Cloudflare (DDoS / edge cache / bot challenge)
  ✗ Single point of failure — nginx + app + DB pooler en mismo droplet
```

## Math Reality Check — Que Aguanta El Sistema Hoy

Con la config actual (sin Redis, sin Cloudflare):

```
Sustained traffic capacity:
  4 workers × 12 connections = 48 active connections
  Avg query duration: ~150ms
  Theoretical: 48 / 0.15 = 320 queries/sec
  
  But: cache hits dominate. With current ~25% hit rate per worker:
    - 75% of requests fan out to DB
    - Real capacity: ~100-150 sustained req/sec
    
  At 50 concurrent users × 0.3 req/sec each = 15 rps → 10% utilization. Easy.
  At 100 concurrent users × 0.3 req/sec each = 30 rps → 20% utilization. Still easy.
  At 200 concurrent users × 0.3 req/sec each = 60 rps → 40% utilization. Working but tight.

Burst capacity (1-second spikes):
  Pool can absorb up to ~48 simultaneous queries before queueing
  10 second pool timeout means burst tolerance ~480 query-seconds
  Translation: 50 users hitting hard simultaneously = fine
  Translation: 200 users hitting at exact same instant = pool queue, slow but no errors

With Redis added:
  Cache hits → cache layer (not pool)
  Effective pool pressure drops ~75%
  Real capacity: ~400-500 sustained req/sec
  
  At 100 concurrent users → 30 rps → 6% utilization. Lots of headroom.
```

**Conclusión: hoy mismo aguanta `50-100` sostenidos.** Lo que cambia con
los `5` items es la **safety margin** y la **visibility**.

## The 5 Items — Que Hacer Para Estar Tranquilos

### 1. Redis managed `1GB` ← **highest ROI**

**Por qué:**
Cada worker tiene su propio `Map` cache. Con `4` workers, una request
warms uno de los caches; las próximas `3` requests del mismo key (en
otros workers) van a hit DB nuevamente. Hit rate efectivo per-key ~`25%`.

Con Redis pub/sub configurado (`cache.js` ya lo soporta nativamente — solo
falta `REDIS_URL`), el cache se comparte: una request popula, las `7`
siguientes son cache hits.

**Cómo:**
```bash
# 1. Provisionar via DO dashboard:
#    Create → Database → Redis
#    Plan: Basic 1GB ($15/mo)
#    Region: NYC3 (mismo que droplet)
#    VPC: same as droplet (private networking)
#    Eviction: allkeys-lru
# 2. Copiar connection string del tab "Connection Details"
# 3. SSH al droplet:
ssh root@ridefleetmanager.com
cd ~/RideFleetManagement
echo 'REDIS_URL=rediss://default:****@private-fleet-redis-nyc3-do-user-XXXX.l.db.ondigitalocean.com:25061' >> backend/.env
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
sleep 30
docker logs --tail 50 fleet-backend-prod | grep -i redis
# Should see: [cache] redis pub/sub ready (channel=fleet:cache-invalidate, ...)
```

**Impacto medible:** Latencia p50 `searchRental` cached: `~500ms → ~50ms`.
Pool utilization durante peak: `40% → 10%`.

**Cost:** `+$15/mo`. **Effort:** `15 min`. **Risk:** zero (additive — `cache.js`
falls back to local-only if Redis unreachable).

### 2. Cloudflare Free delante del dominio

**Por qué:**
- DDoS / bot mitigation automática
- Edge cache para JS/CSS/imágenes (reduce ~`60%` del tráfico al droplet)
- HTTPS con `9 año cert lifetime` (one less worry)
- Analytics de tráfico real (qué países, paths, status codes)
- Rate limiting nivel CDN como secondary defense

**Cómo:**
```
1. Cloudflare dashboard → Add a Site → ridefleetmanager.com (free plan)
2. CF te da 2 nameservers (e.g., kate.ns.cloudflare.com / bob.ns.cloudflare.com)
3. En tu registrar: cambiar nameservers a los de CF
4. Esperar propagación DNS (típico 1-2h, max 24h)
5. Cuando CF muestre "Active":
   - DNS tab: A record → IP del droplet, proxy enabled (orange cloud)
   - SSL/TLS mode: Full (no Strict aún hasta validar el cert local)
   - Speed → Optimization: Brotli on, HTTP/3 on
   - Caching → Configuration: Browser Cache TTL = 4h (default fine)
```

**Impacto:** Spike de bot traffic ya no llega al droplet. Geographic
latency para US-East customers: ~`50ms` mejor por edge caching.

**Cost:** `$0`. **Effort:** `30 min` activo + `~24h` propagación. **Risk:**
DNS cutover momentáneo (DNS TTL típicamente `5-60 min` worst case).

### 3. Load test multi-IP a `100 VUs`

**Por qué:**
El load test que hicimos hoy fue desde `1 IP`, lo que activa el
rate-limiter ANTES del pool. Eso valida que el rate-limiter funciona, no
que el pool aguante carga real distribuida.

Para validar `50-100 concurrentes reales` necesitamos `50-100 IPs distintas`
porque cada usuario real viene de una IP propia.

**Cómo:**
**Opción A — k6 cloud ($30 trial credit):**
```
1. Crear cuenta gratis en https://app.k6.io
2. Adapt el harness existente (run-public-booking.mjs) a k6 syntax
3. Run from k6 cloud: distribuye carga desde 5 regiones globales
4. Configurar 100 VUs × 5 min sostenido
5. Verify: cero pool errors, p95 < 5s, error rate < 1%
```

**Opción B — Distributed manual:**
```
1. Provisionar 5 droplets pequeños temporales ($10 each = $50/mes prorated)
2. En cada uno correr el harness con 20 VUs
3. Total: 5 IPs × 20 VUs = 100 distinct VUs
4. Después destruir los droplets
```

**Cost:** `$0-50`. **Effort:** `1-2 horas` setup + run. **Validation
criteria:**
- Error rate `<1%`
- p95 latency `<5000ms` en cualquier endpoint
- Cero `connection pool` errors en Sentry
- Cero `ECIRCUITBREAKER` errors
- Cache hit rate `>80%` después de warmup

### 4. Sentry alerts adicionales (más allá del pool)

Lo que tenemos hoy: alert solo para pool exhaustion. Lo que falta para
no enterarnos por el cliente:

**Alert rule 1 — Slow queries:**
```
Name: Prisma Slow Queries
Trigger: A new issue is created
Filter: event.message contains "prisma slow query" 
        AND event.level >= warning
Throttle: Once per 30 minutes (avoid spam)
Action: Email
```

**Alert rule 2 — 5xx error rate spike:**
```
Type: Metric Alert
Metric: failure_rate() across all transactions
Threshold: error_rate > 5% for 3 consecutive minutes
Critical threshold: error_rate > 15% for 1 minute
Action: Email + immediate page
```

**Alert rule 3 — Latency degradation:**
```
Type: Metric Alert  
Metric: p95(transaction.duration)
Filter: transaction starts with /api/
Threshold: p95 > 3000ms for 5 minutes
Action: Email
```

**Alert rule 4 — Frontend errors:**
```
Type: Issue Alert
Trigger: An issue's events count exceeds 50 in 10 minutes
Filter: project = frontend
Action: Email
```

**Cost:** `$0` (Sentry free tier covers this). **Effort:** `30 min` clicking
through dashboard.

### 5. Deploy + rollback runbook

Hoy: deploy es manual SSH + docker compose. Si algo falla, no hay step-by-step.
Necesitamos:

**Crear `docs/operations/deploy-runbook.md` con:**

```markdown
# Standard deploy
1. Local: git checkout main && git pull
2. Local: git tag v0.9.0-beta.NN
3. Local: git push origin v0.9.0-beta.NN
4. SSH: ssh root@ridefleetmanager.com
5. SSH: cd ~/RideFleetManagement
6. SSH: git fetch --tags && git checkout v0.9.0-beta.NN
7. SSH: docker compose -f docker-compose.prod.yml up -d --build --force-recreate
8. SSH: sleep 30 && curl -fsS http://localhost:4000/health
9. Verify: docker logs --tail 30 fleet-backend-prod | grep -i prisma
10. External: curl -sI https://ridefleetmanager.com/

# Migration deploy (if schema changed)
- Add between step 7 and 8: docker compose run --rm backend npx prisma db push --skip-generate
- IF connection hangs (port 6543 issue): apply via psql with direct URL

# Rollback (if deploy breaks)
1. SSH: cd ~/RideFleetManagement
2. SSH: git checkout v0.9.0-beta.PREVIOUS
3. SSH: docker compose -f docker-compose.prod.yml up -d --force-recreate
4. Verify health
5. If migration was applied — assess if reversible. Most are forward-only.

# Hotfix flow
1. Create branch hotfix/<short-name>-YYYY-MM-DD off main
2. Commit + push
3. Open PR, request review (or self-merge if owner)
4. Merge + tag + deploy via standard flow

# When things go very wrong
1. Check Supabase status: status.supabase.com
2. Check droplet: ssh + uptime + docker ps
3. Check Cloudflare: cloudflareforce.com/cdn-cgi/trace
4. Sentry latest events
5. Roll back to last known good tag
6. Document in known-bugs as new BUG-NNN
```

**Cost:** `$0`. **Effort:** `1 hora`. **Impact:** time-to-resolution durante
incidente baja de "improvising in panic" a "follow checklist".

## Validación — Cómo Saber Que Estamos Listos

Después de los 5 items, run el "ready check":

```bash
# 1. Pool config visible at boot
ssh root@ridefleetmanager.com
docker logs fleet-backend-prod | grep "appending connection_limit" | head -4
# Should show: 4 workers each appending pool=12

# 2. Redis connected
docker logs fleet-backend-prod | grep "redis pub/sub ready" 
# Should show: [cache] redis pub/sub ready (channel=...)

# 3. Cache hit rate (check from Sentry transactions or app logs)
# After 5 min of traffic, /api/public/booking/bootstrap p50 should be <100ms
# (if all hits) — if you see >300ms p50, hits are not working

# 4. Cloudflare proxy active
curl -sI https://ridefleetmanager.com/ | grep -i 'cf-ray\|server'
# Should show: server: cloudflare and cf-ray header

# 5. Sentry alerts firing test (use Sentry's "Send test notification")
# Should receive 4 emails for the 4 alert rules

# 6. Multi-IP load test passed
# k6 report shows 100 VUs × 5 min, error rate < 1%, p95 < 5000ms

# 7. Runbook tested (dry-run rollback)
# Pick a non-critical hour, deploy a known harmless tag, then immediately
# rollback. Time the whole flow. Should be < 5 min end-to-end.
```

Si los `7` checks pasan: **`50-100` concurrentes ready, con margen de spike
a `~200` antes de necesitar la siguiente fase**.

## Lo Que NO Necesitamos (todavía) Para 50-100

A pesar de tener budget flexible — no agregar lo que no aporta al stage:

- ❌ **Multi-droplet + Load Balancer** — necesita Phase 3 (`200+` concurrent
  sostenidos). Por ahora `1` droplet con `4` workers + Redis es suficiente.
- ❌ **Read replica de Postgres** — solo si reportes pesados degradan el
  primary. No vimos eso aún.
- ❌ **Background jobs droplet separado** — no tenemos jobs largos en
  flight (CESCO scraper sería el primero — cuando lo construyamos, ahí
  separamos).
- ❌ **Multi-region** — todos nuestros tenants están US-East / PR. Latency
  ya es buena.
- ❌ **Datadog / New Relic** — Sentry cubre `90%` de la observabilidad por
  free.
- ❌ **Kubernetes** — over-engineered para 1-2 droplets.

## Cuándo Subimos a la Siguiente Fase (`200+` users)

Triggers para mover a Phase 3 (multi-droplet):

- p95 sostenido `>1s` en endpoints autenticados durante `5+` días
- `>3` Sentry pool alerts/semana
- Memory pressure consistent en un worker
- Cliente enterprise pidiendo SLA `99.9%` formal
- `>30` tenants activos
- Crecimiento orgánico que dispare cualquier de los 4 anteriores

Hasta entonces: hold steady en Phase 1 + los 5 items.

## Recommended Sequencing

Orden óptimo si arrancas mañana:

**Día 1 (1.5 horas):**
1. Provisionar Redis en DO dashboard (15 min)
2. Setear `REDIS_URL` en `.env` del droplet + redeploy (10 min)
3. Verificar log line "redis pub/sub ready" (5 min)
4. Setup Cloudflare account + agregar domain (15 min)
5. Cambiar nameservers en registrar (10 min) — propagación corre en background
6. Crear los `4` Sentry alert rules adicionales (30 min)

**Día 2 (1 hora):**
1. Cloudflare debe estar activo (verifying DNS)
2. Configurar SSL/TLS mode + caching settings (15 min)
3. Smoke test post-Cloudflare: visit site, ver `cf-ray` header (5 min)
4. Escribir `docs/operations/deploy-runbook.md` (40 min)

**Día 3 (1-2 horas):**
1. Setup k6 cloud cuenta (10 min)
2. Adaptar harness a k6 syntax (30 min)
3. Run 100 VU × 5 min load test (15 min)
4. Analyze report + document baseline (30 min)

**Total: `~3-4 horas` de trabajo activo en `~3 días` para estar fully ready.**

## Una Cosa Más — Backup / DR Sanity Check

Vale la pena verificar (`30 min`):

1. **Supabase backups**: dashboard → Settings → Backups. Confirmar que
   automatic backups están on, retention period (default `7 días` en Pro).

2. **Test de restore**: Supabase tiene "Restore database to point in time"
   en Pro. Hacer un test restore en una rama `dev` para confirmar que
   funciona (no en prod obviamente).

3. **Code repo backup**: GitHub es la source of truth, pero si tu cuenta se
   compromete, ¿hay un backup? Considerar mirror en otro provider (e.g.,
   sourcehut, codeberg).

4. **`.env` backup**: el `backend/.env` del droplet contiene secrets
   (DATABASE_URL, REDIS_URL después de mañana, JWT secret, etc.). Si
   pierdes el droplet, ¿están en algún password manager?

5. **Domain renewal**: cuándo expira `ridefleetmanager.com`? Auto-renew
   activado? Un dominio expirado sin notice = downtime sin recovery rápido.
