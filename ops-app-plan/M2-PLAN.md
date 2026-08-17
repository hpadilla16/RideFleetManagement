# Épico M2 — Checkout multi-superficie (plan del PM, 2026-08-17)

> §9-1 resuelta por Hector: CONVIVEN las 4 superficies. Wizard server-driven sobre
> `/api/checkout-sessions/*` (router autenticado, nunca el de kiosk). Arranca al cerrar
> H6 (orden de Hector). Verificado contra `checkout-session.service.js` y
> `kiosk-checkout.service.js:745-791`.

## 1. Reconciliación multi-superficie

### 1.1 Solo cliente (sin backend, arranca ya)
- **Poll con wizard abierto**: `GET /:id` cada 5 s (backoff a 15 s tras 3 sin cambio;
  pausa en background). Diff de `currentStep` + los 4 stamps. ADR-4 hace que "avance
  ajeno" = re-render, no caso especial.
- **UX de avance ajeno**: banner no bloqueante + auto-avance del stepper. Atribución
  desde `events[]` (`TRANSITION {actorUserId, metadata:{kiosk:true}}`) — "completado en
  el kiosco / por otro agente" sin backend nuevo.
- **Matriz 409 completa**: `ILLEGAL_TRANSITION` ya-en/pasado-toStep → no-op (como el
  wizard web); `ENTRY_GUARD` → re-fetch + mostrar qué falta; `SESSION_TERMINAL` /
  `CHECKOUT_TERMINAL` → pantalla terminal con resumen del events log;
  `VEHICLE_CONFLICT` → CTA a swap. Siempre: re-fetch → re-render. Guard anti-doble-tap
  in-flight en todo botón de transición.
- **Pre-stamp re-fetch**: antes de cada `stamp`/`transition`, re-fetch si el último poll
  tiene >3 s — reduce la ventana del read-then-write de `stampSideEffect`
  (`checkout-session.service.js:621-645`).

### 1.2 Pedidos al backend — REQUIEREN APROBACIÓN DE HECTOR

