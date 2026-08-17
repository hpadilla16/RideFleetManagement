# 02 — Blueprint técnico de RideOps (Flutter)

> Alineado con los ADRs de [PROJECT_PLAN.md](../PROJECT_PLAN.md) (no reabrir) y los flujos
> de [00-domain-workflows.md](00-domain-workflows.md). Stack cerrado por ADR-2:
> Riverpod 3.x · go_router (ShellRoute) · Drift+SQLCipher · dio/retrofit/freezed a mano.

## 1. Estructura de carpetas (por features)

```
lib/
  main_dev.dart / main_stg.dart / main_prod.dart   # entrypoints por flavor
  app.dart                      # MaterialApp.router + tema Ride (#8752FE)
  core/
    api/                        # Dio autenticado + Dio limpio, interceptores, ApiException
    session/                    # token store, sesión Riverpod, refresh proactivo, PIN lock
    db/                         # Drift + SQLCipher (outbox), migraciones
    l10n/                       # gen-l10n (app_es.arb, app_en.arb)
    telemetry/                  # Crashlytics/Sentry + taxonomía de eventos
    utils/
  features/
    auth/                       # login, cambio forzado de contraseña, PIN/biometría
    dashboard/                  # 9 colas + 11 métricas + búsqueda (+ selector ubicación)
    checkout/                   # wizard server-driven sobre /api/checkout-sessions
    inspection/                 # captura nativa de cámara + pipeline a outbox
    checkin/                    # return flow (M3)
    outbox/                     # UI de bandeja: pendientes, dead-letter, reintento
  # cada feature: data/ (dto, api), domain/ (modelos, lógica), presentation/ (screens,
  # widgets, providers). Nada importa "hacia arriba"; features solo dependen de core/.
```

## 2. Capa API (`core/api`)

Dos clientes Dio (M0-5):

- **`authedDio`** — SOLO rutas autenticadas de staff. Interceptores en orden:
  1. `AuthInterceptor`: `Authorization: Bearer <jwt>`.
  2. `ViewLocationInterceptor`: `x-view-location: <locationId>` si hay ubicación activa
     (ADR-3 matizado; header aplicado en `backend/src/middleware/auth.js:71-78`).
  3. `ProactiveRefreshInterceptor` (ADR-3a): decodifica `exp` del JWT; si `exp - now < 60s`,
     refresca ANTES del request vía `POST /api/auth/refresh` con un `Mutex`
     (package:mutex) para colapsar refrescos concurrentes. **Nunca** refrescar al recibir
     401 — un JWT vencido también vence el refresh (está detrás de `requireAuth`); 401 = re-login.
  4. `ErrorMapper`: DioException → `ApiException` tipada (ver §2.2).
- **`plainDio`** — rutas públicas por token (`/api/mobile-inspection/:token/*`,
  `/api/public/checkout-handoff/:token`): sin bearer de staff, sin `x-view-location`,
  sin refresh. Jamás compartir instancia con `authedDio`.

