/**
 * Agent Copilot — the intent map, the matcher, and the pre-flight check.
 *
 * Phase 1 of the copilot (design/copilot-mockups, approved 2026-09-01): a
 * static question→intent table over the knowledge Ride already ships. No LLM,
 * no backend, no new endpoint — deterministic, offline, and testable exactly
 * the way curriculum.js is.
 *
 * WHY THIS FILE SITS BESIDE curriculum.js: same "one file, many surfaces"
 * rule. An intent resolves to things that already exist — a Ride University
 * article slug (backend/src/modules/knowledge-base/default-articles.js), a
 * tour module key (curriculum.js), a route — and never to prose of its own
 * except the short curated summary shown inline. The copilot NEVER invents an
 * answer: a question that matches nothing here is a MISS, logged for the
 * authoring backlog, answered honestly with "no lo tengo todavía".
 *
 * THE PRE-FLIGHT CHECK (Hector, 2026-09-01): "Te enseño" never dispatches the
 * tour blind. What a module needs before teaching — a route, or an open
 * reservation — is DERIVED here from the curriculum the tour already obeys
 * (module.needsRecord, module.steps[0].route), never stored again in the map,
 * so the two files cannot drift. See preflightFor().
 */

import { findModule, modulesFor } from './curriculum.js';

// ---------------------------------------------------------------------------
// The map. Each intent names its sources; the panel derives everything else.
//
//   key            — stable identity (miss log, tests, telemetry)
//   aliases        — EN + ES phrasings. The matcher requires every meaningful
//                    token of ONE alias to appear in the question, so aliases
//                    are short noun phrases, not sentences.
//   tourModuleKey  — curriculum module for "Te enseño" (null = no tour yet;
//                    the CTA row degrades honestly by what the map has)
//   route          — where "Llévame allí" navigates (null = record-scoped or
//                    no single screen)
//   articleSlug    — Ride University article for "Ver artículo" (real slugs
//                    from default-articles.js, verified by test)
//   summary        — one curated bilingual lead. For module-backed intents the
//                    panel also renders the module's own step titles + gotcha
//                    (real prose, already translated under training.*).
//   steps          — optional curated bilingual steps, ONLY for intents whose
//                    procedure lives in a playbook rather than a tour module
//                    (the additional-drivers case from the owner's example).
//   source         — the chip naming where the answer came from. No source,
//                    no answer — that rule is enforced by shape: every intent
//                    must carry one (pinned by test).
// ---------------------------------------------------------------------------

