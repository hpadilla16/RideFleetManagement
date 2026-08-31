# 00-REGROUND — RideOps vs. main @ 6d8173c (2026-08-16)

> **Estado del paquete de planificación: FALTANTE.** `RideOps-planning-package.zip` no está
> en esta máquina (buscado: repo, clones alternos, Downloads, Desktop, Documents, perfil
> completo, C:\Projects). Este documento registra la verificación de los cuatro cambios del
> backend contra main; las referencias a qué sección del plan invalida cada punto se
> completarán cuando el paquete esté en `ops-app-plan/`.
>
> Nota de línea base: el prompt citaba main @ c1b8c769; ese commit (el location switcher,
> 2026-08-11) es ancestro del main actual 6d8173c. Todo lo verificado aquí es contra 6d8173c.

---

## 1. Selector de ubicación por header (`x-view-location`) — CONFIRMADO

**Qué es.** Desde 2026-08-11, el cliente puede mandar `x-view-location: <locationId>` y
`requireAuth` reduce `req.user.locationIds` a esa sola ubicación **antes** de que corra
cualquier ruta. Un solo chokepoint; ningún endpoint sabe que la feature existe.

**Evidencia.**
- Lógica pura: `backend/src/lib/view-location.js` (todo el archivo, 52 líneas).
- Aplicación en middleware: `backend/src/middleware/auth.js:64-78`.

**Semántica verificada:**
- Usuario RESTRICTED (con `locationIds` no vacío) que pide una ubicación fuera de su set →
  **403 duro** con body `{ "error": "You do not have access to that location." }`
  (`auth.js:75`). ⚠️ **Sin campo `code`** — a diferencia del gate de contraseña, este 403 no
  trae código de máquina. La app debe tratar cualquier 403 en rutas con el header como
  negativa de acceso (y ofrecer cambiar de ubicación), no como "no hay datos".
- Usuario UNRESTRICTED: el pick se aplica sin chequeo de DB — toda query downstream sigue
  AND-eando `tenantId`, así que un id ajeno solo produce resultados vacíos (fail-closed).
- Service accounts: el header se **ignora** silenciosamente (`view-location.js:42`), no falla.
- El override solo **encoge** el alcance; nunca lo amplía.

**Impacto en la app:**
- El header entra al stack de interceptores de Dio (solo rutas autenticadas de staff).
- La ubicación activa entra al estado de sesión (Riverpod) y persiste entre arranques.
- Matiza el ADR-3 [pendiente de citar §]: el tenant sigue siendo claim del JWT y no se toca;
  el alcance de ubicación ahora sí viaja por header.
- Las filas de la bandeja de salida deben registrar con qué ubicación activa se crearon, para
  que el drenado reproduzca el contexto correcto.

## 2. Módulo kiosk — CONFIRMADO: cuarta superficie sobre la MISMA sesión

**Estructura.** `backend/src/modules/kiosk/` (~9,200 líneas, 12 archivos). Dos routers sobre
`/api/kiosk` (`main.js:313-314`): uno device-facing autenticado por header `X-Kiosk-Token`
(pairing, sessions, lookup, attach, assign-vehicle, offers, OCR, verify-id, sign, complete,
staff-assist, escalate) y uno admin bajo `requireAuth + requireModuleAccess('kiosk')`
(gestión de dispositivos, upsell rules, packages, key-handoff, config VozIA).

**Misma máquina de estados, sin fork.** `KioskSession` (schema.prisma:5606-5683) es
*telemetría paralela*, no una segunda state machine: guarda `checkoutSessionId String?`
(referencia suelta, sin FK) y su `step` es explícitamente "telemetry ONLY". El código lo
declara: *"the kiosk never grows a second state machine"* (`kiosk-checkout.service.js:6-8`).
El kiosk crea/adopta la CheckoutSession real vía `createForReservation` (idempotente por
`reservationId @unique`) y su `sign` recorre **todas las transiciones restantes hasta CLOSED
en un loop secuencial sin transacción** (`kiosk-checkout.service.js:764-775`).

