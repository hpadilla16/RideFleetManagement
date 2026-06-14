# Plan de ingestión de portales de Citations (T2 + tolls) — 2026-06-12

Plan para construir la capa de **ingestión de tickets** del producto nativo **Citations**
del Manuel Shop list, replicando — y mejorando — el modelo de Huur (`huur-usa.com`).
Relacionado: `doc/manuel-shop-audit-2026-06-11.md` (Citations + conector SunPass son 2 de
los 8 productos), Monday item 12246821853 (Manuel Shop Stand-up).

---

## 1. Qué hace Huur (blueprint confirmado en vivo)

Recon hecho dentro de la app de Huur logueado como **Zezgo car rent User** (1,228
violaciones, $65,287, data desde 2017). Backend = API .NET en Azure
`agsm-huur-production-api.azurewebsites.net`. Hallazgos:

- **Violations** (`/ExternalViolation/...`, `/Booking/get-charges-violations`): las
  citaciones entran de **fuente externa**. El botón "View" de cada violación hace
  **deep-link directo al portal de la agencia emisora** — ej.
  `fortlauderdaleparking.t2hosted.com`. O sea: jalan las citaciones de los **portales
  municipales de parking**, indexadas **por placa**. Agencias vistas: City of Fort
  Lauderdale, City of Dania Beach.
- **Tolls** (`/Booking/get-charges-tolls`): filtran por **Plate #** y **Transponder #**
  (ej. `011112222010`). Modelo SunPass/E-ZPass — jalan los pasajes de la **cuenta de
  transponder / autoridad de peaje**.
- **Documents**: subida manual de PDF/imagen del ticket como respaldo.
- **Matching al renter**: endpoints `Booking/*` traen las reservas (Huur integra con
  TSD, HQ Rental Software, ASAP) y cruzan placa + fecha contra la reserva activa.

**Nuestra ventaja:** el matching placa↔reserva↔renter ya es nativo en Ride Fleet
(`vehicle-status-sync`, reservas, RentalAgreement). NO necesitamos el conector CRM que
Huur vende. Solo tenemos que construir el **lado de ingestión** (portales + tolls) y
amarrarlo al modelo que ya existe — exactamente como dice el audit: "amarre vehículo +
reserva, notificación inmediata".

---

## 2. Sobre T2 Systems (la fuente #1 de violations)

- T2 Systems es el SaaS dominante de parking/citations de EEUU; **+2,000 clientes**
  (municipios, universidades, operadores privados). Propiedad de **Verra Mobility** desde
  2021 (la misma Verra/ATS que está detrás de `rentalcarticket.com` — competidor directo
  del espacio de Huur).
- Todos los portales viven en `https://{slug}.t2hosted.com/Account/Portal`.
- **Búsqueda pública de citación SIN login** (guest): formulario con
  `Plate Number` + `State` (combobox), **o** `Citation Number`. Confirmado en el DOM de
  Fort Lauderdale (`ref: Plate Number / State / Citation Number`).
- Guest registration / login en `/cmn/auth_guest.aspx`, `/cmn/newuser.aspx`.
- Plataforma backend: **T2 Flex** (permits + enforcement + citations). Hay **API oficial
  T2 Link / T2 Flex API** para integraciones — vía Verra Mobility, no pública; requiere
  contrato. Esa es la ruta "limpia" a mediano plazo; el scrape del guest portal es la
  ruta inmediata.

---

## 2b. Topología de despliegue — DECISIÓN (Hector, 2026-06-12)

**Regla rectora:** todo es software nuestro, bajo nuestro ecosistema — nada third-party ni
alojado afuera. Pero se separa por CAPA, no por sistema:

- **Producto → nativo en Ride Fleet Manager (mismo app + misma DB Supabase):** schema,
  matching placa↔reserva↔renter, UI, billing, notificaciones. Co-locar en la misma DB es un
  *join* (microsegundos), sin salto de red, sin duplicar reservas → **más rápido, correcto a
  largo plazo**. Las tablas son append-mostly; con índices aguantan millones de filas; el
  matching es event-driven, no poll constante. El amarre nativo es nuestra ventaja sobre Huur.
- **Ingestión (scraping headless + proxies) → droplet aparte, NO en prod:** el headless
  Chrome es lo único que degrada performance (RAM/CPU, zombies, disco al 75%, IP-blocks →
  proxies residenciales). **Reutilizar/extender `ridefleet-scraper-prod`** (138.197.27.209,
  Python/Browserbase, ya corre el pricing). Un 2º droplet de scraping sólo si el volumen
  satura — eso es escalar ingestión, no separar el producto.
