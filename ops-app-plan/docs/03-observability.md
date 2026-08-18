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
| `checkout.transition_ok` / `checkout.transition_409` | POST /transition (tag `code`: ILLEGAL_TRANSITION/ENTRY_GUARD/…) |
| `checkout.reconciled` | UI reconciliada con el servidor (tags `steps_jumped`, `via`) |
| `checkout.money_attempt` / `checkout.money_ok` / `checkout.money_fail` | rutas de dinero (tag `kind`: charge_sale/hold_deposit/manual_*; NUNCA montos ni PAN) |
| `checkout.preview_divergence` | cálculo local ≠ preview del servidor (compuerta ADR-6) |
| `checkout.declined_insurance_set` | `POST /:id/declined-insurance` aceptado (tag `declined`) |
| `checkout.vehicle_swapped` | `POST /:id/vehicle` aceptado — sin tags: el id de la unidad es dato de operación, no de telemetría |
| `checkout.terms_token_minted` | `POST /:id/terms-token` aceptado (tag `reused`) |
| `checkout.terms_token_expired` | el countdown llegó a 0 con el paso abierto |
| `checkout.terms_signed_seen` | el poll vio caer `tcCompletedAt` |
| `checkout.present_mode_shown` | se abrió la pantalla volteada al cliente (10B) |
| `checkout.present_mode_screen_degraded` | brillo/wakelock no se pudo aplicar o restaurar (tags `what`: brightness/wakelock, `phase`: enter/exit) |

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

Detalle de `checkout.reconciled` (M2-H1). Tres valores de `via`, deliberadamente
separados porque miden cosas distintas:

- `poll` — el poll de 5 s detectó que OTRA superficie movió el paso. Su frecuencia ES la
  métrica de cuánto se pisan las superficies en el patio, y con ella se mide la prueba de
  concurrencia del SHIP del épico.
- `conflict` — el servidor rechazó una transición con 409 y el re-fetch reconcilió.
- `preflight` — el re-fetch previo a escribir (>3 s de antigüedad) encontró la sesión ya
  movida y ABORTÓ el POST. No hubo 409: contarlo como tal inflaría las colisiones reales.

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

### Inspección y bandeja
| Evento | Cuándo |
|---|---|
| `inspection.photo_captured` | tag `angle`, `bytes_after_compress`, `ms_compress` |
| `inspection.completed_local` | complete encolado/enviado |
| `inspection.completed_server` | el poll vio caer `inspectionCompletedAt` (tag `waited_s`: segundos desde que la pantalla vio el complete encolado; sin tag si no hubo espera que medir). Con `completed_local` mide lo que el agente espera de pie junto al coche con el paso sin avanzar — M2-H4 |
| `inspection.required_angle_dead` | una foto OBLIGATORIA (front/rear) murió en la bandeja (tag `angle`). El dead-letter no bloquea al resto, así que el `complete` sale igual y el servidor lo rechaza con `REQUIRED_ANGLES_MISSING`: su frecuencia mide el callejón sin salida del frame 17E — M2-H4 |
| `outbox.enqueued` / `outbox.drained_ok` | tag `kind`, `queue_depth` |
| `outbox.remint_token` | re-emisión del handoff al drenar (tag `reused`) |
| `outbox.entry_dead` | dead-letter (tag `code` — TOKEN_*, REQUIRED_ANGLES_MISSING…) |
| `outbox.purged_account_switch` | purga por cambio de cuenta (tag `rows`) |

### Salud
| Evento | Cuándo |
|---|---|
| `net.request_429_backoff` | backoff activado (tag `route`) |
| `camera.oom_guard` | presión de memoria detectada al capturar |
| `dashboard.poll_tick` | solo métrica de frecuencia — sample 1% |

## Compuertas de release

- Crash-free sessions ≥ 99.5% en stg antes de promover un build a prod.
- Cero eventos `checkout.preview_divergence` en stg: si aparece uno, es bug de cálculo
  local y bloquea el release (el número que firma el cliente no puede divergir).
- `outbox.entry_dead` con `code` nuevo desconocido = bug de manejo de errores, no ruido.
