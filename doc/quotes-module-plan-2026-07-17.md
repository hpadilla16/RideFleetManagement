# 📋 Módulo de Quotes (nativo) — plan para aprobación de Hector

> 2026-07-17 · Origen: gap #1 de la auditoría VozIA (Chloe no puede cotizar porque no hay
> endpoint de rates/availability en el allowlist del service-account). Decisión de Hector:
> **"crear un módulo de quotes para que ella pueda crear el quote y se quede guardado en el
> sistema"** — producto NATIVO de Ride Fleet, no integración third-party.
> **NADA se implementa hasta que Hector apruebe este spec.**

## 0. El hallazgo que hace esto barato

**El motor de quotes YA EXISTE y está probado en producción.**
`bookingEngineService.searchRental({ tenantId, pickupLocationId, pickupAt, returnAt })`
(`backend/src/modules/booking-engine/booking-engine.service.js:1221`) ya devuelve, POR CLASE
de vehículo, ambas cosas que necesitamos:

- **el quote**: `days`, `dailyRate`, `baseDailyRate`, `subtotal`, `fees`, `taxes`, `total`,
  `gracePeriodMin`, `source`, y todo el bloque de **revenue-pricing** (`revenuePricingApplied`,
  `revenueAdjustmentPct`, `revenueFactors`, `revenueSummary`) — o sea que un quote de Chloe
  hereda automáticamente tu Market Intelligence.
- **la disponibilidad**: `availabilityCount`, `soldOut`.

