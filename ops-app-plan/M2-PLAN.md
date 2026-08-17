# Ã‰pico M2 â€” Checkout multi-superficie (plan del PM, 2026-08-17)

> Â§9-1 resuelta por Hector: CONVIVEN las 4 superficies. Wizard server-driven sobre
> `/api/checkout-sessions/*` (router autenticado, nunca el de kiosk). Arranca al cerrar
> H6 (orden de Hector). Verificado contra `checkout-session.service.js` y
> `kiosk-checkout.service.js:745-791`.

## 1. ReconciliaciÃ³n multi-superficie

### 1.1 Solo cliente (sin backend, arranca ya)
- **Poll con wizard abierto**: `GET /:id` cada 5 s (backoff a 15 s tras 3 sin cambio;
  pausa en background). Diff de `currentStep` + los 4 stamps. ADR-4 hace que "avance
  ajeno" = re-render, no caso especial.
- **UX de avance ajeno**: banner no bloqueante + auto-avance del stepper. AtribuciÃ³n
  desde `events[]` (`TRANSITION {actorUserId, metadata:{kiosk:true}}`) â€” "completado en
  el kiosco / por otro agente" sin backend nuevo.
- **Matriz 409 completa**: `ILLEGAL_TRANSITION` ya-en/pasado-toStep â†’ no-op (como el
  wizard web); `ENTRY_GUARD` â†’ re-fetch + mostrar quÃ© falta; `SESSION_TERMINAL` /
  `CHECKOUT_TERMINAL` â†’ pantalla terminal con resumen del events log;
  `VEHICLE_CONFLICT` â†’ CTA a swap. Siempre: re-fetch â†’ re-render. Guard anti-doble-tap
  in-flight en todo botÃ³n de transiciÃ³n.
- **Pre-stamp re-fetch**: antes de cada `stamp`/`transition`, re-fetch si el Ãºltimo poll
  tiene >3 s â€” reduce la ventana del read-then-write de `stampSideEffect`
  (`checkout-session.service.js:621-645`).

### 1.2 Pedidos al backend â€” REQUIEREN APROBACIÃ“N DE HECTOR