Retrofit escrito a mano (ADR-2): una clase abstracta por feature (`AuthApi`,
`DashboardApi`, `CheckoutApi`, `InspectionApi`) con métodos que devuelven DTOs freezed.
`openapi.json` versionado solo para diff (DoD #12).

### 2.1 Los 6 DTOs calientes (freezed, con fixtures del JSON real — M0-5)

Campos derivados del código que los emite; fixture = respuesta real capturada de dev.

**`SessionUser`** — `buildSessionUser` (`auth.service.js:87-115`); llega en
`{token, user}` de login/refresh/change-password y en `GET /api/auth/me`:
`id, email, fullName, role (enum UserRole), tenantId?, createdByUserId?, hostProfileId?,
screenLockExempt (bool), locationIds (List<String>? — null = todas), programScope
(RENTAL_ONLY|LOANER_ONLY|BOTH), isServiceAccount (bool), tokenVersion (int),
mustChangePassword (bool), moduleAccess (Map<String,bool>), tenantModuleAccess,
userModuleAccess`.

**`DashboardPayload`** — `employee-app.service.js:451-497`:
`query (String), self { profile { id, fullName, email, role, isActive, commissionPlan
{id,name,isActive}? }?, commissions { monthKey, commissionAmount (num), agreements,
pending, approved, paid, recent[ {id,status,commissionAmount,calculatedAt,
agreementNumber?,reservationId?} ] } }, metrics { openReservations, activeRentals,
precheckinQueue, readyForPickup, dueBackToday, loanerOpen, loanerReady,
loanerBillingAttention, loanerOverdue, issueOpen, issueUnderReview } (11 ints),
queues { precheckin, checkout, returns, active, loanerReady, loanerAdvisorFollowup,
loanerBillingReview, loanerReturns: List<ReservationCard>, issueEscalations:
List<IncidentCard> }, searchResults: List<ReservationCard>`.

**`CheckoutSession`** — fila Prisma serializada tal cual (routes devuelven el row;
modelo `schema.prisma:5067-5111`):
`id, reservationId, agreementId?, tenantId?, currentStep (enum CheckoutStep, 11 valores),
events (String — JSON array serializado, parsear lazy), tcCompletedAt?,
paymentCompletedAt?, inspectionCompletedAt?, customerSignedAt?, startedAt, finishedAt?,
abandonedAt?, abandonedReason?, autoEmailedAt?, startedByUserId?, createdAt, updatedAt`.
Render SIEMPRE desde `currentStep` (ADR-4); prohibido replicar la máquina en Dart.

**`ReservationCard`** — `reservationCard()` (`employee-app.service.js:66-122`):
`id, reservationNumber, status, workflowMode (RENTAL|DEALERSHIP_LOANER), paymentStatus,
pickupAt, returnAt, estimatedTotal, readyForPickupAt?, customerInfoCompletedAt?,
customerInfoReviewedAt?, estimatedServiceCompletionAt?, repairOrderNumber, claimNumber,
serviceAdvisorName, loanerBillingMode, loanerBillingStatus,
loanerBorrowerPacketCompletedAt?, loanerReturnExceptionFlag (bool),
customer {id, firstName, lastName, email, phone}?,
vehicle {id, make, model, year, internalNumber, plate}?,
vehicleType {id, name}?, pickupLocation {id, name}?, returnLocation {id, name}?,
rentalAgreement {id, balance, total}?`.

**`Vehicle`** — sub-shape de card (`id, make, model, year, internalNumber, plate`) +
campos del listado `GET /api/vehicles` que la app use (status, vin, color, mileage,
vehicleTypeId — `schema.prisma:776-816`). Fixture del endpoint real antes de congelar;
no inventar campos.

**`InspectionUpload`** — modelo local (viaja por outbox) que mapea el contrato de
`mobile-inspection.routes.js`:
- foto: `POST /api/mobile-inspection/:token/photo` `{angleKey, photoDataUrl, notes?}` →
  `{angleKey, captured}`;
- cierre: `POST /:token/complete` `{signatureDataUrl?, signerName?, odometer?, fuelLevel?,
  cleanliness (1..5)?, notes?}` → `{ok, photoCount, hasSignature}`.
`angleKey` ∈ los 8 canónicos (`mobile-inspection.service.js:35-44`). El DTO local guarda
además `checkoutSessionId` y `reservationId` para poder re-mintear token al drenar (§5).

### 2.2 Mapeo de errores (DoD #5)

- **401** → limpiar sesión, ruta de re-login. Sin retry de refresh.
- **403** con `code: PASSWORD_CHANGE_REQUIRED` → ruta bloqueante de cambio de contraseña.
  403 **sin** `code` en rutas con `x-view-location` → negativa de ubicación (ofrecer
  cambiar de ubicación, nunca "no hay datos" — REGROUND §1). 403 con mensaje de módulo →
  banner de acceso denegado.
- **409** → códigos de ADR-4: `ILLEGAL_TRANSITION`, `ENTRY_GUARD`, `SESSION_TERMINAL`,
  `VEHICLE_CONFLICT`, `CHECKOUT_TERMINAL` ⇒ re-fetch `GET /:id` (o by-reservation) y
  reconciliar UI. `PAYMENT_REQUIRED`/`ID_VERIFY_REQUIRED` solo existen en kiosk.
  **Más dos que traen la fila fresca y NO necesitan re-fetch** (2026-08-17):
  `STALE_VERSION` (M2-P2 — sólo si mandaste `expectedVersion`) y
  `CONCURRENT_MODIFICATION` (M2-H8 — perdiste la carrera de escritura 3 veces
  seguidas; raro, pero es un 409 real). Los dos llevan la sesión completa en
  `body.session`: reconciliar **desde ahí** y no disparar el GET. Listarlos es
  obligatorio — un 409 que no esté en esta lista cae en el manejador genérico
  del cliente y se muestra como error crudo.
- **200 en `POST /transition`** puede significar "otra superficie ya hizo exactamente
  esta transición" (M2-H8): `transition()` es idempotente cuando la sesión ya está en
  `toStep`, así que un doble-submit o una carrera devuelven la fila fresca en vez de
  `ILLEGAL_TRANSITION`. La app **no** debe asumir que un 200 significa "yo la moví":
  la atribución está en el último evento `TRANSITION` de `events[]`, no en el 200.
  Pedir un paso ya PASADO sigue siendo `ILLEGAL_TRANSITION`.
- **410** (rutas de token): `TOKEN_INVALID|TOKEN_WRONG_KIND|TOKEN_EXPIRED|TOKEN_CONSUMED`
  ⇒ re-mint (autenticado) o abortar el drenado de esa cadena.
- **422**: `PRECHECKIN_REQUIRED`, `AGE_RULES_*`, `NO_VEHICLE_ASSIGNED` ⇒ blockers de paso 1
  del wizard con acción sugerida.
- **429** → backoff exponencial con jitter; el dashboard usa polling, respetar `Retry-After`.

## 3. Estado (Riverpod 3.x) y navegación (go_router)

`core/session` providers:
- `tokenProvider` (Notifier persistido en flutter_secure_storage): JWT + exp decodificado.
- `sessionUserProvider`: `SessionUser` del último login/me/refresh; expone
  `mustChangePassword`, `moduleAccess`, `role`.

> **Desviación aceptada (H1, review de Innovation):** `tokenProvider` y
> `sessionUserProvider` NO existen como providers separados — se fusionaron en
> `sessionControllerProvider` (`core/session/session_controller.dart`), un solo
> `Notifier<SessionState>` con `{status, token, user, passwordChangeRequired}`.
> Razón: token y user cambian JUNTOS (login, refresh, change-password) y dos
> providers separados abren carreras token-nuevo/user-viejo. H2+ debe leer
> `sessionControllerProvider`, no buscar los providers de esta lista. El flag
> `passwordChangeRequired` vive en el estado (no en el user) para que un 403
> del gate observado con `user == null` (restore sin red) también bloquee.
- `activeLocationProvider`: ubicación activa (persistida; null = todas las del usuario).
  Alimenta el `ViewLocationInterceptor` y se escribe en cada fila nueva del outbox.
- `pinLockProvider`: estado de bloqueo por PIN/biometría (timeout de inactividad;
  pregunta abierta §9-6 del plan: no debe saltar a mitad de la firma del cliente).

Por feature: `dashboardProvider` (AsyncNotifier con polling + pull-to-refresh),
`checkoutSessionProvider(reservationId)` (fuente: `GET /by-reservation/:rid`, ADR-4),
`inspectionCaptureProvider`, `outboxProvider` (stream de Drift).

go_router con `ShellRoute` (scaffold con bottom nav + banner de ubicación activa) y
guards en `redirect`, en orden:
1. **auth**: sin token válido → `/login`.
2. **password-gate**: `mustChangePassword == true` (o cualquier 403
   `PASSWORD_CHANGE_REQUIRED` observado) → `/change-password` bloqueante; al éxito el
   backend devuelve `{token, user}` fresco (`auth.service.js:264-292`) — intercambiar el
   JWT sin re-login. El refresh sigue vivo durante el gate (allowlist,
   `middleware/auth.js:15-19`).
3. **PIN lock**: sesión válida pero bloqueada → `/lock`.
RBAC de rutas: esconder por `moduleAccess`, pero manejar el 403 del backend igualmente
(DoD #4).

## 4. Persistencia — bandeja de salida (Drift + SQLCipher, ADR-7)

Base cifrada (sqlcipher_flutter_libs; llave por instalación en Keychain/Keystore).
Esquema propuesto:

```dart
class OutboxEntries extends Table {
  TextColumn get id => text()();                  // uuid v4
  TextColumn get userId => text()();              // dueño — se rechaza al cambiar cuenta
  TextColumn get tenantId => text()();
  TextColumn get locationId => text().nullable()(); // ubicación activa al crear (REGROUND §1)
  TextColumn get kind => text()();                // inspectionPhoto | inspectionComplete | ...
  TextColumn get payload => text()();             // JSON del DTO (fotos: ruta de archivo cifrado, no blob)
  TextColumn get dependsOn => text().nullable()(); // id de la entrada previa de la cadena
  TextColumn get idempotencyKey => text()();      // uuid; header Idempotency-Key al enviar
  IntColumn  get attempts => integer().withDefault(const Constant(0))();
  TextColumn get lastError => text().nullable()();
  DateTimeColumn get createdAt => dateTime()();
  TextColumn get status => textEnum<OutboxStatus>()(); // pending | inflight | dead
  @override Set<Column> get primaryKey => {id};
}
```

Reglas (M0-7): orden de drenado por `createdAt` respetando `dependsOn` (complete depende
de sus fotos); `attempts` con backoff, a `dead` tras N intentos (dead-letter **visible** al
usuario con acción de reintento/descarte); tope de tamaño (bytes) con rechazo de captura
nueva al llegar; purga de la fila y su archivo al confirmar el server; filas de otro
`userId`/`tenantId` se rechazan o borran al cambiar de cuenta. **Dinero jamás entra al
outbox** (ADR-5): `charge-sale`, `hold-deposit`, `record-manual-payment`,
`record-manual-deposit` son síncronos y en primer plano.

**Drenado en Dart plano** (sin `ProviderContainer` — el isolate de background no lo ve):
`outbox/drain.dart` recibe `{db, dio factory, token}` como argumentos puros. Condicionado
al spike M0-1a (lectura de token seguro desde isolate); si falla, drenar solo con la app en
primer plano. Para `MOBILE_INSPECTION` con TTL 15 min: al drenar, re-mintear token vía
`POST /api/checkout-sessions/:id/handoff-token` (autenticado; idempotente si quedan >2 min
— `checkout-session.service.js:717-734`) y usar el token fresco contra
`/api/mobile-inspection/:token/*`. Ojo: `complete` consume el token
(`mobile-inspection.service.js:282-284`) — nunca encolar dos `complete` de la misma sesión.
Prueba del spike M0-1b: capturar offline → esperar >15 min → reconectar → la foto llega;
si no se resuelve en cliente, escalar (gap #2 del plan).

## 5. Cámara (M1)

`camera` package con controlador de vida corta: abrir → capturar → **comprimir
inmediatamente** (flutter_image_compress, target ~1600px lado largo / calidad ~70, techo
<2 MB — el límite del router es 15 MB por body,
`mobile-inspection.routes.js:21`) → escribir archivo cifrado → fila outbox → **liberar el
controlador** antes de la siguiente vista. Nunca retener bytes sin comprimir en memoria; a
la tercera foto sin liberar, OOM en gama media (riesgo §7 del plan). Data-URL
(`data:image/jpeg;base64,...`) se construye al drenar, no al capturar.

## 6. l10n (ADR-8)

`flutter gen-l10n` desde el primer commit: `app_es.arb` (default) + `app_en.arb`. Regla de
lint: cero literales de UI en código (custom lint o revisión de PR); textos del backend
(mensajes 4xx) se muestran tal cual solo como detalle secundario — el título del error
siempre localizado. Formatos de fecha/moneda por `intl` con locale del dispositivo.

## 7. Flavors y CI (M0-2/3/8)

- **Flavors** dev/stg/prod: `applicationId`/`bundleId` propios
  (`com.ride.rideops[.dev|.stg]`), `--dart-define-from-file=env/<flavor>.json` con
  `API_BASE_URL`, flags de telemetría. Iconos diferenciados en dev/stg.
- **CI** (GitHub Actions o Codemagic, con justificación escrita en el PR de M0-3):
  `flutter analyze` + `flutter test` + build firmado Android/iOS + símbolos a
  Crashlytics/Sentry.
- **Paridad de enums** (M0-8): script Node/Dart en CI que parsea
  `backend/prisma/schema.prisma` (regex de bloques `enum X { ... }`: `CheckoutStep`
  :5053-5065, `UserRole` :89-94, `HandoffTokenKind` :5113-5117) y `CHECKOUT_STEPS` de
  `backend/src/modules/checkout-session/state-machine.js:41-53`, y los compara contra los
  enums Dart generados/escritos en `core/api/enums.dart`. Cualquier drift ⇒ build ROJO.
  No leer del OpenAPI (rutas sin tipar, ADR-2). Verificación extra: `CheckoutStep`
  (prisma) ≡ `CHECKOUT_STEPS` (JS) — hoy son idénticos; si divergen es bug de backend y
  se reporta, no se "arregla" en la app.

## 8. Orden de construcción (traza a milestones del plan)

M0: spikes 1a/1b → esqueleto+flavors → CI → telemetría → `core/api` + 6 DTOs con fixtures
→ refresh proactivo → outbox → paridad de enums. M1: auth (login + cambio forzado + PIN)
→ shell RBAC + selector de ubicación → dashboard (9 colas) → captura de inspección.
M2: wizard checkout (bloqueado por §9-1). M3: check-in/returns + loaner + búsqueda.
M4: push (`StaffDevice`, gap #1) + hardening.
