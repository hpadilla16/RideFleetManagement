# Fixtures de contrato API

Cada JSON está derivado **campo por campo del serializer real del backend** (main @
6d8173c) — no de OpenAPI ni de memoria. Si el backend cambia una forma, el fixture se
actualiza en el mismo PR (DoD #12). Los tests de DTO deserializan estos archivos.

| Fixture | Fuente (serializer) |
|---|---|
| `login_response.json` | `auth.service.js` `login()` → `{ token, user: buildSessionUser }` (:87-115, :250-255) |
| `dashboard.json` | `employee-app.service.js` `dashboard()` (:451-497), `reservationCard` (:66-122), `incidentCard` (:124-160) |
| `checkout_session.json` | fila Prisma cruda del modelo `CheckoutSession` (schema.prisma:5067-5111) vía `getById` (:276-280) |
| `reservation_card.json` | `employee-app.service.js` `reservationCard` (:66-122) |
| `handoff_token.json` | `checkout-session.service.js` `mintHandoffToken` (:727-733 reuso, :766-770 fresco) |
| `mobile_inspection_state.json` | `mobile-inspection.service.js` `loadSession` (:118-143) |

Notas de forma que muerden:

- Fechas: ISO-8601 con `Z` (Prisma `DateTime` serializado por Express). Campos `*At`
  pueden ser `null`.
- `locationIds`: `null` significa TODAS las ubicaciones (usuario UNRESTRICTED) — no lista
  vacía. `[]` no ocurre (el backend lo normaliza a `null`).
- `estimatedTotal` y montos: pueden llegar como número o string decimal según la columna
  Prisma (`Decimal` serializa a string). El DTO debe aceptar ambos.
- `reservationCard.vehicle.plate` hace fallback `plate || licensePlate || ''` en servidor.
- `handoff_token` trae `reused: true` solo cuando devolvió un token existente.
