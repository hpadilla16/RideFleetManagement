# RideOps — PROJECT_PLAN (reconstrucción v2, 2026-08-16)

> **Procedencia.** El paquete de planificación original (escrito contra e24d5c7) se perdió —
> nunca se commiteó y el zip no está en la máquina. Este documento lo reconstruye desde:
> (a) las decisiones ya tomadas que Hector preservó en el prompt de arranque,
> (b) la verificación fresca contra main @ 6d8173c ([00-REGROUND.md](00-REGROUND.md)),
> (c) el codebase real. Donde el original tenía detalle que no sobrevivió (los 12 puntos
> exactos del DoD, los 6 mockups), se marca `[reconstruido]` y se re-deriva con criterio.

## 1. Qué es RideOps

App nativa de Flutter para el personal de patio de Ride Fleet — roles **ADMIN / OPS /
AGENT**. Consume la API REST existente de RideFleetManagement (Node/Express + Prisma) sin
tocarla. El aparato de verdad: Android de gama media, en un patio, con Wi-Fi malo, a pleno
sol, con una sola mano.

Lo que justifica lo nativo es **la cámara en el patio**, no los formularios: captura de
inspección (fotos de daños, odómetro, combustible, firma) que no puede depender de la red.

## 2. Línea base verificada

main @ 6d8173c (2026-08-16). Todo lo siguiente está verificado contra ese commit — detalle
y números de línea en [00-REGROUND.md](00-REGROUND.md):

- Checkout: máquina de 11 estados server-driven, transiciones lineales estrictas, 409 en
  out-of-order (`backend/src/modules/checkout-session/state-machine.js`). Entry guards:
  `TC_SIGNED←tcCompletedAt`, `PAID←paymentCompletedAt`,
  `CUSTOMER_SIGN_PENDING←inspectionCompletedAt`, `CLOSED←customerSignedAt`.
- `POST /api/checkout-sessions/:id/handoff-token` emite `MOBILE_INSPECTION` con TTL 15 min
  (router autenticado, `checkout-session.routes.js:161`).
- `GET /api/employee-app/dashboard`: `{ query, self{profile,commissions}, metrics(11),
  queues(9), searchResults }` (`employee-app.service.js:451-497`).
- `POST /api/auth/refresh` detrás de `requireAuth`; sin rotación de refresh token.
- **Nuevo desde el plan original:** selector de ubicación por header `x-view-location`
  (403 duro sin `code` para RESTRICTED fuera de set); gate de primer login
  (`PASSWORD_CHANGE_REQUIRED`, allowlist de 3 endpoints); módulo kiosk = cuarta superficie
  sobre la misma sesión; branding por tenant en PDFs/correos que el staff dispara.
