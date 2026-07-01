# RFM — Session handoff (para continuar en otra máquina, p.ej. MacBook)

Este documento le da contexto completo a una sesión nueva de Claude/Cowork para retomar el trabajo de Ride Fleet Manager (RFM) tal como lo veníamos haciendo.

## 1. Qué es el proyecto
- **RFM (Ride Fleet Manager):** SaaS multi-tenant de renta de autos. Stack: **Node 22 + Express + Prisma 6 + Postgres** (Supabase pooler), **Next.js 14** (frontend), **docker-compose.prod.yml** en un droplet.
- **Repo:** `github.com/hpadilla16/RideFleetManagement`
- **Rama de trabajo:** `release/deposit-balance-fix-beta119` (TODO se commitea aquí, no a main).
- **Esquema de tags:** `v0.9.0-beta.N`. **Último desplegado: `v0.9.0-beta.276`** (ver sección ACTUALIZACIÓN 2026-07-01 al final).
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

---

## ACTUALIZACIÓN 2026-07-01 — Migración de blobs a Supabase Storage (+ incidente y endurecimiento)

**Último tag desplegado: `v0.9.0-beta.276`.** Rama sigue siendo `release/deposit-balance-fix-beta119`.

### Qué se hizo (por qué el disco estaba al 84%)
La DB estaba ~6.1 GB, ~94% eran blobs base64 en columnas Postgres. Se migraron a **Supabase Storage** (buckets privados) y se recuperó el disco con `VACUUM FULL`. Resultado: **DB 6.1 GB → ~312 MB**.

- **Customer/agreement docs** (`Customer.idPhotoUrl`, `licenseBackUrl`, `insuranceDocumentUrl`, `RentalAgreement.insuranceDocumentUrl`) → bucket **`customer-documents`**. Migrados con verificación byte-a-byte. **Intactos y verificados.**
- **Fotos de inspección** (`RentalAgreementInspection.photosJson`) → bucket **`inspection-photos`** (`photoStorageRefs`).

### Betas de esta tanda
- **beta.273** — migración customer-docs (helper `customer-documents.js`, serve con signed URL, write flag `CUSTOMER_DOCS_STORAGE_ENABLED`, backfill con read-back verify). Ships dark.
- **beta.274** — backfills a escala de producción (descubrimiento por SQL solo-IDs, fila por fila, resumible) — arregla timeout 57014; + fix Prisma `DbNull` en backfill de inspección.
- **beta.275** — ENDURECIMIENTO post-incidente: `decodePhotoValue` rechaza no-strings + valida magic header; maneja los 3 formatos reales de `photosJson`; **verificación byte-a-byte OBLIGATORIA** en backfill y en writes vivos (customer + inspección) con fallback a base64; `clear` nunca borra sin read-back en vivo.
- **beta.276** — UI: ver documentos KYC en la página de reserva (endpoints on-demand `GET /customers/:id/{id-photo,insurance-doc,license-back}`, auth + tenant-scoped, signed URL, nunca devuelven el path crudo) + fix de CSS (fotos de inspección se salían de la tarjeta por `styled-jsx` scoped).

### INCIDENTE (importante — lección aprendida)
El primer backfill de inspección subió **basura de 9 bytes** para el formato `photosJson` de **array-de-objetos** `[{key,dataUrl}]` (el helper hacía `String(objeto)` → `"[object Object]"` → base64 basura) y, como NO verificaba byte-a-byte, el paso `clear` + `VACUUM FULL` borró los originales. **Se perdieron 13 fotos de inspección creadas ese día** (no estaban en el backup de 12:02 UTC y PITR no estaba activo). Hector decidió que las fotos no importaban (solo los agreements, que quedaron 100% intactos).
**Reglas permanentes que salieron de esto (ya implementadas en beta.275):** (1) nunca borrar/sobreescribir el original hasta confirmar el objeto en Storage con verificación byte-a-byte; (2) validar magic header de imagen en origen; (3) probar contra formatos REALES, no sintéticos; (4) **PITR debe estar activo** antes de cualquier migración destructiva.

### Estado actual de producción (verificar en el droplet)
- **PITR: ACTIVADO** (se activó durante el incidente). Mantener activo.
- **Disco:** ~312 MB de 12 GB (Supabase auto-escaló a 12 GB durante el incidente; no baja solo).
- **Buckets privados:** `customer-documents`, `inspection-photos` (+ customer-signatures, payment-receipts, inventory-photos ya existían).
- **Flags en `.env` del droplet:**
  - `SUPABASE_STORAGE_CUSTOMER_DOCS_BUCKET=customer-documents`
  - `INSPECTION_PHOTOS_STORAGE_ENABLED` — **ON** (confirmado: inspección nueva RES-183691 subió a Storage con objetos reales ~82 KB).
  - `CUSTOMER_DOCS_STORAGE_ENABLED` — **VERIFICAR**: si subidas nuevas de docs de cliente siguen guardándose como base64 en la DB, ponerlo en `true` (ya es seguro: el write vivo verifica y cae a base64 si falla).
- **Supabase MCP** conectado (proyecto `mmrkgjavuofgkdvlkfgg`, "ridefleetmanager"). Agente nuevo **`supabase-dba`** (`.claude/agents/supabase-dba.md`) para análisis de DB read-only.

### Pendientes OPCIONALES (sin urgencia; disco ya mínimo)
- Re-migrar fotos de inspección viejas con el backfill endurecido (seguro, por lotes) — solo si se quieren en Storage.
- Limpieza cosmética: 316 inspecciones tienen refs a objetos basura de 9 bytes (miniaturas rotas/vacías) → anular esos `photoStorageRefs` y borrar los objetos.
- Reintentar ~8 campos de customer + 1 inspección que fallaron verificación (siguen en base64, intactos; re-correr backfill es idempotente).
- CI no corre `npm test` (los `*.embedded.test.mjs` son la suite autoritativa de los backfills) — agregar un job.

### Nota para la Mac
El working tree de `C:\Projects\RideFleetManagement` en la PC estaba **45 commits atrás** del remoto (se le copiaban archivos sin hacer pull/commit). En la Mac: **clona fresco** o haz `git pull --ff-only` de `release/deposit-balance-fix-beta119` para arrancar al día (HEAD debe ser beta.276).
