# TollBridge -> RFM: respuesta de integracion (recibida 2026-07-26, preparada 2026-07-24)

Pegada verbatim por Hector. Modelo confirmado: RFM consume su partner API, empareja y factura;
TollBridge nunca cobra ni escribe al cliente en sedes facturadas-por-RFM.

Estado RFM al 2026-07-26: su hallazgo del mirror agreement se corrigio en beta.357;
los puntos 7 (ventana re-match por sede) y 8 (notificacion al empleado) se construyeron a continuacion.
Pendientes de ellos: API key, GET /api/partner/tolls, staging (puntos 1-3); de Hector: politica de fee admin (punto 6).

---

TollBridge → equipo de Ride Fleet Manager (Corpusa / LAX)
Respuesta a las 8 preguntas de integración. Preparado 2026-07-24. Todo lo que sigue está verificado contra el código en producción — donde algo no existe, lo digo en vez de describir el diseño previsto.
0. Modelo de integración — CONFIRMADO
Vamos con lo que ustedes proponen: TollBridge es un proveedor de peajes más. Nosotros scrapeamos los portales de California y les entregamos las transacciones por API; ustedes emparejan y facturan dentro de RFM con sus propias reglas y sus propios fees.
Es la decisión correcta: para LAX no existe TSD, así que toda la maquinaria de facturación de TollBridge (write-back, tarifas, libro de "cobrado una vez") es específica de un sistema que ahí no se usa. Ustedes ya tienen el matcher probado y el personal de LAX ya trabaja en RFM.
La regla que queda fijada, y es la importante: para las sedes que ustedes facturan, TollBridge NUNCA emite un cargo ni le envía correo al cliente. Está garantizado en código, no por convención: una sede marcada como facturada-por-RFM queda excluida tanto de la cola de facturación como de la de correos, con pruebas de regresión contra base de datos real que fallan si alguien quita el guard. Un peaje no puede ser cobrado por los dos sistemas.
Dos consecuencias de este modelo que conviene tener presentes:
La tarifa administrativa la definen ustedes. No intenten replicar la nuestra: en TollBridge se calcula una vez por contrato sobre el conteo final (no por cruce) y lleva tope. Por eso el punto 4 de su lista —"fee administrativo desglosado por transacción"— no lo podemos entregar: no existe ese dato y conceptualmente no puede existir. Un contrato con 22 peajes no paga 22 fees. Ustedes aplican su propia política dentro de RFM.
Nosotros dejamos de ver el emparejamiento de LAX. TollBridge tendrá las transacciones (las scrapea) pero no sabrá a qué contrato pertenecen. Reportes de volumen y monto sí; de "a quién se le facturó", no. Es la contrapartida natural de que ustedes sean el sistema de facturación.
Acceso y API
1. ¿Cómo se consumen las transacciones? URL, docs, autenticación.
Base: https://tollbridge.ridefleetmanager.com
Hoy existe: GET /api/tolls/transactions — pero es el endpoint que alimenta nuestra propia UI, no una API de socio. Devuelve las últimas 200 filas del tenant, sin paginar.
No existe: webhook, FTP, ni especificación OpenAPI publicada.
Autenticación hoy: JWT Bearer vía POST /api/auth/login, token de 12 horas (src/lib/auth.js:31). Para una integración desatendida eso no sirve — habría que emitirles una API key de larga duración con alcance de sólo lectura, que hay que construir (no existe).
Veredicto honesto: para consumo máquina-a-máquina hace falta un endpoint nuevo. No es trabajo grande (ver punto 3), pero no es "apunten a esta URL y listo".
2. ¿Sandbox o cuenta de prueba?
No existe. Hay un modo demo del frontend con datos ficticios, que no sirve para integrar contra una API. Opciones realistas, en orden de preferencia:
(a) Levantamos un tenant de staging con datos sintéticos de California — es lo correcto, y es lo que recomendamos para que ustedes puedan verificar imports sin tocar datos reales.
(b) Les damos acceso de sólo lectura al tenant real de LAX una vez tenga transacciones. Más rápido, pero mezcla pruebas con producción.
3. Endpoint por rango de fechas y/o placa, paginación, rate limits
Nada de eso existe hoy: el endpoint actual sólo filtra por status y locationId, con take: 200 fijo y sin paginación. Tampoco hay rate limiting configurado (salvo en login).
La buena noticia: los índices que hacen falta ya están en la base — (tenantId, plateNormalized, transactionAt) y (tenantId, status, transactionAt). Así que el endpoint que ustedes necesitan es barato de construir y rápido en consulta. Propuesta concreta:
GET /api/partner/tolls?from=<iso8601>&to=<iso8601>&plate=<opcional>&cursor=<id>&limit=500
Authorization: Bearer <api-key de solo lectura>
200 {
  "transactions": [ {
      "id":            "<cuid>",              // estable, para idempotencia de su lado
      "externalId":    "<id del proveedor>",  // único por tenant
      "plate":         "8XYZ456",
      "plateNormalized":"8XYZ456",
      "transactionAt": "2026-07-02T16:14:00.000Z",   // SIEMPRE UTC, ISO-8601 con Z
      "location":      "SR-73 Catalina View",
      "lane":          "SB",
      "amount":        3.25,
      "provider":      "FASTRAK_TCA",
      "status":        "IMPORTED|MATCHED|NEEDS_REVIEW|BILLED|DISPUTED|VOID"
  } ],
  "nextCursor": "<id|null>"
}
Paginación por cursor sobre id (estable ante inserciones), límite 500 por defecto y 1000 máximo. Rate limit sugerido: 60 req/min — díganos si necesitan más para la carga inicial.
4. Datos por transacción
Lo que piden	Estado
Placa	✅ plateRaw + plateNormalized
Fecha/hora con zona	✅ transactionAt, siempre UTC (ver aviso abajo)
Plaza/ubicación	✅ location + lane
Monto del peaje	✅ amount (decimal 10,2)
Fee administrativo desglosado	❌ no existe por transacción — es por contrato, ver punto 0
Aviso de zona horaria, aprendido a la mala esta semana. Los estados de cuenta de California imprimen hora local sin offset. Si se interpretan como UTC, un peaje de 09:14 PDT se guarda como 09:14Z (7-8 horas antes) — suficiente para caer dentro de la renta anterior y facturarle al cliente equivocado. Nosotros lo resolvemos convirtiendo con la zona de la sede (America/Los_Angeles) al momento de importar. Lo que les entreguemos por API siempre irá en UTC con Z explícita. Si su matcher compara contra pickupAt/returnAt en hora local, asegúrense de normalizar de un solo lado — es el error más caro de esta integración.
5. Demora y correcciones
Florida (medido en nuestros datos): SunPass postea con días de rezago; hemos visto peajes del 02/07 aparecer el 18/07. Nuestro ciclo interno es de 30 minutos, así que el rezago es del proveedor, no nuestro.
California (LAX): los portales publican por estado de cuenta mensual. Esperen entre 1 semana y 1 mes desde el cruce. Es la razón por la que su ventana de re-match no puede ser de 14 días — nosotros la subimos a ~45 días para LAX.
Correcciones/ajustes: no hay un mecanismo formal de revisión. Deduplicamos por externalId (único por tenant) más una firma de contenido. Si un portal reemite una transacción con distinto identificador, entra como nueva. No manejamos versiones ni notas de crédito a nivel de transacción. Un cargo anulado se marca status = VOID, así que conviene que refresquen el estado de transacciones ya importadas, no sólo que consuman las nuevas.
Operación
6. Registro/actualización de placas (236 vehículos con rotación)
Hoy: POST /api/fleet/import-sunpass-csv (carga CSV, autenticada) y PATCH /api/fleet/:id. Es un import de archivo pensado para operación manual, no una API de sincronización de flota.
Para 236 vehículos con rotación: funciona, pero conviene invertirlo — que RFM sea la fuente de verdad de la flota y TollBridge la lea, ya que ustedes ya administran altas y bajas. Si les sirve, expongan un GET /fleet y nosotros sincronizamos; evita que alguien mantenga dos listas.
7. Proceso de disputa
No existe un flujo de disputa para peajes. El estado DISPUTED está en el modelo pero ninguna ruta lo usa (sí hay flujo de disputa en el módulo de multas, que no aplica aquí). Hoy una transacción incorrecta se corrige a mano.
Si la disputa importa para LAX, hay que construirla, y es una decisión de diseño de dónde vive: si RFM factura (opción A), probablemente la disputa debería vivir de su lado y sólo notificarnos.
8. Contacto técnico
Hector Padilla — dueño de ambos sistemas. Coordinar por su vía habitual.
9. Petición de Hector: notificación al empleado cuando entra un peaje
Este es un requerimiento del negocio, no un detalle técnico, y en este modelo cae del lado de ustedes porque son quienes conocen el contrato. Hector lo pidió explícitamente para LAX.
El problema que resuelve: los peajes de California llegan entre una semana y un mes después del cruce. Para cuando aparecen, la renta casi siempre ya cerró y el cliente se fue. Si el cargo entra al contrato sin que nadie se entere, no se cobra nunca. Con ~20-30 peajes al mes es perfectamente manejable a mano — pero sólo si alguien se entera de que llegaron.
Lo que se necesita, cuando un peaje se adjunta a un contrato:
Aviso dentro de RFM, donde el personal de LAX ya trabaja. Que el peaje nuevo salte a la vista en el contrato — no que quede como una línea más entre los cargos. Un contrato ya cerrado con un cargo nuevo es el caso de riesgo, así que ese es el que más debe destacar.
Correo al encargado de cobros de peajes de la sede. Destinatario configurable por sede (no quemado en código): LAX tendrá su persona, y si mañana entra otra sede tendrá la suya.
Uno por peaje, no un resumen diario. Y idempotente: un peaje avisa una sola vez, sin importar cuántas veces corra el proceso.
Contenido mínimo para que el empleado actúe sin buscar nada: contrato, cliente, placa, monto, fecha del peaje y enlace directo al contrato.
Por qué no lo hacemos nosotros: en este modelo TollBridge entrega la transacción pero no sabe a qué contrato pertenece — el emparejamiento es de ustedes. No podemos avisar "nuevo peaje en el contrato X" porque nunca vemos la X. Lo más que podríamos hacer es avisar volumen ("entraron 23 peajes de LAX"), que no le sirve a quien tiene que cobrar.
Si les es útil, nosotros ya diseñamos esta pantalla para el otro modelo y podemos compartir el mockup aprobado (bandeja "peajes por cobrar" con los cerrados resaltados) — es reutilizable tal cual en RFM.
Dos cosas de su matcher que ahora los afectan a ustedes
Como el emparejamiento queda de su lado, estos dos puntos pasan a ser suyos. Los verificamos leyendo su código, no son suposiciones:
(a) Sus modelos de peaje no tienen sede. TollTransaction está scopeado sólo por tenant — no tiene locationId — y listTenantVehiclesForMatch (tolls.service.js:779) recorre toda la flota del tenant. Si en el mismo tenant conviven los carros de LAX y los de Florida, un peaje de California puede evaluar contra un carro de Florida. En la práctica las placas difieren entre estados, así que el riesgo es bajo — pero no es cero, y es exactamente la clase de fallo que en nuestro lado nos obligó a construir un aislamiento por sede explícito. Si van a facturar LAX, consideren scopear el matching por sede.
(b) La ventana de re-match tiene que ser más ancha de lo normal. Los estados de cuenta de California llegan hasta un mes tarde, o sea el peaje aparece cuando la renta ya cerró. Si su matcher sólo considera rentas abiertas o recién cerradas, esos peajes no van a emparejar nunca y la pérdida es silenciosa. Nosotros tuvimos que subir esa ventana a ~45 días para LAX, y hacerlo por sede — subirla globalmente reabría la ventana de otras sedes y podía facturar contratos cerrados hace meses.
Un hallazgo en su lado que les conviene revisar (independiente de esta integración)
Revisando el módulo de peajes de RFM para diseñar esto, encontramos algo que ya les está afectando hoy con sus proveedores actuales, no sólo con TollBridge:
syncReservationTollCharges (backend/src/modules/tolls/tolls.service.js:1265) termina en refreshReservationEstimatedTotal y nunca llama a syncAgreementCharges. Como el balance impago que lee el mostrador es RentalAgreement.balance — y esa función hace early-return en agreements CLOSED salvo que reciba { allowClosed: true } (reservation-pricing.service.js:210) — un peaje que llega después del check-in crea un ReservationCharge que nunca llega al balance.
Como los peajes casi siempre llegan después de que la renta cerró, el efecto es pérdida silenciosa: el cargo existe en la reserva pero el mostrador no lo ve y nadie lo cobra. Vale la pena un ticket aparte, con o sin esta integración.
Resumen: qué falta para que ustedes conecten
#	Trabajo	De quién	Tamaño
1	API key de sólo lectura, larga duración	TollBridge	chico
2	GET /api/partner/tolls con fechas/placa/cursor	TollBridge	chico (índices ya existen)
3	Tenant de staging con datos de California	TollBridge	chico
4	Cuentas de peaje CA + flota de LAX cargada, scraper corriendo	TollBridge	mediano
5	Acordar quién es fuente de verdad de la flota	ambos	decisión
6	Su política de fee administrativo para LAX	RFM	decisión de negocio
7	Ventana de re-match ~45 días + scope por sede	RFM	mediano — ver arriba
8	Notificación al empleado (en RFM + email)	RFM	mediano — pedido de Hector, punto 9
9	Flujo de disputa (si se necesita)	por definir	mediano
Con los puntos 1, 2 y 3 ustedes pueden estar importando y verificando en días, como dicen. El punto 4 es el que marca cuándo hay datos reales de California que consumir: depende de que las cuentas de los portales estén operativas de nuestro lado.
Nada de esto requiere que ustedes construyan endpoints. En este modelo ustedes sólo consumen.