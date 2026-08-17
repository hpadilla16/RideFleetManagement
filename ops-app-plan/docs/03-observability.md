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
| `session.pin_lock` / `session.pin_unlock` | bloqueo/desbloqueo | `method` (pin/biometric) |

### Checkout (M2)
| Evento | Cuándo |
|---|---|
| `checkout.step_rendered` | render desde `currentStep` (tag `step`) |
| `checkout.transition_ok` / `checkout.transition_409` | POST /transition (tag `code`: ILLEGAL_TRANSITION/ENTRY_GUARD/STALE_VERSION/CONCURRENT_MODIFICATION/…) |
| `checkout.transition_noop` | 200 que era idempotente: otra superficie ya estaba en `toStep` (M2-H8) |
| `checkout.reconciled` | 409 → re-fetch → UI reconciliada (tag `steps_jumped`) |

> **Ruptura de serie por M2-H8 (2026-08-17) — leer antes de comparar contra histórico.**
> El caso "otra superficie ya hizo esta transición" **cambió de lado**: antes emitía
> `checkout.transition_409` (code `ILLEGAL_TRANSITION`) seguido de `checkout.reconciled`;
> ahora el backend responde 200 y emite `checkout.transition_ok`. Sin este aviso, el
> despliegue de H8 se lee en los tableros como "los 409 de checkout se desplomaron y las
> reconciliaciones desaparecieron" — que es exactamente la forma que tendría una regresión
> de telemetría. Consecuencias:
> - `checkout.transition_409` baja, `checkout.transition_ok` sube, **misma suma**.
> - `checkout.reconciled` baja de verdad, porque hay menos que reconciliar.
> - Para no perder la señal de concurrencia, la app emite `checkout.transition_noop`
>   cuando un 200 no movió nada (`currentStep` de la respuesta == el que ya tenía **y**
>   `stateVersion` sin cambio). Esa es la métrica que hay que vigilar para "cuántas veces
>   dos superficies pisan el mismo paso"; ya **no** sirve `transition_409` para eso.
> - `STALE_VERSION` y `CONCURRENT_MODIFICATION` son códigos nuevos del tag `code`.
| `checkout.money_attempt` / `checkout.money_ok` / `checkout.money_fail` | rutas de dinero (tag `kind`: charge_sale/hold_deposit/manual_*; NUNCA montos ni PAN) |
| `checkout.preview_divergence` | cálculo local ≠ preview del servidor (compuerta ADR-6) |

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
