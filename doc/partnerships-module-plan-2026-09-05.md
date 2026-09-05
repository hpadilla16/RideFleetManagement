# 🤝 Módulo de Partnerships (nativo) — plan para aprobación de Hector

> 2026-09-05 · Origen: Rent & Go by VPH Motors pidió administrar alianzas comerciales
> (aseguradoras, cooperativas, empresas) con **términos, precios y servicios propios por
> partner**, y una **página hosted con QR** en un subdominio de su sitio
> (`partners.rentandgopr.com`). Referencia de producto: `partners.rentalcar.com/seguros-multiples`
> (Enterprise × Seguros Múltiples): logos de ambos, bienvenida, beneficios, "Book now",
> términos detallados, contacto, footer legal.
> **v1.1 — incorpora la revisión de Innovation (8 must-change, todos aplicados) y de Graphic
> Design.** Mockups: `doc/partnerships-module-mockups-2026-09-05.html`.
> **NADA se implementa hasta que Hector apruebe este spec + los mockups.**

## 0. Lo que ya existe y se reusa (esto hace el módulo barato)

| Necesidad del partner | Pieza existente | Dónde |
|---|---|---|
| Precios específicos por partner | Motor de tarifas: `Rate` + `RateItem` por clase + `RateDailyPrice` + grace/minChargeDays; aislamiento por `purpose` (ya existe `LOANER`) | `rates.service.js:734 resolveForRental`, `loaner-rate.service.js:30` |
| Servicios adicionales extra | `AdditionalService` (tenant/location, `mandatory`, comisiones, linkedFee) | `schema.prisma:2920` |
| Cotizar + reservar sin matemática nueva | `bookingEngineService.searchRental` → `createPublicBooking` | `booking-engine.service.js:1121-1870` |
| Descuento sin tocar cargos | Revenue pricing ya ajusta `quote.dailyRate` conservando `baseDailyRate` para el tachado | `booking-engine.service.js:1198-1205, 1265` |
| Página pública scopeada al tenant | `X-Tenant-Token` (`resolvePublicTenantToken`) + storefront con proxy | `middleware/public-tenant-token.js`, storefront `route.ts` |
| Rate-limit de página pública | Patrón store-board (`createPublicRateLimitGuard`) | `store-board-public.routes.js:26` |
| QR | `qrcode` ya en `frontend/package.json` (5 usos) | `vehicles/page.js`, `customer-display/page.js` |
| Activar por tenant + por persona | `MODULE_KEYS` / role maps / `Tenant.<x>Enabled` + toggles en People y Settings | `lib/module-access.js`, beta.212/307 |
| Canal de la reserva | `Reservation.bookingChannel` (String; `WEBSITE`, `KIOSK_WALKUP`, …) | `schema.prisma:1294` |
| Upload de logo | `safePath` + `uploadObject` + stamp `"bucket:path"` (marbete) | `vehicles.service.js:1126-1165`, `lib/storage/supabase-storage.js` |
| Audit sin reserva | `ModuleAccessAuditLog` (tenantId, actor, `changed Json`) — `AuditLog` EXIGE reservationId | `schema.prisma:4073` |
| Branding + contacto del tenant | `Tenant.companyLogoUrl`; storefront header/footer/`LOCATION_PHONES`/legal | storefront `src/lib/site.ts`, `messages/pages/legal.*.json` |

> Regla dura respetada: **no se toca código de pago** (gateway, checkout-session charge,
> iPOS/Auth.Net). Los cambios money-adjacent son: `resolveForRental(options.rateId)`, el filtro
> `purpose notIn [LOANER, PARTNER]`, y el hilo `partnerId` en `searchRental`/`createPublicBooking`
> (§3.2) — diffs pequeños, para revisión explícita de Hector antes de mergear.

## 1. Qué es un Partner (y qué NO es)

