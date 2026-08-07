# Prompt para el equipo del KIOSK — Smart lookup de confirmación (S30, 2026-07-19)

## Contexto / problema (Hector)
El cliente llega con el número de confirmación QUE LE DIO LA OTA (Expedia etc.):
`ZE40809640BA`. Pero el sistema lo tiene con el prefijo del import de su
booking-source: TL International lo mete como `TL-ZE40809640BA`. Otras fuentes
(Economy, NU, Flexways, Advantage) tienen sus propios formatos. Además a veces
NO tenemos phone/email del cliente. Resultado hoy: el paso `find_reservation`
del kiosk hace exact-match y le dice "no encuentro tu reserva" a un guest que
SÍ tiene reserva — y ahí muere el check-in autónomo.

## Qué va a existir (lo construye el workstream VozIA/S30 en el backend RFM)
**UN SOLO matcher compartido** — no inventen su propio normalizador (misma
regla que vehicle-status-sync: una sola fuente de verdad):

- `backend/src/lib/reservation-smart-match.js` (puro, unit-tested, DB-free en
  su núcleo):
  - `generateCodeVariants(raw)` → candidatos normalizados: quita/añade los
    prefijos conocidos por booking-source (`TL-`…), case-insensitive, sin
    espacios/guiones, trim de ruido OCR/teclado común.
  - `smartMatchReservation({ code?, name?, dateWindow?, tenantId })` →
    candidatos rankeados `{ reservation, matchType: "exact"|"variant"|"name",
    confidence }`. Tenant-scoped SIEMPRE. Read-only.
- El contrato exacto (firma + shape) se congela cuando S30 lo construya —
  coordinen contra este doc y revisen el lib real antes de integrar.

## Lo que implementa el KIOSK (su lado)