- Push / registro de dispositivos de staff: **no existe nada** (gap #1). El pairing del
  kiosk aporta patrón criptográfico, no esquema.

## 3. ADRs — decisiones cerradas (no reabrir sin argumento a Hector)

- **ADR-1 · Nativo para el bucle diario, web views para la cola larga.** Editor de tarifas,
  administración de personal, configuración de peajes y PDFs se quedan en web. La cámara y
  el offline del patio son la razón del nativo.
- **ADR-2 · Stack:** Riverpod 3.x · go_router con ShellRoute · **Drift** (no Isar) ·
  retrofit+dio+freezed **escritos a mano** sobre los endpoints que de verdad se usan. Nada
  de codegen desde OpenAPI (rutas sin tipar ⇒ modelos inútiles); se versiona una copia de
  `openapi.json` solo para diff.
- **ADR-3 · Tenancy y alcance:** el tenant es claim del JWT y no se toca. *(Matiz 2026-08:
  el alcance de ubicación ahora viaja en el header `x-view-location`; entra al stack de
  interceptores y la ubicación activa vive en el estado de sesión.)*
- **ADR-3a · Refresco proactivo de token:** decodificar `exp` y refrescar ~60 s antes, con
  mutex anti-duplicado. **No** refrescar al recibir 401: si el JWT venció, el propio
  refresh también da 401. Un JWT vencido = re-login.
- **ADR-4 · El servidor manda en la máquina de estados.** Se renderiza desde `currentStep`
  (`GET /api/checkout-sessions/by-reservation/:reservationId` es la fuente de verdad); un
  409 se resuelve re-consultando `GET /:id` y reconciliando. Prohibido construir una copia
  de la máquina en Dart o reproducir un paso sellado. Códigos 409 a manejar:
  `ILLEGAL_TRANSITION`, `ENTRY_GUARD`, `SESSION_TERMINAL`, `VEHICLE_CONFLICT`,
  `CHECKOUT_TERMINAL`.
- **ADR-5 · El dinero nunca se encola offline.** `charge-sale`, `hold-deposit`,
  `record-manual-payment`, `record-manual-deposit`: síncronos, en primer plano, solo con
  conexión. Las llaves de idempotencia cubren el reintento dentro de un intento en vivo —
  no autorizan reproducir una autorización de tarjeta más tarde.
- **ADR-6 · La cuenta la hace el servidor.** El cálculo en cliente es solo para respuesta
  instantánea de pantalla; el número que el cliente firma viene del preview del servidor.
  Si divergen, gana el servidor y el usuario re-confirma.
- **ADR-7 · Bandeja de salida cifrada (SQLCipher), purga al drenar.** Guarda PII (nombres,
  firmas, fotos de daños, documentos) en un teléfono compartido de patio. Filas atadas a
  usuario + tenant (+ ubicación activa) que las creó; se rechazan o borran al cambiar de
  cuenta. Dead-letter visible al usuario; tope de tamaño.
- **ADR-8 · es/en desde el primer commit.** Ningún texto en el código — la lección del
  backend web que salió con inglés hardcodeado.

## 4. Gaps del backend (pedidos potenciales, no bloquear en ellos)

1. **Push/dispositivos de staff — greenfield total.** Propuesta lista: tabla
   `StaffDevice { userId, tenantId, pushToken, platform, appVersion, lastSeenAt,
   revokedAt }` copiando la higiene criptográfica de `KioskDevice` (hash-only,
   `timingSafeEqual`, rotate/revoke, heartbeat). MVP puede salir con polling (§9).
2. **Handoff token TTL 15 min vs. bandeja offline.** Si el spike M0-1b no lo resuelve en
   cliente, pasa a bloqueante de MVP: pedir endpoint de fotos autenticado por JWT sin TTL
   corto (§9).
3. **403 del selector de ubicación sin `code`.** ~~Nice-to-have~~ → **EN CURSO**: el
   PR-tren P1-P3 (feat/checkout-multisurface-p123) agrega `code: 'VIEW_LOCATION_DENIED'`;
   el cliente H4 ya acepta ambas variantes.
4. **`idVerifiedAt` vive solo en `KioskSession`.** Si RideOps verifica ID en patio, la
   evidencia no es visible a otras superficies; decidir dónde persiste (probable pedido de
   columna en `CheckoutSession`). P4 del M2-PLAN — diferido a M3 por Hector.
5. **Sin versioning optimista en `CheckoutSession`** — ~~depende solo de la state
   machine~~ → **EN CURSO**: P2 (`stateVersion`) en el PR-tren; el CAS de `transition()`
   queda como M2-H8 obligatoria.
6. **El "hoy" del dashboard corta en TZ del servidor** (Innovation, review H4): el server
   calcula `startOfToday` en su TZ y el cliente clasifica "hoy" en TZ del dispositivo —
   divergen si difieren. Pedido de plataforma: cortar en TZ del tenant. No bloquea M1.
7. **El scope efectivo de programa se espeja en cliente** (tenant-scope.js → tabla Dart
   con test referenciado): a futuro, que `/me` o el dashboard expongan el scope EFECTIVO
   calculado por el server y el espejo muera.

### Enmiendas de mockup aceptadas por GD en builds (registro para training/M2)
- **Tanda B nota de motion (dot de frescura)**: latido ≤0.5 Hz sustituido por tick
  one-shot al refrescar (batería + testabilidad) — bendecido por GD para M1 (review H4).
- **Buscar (H4)**: pantalla aprobada como extensión del lenguaje sin frame propio;
  mini-frame a posteriori pendiente para la biblioteca de mockups (con filtros/detalle
  llega en M3).
- **Paso "¿Activar huella?" (H2)**: pantalla nueva sin frame propio, aceptada; mini-frame
  a posteriori pendiente.

## 5. Milestones

### M0 — la columna vertebral (nada de pantallas hasta que esté)
En orden:
1. **Spikes** (ambos pueden cambiar el plan):
   a. Leer el token seguro desde un isolate de background en iOS y Android
      (Keychain/Keystore históricamente fallan ahí). Si no es confiable, el drenado en
      background queda condicionado a hidratación del token en primer plano.
   b. Re-emisión del handoff token al drenar. Prueba que debe pasar: capturar offline →
      esperar >15 min → reconectar → la foto llega. Si no se resuelve en cliente ⇒
      escalar (gap #2).
2. Proyecto Flutter 3.35+/Dart 3.9+, FVM, versiones exactas de Riverpod y go_router,
   estructura por features, flavors dev/stg/prod con applicationId/bundleId propios.
3. CI (Codemagic o GitHub Actions, con justificación) — analyze, test, build firmado en
   ambas plataformas.
4. Observabilidad día uno: Crashlytics o Sentry, símbolos en CI, taxonomía de eventos.
   Sesiones-sin-crash es compuerta de release.
5. Cliente API a mano; **6 DTOs calientes** en freezed probados contra fixtures de JSON
   real: `SessionUser` (login/me), `DashboardPayload`, `CheckoutSession`,
   `ReservationCard`, `Vehicle`, `InspectionUpload`. Stack de interceptores SOLO en rutas
   autenticadas (bearer + `x-view-location` + refresh proactivo); rutas públicas de token
   por Dio limpio sin bearer de staff.
6. Refresco proactivo del token (ADR-3a).
7. Bandeja de salida: esquema Drift cifrado, drenado en Dart plano (el isolate de
   background no ve el ProviderContainer), ordenado por dependencias, llaves de
   idempotencia, dead-letter visible, tope de tamaño.
8. Chequeo de paridad de enums en CI, leído de `prisma/schema.prisma` y de
   `state-machine.js` — no del OpenAPI. Falla si hay drift.

### M1 — la cuña de captura (primera versión en teléfono real)
Login (+ pantalla de **cambio de contraseña forzado** — gate `PASSWORD_CHANGE_REQUIRED`),
bloqueo por PIN y biometría, shell con RBAC y **selector de ubicación**, home de
operaciones con las 9 colas del dashboard, captura de inspección nativa (cámara →
comprimir al tomar → soltar el controlador; pipeline offline vía bandeja).

#### Criterios registrados por revisiones H2/H3 (ciclo de review, 2026-08-16)
Compromisos que las revisiones de Innovation/GD dejaron para historias futuras — se
verifican en el DoD de la historia indicada:

- **H4 (home de operaciones):**
  - El chip de ubicación del shell pasa a estado **danger** mientras el dashboard esté
    en 403 por `x-view-location` (pantalla 4D): la negativa se ve donde se eligió la sede.
  - Todo provider de datos *scoped* por sede espera `ActiveLocation.hydrated == true`
    antes del primer fetch — jamás un fetch con el override a medio hidratar.
  - ANTES de construir la 4D: pedir al backend un `code: VIEW_LOCATION_DENIED` en el 403
    de view-location (hoy llega sin code — gap #3). Sin el code, la 4D no puede
    distinguir "sede negada" de un 403 de RBAC genérico.
- **H5 (captura de inspección / bandeja):**
  - Sellar el `locationId` activo en **cada fila del outbox al encolar** (REGROUND §1):
    el header del drenado no puede depender de la sede seleccionada al momento de drenar.
  - La UI de salida del modo kiosco (mantener 3 s + PIN) **limita reintentos de
    `checkPin`** — `checkPin` es puro y no cuenta intentos por diseño; el límite vive en
    la UI que lo llama.
- **M4 (hardening):**
  - `FLAG_SECURE`/privacy screen para el task switcher (el candado H2 protege la app
    viva, no la miniatura de recientes).
  - Candidato: blocklist de PINs triviales (1234, 0000, fechas) en el setup.
  - `verifyPin` distingue **error de Keystore vs PIN erróneo**: hoy un Keystore ilegible
    descuenta un intento como si el PIN fuera incorrecto.
- **M2 (checkout):**
  - La tab bar del shell solo adopta glass/`BackdropFilter` tras una señal real de
    capacidad del dispositivo, con el tope de **máx 1 BackdropFilter por pantalla**
    (política de blur de la nota 4 del mockup 4A).

### M2 — el épico de checkout
Wizard server-driven sobre `/api/checkout-sessions/*` (con identidad de usuario, nunca el
router de kiosk). Dinero síncrono (ADR-5), preview del servidor (ADR-6), firma del cliente.
**Bloqueado por la pregunta abierta §9-1** (cuatro superficies).

### M3 — returns, loaner y colas restantes
Check-in/return flow, colas de loaner (4 de las 9), issue escalations, búsqueda.

### M4 — hardening y push
Registro de dispositivos + push (si se aprueba el pedido de backend), tablet/iOS según
§9-4. *(El modo kiosco para firma se movió a M1-H5 — §9-6 resuelta el 2026-08-16.)*

## 6. Cómo trabajar

- Una historia por rama; flujo PM → build → Innovation + Graphic Design → QA (SHIP) →
  deploy → training, según CLAUDE.md. UI nueva requiere mockup aprobado por Hector ANTES
  de construir.
- Cada historia cierra con los 12 puntos del DoD (§10).
- Fotos: comprimir apenas se toman y soltar el controlador de la cámara — a la tercera
  foto sin liberar, la app muere por memoria en gama media.

## 7. Riesgos principales

| Riesgo | Mitigación |
|---|---|
| Spike token/isolate falla en una plataforma | Drenado condicionado a primer plano; decidir con evidencia |
| TTL 15 min mata fotos offline | Spike M0-1b; si falla, escalar pedido de backend (gap #2) |
| 4 superficies concurrentes sobre la misma sesión | §9-1 ANTES del M2; mientras, 409→re-fetch→reconciliar |
| Sin push: colas viejas en pantalla | Polling con backoff + pull-to-refresh honesto (§9-3) |
| PII en teléfono compartido | ADR-7 completo; filas atadas a cuenta; purga agresiva |
| OOM de cámara en gama media | Compresión inmediata, liberar controlador, prueba en aparato real |
| Drift del contrato API (rutas sin tipar) | Fixtures de JSON real + paridad de enums en CI + openapi.json versionado para diff |

## 8. Inventario de endpoints calientes

Auth: `POST /api/auth/login` · `POST /api/auth/refresh` · `GET /api/auth/me` ·
`POST /api/auth/change-password`.
Dashboard: `GET /api/employee-app/dashboard[?q=]`.
Checkout: `POST /api/checkout-sessions` · `GET /:id` · `GET /by-reservation/:rid` ·
`POST /:id/transition` · `/stamp` · `/customer-signature` · `/terms-token` ·
`/handoff-token` · `/send-customer-inspection` · `/vehicle` · `/charge` · `/charge-sale` ·
`/hold-deposit` · `/record-manual-payment` · `/record-manual-deposit` ·
`GET /:id/terminal-status` · `POST /:id/declined-insurance` · `/abandon`
(`checkout-session.routes.js:33-380`).
Branding para pantallas volteadas al cliente: `GET /api/reservations/:id/display-data`.

## 9. Preguntas abiertas — SOLO Hector decide; si el trabajo se topa con una, parar

1. ~~¿RideOps es el checkout principal o convive con los otros?~~
   **RESUELTA (Hector, 2026-08-17): CONVIVEN LAS CUATRO superficies** (mostrador web,
   precheckin del cliente, kiosco, RideOps) sobre la misma sesión, en simultáneo.
   Consecuencias asumidas para el M2:
   - El épico incluye una **historia de reconciliación multi-superficie** más allá del
     409→re-fetch: presencia/claim suave por sesión ("la está atendiendo X en Y"),
     detección de avance ajeno sin esperar al 409 (poll del `currentStep` mientras el
     wizard está abierto), y UX de "otra superficie completó este paso".
   - Requiere **pedidos al backend** (diseñar en el plan del M2, aprobar con Hector antes
     de tocar backend): mínimo un mecanismo de presencia/heartbeat por sesión de checkout
     y/o versioning optimista ligero; el loop de `sign` del kiosk sin transacción
     (REGROUND §2) se vuelve riesgo activo y entra a ese diseño.
   - El PM diseña el épico M2 con esto ANTES de que cierre H6 (orden de Hector
     2026-08-17: M2 arranca al terminar H6).
2. Si el spike del token falla, ¿se aprueba pedir al backend un endpoint de fotos
   autenticado por JWT y sin TTL corto?
3. ¿Se lanza el MVP sin push, solo con polling?
4. Parque de aparatos: ¿Android de gama media primero, iOS y tablet después?
5. ~~¿Se aceptan web views autenticadas para la cola larga?~~
   **RESUELTA (Hector, 2026-08-17): SÍ — y define el M5.** Web views autenticadas dentro
   de RideOps para editor de tarifas, administración de personal, config de peajes y
   reportes/PDFs. Sesión compartida vía token (hand-off seguro por diseñar: token de un
   solo uso o cookie bridge — probable pedido al backend), navegación integrada, la
   lógica sigue viva en el web sin duplicarse. Hoja de ruta ordenada por Hector:
   M0→M1→M2→M3→M4→**M5**, cada milestone dispara el siguiente.
6. ~~Cuando el cliente firma en el aparato del empleado, el bloqueo por inactividad no debe
   saltar a mitad de la firma. ¿Hace falta un modo kiosco?~~
   **RESUELTA (Hector, 2026-08-16): SÍ — Variante A, modo kiosco.** Barra persistente
   "Modo firma · bloqueo en pausa", lock por inactividad suspendido, notificaciones de
   staff silenciadas, navegación fuera del flujo de firma bloqueada, salida deliberada
   (mantener 3 s + PIN). Mockup de referencia: `mockups/m1-tanda-a-v2.html` pantalla 3C.
   Impacto de alcance: el modo kiosco sale de M4 y entra a la historia **H5 (captura de
   inspección)** del M1 — la firma del cliente no se construye sin él.

## 10. Definition of Done — 12 puntos por historia

Los cinco primeros son los que más se olvidan (preservados del plan original):
1. Textos en **es y en** (ningún string en código).
2. Objetivos táctiles **48 pt** y contraste **4.5:1**.
3. Ruta offline probada en **toda escritura no financiera**.
4. RBAC verificado **contra la API**, no solo escondiendo botones.
5. Estados de error de verdad manejados: **401 → re-login · 403 (incluido el del selector
   de ubicación) → negativa visible · 409 → reconciliar · 429 → backoff**.

`[reconstruido]` — los siete restantes re-derivados del criterio del equipo:

6. Tests: unit para lógica de dominio/providers, widget test para la pantalla nueva; todos
   verdes en CI.
7. `flutter analyze` limpio y formato aplicado; cero warnings nuevos.
8. Toda foto: comprimida al capturar, controlador de cámara liberado, probada en gama media.
9. Telemetría: eventos de la taxonomía para el flujo nuevo + sin crashes nuevos en la build.
10. Loading/empty/error states diseñados (no spinners eternos ni pantallas en blanco).
11. Revisión de Innovation (+ Graphic Design si toca UI con mockup aprobado) y QA **SHIP**.
12. `openapi.json` diffeado si el contrato cambió; fixtures de DTO actualizados.
