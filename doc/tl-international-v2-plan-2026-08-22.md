# TL International — plan de integración v2 y respuesta al due diligence

**Fecha:** 2026-08-22
**Entrada:** `UK_US_Puerto_Rico_Data_Protection_Information_Due_Diligence.docx` (lado UK, recibido 2026-08-19)
**Complementa:** `doc/tl-international-v2-integration-requirements-2026-08-13.md`

> Nada de este documento es asesoramiento legal. El propio documento de TL lo dice de sí mismo.
> Los puntos marcados ⚠️ necesitan la firma de un abogado de privacidad UK/EEUU.

---

## 1. Qué pide realmente TL

Dos cosas que conviene no mezclar:

1. **Un cuestionario de protección de datos** — 16 secciones más 9 documentos de evidencia. No es
   una negociación técnica: es la debida diligencia previa a redactar el contrato.
2. **Una integración servidor-a-servidor** que sustituya el scraping — recoger reservas, notificar
   recogida y devolución, y reenviar los documentos del alquiler.

La restricción que gobierna el calendario está en la sección 6, literal:

> Development may proceed using appropriately controlled test or synthetic data where agreed.
> However, live UK customer personal data must not be transferred through the proposed integration
> until the applicable assessment has been completed and the necessary contractual,
> international-transfer and technical safeguards have been approved and put in place.

**Se puede construir desde hoy. Lo que no puede cruzar es un dato real de un cliente británico.**
Por eso el plan tiene tres carriles paralelos y no una secuencia.

---

## 2. Dónde estamos de verdad (verificado en producción, 2026-08-22)

No tomar estos valores del `.env.example`: sus valores por defecto **no** coinciden con producción.

| Hecho | Valor real | Por qué importa |
|---|---|---|
| Aplicación y API | DigitalOcean **nyc3** — Clifton, Nueva Jersey | El cuestionario asume Puerto Rico en 5 secciones |
| Base de datos | Supabase sobre **AWS us-east-1** (Postgres 17.6) | Transferencia a EEUU: necesita mecanismo legal |
| Caché | DigitalOcean gestionado, red privada, TLS | — |
| **Hosting en Puerto Rico** | **Ninguno** | Elimina toda la rama territorial del análisis |
| Scraper de TL | `TL_INTEGRATION_ENABLED=false` — **apagado** | El riesgo de descubrimiento es histórico |
| Credencial de TL | **International Rental Corp**, refrescada 2026-08-20 | Identifica el tenant afectado |
| Documentos y fotos | Flags en `true` → Supabase Storage | Mejor de lo que asumían los informes |
| Firmas | Base64 en línea en Postgres, siempre | Están dentro de cada copia de seguridad |
| **OCR con Anthropic** | Clave activa en **Corpusa** e **International Rental Corp** | Choca con la cláusula de IA de TL |
| Sentry | Activo, **sin filtro de datos personales** | Un error de Prisma puede enviar PII a EEUU |

### Lo que sí es fuerte y conviene enseñar

- **Nunca tocamos el número de tarjeta ni el CVV.** No existe un campo de tarjeta en nuestra
  interfaz: todo pasa por el terminal Dejavoo o por campos alojados del procesador. El alcance PCI
  queda en el nivel más bajo.
- **Aislamiento por tenant y por sede**, cerrado por defecto, con pruebas de regresión propias.
- **Credenciales de integración cifradas** con AES-256-GCM e IV aleatorio por escritura.
- **Redacción de PII en los logs**, con claves enmascaradas y truncado de blobs base64.
- La importación de reservas ya es **agnóstica del origen**: seis integraciones comparten
  `ExternalReservation`, la bandeja de pendientes y el promotor.

---

## 3. Los bloqueos, ordenados

### 3.1 Bloquean contestar el cuestionario con honestidad

