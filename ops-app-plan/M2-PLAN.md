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

### 1.3 Pedidos nuevos levantados al construir H2 (chicos, ninguno bloquea el build)

Los tres salen de que el cliente tuvo que **suplir** algo que el servidor sabe y no dice.
Ninguno frena a H2, pero cada uno deja una fragilidad escrita en el cliente.

| # | Pedido | Por qué lo pide el cliente hoy |
|---|---|---|
| **P5 · URL absoluta en `POST /:id/terms-token`** | Que la respuesta traiga la URL de firma completa, como ya hace `APP_BASE_URL` para todos los demás enlaces. | Sin ella el QR se arma con `RIDEOPS_WEB_BASE` compilado por dart-define: **un inquilino con dominio propio necesitaría otro build de la app**. |
| **P6 · 409 al tocar el seguro después del sello** | Que `declined-insurance` responda 409 cuando ya hay `tcCompletedAt`. | Verificado: hoy el backend **no** tiene guard ahí, y `terms-signing` calcula las secciones con el valor del momento de firma. El cliente cierra el switch por su cuenta — es una regla de negocio viviendo en la app, justo lo que ADR-4 prohíbe. |
| **P7 · Exponer `agreement.declinedInsurance` en display-data** | Que el estado del seguro venga como campo, no deducido. | `getById` no lo incluye, así que el cliente **deriva el estado leyendo `events[]`** — un TEXT con lost-update (que H8 apenas mitiga). Es el dato más frágil de todo el paso. |

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
- **Lámina delta de H2** (`mockups/m2-delta-h2.html`) — tres estados que no existen en el
  mockup aprobado: la tarjeta de cliente "no se pudo leer" (D1), el mensaje del servidor
  presentado como cita (D2) y el pill `Actual` en la unidad inerte (D3, propuesta pura).
  El build de esos tres está DETENIDO hasta la aprobación; el resto del lote de H2 sigue.
- **Copy de la consecuencia del rechazo de seguro (GD SC-6).** La copy aprobada solo
  promete que "se adjunta un anexo": un agente explicándoselo al cliente en el patio no
  tiene con qué. GD propone decir que los daños quedan a cargo del cliente. **Cambia copy
  ya aprobada y afirma alcance legal** — necesita tu visto bueno y confirmación de qué
  cubre realmente la póliza. Va junto con el copy legal del guardado de tarjeta.
- **Desviaciones de ADR-2 por plugins nuevos.** `qr` (codificador del QR) quedó aprobada
  por Innovation con evidencia de salud del paquete. El brillo forzado y el wakelock del
  modo presentación —que el mockup fijó como requisito de build para sol directo— exigen
  otros dos plugins. Autorizados por el PM como desviación declarada, sujetos a tu veto.
- **SC-5 y SC-7 (alcance, no defectos).** SC-5: bajar a la tarjeta roja una línea que diga
  dónde se capturan los datos, ahora que ADR-1 borró el enlace del mockup. SC-7: el
  mockup dibuja "Ver documento firmado" en 10C y no se construyó; si no hay URL de PDF en
  el contrato la omisión es correcta, pero debe quedar escrita como decisión, no olvido.

**Corrección del encargo del PM, verificada en código:** `charge-sale` y `hold-deposit`
**NO** están gateados por `paymentActions` (`money-route-gate.test.mjs` los fija como
card-present/record-only abiertos a propósito — "gatearlos trabaría cada checkout"). El
PM había pedido dibujarlos en estado denegado; hacerlo habría producido una app que traba
el mostrador. La §15 muestra en su lugar un mapa de capacidades honesto (un AGENT cobra
igual; lo que no puede es mover dinero **sin el cliente presente**) y usa la única acción
realmente gateada y alcanzable: cobrar a la tarjeta guardada.

### Restricción de orden de despliegue (decisión del PM, review H7)

**La rama del M2 NO se despliega al patio antes de que M2-H4 aterrice.** H7 quitó de la
card la entrada a `/inspection/:id` —que siempre fue un cabo temporal de M1-H6— porque el
estado final correcto es card → wizard → paso 4 = inspección, y eso lo construye H4. Entre
H7 y H4 no queda ninguna forma de INICIAR una inspección nueva (la entrada de la bandeja
solo aparece para filas ya encoladas). No hay regresión en campo porque el M1 desplegable
conserva su entrada intacta, pero el M2 parcial no puede salir en esa ventana.

### Bug pre-existente del M1 a atender aparte (Innovation, review H7)

`POST /api/mobile-inspection/:token/complete` devuelve **200 con `{ok:true}` aunque
`hasSignature` sea false** (`mobile-inspection.service.js:319`): en ese caso NO se estampa
`customerSignedAt` ni se escriben las columnas de firma (`:272`, `:293-303`).
`CheckoutApi.completeInspection` descarta el body por completo. Hoy es difícil de alcanzar
(la UI exige firma no nula antes de terminar), pero el umbral del servidor es un chequeo
de longitud que el cliente no espeja. **Misma trampa que el correo, con más en juego: es
la firma del cliente.** Ticket propio, no de H7.