**Es**: una alianza configurada por el tenant (p. ej. "Seguros Isla") con: identidad (nombre,
logo, contacto), **términos y condiciones propios** (ES/EN), **precios propios** (tarifa del motor
de rates con `purpose: PARTNER`, o % de descuento), **decisión de vehículos** (mostrar clases con
foto / asignar al recoger), **servicios adicionales** (subset de los del tenant + extras exclusivos),
un **código de programa** corto (estilo CDP de Hertz / AWD de Avis) y una **página hosted** con URL
propia + QR. N partners por tenant; cada uno DRAFT, ACTIVE, PAUSED o EXPIRED.

**NO es**: una fuente de reservas externa (no es booking-source/integración), ni un canal de pago
nuevo. Las reservas del partner son reservas normales con `bookingChannel='PARTNER'` + `partnerId`,
y pasan por el MISMO checkout público de hoy.

## 2. Modelo (aditivo — 3 tablas nuevas + enum + 3 columnas)

```prisma
enum RatePurpose { RENTAL LOANER PARTNER }        // + PARTNER (aditivo)
enum PartnerStatus { DRAFT ACTIVE PAUSED EXPIRED }
enum PartnerKind { INSURANCE CORPORATE COOPERATIVE HOTEL OTHER }
// Switch "mostrar vehículos del inventario" (Hector 2026-09-05):
//   SHOW_INVENTORY   = ON  → clases con foto y precio del programa
//   PREFERRED_TYPE   = OFF + kind INSURANCE → el cliente escoge el TIPO que prefiere + acepta el
//                      aviso de cobertura (no garantizado; depende de la póliza y disponibilidad)
//   ASSIGN_AT_PICKUP = OFF + cualquier otro kind → categoría fija, se asigna al recoger
enum PartnerVehicleMode { SHOW_INVENTORY PREFERRED_TYPE ASSIGN_AT_PICKUP }

model Partner {
  id          String        @id @default(cuid())
  tenantId    String
  tenant      Tenant        @relation(fields: [tenantId], references: [id])
  slug        String                       // "seguros-isla" → partners.rentandgopr.com/seguros-isla (única identidad pública)
  code        String                       // "ISLA26" — código de programa tecleable (storefront principal + staff)
  kind        PartnerKind   @default(OTHER) // INSURANCE habilita PREFERRED_TYPE + aviso de cobertura
  name        String
  logoRef     String?                      // "partner-assets:<tenant>/<partner>/logo.png" — bucket PÚBLICO (no es PII; cacheable)
  status      PartnerStatus @default(DRAFT)
  unlisted    Boolean       @default(false) // no aparece en el índice del subdominio (solo por link/QR)
  validFrom   DateTime?
  validTo     DateTime?

  contactName  String?
  contactEmail String?
  contactPhone String?

  landingJson  Json?       // {es:{eyebrow, heroTitle, heroSubtitle, partnerNote, benefits[], ctaLabel}, en:{...}} — HTML SANITIZADO al guardar
  termsJson    Json?       // {es: html, en: html} — T&C del programa — HTML SANITIZADO al guardar (sanitize-html, allowlist)
  termsVersion Int         @default(1)     // sube en cada edición de términos; se estampa en la reserva
  showTenantTerms   Boolean @default(true)
  showTenantContact Boolean @default(true)

  rateId       String?     @unique         // Rate purpose=PARTNER, rateCode "PARTNER-<slug>", locationId null, displayOnline false
  rate         Rate?   @relation(fields: [rateId], references: [id])
  discountPct  Decimal? @db.Decimal(5,2)   // modo alterno si rateId es null: dailyRate = online × (1 − pct)

  vehicleMode           PartnerVehicleMode @default(SHOW_INVENTORY)
  allowedVehicleTypeIds Json?              // SHOW_INVENTORY: null = todas las clases con RateItem · PREFERRED_TYPE: los tipos elegibles (≥1)
  defaultVehicleTypeId  String?            // OBLIGATORIO en ASSIGN_AT_PICKUP
  coverageDisclosureJson Json?             // PREFERRED_TYPE: {es, en} — texto por defecto editable; sanitizado
  coverageDisclosureVersion Int @default(1) // sube al editar; se estampa en la reserva junto con la aceptación
  preferredTypePricing  String  @default("CONFIRM_AT_PICKUP") // CONFIRM_AT_PICKUP (sin número, sin pago online — decisión Hector) | TYPE_PRICE
  askPolicyNumber       Boolean @default(false)        // campo opcional "n.º de póliza / reclamación" en la tarjeta

  locationIds  Json?                       // null = todas las sedes

  visitCount   Int       @default(0)       // landing GET (patrón StoreBoardToken.lastSeenAt)
  lastVisitAt  DateTime?

  createdBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  services     PartnerService[]
  reservations Reservation[]
  auditLogs    PartnerAuditLog[]

  @@unique([tenantId, slug])
  @@unique([tenantId, code])
  @@index([tenantId, status])
}

model PartnerService {
  id                  String  @id @default(cuid())
  partnerId           String
  partner             Partner @relation(fields: [partnerId], references: [id], onDelete: Cascade)
  additionalServiceId String
  additionalService   AdditionalService @relation(fields: [additionalServiceId], references: [id])
  rateOverride        Decimal? @db.Decimal(10,2)   // null = precio normal
  mandatory           Boolean  @default(false)     // el SERVER lo añade (hoy AdditionalService.mandatory NO se impone server-side)
  sortOrder           Int      @default(0)
  @@unique([partnerId, additionalServiceId])
}

model PartnerAuditLog {                     // AuditLog exige reservationId → no sirve para CRUD de partner
  id          String   @id @default(cuid())
  tenantId    String
  partnerId   String
  partner     Partner  @relation(fields: [partnerId], references: [id], onDelete: Cascade)
  actorUserId String?
  actorRole   String?
  action      String                       // CREATE | UPDATE | PAUSE | ACTIVATE | PRICE_CHANGE | TERMS_CHANGE
  changed     Json                         // before/after (precio por clase, status, términos hash)
  createdAt   DateTime @default(now())
  @@index([tenantId, partnerId, createdAt])
}

// Columnas nuevas (nullable → migración aditiva)
model AdditionalService { partnerId String? @index }        // servicio EXCLUSIVO del partner
model Reservation       { partnerId String? @index; partnerTermsVersion Int?
                          partnerPreferredVehicleTypeId String?   // PREFERRED_TYPE: lo que el cliente pidió (vehicleTypeId = el mismo, para el precio)
                          partnerDisclosureAcceptedAt DateTime?; partnerDisclosureVersion Int?
                          partnerPolicyNumber String? }           // opcional; PII → redactSensitive
model Tenant            { partnershipsEnabled Boolean @default(false); partnerHostedBaseUrl String? }
```

