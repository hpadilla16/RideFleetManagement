# RideOps — Observabilidad (M0-4)

**Decisión: Sentry, no Crashlytics.** El backend ya reporta a Sentry (ver
`SENTRY_DSN`/`SENTRY_ENV` en `.github/workflows/beta-ci.yml:154-157` y el init del
backend) — un vendor, un dashboard, y correlación app↔API con el mismo trace. Crashlytics
además arrastraría Firebase entero solo para crashes. Paquetes: `sentry_flutter` +
`sentry_dart_plugin` (subida de símbolos/mapping en CI — sin símbolos la métrica de
sesiones-sin-crash no existe, y esa métrica es compuerta de release).

Config por flavor: `SENTRY_DSN` propio de la app (proyecto `rideops` en la org existente),
`environment` = dev/stg/prod del flavor, `release` = `rideops@<version>+<build>` para que
el crash-free rate corte por build.

## Reglas de PII (ADR-7 aplica también aquí)

- `sendDefaultPii: false`. Nunca adjuntar: nombres de clientes, firmas, fotos, tokens,
  bodies de request. `beforeSend` redacta `Authorization` y `x-view-location` queda como
  booleano `hasViewLocation`.
- Identidad: `userId` propio del empleado (es staff, no cliente) + `tenantId` como tag.
  Nada del cliente final viaja a Sentry.

## Taxonomía de eventos (breadcrumbs/analytics estructurados)

Convención: `dominio.acción[_resultado]`, snake_case, tags siempre presentes:
`tenant_id`, `location_id` (la activa del selector), `flavor`, `offline` (bool).

### Sesión
| Evento | Cuándo | Datos extra |
|---|---|---|
| `auth.login_ok` / `auth.login_fail` | login | `fail_reason` (invalid/network) |
| `auth.password_gate_shown` / `auth.password_changed` | gate `PASSWORD_CHANGE_REQUIRED` | — |
| `auth.token_refresh_ok` / `auth.token_refresh_fail` | refresco proactivo | `ms_before_expiry` |
| `auth.session_expired_relogin` | 401 → re-login | — |
| `session.view_location_set` | cambio en el selector | — |
| `session.view_location_denied` | 403 del header | — |
| `session.pin_lock` / `session.pin_unlock` | bloqueo/desbloqueo | lock: `reason` (cold_start/idle_timeout/background/manual) · unlock: `method` (pin/biometric) |

### Checkout (M2)
| Evento | Cuándo |
|---|---|
| `checkout.entry_open` | POST /api/checkout-sessions OK desde la card de la cola: se abre o se REANUDA (M2-H7) |
| `checkout.entry_blocked` | un guard de creación negó la apertura (tag `code`) — M2-H7 |
| `checkout.entry_precheckin_link_sent` | salida del guard 11B: el link de pre-checkin salió por correo (M2-H7) |
| `checkout.step_rendered` | render desde `currentStep` (tag `step`) |
| `checkout.transition_ok` / `checkout.transition_409` | POST /transition (tag `code`: ILLEGAL_TRANSITION/ENTRY_GUARD/STALE_VERSION/CONCURRENT_MODIFICATION/…) |
| `checkout.transition_noop` | 200 que NO lo movió esta superficie: lo movió otra, o fue doble-submit (M2-H8) |
| `checkout.reconciled` | UI reconciliada con el servidor — p.ej. 409 → re-fetch (tags `steps_jumped`, `via`) |
| `checkout.money_attempt` / `checkout.money_ok` / `checkout.money_fail` | rutas de dinero (tag `kind`: charge_sale/hold_deposit/manual_*; NUNCA montos ni PAN) |
| `checkout.preview_divergence` | cálculo local ≠ preview del servidor (compuerta ADR-6) |
| `checkout.context_unreachable` | `GET /reservations/:id/display-data` no respondió. Tags: `status` (código del servidor / `network` / `none`), `stale` (había una respuesta previa en pantalla) y `via` (`open`/`swap`/`confirm_retry`/`verify_handover`). El grave es `stale:false` + `via:open`: el paso 1 se queda SIN poder verificar identidad. `via:verify_handover` es OTRO incidente —la comprobación post-cierre, que ya tiene su propio veredicto— y sumarlos borraría los dos |
| `checkout.context_retry` | "Reintentar la consulta" del paso 1 (tag `result`: answered/unreachable) — hermano de `checkout.handover_recheck` |
| `checkout.declined_insurance_set` | `POST /:id/declined-insurance` aceptado (tag `declined`) |
| `checkout.vehicle_swapped` | `POST /:id/vehicle` aceptado — sin tags: el id de la unidad es dato de operación, no de telemetría |
| `checkout.terms_token_minted` | `POST /:id/terms-token` aceptado (tag `reused`) |
| `checkout.terms_token_expired` | el countdown llegó a 0 con el paso abierto |
| `checkout.terms_signed_seen` | el poll vio caer `tcCompletedAt` |
| `checkout.present_mode_shown` | se abrió la pantalla volteada al cliente (10B) |
| `checkout.present_mode_screen_degraded` | brillo/wakelock no se pudo aplicar o restaurar (tags `what`: brightness/wakelock, `phase`: enter/exit) |
| `checkout.signature_saved` | `POST /:id/customer-signature` aceptado (tag `replaced`: pisó una firma ya guardada) — M2-H5 |
| `checkout.close_started` | el agente arrancó el cierre (tag `legs`: 3 con firma por recoger, 2 si ya venía sellada) — M2-H5 |
| `checkout.close_ok` | el cierre llegó a CLOSED (tag `handover`: recorded/not_recorded/unverified, leído de `Reservation.status`) — M2-H5 |
| `checkout.close_failed` | un tramo del cierre fue rechazado (tags `leg`, `code`, `terminal`) — M2-H5 |
| `checkout.close_unknown` | un tramo del cierre murió sin respuesta (tag `leg`) — M2-H5 |
| `checkout.handover_recheck` | "Volver a comprobar" desde el estado sin confirmar (tag `result`: recorded/not_recorded/unverified) — M2-H5, frame 19A-bis |