export const INTENTS = [
  // ── the owner's example, verbatim: additional drivers ─────────────────────
  // Phase 2 shipped the micro-module (curriculum.js `additional-drivers`), so
  // "Te enseño" fully guides it — record-scoped, parking and all. The last
  // gap closed 2026-09-02: the Ride University article now exists
  // (default-articles.js `additional-drivers`), so the card gained the live
  // article body and the "Ver artículo" deep link. The curated playbook steps
  // stay as the leading answer.
  {
    key: 'additional-drivers',
    aliases: {
      en: ['additional driver', 'add driver', 'extra driver', 'second driver', 'another driver'],
      es: ['conductor adicional', 'chofer adicional', 'otro conductor', 'otro chofer', 'anadir conductor', 'agregar conductor', 'segundo conductor'],
    },
    tourModuleKey: 'additional-drivers',
    route: '/reservations',
    articleSlug: 'additional-drivers',
    summary: {
      en: 'Additional drivers live inside the reservation itself.',
      es: 'Los conductores adicionales viven dentro de la reserva misma.',
    },
    steps: {
      en: [
        'Open the customer’s reservation.',
        'Press the Additional Drivers button.',
        'Add the driver with their license and save.',
      ],
      es: [
        'Abre la reserva del cliente.',
        'Dale al botón Additional Drivers.',
        'Añade el conductor con su licencia y guarda.',
      ],
    },
    gotcha: {
      en: 'Confirm additional drivers BEFORE releasing the vehicle — a driver who is not on the agreement is not covered, and the configured fee does not charge itself after closeout.',
      es: 'Confirma los conductores adicionales ANTES de entregar el vehículo — un conductor que no está en el contrato no está cubierto, y el fee configurado no se cobra solo después del cierre.',
    },
    source: { kind: 'PLAYBOOK', label: 'Playbook: Checkout, Inspection & Payment' },
  },

  // ── counter work: tour-backed, record-scoped ──────────────────────────────
  {
    key: 'check-out',
    aliases: {
      en: ['check out', 'checkout', 'hand over vehicle', 'release vehicle', 'start rental'],
      es: ['check out', 'checkout', 'entregar vehiculo', 'entregar el carro', 'empezar renta', 'sacar el carro'],
    },
    tourModuleKey: 'check-out',
    route: null,
    articleSlug: 'how-to-checkout',
    summary: {
      en: 'The check-out wizard walks the whole handover in order: agreement, terms, payment, photos, signature.',
      es: 'El wizard de check-out camina toda la entrega en orden: contrato, términos, pago, fotos, firma.',
    },
    source: { kind: 'ARTICLE', label: 'How to Check Out a Vehicle' },
  },
  {
    key: 'check-in',
    aliases: {
      en: ['check in', 'checkin', 'return vehicle', 'vehicle return', 'close rental'],
      es: ['check in', 'checkin', 'devolver vehiculo', 'devolucion', 'recibir el carro', 'cerrar renta'],
    },
    tourModuleKey: 'check-in',
    route: null,
    articleSlug: 'how-to-checkin',
    summary: {
      en: 'Check-in compares the return against the check-out photos, captures readings, and computes the fees before you charge them.',
      es: 'El check-in compara el retorno contra las fotos del check-out, captura las lecturas y computa los cargos antes de cobrarlos.',
    },
    source: { kind: 'ARTICLE', label: 'How to Check In a Vehicle' },
  },
  {
    key: 'take-payment',
    aliases: {
      en: ['take a payment', 'charge the customer', 'collect payment', 'record payment', 'payment on reservation'],
      es: ['cobrar', 'cobrar un pago', 'registrar pago', 'procesar pago', 'cobrarle al cliente'],
    },
    tourModuleKey: 'take-payment',
    route: null,
    articleSlug: 'payment-processing',
    summary: {
      en: 'Card, cash or check — recorded on the reservation, with the reference that makes it findable months later.',
      es: 'Tarjeta, efectivo o cheque — registrado en la reserva, con la referencia que lo hace localizable meses después.',
    },
    source: { kind: 'ARTICLE', label: 'Payment Processing Guide' },
  },

  // ── counter work: tour-backed, route-anchored ─────────────────────────────
  {
    key: 'create-reservation',
    aliases: {
      en: ['create reservation', 'new reservation', 'make a booking', 'new booking', 'book a car'],
      es: ['crear reserva', 'nueva reserva', 'hacer una reserva', 'reservar un carro', 'nueva reservacion'],
    },
    tourModuleKey: 'create-reservation',
    route: '/reservations/new',
    articleSlug: null,
    summary: {
      en: 'The four-step wizard books a car from scratch, with a running quote beside you the whole way.',
      es: 'El wizard de cuatro pasos reserva un carro desde cero, con la cotización corriendo al lado todo el camino.',
    },
    source: { kind: 'MODULE', label: 'Ride University: Create a reservation' },
  },
  {
    key: 'find-reservation',
    aliases: {
      en: ['find reservation', 'search reservation', 'look up reservation', 'find a booking', 'find customer reservation'],
      es: ['buscar reserva', 'encontrar reserva', 'buscar una reservacion', 'buscar cliente reserva'],
    },
    tourModuleKey: 'find-reservation',
    route: '/reservations',
    articleSlug: null,
    summary: {
      en: 'Search by name, number, plate or payment reference — you never need to remember which screen something lives on.',
      es: 'Busca por nombre, número, tablilla o referencia de pago — nunca tienes que recordar en qué pantalla vive algo.',
    },
    source: { kind: 'MODULE', label: 'Ride University: Find a reservation' },
  },
  {
    key: 'the-workspace',
    aliases: {
      en: ['dashboard', 'workspace', 'get around', 'where is everything', 'global search'],
      es: ['dashboard', 'pantalla principal', 'donde esta todo', 'buscador global', 'como me muevo'],
    },
    tourModuleKey: 'the-workspace',
    route: '/',
    articleSlug: null,
    summary: {
      en: 'The dashboard, the menu, and how to search from anywhere.',
      es: 'El dashboard, el menú, y cómo buscar desde cualquier pantalla.',
    },
    source: { kind: 'MODULE', label: 'Ride University: The workspace' },
  },
  {
    key: 'overdue-returns',
    aliases: {
      en: ['overdue return', 'overdue rental', 'late return', 'car not returned', 'missing car'],
      es: ['renta vencida', 'retorno tarde', 'no devolvio el carro', 'carro perdido', 'carro no aparece', 'reserva vencida'],
    },
    tourModuleKey: 'overdue-returns',
    route: '/',
    articleSlug: null,
    summary: {
      en: 'A rental is overdue the moment its return time passes. The dashboard counts them, and GPS alerts say where the car actually is.',
      es: 'Una renta está vencida al momento en que pasa su hora de retorno. El dashboard las cuenta, y las alertas de GPS dicen dónde está el carro realmente.',
    },
    source: { kind: 'MODULE', label: 'Ride University: Chase an overdue return' },
  },
  {
    key: 'availability',
    aliases: {
      en: ['availability', 'available cars', 'what is free', 'fleet status report', 'how many cars'],
      es: ['disponibilidad', 'carros disponibles', 'que hay libre', 'cuantos carros', 'inventario disponible'],
    },
    tourModuleKey: 'availability',
    route: '/reports-v2/availability',
    articleSlug: null,
    summary: {
      en: 'Available, reserved, on rent, in maintenance — per vehicle class, right now, exportable.',
      es: 'Disponible, reservado, rentado, en mantenimiento — por clase de vehículo, ahora mismo, exportable.',
    },
    source: { kind: 'MODULE', label: 'Ride University: Check availability' },
  },
  {
    key: 'shuttle-dispatch',
    aliases: {
      en: ['shuttle console', 'dispatch shuttle', 'driver link', 'shuttle driver', 'run the shuttle'],
      es: ['consola de shuttle', 'despachar shuttle', 'link de conductor', 'chofer de shuttle', 'guagua del aeropuerto'],
    },
    tourModuleKey: 'shuttle-dispatch',
    route: '/shuttles',
    articleSlug: 'shuttle-dispatch-and-driver-mode',
    summary: {
      en: 'The live map, who is driving, and the zones that raise alerts. Driver shifts are handed out as links, not logins.',
      es: 'El mapa en vivo, quién está guiando, y las zonas que levantan alertas. Los turnos de conductor se entregan como links, no logins.',
    },
    source: { kind: 'ARTICLE', label: 'Shuttle Dispatch and Driver Links' },
  },
  {
    key: 'shuttle-tracker',
    aliases: {
      en: ['shuttle tracker', 'shuttle request', 'customer shuttle', 'shuttle queue', 'tracker link'],
      es: ['tracker del shuttle', 'pedido de shuttle', 'cliente shuttle', 'cola de shuttle', 'link del tracker'],
    },
    tourModuleKey: 'shuttle-tracker',
    route: '/shuttle',
    articleSlug: 'shuttle-dispatch-and-driver-mode',
    summary: {
      en: 'Customers watch the shuttle move on a live map and request it with one tap — every request lands on the queue screen.',
      es: 'Los clientes ven el shuttle moverse en un mapa en vivo y lo piden con un toque — cada pedido cae en la pantalla de la cola.',
    },
    source: { kind: 'MODULE', label: 'Ride University: The live shuttle tracker' },
  },

  // ── admin work: tour-backed, role-gated ───────────────────────────────────
  {
    key: 'users-and-locations',
    aliases: {
      en: ['add a user', 'new employee', 'create user', 'user locations', 'scope user', 'add agent'],
      es: ['anadir usuario', 'agregar usuario', 'nuevo empleado', 'crear usuario', 'darle acceso', 'asignar sucursal'],
    },
    tourModuleKey: 'users-and-locations',
    route: '/people',
    articleSlug: 'security-basics-for-agents',
    summary: {
      en: 'Roles, and which branches a person can see. Leaving every location UNCHECKED means they see ALL locations.',
      es: 'Roles, y qué sucursales una persona puede ver. Dejar todas las locations SIN marcar significa que ve TODAS.',
    },
    source: { kind: 'MODULE', label: 'Ride University: Add a user and scope them' },
  },
  {
    key: 'incoming-bookings',
    aliases: {
      en: ['incoming bookings', 'broker feed', 'franchise bookings', 'review tray', 'imported reservations'],
      es: ['reservas entrantes', 'feed de broker', 'reservas de franquicia', 'bandeja de revision', 'reservas importadas'],
    },
    tourModuleKey: 'incoming-bookings',
    route: '/settings',
    articleSlug: null,
    summary: {
      en: 'Franchise and broker feeds pull reservations in on a schedule; anything that did not match cleanly waits in the review tray.',
      es: 'Los feeds de franquicia y broker traen reservas en horario; lo que no cruzó limpio espera en la bandeja de revisión.',
    },
    source: { kind: 'MODULE', label: 'Ride University: Bookings arriving on their own' },
  },
  {
    key: 'market-pricing',
    aliases: {
      en: ['market pricing', 'competitor prices', 'price against the market', 'market intelligence', 'pricing strategy'],
      es: ['precios del mercado', 'precios de competidores', 'competencia precios', 'inteligencia de mercado', 'estrategia de precios'],
    },
    tourModuleKey: 'market-pricing',
    route: '/market',
    articleSlug: null,
    summary: {
      en: 'Competitor offers collected nightly, mapped to your vehicle classes, with a strategy that moves prices inside your guardrails.',
      es: 'Ofertas de competidores recogidas cada noche, cruzadas a tus clases de vehículo, con una estrategia que mueve precios dentro de tus límites.',
    },
    source: { kind: 'MODULE', label: 'Ride University: Price against the market' },
  },

  // ── article-only intents: answer + Ver artículo + Llévame ─────────────────
  {
    key: 'damage-disputes',
    aliases: {
      en: ['damage dispute', 'customer disputes damage', 'damage claim', 'vehicle damage argument'],
      es: ['disputa de dano', 'cliente disputa dano', 'reclamo de dano', 'pelea por dano', 'dano al vehiculo disputa'],
    },
    tourModuleKey: null,
    route: '/issues',
    articleSlug: 'handling-damage-disputes',
    summary: {
      en: 'Damage disputes run through Issue Center, with the check-out photos as the evidence that decides them.',
      es: 'Las disputas de daño corren por Issue Center, con las fotos del check-out como la evidencia que las decide.',
    },
    source: { kind: 'ARTICLE', label: 'Handling Damage Disputes' },
  },
  {
    key: 'tolls',
    aliases: {
      en: ['toll charges', 'process tolls', 'toll billing', 'autoexpreso', 'toll on reservation'],
      es: ['peajes', 'cargos de peaje', 'procesar peajes', 'autoexpreso', 'cobrar peaje'],
    },
    tourModuleKey: null,
    route: '/tolls',
    articleSlug: 'processing-toll-charges',
    summary: {
      en: 'Toll crossings land on the Tolls screen, get matched to the rental that drove them, and bill from there.',
      es: 'Los cruces de peaje caen en la pantalla de Tolls, se cruzan con la renta que los guió, y se facturan desde ahí.',
    },
    source: { kind: 'ARTICLE', label: 'Processing Toll Charges' },
  },
  {
    key: 'citations',
    aliases: {
      en: ['citation', 'traffic ticket', 'fine', 'parking ticket', 'multa'],
      es: ['multa', 'boleto', 'citacion', 'ticket de transito', 'foto multa'],
    },
    tourModuleKey: null,
    route: '/citations',
    articleSlug: 'handling-citations',
    summary: {
      en: 'A citation is matched to the rental that was driving, documented, and either charged or disputed — all from the Citations screen.',
      es: 'Una multa se cruza con la renta que estaba guiando, se documenta, y se cobra o se disputa — todo desde la pantalla de Citations.',
    },
    source: { kind: 'ARTICLE', label: 'Handling a Citation' },
  },
  {
    key: 'citation-documents',
    aliases: {
      en: ['citation documents', 'citation export', 'citation paperwork', 'export citations'],
      es: ['documentos de multa', 'exportar multas', 'papeles de la multa', 'evidencia de multa'],
    },
    tourModuleKey: null,
    route: '/citations',
    articleSlug: 'citation-documents-and-export',
    summary: {
      en: 'Each citation carries its documents, and the export file packages them for the issuing agency.',
      es: 'Cada multa carga sus documentos, y el archivo de export los empaqueta para la agencia que la emitió.',
    },
    source: { kind: 'ARTICLE', label: 'Citation Documents and the Export File' },
  },
  {
    key: 'precheckin',
    aliases: {
      en: ['pre-check-in', 'precheckin', 'customer filled online', 'arrival before counter', 'pre check in'],
      es: ['pre-check-in', 'precheckin', 'cliente lleno en linea', 'antes de llegar al counter', 'pre registro'],
    },
    tourModuleKey: null,
    route: '/reservations',
    articleSlug: 'precheckin-and-arrival',
    summary: {
      en: 'Pre-check-in shows what the customer already completed online — and exactly what still has to happen at the counter.',
      es: 'El pre-check-in muestra lo que el cliente ya completó en línea — y exactamente lo que todavía tiene que pasar en el counter.',
    },
    source: { kind: 'ARTICLE', label: 'Pre-Check-in: What Is Done and What Still Is Not' },
  },
  {
    key: 'quotes',
    aliases: {
      en: ['quote', 'price quote', 'quote to reservation', 'send a quote', 'cotizacion'],
      es: ['cotizacion', 'cotizar', 'de cotizacion a reserva', 'mandar cotizacion', 'presupuesto'],
    },
    tourModuleKey: null,
    route: '/quotes',
    articleSlug: 'quote-to-reservation',
    summary: {
      en: 'A quote holds a price for a customer who is not ready to book; one click converts it into the real reservation.',
      es: 'Una cotización aguanta un precio para un cliente que no está listo; un click la convierte en la reserva real.',
    },
    source: { kind: 'ARTICLE', label: 'From a Quote to a Reservation' },
  },
  {
    key: 'monthly-rentals',
    aliases: {
      en: ['monthly rental', 'long term rental', 'monthly plan', 'bill next cycle', 'rent by month'],
      es: ['renta mensual', 'renta a largo plazo', 'plan mensual', 'renta por mes', 'mensualidad'],
    },
    tourModuleKey: 'create-reservation',
    route: '/reservations/new',
    articleSlug: 'long-term-and-monthly-rentals',
    summary: {
      en: 'Monthly must be chosen on the FIRST step of the wizard — picking it later means attaching the plan from the reservation page afterwards.',
      es: 'Mensual se escoge en el PRIMER paso del wizard — escogerlo después significa amarrar el plan desde la página de la reserva luego.',
    },
    source: { kind: 'ARTICLE', label: 'Monthly and Long-Term Rentals' },
  },
  {
    key: 'security-basics',
    aliases: {
      en: ['two factor', '2fa', 'screen lock', 'security pin', 'account security'],
      es: ['dos factores', '2fa', 'bloqueo de pantalla', 'pin de seguridad', 'seguridad de cuenta'],
    },
    tourModuleKey: null,
    route: null,
    articleSlug: 'security-basics-for-agents',
    summary: {
      en: 'Two-factor, the idle screen lock, and why your view may be scoped to your branch — the security habits every agent needs.',
      es: 'Dos factores, el bloqueo de pantalla por inactividad, y por qué tu vista puede estar limitada a tu sucursal — los hábitos de seguridad que todo agente necesita.',
    },
    source: { kind: 'ARTICLE', label: 'Security Basics for Every Agent' },
  },
  {
    key: 'car-sharing',
    aliases: {
      en: ['car sharing trip', 'host trip', 'car sharing workflow', 'sharing handoff'],
      es: ['viaje de car sharing', 'viaje de host', 'flujo de car sharing', 'entrega de sharing'],
    },
    tourModuleKey: null,
    route: '/car-sharing',
    articleSlug: 'car-sharing-trip-workflow',
    summary: {
      en: 'The car-sharing trip lifecycle — booking, host approval, handoff and return — runs on its own screen, separate from counter rentals.',
      es: 'El ciclo de un viaje de car sharing — booking, aprobación del host, entrega y retorno — corre en su propia pantalla, separado de las rentas del counter.',
    },
    source: { kind: 'ARTICLE', label: 'Car Sharing Trip Workflow' },
  },
  {
    key: 'maintenance-holds',
    aliases: {
      en: ['maintenance hold', 'take vehicle down', 'car in shop', 'out of service', 'oil change hold'],
      es: ['mantenimiento', 'bajar vehiculo', 'carro en el taller', 'fuera de servicio', 'cambio de aceite'],
    },
    tourModuleKey: null,
    route: '/maintenance',
    articleSlug: 'maintenance-holds',
    summary: {
      en: 'A maintenance hold takes the vehicle out of the bookable fleet for a window, so the planner never promises a car that is in the shop.',
      es: 'Un hold de mantenimiento saca el vehículo de la flota reservable por una ventana, para que el planner nunca prometa un carro que está en el taller.',
    },
    source: { kind: 'ARTICLE', label: 'Taking a Vehicle Down for Maintenance' },
  },
  {
    key: 'loaner-program',
    aliases: {
      en: ['loaner', 'dealership loaner', 'service loaner', 'repair order loaner', 'courtesy car'],
      es: ['loaner', 'carro de cortesia', 'prestamo del dealer', 'orden de reparacion', 'vehiculo de reemplazo'],
    },
    tourModuleKey: null,
    route: '/loaner',
    articleSlug: 'loaner-program',
    summary: {
      en: 'The loaner program runs service-lane vehicles end to end: intake with the repair order, the loan itself, and the return when service closes.',
      es: 'El programa de loaner corre los vehículos de service de punta a punta: intake con la orden de reparación, el préstamo mismo, y el retorno cuando cierra el servicio.',
    },
    source: { kind: 'ARTICLE', label: 'The Loaner Program, End to End' },
  },
  {
    key: 'kiosk-operations',
    aliases: {
      en: ['kiosk', 'self service kiosk', 'kiosk device', 'run a kiosk'],
      es: ['kiosko', 'kiosco', 'quiosco', 'maquina de auto servicio'],
    },
    tourModuleKey: null,
    route: '/kiosks',
    articleSlug: 'kiosk-operations',
    summary: {
      en: 'Kiosks run the customer-facing self-service flow on a dedicated device; the Kiosks screen is where they are provisioned and watched.',
      es: 'Los kioskos corren el flujo de auto-servicio del cliente en un equipo dedicado; la pantalla de Kiosks es donde se preparan y se vigilan.',
    },
    source: { kind: 'ARTICLE', label: 'Running a Kiosk' },
  },
];