Decisiones de modelo (con los hallazgos de Innovation):
- **Aislamiento por `purpose: PARTNER`, no por `displayOnline`.** `displayOnline` solo filtra el
  path online; los callers de staff (`reservations.routes.js:360/1077`, `rates.routes.js:18`) no
  pasan opciones, y el orden `createdAt desc` haría que una tarifa de partner recién creada GANARA
  toda cotización de counter para esa clase. Fix: los 3 sitios `purpose: { not: 'LOANER' }`
  (`rates.service.js:636/658/756`) pasan a `notIn: ['LOANER','PARTNER']`; el grid general de Rates
  deja de listar tarifas de partner (nadie las flipea online a mano). `displayOnline=false` se
  conserva como cinturón, no como candado.
- **Descuento = tarifa efectiva, NO línea de cargo negativa.** Igual que revenue pricing:
  `quote.dailyRate = online × (1 − pct)`, `baseDailyRate` conservado para el tachado. La fila
  DAILY lleva el precio del partner con cero sources nuevos → `syncAgreementCharges` intacto.
- **Revenue pricing NO aplica a tarifas de partner** (son precios negociados; `getRevenueRecommendation`
  se salta en el path de partner). Market Intelligence y `PricingRule` rechazan `purpose: PARTNER`
  como target.
- **Una sola identidad pública: el `slug`.** Sin `hostedToken`: la página es marketing (las de
  Enterprise son públicas) y un QR impreso no se rota; la protección del precio es status ACTIVE +
  validación server. `unlisted` cubre programas "solo por link". Fallback en RFM:
  `/p/<tenantSlug>/<partnerSlug>`.
