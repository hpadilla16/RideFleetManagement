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

Detalle de `checkout.reconciled` (M2-H1). Tres valores de `via`, deliberadamente
separados porque miden cosas distintas:

- `poll` — el poll de 5 s detectó que OTRA superficie movió el paso. Su frecuencia ES la
  métrica de cuánto se pisan las superficies en el patio, y con ella se mide la prueba de
  concurrencia del SHIP del épico.
- `conflict` — el servidor rechazó una transición con 409 y el re-fetch reconcilió.
- `preflight` — el re-fetch previo a escribir (>3 s de antigüedad) encontró la sesión ya
  movida y ABORTÓ el POST. No hubo 409: contarlo como tal inflaría las colisiones reales.

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
