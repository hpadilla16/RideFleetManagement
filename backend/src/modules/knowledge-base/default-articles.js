/**
 * Ride University — the written half of the curriculum.
 *
 * WHY THESE LIVE IN CODE (2026-08-28): they used to be an array buried inside
 * seedDefaults, reachable only by a "Seed defaults" button that renders when a
 * tenant has NO articles at all. That made the corpus effectively append-once:
 * article number seven shipped to nobody, because every existing tenant had
 * six. Two articles written for citations had to be inserted into production
 * by hand for exactly that reason.
 *
 * So the list moved here, the seed became per-article, and the global corpus
 * is topped up at boot — a new article now deploys with the release that
 * writes it, the same way a tour step does.
 *
 * RULES FOR ADDING ONE
 *   - `slug` is the identity and is forever. The top-up matches on it, so a
 *     renamed slug silently becomes a second article.
 *   - `category` must be one of the ten in knowledge-base.service.js.
 *   - Keep it short and practical: what the person does, in order, then the
 *     one mistake that costs money. A manual is not training.
 *   - Bilingual. The counter is in Puerto Rico and the team reads Spanish
 *     first; KnowledgeArticle has no locale column, so both languages live in
 *     one body under their own heading.
 *
 * EDITING AN ARTICLE THAT ALREADY SHIPPED — `supersedes` (2026-08-29)
 *
 * The top-up creates missing articles and otherwise leaves bodies alone, which
 * is right: a tenant who rewrote an article must not have it overwritten by a
 * deploy. But it also meant an EDIT could never ship. Two consequences we were
 * actually living with:
 *   - the original six were English-only in production and staying that way;
 *   - the two citation articles had bilingual bodies IN THIS FILE and
 *     English-only rows in the database, because they were hand-inserted
 *     before the corpus was seedable. The file and production had silently
 *     disagreed for a day.
 *
 * So an article may carry `supersedes`: the sha256 of each body we have
 * previously shipped for that slug. At boot the top-up rewrites a row ONLY if
 * the hash of what is in the database is one of them — i.e. it is provably
 * still OUR text, untouched. Anything else is somebody's edit and is left
 * exactly where it is. The default with no `supersedes` is unchanged: never
 * rewrite.
 *
 * To edit a shipped article: change the body, then append the sha256 of the
 * PREVIOUS body to `supersedes` (keep the older entries — a tenant may be
 * several versions behind). The hash is a content fingerprint for change
 * detection, not a security control.
 */

import { createHash } from 'node:crypto';