// ---------------------------------------------------------------------------
// Matching. Deterministic and forgiving of morphology, not of meaning: a
// question matches an intent when EVERY meaningful token of at least one alias
// appears in it (prefix-tolerant, so "conductores" finds "conductor"). No
// fuzzy scoring across unrelated words — a wrong answer at a rental counter is
// worse than "no lo tengo".
// ---------------------------------------------------------------------------

/** Words that carry no intent on their own, in either language. */
const STOPWORDS = new Set([
  // EN
  'how', 'do', 'i', 'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'my',
  'me', 'you', 'is', 'it', 'can', 'what', 'where', 'when', 'add', 'make',
  // ES (normalized — accents already stripped)
  'como', 'se', 'hace', 'hago', 'un', 'una', 'el', 'la', 'los', 'las', 'de',
  'del', 'en', 'que', 'para', 'mi', 'yo', 'puedo', 'donde', 'cuando', 'al',
  'le', 'lo', 'es', 'y', 'o', 'pongo', 'con',
]);

/** Lowercase, strip diacritics, keep letters and digits. */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalize(text).split(' ').filter((w) => w && !STOPWORDS.has(w));
}

/**
 * How well query token `q` hits alias token `a`: 2 for exact, 1 for a prefix
 * relationship at length ≥ 4 (so plurals and light conjugation match —
 * "conductores"/"conductor", "checkout"/"check" — without two-letter
 * fragments matching everything), 0 otherwise. Exact outweighing prefix is a
 * real tiebreak: "check in a vehicle" must beat check-OUT's "checkout" alias,
 * which only prefix-matches "check".
 */
