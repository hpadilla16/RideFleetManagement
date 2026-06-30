# RFM — Session handoff (para continuar en otra máquina, p.ej. MacBook)

Este documento le da contexto completo a una sesión nueva de Claude/Cowork para retomar el trabajo de Ride Fleet Manager (RFM) tal como lo veníamos haciendo.

## 1. Qué es el proyecto
- **RFM (Ride Fleet Manager):** SaaS multi-tenant de renta de autos. Stack: **Node 22 + Express + Prisma 6 + Postgres** (Supabase pooler), **Next.js 14** (frontend), **docker-compose.prod.yml** en un droplet.
- **Repo:** `github.com/hpadilla16/RideFleetManagement`
- **Rama de trabajo:** `release/deposit-balance-fix-beta119` (TODO se commitea aquí, no a main).
- **Esquema de tags:** `v0.9.0-beta.N`. **Último desplegado: `v0.9.0-beta.272`** (incluye todo lo de las sesiones recientes).
- **Sub-tenant principal en prod:** `rent-by-vphmotors` (Zezgo). App admin en `https://ridefleetmanager.com`.

## 2. Cómo ponerse al día en la Mac (setup)
```bash
# clonar y traer lo último
git clone https://github.com/hpadilla16/RideFleetManagement.git
cd RideFleetManagement
git checkout release/deposit-balance-fix-beta119
git pull --ff-only
git config user.email "hpadilla160123@gmail.com"
git config user.name "Hector Padilla"

# backend / frontend deps (Node 22)
cd backend && npm ci && cd ../frontend && npm ci && cd ..
```
- **PAT de GitHub:** para hacer push hay que usar un Personal Access Token. **Pídeselo a Hector** (no está en el repo). Push con: `git push https://hpadilla16:<PAT>@github.com/hpadilla16/RideFleetManagement.git <rama|tag>`.
- **Para leer el estado completo:** lee `doc/platform-audit-and-roadmap-2026-06-29.md` (el plan/roadmap), `CLAUDE.md` (workflow obligatorio) y `.claude/agents/*.md` (los agentes).

## 3. Flujo de trabajo OBLIGATORIO (multi-agente)
Definido en `CLAUDE.md` + `.claude/agents/`. EN CADA tarea no-trivial:
1. **Project Manager** (el asistente principal orquesta): aclara meta + criterios, decide qué agentes usar, plan ordenado con gates.
2. **Build** en un clone limpio. Para UI nueva/rediseño: **mockup aprobado por Hector ANTES de construir**.
3. **Review en paralelo:** agente **Innovation** (mejor enfoque vs. código + industria) + **Graphic Design** si toca UI. Cambios MUST-CHANGE vuelven al PM.
4. **QA gate:** el agente **Quality Assurance** debe devolver **SHIP** (sin BLOCKER/MAJOR) antes de deploy. Verifica correctness, regresión, cobertura, seguridad financiera/datos.
5. **Deploy** solo tras SHIP: push tag → CI verde → Hector despliega (o se le da el comando).
6. **Training:** si afecta a un empleado/admin, el agente **training** genera un PDF tutorial a `training/` (español, branded) y actualiza `training/INDEX.md`. Reusa fotos reales si están en `training/assets/screenshots/<módulo>/`.
- Para cambios puramente mecánicos (ej. externalizar strings i18n) se puede saltar Innovation/GD y ir build → QA → ship.

