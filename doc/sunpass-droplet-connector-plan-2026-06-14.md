# SunPass connector — patrón droplet (DESACOPLADO de AutoExpreso). Plan 2026-06-14

DECISIÓN (Hector, 2026-06-14): el conector de **SunPass/E-PASS (Florida)** va por el
**patrón droplet + ingest** (opción "b"), NO dentro del worker. Regla rectora: **un
conector no puede depender de otro** — el timing/fallo de uno no debe afectar al otro.

## Por qué (b) y no extender el sweep del worker
- El sweep automático de peajes vive en el worker (`tolls.scheduler.js` →
  `tollsService.runAutomaticSyncSweep`) y **hoy filtra `provider: 'AUTOEXPRESO'`** — recorre
  las cuentas AutoExpreso **secuencialmente** sobre el Chromium único (cap global
  `PUPPETEER_MAX_CONCURRENT_PAGES=2`). SunPass NO está en ese sweep (solo corre manual).
- Si metiéramos SUNPASS al mismo sweep, cada ciclo haría PR y *luego* FL secuencial en el
  mismo proceso → **el tiempo de uno suma al del otro** y compiten por el navegador. Eso es
  justo lo que Hector quiere evitar.
- Consistente con la **decisión de topología de la auditoría** (2026-06-12): *scraping pesado
  AFUERA (droplet), producto adentro (prod + Supabase)*.

## Arquitectura
**Capa de PRODUCTO (nativa en prod, sin cambios al matching):**
- **`POST /api/internal/tolls/ingest`** (beta.165, YA construido) — token interno compartido
  (`BACKEND_INTERNAL_TOKEN`). Body `{ tenantId, rows:[...], sourceType?, importMeta? }`.
  Reusa el pipeline EXISTENTE `createManualTransactions`: dedup por `externalId`, match por
  placa/tag/sello + timestamp dentro de la ventana de renta (`buildMatchSuggestion`),
  asignación, y `syncReservationTollCharges` para los matched. Exige `tollsEnabled`.
- AutoExpreso (PR) se queda EXACTAMENTE como está en el worker. Independiente.

**Capa de INGESTIÓN (droplet `ridefleet-scraper-prod`, 138.197.27.209):**
- Adapter SunPass (Python, patrón citations/pricing): login a sunpass.com (creds en el `.env`
  del droplet para el piloto) → Activity → **export Spreadsheet** del rango desde el último
  sync → parse → filas normalizadas → push a `/api/internal/tolls/ingest`. `flock` + splay +
  schedule propio (ventana independiente de AutoExpreso). El droplet es un **productor tonto**.

## Contrato de fila (lo que empuja el droplet)
`{ transactionAt (ISO o parseable), plate?, tag? (=transponder), sello?, amount (>0),
  location?, lane?, direction?, externalId (clave de dedup), transactionTimeRaw? }`
- **`externalId` = clave idempotente**: id de transacción de SunPass si existe; si no,
  componer `transponder|timestamp-al-segundo|plaza|monto`. Sin externalId estable no hay dedup
  → duplicados en re-corridas.
- **Match**: el backend amarra por `plateNormalized` (placa) o `tagNormalized`/`selloNormalized`
  (el `Vehicle.tollTagNumber`/`tollStickerNumber`) + timestamp en `[pickupAt, returnAt]`.
  Por eso el droplet debe incluir placa Y/O transponder por fila.

## Transponder → placa
SunPass "Transponders and Vehicles" da el mapeo transponder→placa (601 placas / 564
transponders en la cuenta 91002658). El droplet puede (a) incluir la placa en cada fila
resolviendo el mapeo en el scrape, o (b) mandar solo el transponder (`tag`) y dejar que el
backend matchee por `tollTagNumber`. Recomendado (a) cuando la Activity ya trae la placa;
si no, refrescar el mapeo periódicamente y resolver en el droplet.

## E-PASS / CFX (408/417/528/429) — GAP a decidir
Hoy solo existen los providers `AUTOEXPRESO` y `SUNPASS`. **E-PASS (CFX) no es un provider
aparte.** SunPass y E-PASS son interoperables pero NO todas las transacciones E-PASS
aparecen en la cuenta SunPass. Opciones: (1) confirmar en vivo si la Activity de SunPass
incluye los peajes CFX; si sí, basta SunPass. (2) Si no, un **segundo adapter E-PASS** en el
droplet que empuja al mismo `/ingest` con `sourceType:'EPASS_SYNC'` (y, si queremos trackear
provider por fila, añadir el enum `EPASS`). PENDIENTE: recon del E-PASS antes de decidir.

## ⚠️ Nota de dinero (parity, NO cambio nuevo)
El ingest reusa `syncReservationTollCharges` igual que el manual-import del staff que YA
existe: un peaje matched postea al `RentalAgreement.balance` (no captura tarjeta, solo
balance). No es una vía de dinero nueva — es la misma del manual-import — pero es
money-adjacent → **Hector revisa la parity** antes de activar el auto-push. El adapter puede
arrancar en modo "solo importa, no postea" si se prefiere (sourceType distinto + flag).

## Multi-tenant / plug-and-play (igual que citations)
- Gate doble: `tollsEnabled` (settings) + `TollProviderAccount` provider=SUNPASS activo
  (= "tenemos el servicio"). El ingest ya exige `tollsEnabled`.
- Piloto = UNA cuenta (corpus / ZEZGO Orlando 91002658) con creds en el `.env` del droplet.
- Follow-up multi-tenant: endpoint interno que enumere los tenants con SUNPASS activo +
  distribución segura de creds (o perfiles por tenant en el droplet), espejo del discovery
  por-source de citations. OJO seguridad: mover creds de login al droplet es una decisión a
  revisar (hoy AutoExpreso desencripta in-worker; el droplet implicaría que las creds crucen).

## Fases
- **A. Backend ingest** — HECHO (beta.165): `/api/internal/tolls/ingest` + mount.
- **B. Adapter SunPass en el droplet** — needs recon en vivo del export de Activity (formato
  de columnas), igual que el `parse_results` de CPC se clava con un dump real. Estructura:
  login → activity → export → parse → push.
- **C. Refresh del mapeo transponder→placa**.
- **D. (opc.) Adapter E-PASS/CFX** al mismo ingest.
- **E. Multi-tenant**: discovery + creds.

## Ship / deploy
- `.deploy-notes/2026-06-14-ship-tolls-internal-ingest-beta165.sh` (backend, code-only, sin
  migración). AutoExpreso intacto. Verify post-deploy: `/api/internal/tolls/ingest` → 401 sin
  token (montado) y el sweep de AutoExpreso sigue corriendo en el worker.