function tokenHit(q, a) {
  if (q === a) return 2;
  const [shorter, longer] = q.length <= a.length ? [q, a] : [a, q];
  if (shorter.length >= 4 && longer.startsWith(shorter)) return 1;
  // Light stemming for Spanish conjugation: a shared root of ≥ 4 with short
  // differing tails ("cobro"/"cobrar", "guio"/"guiar") is the same word for
  // our purposes; anything looser starts matching unrelated words.
  let common = 0;
  while (common < shorter.length && shorter[common] === longer[common]) common += 1;
  if (common >= 4 && shorter.length - common <= 2 && longer.length - common <= 2) return 1;
  return 0;
}

/**
 * Match a free-typed question to an intent.
 *
 * @returns {{ intent: object, score: number } | null} null = MISS
 */
export function matchIntent(question) {
  const qTokens = tokens(question);
  if (!qTokens.length) return null;
  let best = null;
  for (const intent of INTENTS) {
    const aliases = [...(intent.aliases?.en || []), ...(intent.aliases?.es || [])];
    for (const alias of aliases) {
      const aTokens = tokens(alias);
      if (!aTokens.length) continue;
      // EVERY alias token must be hit for the alias to count at all; the
      // score then favors exact hits and longer (more specific) phrases.
      // Remaining ties keep the FIRST intent in the file, so ordering in
      // INTENTS is a real tiebreak (the owner's example sits first on
      // purpose).
      let score = 0;
      let allHit = true;
      for (const a of aTokens) {
        const hit = Math.max(0, ...qTokens.map((q) => tokenHit(q, a)));
        if (!hit) { allHit = false; break; }
        score += hit;
      }
      if (!allHit) continue;
      if (!best || score > best.score) best = { intent, score };
    }
  }
  return best;
}