## 4. Convenciones de build / test / deploy
- **Edición segura:** históricamente la herramienta Edit/Write corrompía archivos en el mount de Windows (`C:\Projects`), por eso se editaba en un clone `/tmp/rfm` con python/bash y se copiaba al mount. **En Mac/Linux esto probablemente no aplica** — verifica; si Edit/Write funcionan bien sobre el repo, úsalas directo. El patrón seguro igual sirve: editar en el clone, testear, luego commitear.
- **Tests DB-backed (embedded-postgres):** muchos `*.test.mjs` necesitan Postgres. Patrón: `npm install --no-save embedded-postgres` → bootear PG en un puerto → `export DATABASE_URL=...` → `npx prisma db push --skip-generate --accept-data-loss` → `npx prisma generate` → `node --test ...`. (En Mac, embedded-postgres baja un binario de PG; si falla, usar un Postgres local/Docker y exportar DATABASE_URL.)
- **CI = `.github/workflows/beta-ci.yml`:** corre `frontend-build` (npm ci + next build), `backend-check` (npm ci + prisma generate + node --check + import-resolve), y `tenant-isolation-suite` (docker compose). **OJO: CI NO corre `npm test`** todavía (está en el plan agregarlo). La suite de aislamiento tarda ~8-10 min.
- **package.json ↔ package-lock.json:** si tocas dependencias, **regenera el lockfile** (`npm install`/`--package-lock-only`) o `npm ci` falla en CI (ya nos pasó con `pg` y con `eslint-plugin-i18next`).
- **Ver CI vía API GitHub** (con el PAT): `GET api.github.com/repos/hpadilla16/RideFleetManagement/actions/runs?per_page=5`.
- **Deploy en el droplet** (Hector lo corre):
```
cd ~/RideFleetManagement
git fetch origin --tags && git checkout v0.9.0-beta.<N>
docker compose -f docker-compose.prod.yml build backend frontend
docker compose -f docker-compose.prod.yml up -d --force-recreate backend frontend worker
```
Reconstruir `worker` cuando haya schedulers; migraciones aditivas/idempotentes se aplican solas al bootear (AUTO_MIGRATE_ON_BOOT).
- **Seguridad operativa:** no ejecutar reembolsos/cobros reales (mueven dinero en la tarjeta del cliente) — eso lo hace Hector; no modificar permisos ni saltarse gates.

## 5. Estado actual — qué ya se hizo (reciente) y qué sigue
**Desplegado (beta.272 incluye todo):**
- **i18n batch 1:** fundación (EN default + lint `eslint-plugin-i18next`) + AppShell y Dashboard 100% en ES (200 llaves EN/ES).
- **P0 seguridad batch 1:** Customers fail-closed; rate-limit con `req.ip`/trust proxy (no XFF spoof); no se loguea `DATABASE_URL`.
- **Fixes de facturación (RES-849093):** toll sin identificador no se auto-asigna + requiere identificador fuerte para auto-confirm; void de toll marca la transacción VOID (se mantiene); paquete waivea tolls; crédito unificado a línea ADMIN_CORRECTION visible/anulable (rutas viejas de crédito → 410).
- (Antes) fuel/odómetro correction, void-payment-no-refund, auto-email de pre-check-in, emails branded unificados, pre-check-in redesign, etc.

**Sistema de Training:** agente `training` + carpeta `training/` (PDFs locales, gitignored) + INDEX. Ya hay PDFs (dashboard, corrección fuel/odómetro, void-no-refund).

**Orden del plan acordado por Hector** (ver el roadmap doc):
1. **i18n** — EN completo + ES en TODA la app (batch 1 hecho; faltan batches: Reservations → Customers/Planner → Reports → **Settings** (el grande) → resto).
2. **P0 seguridad** — batch 1 hecho; **falta batch 2: atar pagos/checkout al tenant** (`payment-gateway` charge/void/refund, `checkout-session`/`spin-charge`, telematics upsert) + extensión Prisma que auto-inyecta tenantId + lint anti-`id`-pelado. **Esto es lo siguiente recomendado.**
3. **Planner** (rediseño board-first + perf) — antes que la app de empleado.
4. **Employee App** nativa (Capacitor ya está; tablet + lector; rol de cobro = OPS).
5. **Kiosk Mode** = módulo NUEVO vendible, gated como Market Intelligence/Tolls, con Settings propio (incluye cobertura mínima de seguro). Diseño detallado en el roadmap (self-checkout: ID+selfie, seguro auto-aprobado, upsell, pago+depósito, QR+PIN de llave, bot IA).
6. Quick-wins intercalados: **dark-mode** (checklist concreto en el roadmap), **Quotes** module, fundación de diseño (tokens), CI corre `npm test`, atomicidad del doble-ledger, blobs base64 → storage.

## 6. Decisiones fijas de Hector
- Kiosk hardware = **tablet + lector**; el rol que cobra corre como **OPS**.
- Kiosk Mode = **add-on vendible** (entitlement por tenant, como tolls/market-intelligence) con página de Settings para configurarlo todo.
- **Planner antes** que la Employee App.
- i18n primero pero **por batches** (la traducción completa toma tiempo; se intercala con el resto).
- "Anything that is reimagining needs mockups and Hector's approval first." Usar todos los agentes y el QA en todo.

## 7. Primer paso sugerido para la sesión en la Mac
Saludar a Hector, confirmar acceso (pedir el PAT), `git pull` de la rama, leer este doc + `CLAUDE.md` + el roadmap, y preguntar si retoma por el **batch 2 de P0 seguridad (pagos/checkout tenant-binding)** o por otra prioridad del plan. Seguir SIEMPRE el flujo multi-agente con QA antes de cualquier deploy.
