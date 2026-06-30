# Ride Fleet Manager — Auditoría de plataforma y roadmap (2026-06-29)

Análisis read-only de toda la plataforma, pasado por los agentes de **Seguridad**, **Aislamiento de tenants**, **Innovación/arquitectura**, **Diseño/UX** y **Oportunidades de producto**. Ningún archivo fue modificado. Cada arreglo, al implementarse, pasa por el flujo de agentes (build → Innovation + Graphic Design → QA SHIP) antes de deploy.

**Veredicto general:** plataforma madura y bien construida. NO es candidata a reescritura. Pero hay **vulnerabilidades críticas de aislamiento entre tenants** que deben arreglarse YA (un tenant puede tocar dinero/datos de otro), más mejoras de alto valor en seguridad, performance, consistencia visual y features nuevas.

---

## Prioridad P0 — CRÍTICO (arreglar de inmediato: dinero/datos cruzados entre tenants)

Estos permiten que un usuario autenticado de un tenant afecte a OTRO tenant. Riesgo legal/financiero real.

1. **Pagos sin atar al tenant.** `payment-gateway.service.js` (charge/auth/capture/void/refund) usa el `tenantId` solo para cargar credenciales, nunca verifica que el `reservationId`/`referenceId` sea del tenant. Un ADMIN/OPS del tenant A puede hacer void/refund/charge sobre una reserva del tenant B. → Resolver `reservation.findFirst({where:{id,tenantId}})` (fail-closed) antes de cualquier llamada al gateway.
2. **Checkout-session y spin-charge por id pelado.** `checkout-session.service.js` (transition/stamp/signature/handoff) y `spin-charge.service.js` mutan por `id` sin chequear tenant. Tenant A puede cerrar el checkout de B, firmar, mintear tokens públicos y postear cargos. → Pasar y forzar `tenantId` en cada método mutador.
3. **Módulo Customers falla ABIERTO + confía en tenantId del cliente.** `customers.routes.js` define un `scopeFor` local que devuelve `{tenantId: null}` si falta el claim → el filtro desaparece → lectura/escritura global de PII (licencia, seguro, DOB) y creación/import cross-tenant. → Usar el helper fail-closed `lib/tenant-scope.js`; nunca derivar tenantId del body/filas.
4. **`POST /rental-agreements/:id/credit` sin scope de tenant.** Ajusta el `creditBalance` del cliente por id de agreement sin verificar tenant. → Usar el accessor scopeado.
5. **Upsert de telemática con clave única GLOBAL.** `registerTelematicsDevice` hace upsert por `(provider, externalDeviceId)` sin tenantId → el tenant B puede re-apuntar el dispositivo del tenant A. → Leer-por-tenant y luego crear, o añadir tenantId a la unique.
6. **Rate limiting confía en `X-Forwarded-For`.** `public-endpoint-guards.js` toma el XFF de la izquierda (controlado por el atacante) → todos los límites públicos (login 5/min, account-deletion, checkout) son evadibles. → `trust proxy` + `req.ip`.
7. **`DATABASE_URL` (con contraseña) impreso en logs al bootear** (`prisma-url.js`). → Quitar ese `console.log`.

**Sistémico (fuertemente recomendado):** una extensión/middleware de Prisma que auto-inyecte `tenantId` en modelos tenant-owned (defensa en profundidad — un filtro olvidado falla cerrado), y un lint (como el `lint-cache-keys.mjs` existente) que marque `update/delete/findUnique` por `id` pelado en modelos tenant-owned. El módulo `reservations` ya es el patrón correcto a estandarizar.

---

## Prioridad P1 — ALTO

**Seguridad / datos:**
- **Credenciales de gateway y Twilio en texto plano en la DB** (`settings.service.js`). Ya existe `lib/integration-crypto.js` (AES-256-GCM) pero no se usa aquí → cifrar en reposo (relevante PCI).
- **`requireAuth` no rechaza tokens GUEST** explícitamente (hoy se salva por accidente). → Rechazar `role==='GUEST'`.
- **Secreto HMAC del QR de check-in con fallback hardcoded** `'ride-fleet-qr'`. → Fallar cerrado si no hay secreto real.
- **Endpoints públicos de trip-documents/cancel** sin chequeo de identidad/tenant cuando no llega `X-Tenant-Token` → sobre-escritura de KYC / cancelación cross-tenant por reservationNumber+email. → tenantId obligatorio + match de identidad.
- Allowlist de URLs salientes (SSRF) para gateways/email; loaner lookup que exige los 3 campos; respuesta de tiempo constante en guest sign-in.