export function findIntent(key) {
  return INTENTS.find((i) => i.key === String(key)) || null;
}

// ---------------------------------------------------------------------------
// CTA derivation — what the answer card may offer, honestly.
// ---------------------------------------------------------------------------

/**
 * Which CTAs an intent supports for THIS viewer.
 *
 * Role & gate awareness (guardrail 4): the candidate module filters through
 * modulesFor(viewer) — the same gating the tour itself uses. An AGENT asking
 * about Settings gets `adminOnly: true` (the honest "eso lo hace un admin")
 * with the article still offered, never a tour that dies on a missing anchor.
 */
export function ctasFor(intent, viewer = {}) {
  if (!intent) return { teach: false, go: null, article: null, adminOnly: false };
  let teach = false;
  let adminOnly = false;
  if (intent.tourModuleKey) {
    const allowed = modulesFor(viewer).some((m) => m.key === intent.tourModuleKey);
    if (allowed) teach = true;
    else adminOnly = true;
  }
  return {
    teach,
    // A role-gated intent hides navigation too: sending an agent to a screen
    // they cannot use is the same broken promise as touring them through it.
    go: adminOnly ? null : (intent.route || null),
    article: intent.articleSlug || null,
    adminOnly,
  };
}

// ---------------------------------------------------------------------------
// Pre-flight — right place before teaching (Hector, 2026-09-01).
// ---------------------------------------------------------------------------