Lo consume hoy `public-booking.service.js` para el sitio público. **Cero matemática de precios
nueva** — reusamos el motor tal cual. Esto también cierra `checkAvailability` (gap #1 completo)
con la MISMA llamada.

> Regla dura respetada: no toco `pricing-*`/revenue-pricing/rates. Solo llamo el motor.

## 1. Qué es un Quote (y qué NO es)

**Es**: un estimado con precio, **guardado**, con número legible (`Q-1042`) que Chloe puede
decir por teléfono y el cliente puede mencionar después. Tiene vigencia (los rates se mueven
con revenue pricing).

**NO es**: una reserva, un cobro, ni un hold de inventario. **Un quote nunca mueve dinero ni
bloquea un carro.** Convertirlo en reserva es un paso aparte (Fase 3, aprobación explícita).

## 2. Modelo (aditivo — 1 tabla nueva + 1 enum)

```prisma
model Quote {
  id          String @id @default(cuid())
  quoteNumber String @unique          // "Q-1042" — legible por voz (mismo espíritu que reservationNumber)
  tenantId    String
  tenant      Tenant @relation(fields: [tenantId], references: [id])

  // A quién
  customerId   String?                // opcional: quien llama puede no ser cliente todavía
  customer     Customer? @relation(fields: [customerId], references: [id])
  contactName  String?
  contactPhone String?
  contactEmail String?

  // Qué se cotizó
  pickupLocationId String
  returnLocationId String?
  vehicleTypeId    String
  pickupAt         DateTime
  returnAt         DateTime

  // Snapshot del precio (COPIADO del booking-engine, nunca recalculado al leer)
  days        Int
  dailyRate   Decimal @db.Decimal(10, 2)
  subtotal    Decimal @db.Decimal(10, 2)
  fees        Decimal @db.Decimal(10, 2)
  taxes       Decimal @db.Decimal(10, 2)
  total       Decimal @db.Decimal(10, 2)
  currency    String  @default("USD")
  pricingSource         String?        // quote.source (GLOBAL / rate code)
  revenuePricingApplied Boolean @default(false)
  engineSnapshotJson    String?        // respuesta cruda del motor, para auditoría

  // Ciclo de vida
  status    QuoteStatus @default(ACTIVE)
  expiresAt DateTime                   // por qué: los rates se mueven (revenue pricing)
  convertedReservationId String?       // Fase 3

  // Procedencia (quién/desde dónde)
  source          String  @default("STAFF")   // STAFF | VOZIA | PORTAL
  createdByUserId String?
  author          String?                     // "USR-2 Hector (via VozIA)"
  ticketId        String?                     // el actionId/ticket de VozIA

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId, status])
  @@index([tenantId, customerId])
  @@index([tenantId, createdAt])
}

enum QuoteStatus { ACTIVE EXPIRED CONVERTED CANCELLED }
```

**Por qué snapshot y no recalcular al leer**: si el cliente llama mañana citando `Q-1042`, el
agente tiene que ver **el precio que se le dijo**, no uno nuevo. La vigencia (`expiresAt`) es la
que protege al negocio.

## 3. Endpoints

| Método | Ruta | Para qué | Service-account (VozIA) |
|---|---|---|---|
| `GET` | `/api/quotes/preview` | Computa SIN guardar (params: vehicleTypeId?, pickupLocationId, pickupAt, returnAt). Devuelve precio **+ disponibilidad** por clase. Es lo que contesta "¿cuánto me sale?" al vuelo. | ✅ allowlist |
| `POST` | `/api/quotes` | Computa **y guarda** → devuelve el Quote con su `quoteNumber`. | ✅ allowlist |
| `GET` | `/api/quotes/:id` | Por `id` o por `quoteNumber` (mismo resolver que reservations: `^[A-Za-z]{2,6}-` → número). | ✅ allowlist |
| `GET` | `/api/quotes` | Lista/filtro (`customerId`, `status`, ventana de fechas). | ✅ allowlist |
| `POST` | `/api/quotes/:id/cancel` | Cancelar un quote (no-dinero). | ⛔ solo humanos (Fase 2) |
| `POST` | `/api/quotes/:id/convert` | **Fase 3** — crear reserva desde el quote. | ⛔ NUNCA para VozIA |

- Todo detrás de `requireAuth` + `tenantRateLimit` + `requireModuleAccess('reservations')`
  (o un módulo `quotes` propio si quieres togglearlo por persona — **decisión #2 abajo**).
- Errores/tenant/formato: idénticos al resto (`{error:string}`, tenant implícito en el token).
- `POST /api/quotes` lleva `Idempotency-Key` (reusa el middleware existente) para que un retry
  de Chloe no cree dos quotes.

## 4. Expiración (sin cron nuevo)

`expiresAt = createdAt + QUOTE_TTL_HOURS` (env, default sugerido **72h**).
Los quotes NO se expiran con un job: se marcan `EXPIRED` **lazy** al leerlos (mismo patrón que
`inventory-reconciliation`), y el sweep horario del worker puede barrer los viejos si algún día
molesta. Menos infraestructura, cero deriva.

## 5. VozIA (Fase 2)

- `HttpAdapter.quoteRate` → `GET /api/quotes/preview` → mapea a `RateQuote` (el tipo ya existe).
- `HttpAdapter.checkAvailability` → **la misma llamada** (`availabilityCount`/`soldOut`) → mapea a
  `AvailabilityResult`. Los dos `throw` de gap #1 desaparecen.
- **Tool nueva `createQuote`** → `POST /api/quotes` con `source:"VOZIA"`, `author`, `ticketId`.
  Chloe dice: *"Te lo dejé guardado como Q-1042, válido hasta el viernes."*
- **Decisión #3**: ¿Chloe crea el quote sola, o requiere aprobación? Mi recomendación: **sola** —
  no mueve dinero, no bloquea inventario, y es exactamente el valor ("que se quede guardado").
  Lo que SÍ pasa por aprobación es **emailearlo al cliente** (comunicación saliente).
- Consola: lista de Quotes + detalle; desde un ticket, "crear quote"; el 360 del cliente muestra
  sus quotes recientes.

## 6. ⚠️ Guardarraíl de reportes (la lección de beta.296)

**Los quotes NO son ingreso y no pueden filtrarse a NINGÚN reporte de dinero.**
En beta.296 los AUTH_HOLDs inflaron "Revenue in period" de $47.5K → $336K justamente por
contar cosas que no eran plata cobrada. Un Quote es todavía menos que un hold: es una
*intención*. Requisito explícito del módulo: `Quote` no entra en `collected-payments.js`, ni en
sales/taxes/commission, ni en `projectedRevenue`. Si algún día quieres un reporte de "quotes →
conversión", es un reporte APARTE y claramente etiquetado como pipeline, no como revenue.

## 7. Fases

| Fase | Qué | Riesgo |
|---|---|---|
| **1** | Modelo + migración aditiva + `preview`/`POST`/`GET` + allowlist + tests. Backend puro. | Bajo — reusa el motor, tabla nueva aislada |
| **2** | VozIA: quoteRate/checkAvailability/createQuote + prompt de Chloe + UI de consola + training | Bajo-medio (UI → necesita mockup aprobado por ti) |
| **3** | `convert` (quote → reserva) + emailear el quote | **Aprobación explícita** — toca creación de reservas |

## 8. Decisiones que necesito de ti

1. **TTL del quote**: ¿72h por defecto? (los rates se mueven con revenue pricing)
2. **Módulo propio `quotes`** en el toggle de People/Settings, ¿o va bajo `reservations`?
   (propio = puedes dárselo a ventas y quitárselo a otros)
3. **¿Chloe crea quotes sin aprobación?** (mi recomendación: sí; emailear = con aprobación)
4. **`quoteNumber`**: ¿formato `Q-1042`? (secuencia por tenant, legible por voz)
5. **Alcance de Fase 1**: ¿solo rental, o también car-sharing? (`searchCarSharing` es otro método
   del mismo servicio — se puede añadir después sin romper nada)

## 9. Lo que NO hace este plan

- No toca `pricing-*`, revenue-pricing, ni `rates` — solo **llama** al motor.
- No cobra, no hace hold de inventario, no crea reservas (eso es Fase 3).
- No inventa precios: si el motor dice `soldOut`, el quote se rechaza o se marca sin disponibilidad.

---

## Decisiones de Hector — ronda 2 (2026-07-17, post-QA-SHIP)

1. **Depósito para reservas convertidas (VOZIA): NO.** Flujo de links de hoy tal cual:
   confirmación + pre-checkin + link de pago. ✅ VERIFICADO: ya se cumple sin código —
   `sendConfirmationEmail` default `true` (schema + create) y el precheckin auto-invite
   scheduler agarra reservas NEW/CONFIRMED automáticamente.
2. **Re-quote en EXPIRED: SÍ entra en v1.** Un click → duplica el quote con precios
   FRESCOS del motor → nuevo Q-# (no es edición de precio). Se implementa en el delta de
   la fase de UI junto con los MINORS de QA (m1: status inválido → 400; m2: race de
   vehicle-conflict → QUOTE_UNAVAILABLE 422), un solo re-pase de QA para el paquete.
3. **Mockups v2 publicados** para aprobación:
   https://claude.ai/code/artifact/980ce4a5-b0a2-47d7-8e66-fc1ec20fc6d1
