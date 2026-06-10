# Session handoff — 2026-06-10 EOD (scraper + seam de inspección móvil)

Prod corre de `release/deposit-balance-fix-beta119`. **Prod confirmado = v0.9.0-beta.152**
(deployado junto con beta.151 en un solo build; 3 contenedores healthy, /health 200, boot
limpio, requests + sweeps del worker verificados por log-dump). Continúa de
`doc/session-handoff-2026-06-10-phase0-EOD.md` (Phase 0 cerrado en la mañana).

## Parte 1 — Expedia scraper (droplet APARTE: ridefleet-scraper-prod, 138.197.27.209)

**Contexto que NO estaba en la memoria y ahora sí:** el scraper corre en un droplet
dedicado (1 vCPU/2GB), stack **Python + Playwright + Browserbase** (sesión Chromium cloud
fresca por día-buscado, `solveCaptchas`, proxies del pool de Browserbase). Cron con 3 (ahora
4) ventanas que llaman `run_all_profiles.sh <horaEDT>` → `run_profile.py --profile-id`.
Los archivos viven SOLO en ese droplet (`/root/ridefleet-scraper/`); en el repo quedaron
los scripts de mantenimiento en `ops/scraper-droplet/`. El `backend/scripts/market-scraper/`
del repo (node/Bright Data) es el ancestro — NO es lo que corre en prod.

**Bug del día:** run de las 4AM trancado en RUNNING y el siguiente sin correr.
- Causa 1: `timeout 1800` del wrapper mató el python a los 30 min (día 13/14) — SIGTERM no
  actualiza la fila → RUNNING huérfano para siempre (el runner solo finaliza en exit limpio).
- Causa 2 (el porqué tardaba tanto): `no_car_cards_in_dom` masivo. Diagnóstico con
  screenshots (diag_one_day.py, quedó en el droplet): **NO es challenge de Imperva** — la
  página carga, el form aplica, pero Expedia responde **"Sorry! We're experiencing some
  technical problems"** = soft-block del search por reputación de la sesión/IP del pool
  compartido de Browserbase. ~50% de las sesiones en ráfagas malas; los retries de 90s caían
  en la misma ráfaga.

**Fixes aplicados (vía `ops/scraper-droplet/2026-06-10-scraper-fixes.sh` + `...-profiles-fixup.sh`):**
- Wrapper: timeout 1800→3600; al fallar un perfil marca sus runs RUNNING→FAILED (psycopg2)
  + actualiza lastRunStatus del perfil; splay random 0-45 min (SPLAY_MAX_SEC, solo cron);
  flock serializa ventanas (espera hasta 3h).
- run_profile.py: espera `car-offer-card` O el banner de error (lo que llegue primero, en
  segundos); clasifica `expedia_technical_problems`; retries 2→4 con sesión Browserbase
  fresca c/u; sleep 30s.
- Perfiles/cron → 4 ventanas: **1-14 @4AM daily · 15-29 @11AM daily · 30-44 @5AM cada 4d ·
  45-59 @6AM cada 4d** (EDT; cron en UTC 8/15/9/10 — en invierno corre 1h antes local).

**PENDIENTE scraper (mañana):**
- Revisar `/var/log/ridefleet-scraper/2026-06-11.log` → tasa real con la cadencia normal.
  Si sigue alta: (a) warm-up (visitar expedia.com home antes del carsearch), (b) proxy
  residencial PROPIO vía Browserbase external proxy (IPRoyal — creds ya en el .env del
  scraper droplet), (c) ver session replays en el dashboard de Browserbase.
- Muerte silenciosa sin OOM a los 8 min en un test (día 4/14, sin traceback) — sospecha
  segfault de Playwright en el box de 1 vCPU. Sin reproducir después. Los 4 intentos +
  cleanup la mitigan. Si reaparece: `dmesg -T | grep -i segfault`.
- Las sugerencias de pricing del 2026-06-10 AM salieron de data PARCIAL (run trancado +
  engine corrió igual) — Hector iba a revisar el inbox de suggestions.
- El run trancado (c07a59c3...) quedó marcado FAILED a mano. Los counters de runs matados
  quedan en 0 aunque haya observations escritas (cosmético, engaña al Activity Queue).

## Parte 2 — Seam móvil↔desktop de inspecciones (beta.151 + beta.152, MISMO deploy)

El flujo de inspección móvil (QR handoff, 2026-05-28) escribe en lugares/formas que los
views del desktop y el contrato no leían. TRES caras del mismo seam:

1. **Fotos invisibles en View Inspections** — móvil guarda `photosJson` como ARRAY
   [{key,dataUrl}] con keys snake_case (front_seat/rear_seat/dash); el read path esperaba
   MAPA camelCase. Fix: `inspection-photos-normalize.js` (sin prisma, 8 unit tests,
   `npm run test:inspection-photos`) colapsa formas + alias. Retroactivo, sin migración.