**Continuación cruzada:** funciona en ambos sentidos (staff→kiosk adopta la sesión existente
y respeta `currentStep`; kiosk→staff porque `/api/checkout-sessions/*` opera la misma fila).
Fricciones verificadas:
- El kiosk exige `paymentCompletedAt` antes de firmar (409 `PAYMENT_REQUIRED`) y exige
  `KioskSession.idVerifiedAt` (409 `ID_VERIFY_REQUIRED`). Ese `idVerifiedAt` vive en
  `KioskSession`, **no** en `CheckoutSession` → una verificación de ID hecha en mostrador o
  en RideOps **no** satisface el gate del kiosk, y viceversa. Si RideOps verifica ID en
  patio, hay que decidir dónde persiste esa evidencia (hoy no hay columna compartida).
- Sesión terminal → 409 `SESSION_TERMINAL`.

**Concurrencia (relevante para la pregunta abierta de §9):** no hay versioning optimista ni
ETag en `CheckoutSession`; la protección real es la state machine (409 `ILLEGAL_TRANSITION`,
*intencionalmente* no idempotente en el money-path — `checkout-session.service.js:380-391`),
entry guards (409 `ENTRY_GUARD`), claim atómico de vehículo, y unicidad de sesión por
reserva. Huecos: `stampSideEffect` es read-then-write sin guard, y el loop de `sign` del
kiosk puede quedar a medias si otra superficie transiciona en paralelo (sin rollback). Con
cuatro superficies (mostrador web, precheckin/mobile-inspection, kiosk, RideOps), la
historia de reconciliación "409 → re-fetch GET /:id → reconciliar" sigue siendo el contrato,
pero los códigos a manejar son: `ILLEGAL_TRANSITION`, `ENTRY_GUARD`, `SESSION_TERMINAL`,
`VEHICLE_CONFLICT`, `CHECKOUT_TERMINAL`.

> **SUPERADO por M2-P2 y M2-H8 (2026-08-17). El párrafo de arriba se conserva como
> registro de lo que era cierto cuando se escribió; lo que sigue es el contrato vigente.**
>
> - **Sí hay versioning optimista**: `CheckoutSession.stateVersion` (P2), **opt-in**. El
>   cliente que manda `expectedVersion` recibe 409 `STALE_VERSION`; el que no lo manda no
>   nota nada. No es un ETag, pero cubre la misma necesidad.
> - **`transition()` ya NO es "intencionalmente no idempotente"** — H8 **revierte esa
>   decisión deliberada**, y por eso se documenta aquí en vez de dejarlo como efecto
>   lateral de un PR. La regla nueva, exacta:
>   - `toStep` == el paso en el que la sesión YA está → **200 con la fila fresca**. No
>     aparece evento nuevo (la atribución sigue nombrando a quien de verdad la movió) y no
>     sube `stateVersion`. Cubre tanto la carrera entre superficies como el doble-submit
>     sin carrera, porque `canTransition(S, S)` es `false` en ambos casos: el endpoint
>     queda **propiamente idempotente**, no sólo tolerante a carreras.
>   - `toStep` **más atrás** que el paso actual → sigue siendo 409 `ILLEGAL_TRANSITION`
>     duro. "Ya estoy ahí" no es "ya pasé de largo".
>   - Mandar `expectedVersion` **desactiva** la idempotencia: ese llamador pidió enterarse
>     y recibe `STALE_VERSION` con la fila fresca.
>   - El money-path no se debilita: `spin-charge` gatea el cobro por `currentStep` de forma
>     independiente, así que un 200 en `→ PAID` nunca autoriza un segundo cargo.
> - **El commit es compare-and-set** (`updateMany` condicionado por `currentStep`, y por
>   `stateVersion` cuando vino `expectedVersion`), así que el TRANSITION duplicado y la
>   ventana TOCTOU de `assertExpectedVersion` están cerrados.
> - **Hueco que sigue abierto**: `stampSideEffect` sigue siendo read-then-write sin candado
>   (H8 no se lo aplica a propósito: no tiene contra qué comparar, y el único guardia
>   análogo rompería los re-stamps legítimos). Y `events` sigue siendo una columna TEXT con
>   **14 escritores sin candado**, de los cuales H8 sólo serializa `transition` contra
>   `transition`.
> - **Códigos 409 nuevos a manejar**: `STALE_VERSION` (P2) y `CONCURRENT_MODIFICATION`
>   (H8). Ambos traen la fila fresca en `session`, así que para ELLOS el re-fetch del
>   contrato "409 → GET /:id" ya no hace falta.