Notas de los eventos de M2-H2:

- **`terms_token_minted.reused`** mide cuántas re-emisiones caen dentro de la ventana de
  re-uso del backend (>2 min restantes ⇒ devuelve el MISMO token). Es la métrica que
  respalda la copy honesta de la re-emisión: si `reused` domina, el agente está tocando el
  botón sin necesidad y el copy tiene que enseñarlo mejor.
- **`terms_token_expired`** es la medida directa del riesgo §5 del plan (TTL de 15 min
  corto para un cliente que de verdad lee los términos). Se emite **una vez por token**,
  no una por tick del countdown.
- **`terms_signed_seen`** se emite solo cuando el sello CAE mientras la app mira (null →
  fechado). Encontrarlo ya puesto al entrar no es un evento: es el estado de la sesión.
- **`present_mode_screen_degraded`** con `phase:exit` es la única señal de que el teléfono
  del agente pudo quedarse con el brillo forzado tras salir del modo presentación. En
  Android no debería aparecer nunca con consecuencia real (el override es de la VENTANA de
  la actividad y muere con ella); en iOS sí sería un teléfono al 100% hasta que alguien lo
  baje a mano. Volumen sostenido = plugin roto en esa versión de OS.
- Ninguno de estos lleva nombre de cliente, número de reserva ni el token: el token es
  credencial (regla de PII de este mismo documento).

Detalle de `checkout.entry_blocked` (M2-H7). El tag `code` lleva el código del SERVIDOR
cuando existe (`NO_VEHICLE_ASSIGNED`, `VEHICLE_CONFLICT`, `PRECHECKIN_REQUIRED`,
`AGE_RULES_*`, `SESSION_TERMINAL`) y, cuando el arranque se cortó del lado del cliente, el
motivo local (`offline`, `connectionLost`, `locationNotReady`, `forbidden`,
`locationDenied`, `rateLimited`, `scopeChanged`, `unknown`). Se separan a propósito: "el
patio no tiene señal" y "el backend negó" son dos problemas distintos y colapsarlos en
`none` haría inútil la métrica.

**Sin veredicto del servidor = la sesión pudo quedar CREADA.** Son DOS los códigos con esa
propiedad, no uno:

- `connectionLost` — el POST salió y no volvió respuesta (timeout de recepción/envío,
  socket caído). El servidor pudo correr `createForReservation` entero y dejar
  `CheckoutSession` + `RentalAgreement` con renglones de precio
  (`checkout-session.service.js:194-209`).
- `scopeChanged` — el POST salió y su respuesta llegó tras un cambio de sede/cuenta.

Los dos imprimen el pie "la sesión pudo haberse creado; vuelve a tocar la card: si existe,
se reanuda" en vez de "no se creó ninguna sesión", que es una afirmación que el backend no
garantiza. `offline` (el corte previo, con la petición sin salir del aparato) y los códigos
del servidor SÍ pueden afirmarla. Si `connectionLost` sube, es salud de red del patio; si
sube `scopeChanged`, hay un patrón de uso —cambiar de sede con el checkout abriéndose— que
merece diseño, no un bug que ocultar.