### Bug VIVO en producción destapado al construir H2 (Innovation, verificado en código)

No es deuda ni riesgo futuro: **el switch de seguro del wizard web arranca apagado en
cada carga, sin importar lo guardado.** `getById` usa un `select` explícito para
`rentalAgreement` (`reservations.service.js:1585-1669`) que omite `declinedInsurance` —
el select de la LISTA sí lo trae (`:285`). El wizard siembra el switch desde ese campo
(`checkout-wizard-v2/page.js:750-752`), recibe `undefined`, y `!!undefined === false`.

Por qué importa y no es cosmético:
- el **kiosco sí lee bien** la columna (`kiosk-checkout.service.js:585`), así que un
  cliente que rechaza el seguro ahí queda persistido en `true`;
- el agente abre el wizard, ve el switch apagado, y si lo enciende y apaga para revisar,
  el viaje manda `declined: false` (`page.js:755-767`) y **borra el anexo de un contrato
  que el cliente esperaba**;
- de esa columna dependen las iniciales requeridas (`terms-signing.service.js:132`) y el
  bloque impreso (`rental-agreements.service.js:1184`).

Arreglo: **un renglón** — agregar `declinedInsurance: true` al select de `getById`. Cierra
además el pedido P7, porque RideOps deja de deducir el estado leyendo `events[]`. Va en la
rama `fix/insurance-flag-and-terms-url` junto con P6 y P5.

### Backlog abierto por el SHIP de H7: el pie del 5xx (QA, re-gate d3f0c3b)

H7 pasó con SHIP, pero QA dejó un pendiente que **no puede vivir solo como párrafo en el
doc de observabilidad**. Un 5xx cae en `unknown`, cuyo pie afirma "no se creó ninguna
sesión": cierto para el 500 de `ensureAgreementExists` (corre ANTES del create,
`checkout-session.service.js:194-197`) y **falso** para el `update` de `DEALERSHIP_LOANER`
(`:215-220`, después). QA agregó un caso que el desarrollador no vio: **un 502 de proxy
durante un reinicio de despliegue** cae en el mismo bucket con la misma mentira.

Por qué no bloqueó: M-1 era falso el 100% de las veces y sobre el modo de falla rutinario
(WiFi de patio); esto es falso solo en un subconjunto estrecho de una clase ya rara, y
para el 5xx **más probable** de esa ruta el copy actual es CIERTO — cambiarlo cambiaría un
mensaje correcto por un sobre-aviso.

**Pero QA corrigió al desarrollador en su razón**: él dijo que solo el re-fetch por reserva
puede arreglarlo, y eso no es exacto — dejarlo así justificaría el hueco para siempre.
`CheckoutEntryBlock.status` ya viaja, así que `_footOf` puede ramificar en
`status != null && status >= 500` y reusar `coEntryConnectionLostFoot`: **tres líneas, cero
llaves nuevas, una prueba** — más chico que el arreglo que acababa de shippear. Estado final
honesto sigue siendo la reconciliación por re-fetch, que resuelve `connectionLost`,
`scopeChanged` y el 5xx de una sola vez.

### Lo que la Tanda C destapó y H5 NO puede construir a ciegas

Dos defectos que el diseño encontró **leyendo el backend**, no dibujando. El primero es de
evidencia contractual y el segundo no tiene pantalla hoy:

1. **El paso de firma se decide por el SELLO, no por `currentStep`.** El `complete` de la
   inspección estampa `customerSignedAt` **junto** a `inspectionCompletedAt` cuando viene
   firma (`mobile-inspection.service.js:265-281`), y la captura de RideOps **siempre** la
   manda (su CTA está deshabilitado sin firma, `inspection_screen.dart:818`). O sea que en
   el camino normal el paso 8 llega **ya cumplido**. Construirlo mirando el paso significa
   pedirle al cliente firmar dos veces lo mismo — y `saveCustomerSignature` **sobrescribe**
   `tcSignatureDataUrl`/`tcSignedAt` sin condición (`checkout-session.service.js:668-690`).
2. **"Cerrado pero no entregado" existe y no tiene pantalla.** La sesión pasa a `CLOSED` en
   `:417` y la cascada corre **después**; un 409/422 posterior deja al agente con error,
   sesión terminal y **sin reintento posible** (`canTransition` es false desde terminal).

Pedidos nuevos que salen de ahí (ninguno bloquea el mockup): **P9** devolver el resultado de
la cascada en la respuesta de `transition` —hoy varios tramos se tragan su error
(`:526`, `:533`, `:557`, `:571`), así que un 200 puede convivir con una reserva sin avanzar—
y **P10** un evento `FINALIZE_FAILED` para que el motivo sobreviva al re-fetch.