/** @type {Array<{title: string, slug: string, category: string, sortOrder: number, body: string, tags: string[], supersedes?: string[]}>} */
export const DEFAULT_ARTICLES = [
  {
    title: 'How to Check Out a Vehicle',
    slug: 'how-to-checkout',
    category: 'CHECKOUT',
    sortOrder: 1,
    tags: ['checkout', 'process', 'vehicle'],
    supersedes: ['9e39a5666e6a8604d1837c0a99994c08fb21dc5229a99cc790120a82a2cdffae'],
    body: `## Checkout Process

1. Open the reservation in the Reservations page
2. Click "Start Check-out"
3. Verify customer ID and payment
4. Complete the vehicle inspection (take photos)
5. Hand over the keys and confirm

The system will automatically:
- Create the rental agreement
- Send the customer a confirmation email
- Update the vehicle status to "Checked Out"
- Start the billing period

---

## Proceso de check-out (Español)

1. Abre la reserva en la página de Reservations
2. Dale a **Start Check-out**
3. Verifica la identificación del cliente y el pago
4. Completa la inspección del vehículo (toma fotos)
5. Entrega las llaves y confirma

El sistema hace solo:
- Crea el contrato de renta
- Le manda al cliente el correo de confirmación
- Cambia el estado del vehículo a "Checked Out"
- Arranca el período de facturación

**Las fotos son lo único que te defiende después.** Si sale un daño en el
check-in, lo que decide quién paga son las fotos del check-out — no lo que
alguien recuerde.`,
  },
  {
    title: 'How to Check In a Vehicle',
    slug: 'how-to-checkin',
    category: 'CHECKIN',
    sortOrder: 2,
    tags: ['checkin', 'return', 'vehicle'],
    supersedes: ['e58bfee282727b4909e4f58e9eec900b32f77243739f09c4516409fb6628a93a'],
    body: `## Check-in Process

1. Open the reservation and click "Check In"
2. Complete the return inspection (compare with checkout photos)
3. Note fuel level and mileage
4. Calculate any additional charges (late return, fuel, damage)
5. Process final payment
6. Close the rental agreement

The system will:
- Update the vehicle status to "Available"
- Generate the return receipt
- Send the customer their receipt via email

---

## Proceso de check-in (Español)

1. Abre la reserva y dale a **Check In**
2. Haz la inspección de retorno (compárala con las fotos del check-out)
3. Anota el nivel de gasolina y el millaje
4. Calcula los cargos adicionales (retorno tarde, gasolina, daños)
5. Procesa el pago final
6. Cierra el contrato de renta

El sistema hace solo:
- Cambia el estado del vehículo a "Available"
- Genera el recibo de retorno
- Le manda el recibo al cliente por correo

**Cerrar el contrato no cierra la cuenta.** Los peajes llegan semanas después
del retorno y se le montan al contrato aunque ya esté cerrado. Por eso hay
contratos cerrados que siguen apareciendo con balance — no es un error, es un
peaje que entró tarde.`,
  },
  {
    title: 'Handling Damage Disputes',
    slug: 'handling-damage-disputes',
    category: 'DISPUTES',
    sortOrder: 3,
    tags: ['dispute', 'damage', 'claims'],
    supersedes: ['083a091dc79b611132cd5081427b9ba93f29a0f757b5eba53a9cfd73d6a77035'],
    body: `## Dispute Resolution Steps

1. Go to the Issue Center
2. Find the incident linked to the trip
3. Review checkout and checkin inspection photos side by side
4. Check the chat transcript if available
5. Make a liability decision based on evidence
6. Process the charge or waive the claim

**Tips:**
- Always take clear photos at checkout and checkin
- Inspection photos are your best evidence
- The chat transcript can show if damage was discussed

---

## Cómo se resuelve una disputa por daños (Español)

1. Ve al **Issue Center**
2. Busca el incidente amarrado al viaje
3. Pon las fotos del check-out y las del check-in una al lado de la otra
4. Lee el chat si lo hay
5. Decide la responsabilidad basándote en la evidencia
6. Aplica el cargo o perdona el reclamo

**Consejos:**
- Toma fotos claras en el check-out y en el check-in, siempre
- Las fotos de inspección son tu mejor evidencia
- El chat puede enseñar si el daño se habló en su momento

**Decide con lo que puedes enseñar.** Si el daño no se ve en la foto del
check-out y sí se ve en la del check-in, tienes un caso. Si no tienes foto del
check-out, no tienes caso — y cobrarlo igual es lo que se convierte en un
contracargo.`,
  },
  {
    title: 'Processing Toll Charges',
    slug: 'processing-toll-charges',
    category: 'TOLLS',
    sortOrder: 4,
    tags: ['tolls', 'billing', 'charges'],
    supersedes: ['c012055b4edf0617ccb808ca57c84cc4ca237be55a0b8bcdd07e196f51475c18'],
    body: `## Toll Management

1. Go to the Tolls module
2. Import toll transactions from your toll provider
3. The system will auto-match tolls to reservations based on vehicle plate and dates
4. Review matched and unmatched tolls
5. Manually assign any unmatched transactions
6. Bill the customer for toll charges

**Auto-match logic:**
- Matches by plate number + transaction date within reservation window
- Handles vehicle swaps during the reservation period

---

## Manejo de peajes (Español)

1. Ve al módulo de **Tolls**
2. Importa las transacciones de tu proveedor de peajes
3. El sistema las parea solo con las reservas, por tablilla y por fecha
4. Revisa los peajes pareados y los que quedaron sin parear
5. Asigna a mano los que no parearon
6. Factúraselos al cliente

**Cómo parea solo:**
- Por número de tablilla + fecha de la transacción dentro de la ventana de la reserva
- Aguanta los cambios de vehículo durante la misma reserva

**Los peajes llegan tarde y por eso duelen.** Casi siempre entran después de
que el carro se devolvió y el contrato se cerró, y se le montan igual. Ese es
el motivo de la mayoría de los contratos cerrados que aparecen con balance
pendiente. Revisa la cola de peajes por tu cuenta — si esperas a que alguien
se queje, ya pasó demasiado tiempo para cobrarle.`,
  },
  {
    title: 'Car Sharing Trip Workflow',
    slug: 'car-sharing-trip-workflow',
    category: 'CAR_SHARING',
    sortOrder: 5,
    tags: ['car-sharing', 'trip', 'workflow'],
    supersedes: ['e9e37d7ee314029bae78a5f8cbf1457bfbe3176ab2fdad9ddd915d0ecb0eb9ce'],
    body: `## Car Sharing Trip Flow

1. Guest books a listing on the website
2. Trip is created in PENDING_APPROVAL or CONFIRMED status
3. Trip chat room is automatically created
4. Host and guest coordinate pickup via chat
5. Host confirms vehicle is ready
6. Guest picks up the vehicle
7. Trip moves to IN_PROGRESS
8. Guest returns the vehicle
9. Trip moves to COMPLETED
10. Review requests are sent to the guest

**Hot buttons in chat:**
- Guest: "I'm at pickup", "I'm at return", "Running late"
- Host: "Vehicle ready", "Inspection done"

---

## Flujo de un viaje de car sharing (Español)

1. El huésped reserva un listing desde la página
2. Se crea el viaje en estado PENDING_APPROVAL o CONFIRMED
3. El chat del viaje se abre solo
4. Anfitrión y huésped cuadran el pickup por chat
5. El anfitrión confirma que el vehículo está listo
6. El huésped recoge el vehículo
7. El viaje pasa a IN_PROGRESS
8. El huésped devuelve el vehículo
9. El viaje pasa a COMPLETED
10. Se le manda al huésped la invitación a dejar reseña

**Botones rápidos del chat:**
- Huésped: "I'm at pickup", "I'm at return", "Running late"
- Anfitrión: "Vehicle ready", "Inspection done"

**El chat es parte del expediente.** Todo lo que se escriba ahí se puede leer
después si hay una disputa por daños, y sirve de evidencia igual que las
fotos. Escríbelo como si lo fueras a leer en voz alta más tarde.`,
  },
  {
    title: 'Payment Processing Guide',
    slug: 'payment-processing',
    category: 'PAYMENTS',
    sortOrder: 6,
    tags: ['payments', 'billing', 'gateway'],
    supersedes: ['605e992510e1af8a35602502d676b0bbe24820e01624773a0344d48c5135bb53'],
    body: `## Payment Methods

### Authorize.Net
- Primary payment gateway for hosted payments
- Supports saved cards and security deposit holds

### iPOSPays/SPIn Terminal
- Physical terminal processing via SPIn REST API
- Sale, auth/capture, void, refund supported
- Card-on-file tokenization available

### Payment Flow
1. Customer receives payment link via email/SMS
2. Customer enters card details on hosted payment page
3. Payment is processed and recorded
4. Receipt is sent automatically

**Security deposits** are held as auth-only transactions and captured or voided at return.

---

## Guía de procesamiento de pagos (Español)

### Authorize.Net
- Es la pasarela principal para pagos en línea
- Aguanta tarjetas guardadas y retenciones de depósito

### Terminal iPOSPays/SPIn
- Terminal física, procesa por el API REST de SPIn
- Hace venta, autorización/captura, void y reembolso
- Puede tokenizar la tarjeta para dejarla en archivo

### Cómo corre un pago
1. El cliente recibe el link de pago por correo o SMS
2. El cliente entra los datos de la tarjeta en la página de pago
3. El pago se procesa y queda registrado
4. El recibo sale solo

**Los depósitos de seguridad** se retienen como autorización nada más, y en el
retorno se capturan o se liberan.

**Tú nunca ves el número completo de la tarjeta, y así tiene que ser.** El
número se entra en la página de Authorize.Net o en la terminal; el sistema solo
guarda un identificador y los últimos cuatro dígitos. Si alguien te pide que
apuntes un número de tarjeta en una nota o en un correo, la contestación es no
— eso es justo lo que nos sacaría de cumplimiento con PCI.`,
  },
  // ---------------------------------------------------------------------
  // Added 2026-08-28. Everything below is bilingual in one body: the counter
  // is in Puerto Rico and KnowledgeArticle has no locale column.
  // ---------------------------------------------------------------------
  {
    title: 'Handling a Citation',
    slug: 'handling-citations',
    category: 'DISPUTES',
    sortOrder: 7,
    tags: ['citations', 'fines', 'disputes'],
    // The English-only draft that was INSERTED INTO PRODUCTION BY HAND on
    // 2026-08-28, before the corpus was seedable. The bilingual body below has
    // existed in this file since the same day and had no way to reach the row.
    supersedes: ['7d39dee6d2109d38ba88e5179821483cb5a3ef1edf5d40782109b3196d48895b'],
    body: `## Working the citation queue

Citations arrive on their own — scraped from the agencies, or read out of a
mailed notice you upload. The system matches the plate to a vehicle, then to
whichever rental was out on the date of the violation. Your job is to agree
with it, or not.

1. Open **Citations**. The **Working** view is your queue; **Archive** holds
   what is finished.
2. Open a row and read the Activity timeline — it tells you whether it matched
   a vehicle, matched a rental, or found no rental for that date.
3. Decide:
   - **Confirm** — the match is right.
   - **Dispute** — you are challenging it with the agency.
   - **Close** — resolved, moves to Archive.
   - **Void** — it was never ours.
4. Type what you decided in the notes box before you click. The note is saved
   with the decision and is the only explanation anyone gets later.
5. Once it is matched to a renter you can **Download affidavit (transfer of
   liability)** to move the ticket to the driver.

**Confirm posts the charge. It is not a bookkeeping click.**
- Confirming puts the fine plus the admin fee on that rental's agreement
  straight away — including on a rental that is already closed.
- **Dispute** and **Void** pull those charges back off. **Close** does not:
  anything already posted stays posted.
- If you only meant "yes, that is our car", say so in the notes and leave it in
  Needs Review until someone decides about the money.

---

## Trabajando la fila de multas (Español)

Las multas entran solas — raspadas de las agencias, o leídas del aviso que tú
subes. El sistema busca la tablilla, encuentra el vehículo, y luego la renta
que estaba afuera el día de la violación. Tu trabajo es estar de acuerdo, o no.

1. Abre **Citations**. La vista **Working** es tu fila; **Archive** es lo
   terminado.
2. Abre la fila y lee el timeline de actividad — te dice si pegó con un
   vehículo, con una renta, o si no había renta ese día.
3. Decide:
   - **Confirm** — el match está bien.
   - **Dispute** — la estás peleando con la agencia.
   - **Close** — resuelta, se va a Archive.
   - **Void** — nunca fue de nosotros.
4. Escribe lo que decidiste en las notas ANTES de darle. Esa nota se guarda con
   la decisión y es la única explicación que alguien va a ver después.
5. Cuando ya está pegada a un renter, puedes bajar el **affidavit (transfer of
   liability)** para pasarle el ticket al conductor.

**Confirm cobra. No es un click de papeleo.**
- Confirmar le monta la multa más el cargo administrativo al contrato de esa
  renta al instante — aunque la renta ya esté cerrada.
- **Dispute** y **Void** quitan esos cargos. **Close** NO: lo que ya se montó,
  ahí se queda.
- Si lo único que querías decir era "sí, ese es nuestro carro", ponlo en las
  notas y déjala en Needs Review hasta que alguien decida lo del dinero.`,
  },
  {
    title: 'Citation Documents and the Export File',
    slug: 'citation-documents-and-export',
    category: 'DISPUTES',
    sortOrder: 8,
    tags: ['citations', 'documents', 'export'],
    // Same story as its sibling above: hand-inserted English, bilingual here.
    supersedes: ['bfa3c69dfba895c14f8631d9447a8a5b393a8f5fa25b7d6a781c069a1ad3b7f4'],
    body: `## Building the file for a citation

Every citation has a **Supporting documents** panel. This is where the paper
that wins an argument lives — the agency notice, the proof you paid, the letter
you sent, what they wrote back.

1. Pick the document type — agency notice, proof of payment, dispute letter,
   agency response, customer correspondence, rental document, or other.
2. Give it a **Document name** you would recognise in a year. "Scan 3" is not
   one.
3. Add a note if the file does not explain itself.
4. Choose the file and click **Add document**. The limit is 15MB.
5. When you need the whole story in one place, click **Export citation file
   (PDF)** — you get a cover with the citation, the vehicle, the rental and the
   renter, then every document appended behind it.

**Two things that will catch you out.**
- **Never upload anything showing a full card number.** Mask all but the last
  four first. The system warns you when a file looks like a payment document,
  but it cannot see inside every file.
- **The export only appends PDFs and images.** Word, Excel, plain text and
  email files can be attached, but they appear on the cover as a name only —
  the PDF itself says so. Never hand that bundle over as the complete record
  without checking what did not make it in.
- **Archive is not delete.** Archiving a document hides it from the panel and
  leaves the file in place.

---

## Armando el expediente de una multa (Español)

Cada multa tiene un panel de **Supporting documents**. Ahí vive el papel que
gana la discusión — el aviso de la agencia, la prueba de pago, la carta que
mandaste, lo que te contestaron.

1. Escoge el tipo de documento — aviso de agencia, prueba de pago, carta de
   disputa, respuesta de agencia, correspondencia del cliente, documento de
   renta, u otro.
2. Ponle un **Document name** que reconozcas dentro de un año. "Scan 3" no lo
   es.
3. Añade una nota si el archivo no se explica solo.
4. Escoge el archivo y dale **Add document**. El límite es 15MB.
5. Cuando necesites todo junto, dale **Export citation file (PDF)** — te sale
   una portada con la multa, el vehículo, la renta y el renter, y detrás todos
   los documentos.

**Dos cosas que te van a coger.**
- **Nunca subas nada que enseñe el número completo de tarjeta.** Tapa todo
  menos los últimos cuatro. El sistema te avisa cuando un archivo parece de
  pago, pero no puede ver dentro de todos.
- **El export solo pega PDFs e imágenes.** Word, Excel, texto y correos se
  pueden adjuntar, pero salen en la portada como nombre nada más — el propio
  PDF lo dice. No entregues ese paquete como el expediente completo sin mirar
  qué se quedó afuera.
- **Archive no es borrar.** Archivar lo esconde del panel; el archivo se queda.`,
  },
  {
    title: 'Pre-Check-in: What Is Done and What Still Is Not',
    slug: 'precheckin-and-arrival',
    category: 'AGREEMENTS',
    sortOrder: 9,
    tags: ['precheckin', 'portal', 'counter'],
    body: `## When a customer arrives having pre-checked in

Pre-check-in is the customer doing the typing at home: their details, their
licence, their insurance, and the protection and extras they want. It does not
hand you a finished rental. It hands you a head start.

1. Send the invite from the reservation with **Request Customer Information**
   (some tenants send it automatically before pickup).
2. When they arrive, open the reservation and read the **Pre-check-in Status**
   card — the status and the "N of M items complete" counter.
3. Click **Mark Docs Reviewed** once you have actually looked at what they
   uploaded.
4. Click **Mark Ready For Pickup**.
5. Then run the check-out wizard exactly as you always would.

**Pre-check-in never skips the counter.**
- **Mark Docs Reviewed stays locked until the customer submits.** If the button
  reads "Awaiting Customer Submission", they have not finished — chasing them
  is the job, not clicking harder.
- If the checklist is incomplete the second button becomes **Override Ready For
  Pickup**. It still works. It records that you overrode it, with your name.
- **Declining coverage online is not final.** If they said they will use their
  own insurance, you still verify the policy at the counter. If it does not
  hold up, they buy coverage from you.
- If you change pricing afterwards, re-apply the pre-check-in discount on the
  reservation. A plain save puts them back on counter pricing.

---

## Cuando el cliente llega con el pre-check-in hecho (Español)

El pre-check-in es el cliente escribiendo desde su casa: sus datos, su
licencia, su seguro, y la protección y extras que quiere. No te entrega una
renta terminada. Te entrega adelanto.

1. Manda la invitación desde la reserva con **Request Customer Information**
   (algunos tenants la mandan solos antes del pickup).
2. Cuando llegue, abre la reserva y lee la tarjeta **Pre-check-in Status** — el
   estado y el contador de "N of M items complete".
3. Dale **Mark Docs Reviewed** cuando de verdad hayas mirado lo que subió.
4. Dale **Mark Ready For Pickup**.
5. Y corre el wizard de check-out igual que siempre.

**El pre-check-in nunca se salta el counter.**
- **Mark Docs Reviewed está trancado hasta que el cliente someta.** Si el botón
  dice "Awaiting Customer Submission", no terminó — hay que perseguirlo, no
  darle más duro al botón.
- Si el checklist está incompleto, el segundo botón cambia a **Override Ready
  For Pickup**. Funciona igual. Y queda grabado que TÚ lo forzaste.
- **Rechazar cobertura en línea no es final.** Si dijo que usa su propio
  seguro, tú verificas la póliza en el counter. Si no sirve, te compra
  cobertura.
- Si cambias precios después, vuelve a aplicar el descuento de pre-check-in en
  la reserva. Un save normal lo devuelve a precio de counter.`,
  },
  {
    title: 'From a Quote to a Reservation',
    slug: 'quote-to-reservation',
    category: 'GENERAL',
    sortOrder: 10,
    tags: ['quotes', 'pricing', 'counter'],
    body: `## Quoting a price over the phone

A quote is a price you can say out loud and honour later. It gets a short
Q-number, and it is good for 72 hours.

1. Open **Quotes** and click **+ New quote**.
2. Fill the pickup location, the dates, and the caller's name and phone.
3. **Live prices** loads the classes with what is actually available. Click the
   one they want.
4. Read them the Q-number. That is how they come back to it — there is no
   "email this quote" button on this screen.
5. When they call back, open the quote and click **Convert to reservation**.
   The quoted price is honoured; the reservation is created with no vehicle
   assigned and no payment taken.

**A quote holds a price, never a car.**
- Converting re-checks availability. If the class sold out in the meantime the
  conversion is refused, quoted price or not.
- **Only a manager can change the quoted rate**, and the change needs a written
  reason. If the rate box is read-only, that is why.
- **Cancelling a quote throws the locked price away.** A new quote gets today's
  prices. Expired ones offer **Re-quote**, which does the same thing.

---

## De una cotización a una reserva (Español)

Una cotización es un precio que puedes decir por teléfono y honrar después.
Recibe un Q-number cortito y sirve por 72 horas.

1. Abre **Quotes** y dale **+ New quote**.
2. Llena la sede de pickup, las fechas, y el nombre y teléfono de quien llama.
3. **Live prices** carga las clases con lo que de verdad hay. Dale click a la
   que quiere.
4. Léele el Q-number. Así es que vuelve — en esta pantalla no hay botón de
   "enviar cotización por email".
5. Cuando llame de vuelta, abre la cotización y dale **Convert to reservation**.
   Se honra el precio; la reserva se crea sin vehículo asignado y sin cobrar.

**Una cotización guarda un precio, nunca un carro.**
- Al convertir se vuelve a chequear disponibilidad. Si la clase se vendió
  mientras tanto, no convierte — con precio cotizado y todo.
- **Solo un manager puede cambiar la tarifa cotizada**, y hay que escribir la
  razón. Si la caja de tarifa está bloqueada, por eso es.
- **Cancelar una cotización bota el precio guardado.** Una nueva coge los
  precios de hoy. Las vencidas ofrecen **Re-quote**, que hace lo mismo.`,
  },
  {
    title: 'Monthly and Long-Term Rentals',
    slug: 'long-term-and-monthly-rentals',
    category: 'AGREEMENTS',
    sortOrder: 11,
    tags: ['monthly', 'long-term', 'billing'],
    body: `## Renting by the month

A monthly rental is not a long daily rental. It bills in cycles, carries its
own included mileage, and can renew itself.

1. On step one of the new-reservation wizard — **Dates & locations** — set
   **Rate type** to **Monthly**.
2. Set the cycle length (30 days by default), the cycle rate if you are
   overriding the configured monthly rate, the included miles, and whether it
   renews automatically.
3. Finish the reservation as normal.
4. To bill a cycle later, open the reservation's **Monthly plan** panel and
   click **Bill Next Cycle**. That posts the cycle charge plus any mileage
   overage, extends the return date, and moves the next bill date.
5. Collect the money through **View Payments** as usual. "Mark paid" on a cycle
   is bookkeeping only — it moves no money.

**Choose monthly at the start.**
- You can attach a plan afterwards from the reservation, but only if the rental
  is **25 days or longer**. Shorter than that, there is no way to add one — the
  fix is to cancel and re-book.
- **Attaching a plan rewrites the pricing.** The daily base charge is deleted
  and replaced with a single monthly cycle charge. Services, fees and insurance
  survive. There is no confirmation prompt.
- **One plan per reservation, ever.** There is no detach — only "End At Cycle
  Close".
- If the reservation is created but the plan fails, you get a daily-rate
  reservation and a message saying so. Attach the plan from the reservation
  page; do not re-book.

---

## Rentas mensuales y de largo plazo (Español)

Una renta mensual no es una renta diaria larga. Factura por ciclos, trae su
propio millaje incluido, y se puede renovar sola.

1. En el paso uno del wizard de reserva nueva — **Dates & locations** — pon
   **Rate type** en **Monthly**.
2. Pon el largo del ciclo (30 días por defecto), la tarifa del ciclo si vas a
   sobreescribir la configurada, las millas incluidas, y si renueva solo.
3. Termina la reserva normal.
4. Para facturar un ciclo después, abre el panel **Monthly plan** de la reserva
   y dale **Bill Next Cycle**. Eso monta el cargo del ciclo más el exceso de
   millaje, extiende la fecha de retorno, y mueve la próxima fecha de cobro.
5. Cobra por **View Payments** como siempre. El "Mark paid" del ciclo es
   papeleo nada más — no mueve chavos.

**Escoge mensual desde el principio.**
- Puedes pegar el plan después desde la reserva, pero SOLO si la renta es de
  **25 días o más**. Más corta que eso, no hay manera — hay que cancelar y
  volver a reservar.
- **Pegar un plan reescribe el precio.** El cargo diario base se borra y se
  reemplaza por un solo cargo mensual. Servicios, fees y seguro se quedan. No
  te pregunta nada.
- **Un plan por reserva, para siempre.** No se despega — solo "End At Cycle
  Close".
- Si la reserva se crea pero el plan falla, te queda una reserva de tarifa
  diaria y un mensaje diciéndolo. Pega el plan desde la página de la reserva;
  no vuelvas a reservar.`,
  },
  {
    title: 'Security Basics for Every Agent',
    slug: 'security-basics-for-agents',
    category: 'GENERAL',
    sortOrder: 12,
    tags: ['security', '2fa', 'screen-lock', 'locations'],
    body: `## The three security things that affect your day

**Two-factor authentication.** If your company requires it for your role, the
setup finds you: the next time you sign in, the app shows a QR code before it
lets you through.

1. Scan the code with an authenticator app — Google Authenticator, Authy,
   1Password.
2. Type the six digits and confirm.
3. **Save the backup codes it shows you.** They are shown once and never again.
   They are how you get in when your phone is dead or lost.

If you lose both, an admin can reset your 2FA from the People screen. There is
no self-service path.

**The screen lock.** The app locks itself after two minutes of no activity and
asks for your lock PIN. It is not a login — it is so the person who walks up to
your unattended counter cannot use your session. Set your PIN before your first
shift, because the kiosk's staff-assist also uses it.

**Why you only see one branch.** Your account is scoped to the locations you
work at. That follows you everywhere: which reservations you see, which
locations you can book from, and what your exports contain.

**Where people trip.**
- **Leaving every location box unchecked does not mean "no access" — it means
  ALL locations.** Restricting someone means ticking boxes, not clearing them.
  It reads backwards and it is the most common mistake on that screen.
- If an agent cannot create a reservation at a branch, check their location
  scope before anything else.
- If you have more than one location, the pin dropdown in the top bar changes
  what you are looking at — and **reloads the page**. It also changes what your
  exports contain, so switch back to all locations before exporting anything
  fleet-wide.

---

## Lo básico de seguridad para todo agente (Español)

**Autenticación de dos factores.** Si tu compañía la requiere para tu rol, la
configuración te busca a ti: la próxima vez que entres, la app te enseña un
código QR antes de dejarte pasar.

1. Escanea el código con una app de autenticación — Google Authenticator,
   Authy, 1Password.
2. Escribe los seis dígitos y confirma.
3. **Guarda los backup codes que te enseña.** Se enseñan una sola vez. Son
   cómo entras cuando el celular está muerto o perdido.

Si pierdes los dos, un admin te resetea el 2FA desde People. No hay manera de
hacerlo tú solo.

**El screen lock.** La app se tranca sola a los dos minutos sin actividad y te
pide tu PIN. No es un login — es para que quien se acerque a tu counter sin ti
no pueda usar tu sesión. Pon tu PIN antes del primer turno, porque el staff
assist del kiosco también lo usa.

**Por qué solo ves una sede.** Tu cuenta está limitada a las sedes donde
trabajas. Eso te sigue a todos lados: qué reservas ves, desde qué sedes puedes
reservar, y qué sale en tus exports.

**Dónde se traba la gente.**
- **Dejar todas las cajitas de sede sin marcar NO es "sin acceso" — es TODAS
  las sedes.** Limitar a alguien es marcar cajitas, no vaciarlas. Se lee al
  revés y es el error más común de esa pantalla.
- Si un agente no puede crear una reserva en una sede, chequea su alcance de
  sedes antes que nada.
- Si tienes más de una sede, el dropdown del top bar cambia lo que estás viendo
  — y **recarga la página**. También cambia lo que sale en tus exports, así que
  vuelve a todas las sedes antes de exportar algo de toda la flota.`,
  },
  {
    title: 'Shuttle Dispatch and Driver Links',
    slug: 'shuttle-dispatch-and-driver-mode',
    category: 'GENERAL',
    sortOrder: 13,
    tags: ['shuttle', 'driver', 'dispatch'],
    body: `## Running the shuttle from the counter

Customers picking up at a shuttle location get a personal tracking link by
email and SMS. They watch the bus move and request it with one tap. That tap
lands in your queue.

1. Open **Shuttles**. **Live map** shows every shuttle transmitting right now.
2. Waiting customers appear in the queue and on the map. Work a row with
   **Picked up**, **Notify delay**, **Customer cancelled** or **No-show**.
3. To put a driver on the road, go to **Driver shifts**, choose the shuttle,
   type the driver's name, set how many hours the link is good for, and click
   **Create driver link**.
4. Send them the link — copy it or share it by WhatsApp. They open it on their
   phone. No account, no password.
5. Use **Message driver** to tell them something; it shows on their screen.
   Use **Revoke link** when the shift ends.

Locations run one of two ways. **On demand** means you assign the pickup.
**Non-stop** means the bus loops and the customer is told roughly how often it
passes — there is no assigning in loop mode.

**The driver link is shown once and never again.**
- If it gets lost, revoke that shift and mint a new one. There is no way to
  look it up.
- **Anyone holding the link is the driver** until it expires or you revoke it.
  Treat it like a key.
- A shuttle with no GPS device mapped never appears on the map or on the
  customer's page, no matter how healthy everything else looks.
- Marking a no-show notifies the customer and the counter. Doing it twice
  notifies nobody a second time.

---

## Manejando el shuttle desde el counter (Español)

El cliente que recoge en una sede con shuttle recibe un link personal de
rastreo por email y SMS. Ve la guagua moverse y la pide con un toque. Ese toque
cae en tu fila.

1. Abre **Shuttles**. **Live map** enseña cada guagua transmitiendo ahora mismo.
2. Los clientes esperando salen en la fila y en el mapa. Trabaja la fila con
   **Picked up**, **Notify delay**, **Customer cancelled** o **No-show**.
3. Para poner un driver a rodar, ve a **Driver shifts**, escoge la guagua,
   escribe el nombre del driver, pon por cuántas horas sirve el link, y dale
   **Create driver link**.
4. Mándale el link — cópialo o compártelo por WhatsApp. Lo abre en su celular.
   Sin cuenta, sin password.
5. Usa **Message driver** para decirle algo; le sale en la pantalla. Usa
   **Revoke link** cuando termine el turno.

Las sedes corren de dos maneras. **On demand** es que tú asignas el pickup.
**Non-stop** es que la guagua da vueltas y al cliente se le dice cada cuánto
pasa — en modo loop no se asigna.

**El link del driver se enseña una sola vez.**
- Si se pierde, revoca ese turno y saca uno nuevo. No hay manera de buscarlo.
- **Cualquiera con el link es el driver** hasta que expire o lo revoques.
  Trátalo como una llave.
- Una guagua sin GPS mapeado nunca sale en el mapa ni en la página del cliente,
  por muy bien que se vea todo lo demás.
- Marcar un no-show le avisa al cliente y al counter. Marcarlo dos veces no le
  avisa a nadie otra vez.`,
  },
  {
    title: 'Taking a Vehicle Down for Maintenance',
    slug: 'maintenance-holds',
    category: 'PLANNER',
    sortOrder: 14,
    tags: ['maintenance', 'fleet', 'availability'],
    body: `## Putting a car down, and getting it back

A repair order is how a car leaves the rentable fleet and how it comes back.
Anything else you do to a vehicle's status is invisible to the maintenance
board.

1. Open **Maintenance** and click **+ New repair order**, or use **Create RO**
   from the due list.
2. Pick the vehicle and create it. The car moves to In Maintenance and stops
   being bookable.
3. Add the lines as the work happens — part or labour, description, quantity,
   unit cost.
4. When the work is done, click **Complete**. The car goes back to Available
   and any damage reports grouped under that RO are marked fixed.
5. **Cancel RO** also releases the car, and un-links its damage reports so they
   can be rolled into a new order.

**The status flip is quiet, and conditional.**
- A repair order only moves a car that is currently **Available or Reserved**.
  Open one on a car that is **on rent**, out of service or sold and the status
  does not change — no error, no warning. That is deliberate: it will never
  yank a car off an active rental.
- The car is only released when the **last** open repair order on it is closed.
- If someone set a vehicle to In Maintenance by hand from the Vehicles screen,
  no repair order exists, the maintenance board shows nothing, and completing
  an RO will never release it. Put cars down from here, not from there.

---

## Bajando un carro por mantenimiento (Español)

Un repair order es cómo un carro sale de la flota rentable y cómo vuelve.
Cualquier otra cosa que le hagas al estatus del vehículo es invisible para el
board de mantenimiento.

1. Abre **Maintenance** y dale **+ New repair order**, o usa **Create RO** de
   la lista de vencimientos.
2. Escoge el vehículo y créalo. El carro pasa a In Maintenance y deja de ser
   reservable.
3. Añade las líneas según avanza el trabajo — pieza o labor, descripción,
   cantidad, costo unitario.
4. Cuando termine el trabajo, dale **Complete**. El carro vuelve a Available y
   los reportes de daño agrupados bajo ese RO se marcan arreglados.
5. **Cancel RO** también suelta el carro, y despega sus reportes de daño para
   que entren en una orden nueva.

**El cambio de estatus es callado, y condicional.**
- Un repair order solo mueve un carro que esté **Available o Reserved**. Ábrelo
  en un carro que esté **rentado**, fuera de servicio o vendido y el estatus no
  cambia — sin error, sin aviso. Es a propósito: nunca le quita un carro a una
  renta activa.
- El carro se suelta solo cuando se cierra el **último** RO abierto que tenga.
- Si alguien puso el vehículo en In Maintenance a mano desde la pantalla de
  Vehicles, no existe repair order, el board no enseña nada, y completar un RO
  nunca lo va a soltar. Baja los carros desde aquí, no desde allá.`,
  },
  {
    title: 'The Loaner Program, End to End',
    slug: 'loaner-program',
    category: 'AGREEMENTS',
    sortOrder: 15,
    tags: ['loaner', 'dealership', 'service'],
    body: `## Putting a service customer in a loaner

A loaner is a rental with the money switched off and a repair order attached.
It runs through the same check-out and check-in as everything else.

1. Leads from the public request form land in **Courtesy Requests**. Move each
   one along — received, contacted, converted, closed — or dismiss it.
2. Start the real record with **Quick Intake**: the customer, the billing mode
   (courtesy, customer pay, warranty, insurance, internal), the repair order
   number, the advisor, the vehicle type, and the dates.
3. Tick the liability acceptance box. The form will not submit without it.
4. **Create Loaner Intake** drops you on the reservation — not the check-out
   wizard. That is on purpose: the advisor reviews it, and checks out when the
   customer is actually standing there.
5. Work the day from **Loaner Queues**: new check-ins, active loaners, returns,
   advisor follow-up, billing review, and overdue.
6. Check in and inspect from the Returns queue, then settle it in billing.

**Two panels look alike and are not.**
- **Courtesy Requests** are leads with no reservation behind them yet.
- **Customer Requests** are extension and return-date changes on a loaner that
  is already out. Clicking **Approve** there moves the date on a live
  reservation.
- The Customer Requests panel **hides itself when it is empty**, so an absent
  panel means "nothing waiting", not "something is broken".
- A half-typed intake survives a refresh — it is kept until the create
  succeeds. Do not assume a blank-looking form is a fresh one.

---

## El programa de loaners, de principio a fin (Español)

Un loaner es una renta con el dinero apagado y un repair order pegado. Corre
por el mismo check-out y check-in que todo lo demás.

1. Los leads del formulario público caen en **Courtesy Requests**. Muévelos —
   received, contacted, converted, closed — o descártalos.
2. Empieza el récord de verdad con **Quick Intake**: el cliente, el modo de
   facturación (cortesía, paga el cliente, garantía, seguro, interno), el
   número de repair order, el advisor, el tipo de vehículo, y las fechas.
3. Marca la cajita de aceptación de responsabilidad. Sin eso no somete.
4. **Create Loaner Intake** te deja en la reserva — no en el wizard de
   check-out. Es a propósito: el advisor la revisa, y hace el checkout cuando
   el cliente está ahí de verdad.
5. Trabaja el día desde **Loaner Queues**: nuevos, activos, retornos,
   seguimiento del advisor, revisión de facturación, y atrasados.
6. Haz el check in e inspecciona desde la fila de retornos, y ciérralo en
   facturación.

**Dos paneles se parecen y no son lo mismo.**
- **Courtesy Requests** son leads que todavía no tienen reserva detrás.
- **Customer Requests** son cambios de extensión o fecha de retorno de un
  loaner que YA está afuera. Darle **Approve** ahí mueve la fecha de una
  reserva viva.
- El panel de Customer Requests **se esconde solo cuando está vacío**, así que
  si no lo ves quiere decir "no hay nada", no "se rompió".
- Un intake a medio escribir sobrevive un refresh — se guarda hasta que el
  create funcione. No asumas que un formulario que se ve vacío está limpio.`,
  },
  {
    title: 'Running a Kiosk',
    slug: 'kiosk-operations',
    category: 'GENERAL',
    sortOrder: 16,
    tags: ['kiosk', 'device', 'counter'],
    body: `## Pairing a kiosk, and rescuing one

A kiosk is a tablet that runs the pickup itself: the guest finds their
reservation, scans their licence, takes a selfie, chooses protection, pays, and
signs. You set it up once and step in when it asks for you.

1. Open **Kiosks** and click **Pair a new kiosk**. Name it something you could
   shout across a counter — "Kiosk 1 — Counter left".
2. Pick its location and click **Create & get pairing code**. You get a
   six-digit code.
3. On the tablet, open the kiosk app and type that code. It is single-use and
   it expires.
4. Watch the devices table for **Online**, **Offline** and the last heartbeat.
5. When a guest taps for help, choose your name and enter your **screen-lock
   PIN** to unlock staff assist. You then enter the ID details by hand and
   capture the licence front and back.

**Recovering a kiosk means re-pairing it, not finding the token.**
- **Rotate** kills the old token and shows a new one once. **Revoke** stops the
  device permanently and cannot be undone.
- In practice the fix for any token problem is to issue a fresh pairing code
  and pair the tablet again.
- **Five wrong entries lock the whole device for fifteen minutes** — and staff
  PIN attempts and guest lookup attempts share the same counter. Fat-fingering
  your PIN locks guests out of looking up their reservation. An admin can clear
  it immediately with a fresh pairing code.
- Staff assist does not override the rules. An underage driver is still a hard
  stop with you standing there.
- The welcome screen offers walk-up rentals; that path is not live yet and
  sends the guest to the counter.

---

## Manejando un kiosco (Español)

Un kiosco es una tableta que hace el pickup sola: el huésped busca su reserva,
escanea su licencia, se toma un selfie, escoge protección, paga, y firma. Tú lo
configuras una vez y entras cuando te llama.

1. Abre **Kiosks** y dale **Pair a new kiosk**. Ponle un nombre que puedas
   gritar de lado a lado del counter — "Kiosk 1 — Counter left".
2. Escoge su sede y dale **Create & get pairing code**. Te da un código de seis
   dígitos.
3. En la tableta, abre la app del kiosco y escribe ese código. Es de un solo
   uso y expira.
4. Vigila la tabla de dispositivos: **Online**, **Offline**, y el último
   heartbeat.
5. Cuando un huésped pida ayuda, escoge tu nombre y mete tu **PIN de screen
   lock** para abrir el staff assist. Ahí metes los datos del ID a mano y
   capturas la licencia por delante y por detrás.

**Rescatar un kiosco es volver a parearlo, no buscar el token.**
- **Rotate** mata el token viejo y enseña uno nuevo una sola vez. **Revoke**
  para el dispositivo para siempre y no se puede deshacer.
- En la práctica, el arreglo para cualquier problema de token es sacar un
  código de pareo nuevo y volver a parear la tableta.
- **Cinco intentos malos trancan el dispositivo completo por quince minutos** —
  y los intentos de PIN del staff y las búsquedas del huésped comparten el
  mismo contador. Que se te vaya el dedo en el PIN deja al huésped sin poder
  buscar su reserva. Un admin lo destranca al momento con un código nuevo.
- El staff assist no brinca las reglas. Un conductor menor de edad sigue siendo
  un no rotundo contigo ahí parado.
- La pantalla de bienvenida ofrece rentas walk-up; ese camino todavía no está
  vivo y manda al huésped al counter.`,
  },
  {
    // The copilot's first recorded gap (2026-09-02): the owner's own example
    // question had curated playbook steps and no article behind them. This
    // closes it — the intent map (frontend intents.js `additional-drivers`)
    // now points here.
    title: 'Adding an Additional Driver',
    slug: 'additional-drivers',
    category: 'AGREEMENTS',
    sortOrder: 17,
    tags: ['drivers', 'reservation', 'checkout'],
    body: `## Putting a second driver on the rental

An additional driver lives inside the reservation itself — there is no
separate screen to hunt for.

1. Open the customer's reservation in the Reservations page.
2. Click **Additional Drivers**.
3. Fill the form: first name, last name, address, date of birth, license
   number — and a photo of the license. Every field is required: this is who
   is covered behind the wheel.
4. Click **Add Driver**. They appear on the list below; repeat for each extra
   driver.
5. Click **Save Drivers**. Nobody on the list counts until you save — saving
   puts the roster on the reservation and returns you to it.

**Confirm additional drivers BEFORE releasing the vehicle.**
- A driver who is not on the agreement is not covered. If they crash, the
  argument starts with a name missing from a document you had time to fix.
- If your tenant charges an additional-driver fee, it applies at check-out for
  the drivers already on the reservation. It does not charge itself after
  closeout — a driver added late is a fee collected never.
- The license photo is not optional. No picture, no driver — the same
  requirement the main driver already met at the counter.

---

## Añadir un conductor adicional (Español)

El conductor adicional vive dentro de la reserva misma — no hay otra pantalla
que buscar.

1. Abre la reserva del cliente en la página de Reservations.
2. Dale a **Additional Drivers**.
3. Llena el formulario: nombre, apellido, dirección, fecha de nacimiento,
   número de licencia — y una foto de la licencia. Todos los campos son
   obligatorios: esto es quién está cubierto detrás del volante.
4. Dale **Add Driver**. Aparece en la lista de abajo; repite por cada
   conductor extra.
5. Dale **Save Drivers**. Nadie en la lista cuenta hasta que guardes — el save
   pone el roster en la reserva y te devuelve a ella.

**Confirma los conductores adicionales ANTES de entregar el vehículo.**
- Un conductor que no está en el contrato no está cubierto. Si choca, la
  discusión empieza con un nombre que falta en un documento que tuviste
  tiempo de arreglar.
- Si tu tenant cobra fee de conductor adicional, se aplica en el check-out por
  los conductores que ya están en la reserva. No se cobra solo después del
  cierre — un conductor añadido tarde es un fee que nunca se cobra.
- La foto de la licencia no es opcional. Sin foto no hay conductor — el mismo
  requisito que el conductor principal ya cumplió en el counter.`,
  },

];