- **Código de programa (`code`) en V1**: cubre al asegurado que llama o entra al counter sin pasar
  por la página — el staff lo teclea en New Reservation y la cotización usa la tarifa del partner;
  sin esto esas reservas ni se atribuyen ni se cobran como partner.
- **Switch "mostrar vehículos del inventario" (pedido de Hector 2026-09-05).** ON = `SHOW_INVENTORY`.
  OFF + `kind = INSURANCE` = **`PREFERRED_TYPE`**: la página no muestra inventario; el cliente marca el
  TIPO que prefiere (Sedán / SUV / Minivan… = `allowedVehicleTypeIds`), lee el **aviso de cobertura**
  ("tu preferencia no está garantizada; depende de la cobertura de tu póliza y de la disponibilidad;
  Rent & Go asigna al recoger") y debe marcar "Entiendo" para continuar. La reserva nace con
  `vehicleTypeId = tipo preferido` (así el precio del programa es el de ese tipo — fila DAILY normal),
  `partnerPreferredVehicleTypeId`, `partnerDisclosureAcceptedAt/Version` y, si el tenant lo activa,
  `partnerPolicyNumber` (opcional). El counter ve "Prefiere: SUV · sujeto a cobertura" en el detalle y
  en el planner, y puede asignar OTRA clase al check-out (Admin Corrections / replacePricing ya
  recalculan si cambia la clase). Solo aseguradoras: en otros `kind` el switch OFF = `ASSIGN_AT_PICKUP`.
- `ASSIGN_AT_PICKUP` (y `PREFERRED_TYPE`): sin vehículo, **status derivado de la regla de depósito de
  hoy** (`booking-engine.service.js:1701`, no CONFIRMED a la fuerza), y **con el chequeo de sold-out**
  de la clase (`:1601`) para no vender una clase con cero carros. El counter asigna al recoger
  (no-car-no-checkout ya lo obliga).

## 3. Backend

### 3.1 Admin (authed) — `/api/partnerships` · `requireModuleAccess('partnerships')` · ADMIN/OPS
- CRUD (list con reservas 30d + visitas, detail, create, update, pause/activate). `slug` y `code`
  se bloquean al publicar (están impresos en QR/brochures).
- `POST /:id/logo` (multipart ≤2 MB, png/jpg/webp/svg → bucket público `partner-assets`,
  `getPublicUrl`; patrón `vehicles.service.js:1126`).
- `POST /:id/rate` crea/vincula la Rate `PARTNER-<slug>` (`purpose: PARTNER`, `locationId: null`,
  todos los días ON, `displayOnline: false`; opcional "copy from online rate" de una sede).
- `PUT /:id/services` (PartnerService) · `POST /:id/services/custom` (AdditionalService con `partnerId`).
- `PUT /:id/terms` y `PUT /:id/landing` pasan por `sanitize-html` (allowlist p/ul/ol/li/strong/em/
  a[href http(s)]/h2-h4/br) — hoy NO hay sanitizador en el repo y esto se renderiza en una página
  pública de rentandgopr.com (XSS almacenado si se phishea un admin).
- `GET /:id/hosted` → `{ url }` (QR en el frontend con `qrcode`; URL con `utm_source=qr&utm_campaign=<slug>`).
- `GET /:id/reservations` · `GET /summary`. Cada mutación escribe `PartnerAuditLog`.

### 3.2 Público — en `publicBookingRouter` (ya detrás de `resolvePublicTenantToken` + guards, `main.js:211`)
- `GET /partners/:slug` → landing payload (partner + tenant + sedes + status efectivo). Partner
  fuera de ACTIVE/vigencia → 404 `{ reason }` (la página muestra "programa no disponible").
  Con token presente: `partner.tenantId === req.publicTokenTenantId` o 404. `no-store` (una pausa
  propaga al instante). Incrementa `visitCount/lastVisitAt`.
- `POST /rental-search` y `POST /checkout` aceptan `partnerSlug` (o `partnerCode`). Validación
  server-side SIEMPRE (mismo tenant, ACTIVE, vigencia, sede permitida) → si falla 422
  `PARTNER_NOT_AVAILABLE`, nunca cae al precio online. Con partner presente **se fuerza
  `tenantId = partner.tenantId`** y jamás se entra al modo agregador cross-tenant (`:1121-1148`).
- **Cache de `searchRental`**: la llave (`:1124`) suma `partner=<id>` — sin eso una búsqueda de
  partner alimentaría 60 s al sitio público y viceversa. `createPublicBooking` re-busca (`:1593`)
  **con el mismo `partnerId`** para re-cotizar al precio del partner.
- **`resolveForRental(options.rateId)`** (money-adjacent): con `rateId`, `where: { id, tenantId,
  purpose: 'PARTNER' }` + los filtros de isActive/día/vigencia de hoy; fail-closed (clase sin
  `RateItem` → null → se oculta). Sin `rateId`, byte-idéntico salvo el `notIn`.
- Servicios en checkout: unión server-side de los `PartnerService.mandatory` (hoy `:1618-1629`
  solo honra lo que manda el cliente) y `rateOverride` aplicado a `service.rate` ANTES de
  `computeAdditionalServiceLine` → las filas de cargo (`:1809`) ya llevan el precio del partner.
- Reserva: `bookingChannel:'PARTNER'`, `partnerId` (añadir a la lista explícita de campos de
  `reservations.service.create:1687`), `sourceRef = PARTNER:<slug>:<rand>`,
  `ReservationPricingSnapshot.source='PARTNER_BOOKING'`, `partnerTermsVersion` (snapshot de lo
  aceptado — un edit posterior de T&C no reescribe lo que el cliente firmó). Email de confirmación
  con línea "Programa: X", fire-and-forget (lección beta.336).

### 3.3 Fuga de servicios exclusivos — TODOS los catálogos no-partner filtran `partnerId: null`
kiosk `kiosk-offers.service.js:115/146` · counter `rental-agreements.service.js:1819` · portal
`customer-portal.routes.js:1293` · público `booking-engine.service.js:650` · admin
`additional-services.service.js`. Test DB-free: "un servicio solo-partner nunca aparece en un
catálogo sin partner".

### 3.4 Hosted page en RFM (fallback) — `GET /api/public/partners/:tenantSlug/:partnerSlug`
`frontend/src/app/p/[tenant]/[partner]/page.js` (patrón store-board): tema neutro con ambos logos,
términos, contacto y el flow de `/book` con `partnerSlug`. Es lo que va en el QR cuando el tenant
NO configura `partnerHostedBaseUrl`.

### 3.5 Módulo (checklist beta.212 + trampa beta.307)
- `module-access.js`: `partnerships` en `MODULE_KEYS`/`MODULE_LABELS`/`MODULE_DENIED_HINTS`; ON
  para ADMIN/OPS, OFF AGENT/hosts; `defaultTenantModuleConfig` (`:234`), clamp en
  `normalizeTenantModuleConfig` (`:266`), fallback sin tenant (`:298`), y **los `select` de
  `getTenantModuleConfig`/`updateTenantModuleConfig` (`:305/:328`)** — sin esto cada save de Access
  Control apaga el módulo (bug exacto de beta.307).
- Frontend: `MODULE_DEFINITIONS` + `ROLE_DEFAULT_MODULES` (`lib/moduleAccess.js:10/89`, pinned por
  `module-access-frontend-defaults.test.mjs`), `pathnameToModule`, nav en `AppShell.jsx:30` +
  `nav.partnerships` en/es. Tenants create/patch del flag (`tenants.service.js:104/126/157`).
- `main.js`: `app.use('/api/partnerships', requireAuth, tenantRateLimit,
  requireModuleAccess('partnerships'), requireRole('ADMIN','OPS'), partnershipsRouter)`.

## 4. Frontend RFM (admin) — ver mockups §A/§B

- Nav "Partnerships" → `/partnerships`: KPIs (activos, bookings 30d, revenue 30d, visitas) + cards
  (ambos logos, status chip, URL, bookings) + "New partner".
- Editor `/partnerships/[id]` con franja de progreso (6 pasos ✓) y 6 tabs: Profile · Terms (ES/EN,
  mismo editor que Location → Terms rider) · Pricing (tarifa propia con grid por clase vs online, o
  descuento %) · Vehicles (switch "Mostrar vehículos del inventario"; OFF → preferencia de tipo +
  aviso de cobertura editable ES/EN + precio del tipo o "según cobertura" + pedir n.º de póliza
  [solo Aseguradora], o asignar al recoger + clase por defecto [otros]) · Services
  (toggles + override + obligatorio + "solo este partner") · Hosted page (URL, Copy, QR PNG/SVG,
  "Print card", publicada/pausada, preview). Dark-aware desde el build (tokens de `globals.css`).
- Reservations list/detail: chip "Partner: X". New Reservation (staff): campo opcional "Program code".
- Settings → Partnerships: `partnerHostedBaseUrl` del tenant.

## 5. Storefront Rent & Go (`triangle-dealers-site`) — el subdominio — ver mockups §C/§D

- Vercel: dominio `partners.rentandgopr.com` en el mismo proyecto + `ALLOWED_HOSTS` (una sola env
  cubre `middleware.ts:11` y `route.ts:22`; host fuera de la lista = 404 global).
- `middleware.ts`: rewrite por host **después** de resolver el locale (si va antes, el redirect de
  next-intl expone `/es/partners/<slug>`); verificar en un preview de Vercel. Raíz del subdominio →
  índice de programas ACTIVE no-`unlisted` (o 404 si Hector prefiere).
- Página `/[locale]/partners/[slug]`: Header de Rent & Go + "Programa en alianza con" + logo del
  partner; hero; beneficios; SearchWidget (SHOW_INVENTORY), tarjeta de preferencia de tipo con aviso
  de cobertura + checkbox "Entiendo" (PREFERRED_TYPE) o tarjeta de reserva directa
  (ASSIGN_AT_PICKUP) — en los dos modos OFF no hay sección de flota ni nav "Vehículos" y la tarjeta
  NO pide datos personales (el checkout los pide una sola vez); vehículos con precio del programa y
  tachado del online; **Términos del
  programa** + resumen/enlaces a los T&C generales; **Contacto** (3 sedes con teléfono, email,
  horario, WhatsApp, Uber gratis — de `site.ts`/i18n); footer con ambos logos. ES default, EN toggle.
- Contexto de partner **en la URL** por todo el funnel (`rent → rent/[id] → checkout`), cookie 24h
  solo de respaldo, y **pill visible "Programa: X · salir"** en el sitio para que nadie quede
  cotizando como partner sin saberlo. Estados: programa pausado/vencido → página "no disponible"
  con contacto; partner sin clases con precio → CTA a llamar.

## 6. Seguridad / dinero (resumen)

- El precio SIEMPRE lo fija el server a partir de `partnerSlug`/`code` validado; el cliente nunca manda montos.
- Aislamiento por `purpose: PARTNER` en los 3 filtros del resolver + grid de Rates + MI/PricingRule.
- Partner PAUSED/EXPIRED/otro tenant → 404/422, sin fallback al online. Cache de búsqueda keyed por partner.
- HTML del partner sanitizado al guardar; logos en bucket público (no PII), tamaño/tipo validados.
- `PartnerAuditLog` en cada mutación; `partnerTermsVersion` en la reserva.
- Follow-up FUERA del módulo (motor público): `rentalAvailabilityCount` no descuenta reservas sin
  vehículo (pre-existente para WEBSITE también) — hacerlo en su propio ship.

## 7. Fases y gates

| Fase | Entrega | Gate |
|---|---|---|
| **F0 (ahora)** | Plan v1.1 + mockups v2 | Innovation ✓ (8 MC aplicados) · Graphic Design ✓ (9 MC aplicados en v2: color del partner fuera de la UI, ≥11px/44px en móvil, tarjeta OFF sin PII, un solo control Publish/Pause, estados dibujados, frames de precio en funnel, KPIs con fuente, contrato dark-mode, iconos lucide) · switch de inventario + preferencia de tipo (Hector) → **aprobación de Hector** |
| **F1** | Schema + `purpose PARTNER` + `/api/partnerships` + admin UI + `GET /partners/:slug` + filtros `partnerId:null` — **dark** (`partnershipsEnabled=false`) | **CONSTRUIDO 2026-09-05** en worktree `~/Code/rfm-wt-partnerships` (rama `feat/partnerships-module-f1` sobre `origin/main`); E2E en browser local OK (crear → tarifa → precios → términos saneados → publicar → QR → switch inventario/preferencia de tipo → servicio solo-partner oculto del catálogo; AGENT 403). Innovation ✓ build (4 MC: sanitizador de texto decodifica, relink reactiva la tarifa, MI/PricingRule/long-term excluyen PARTNER, descuento excluyente con tarifa) · GD ✓ build (5 MC: colisión con `button` global en tema claro, patrón `.modal-backdrop`, QR bloqueado legible, strings i18n) · commit `22f2b6a4` · QA → PR |
| **F2** | `rental-search`/`checkout` con partner + `resolveForRental(rateId)` + storefront `/partners/[slug]` + subdominio + código de programa en staff | **Hector revisa los diffs money-adjacent** · QA money-read SHIP · smoke real con partner de prueba |
| **F3** | `/p/[tenant]/[partner]` en RFM, chip en reservas, reporte "Bookings by partner", training PDF | QA SHIP · training |

Tests: `test:partnerships` DB-free (status/fechas/tenant, discount math, slug/code, sanitizer,
fuga de servicios) + DB-backed `resolveForRental(rateId)` (fail-closed, byte-idéntico sin rateId,
tarifa PARTNER invisible al path de staff) + cache key por partner + contract test del storefront
(pausado → 404, nunca precio online).

## 8. Decisiones de Hector (2026-09-05) — cerradas

1. **Solo por link/QR.** La raíz de `partners.rentandgopr.com` sirve la página "programa no disponible"; sin índice. `unlisted` deja de ser necesario (todos lo son).
2. **Sí a `discountPct`** como modo además de tarifa propia (tarifa propia default).
3. **Sin número** en preferencia de tipo: `preferredTypePricing = CONFIRM_AT_PICKUP` por defecto. La reserva se crea **sin pago en línea** (el checkout solo recoge datos + aceptación de términos y del aviso), con `vehicleTypeId = tipo preferido` para que el counter tenga la tarifa del programa a mano al recoger; el monto se confirma allí según cobertura. Implicación de ingeniería: `createPublicBooking` necesita un camino `skipPayment` para este modo (hoy el checkout público siempre cotiza y cobra) — money-adjacent, en la revisión de Hector de F2.
4. **Sí al código de programa en V1**; n.º de póliza/reclamación opcional en la tarjeta de aseguradoras.

### Preguntas originales (histórico)

1. Raíz de `partners.rentandgopr.com`: ¿índice público de programas activos o 404 (solo por link/QR)?
2. ¿`discountPct` como modo además de tarifa propia? (Recomiendo ambos; tarifa propia default.)
3. Sin inventario (`PREFERRED_TYPE` / `ASSIGN_AT_PICKUP`): ¿precio fijo por día del tipo preferido /
   clase por defecto, o "según cobertura · se confirma al recoger" sin número? (Recomiendo fijo; en
   aseguradoras, configurable por partner.)
3b. Aseguradoras: ¿pedir n.º de póliza/reclamación (opcional) en la tarjeta? (Recomiendo sí, opcional.)
4. ¿Código de programa en V1 (recomendado, cierra el caso "llamó al counter")? ¿Validación de elegibilidad (n.º de póliza) en V2?
5. Un cliente que entra por la página del partner y horas después vuelve a `rentandgopr.com`: ¿sigue con precio de partner (cookie) o solo dentro de la sesión con pill visible? (Recomiendo pill + cookie 24h.)