| # | Bloqueo | Estado real |
|---|---|---|
| B1 | **Sin doble factor** en ninguna cuenta, incluido el superadministrador | No existe |
| B2 | **Sin límite de retención automático** en ninguna categoría | Solo 30 días en copias de seguridad |
| B3 | **Borrado de un cliente roto** — falla por clave foránea y devuelve "cliente no encontrado" | Falla silenciosa |
| B4 | **Sin exportación de los datos de un cliente** (derecho de acceso) | No existe |
| B5 | **Sin registro de accesos** — `AuditLog` exige un ID de reserva | Estructural |
| B6 | **Impersonate sin trazabilidad** — no se registra y el token no lleva marca | Estructural |
| B7 | **Anthropic recibe imágenes de licencias** en el tenant que consume TL | Activo |
| B8 | **Sentry sin `beforeSend`** — la redacción existente no cubre los errores | Activo |

### 3.2 Hallazgo de seguridad vivo, independiente de TL

`GET /api/customer-inspection/v/:payload` **no exige autenticación** (comprobado contra producción:
400 con firma inválida, frente a 401 en rutas protegidas). La firma del QR es un HMAC estático sobre
el ID del vehículo, **sin caducidad, impreso en una pegatina del carro**. Resuelve a la reserva que
esté `CHECKED_OUT` en ese vehículo y devuelve **el nombre del cliente actual**, además de emitir un
token de 24 h que permite crear reportes de daño contra ese alquiler.

Encendido **solo en Corpusa**. No requiere atacante remoto: basta haber fotografiado la pegatina, el
acceso no caduca y no queda registrado.

**Arreglo mínimo honesto:** que el QR incluya un nonce por reserva emitido en el check-out y que
caduque en la devolución; montar el router tras el guard de tasa por IP; separar el secreto del QR
de `JWT_SECRET` y eliminar el literal de reserva `ride-fleet-qr`.

### 3.3 Riesgos operativos de la integración

- **Cancelaciones**: si TL cancela, la reserva deja de aparecer en el feed y nada la concilia. El
  vehículo queda bloqueado y la reserva viva. Arreglo: marcar `MISSING_FROM_FEED` lo que no aparezca
  en un barrido completo y **que lo decida una persona**, nunca cancelar automáticamente.
- **`ExternalReservation` sin unicidad por tenant** — hoy solo un tenant consume TL; si mañana son
  dos, colisionan en la misma fila.
- **Sin tiempo de espera** en las llamadas de `modules/integrations/`. El cliente v2 lo lleva.

---

## 4. Arquitectura decidida

### 4.1 Entrada: sondeo, no webhooks

**Sondear a TL con cursor delta**, y aceptar un webhook suyo, si lo ofrecen, solo como aviso que
encola un sondeo — nunca como vía de datos.

El argumento decisivo no es técnico sino de relación: un webhook hace a TL responsable de nuestras
caídas — almacenar, reintentar, alertar de nuestros 500. Eso es exactamente *"many hours of
additional development and support work"* que describieron de TSD. El sondeo pone toda la carga
operativa de nuestro lado, que es la forma con más probabilidad de recibir un sí. Además, un sondeo
perdido se cura solo en el siguiente ciclo; un webhook perdido no.

Y bajo GDPR: sondeando, **nosotros** elegimos la ventana y el conjunto de campos, y podemos
demostrarlo. Con push, TL decide qué aterriza en nuestros servidores y cuándo.

### 4.2 Salida: bitácora en Postgres con reconciliador

La pieza que hay que defender: **el reconciliador es la garantía, la emisión es solo latencia.**

El checkout moderno y el cierre de check-in **no tienen transacción** donde engancharse, así que una
emisión en línea nunca podría ser una garantía. Se invierte: los eventos se derivan de la verdad de
las reservas cada cinco minutos, igual que ya hacen los barridos de deriva de vehículos y comisiones.

Tres consecuencias que valen el diseño:

1. **El mostrador nunca habla con TL.** Su tiempo de actividad no puede tocar a un cliente esperando.
2. Si alguien añade un cuarto camino de checkout y olvida emitir, el reconciliador lo cubre igual.
3. Si TL se cae un día entero, solo crece la profundidad de la cola.