Nota de honestidad pendiente: un 5xx del servidor cae en `unknown` y el pie ahí sí afirma
"no se creó ninguna sesión". Es cierto para el 500 de `ensureAgreementExists` (corre ANTES
del `create`, service:194-197) y falso para el caso raro del `update` de
`DEALERSHIP_LOANER` (service:215-220, después del create). Queda registrado, no corregido:
la superficie que lo resolvería es el re-fetch por reserva, no un cambio de copy.
`entry_open` NO lleva tag `resumed` — el backend responde 201 igual al crear que al
reanudar, y la app no puede afirmar la diferencia sin inventarla.

Detalle de `checkout.reconciled` (M2-H1). Cinco valores de `via`, deliberadamente
separados porque miden cosas distintas:

- `poll` — el poll de 5 s detectó que OTRA superficie movió el paso. Su frecuencia ES la
  métrica de cuánto se pisan las superficies en el patio, y con ella se mide la prueba de
  concurrencia del SHIP del épico.
- `conflict` — el servidor rechazó una transición con 409 y el re-fetch reconcilió.
- `preflight` — el re-fetch previo a escribir (>3 s de antigüedad) encontró la sesión ya
  movida y ABORTÓ el POST. No hubo 409: contarlo como tal inflaría las colisiones reales.
- `noop` (M2-H6) — el POST volvió **200 y no lo movimos nosotros**: desde M2-H8 el backend
  responde idempotente cuando otra superficie ya hizo esa transición. No hubo 409 ni
  rechazo, pero el paso SÍ saltó por debajo del agente, así que la reconciliación existe y
  se cuenta. Va con su `checkout.transition_noop`. Separado de `conflict` a propósito:
  contarlo ahí volvería a inflar las colisiones que H8 justamente dejó de producir.
- `rejected` (M2-H5) — el servidor rechazó la transición con un 4xx del SERVICIO que no es
  409 (400/404/422) y el re-fetch reconcilió. Su caso real es el finalize: `transition`
  commitea el paso (checkout-session.service.js:417) y la cascada revienta DESPUÉS con 422
  (`NO_VEHICLE_ASSIGNED`, `PRECHECKIN_REQUIRED`, `AGE_RULES_*`), dejando la sesión cerrada
  y al cliente creyendo que sigue en FINALIZING. NO se cuenta como `conflict`: no hubo
  colisión entre superficies, hubo una regla de negocio que falló tarde.

**Un movimiento = un evento.** El emisor deduplica por movimiento (`FROM>TO`): un 409 que
re-consulta y reconcilia produce UNA línea, no una por cada capa que la detectó. Contarlo
dos veces duplicaría exactamente la señal con la que se mide la concurrencia. Y una
reconciliación que no movió nada (el 409 que encuentra la sesión donde ya estaba) no se
emite.

Nunca se emite con `steps_jumped` negativo: una lectura que aterriza después de una
escritura se descarta por fencing (`stateVersion` de P2 + epoch local) en vez de publicar
el pasado.
`steps_jumped` puede venir ausente: si alguno de los dos pasos no está en el catálogo de
la app (paso nuevo del backend), el evento viaja sin el tag antes que con un número
inventado.