/**
 * Which default articles a scope does not have yet.
 *
 * Pure, so the top-up rule is testable without a database — the same split
 * tour-state.js uses. Matching is by slug and by slug only: a body that was
 * edited in place still counts as present, and must never be reinstated.
 *
 * @param {string[]} existingSlugs  slugs already in that scope
 */
export function articlesMissingFrom(existingSlugs = []) {
  const have = new Set(existingSlugs);
  return DEFAULT_ARTICLES.filter((a) => !have.has(a.slug));
}

/** sha256 of a body, as the fingerprint `supersedes` is written in. */
export function bodyFingerprint(body) {
  return createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex');
}

/**
 * Which existing articles this release is allowed to rewrite.
 *
 * The rule, and the whole point of it: an article is upgraded ONLY when the
 * body sitting in the database hashes to one of the bodies WE shipped for that
 * slug. That is the proof it was never edited. Everything else — a tenant's
 * rewrite, a hand-inserted row nobody recorded, a body already at the current
 * version — is left untouched.
 *
 * Pure, like articlesMissingFrom, so the rule is testable without a database.
 *
 * @param {Array<{slug: string, body: string}>} existing  rows already in scope
 * @param {Array<object>} [catalog]  the articles to match against. Only the
 *   tests pass this — a sha256 has no preimage, so proving "a body we shipped
 *   IS upgraded" needs a catalog whose predecessor hash the test can compute.
 * @returns {Array<{slug: string, body: string, from: string}>} rewrites to apply
 */
export function articlesToUpgrade(existing = [], catalog = DEFAULT_ARTICLES) {
  const bySlug = new Map(catalog.map((a) => [a.slug, a]));
  const out = [];
  for (const row of existing) {
    const article = bySlug.get(row?.slug);
    if (!article) continue;                       // not ours; never touch it
    const supersedes = article.supersedes || [];
    if (supersedes.length === 0) continue;        // no upgrade path declared
    const current = bodyFingerprint(row.body);
    // Already current. Checked BEFORE the match so a body that is somehow
    // listed in its own supersedes can never loop.
    if (current === bodyFingerprint(article.body)) continue;
    if (!supersedes.includes(current)) continue;  // edited by somebody
    out.push({ slug: article.slug, body: article.body, from: current });
  }
  return out;
}