**Arquitectura / performance:**
- **CI no corre el test suite.** `beta-ci.yml` hace build + node --check + suite de aislamiento, pero NUNCA `npm test` (≈40 suites DB-backed). Es la brecha de mayor leverage. → Job de CI con servicio Postgres que corra `npm test`.
- **Escrituras del doble-ledger de pagos no son atómicas.** El mirror Reservation↔Agreement corre en el cliente global con `try{}catch{}` que traga errores → puede dejar balance stale. → Envolver en `$transaction` + script de reconciliación de drift.
- **Blobs base64 en columnas Postgres** (idPhoto/insurance/license/firmas) — causa raíz del row de 14MB / getById de 37s. La capa de storage (Supabase) YA existe y ya migraron las fotos de inspección. → Terminar la migración de documentos/firmas a object storage + URLs firmadas, luego dropear columnas.
- **Bundle frontend carga libs pesadas en todas las páginas** (chart.js, @zxing ~500KB) sin lazy-load. → `next/dynamic` → ~250KB menos en el bundle inicial (quick win).

---

## Prioridad P2 — MEDIO

- N+1 en reports (`.map(async)` con `findFirst` por fila) → batch con `findMany({where:{id:{in:[...]}}})`.
- Paginación por cursor en listas grandes (reservas/tolls/customers); `take` en los `findMany` sin límite. (NO subir límites de offset — empuja payloads grandes.)
- Catch blocks que tragan todo y devuelven 404 (customers/locations) → ciegan Sentry; narrow a P2025.
- `reservations/[id]/page.js` ~3,400 líneas / 60+ useState → descomponer en componentes; introducir capa de datos (SWR ligero) para colapsar el `refresh()` imperativo.
- Validación de requests centralizada/ligera (sin framework pesado en el hot path).
- Verificar locks de schedulers bajo cluster (que no disparen x4); consolidar helpers duplicados (`monthKey`, role checks, money).

---

## Diseño / UX — estandarización (casi todo costo-perf CERO)

Hay un design-system real en `globals.css` (~1,220 líneas) pero la adopción es inconsistente: **1,343+ `style={{` inline, 768+ hexes literales, 5 "morados de marca" distintos, sin escala de spacing/radius, y huecos grandes de dark-mode.**

**Fundación (hacer primero, CSS puro, perf cero):**
- Completar tokens: escala `--space-*`, `--radius-*`, colores de estado (`--danger/--success/--warn/--info`), y `--brand-purple-rgb` unificando los 5 morados.
- Pasada de dark-mode: cards, surface-note, info-tile, metric-card, zebra de tablas, paleta de charts y el dropdown CustomerSearch (hoy caja blanca en dark).
- Promover patrones inline repetidos a clases: `.btn-danger/.btn-success`, `.required-asterisk`, variantes `.status-chip.danger/.info`.

**Componentes compartidos:**
- Estados Empty / Loading (skeletons) / Error (`.inline-alert`) — hoy son strings sueltos, sin skeletons.
- Modal accesible para reemplazar los ~24 `window.confirm/prompt` (cancel/void/refund/no-show) — no son accesibles ni branded.

**Por pantalla (alto valor):** consolidar el tope del Dashboard (KPI band duplicado), iconos en alertas (no solo color), sub-nav + barra de "Save" pegajosa en Settings (15+ tabs), control de densidad en tablas, descomponer la pantalla de reserva.

**Evitar (puede afectar velocidad):** demasiados `backdrop-filter: blur` apilados (limitar blur a sidebar/topbar/modales); no cachear blobs; nada de framework de validación pesado por request; no reescribir todo a server-components ahora.

---

## Oportunidades — herramientas/funciones nuevas (cliente / empleado / dueño)

Top 10 por ROI (todas se apoyan en piezas que YA existen):