1. **`find_reservation` usa el matcher**: primero exact (como hoy); si falla,
   `generateCodeVariants` + búsqueda por variantes; si falla, ofrecer fallback
   por **nombre + fecha de pickup** ("¿A nombre de quién está la reserva y
   para qué día?").

2. **UX de desambiguación**: si hay varios candidatos, pedir UN dato más
   (fecha de pickup o apellido completo) — nunca mostrar una lista de reservas
   para que el guest escoja.

3. **PRIVACIDAD (regla dura)**: un match que NO fue exact-por-código muestra
   solo datos ENMASCARADOS antes del verify de identidad ("Reserva de Juan
   P*** · pickup mañana · MCO — ¿es la tuya?"). El paso `verify_identity`
   existente sigue siendo el gate para TODO detalle/avance — el matcher no lo
   relaja NADA. Nunca exponer número de confirmación completo, teléfono, email
   ni vehículo pre-verify.

4. **Anti-enumeración**: cap de intentos de lookup por sesión de kiosk (p.ej.
   5) con backoff — un kiosk público no puede ser un oráculo para enumerar
   reservas por nombre común o por fuerza bruta de códigos. Al cap: "pídele
   ayuda al staff" / botón Get Help (VozIA).

5. **Telemetría**: registrar el `matchType` que resolvió cada lookup (exact /
   variant / name / fail) — con eso afinamos los patrones de variantes con
   data real de la tienda.

6. **Get Help coherente**: si el lookup falla del todo, el botón Get Help ya
   monta el chat de VozIA con `res=` vacío — Chloe tendrá el MISMO matcher vía
   su endpoint de service account, así que el guest no repite la pelea.

## Coordinación
- El lib compartido lo entrega S30 (workstream VozIA) — arranquen su
  integración/UX en paralelo con mocks del contrato de arriba, y se amarra
  cuando el lib esté en el árbol.
- Cambios de contrato o patrones de variantes nuevos que descubran en su data
  (formatos raros de import): al doc compartido + avisar, no forks locales.
- Como siempre: additive, read-only, tenant-scoped, y el gate de identidad
  (idVerifiedAt) NO se toca.

---

# CONTRACT FREEZE — aceptado por S30/VozIA (2026-07-19)

El kiosk team mandó sus NEEDS (B3g) y S30 los acepta TAL CUAL como contrato
congelado del lib compartido `backend/src/lib/reservation-smart-match.js`:

```
smartMatchReservation({ code?, name?, dateWindow?, tenantId }) =>
  Promise<Array<{
    reservation: { id: string },   // id estable (cuid) GARANTIZADO; puede
                                   // haber más campos pero NO son contrato
    matchType: 'exact' | 'variant' | 'name',
    confidence: number             // 0–100, rank monotónico, mejor primero
  }>>
```

Garantías que S30 se compromete a cumplir (= acceptance tests del lib):
1. **Tenant-scoped duro** — jamás retorna filas de otro tenant (y el kiosk
   igual re-fetchea cada id bajo su propio scope: cinturón y correa).
2. **Read-only absoluto** — el matcher nunca escribe.
3. **Array rankeado, mejor primero**; múltiples candidatos es comportamiento
   correcto (variante ambigua → >1 booking), no error.
4. `matchType` exacto al enum; el kiosk lo usa para telemetría.
5. El kiosk corre su exact-match ANTES de llamar al lib — el trabajo del
   matcher para el kiosk es el caso `variant`. `name`/`dateWindow` son
   additive para cuando el kiosk quiera delegarlos (VozIA sí los usará).
6. Variantes nuevas descubiertas en el field → al lib compartido + este doc,
   nunca forks locales.

Seam del kiosk: `backend/src/modules/kiosk/kiosk-smart-match.js` (una línea
cuando el lib aterrice). Los detalles de PII/masking son del kiosk (el lib
solo entrega ids). Aviso al kiosk team cuando el lib esté en el árbol.


---

# ✅ LIB ATERRIZADO — beta.331 (2026-07-19, commit 589cc82)

`backend/src/lib/reservation-smart-match.js` está en el árbol y el seam del
kiosk (`kiosk-smart-match.js`, B3g) quedó **CONECTADO** en el mismo tag (lambda
que inyecta prisma — el single-arg contract del seam intacto). El kiosk gana
variant-matching en find_reservation al deployar beta.331. test:kiosk 127/127
con el seam vivo. Nota para el kiosk team: el matcher pasó Innovation+QA con
2 hardenings de privacidad (el stub del ROUTE de VozIA ya no expone id/fecha
exacta) — NO afecta su lado: el lib les sigue devolviendo reservation.id en
cada entry (guarantee #2 del freeze intacta; su re-fetch scoping aplica igual).

---

# 🔁 PATRÓN DE VARIANTE NUEVO — pass 5, tolerancia a cero inicial (2026-08-06)

Registrado aquí porque la regla #6 del freeze lo pide: variante nueva
descubierta en el field → al lib compartido **y a este doc**.

**El caso real.** Un cliente en el baggage claim de SJU dictó su código a
Chloe: *"r e s one zero seven one six zero"* (= `RES-107160`). Llegó al lookup
como **`RES0107160`** — un cero de más al frente — en 3 de 5 intentos. Ninguno
matcheó y el cliente se quedó sin guagua.

**Qué hace pass 5.** Después de generar las variantes de siempre, para cada
candidato cuya cola (tras un prefijo conocido) sea **solo dígitos y empiece en
`0`**, añade la misma variante sin los ceros iniciales.

**Los límites, a propósito:**
- Solo cola **all-digit** — `TL0ZE409` NO se toca (una cola alfanumérica es un
  código real, no un artefacto de transcripción).
- Solo **ceros iniciales** — un dígito de más en cualquier otra posición sigue
  siendo un miss. Es una pasada estrecha y diseñada, no un fuzzy match.
- El resultado debe quedar en **≥3 caracteres** — `RES00012` no produce
  `RES-12`, que matchearía demasiado ancho.
- Se **añade al final** de la lista, así que nunca supera en ranking a un match
  genuino, y `exact` se sigue calculando solo contra `variants[0]`. Una fila
  encontrada por esta tolerancia es siempre `matchType: 'variant'` → **sigue
  enmascarada** hasta que el que llama pruebe un dato. Pass 5 en sí no cambia
  el gate; lo que sí lo cambia es la sección de abajo, y hay que leer las dos
  juntas — el abanico de variantes es justo la población que el comparador de
  apellidos gobierna.
- `take` de la query pasó a `Math.max(MAX_CANDIDATES, variants.length)`: el
  peor caso de variantes subió de 8 a 16 y la query no tiene `orderBy`, así que
  el cap viejo podía botar un candidato arbitrario.

**Colisiones, medidas (no argumentadas).** Un unmask equivocado necesitaría que
existieran `P+"0"+D` y `P+D` en el MISMO tenant y con el MISMO apellido.
Consulta contra prod 2026-08-06: **0 pares colisionando, 0 con apellido igual.**
Y aun colisionando, ambos volverían enmascarados.

**Impacto para el kiosk:** un typo de teclado numérico con cero inicial que
antes daba 404 ahora resuelve, enmascarado, por el camino normal. El
short-circuit de `findFirst` exacto en `kiosk-session.service.js` corre antes,
así que un código bien tecleado ni llega al matcher. `test:kiosk` 148/148.

**Suite:** el test del matcher (`reservation-smart-match.test.mjs`) llevaba
desde S30 **sin correr en ningún script de npm** — huérfano. Ahora es
`npm run test:smart-match` y está en la cadena de `npm test` **y en el step
DB-free de `beta-ci.yml`** — la cadena de npm sola no bastaba: aborta en el
suite #8 por falta de Postgres y nunca llega al final, así que el test habría
quedado huérfano por un segundo mecanismo. 24/24.

---

# 🔒 CAMBIO DE SEMÁNTICA DEL GATE (2026-08-06, decisión de Hector)

Dos mitades opuestas, y hay que leerlas juntas.

**(a) CERRADO PARA EL APELLIDO — la instancia de la FECHA sigue ABIERTA.** Un
dato que SELECCIONA un candidato no puede PROBARLO. La búsqueda
por nombre matchea tokens contra `firstName` OR `lastName`; aceptar el apellido
como verificación dejaba que UNA sola cadena adivinada encontrara la reserva de
un extraño y la destapara. Medido por QA: unmask completo —número, fecha
exacta, status y el **cuid interno** que `maskCandidate` esconde a propósito—
partiendo de un nombre de dos palabras. `candidateMatchesVerification` recibe
ahora `{ matchType }` y con `matchType === 'name'` **ignora `verifyLastName`**:
ahí solo vale `verifyPickupDate`, que la búsqueda no usó.

**(b) El apellido se compara por TOKEN, no como cadena completa**
(`lastNameMatches`). Un huésped cuya reserva dice "Gonzalez Perez" nunca pasaba
el gate diciendo "Perez" — y en PR medio mundo carga dos apellidos y dice uno.

**QUÉ GOBIERNA EXACTAMENTE ESTE COMPARADOR — importa, y la primera versión de
esta nota lo tenía al revés.** En la ruta, `exact` hace corto-circuito a
verificado *antes* de llamarlo, y `name` tiene su apellido ignorado por (a).
Así que el comparador decide **una sola población: los candidatos `variant`** —
o sea filas que el matcher ADIVINÓ expandiendo prefijos y ceros. Un "107160"
dictado abre RES-/TL-/NU-/ECON-/FW-/ADV-107160, y **como máximo una es del que
llama**; el resto son de extraños. No es "ya probó que tiene el número": es
precisamente donde NO lo probó. Por eso el comparador tiene que ser estrecho.

Los dos límites que lo hacen sostenible, ambos encontrados rompiéndolo:
- **Stoplist de partículas.** Sin ella, "De Jesus" destapaba a "De La Cruz": el
  token compartido era `de`. En PR esa partícula está en todos lados, así que
  el hueco era más ancho justo donde el cambio pretendía ayudar. Se descartan
  `de del la las lo los el y da das do dos di du le van von san santa st saint`.
- **Cap de 2 tokens del lado hablado.** Sin cap, una sola petición valía N
  intentos: una bolsa de once apellidos comunes matcheaba casi cualquier fila.
  El lado ALMACENADO no se capea — ese es autoritativo.
- El mínimo de token queda en 2 chars, no 3: `Ng`, `Li`, `Wu` son apellidos
  reales y fallarlos solo empuja al huésped honesto a la fecha de pickup.

**Medición en prod con el predicado correcto** (traslape de token sobre el
abanico COMPLETO de prefijos — el bare core igual dentro del mismo tenant, no
solo la familia de ceros): **0 pares colisionando, 0 compartiendo token de
apellido.** Hoy no hay instancia viva; los límites de arriba son estructurales,
no dependen de ese cero.

Más suelto donde el que llama ya probó algo, más estricto donde el propio
nombre hizo el hallazgo. Consumidor único: la ruta `/smart-lookup`.

**⚠️ ABIERTO — la MITAD de fecha del mismo oráculo, y es la barata.** Los
params `from`/`to` de la ruta se convierten en el `dateWindow` del matcher, que
FILTRA la búsqueda por nombre por `pickupAt`. O sea la fecha **selecciona** la
población. Y `verifyPickupDate` **prueba** por fecha. Es exactamente la misma
clase que (a), sin cerrar.

Peor que un simple resto simétrico: si atas `from=to=X` y `verifyPickupDate=X`,
todo lo que vuelve verifica, así que `isFailedVerifyProbe` da false y **el
barrido no cuesta NI UNA ranura del throttle** — hasta 10 filas destapadas por
petición, día por día. Gratis para el que barre, mientras al huésped honesto sí
se le cobraba (eso último ya está arreglado).

Es **preexistente** — los dos params son de antes de este arco — y no es
alcanzable por Chloe: el `HttpAdapter` de Valet nunca manda `from`/`to`. Pero
este cambio **encamina tráfico hacia ahí** (el `nextStep` ahora dice "pídele la
fecha exacta de pickup … verifyPickupDate"), así que hereda el volumen. Lo
correcto es lo mismo que se hizo con el apellido: si la fecha acotó la
población, la fecha no puede ser la prueba.

**PENDIENTE para el kiosk (no lo tocamos):** `kiosk-session.service.js` sigue
comparando el apellido con `equals` de cadena completa, así que el huésped con
dos apellidos SIGUE trancado en el kiosk — que es el camino de más volumen. El
objetivo de negocio de Hector está a medias hasta que eso se atienda.