**Corrección al reporte de la Tanda C:** marcó como pendiente el copy del correo en la
pantalla 11E de H7 ("salió por correo"). **Ya estaba arreglado** — H7 lo corrigió en su
propio ciclo y hoy dice "se pidió el envío del contrato". Verificado en `app_es.arb:652`.
Es el segundo hallazgo cruzado que llega tarde porque cada agente mira su propio árbol.

### Orden de fusión: el trinquete de CI vive en UNA sola rama

Dos gates de QA dieron veredictos aparentemente contradictorios sobre el mismo trinquete.
No lo son: **la capacidad la añade `fix/sign-page-tenant-identity` y `fix/insurance-flag-and-terms-url`
salió de main, así que no la tiene.**

El guardia `backend/src/lib/npm-test-chain.test.mjs` vigilaba solo la definición **débil**
de "la prueba corre" (alcanzable desde `npm test`) — y CI **nunca invoca `npm test`**, cosa
que el propio workflow documenta. La rama de la página de firma le agrega una tercera
comprobación que **sí lee `beta-ci.yml`** y exige que las suites gateadas estén en la lista
explícita. QA lo verificó rompiéndolo: quitó la línea del workflow y vio fallar el guardia.

Consecuencia práctica: **hasta que esa rama entre, quitar una suite de la lista de CI no lo
caza nadie** — ni la de `test:declined-insurance`, ni las otras 22. Al fusionar ambas, hay
que confirmar que la suite del seguro quede cubierta por la comprobación nueva; si no, se
arreglaron dos síntomas y el mecanismo sigue abierto.

### Alcance de la rama del gap #11 (decisión del PM, review GD de la página de firma)

GD encontró **siete MUST** en `fix/sign-page-tenant-identity`, pero solo tres son la fuga
de marca; el resto son defectos preexistentes de una pantalla que nadie había mirado con
lupa. **La rama cierra la fuga y nada más.** Lo demás se separa para que el gap #11 no se
convierta en un rediseño de la pantalla de firma con el M2 detenido detrás.

Dentro de la rama (es la fuga):
- **M1 · el logo sigue ahí.** Se arregló el título y se heredó todo lo demás de
  `layout.js`: el cliente ve el logotipo de Ride Fleet junto a "Autos del Valle" en el
  selector de pestañas, y "añadir a pantalla de inicio" le propone "Ride Fleet". **Es lo
  ÚNICO que GD dice que no necesita mockup**, así que es lo mínimo que desbloquea el QA
  de H2.
- **M3 · la identidad no sobrevive al scroll**: el nombre aparece una vez arriba y no hay
  nada junto al pad de firma. El instante del consentimiento es justo el que el gap
  quería arreglar.
- **M4 · la costura de idioma**, incluido el `documentElement.lang='es'` sobre cláusulas
  en inglés, que hace que los lectores de pantalla lean texto legal inglés con fonética
  española.

Fuera de la rama, historia propia:
- **M6 · la iniciación accidental que se auto-guarda sin deshacer.** Preexistente y con
  consecuencia legal: queda una inicial registrada que el cliente no quiso poner. Ticket
  aparte, necesita mockup y decisión de Hector.
- **M2 · el estado de error** que borra la pantalla e imprime `/api/sign/<token> failed
  (410)` — el token del cliente en pantalla. El texto viene de `client.js:86`, así que la
  causa es compartida con otras superficies. Lo único que sí entra aquí es dejar de
  imprimir `err.message`.
- **M5 y M7** (objetivos de toque, tamaño del cuerpo legal, hairlines de 0.5 px, `100vh`
  sin safe-area, semántica de formulario) y las **seis fugas hermanas** en otras pantallas
  de cliente, con sus causas raíz en `layout.js:9` y `:120`.

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
- **H2 · Dependencia nueva `qr` ^4.0.0 — desviación declarada de ADR-2.** El ADR pide
  pintar a mano; el pintor SÍ es nuestro (quiet zone, contraste 21:1, estado vencido),
  pero el **codificador** Reed-Solomon no. Razón: escribir a mano la codificación de un
  QR que lleva a la firma de un contrato legal es riesgo sin premio — si el código sale
  mal, el cliente firma otra cosa o no firma. Pendiente de que Innovation juzgue la
  salud del paquete.
- **PM · Gap #11 se arregla en su propia rama de frontend (`fix/sign-page-tenant-identity`),
  decidido 2026-08-17.** Era decisión pendiente de Hector, pero **bloquea el QA de H2** y
  la cadena no puede esperar; es reversible y pasa por las mismas compuertas. El viaje
  real que arregla: el agente muestra una pantalla con la marca del inquilino, el cliente
  escanea, y aterriza en "Ride Fleet · Terms & Conditions" en inglés. Es fuga de marca de
  la plataforma hacia el cliente final de otro negocio, en la pantalla donde firma.

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