**Device pairing como base para registro de dispositivos de staff: patrón sí, tabla no.**
- Lo copiable: higiene criptográfica completa y probada — token hash-only (SHA-256, plaintext
  nunca persiste), `timingSafeEqual`, rotate/revoke con `tokenVersion`, heartbeat
  `lastSeenAt` con throttle 30s, `appVersion`, `connectivity` ONLINE/OFFLINE
  (`kiosk-device.service.js`, `kiosk-auth.middleware.js`).
- Lo que lo descarta como tabla: `KioskDevice` no tiene `userId` (es un mueble del lobby
  atado a `(tenantId, locationId NOT NULL FK)`), su token no expira, y su middleware no
  produce `req.user` — ninguna ruta de negocio autenticada funcionaría con él.
- **Push: greenfield total.** No existe ningún campo/tabla/servicio de push token en todo el
  repo (grep exhaustivo). El gap #1 del plan sigue 100% abierto; el atajo real es una tabla
  nueva `StaffDevice { userId, tenantId, pushToken, platform, appVersion, lastSeenAt,
  revokedAt }` copiando el patrón criptográfico de `KioskDevice`.

**OCR de ID reutilizable con reservas.** `extractLicenseFront`
(`kiosk-id-ocr.extract.js:77`) llama la API de Anthropic (Haiku) de forma síncrona en el
request; API key en cascada settings-del-tenant → env → 503. Límites de coste in-memory
(5/sesión, 15/dispositivo/hora) que no sobreviven reinicios. Utilizable desde RideOps vía un
endpoint autenticado nuevo, pero a escala de flota querrá cola/worker.

**Implicación de arquitectura para RideOps:** consumir `/api/checkout-sessions/*` con
`requireAuth` (auditoría por `actorUserId` en cada transición), **no** el router de kiosk
(sin identidad de usuario). `GET /api/checkout-sessions/by-reservation/:reservationId` es la
fuente de verdad para renderizar.

## 3. Primer login forzado (`mustChangePassword`) — CONFIRMADO

**Qué es.** Mientras `User.mustChangePassword` sea `true` (contraseña temporal al crear el
usuario, o reset por admin), la sesión humana solo alcanza 3 endpoints; todo lo demás
responde **403** con `{ "code": "PASSWORD_CHANGE_REQUIRED" }`.

**Evidencia.**
- Gate y allowlist: `backend/src/middleware/auth.js:8-19,49-60`. Allowlist exacta:
  `POST /api/auth/change-password`, `GET /api/auth/me`, `POST /api/auth/refresh`.
- Endpoint de cambio: `backend/src/modules/auth/auth.routes.js:70-88` — body
  `{ currentPassword, newPassword }`; exige la contraseña actual incluso en flujo forzado;
  valida política con `validatePassword`; errores 400 con mensaje.
- Servicio: `backend/src/modules/auth/auth.service.js:264-291` — es el ÚNICO camino que
  limpia el flag; **devuelve `{ token, user }` fresco**, así que el cliente intercambia su
  JWT y el gate se levanta sin re-login.
- El flag viaja en el objeto de sesión: `auth.service.js:110` (`buildSessionUser`), presente
  en la respuesta de login y de `/me`.

**Impacto en la app (M1):**
- Pantalla de cambio forzado de contraseña requerida desde M1 — sin ella un empleado nuevo
  no pasa del login. El plan no la contempla [pendiente de citar §].
- Flujo: detectar `user.mustChangePassword === true` en la respuesta de login (o un 403 con
  `code: PASSWORD_CHANGE_REQUIRED` en cualquier llamada) → ruta bloqueante de cambio →
  al éxito, guardar el `token` devuelto y continuar.
- El refresh sigue vivo durante el gate (está en la allowlist), así que el refresco proactivo
  del ADR-3a no necesita caso especial.