1. **OCR de licencia/ID con autollenado** (empleado) — el mayor ahorro de tiempo en el counter; la infra de OCR ya existe (citations/Claude vision); `licenseBack` ya está.
2. **Apple Pay / Google Pay** (cliente) — más conversión móvil; los gateways ya tokenizan.
3. **Cobro automático/dunning** de balances vencidos (dueño) — recupera ingreso; ya hay reporte de unpaid-balance + tarjetas guardadas + schedulers.
4. **Telemática → triggers de mantenimiento + recalls** (empleado) — conecta dos sistemas ya vivos (odómetro live + motor de intervalos).
5. **Canal WhatsApp** (cliente) — canal dominante en PR; el `sms` ya abstrae proveedores (Twilio soporta WhatsApp).
6. **Sync con QuickBooks/Xero** (dueño) — elimina doble-entrada; reports de ventas/taxes/pagos ya computan todo.
7. **Screening AML/OFAC + señales de fraude** en check-in (empleado) — cumplimiento + prevención de pérdida; se empareja con #1.
8. **BI multi-local + exports programados** (dueño) — visibilidad cross-location; reports-v2 ya es por local.
9. **AI de detección de daños** en fotos de inspección (empleado) — menos disputas; ya se guardan fotos antes/después.
10. **Loyalty / referidos** (cliente) — repetición + reservas directas que evitan comisión de OTAs.

Otras: self-report de daños del cliente, "where's my car" con telemática, agregación/respuesta de reseñas, app móvil de ops (la ruta `employee-app` existe oculta — es revivir, no construir), workflow de claims/subrogación, pack de cumplimiento PR (DTOP/SURI).

---

## Roadmap sugerido (secuencia)

**Sprint 0 — P0 seguridad/aislamiento** (esto primero, sí o sí): #1–#7 arriba + la extensión Prisma de tenant + el lint. Cada uno con su test de aislamiento.

**Sprint 1 — P1 base:** CI corre `npm test` (mayor leverage) → escrituras atómicas del ledger + reconciliación → cifrar credenciales → rechazar GUEST / QR fail-closed → lazy-load del bundle.

**Sprint 2 — Fundación de diseño:** tokens + dark-mode + componentes de estado + modal accesible (todo perf-cero), y terminar migración de blobs a storage.

**Sprint 3+ — Features de alto ROI:** OCR de licencia, Apple/Google Pay, dunning automático, WhatsApp, QuickBooks — en orden de ROI.

> Nota: las dos "deudas de diseño" de arquitectura (doble ledger y blobs base64) son más ladrido que mordida — el doble ledger está bien como diseño y solo necesita atomicidad + chequeo de drift; los blobs ya están medio migrados.

---

# Adición: Rediseño del Planner + Employee App nativa (Play/App Store)

## Planner — rediseño (herramienta admin desktop)
Hoy: board de tracks (CSS-grid) enterrado bajo ~20 tiles + toolbar + copilot + rules + recomendaciones en un solo scroll; sin estados vacíos/loading; sin dark-mode en el board; bloques diminutos; drag sin preview. Perf: `getSnapshot` arma señales operacionales por vehículo inline (revienta a ~125 vehículos), manda payloads redundantes, y `PlannerTrackRow` monta ~3,750 celdas DOM sin virtualización.

**Rediseño (board-first):**
- **Command bar pegajosa** (Tenant, ◀ Today ▶, Day|Week|Month, filtros, 1 acción primaria, "⋯ More" para acciones pesadas).
- **Triage strip** que colapsa los 20 tiles en chips priorizados (Overbooked/Unassigned/Cars Needed = críticos y clicables como filtro; el resto en "All metrics ▸").
- **Board llena la pantalla** con su propio scroll; densidad Comfortable/Compact/Condensed; header de día pegajoso; columna "hoy" resaltada; bloques con barra de estado lateral + ícono (legend se retira); **drag con preview**: celdas legales resaltadas, ilegales atenuadas con razón.
- **Copilot/Recomendaciones/Rules → rail derecho** (slide-over), no en el scroll principal; al hacer click en una recomendación, el board hace scroll y pulsa esa fila.
- Estados empty/loading (skeleton)/error + dark-mode para el board.
- **Perf:** mover señales operacionales a endpoint lazy por fila; paginar/ventanear vehículos; virtualizar filas (react-window); `React.memo` por fila; SSE/poll-on-focus para conflictos.