| # | Propuesta | Forma | Esfuerzo |
|---|---|---|---|
| **P1 · Presencia/claim suave** | Informativa, nunca bloquea. | `POST /api/checkout-sessions/:id/presence` (heartbeat `{surface, label?}`, upsert por `(sessionId, surface, actorUserId)`, TTL 45 s); `GET /:id` agrega `presence: [{surface, displayName, lastSeenAt}]`. | ~1 día + tests embedded-postgres |
| **P2 · Versioning optimista ligero** | Opt-in y retrocompatible. Cierra la ventana de `stampSideEffect` (gap #5). | `stateVersion Int @default(0)` incrementado en transition/stamp/customer-signature; `expectedVersion?` en esos POST → 409 `STALE_VERSION` con la sesión fresca. | ~0.5–1 día |
| **P3 · Endurecer el loop de `sign` del kiosk** | El loop sin transacción (`kiosk-checkout.service.js:764-775`) queda a medias si otra superficie transiciona en paralelo — riesgo activo con "conviven". | Catch de `ILLEGAL_TRANSITION` dentro del loop → re-fetch → reanudar desde el estado del servidor (walk idempotente); terminal → salir OK. | ~0.5 día |
| P4 · `idVerifiedAt` en CheckoutSession (gap #4) | **Diferido a M3** salvo que Hector lo quiera en M2. | Columna + stamp. | ~0.5 día |

Recomendación PM: aprobar P1+P2+P3 juntos (≤2.5 días backend, un solo PR-tren con su
ciclo Innovation→QA→CI verde→deploy ANTES de que M2-H6 los consuma).

> **APROBADO por Hector (2026-08-17): P1+P2+P3 completos.** P4 diferido a M3. El PR-tren
> arranca de inmediato (en paralelo con M1-H4/H5) para que el deploy tenga margen.

## 2. Historias (una por rama)

| Historia | Contenido | Depende de |
|---|---|---|
| M2-H1 · Wizard shell + estado server-driven | Stepper desde `currentStep` (`by-reservation` fuente de verdad), poll base, matriz 409 mínima, abandon, telemetría. Blur de tab bar solo tras señal de capacidad (compromiso M1→M2). | H6 (M1) |
| M2-H2 · CONFIRMING → TC | Verificación cliente/vehículo, declined-insurance, swap, QR terms-token (TTL 15 min, re-mint), poll de tcCompletedAt. | H1 |
| M2-H3 · Pago | ADR-5: charge-sale + hold-deposit two-tap, record-manual-* failsafe con reason, poll terminal-status, preview del servidor (ADR-6) con re-confirm en divergencia. Botones gateados por `paymentActions` fail-closed contra la API (record-only no gateado, la UI lo refleja). | H1 |
| M2-H4 · Inspección como paso | Integra la captura de M1-H5 como paso INSPECTION_*. | H1 + M1-H5 |
| M2-H5 · Firma y cierre | CUSTOMER_SIGN_PENDING con modo kiosco, customer-signature, cascada a CLOSED, branding vía display-data. | H4 |
| M2-H6 · Reconciliación multi-superficie | UX de presencia, banner de avance ajeno con atribución, matriz 409 completa, adjuntarse a sesión en cualquier paso. Consume P1/P2; si no se aprueban → Plan B (§5). | H1 (+ deploy P1–P3) |
| M2-H7 · Entrada desde cards de H4 | CTA cola checkout → crear/reanudar sesión; guards de creación (422 PRECHECKIN_REQUIRED / AGE_RULES_*, 409 VEHICLE_CONFLICT / SESSION_TERMINAL). | H1 |

Paralelización: H1 primero → H2 ∥ H3 ∥ H7 → H4 → H5. H6 parte cliente tras H1, cierra
al final. El PR-tren de backend corre en paralelo a H2/H3 apenas Hector apruebe.

## 3. Mockups (graphic-design → aprobación de Hector ANTES de construir)

- **Tanda A** (bloquea H1/H2/H7): shell del wizard (stepper, header de sesión, offline),
  paso CONFIRMING, paso T&C con QR + countdown, entrada desde card con estados de guard.
- **Tanda B** (bloquea H3): pago — two-tap, estado del terminal, failsafe manual,
  capability-denegada, y la pantalla de divergencia de preview (ADR-6).
- **Tanda C** (bloquea H5/H6): firma/cierre en kiosco, reconciliación — chip de
  presencia, banner "otra superficie completó este paso", terminal/cancelado.

Tanda A se encarga de inmediato al cerrar H6; B y C durante la construcción de H1.

## 4. Gates y SHIP del épico

Por historia: mockup aprobado → build → Innovation + GD en paralelo → fixes → QA SHIP →
merge. DoD §10 completo.

QA de épico (SHIP del M2):
1. Cero divergencias del preview del servidor (ADR-6) — telemetría en 0 en la RC.
2. Compuerta de release de la taxonomía + sesiones-sin-crash.
3. **Prueba de concurrencia real**: RideOps + kiosk en staging sobre la MISMA sesión —
   sin estado corrupto, sin doble cobro, reconciliación visible.
4. Dinero: jamás encolado; idempotencia dentro del intento vivo probada con corte de
   red; `paymentActions` fail-closed contra la API.
5. Matriz 409 en toda pantalla; openapi.json diffeado + fixtures si P1–P3 entraron.

Post-deploy: agente `training` (paso 7) — tutorial PDF en español reusando mockups.

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| Dinero en Wi-Fi de patio | Síncrono foreground + timeout honesto; en timeout NUNCA auto-reintento de autorización: `GET /:id` + `terminal-status` primero; jamás reproducir autorización después (ADR-5). |
| 4 superficies pisándose | Poll + matriz 409 + re-render; P1/P2 reducen ventanas; P3 cierra el hueco gordo del kiosk. |
| TTL del terms-token | Mint idempotente reusa >2 min; countdown + re-emisión one-tap. |
| P1–P3 no aprobados → Plan B | H6 degrada sin caerse: avance ajeno por poll + atribución de events[] (sin nombre en vivo); pre-stamp re-fetch; el loop del kiosk queda como known issue documentado en QA (exposición pre-existente, no bloquea el SHIP de RideOps). |
| paymentActions ausente | Fail-closed verificado contra la API; failsafes manuales visibles. |

**Primer paso al cerrar H6:** (a) graphic-design → Tanda A, (b) PR-tren P1–P3 si Hector
aprueba. H1 arranca con la Tanda A aprobada.