- **Puente = endpoint de ingestión autenticado:** scraper-droplet → normaliza → `POST
  /api/citations/ingest` (tenant-scoped, idempotente). El droplet es un **productor tonto**
  que escribe a NUESTRA misma DB → sigue siendo un solo sistema, no integración third-party.

Resumen: **producto adentro (nativo, rápido) · scraping afuera escribiendo a la misma DB.**
NO es droplet-separado-por-API alojando el producto (eso recrearía el problema de Huur).

## 3. Arquitectura de ingestión propuesta

Patrón de **adapters** (un conector por fuente, interfaz común), corriendo en el
**worker** (no en `main.js`), con scheduler tipo el toll auto-sync que ya movimos al
worker en beta.150. Reusar el patrón del **scraper droplet** (Python/Browserbase) que ya
existe para pricing — mismo modelo de sesiones frescas + retries + splay.

```
                    ┌─────────────────────────────────────────┐
                    │  Ride Fleet  (vehículos, reservas, RA)   │
                    └───────────────▲─────────────────────────┘
                                    │ match placa+fecha → reserva/renter
       ┌────────────────────────────┴───────────────────────────┐
       │              Violation/Toll Ingestion Service            │
       │   (worker · cola por placa · normaliza a schema común)   │
       └───┬───────────────┬───────────────┬─────────────────────┘
           │               │               │
  ┌────────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────┐
  │ T2 Connector  │ │ SunPass Conn │ │ Manual Upload  │
  │ (guest scrape)│ │ (transponder)│ │ (PDF/foto OCR) │
  └───────────────┘ └──────────────┘ └────────────────┘
   por slug/ciudad   cuenta 91002658   respaldo humano
```

**Interfaz común del adapter** (cada conector implementa):
- `discover(plate, state) -> [RawCitation]` — busca por placa+estado.
- `fetchDetail(externalId) -> RawCitationDetail` — monto, fecha, ubicación, agencia, doc URL.
- `normalize(raw) -> ExternalViolation` — al schema canónico de abajo.
- Metadata: `sourceType` (T2|SUNPASS|MANUAL|OTHER), `agency`, `portalSlug`, `lastSyncAt`.

**Cadencia:** por placa activa, no full-fleet cada vez. Gate por `lastSuccessAt` (lección
del scraper: un run manual mueve el gate). Splay aleatorio para no martillar un portal.
Priorizar placas con reserva CHECKED_OUT o devueltas en los últimos N días.

---

## 4. Schema (Prisma, additive only)

Espejo de lo que vimos en Huur pero nativo:

```prisma
model ExternalViolation {
  id            String   @id @default(cuid())
  tenantId      String
  source        ViolationSource           // T2 | SUNPASS | MANUAL | OTHER
  portalSlug    String?                    // "fortlauderdaleparking"
  agency        String                     // "City of Fort Lauderdale"
  citationNo    String                     // "A200200411"
  plate         String
  plateState    String                     // "FL"
  issuedAt      DateTime
  amount        Decimal  @db.Decimal(10,2)
  fee           Decimal  @db.Decimal(10,2) @default(0)
  status        ViolationStatus            // NEW | MATCHED | BILLED | DISPUTED | PAID | VOID
  externalUrl   String?                    // deep-link al portal de la agencia
  documentPath  String?                    // Supabase bucket:path (foto/PDF)
  vehicleId     String?                    // amarre — FK Vehicle
  reservationId String?                    // amarre — FK Reservation
  rawPayload    Json
  syncedAt      DateTime @default(now())
  @@unique([tenantId, source, citationNo])
  @@index([tenantId, plate, plateState])
  @@index([tenantId, status])
}

model PortalConnector {
  id          String   @id @default(cuid())
  tenantId    String
  source      ViolationSource
  slug        String                       // subdominio t2hosted o id de cuenta toll
  displayName String
  state       String?
  enabled     Boolean  @default(true)
  authMode    String                       // GUEST | CREDENTIALED | API
  lastSuccessAt DateTime?
  config      Json                         // credenciales (vault), selectores, etc.
  @@unique([tenantId, source, slug])
}
```