## Employee App nativa (iOS + Android, instalable en tiendas)
**Arquitectura (Innovation):** usar **Capacitor** (ya es dependencia; `appId com.ridefleet.mobile`). Cambiar del wrapper de URL remota a un **bundle estático de rutas `/m/*`** (solo flujos de piso) → habilita offline y pasa review de Apple. Token seguro en keystore (no localStorage). **Offline-first**: outbox local (SQLite) que encola check-in/out/inventario con idempotency key y sincroniza al reconectar; fotos a Supabase Storage (no base64-in-DB). **Cámara/scanner nativo** (`@capacitor/camera` + ML Kit) para VIN, licencia PDF417 (reusa `parseAamva`/LicenseScanner) y fotos de daños. **Push** desde los schedulers existentes. **OTA live-updates** para iterar sin re-review.

**Pantallas (mobile-first, tap targets 48-56px, una mano, glove-friendly):**
- **Today** — "Next Up" + 4 stat tiles + timeline del día + acciones rápidas.
- **Reservations** — lista día-a-día + búsqueda + chips de estado; acción primaria por tarjeta según estado.
- **Check-IN** (devolución) — reutiliza el wizard real de 6 pasos: 8 fotos guiadas + daños, odómetro (pad), fuel (8 segmentos), **fee preview en vivo**, settlement, firma.
- **Check-OUT** (recogida) — verificar cliente, **escanear licencia** (OCR, reemplaza el upload de escritorio), firmar en el equipo, depósito/pago, entregar.
- **Inventory** — lista/estado, **escanear VIN/QR** (ya imprimen labels QR), filtros por señal operacional, "Mark status".
- **Tablet "Customer-Assist / Self-Checkout" (kiosko)** — modo **bloqueado** (screen-pinning), sin chrome admin, branded, pasos enormes: bienvenida → buscar reserva → verificar ID → revisar/firmar → pagar → listo; "volver al inicio" entre clientes (auto por inactividad); **salida con PIN**. Es la cara de cliente del checkout-session ya existente, convertida en kiosko.

**Fases:** MVP (Capacitor nativo + bundle + Today/lookup + check-out + check-in + inventory + cámara/scanner) → v1 (offline outbox, kiosko tablet, push, submisión a tiendas) → v2 (OTA, self-checkout cliente, señales de telemática).

**Riesgos a decidir:** (1) rol AGENT no puede cobrar hoy (`payment-gateway` es ADMIN/OPS) — decidir si se le da acceso scopeado o el piso/kiosko corre como usuario OPS; (2) no hay concepto de sesión "kiosko/device" en el backend — es trabajo nuevo (claim + scoping de endpoints); (3) fotos base64 en DB → mover a storage (prerequisito de offline); (4) cuentas Apple Developer + Google Play + política de privacidad; (5) pago offline NO es posible (terminal/CNP requieren conexión) — offline bloquea el paso de pago.

---

# Adición 2: Quotes · i18n (ES completo) · Dark mode · Kiosko de self-checkout

## Módulo de Quotes (cotizaciones → reservas)
Reutiliza el motor de precios que YA existe (`booking-engine.searchRental` calcula daily/subtotal/fees/taxes/total; `createPublicBooking` ya hace quote→reservation). 
- **Modelos nuevos:** `Quote` (cliente o lead, clase de vehículo, fechas/locations, pricing congelado, status DRAFT/SENT/ACCEPTED/EXPIRED/CONVERTED, expiry, publicToken, convertedReservationId, version) + `QuoteLineItem` (espejo de ReservationCharge).
- **Inventario:** NO hace hold duro — estimado suave por clase; al convertir se revalida disponibilidad (evita doble-booking) y si no hay, ofrece re-cotizar. `holdUntil` opcional = "honramos el precio hasta X" sin bloquear unidad.
- **Flujo:** crear (admin o público "request a quote") → precio (misma función que search; extraer `priceRentalClass()` compartida) → enviar (email branded + PDF Puppeteer + link de aceptar) → aceptar (token público) → **convertir en 1 click** (upsert lead→Customer, `reservationsService.create`, copiar line items + snapshot). Versionado en re-quote; scheduler de expiry.
- **UI:** nav nuevo entre Reservations y Vehicles; lista con chips de status + builder + "Convert to Reservation". (Mockup para aprobación primero.)