> **Ruptura de serie por M2-H8 (2026-08-17) — leer antes de comparar contra histórico.**
> El caso "otra superficie ya hizo esta transición" **cambió de lado**: antes emitía
> `checkout.transition_409` (code `ILLEGAL_TRANSITION`) seguido de `checkout.reconciled`;
> ahora el backend responde 200 y emite `checkout.transition_ok`. Sin este aviso, el
> despliegue de H8 se lee en los tableros como "los 409 de checkout se desplomaron y las
> reconciliaciones desaparecieron" — que es exactamente la forma que tendría una regresión
> de telemetría. Consecuencias:
>
> - `checkout.transition_409` baja, `checkout.transition_ok` sube, **misma suma**.
> - `checkout.reconciled` baja de verdad, porque hay menos que reconciliar.
> - `STALE_VERSION` y `CONCURRENT_MODIFICATION` son códigos nuevos del tag `code`.
> - Para no perder la señal de concurrencia, la app emite `checkout.transition_noop`.
>   **Cómo se detecta (importa, y la primera versión de esta nota lo tenía al revés):**
>   un noop **NO** es "el paso volvió igual y la versión no cambió". En la carrera entre
>   superficies —que es justo lo que esta métrica tiene que vigilar— el cliente está en
>   `FINALIZING`/v0, otra superficie commitea, y la respuesta llega `CLOSED`/v1: el paso
>   **sí** cambió y la versión **también**. Esa regla sólo dispara en el doble-submit sin
>   carrera, o sea que sub-reporta exactamente el caso que motivó la métrica.
>
>   La regla correcta es la de atribución, la misma que ya usa
>   `02-flutter-blueprint.md` §2.2: **es noop cuando el último evento `TRANSITION` de la
>   respuesta no nombra a esta superficie** (comparar su `actorUserId`/`metadata` con los
>   propios). **Es la única regla.** No hay atajo por `stateVersion`: una versión anterior
>   de esta nota ofrecía "`stateVersion !== localVersion + 1`" como equivalente y **no lo
>   es**, precisamente en el caso que la métrica existe para vigilar — el wizard tiene v0
>   en `FINALIZING`, el kiosco commitea `CLOSED` → v1, y la respuesta idempotente no sube
>   nada, así que lee v1: `1 !== 0 + 1` es **falso** y no se marca. Subió exactamente uno,
>   pero lo subió otro, y la versión sola no sabe distinguirlo. Es tentador porque evita
>   decodificar el JSON; es exactamente el sub-reporte que esta sección vino a arreglar.
>
>   Nota de parseo: `events` viaja como **string JSON**, no como arreglo — hay que
>   `jsonDecode` antes de leer el último `TRANSITION`. Llega así por los dos caminos
>   (`GET /:id` y la respuesta del propio POST).

### Inspección y bandeja
| Evento | Cuándo |
|---|---|
| `inspection.photo_captured` | tag `angle`, `bytes_after_compress`, `ms_compress` |
| `inspection.completed_local` | complete encolado/enviado |
| `inspection.completed_server` | el poll vio caer `inspectionCompletedAt` (tag `waited_s`: segundos desde que la pantalla vio el complete encolado; sin tag si no hubo espera que medir). Con `completed_local` mide lo que el agente espera de pie junto al coche con el paso sin avanzar — M2-H4 |
| `inspection.required_angle_dead` | una foto OBLIGATORIA (front/rear) murió en la bandeja (tag `angle`). El dead-letter no bloquea al resto, así que el `complete` sale igual y el servidor lo rechaza con `REQUIRED_ANGLES_MISSING`: su frecuencia mide el callejón sin salida del frame 17E — M2-H4 |
| `outbox.enqueued` / `outbox.drained_ok` | tag `kind`, `queue_depth` |
| `outbox.remint_token` | re-emisión del handoff al drenar (tag `reused`) |
| `outbox.entry_dead` | dead-letter (tag `code` — TOKEN_*, REQUIRED_ANGLES_MISSING… — y tag `status`: el HTTP de la respuesta, o null si NUNCA llegó una. `code` null + `status` null = murió sin red; `code` null + `status` presente = el backend rechazó sin mandar code) |
| `outbox.purged_account_switch` | purga por cambio de cuenta (tag `rows`) |
| `outbox.inflight_rescued` | filas que quedaron en `inflight` (corrida tumbada a media subida) y el arranque del drenado devolvió a `pending` (tag `rows`). Cada una fue una foto congelada en "Subiendo" en la cara de un empleado — corrida e2e 2. **Solo se ve desde FOREGROUND:** el worker de background construye su logger a mano y en release es `NoopEventLogger` (`background_drain.dart:127`), así que un rescate hecho por WorkManager no llega al tablero. La cifra es un PISO, no el total — si algún día importa el total, el pedido es un logger real en el isolate, no un cambio en este evento |

### Salud
| Evento | Cuándo |
|---|---|
| `net.request_429_backoff` | backoff activado (tag `route`) |
| `camera.oom_guard` | presión de memoria detectada al capturar |
| `camera.shutter_timeout` | `takePicture()` no resolvió en `kShutterTimeout` (tag `timeout_s`). Salud de APARATO: la app suelta el controlador y lo dice; contarlo es la única forma de saber en qué teléfonos pasa |
| `dashboard.poll_tick` | solo métrica de frecuencia — sample 1% |

## Compuertas de release

- Crash-free sessions ≥ 99.5% en stg antes de promover un build a prod.
- Cero eventos `checkout.preview_divergence` en stg: si aparece uno, es bug de cálculo
  local y bloquea el release (el número que firma el cliente no puede divergir).
- `outbox.entry_dead` con `code` nuevo desconocido = bug de manejo de errores, no ruido.