Una tabla nueva, `TlOutboundEvent`, que hace triple trabajo: cola durable, acuse de entrega y
registro de auditoría. Escalera de reintentos propia (1m → 24h, ~12 intentos en 4 días), muy por
encima del techo de 43 minutos de BullMQ. Orden por reserva mediante secuencia en bandas
(100 recogida, 200 devolución, 300+ documentos), sin bloqueo global.

### 4.3 Retención y auditoría a la vez

El truco que hace compatible "registro auditable completo" con "derecho al borrado":
**el registro sobrevive al dato personal.** `payload` y `tlAckBody` son anulables; el hash, las
marcas de tiempo, el acuse de TL y el estado no lo son. A los 90 días se redacta el contenido y la
fila permanece. Se puede seguir demostrando *que* el documento X se entregó el día Y y que sus bytes
daban el hash Z, sin conservar los datos del cliente.

### 4.4 Que los datos reales no puedan cruzar por accidente

No como política, sino estructuralmente:

- `TL_API_MODE = OFF | SANDBOX | LIVE`, por defecto `OFF`. En `SANDBOX`, el resolutor de URL
  **rechaza cualquier host** que no esté en la lista permitida.
- `LIVE` **se niega a arrancar** salvo que estén las tres attestaciones:
  `TL_LEGAL_DPA_SIGNED`, `TL_LEGAL_IDTA_SIGNED`, `TL_LEGAL_TRA_COMPLETE`.
- Servidor TL falso con inyección de fallos (500, timeout, 429, acuse duplicado, documento parcial,
  y el «éxito falso» que nos enseñó Economy).
- Datos sintéticos solo de rangos reservados: `@example.com`, `+44 7700 900xxx` (rango de ficción de
  Ofcom), códigos postales de ejemplo. Cada registro marcado `isSynthetic: true`.
- Una prueba tripwire que afirma todo lo anterior.

---

## 5. Vía legal de transferencia

### 5.1 Recomendación: IDTA ahora, DPF como proyecto opcional después

Somos importadores estadounidenses de datos personales británicos. Sin el puente de datos UK-EEUU
hacen falta salvaguardas contractuales.

- **IDTA + DPA + anexos** se puede firmar en días. Es lo que el documento de TL ya asume.
- **Certificarse al DPF** cuesta ~$250–260/año de tasa (las fuentes discrepan en la cifra exacta;
  la Extensión UK va incluida sin coste adicional) más un mecanismo de recurso independiente
  (~$750/año orientativo) más el fondo de arbitraje, tarda 4–8 semanas, **exige certificarse
  primero al EU-US DPF** (la Extensión UK no es un camino aparte) y **no elimina la necesidad del
  DPA ni de los anexos**. La salida además es pegajosa: al retirarse hay que borrar o devolver los
  datos, o seguir aplicando los Principios y pagar $260/año indefinidamente.

Y sobre todo, los cimientos del DPF están bajo tensión visible: el recurso *Latombe* está ante el
TJUE, el PCLOB sigue sin cuórum, y el **29 de junio de 2026 el Tribunal Supremo anuló
*Humphrey's Executor* en *Trump v. Slaughter***, eliminando la independencia de los comisionados de
la FTC — que es precisamente el pilar de aplicación del DPF. El consejo predominante, incluso para
empresas ya certificadas, es mantener un IDTA de todas formas.

Un matiz que juega a favor del DPF si algún día se plantea: el **30 de julio de 2026 la ICO aclaró
que la adecuación británica es independiente de la europea**, así que una sentencia del TJUE contra
la decisión europea no tumbaría automáticamente el puente británico.

### 5.2 Tres hechos que reducen nuestro trabajo — decírselos a TL pronto

**a) La evaluación de riesgo de transferencia es obligación de TL, no nuestra.** La hace quien
**inicia** la transferencia restringida, es decir el exportador. Nosotros aportamos los insumos.