## i18n — que el toggle ES traduzca TODO (no solo partes)
**Causa raíz:** react-i18next está bien montado, pero **solo `AppShell.jsx` usa `t()`** — las ~93 páginas y ~170 componentes tienen texto en inglés hardcodeado (~4,284 nodos + ~479 atributos). Cobertura efectiva ≈ **2%**. No hay ESLint que lo impida, y secciones del diccionario (`dashboard.*`, `login.*`, `common.*`) están pobladas pero nunca usadas.
**Plan:** (1) **lint primero** (`eslint-plugin-i18next` no-literal-string en CI) para frenar la sangría; (2) convención de keys por pantalla; (3) `fallbackLng:'en'` + `saveMissing` para descubrir el backlog; (4) `i18next-parser` para extraer; (5) orden: AppShell+Dashboard (quick win, dict ya existe) → Reservations → Customers/Planner → Reports → Settings (el grande) → resto. La acción de mayor leverage es el lint.

## Dark mode — checklist concreto
**Causa:** el bloque `:root[data-theme='dark']` solo parchea body/headings/inputs/botones/nav + una regla compartida; el resto hardcodea `#fff`/grises claros, y hay color inline en ~50 archivos (peores: reports-v2 y charts).
**Fix (orden):** (1) agregar tokens dark-aware `--surface/--surface-2/--border-hair/--text-strong/--text-body`; (2) parchear clases en globals.css (`.info-tile`, `.timeline-item`, `.metric-card strong`, zebra/hover de tablas, `.ios-action-card`, `.service-form`, knowledge/legal, sales-chart); (3) **board del Planner** (`.planner-scroll/cell/sticky/drop` sin override dark); (4) dropdown **CustomerSearch** (hoy `background:'white'` inline); (5) **charts** theme-aware (`getChartTheme()` por `data-theme`, re-render al togglear); (6) bulk swap de literales inline en reports-v2 + cards; (7) excluir superficies de firma/print del cliente (intencionalmente claras). Checklist completo con file:line en el análisis.

## KIOSKO DE SELF-CHECKOUT (pieza estrella — diseño detallado)
Meta: cliente llega, pone confirmación # o escanea el QR del recordatorio, y sale manejando en **10-15 min**; reduce filas; bot de IA ayuda; experiencia única que **vende manteniendo al cliente feliz**. ~70% reutiliza módulos existentes (checkout-session + handoff/QR tokens, terms+initials+firma+decline flow, fotos→Supabase, OCR Claude-vision de citations, payment-gateway card-on-file+deposit hold, catálogos de seguros/servicios, recordatorios bilingües).

