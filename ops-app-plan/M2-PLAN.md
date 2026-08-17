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
| M2-H3 · Pago | ADR-5: charge-sale + hold-deposit two-tap, record-manual-* failsafe con reason, poll terminal-status, preview del servidor (ADR-6) con re-confirm en divergencia. **CORREGIDO (2026-08-17):** `charge-sale` y `hold-deposit` **NO** se gatean por `paymentActions` — `money-route-gate.test.mjs:302-315` los fija como *card-present* abiertos a propósito y el test **falla si alguien los gatea** ("Gating them jams the counter", Hector 2026-07-25). La versión anterior de esta fila decía lo contrario y, construida tal cual, habría trabado todos los mostradores. Lo que sí está gateado es mover dinero **sin el cliente presente**. | H1 |
| M2-H4 · Inspección como paso | Integra la captura de M1-H5 como paso INSPECTION_*. | H1 + M1-H5 |
| M2-H5 · Firma y cierre | CUSTOMER_SIGN_PENDING con modo kiosco, customer-signature, cascada a CLOSED, branding vía display-data. | H4 |
| M2-H6 · Reconciliación multi-superficie | UX de presencia, banner de avance ajeno con atribución, matriz 409 completa, adjuntarse a sesión en cualquier paso. Consume P1/P2; si no se aprueban → Plan B (§5). | H1 (+ deploy P1–P3) |
| M2-H7 · Entrada desde cards de H4 | CTA cola checkout → crear/reanudar sesión; guards de creación (422 PRECHECKIN_REQUIRED / AGE_RULES_*, 409 VEHICLE_CONFLICT / SESSION_TERMINAL). | H1 |
| M2-H8 · Backend: CAS en `transition()` | **Obligatoria dentro del M2, prerrequisito de H6** (Innovation, review del PR P1-P3): `updateMany` condicionado por `currentStep` (+ `stateVersion` cuando venga `expectedVersion`), `count===0` → re-leer → STALE_VERSION/ILLEGAL. Cierra el TRANSITION duplicado con dos superficies en el mismo paso, la ventana TOCTOU del assertExpectedVersion, y reduce el lost-update del string `events`. | PR P1-P3 deployado |

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

> **Tanda A APROBADA por Hector (2026-08-17)** y por graphic-design (8 MUST aplicados +
> sincronización de la capa de anotación). Desbloquea H1, H2 y H7. Tanda B (pago) en
> diseño desde el mismo día.

### Bloqueantes de M2-H3 (pago) levantados por la Tanda B — resolver ANTES de construir

1. **Fijar la fuente del desglose y pedir un `previewedAt` del servidor.** Sin una marca
   de cuándo calculó el servidor ese total, la pantalla de divergencia (§13, compuerta de
   release del M2 por ADR-6) no tiene cimiento: no se puede decir "este número es de hace
   4 s" ni detectar que envejeció. Pedido chico de backend.
2. **Confirmar el comportamiento real del backend en el caso 13C** (divergencia entre la
   venta ya cobrada y la garantía: se cobra la diferencia, jamás se reembolsa) **y si la
   consulta post-timeout puede afirmar con certeza "cobró / no cobró"**. Si no puede, el
   copy de §16 tiene que decirlo con esa honestidad.