**b) La ICO permite expresamente apoyarse en el análisis del gobierno británico sobre el derecho
estadounidense** (DSIT, septiembre 2023) para una evaluación UK→EEUU, y su conclusión es que es
razonable y proporcionado apoyarse en él **con independencia de si el riesgo es bajo, medio o alto**
— y **precisamente cuando el importador no está certificado al DPF**, que es nuestro caso. Si su
abogado planea un análisis de equivalencia esencial al estilo europeo, es más trabajo del que la ICO
exige. Decirlo ahorra semanas a ambos lados.

**c) El estándar británico cambió el 5 de febrero de 2026.** La Data (Use and Access) Act 2025
sustituyó el criterio de *Schrems II* por una prueba estatutaria de **"no materialmente inferior"**,
basada en riesgo. Las evaluaciones hechas con la guía anterior siguen siendo válidas.

### 5.3 Lo único que tenemos que producir nosotros

**El paquete de "Importer Information"** (IDTA s.8.3.1): leyes y prácticas locales, riesgos, y todo
lo que el exportador necesite razonablemente para su evaluación — **antes de que se mueva ningún
dato**. Más medidas técnicas y organizativas **en términos específicos, no genéricos**, la lista de
subprocesadores y el calendario de retención y borrado.

Se construye una vez y sirve para cualquier futuro socio británico.

### 5.4 ⚠️ Tres avisos que hay que llevar al abogado antes de firmar nada

1. **No firmar una declaración categórica de que no somos un "electronic communications service
   provider".** El propio análisis de DSIT pone como ejemplo de ECSP *"computer terminals running an
   electronic reservations system"*, dice que no hace falta prestar servicio al público y que basta
   una pequeña cantidad de actividad aunque no sea la función principal. Eso nos describe. Podemos
   **describir nuestros servicios de forma factual** y dejar que el exportador lo valore; lo que no
   debemos es garantizar una conclusión jurídica que esa nota al pie contradice.

2. **Encargado o responsable — resolverlo antes de redactar, no después.** El ejemplo propio del
   EDPB (agencia de viajes que envía datos a aerolínea y hotel) concluye **responsables
   independientes**. Si el alquiler se hace bajo nuestro contrato, con datos que recogemos nosotros
   en el mostrador, retención nuestra y respuestas nuestras a los clientes, esa es casi con certeza
   nuestra posición. Cambia el papeleo de forma sustancial: acuerdo de intercambio de datos en vez
   de contrato de encargo, y nos aplican directamente cláusulas de responsable — incluida la
   respuesta a solicitudes de acceso **en un mes**. Etiquetarse mal no sirve de nada: el IDTA
   s.3.2 aplica automáticamente las cláusulas del rol correcto.

3. **Representante en el Reino Unido (art. 27).** No se activa por ser encargado de un exportador
   británico. Sí se activa, muy probablemente, si ofrecemos alquileres a clientes británicos con
   nuestro propio contrato — precios en libras y condiciones o contactos específicos para el Reino
   Unido son justo los indicadores que usa la ICO. Es un papel de mero canal de comunicación y
   barato de externalizar.

### 5.5 Fechas de revisión

**FISA 702 caducó como estatuto en junio de 2026**, pero la vigilancia continúa bajo certificaciones
prorrogadas **hasta marzo de 2027**, y su renovación está sin resolver. Cualquier evaluación de
transferencia debe ir fechada y con revisión programada: conviene un ciclo **semestral**. El IDTA se
auto-modifica (s.5.4) cuando la ICO publique la versión nueva prevista para 2026, así que no hay que
rehacer papeles.

---

## 6. Plan por fases

### Carril 1 — Contestar el cuestionario (empieza ya)

| Paso | Depende de |
|---|---|
| Corregir el supuesto de Puerto Rico y aportar el mapa de hosting real | Hecho |
| Pliego de respuestas con evidencia por archivo y línea | Hecho, falta formato final |
| Paquete de *Importer Information* + medidas técnicas específicas | Nosotros |
| Datos de entidad legal + 3 contactos (firmante, privacidad, seguridad) | **Hector** |
| Evidencia PCI del procesador | **Hector** |
| Políticas: privacidad, seguridad, retención, brechas | Redactar si no existen |
| Diagrama de flujo de datos | Se deriva del carril 3 |