**Flujo (pantalla por pantalla):** Atract/Welcome (EN|ES) → Identificar (QR `kind=KIOSK_CHECKIN` o confirmación#+apellido) → Resumen del viaje → **Escaneo de licencia** (guarda foto front/back + OCR ID: vence/edad/nombre) → **Selfie + liveness** → **Conductor adicional** (repite captura) → **Seguro**: propio (escanea doc → **motor de auto-aprobación** vs requisitos del tenant: si insuficiente, ofrece "gap-fill" → vende plan; si ilegible/low-confidence → revisión del agente) o nuestro (**vende 3 tiers**, el del medio "Recomendado", descripción clara; decline reusa initials+firma) → **Upsell** de servicios no en la reserva → **Review** transparente (incluye hold de depósito marcado "no es cargo") → **Términos/initials/firma** (reusa terms-signing) → **Pago + card-on-file + deposit hold** (card-present en el lector) → **Completion: QR de checkout del carro + PIN de llave**.
**Auto-aprobación de seguro (NUEVO):** OCR del doc (imagen/PDF) → `decideCoverage()` (APPROVED/INSUFFICIENT/MANUAL_REVIEW) vs settings nuevos `insuranceRequirements` (min liability, collision/comp requeridos, vigencia, confidence). Nunca aprueba en silencio; insuficiente→gap-fill; dudoso→agente.
**PIN / entrega de llave (NUEVO):** PIN de 6 dígitos hasheado, corto, single-use, atado a reserva+location; sesión pasa a `KEY_HANDOFF_PENDING`; el **agente lo ingresa en el Employee-App** y ve un panel de verificación (selfie al lado de la licencia, flags de ID, decisión de seguro, pago+depósito, conductor adicional) y **libera llaves** (o retiene) → CLOSED. Todo auditado.
**Bot concierge IA (NUEVO):** ayuda paso a paso bilingüe (reusa el cliente Anthropic del OCR), guardarraíles duros (no promete cobertura/legal, no negocia precio, no repite PII), escala a agente vivo. 
**Selling UX:** 3 tiers con decoy "Recomendado", valor en lenguaje claro, loss-framing ético, gap-fill (el momento de mayor conversión), defaults inteligentes en add-ons, total transparente (reduce chargebacks). Métricas: drop-off por paso, attach rate, mix de tiers, tiempo-a-completar.
**Deploy:** kiosko standalone (cámara doc + selfie + lector chip/tap + printer) o tablet bloqueado (Capacitor + screen-pinning/COSU); `KioskDevice` provisionado a tenant+location; QR en el recordatorio existente; offline degrada a "ver agente" en el paso de pago. Distinto del kiosko del Employee-App (ese es staff-auth; este es cliente, token/PIN-gated, sin datos operativos).
**Nuevo backend (acotado):** captura ID/selfie + 2 extractores OCR (ID, seguro) + motor `decideCoverage` + settings `insuranceRequirements` + PIN de llave + verify del agente + `KioskDevice`/sesión bloqueada + estados nuevos (`KEY_HANDOFF_PENDING`) + tokens nuevos (`KIOSK_CHECKIN`, `KEY_RETRIEVAL`) + bot concierge. **Riesgos:** card-present vs CNP, PCI de imágenes PII (cifrar/retención), exactitud de liveness/OCR (advisory + gate humano), consentimiento biométrico del selfie, legal de aceptación de seguro por jurisdicción.
**Fases:** MVP (kiosko bloqueado + identify + captura ID/selfie + vender tiers + add-ons + terms/firma + pago/depósito + PIN + panel del agente + QR en recordatorio) → v1 (OCR ID + motor de seguro + gap-fill + liveness/face-match + bot concierge + pulido de venta + hardware standalone).

---

# Decisiones de Hector (2026-06-29) + orden de ejecución

**Decisiones:**
1. **i18n primero:** todo en inglés por defecto + el toggle ES debe traducir TODA la app (no solo partes).
2. **Kiosko hardware = tablet + lector.** El **rol que cobra = OPS** (la sesión del kiosko/piso corre como usuario OPS para evitar el bloqueo de pagos del rol AGENT).
3. **Kiosk Mode = feature NUEVO y vendible** (add-on que los clientes de RFM compran), **gated por entitlement igual que Toll Manager y Market Intelligence**: flag por tenant (ej. `kioskEnabled`), toggle del super-admin en /tenants, oculto del nav y rutas 403 si está apagado (mismo patrón en `lib/module-access.js` + `Tenant.tollsEnabled/marketIntelligenceEnabled`). Incluye una **página de Settings en RFM** para configurar TODO el kiosko: requisitos de cobertura mínima de seguro (`insuranceRequirements`), tiers/precios visibles, qué se captura (selfie/ID), upsells, textos del bot, branding, TTL del PIN, etc.
4. **Planner se hace ANTES de la Employee App.**

**Orden de ejecución acordado:**
1. **i18n** — EN completo + ES funcional en toda la app (lint primero, luego conversión por pantallas).
2. **P0 seguridad/aislamiento** (sigue siendo crítico; recomendado no posponerlo mucho).
3. **Planner** (rediseño + perf).
4. **Employee App** (MVP nativo).
5. **Kiosk Mode** (entitlement-gated + Settings de configuración) — MVP → v1.
   (Quotes, dark-mode y la fundación de diseño entran como quick-wins intercalados.)
