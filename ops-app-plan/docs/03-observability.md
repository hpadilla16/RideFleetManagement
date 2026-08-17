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
- Ninguno de estos lleva nombre de cliente, número de reserva ni el token: el token es
  credencial (regla de PII de este mismo documento).

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
