# Ride Kiosk — Plan de producto: kiosk 100% autónomo (2026-06-11)

Decisiones de Hector (2026-06-11): **tablet v1 → kiosk full v2** · **touch-first con AI
conversacional opcional** · **pago = payment link de iPOS o terminal físico integrado** ·
**escalación = video en vivo dentro del kiosk (módulo nativo que REEMPLAZA a VideFace)**.

Proyecto Manuel Shop (Monday 12246821853). Basado en la auditoría
`doc/manuel-shop-audit-2026-06-11.md`. Productos nativos Ride — cero third-party.

## 1. Visión
Un cliente llega al counter sin fila: el kiosk lo detecta, lo saluda, verifica su ID,
encuentra su reserva, le vende los ancillaries correctos según su perfil/broker, cobra,
asigna el carro, firma, y le dice dónde están las llaves — sin humano. Solo si el cliente
Y el AI no pueden resolver, entra un agente humano POR VIDEO en el mismo kiosk. El pool de
agentes que hoy CORPUSA paga para 4 mercados (FLL/LA/MIA/MCO, 9+ kiosks) se reduce a
fallback. Manuel deja de atender kiosks de Miami a mano.

## 2. Lo que la auditoría definió (no negociable en el diseño)
- **El revenue es el upsell**: base rate $0 (OTA prepagada) + CDW $24/d + SunPass $13/d +
  DCF $16/d + 3% + tax = $522 en una renta "gratis" de 9 días. El kiosk ES la máquina de
  vender esto.