export const PREFLIGHT = Object.freeze({
  HERE: 'HERE',                 // route-anchored and already on its screen
  ASK_HERE: 'ASK_HERE',         // record-scoped and a reservation IS open — ASK which one
  NAVIGATE: 'NAVIGATE',         // route-anchored, elsewhere — announce, then move
  NEEDS_RECORD: 'NEEDS_RECORD', // record-scoped, no reservation open — ask for theirs
});

/** The reservation id in a /reservations/<id>… path, or null. `/reservations/new` is the wizard, not a record. */
export function reservationIdFromPath(pathname) {
  const m = /^\/reservations\/([^/?#]+)/.exec(String(pathname || ''));
  if (!m || m[1] === 'new') return null;
  return m[1];
}

/**
 * What must be true before "Te enseño" dispatches — derived from the
 * curriculum the tour already obeys (module.needsRecord, steps[0].route),
 * never stored in the intent map, so the two files cannot drift.
 *
 * Four outcomes; the panel owns the words and the motion for each.
 */
export function preflightFor(module, pathname) {
  if (!module) return { kind: PREFLIGHT.HERE };
  if (module.needsRecord) {
    const recordId = reservationIdFromPath(pathname);
    return recordId
      ? { kind: PREFLIGHT.ASK_HERE, recordId }
      : { kind: PREFLIGHT.NEEDS_RECORD, go: module.needsRecord };
  }
  const first = module.steps?.[0];
  if (first?.route && pathname !== first.route) {
    return { kind: PREFLIGHT.NAVIGATE, to: first.route };
  }
  return { kind: PREFLIGHT.HERE };
}

/**
 * Human name for a route, for the "Te llevo a {{screen}} primero" line.
 * Bilingual where the product name differs; most screens keep their English
 * product name in both languages, matching the sidebar.
 */
const SCREEN_NAMES = {
  '/': { en: 'the Dashboard', es: 'el Dashboard' },
  '/reservations': { en: 'Reservations', es: 'Reservations' },
  '/reservations/new': { en: 'the new-reservation wizard', es: 'el wizard de nueva reserva' },
  '/shuttles': { en: 'the Shuttle console', es: 'la consola de Shuttles' },
  '/shuttle': { en: 'the Shuttle queue', es: 'la cola del Shuttle' },
  '/people': { en: 'People', es: 'People' },
  '/settings': { en: 'Settings', es: 'Settings' },
  '/market': { en: 'Market', es: 'Market' },
  '/reports-v2/availability': { en: 'the Availability report', es: 'el reporte de Availability' },
  '/knowledge-base': { en: 'Ride University', es: 'Ride University' },
};

export function screenNameFor(route, lang = 'en') {
  const entry = SCREEN_NAMES[route];
  if (entry) return entry[lang === 'es' ? 'es' : 'en'] || entry.en;
  return route || '';
}

// ---------------------------------------------------------------------------
// The miss log — the authoring backlog (Phase 1 telemetry, guardrail 2).
//
// localStorage ring buffer + console line, deliberately no backend: Phase 1
// learns what to add by asking the team what the copilot could not answer.
// ---------------------------------------------------------------------------

export const MISS_LOG_KEY = 'copilot.misses';
export const MISS_LOG_MAX = 50;

export function readMisses(storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(MISS_LOG_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Record an unanswered question. Newest last, capped at MISS_LOG_MAX (oldest
 * fall off — it is a ring buffer, not an archive). Also says so on the
 * console, so a dev tools window at the counter shows the misses live.
 */
export function logMiss(question, { lang = 'en', flagged = false, pathname = null, storage } = {}) {
  // `pathname` (Phase 2): where the person was when they asked — flushed to
  // the server-side miss table so the authoring backlog carries context.
  const entry = { q: String(question || '').slice(0, 300), lang, flagged, pathname: pathname || null, at: new Date().toISOString() };
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (store) {
    try {
      const list = readMisses(store);
      list.push(entry);
      store.setItem(MISS_LOG_KEY, JSON.stringify(list.slice(-MISS_LOG_MAX)));
    } catch { /* private browsing — the console line below still fires */ }
  }
  try {
    // eslint-disable-next-line no-console
    console.info('[copilot] miss:', entry.q, entry);
  } catch { /* no console */ }
  return entry;
}

/** Mark the most recent miss as flagged for an admin ("Avisar a un admin"). */
export function flagLastMiss(storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store) return null;
  try {
    const list = readMisses(store);
    if (!list.length) return null;
    const last = { ...list[list.length - 1], flagged: true };
    list[list.length - 1] = last;
    store.setItem(MISS_LOG_KEY, JSON.stringify(list));
    return last;
  } catch {
    return null;
  }
}

// Re-exported so the panel resolves modules through one import path.
export { findModule };
