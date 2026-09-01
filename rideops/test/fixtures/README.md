# Fixtures de contrato API

Cada JSON está derivado **campo por campo del serializer real del backend** (main @
6d8173c) — no de OpenAPI ni de memoria. Si el backend cambia una forma, el fixture se
actualiza en el mismo PR (DoD #12). Los tests de DTO deserializan estos archivos.

| Fixture | Fuente (serializer) |
|---|---|
| `login_response.json` | `auth.service.js` `login()` → `{ token, user: buildSessionUser }` (:87-115, :250-255) |
| `dashboard.json` | `employee-app.service.js` `dashboard()` (:451-497), `reservationCard` (:66-122), `incidentCard` (:124-160) |
| `checkout_session.json` | fila Prisma cruda del modelo `CheckoutSession` (schema.prisma:5067-5111) vía `getById` (:276-280); `events` con la forma exacta de `appendEvent` (state-machine.js:111-117) — incluye una entrada del kiosco (`metadata.kiosk`, kiosk-checkout.service.js:769-774) y una entrada LEGACY sin `kind` |
| `checkout_session_presence.json` | la MISMA fila + lo que agrega el PR-tren P1-P3 (ya en main): `presence: [{surface, actorUserId, displayName, lastSeenAt}]` de `checkoutPresenceService.activePresence()` (:179-190) vía `withPresence()`, y la columna `stateVersion` de P2 (que el cliente LEE para descartar respuestas tardías; `expectedVersion` sigue sin enviarse — `STALE_VERSION` quedó FUERA del alcance de M2-H6). `actorUserId` llega **null a propósito** en el kiosco y el teléfono del cliente, que laten sin usuario. Las tres filas son deliberadas: un aparato, un compañero, y la propia (`RIDEOPS` con `kFixtureUserId`) para ejercitar el filtro de auto-supresión contra el payload real |
| `reservation_card.json` | `employee-app.service.js` `reservationCard` (:66-122) |
| `handoff_token.json` | `checkout-session.service.js` `mintHandoffToken` — re-leído 2026-09-01 (:1345-1355 reuso, :1391-1396 fresco): las dos ramas devuelven AHORA `signUrl` además de `{token, expiresAt, kind}`. Este fixture es un `MOBILE_INSPECTION`, así que su `signUrl` llega **null** — `publicUrlForToken` (:62-64) solo mapea `TERMS_SIGNING` y se niega a adivinar la ruta de los demás kinds |
| `handoff_token_terms.json` | el MISMO mint con `kind: TERMS_SIGNING` (:1395): `signUrl` absoluta armada con `signingBaseUrl()` (:45-52 — `APP_BASE_URL` → `FRONTEND_BASE_URL` → `CUSTOMER_PORTAL_BASE_URL`, sin barra final). Es la rama que el paso T&C consume para el QR, y por eso el host del fixture es un dominio de inquilino y NO el de la plataforma: el defecto que cerró era justamente que la app horneaba el origen en el APK |
| `mobile_inspection_state.json` | `mobile-inspection.service.js` `loadSession` (:118-143) |
| `locations_selectable.json` | `locations-selectable.routes.js` `GET /selectable` (:38-45 — `select: {id, code, name, city, state}`; array plano, sin envoltura) |
| `reservation_display_data.json` | `reservations.routes.js` `GET /:id/display-data` (:588-627 — `{reservation: getById+charges, insurancePlans, additionalServices, branding}`; branding con defaults `'Ride Fleet'`/`''` en :618-622; `reservation.vehicle` es la fila Prisma completa vía `include {vehicle: true}` de `getById` :1539-1580; `customer` y `rentalAgreement` con los `select` EXACTOS de `getById` :1540-1576 y :1585-1668, re-leídos para M2-H2) |
| `reservation_available_vehicles.json` | `reservations.routes.js` `GET /:id/available-vehicles` (:992-1092 — array PLANO con el `vehicleSelect` de :1003-1009; la unidad ya asignada viaja SIEMPRE y de primera, :1064-1067) |

Notas de forma que muerden:

- Fechas: ISO-8601 con `Z` (Prisma `DateTime` serializado por Express). Campos `*At`
  pueden ser `null`.
- `locationIds`: `null` significa TODAS las ubicaciones (usuario UNRESTRICTED) — no lista
  vacía. `[]` no ocurre (el backend lo normaliza a `null`).
- `estimatedTotal` y montos: pueden llegar como número o string decimal según la columna
  Prisma (`Decimal` serializa a string). El DTO debe aceptar ambos.
- `reservationCard.vehicle.plate` hace fallback `plate || licensePlate || ''` en servidor.
- `handoff_token` trae `reused: true` solo cuando devolvió un token existente.
- `reservation_display_data.reservation` es la fila COMPLETA (el `getById` usa `include`,
  no `select`): además de lo ya declarado trae `pickupAt` y `customerInfoCompletedAt`, que
  el header del wizard de checkout usa para responder "para cuándo" y si el pre-checkin
  está listo (M2-H1). El resto de columnas sigue ignorándose por json_serializable.
- **M2-H5** (`getById` re-leído en `reservations.service.js:1521-1584`): el mismo `include`
  trae `status` y `returnAt` —escalares de `Reservation`— y `returnLocation` como fila
  COMPLETA de `Location` (`include: {returnLocation: true}`). El fixture incorpora
  `returnLocation` con los campos que el select de `locations-selectable` ya declara
  reales. `status` es lo único con lo que el cierre puede VERIFICAR si la entrega quedó
  registrada: la sesión terminal no lo prueba, porque la cascada del finalize corre
  después del `CLOSED` y se traga varios de sus errores.
- `reservation_display_data.reservation.rentalAgreement` **no trae**
  `declinedInsurance`: el `select` de `getById` no la incluye (solo el select de LISTA,
  `reservations.service.js:285`). El fixture respeta esa ausencia a propósito — es la
  razón por la que RideOps deriva el switch del seguro desde el `events[]` de la sesión, y
  la razón por la que el switch del wizard WEB arranca siempre apagado.
- `reservation_available_vehicles.json` es un **array plano** (sin envoltura): se lee con
  `readJsonListFixture`. Su primera fila es la unidad ya asignada — el endpoint la incluye
  siempre, y es la que el sheet de swap pinta INERTE con su motivo.
- `presence: []` **no** significa "no hay nadie": `withPresence()` es best-effort y
  degrada a lista vacía si la lectura de presencia falla. La presencia solo puede afirmar
  presencia, jamás soledad.