- **El upsell varía POR BROKER**: Priceline llega con add-ons ya cobrados ("BROKER HAS
  ALREADY COLLECTED THE ADD-ONS"), Expedia no. El engine debe leer el canal y ajustar la
  oferta (no ofrecer lo ya pagado; pivotear a upgrade/fuel/seat).
- **Flujo de pago real**: Security Auth $250 (depósito) + captura de ancillaries al pickup.
- **Cadencia**: pickups cada 30 min, ~74 reservas/día entrantes, 11.65% no-show.
- La sesión termina en CONTRATO (agreement) — no es un chatbot, es un checkout.

## 3. Arquitectura (sobre lo que ya existe)

### Kiosk App (nuevo, frontend)
- Next.js standalone (mismo repo, target tablet fullscreen/PWA kiosk-mode v1; Chrome kiosk
  en hardware dedicado v2). Touch-first, wizard de pasos grandes, ES/EN.
- Reusa: license scanner **BarcodeDetector pdf417 + AAMVA parser (beta.138-139, ya probado
  en tablet)**, vehicleDiagrams (inspección), señalización de pago.
- Detección de presencia v1: tap "Start" / sensor de cámara simple (motion) que dispara el
  saludo (el "Force Call" autónomo). v2: sensor dedicado.

### Backend: módulo `kiosk` (nuevo)
- `KioskDevice` (tenant, location, nombre, estado, heartbeat) + `KioskSession` (estado
  conversacional + checkout, cliente, reserva, outcome: COMPLETED/ESCALATED/ABANDONED).
- Auth de dispositivo: token por kiosk (patrón HandoffToken existente, kind nuevo
  KIOSK_DEVICE sin TTL corto + rotación).
- API: el kiosk habla SOLO con Ride Fleet Manager por REST (mismo backend, rutas
  `/api/kiosk/*` tenant-scoped) — sesión, búsqueda de reserva, oferta de upsell, pago,
  asignación, firma, escalación.
- Reusa la state machine del checkout-session v2 (toStep cascade hasta CLOSED) con un
  caller nuevo tipo `kioskSession` — los guards existentes aplican (no-car-no-checkout 422,
  fee-engine, recordMileageEntry, contrato con coalesce de inspección).

### Upsell Engine nativo (nuevo, el corazón comercial)
- Catálogo de ancillaries por tenant (equivalente a Optional Services de TSD): código,
  descripción, charge type (daily/one-time), monto, flags (bundled/included), tax.
  El fee-engine actual es one-time-bias → se EXTIENDE a daily addons (cantidad × días).
- **Reglas por canal/broker**: tabla `UpsellRule` (channel/source → qué ofrecer, qué NO
  ofrecer, orden, precio A/B). Expedia → CDW+SunPass+DCF; Priceline → upgrade+fuel.
- Estrategias nativas v1 (determinísticas, medibles):
  1. Anchor + decoy: 3 paquetes (Basic / **Recomendado** / Premium) en vez de línea por línea.
  2. Upgrade de clase con scarcity real (lee disponibilidad del planner: "quedan 2 SUV").
  3. SunPass pitch por geografía del viaje (Orlando = peajes seguros).
  4. Decline-flow: si rechaza CDW → contraoferta deducible parcial (downsell).
  5. Bundle "todo incluido" con descuento vs suma de partes.
- AI layer encima: explica, responde objeciones, negocia dentro de límites configurados
  (floor/ceiling por tenant) — nunca inventa precios; lee del engine.
- Telemetría por oferta: shown/accepted/declined/escalated → attach rate por agente=kiosk,
  por broker, por estrategia (dashboard).

### AI conversacional (opcional sobre touch)
- Botón "Ask me anything" / micrófono en cada paso; LLM con contexto de la sesión (reserva,
  broker, addons, políticas del tenant) + RAG de políticas (depósitos, edad, debit cards).
- Resuelve: dudas de cobros, requisitos, direcciones, cambios simples (extender días →
  recotiza vía pricing existente).
- NO resuelve (escala directo): disputas de cobro, ID que no pasa, cliente sin reserva ni
  tarjeta válida, menores de edad, daños/claims.

### Escalación: módulo "Remote Agent" (nuevo — mata a VideFace)
- Ladder: (1) UI guiada → (2) AI → (3) **video en vivo en el kiosk**.
- WebRTC (LiveKit/Twilio self-hosted opción a evaluar; preferencia: LiveKit OSS en el
  droplet para mantener "cero third-party" razonable) — consola de agente DENTRO de Ride
  Fleet Manager: cola de escalaciones con CONTEXTO completo (paso donde se trabó, reserva,
  ID escaneado, intentos del AI) — ventaja brutal vs VideFace que arranca de cero.
- El agente puede: completar el paso remoto (co-driving del wizard), override de precio
  (permiso), tomar el checkout manual.
- Grabación: full session en Supabase Storage (no 24h como VideFace) + audit log.
- Métrica norte: **% de sesiones resueltas sin humano** (target v1: >70%).

### Pago (MONEY — diff línea a línea con Hector SIEMPRE)
- v1: **iPOS payment link** — QR en pantalla del kiosk / SMS al teléfono del cliente
  (iPOS ya está integrado en Ride). Flujo: deposit auth + captura de ancillaries espejo
  del flujo TSD ($250 + addons). Webhook/poll de confirmación → avanza el wizard.
- v2: terminal físico integrado en el kiosk (Dejavoo/iPOS semi-integrado ya soportado).
- Regla dura existente: agentes nunca teclean credenciales; el cliente paga en SU teléfono
  o en el terminal.

## 4. Flujo del cliente (happy path v1)
1. Presencia → saludo bilingüe → "¿Tienes reserva?" (QR del email de confirmación o
   apellido+confirmación).
2. Encuentra reserva (lookup por confirmación ZE*/WXX* o teléfono) → muestra resumen.
3. **Escaneo de licencia** (pdf417, ya existe) → match nombre vs reserva + edad → foto
   selfie de verificación (liveness simple v1: foto + comparación manual del agente solo
   si dudosa; v2: face-match automático).
4. **Upsell** (paquetes por broker) → add/decline → recibo en pantalla.
5. **Pago**: QR de iPOS payment link (deposit + addons) → confirma webhook.
6. Asignación de unidad (auto-sugerida del pool AVAILABLE de la clase; upgrade si lo
   compró) → contrato en pantalla → **firma táctil** → email del contrato.
7. Instrucciones de llaves: v1 keybox con código por sesión / staff entrega; v2 dispensador.
8. Opcional: link de customer inspection (beta.160) al teléfono — el cliente documenta
   daños ANTES de salir → cierra el loop con Damage Reports→Repair Orders.
9. Si algo falla 2 veces o el cliente lo pide → "Connecting you to an agent" → video.

## 5. Fases
- **Fase A (diseño)**: mockups del wizard kiosk + consola de agente (estilo line-art
  violeta aprobado), spec de UpsellRule + catálogo, contrato de API `/api/kiosk/*`.
  Validar EN VIVO con Manuel (este proyecto no tiene gate, pero el flujo de pago sí lo
  revisa Hector línea a línea).
- **Fase B**: backend kiosk module + catálogo/upsell engine + extensión daily-addons del
  fee-engine (tests canónicos estilo test:fees) + lookup de reservas por confirmación.
- **Fase C**: kiosk app v1 en tablet (sin pago real, sandbox iPOS) — demo con Manuel en
  Orlando 1.
- **Fase D**: pago iPOS payment link end-to-end (review de Hector) + firma + contrato +
  piloto controlado horas valle con staff de respaldo al lado.
- **Fase E**: AI conversacional + telemetría de upsell + dashboard attach-rate.
- **Fase F**: Remote Agent (video) — reemplazo total de VideFace; pool de agentes Ride.
- **Fase G (v2 hardware)**: kiosk físico, terminal integrado, keybox/dispensador, face-match.

## 6. Métricas del piloto (Orlando 1-2)
- % sesiones completadas sin humano (target >70% v1)
- Tiempo de counter (hoy ~? min con agente — medir baseline con Manuel) → target <6 min
- Attach rate de ancillaries vs counter humano (baseline: el counter actual de Manuel)
- Revenue por checkout vs baseline · escalaciones por motivo · abandono por paso

## 7. Qué NO hace v1
Walk-ups sin reserva (los manda al agente/video), cash, multi-driver complejo, claims,
extensiones de contrato abierto, face-match automático, dispensado de llaves.

## 8. Preguntas para Manuel (próxima sesión en vivo)
1. ¿Qué hace exactamente el agente VideFace durante una llamada, paso a paso? (observar una)
2. ¿Dónde viven las llaves hoy? ¿Lockbox con código sirve para v1?
3. Attach rate actual de CDW/SunPass/DCF por agente humano (baseline para el AB).
4. ¿Las otras 2 locations de TSD (MA/NE) y los mercados de LA/Miami/FLL — mismo dueño,
   misma operación? ¿El piloto es solo Orlando?
5. Reglas de negocio del counter: edad mínima, debit card policy, depósito por clase.