2. **View Check-out/Check-in "Missing"** — ops-view leía líneas RES_CHECKOUT/RES_CHECKIN de
   `reservation.notes` (solo las escribía el wizard viejo). Fix: lee `/inspection-report`
   estructurado con fallback a notes.
3. **Contratos con "-" en Odometer/Fuel Out-In + mileage history saltado** — la cascada del
   wizard-v2 (checkout-session, toStep=CLOSED) NO llama al finalize() clásico: marcaba
   FINALIZED sin copiar métricas de la inspección a las columnas del agreement y sin
   `recordMileageEntry` (gap silencioso de beta.143 en TODOS los checkouts v2). Fix:
   `fuelLevelToFraction()` (FULL/THREE_QUARTERS/... → 0..1); contrato hace coalesce
   columna ?? inspección (select SLIM, nunca photosJson); la cascada copia métricas (solo
   si columna null) + `recordMileageEntrySafe`. El diff de checkout-session fue revisado
   línea a línea por Hector antes del push (cero lógica de cobro tocada).

Ships: `.deploy-notes/2026-06-10-ship-inspection-view-fixes-beta151.sh` (incluye build de
frontend como gate) y `...-ship-contract-inspection-metrics-beta152.sh`.

**LIMITACIONES conocidas / follow-ups:**
- `cleanliness out` sigue "-" en checkouts móviles: la página móvil no lo captura. Feature
  pequeña si se quiere (select en el móvil + write-through).
- Los checkouts v2 YA CERRADOS antes de beta.152 no tienen mileage entries CHECKOUT (el
  contrato sí se arregla retroactivo por el coalesce; el mileage no — sería un backfill
  desde las filas de inspección si Hector lo quiere).
- ~~Smoke UI de beta.151/152 por Hector~~ **HECHO 2026-06-10 PM, todo OK** (contrato v2 con
  valores, fotos móviles visibles, view check-in con datos, agreement viejo intacto).

## Otros del día
- Cron de scraper ya no manda output a /dev/null sin log: todo va a
  `/var/log/ridefleet-scraper/YYYY-MM-DD.log` (+ diag/ con screenshots de fallos).
- `npm run test:rental-agreements` sigue colgándose al correr ambos archivos juntos en el
  Mac de Hector (handle de prisma; los tests pasan por archivo). Gate futuro:
  `--test-force-exit`.
- Hector quiere montar llaves SSH para Cowork (acceso directo a droplets) — sugerido: par
  dedicado revocable; mantener la llave restringida de log-dump para el droplet principal.

## Convenciones que se respetaron
Cowork preparó+verificó (node --check, unit tests, import-graph walk, guards, env-diff);
Hector deployó y revisó el diff del módulo checkout-session antes del push. Ships atómicos
con FILES explícito. Cero migraciones hoy (todo code-only). Cero código de dinero tocado
(el cambio en checkout-session es métricas/mileage en el bloque de status, revisado).

## Parte 3 — Sesión de noche (beta.153/154/155 + Monday)

**Prod pasó a v0.9.0-beta.155** (un build, boot verificado por log-dump). Detalle completo en
CLAUDE.md §Estado de versiones. Resumen: beta.153 = cleanliness en checkout móvil + fix de
redactSensitive(name) + --test-force-exit + script backfill-v2-checkout-mileage; beta.154 =
auditLog de pago manual (reservationId null sobre campo requerido, catch silencioso); beta.155
(MONEY, diff revisado) = **el refund de Auth.Net settled nunca funcionó** — orden de campos del
XML (amount/payment después de refTransId → E00003). Lo destapó el refund de la 904984532861.

**Roadmap centralizado en Monday**: board "Ride Fleet Roadmap" (18417274050) con ~28 items en
6 grupos, specs grandes como updates (fuel charge 1/8s, inspección por el cliente, vehicle
profile trackers, Triangle 35 días, Manuel Shop Orlando, MEX). Sync nocturno 7:30PM FL
(tarea Cowork `monday-roadmap-sync`). Decisión de Hector: features grandes = plan de diseño
con mockups y aprobación ANTES de código (excepto Manuel Shop, que se hace junto en vivo).

**PENDIENTE smoke (Hector)**: refund completo 904984532861 (confirmar credit/void en panel de
Auth.Net), backfill dry-run→--apply, cleanliness en un checkout móvil, fila de auditLog en un
pago manual de prueba.

**Vistos en el log post-deploy (no bloquean)**: 3× 400 en
`POST /payments/reconcile-authorizenet` (22:47, reserva cmo5sq4t2..., probablemente pruebas);
planner snapshot 38s (slow query 33s en RentalAgreementInspection) — el ship untracked
`2026-06-10-ship-planner-snapshot-slim-inspection-photos.sh` sigue pendiente de salir.

**Próximo bloque acordado**: plan de diseño de Fuel Capacity & Fuel Charge (1/8s, MONEY) para
aprobación; después Vehicle Profile pack e Inspección-por-el-cliente.