## 4. Branding por tenant — CONFIRMADO, con matices

**Dónde vive.** No en un modelo dedicado: config key/value en `AppSetting` con prefijo
`tenant:<id>:` — defaults en `backend/src/modules/settings/settings.service.js:15-50`
(`companyName: 'Ride Fleet'`, `companyLogoUrl`, `emailBrandColor`, `emailFromAddress`, …).
Precedencia en documentos: location > franchise > tenant global
(`backend/src/modules/rental-agreements/rental-agreements.service.js:3532-3558`).
Email brand: `backend/src/lib/email-template.js` (`resolveEmailBrand`, ~35 consumidores).
Remitente por tenant con fallback de plataforma: `backend/src/lib/mailer.js:187-230`.

**Lo que toca a la app de staff:**
- Los PDFs/correos que el staff dispara **ya llevan branding del tenant, resuelto en el
  servidor**: agreement print/PDF/email (`rental-agreements.routes.js:201-211,217,724`),
  recibo post-check-in (`checkin-close.service.js:362` → `checkin-emails.service.js:115-125`),
  loaner statements, affidavits de citación. La app no tiene que hacer nada — pero **no debe
  hardcodear "Ride Fleet"** en visores de PDF, asuntos/previews de correo, ni en ninguna
  pantalla que el empleado voltee hacia el cliente (firma en tablet incluida).
- Las superficies de staff puras NO sirven branding: `GET /api/employee-app/dashboard`
  (`employee-app.service.js:451-497`) y `GET /api/auth/me` no traen nombre ni logo de tenant.
  Hardcodear la marca RideOps/Ride Fleet en el chrome interno de la app (splash, about) es
  defendible hoy.
- Si una pantalla necesita branding para mostrar al cliente, ya existe patrón:
  `GET /api/reservations/:id/display-data` devuelve `branding: { companyName,
  companyLogoUrl, companyPhone }` (`reservations.routes.js:588-627`) — es lo que usa el
  customer-display web. Preferir esto sobre `GET /api/settings/rental-agreement`, que exige
  módulo `settings` y expone plantillas y `emailFromAddress` a cualquier AGENT.
- No existe `GET /api/tenant/branding` dedicado. Si el M2+ lo necesita, pedirlo al backend
  en vez de reusar el endpoint de settings.

## Lo re-confirmado del prompt (sin re-auditar, spot-check solamente)

- `POST /api/checkout-sessions/:id/handoff-token`: emite `MOBILE_INSPECTION` con TTL 15 min
  en router autenticado — el choque con la bandeja offline sigue vigente (spike M0 #2).
- `POST /api/auth/refresh` detrás de `requireAuth`, sin rotación de refresh token — el
  refresco proactivo (exp − 60s, con mutex) sigue siendo la respuesta correcta; verificado
  además que el refresh sobrevive al gate de contraseña (punto 3).
- Sin registro de dispositivos de staff ni push — gap #1 sigue abierto; ver §2: el pairing
  del kiosk sirve de patrón criptográfico pero no de esquema (no tiene `userId`).

## Qué invalida del plan

El paquete original (escrito contra e24d5c7) se perdió — nunca se commiteó y el zip no
está en la máquina (verificado 2026-08-16: working tree, historial completo de git en
todas las ramas, stashes, clones alternos, filesystem). Con el OK de Hector, el plan se
reconstruyó desde cero en [PROJECT_PLAN.md](PROJECT_PLAN.md), que ya integra los cuatro
puntos de este documento:

- Punto 1 (x-view-location) → matiza el **ADR-3** y entra al stack de interceptores (M0-5).
- Punto 2 (kiosk) → alimenta la **pregunta abierta §9-1** (cuatro superficies), el
  **gap #4** (`idVerifiedAt`) y el **gap #1** (patrón StaffDevice para push).
- Punto 3 (mustChangePassword) → pantalla de cambio forzado añadida al **M1**.
- Punto 4 (branding) → regla "no hardcodear marca en superficies volteadas al cliente"
  en M1/M2; endpoint `display-data` como patrón.