3. **Pedir `{ code: 'MODULE_ACCESS_DENIED', module }` en el 403 de `requireCapability`**
   → registrado como gap #12. Hoy llega en inglés y sin código: exactamente el mismo mal
   patrón que ya hubo que puentear con el 403 de ubicación (gap #3), y aquí decide si el
   agente ve "no tienes esta capacidad" o un error genérico sobre una pantalla de dinero.
4. **El 409 `DEPOSIT_ALREADY_HELD` NO implica que el paso esté cerrado** (GD, review de la
   Tanda B): el 409 se dispara por `agreement.depositHoldId`, pero lo que avanza el wizard
   es `paymentCompletedAt` en la SESIÓN. Si la garantía la puso otra superficie por otra
   ruta, hay hold y no hay stamp ⇒ la sesión sigue en `PAYMENT_PENDING` y ofrecer
   "Continuar a inspección" chocaría con ADR-4. La pantalla se dibuja desde el
   `currentStep` RE-CONSULTADO, y si el paso no está estampado la única salida verdadera
   es `record-manual-deposit` con su motivo.
5. **`PAYMENT_PENDING` es puerta de un solo sentido** (GD, re-review Tanda B, verificado en
   `state-machine.js`): `FORWARD` no tiene aristas hacia atrás, así que
   `PAYMENT_PENDING → TC_SIGNED` devuelve 409 `ILLEGAL_TRANSITION`. Un rechazo de tarjeta,
   un timeout o una consulta negativa **NO** devuelven la sesión al paso anterior: desde
   ahí se re-cobra sin cambiar de paso. Importa porque el rechazo es el error más
   frecuente del paso: un build que retroceda dispararía un 409 en el camino de error más
   transitado, o pintaría el paso localmente — la copia de la máquina que ADR-4 prohíbe.

### Decisiones de Hector pendientes para el M2 (no bloquean H1/H2)

- **¿RideOps expone "cobrar a la tarjeta guardada" en el M2?** Hoy esa acción vive fuera
  del wizard (`reservations POST /:id/agreement/spin/charge-card-on-file`, gateada por
  `paymentActions`). GD recomienda **no** construirla en H3 y conservar el patrón del 403
  en el sistema de diseño hasta que se consuma de verdad.
- **Copy legal del guardado de tarjeta.** El paso de pago **guarda la tarjeta del cliente
  para cargos posteriores** — verificado en `spin-charge.service.js`: las tres rutas
  tokenizan y persisten `cardOnFileToken`/`cardOnFileLast4` (runSale:763,
  runDepositHold:989, rama pre-pagada:378), y `money-route-gate` llama a ese guardado
  "the ARMING step". Hoy la app lo menciona en una sola pantalla y calla en las otras dos
  donde ocurre igual. El texto que ve el agente —y lo que se le dice al cliente— necesita
  el visto bueno de Hector.

**Corrección del encargo del PM, verificada en código:** `charge-sale` y `hold-deposit`
**NO** están gateados por `paymentActions` (`money-route-gate.test.mjs` los fija como
card-present/record-only abiertos a propósito — "gatearlos trabaría cada checkout"). El
PM había pedido dibujarlos en estado denegado; hacerlo habría producido una app que traba
el mostrador. La §15 muestra en su lugar un mapa de capacidades honesto (un AGENT cobra
igual; lo que no puede es mover dinero **sin el cliente presente**) y usa la única acción
realmente gateada y alcanzable: cobrar a la tarjeta guardada.

### Capacidades ausentes que se vuelven historia propia (GD, review H7)

El mockup de la §11 dibuja CTAs que la app **no puede cumplir hoy**. GD aprobó no
construirlos (un botón muerto es la "falsa puerta" que prohíbe la nota 8) **a condición
de que la app diga dónde vive la acción**. Cuando estas capacidades existan, vuelven los
CTAs de los frames tal cual están dibujados, con su mockup antes de construir:

- **Asignar / cambiar el vehículo de una reserva** — depende de la edición de reserva,
  que es del M3.
- **Ver el contrato** — hoy el PDF vive tras un endpoint con bearer y el stack cerrado
  del ADR-2 no tiene visor ni `url_launcher`. Requiere visor in-app o una URL firmada de
  vida corta. Mientras tanto, 11E muestra el DATO (`autoEmailedAt` → "El contrato salió
  por correo a las 11:04"), que GD calificó como **mejor** que el botón del mockup porque
  responde la pregunta real sin prometer un visor.
- **Chip "En curso · paso N de 10" en la card de la home** (nota 2 del frame 11A) — no es
  construible: `reservationCard` del dashboard **no emite nada de `CheckoutSession`**
  (`employee-app.service.js`). Pedido de backend, no trabajo de cliente.
- **`conflictReservationId` en el 409 `VEHICLE_CONFLICT`** — hoy el número de la otra
  reserva se extrae del TEXTO del mensaje (puente documentado que degrada a "sin botón"
  si el copy cambia). El campo lo cierra de verdad.
- **`send-request-email` no está en `extra-routes.generated.js`** → no aparece en
  `openapi.json`. Endpoint preexistente que la app ahora consume, sin documentar.

### Decisiones registradas durante la construcción (PM)

- **H1 · El rail de fases se pinta desde la POSICIÓN en la cadena, no desde `events[]`**
  — desviación APROBADA de la nota 4 del mockup (que pedía `currentStep` + `events[]`).
  Razón, verificada por Innovation: `FORWARD` es estrictamente lineal
  (`state-machine.js:59-71`) y en todo el backend solo dos sitios escriben `currentStep`
  (el create y `transition()`), así que la posición implica que los pasos anteriores se
  recorrieron. Además es MÁS robusto que `events[]`, que es un TEXT con lost-update
  reconocido (lo cierra H8). `events[]` se sigue usando para la ATRIBUCIÓN ("lo completó
  el kiosco"), que es su fortaleza.
- **H1 · La presencia es ASIMÉTRICA hasta H6: RideOps lee, pero no late.** La app consume
  el `presence` de P1 pero no hace `POST /:id/presence`, así que el mostrador y el kiosco
  **no ven** al agente de RideOps en la sesión. Declarado para que nadie lea el chip como
  "estoy solo, puedo avanzar tranquilo": **la presencia solo puede afirmar presencia,
  jamás soledad** — ni `null` ni `[]` autorizan esa lectura (`withPresence` también
  degrada a `[]` ante error). El heartbeat entra en H6.
- **H1 · Regla de variante del header (canon para H2–H5, confirmada por GD):** completa
  solo cuando el shell ES el contenido (entrada, avance ajeno, skeleton); `mini` en
  cuanto la pantalla tiene cuerpo propio (sheet abierto, offline, y todas las pantallas
  de paso). "Compacta" y "mini" son la MISMA variante — H2 no introduce una tercera
  densidad. El chip de presencia viaja en ambas.

## 4. Gates y SHIP del épico

Por historia: mockup aprobado → build → Innovation + GD en paralelo → fixes → QA SHIP →
merge. DoD §10 completo.

QA de épico (SHIP del M2):
1. Cero divergencias del preview del servidor (ADR-6) — telemetría en 0 en la RC.
2. Compuerta de release de la taxonomía + sesiones-sin-crash.
3. **Prueba de concurrencia real**: RideOps + kiosk en staging sobre la MISMA sesión —
   sin estado corrupto, sin doble cobro, reconciliación visible.
   **Protocolo obligatorio** (QA H1, verificado con sondas, no razonado):
   - a) **Cada aparato observador se queda en el wizard toda la corrida.** No comparar
     "movimientos emitidos" contra "movimientos hechos" cruzando salidas/re-entradas: el
     controller es autoDispose y la primera lectura de cada visita se aplica con
     `detectForeign: false`, así que un movimiento ocurrido con nadie mirando cuenta
     CERO. Es sub-conteo (dirección segura), pero invalida la comparación directa.
   - b) **Una cuenta de usuario DISTINTA por aparato.** No es cosmético: un movimiento
     hecho por tu propia cuenta desde otro aparato se suprime en el camino de poll
     (`actor == you`) pero sí se loguea en el de 409 — si la prueba maneja dos teléfonos
     con una sola cuenta, `via: poll` leerá cero y la corrida parecerá indicar que no
     hubo concurrencia.
   - c) **Corre DESPUÉS de que despliegue el PR P1-P3**: el cinturón de `stateVersion`
     está inerte hasta entonces, y esa prueba es el único lugar donde el camino de
     réplica obsoleta recibe cobertura real.
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