### Carril 2 — Cerrar los bloqueos técnicos

**Antes de contestar** (porque cambian la respuesta): filtro de PII en Sentry (~15 líneas,
reutiliza `redactSensitive()` ya probada); decisión sobre el OCR de Anthropic; arreglo del QR de
Corpusa.

**Antes del go-live**: doble factor en `SUPER_ADMIN` y `ADMIN`; servicio único de borrado que cubra
las copias desnormalizadas, las firmas, `ExternalReservation.rawJson` y **los archivos en el
bucket**, no solo los punteros; exportación de datos por cliente; registro de auditoría de accesos y
trazabilidad del impersonate; calendario de retención implementado.

### Carril 3 — Construir con datos sintéticos (empieza ya)

- **Fase 1** — Servidor TL falso, semilla sintética, cliente con tiempos de espera, puerta legal y
  pruebas de contrato. *No depende de TL en absoluto.*
- **Fase 2** — Entrada real por su API, con planificador (TL es la única integración que hoy no
  tiene uno). Requiere sus respuestas y un entorno de pruebas.
- **Fase 3** — Retirada del scraper, tras **14 días de sombra** con paridad demostrada por datos,
  cero credenciales caducadas, y confirmación por escrito de TL. No al primer verde.
- **Fase 4** — Eventos de recogida y devolución. Una semana en `DRY_RUN` en producción antes de
  `LIVE`, con el reconciliador sin encontrar nada que reparar.
- **Fase 5** — Documentos, con manifiesto previo y verificación por lectura de vuelta.
- **Fase 6** — Operaciones GDPR y go-live.

---

## 7. Preguntas que bloquean el diseño y solo TL puede responder

1. URLs base (producción y pruebas), método de autenticación, quién emite credenciales y cómo se rotan.
2. ¿El feed lleva modificaciones y cancelaciones? ¿Con qué vocabulario de estado? ¿Hay un
   `updatedAt` o versión monótona por reserva?
3. «Returned and the rental completed»: ¿el vehículo está de vuelta, o el saldo está liquidado? Si
   importan ambos, ¿quieren dos eventos?
4. Endpoints y formatos de los eventos; nombre y semántica de la cabecera de idempotencia; qué
   códigos significan reintentar y cuáles no; ¿exponen lectura de vuelta para verificar?
5. Subida de documentos: formato, tamaño máximo, tipos aceptados, ¿manifiesto y deduplicación?,
   ¿cuáles son obligatorios? Y en concreto: **¿quieren recibir licencias y documentos de identidad?**
   Por minimización preferimos no enviarlos salvo que tengan base legal y periodo de retención.
6. Su DPA estándar. ¿Aceptan hosting en EEUU bajo el IDTA, o exigen residencia UK/UE? La residencia
   es un proyecto de infraestructura aparte y hay que saberlo **antes** de diseñar.
7. Entorno de pruebas con reservas de ejemplo, y **sus** criterios de aceptación para el go-live —
   que definan qué es "correcto" antes de escribir código, que es literalmente lo que pidieron.
8. Límites de tasa, ventanas de mantenimiento y política de versionado.

---

## 8. Decisiones pendientes de Hector

1. **QR de inspección en Corpusa** — ¿apagar hoy y arreglar, o arreglar primero?
2. **OCR de Anthropic** — ¿declararlo como subprocesador, o apagarlo para el tenant de TL?
3. **Scraper de TL** — está apagado; ¿lo retiramos del todo y se lo contamos a TL como apertura de
   la conversación, en vez de que lo descubran ellos?
4. Datos de entidad legal, los tres contactos, evidencia PCI, y qué políticas existen ya por escrito.
5. **Abogado de privacidad UK/EEUU** — hace falta para cuatro puntos concretos: la caracterización
   responsable/encargado, el representante del artículo 27, el lenguaje sobre ECSP, y la
   jurisdicción de la FTC sobre una entidad de Puerto Rico. ¿Tienes uno, o hay que buscarlo?