Notas de seguridad de schema (regla dura del repo): cualquier credencial va al **vault /
`.env` del droplet**, nunca en la tabla en claro; `redactSensitive()` en logs; el módulo
del worker que importe esto va en el `FILES[]` del ship script (causa #1 de boot crashes).

---

## 5. Conectores — detalle

### 5.1 T2 Connector (guest scrape) — P0
- Browser headless (Browserbase / puppeteer singleton `withPage()`, semáforo
  `PUPPETEER_MAX_CONCURRENT_PAGES`) → `https://{slug}.t2hosted.com/Account/Portal`.
- Llenar `Plate Number` + seleccionar `State` → submit → parsear tabla de resultados →
  por cada citación, `fetchDetail` para monto/fecha/agencia/URL.
- Un `PortalConnector` por ciudad (slug). Empezar por las ciudades donde Manuel/ZEZGO
  ORLANDO opera (ver §6, foco FL).
- **Anti-bot / ToS:** igual que TL International, puede requerir **proxy residencial** por
  ciudad y respetar rate-limits. Detección de banner de error → retry con sesión fresca.
  **Antes de scrapear a escala: revisar los Terms de cada portal y de Verra Mobility.**
  La búsqueda por placa es pública (guest), pero el scraping automatizado puede violar ToS
  — decisión de negocio + legal de Hector antes de prod.

### 5.2 SunPass Connector (tolls) — P0
- Cuenta existente **SunPass 91002658** (601 placas, ~$230/día — del audit).
- Login credentialed → descargar transacciones por placa/transponder → normalizar.
- Mismo patrón de proxy/sesión. Esto es el "conector SunPass" del audit, ya definido.
- E-ZPass como fase posterior si la flota cruza al noreste.

### 5.3 Manual Upload + OCR — P1
- Respaldo: empleado sube foto/PDF del ticket → OCR (extrae citación, placa, monto,
  agencia) → cae en la misma cola de matching. Cubre agencias sin portal o sin scrape.

### 5.4 T2 Flex API oficial — P2 (objetivo a mediano plazo)
- Vía Verra Mobility. Reemplaza el scrape donde se pueda con un feed contractual estable.
  Requiere contrato comercial; explorar después de validar el producto con el scrape.

---

## 6. Lista de portales T2 — VERIFICADA por DNS (2026-06-12)

Metodología (importante, ver §6.1): **crt.sh NO sirve** como enumerador porque T2 usa
**certificados wildcard `*.t2hosted.com`** (los portales de clientes no aparecen en los
logs de transparencia). Los **resultados de búsqueda web están stale** (devuelven portales
ya muertos, ej. `charlestonsc`, `norfolk`, `tampaparking`, `harvardparking` → hoy NXDOMAIN).
El único enumerador confiable es **resolver DNS + probar HTTP cada slug candidato**. La
lista de abajo es el subconjunto **confirmado vivo por DNS** (3 resolvers: 8.8.8.8 / 1.1.1.1
/ 9.9.9.9) de una wordlist de ~183 nombres comunes. **NO es exhaustiva** — T2 tiene +2,000
clientes; esto son los nombres "obvios" que pegaron.

### 🔴 Hallazgo crítico para ZEZGO ORLANDO / Manuel
**En Florida, de las ciudades, SOLO Fort Lauderdale está en T2.** Orlando, Miami (ciudad),
Tampa, Jacksonville, etc. **NO usan T2** (verificado NXDOMAIN). Como la operación real de
Manuel es en **Orlando**, el scraping de T2 cubre **casi nada** de su footprint de
violations. → **T2 es solo UNA fuente; para Orlando hay que conectar las agencias propias
de allá por separado** (City of Orlando Parking, Orange County, OPD — investigar qué
plataforma usan; probablemente no T2). Las universidades FL en T2 (UM, USF, FGCU,
Embry-Riddle) casi nunca emiten a carros de renta, así que son baja prioridad.

### Ciudades / municipios en T2 (vivos por DNS)
| Agencia | Slug |
|---|---|
| City of Fort Lauderdale, FL ✅ (visitado en vivo) | `fortlauderdaleparking.t2hosted.com` |
| City of Houston, TX | `houstonparking.t2hosted.com` |
| City of Columbia, SC | `columbiasc.t2hosted.com` |
| City of Davenport, IA | `davenport.t2hosted.com` |
| City of Lafayette, IN | `lafayette.t2hosted.com` |
| City of Newark, DE | `newark.t2hosted.com` |
| City of Rehoboth Beach, DE | `cityofrehoboth.t2hosted.com` |
| Borough of State College, PA | `statecollege.t2hosted.com` |
| City of Memphis, TN | `memphis.t2hosted.com` |
| City of Louisville, KY | `louisville.t2hosted.com` |
| American University, DC* | `american.t2hosted.com` |

\* `american` = probablemente American University (DC), no una ciudad. Confirmar al probar HTTP.

### Universidades en T2 (vivas por DNS) — baja prioridad para renta
`universityofmiami` · `usfpts` (USF) · `fgcu` · `embryriddle` (las 4 en FL) · `purdue` ·
`udel` (U. Delaware) · `umt` (U. Montana) · `wrightparking` (Wright State) · `usc` ·
`ucr` (UC Riverside) · `cornelltransportation` (Cornell) · `psu` (Penn State) ·
`umd` (Maryland) · `umass` · `duke` · `clemson` · `uga` (Georgia) · `lsu` · `utexas` ·
`michiganstate` / `msu` · `colostate` (Colorado State).

Todos resuelven a la infra de T2 (`64.72.147.220` directo, o CNAME `t2systems.que-it.net`).

### 6.1 Cómo construir la lista MAESTRA completa (fase de discovery, correr en el droplet)
1. **Wordlist grande**: todas las ciudades de EEUU >25k hab + condados + universidades +
   sufijos (`parking`, `cityof`, `{abbr}`). Hay datasets públicos de municipios/colleges.
2. **Resolver DNS** cada candidato contra un resolver estable (`64.72.147.220` /
   `t2systems.que-it.net` = señal positiva). NXDOMAIN = no existe (DNS NO es wildcard —
   `randomxyz.t2hosted.com` da NXDOMAIN, confirmado).
3. **HTTP-probe** los que resuelven: `GET /Account/Portal` y confirmar que es un portal de
   **citations** (no solo permits) buscando el form `Plate Number + State + Citation Number`.
4. Cargar los confirmados como filas `PortalConnector`, mapeados contra los estados donde
   la flota tiene placas (`Vehicle.plateState`).
- **No usar el resolver del sandbox de Cowork** para esto: dio falsos negativos (timeouts).
  Correr desde el droplet con dig +tries/+time y 2-3 resolvers, o un probe HTTP directo.

### 6.2 🟢 Ecosistema de Orlando (lo que DE VERDAD cubre la flota de Manuel)

Como T2 no cubre Orlando, esto es lo que importa. La emisión en el área de Orlando está
**fragmentada en varios procesadores** (no es un solo portal):

| Fuente | Procesador / Portal | Búsqueda por placa | Scrapeable | Prioridad |
|---|---|---|---|---|
| **City of Orlando — parking** | Citation Processing Center · `citationprocessingcenter.com` (`/citizen-search-citation.aspx`, "Search by License Plate") | ✅ Sí (placa o citación #) | ✅ Sí | **P0** |
| **Orange County (no incorporado) — parking** | Orange County Comptroller · `parking.occompt.com` (solo tickets de OCSO desde 09/2012) | ✅ Sí (placa o citación #) | ✅ Sí | **P0** |
| **Red-light cameras** | `ViolationInfo.com` (Verra Mobility/ATS) | ❌ Requiere **Notice # + PIN** | ❌ No (no se enumera por placa) | P1 → upload/OCR |
| **UTC / moving violations** | Orange County Clerk · `myorangeclerk.com` / MyeClerk (corte) | Por nombre/caso | ❌ No (es corte, no parking) | Baja |
| **Aeropuerto MCO** | Greater Orlando Aviation Authority | ❓ A investigar | ❓ | TODO |

**Hallazgo grande:** el **Citation Processing Center es un segundo agregador multi-ciudad
igual que T2** — procesa Orlando, Sarasota y otras (`/sarasotacitations/...`). O sea, hay
que tratar **dos plataformas-agregador** como conectores de primera clase:
`CITATION_PROCESSING_CENTER` además de `T2`. El adapter de §3 es el mismo patrón; solo
cambia el slug/sub-path por ciudad.

**Implicación para el modelo Huur:** ViolationInfo.com (red-light) NO se puede enumerar por
placa — sale por correo con Notice# + PIN. Por eso el **path de upload manual + OCR (§5.3)
no es opcional para Orlando**: es la única forma de capturar las cámaras de luz roja. Huur
tiene el mismo límite (su tab "Documents" de upload manual es justo para esto).

**Tolls de Orlando:** además de **SunPass** (estatal FL), Orlando corre sobre **CFX /
E-PASS** (Central Florida Expressway Authority — 408/417/429/528/etc.), interoperable con
SunPass. El conector de transponder (§5.2) los cubre vía la cuenta SunPass; verificar que la
cuenta 91002658 reciba los pasajes de CFX o si hace falta cuenta E-PASS aparte.

**Acción:** confirmar el form exacto de `citationprocessingcenter.com` y `parking.occompt.com`
(campos placa+estado, si piden algo más) visitándolos en vivo — igual que hice con Fort
Lauderdale — antes de cablear los adapters P0.

### 6.3 Confirmación en vivo de los forms P0 (2026-06-12)

**Citation Processing Center** (`/citizen-search-citation.aspx`) — VERIFICADO ✅. Ofrece 6
modos de búsqueda; el relevante para ingestión es **"Search by License Plate"**:
- Campos: **License Plate Number** (text) + **State** (combobox, default California).
- Etiqueta "Parking Citations Only" → el plate-search solo trae **parking citations**
  (las administrativas/notice salen por Notice Number, no por placa).
- **Sin selector de ciudad/agencia** en el plate-search → busca por **placa+estado en TODA
  la base de CPC** (un solo query cubre Orlando, Sarasota y todos sus clientes). Ideal para
  el adapter: una llamada por placa, no una por ciudad.
- Otros modos (no usar para ingestión por placa): Time+Citation#, Notice#+Zip, Date+Citation#,
  Date+Notice#, Payment Plan#.
- ASP.NET clásico (.aspx, viewstate) → scrape con sesión que mantenga `__VIEWSTATE`/
  `__EVENTVALIDATION`. Stack viejo, estable, fácil de parsear.

**Orange County Comptroller** (`parking.occompt.com`) — NO accesible desde esta red ❌.
La carga la **bloqueó FortiGuard Web Filtering** (filtro del propio IT del Comptroller; el
dominio sale "banned" para IPs no residenciales / fuera de su geo). Implicación: este portal
**requiere proxy residencial** para scrapear (mismo patrón que TL International). Confirmar
el form (placa/citación) desde el droplet con el proxy residencial puesto, no desde Cowork.
Recordatorio: solo cubre tickets emitidos por **OCSO** (sheriff) desde 09/2012 — alcance
limitado vs CPC.

**Conclusión P0:** arrancar el conector por **Citation Processing Center** (verificado,
plate-search nacional, sin proxy aparente) como piloto en vez de Fort Lauderdale — cubre
Orlando directo, que es el footprint real de Manuel. Fort Lauderdale (T2) y OCSO Comptroller
quedan como segundos conectores.

---

## 7. Fases de entrega

- **Fase 0 — Discovery (1-2 días):** barrido crt.sh de `*.t2hosted.com` → lista maestra de
  slugs + estado. Mapear qué ciudades cubren las placas reales de la flota (cruce contra
  `Vehicle.plate`/`plateState`). Revisar ToS. Decisión go/no-go de scrape con Hector.
- **Fase A — Schema + 1 conector (T2 Fort Lauderdale):** modelos `ExternalViolation` +
  `PortalConnector` (migración additive), worker job, 1 slug end-to-end, matching a
  reserva, status NEW→MATCHED. Sin billing todavía.
- **Fase B — UI Citations:** lista/filtros (placa, agencia, citación, fechas) espejo de
  Huur, deep-link al portal, detalle, vista en el Vehicle Profile y en la reserva.
  Notificación inmediata al amarrar (regla del audit).
- **Fase C — SunPass connector:** tolls por transponder, misma cola y UI (tab Tolls).
- **Fase D — Manual upload + OCR + multi-ciudad FL:** ampliar a las demás ciudades de la
  flota; respaldo manual.
- **Fase E — Billing (MONEY, gate duro):** aplicar fee/markup, llevar al
  `RentalAgreement.balance`. **Cualquier código de dinero = aprobación explícita de
  Hector**, diffs revisados, igual que beta.155.
- **Fase F (opcional) — T2 Flex API oficial vía Verra** para reemplazar scrape.

---

## 8. Riesgos / reglas duras a respetar

- **ToS y legalidad del scraping** — decisión de negocio de Hector antes de prod. La
  búsqueda guest es pública pero la automatización puede violar términos; Verra es litigiosa.
- **Proxy residencial por portal** probablemente necesario (lección TL International).
- **Credenciales** (SunPass, portales credentialed) → vault/`.env` del droplet, nunca en
  tabla en claro; `redactSensitive()` en logs.
- **Worker, no main.js**; imports en el `FILES[]` del ship; `env-diff-check.sh` antes del
  deploy.
- **Billing = gate de dinero.** Ingestión y matching pueden correr libres; cobrar NO.
- **Disco del droplet al 75%** — el scrape headless acumula imágenes; `docker image prune`.

---

## 9. Próximos pasos inmediatos

1. Hector decide go/no-go del scrape (ToS) y prioriza ciudades FL reales.
2. Correr el barrido crt.sh para la lista maestra de slugs.
3. Confirmar el portal de Dania Beach y el set exacto de agencias que pegan a la flota.
4. Arrancar Fase A con Fort Lauderdale como conector piloto.