| # | Propuesta | Forma | Esfuerzo |
|---|---|---|---|
| **P1 Â· Presencia/claim suave** | Informativa, nunca bloquea. | `POST /api/checkout-sessions/:id/presence` (heartbeat `{surface, label?}`, upsert por `(sessionId, surface, actorUserId)`, TTL 45 s); `GET /:id` agrega `presence: [{surface, displayName, lastSeenAt}]`. | ~1 dÃ­a + tests embedded-postgres |
| **P2 Â· Versioning optimista ligero** | Opt-in y retrocompatible. Cierra la ventana de `stampSideEffect` (gap #5). | `stateVersion Int @default(0)` incrementado en transition/stamp/customer-signature; `expectedVersion?` en esos POST â†’ 409 `STALE_VERSION` con la sesiÃ³n fresca. | ~0.5â€“1 dÃ­a |
| **P3 Â· Endurecer el loop de `sign` del kiosk** | El loop sin transacciÃ³n (`kiosk-checkout.service.js:764-775`) queda a medias si otra superficie transiciona en paralelo â€” riesgo activo con "conviven". | Catch de `ILLEGAL_TRANSITION` dentro del loop â†’ re-fetch â†’ reanudar desde el estado del servidor (walk idempotente); terminal â†’ salir OK. | ~0.5 dÃ­a |
| P4 Â· `idVerifiedAt` en CheckoutSession (gap #4) | **Diferido a M3** salvo que Hector lo quiera en M2. | Columna + stamp. | ~0.5 dÃ­a |

RecomendaciÃ³n PM: aprobar P1+P2+P3 juntos (â‰¤2.5 dÃ­as backend, un solo PR-tren con su
ciclo Innovationâ†’QAâ†’CI verdeâ†’deploy ANTES de que M2-H6 los consuma).

> **APROBADO por Hector (2026-08-17): P1+P2+P3 completos.** P4 diferido a M3. El PR-tren
> arranca de inmediato (en paralelo con M1-H4/H5) para que el deploy tenga margen.

## 2. Historias (una por rama)

| Historia | Contenido | Depende de |
|---|---|---|
| M2-H1 Â· Wizard shell + estado server-driven | Stepper desde `currentStep` (`by-reservation` fuente de verdad), poll base, matriz 409 mÃ­nima, abandon, telemetrÃ­a. Blur de tab bar solo tras seÃ±al de capacidad (compromiso M1â†’M2). | H6 (M1) |
| M2-H2 Â· CONFIRMING â†’ TC | VerificaciÃ³n cliente/vehÃ­culo, declined-insurance, swap, QR terms-token (TTL 15 min, re-mint), poll de tcCompletedAt. | H1 |
| M2-H3 Â· Pago | ADR-5: charge-sale + hold-deposit two-tap, record-manual-* failsafe con reason, poll terminal-status, preview del servidor (ADR-6) con re-confirm en divergencia. Botones gateados por `paymentActions` fail-closed contra la API (record-only no gateado, la UI lo refleja). | H1 |
| M2-H4 Â· InspecciÃ³n como paso | Integra la captura de M1-H5 como paso INSPECTION_*. | H1 + M1-H5 |
| M2-H5 Â· Firma y cierre | CUSTOMER_SIGN_PENDING con modo kiosco, customer-signature, cascada a CLOSED, branding vÃ­a display-data. | H4 |
| M2-H6 Â· ReconciliaciÃ³n multi-superficie | UX de presencia, banner de avance ajeno con atribuciÃ³n, matriz 409 completa, adjuntarse a sesiÃ³n en cualquier paso. Consume P1/P2; si no se aprueban â†’ Plan B (Â§5). | H1 (+ deploy P1â€“P3) |
| M2-H7 Â· Entrada desde cards de H4 | CTA cola checkout â†’ crear/reanudar sesiÃ³n; guards de creaciÃ³n (422 PRECHECKIN_REQUIRED / AGE_RULES_*, 409 VEHICLE_CONFLICT / SESSION_TERMINAL). | H1 |
| M2-H8 Â· Backend: CAS en `transition()` | **Obligatoria dentro del M2, prerrequisito de H6** (Innovation, review del PR P1-P3): `updateMany` condicionado por `currentStep` (+ `stateVersion` cuando venga `expectedVersion`), `count===0` â†’ re-leer â†’ STALE_VERSION/ILLEGAL. Cierra el TRANSITION duplicado con dos superficies en el mismo paso, la ventana TOCTOU del assertExpectedVersion, y reduce el lost-update del string `events`. | PR P1-P3 deployado |

ParalelizaciÃ³n: H1 primero â†’ H2 âˆ¥ H3 âˆ¥ H7 â†’ H4 â†’ H5. H6 parte cliente tras H1, cierra
al final. El PR-tren de backend corre en paralelo a H2/H3 apenas Hector apruebe.

## 3. Mockups (graphic-design â†’ aprobaciÃ³n de Hector ANTES de construir)

- **Tanda A** (bloquea H1/H2/H7): shell del wizard (stepper, header de sesiÃ³n, offline),
  paso CONFIRMING, paso T&C con QR + countdown, entrada desde card con estados de guard.
- **Tanda B** (bloquea H3): pago â€” two-tap, estado del terminal, failsafe manual,
  capability-denegada, y la pantalla de divergencia de preview (ADR-6).
- **Tanda C** (bloquea H5/H6): firma/cierre en kiosco, reconciliaciÃ³n â€” chip de
  presencia, banner "otra superficie completÃ³ este paso", terminal/cancelado.

Tanda A se encarga de inmediato al cerrar H6; B y C durante la construcciÃ³n de H1.

## 4. Gates y SHIP del Ã©pico

Por historia: mockup aprobado â†’ build â†’ Innovation + GD en paralelo â†’ fixes â†’ QA SHIP â†’
merge. DoD Â§10 completo.

QA de Ã©pico (SHIP del M2):
1. Cero divergencias del preview del servidor (ADR-6) â€” telemetrÃ­a en 0 en la RC.
2. Compuerta de release de la taxonomÃ­a + sesiones-sin-crash.
3. **Prueba de concurrencia real**: RideOps + kiosk en staging sobre la MISMA sesiÃ³n â€”
   sin estado corrupto, sin doble cobro, reconciliaciÃ³n visible.
4. Dinero: jamÃ¡s encolado; idempotencia dentro del intento vivo probada con corte de
   red; `paymentActions` fail-closed contra la API.
5. Matriz 409 en toda pantalla; openapi.json diffeado + fixtures si P1â€“P3 entraron.

Post-deploy: agente `training` (paso 7) â€” tutorial PDF en espaÃ±ol reusando mockups.

## 5. Riesgos

| Riesgo | MitigaciÃ³n |
|---|---|
| Dinero en Wi-Fi de patio | SÃ­ncrono foreground + timeout honesto; en timeout NUNCA auto-reintento de autorizaciÃ³n: `GET /:id` + `terminal-status` primero; jamÃ¡s reproducir autorizaciÃ³n despuÃ©s (ADR-5). |
| 4 superficies pisÃ¡ndose | Poll + matriz 409 + re-render; P1/P2 reducen ventanas; P3 cierra el hueco gordo del kiosk. |
| TTL del terms-token | Mint idempotente reusa >2 min; countdown + re-emisiÃ³n one-tap. |
| P1â€“P3 no aprobados â†’ Plan B | H6 degrada sin caerse: avance ajeno por poll + atribuciÃ³n de events[] (sin nombre en vivo); pre-stamp re-fetch; el loop del kiosk queda como known issue documentado en QA (exposiciÃ³n pre-existente, no bloquea el SHIP de RideOps). |
| paymentActions ausente | Fail-closed verificado contra la API; failsafes manuales visibles. |

**Primer paso al cerrar H6:** (a) graphic-design â†’ Tanda A, (b) PR-tren P1â€“P3 si Hector
aprueba. H1 arranca con la Tanda A aprobada.
