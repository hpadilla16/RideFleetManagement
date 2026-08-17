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
3. **403 del selector de ubicación sin `code`.** Nice-to-have: que el backend agregue
   `code: 'VIEW_LOCATION_DENIED'` para distinguirlo por máquina.
4. **`idVerifiedAt` vive solo en `KioskSession`.** Si RideOps verifica ID en patio, la
   evidencia no es visible a otras superficies; decidir dónde persiste (probable pedido de
   columna en `CheckoutSession`).
5. **Sin versioning optimista en `CheckoutSession`** — la reconciliación multi-superficie
   depende solo de la state machine (ver §9, pregunta 1).

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

### M2 — el épico de checkout
Wizard server-driven sobre `/api/checkout-sessions/*` (con identidad de usuario, nunca el
router de kiosk). Dinero síncrono (ADR-5), preview del servidor (ADR-6), firma del cliente.
**Bloqueado por la pregunta abierta §9-1** (cuatro superficies).

### M3 — returns, loaner y colas restantes
Check-in/return flow, colas de loaner (4 de las 9), issue escalations, búsqueda.

### M4 — hardening y push
Registro de dispositivos + push (si se aprueba el pedido de backend), modo kiosco para
firma (si §9-6 dice que sí), tablet/iOS según §9-4.

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

1. ¿RideOps es el checkout principal o convive con los otros? Con el kiosco son **cuatro**
   superficies sobre la misma sesión. Si conviven, hace falta historia de reconciliación
   más allá del 409 (no hay versioning optimista) y el épico M2 cambia de tamaño.
   **Decidir antes del M2.**
2. Si el spike del token falla, ¿se aprueba pedir al backend un endpoint de fotos
   autenticado por JWT y sin TTL corto?
3. ¿Se lanza el MVP sin push, solo con polling?
4. Parque de aparatos: ¿Android de gama media primero, iOS y tablet después?
5. ¿Se aceptan web views autenticadas para la cola larga?
6. Cuando el cliente firma en el aparato del empleado, el bloqueo por inactividad no debe
   saltar a mitad de la firma. ¿Hace falta un modo kiosco?

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
