# Plan de acción — cerrar los huecos antes de contestar a TL

**Fecha:** 2026-08-22
**Objetivo:** llegar a un pliego de respuestas donde lo que piden **ya esté hecho**, no prometido.
**Acompaña a:** `doc/tl-international-ddq-response-2026-08-22.md`

---

## Cómo leer este plan

Cada elemento dice **qué respuesta convierte**. Ese es el criterio de "terminado": no es que el
código exista, es que podamos contestar que sí a una pregunta concreta del cuestionario sin matices.

Las estimaciones son de trabajo enfocado, no de calendario. Y son estimaciones — las de la ola 2 son
las más inciertas porque tocan datos vivos.

**Una recomendación de entrada:** no intentes cerrar los 34. Tres de ellos cuestan meses y miles de
dólares para mover una respuesta de "no tenemos" a "tenemos", y hay una forma más honesta y más
barata de contestarlos, que está al final en la ola 5. Cerrar 31 y declarar 3 con criterio se lee
mejor que cerrar 34 mal.

---

## Resumen

| Ola | Qué es | Elementos | Estimación |
|---|---|---|---|
| **0** | Arreglos baratos que ya cambian una respuesta | 6 | ~2 días |
| **1** | Seguridad de acceso | 5 | ~4 días |
| **2** | Derechos de los interesados y retención | 5 | ~8 días |
| **3** | Trazabilidad y registro | 4 | ~4 días |
| **4** | Aseguramiento y proceso | 5 | ~3 días + proveedor externo |
| **5** | Documentos y políticas | 6 | ~4 días |
| **6** | Correcciones de la integración | 6 | ~4 días |
| | **Total** | **37** | **~29 días + pentest externo** |

Las olas 0 a 3 son las que mueven respuestas de "no" a "sí". La 4 y la 5 son las que hacen que el
pliego parezca el de una empresa seria. La 6 no la pide el cuestionario pero la pide la integración.

---

## Ola 0 — Baratos y de alto impacto (~2 días)

Todo esto son horas. Hacerlo primero porque cada uno cambia literalmente una casilla del pliego.

### 0.1 Filtro de datos personales en Sentry
**Convierte:** 3.4 y 3.9 — de "el monitoreo de errores puede transmitir datos personales" a "no lo hace".
**Qué:** aplicar `redactSensitive()` — que ya existe y ya está probada en `lib/logger.js` — a
`event.exception`, `event.extra`, `event.contexts` y `event.breadcrumbs` mediante un `beforeSend`, en
`backend/src/lib/sentry.js` y `frontend/src/lib/sentry.js`. Fijar `sendDefaultPii: false` explícito.
**Por qué importa:** un error de validación de Prisma incluye los valores del objeto en el mensaje.
Hoy eso sale íntegro hacia un servicio externo.
**Estimación:** 2 horas incluyendo prueba.

### 0.2 Cabecera HSTS
**Convierte:** 3.9 — cifrado en tránsito, de "TLS correcto pero degradable" a "TLS forzado".
**Qué:** `Strict-Transport-Security: max-age=31536000; includeSubDomains` en nginx.
**Ojo:** empezar con un `max-age` corto (300) un día, confirmar que nada se rompe, y subirlo. Un
HSTS largo mal puesto es difícil de revertir.
**Estimación:** 1 hora + un día de observación.

### 0.3 Cabeceras de seguridad restantes
**Convierte:** 3.9 — de "sin cabeceras de seguridad" a lista completa.
**Qué:** `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` y una CSP básica.
Ya tenemos `X-Frame-Options` desde el trabajo del showcase. Ponerlas en `next.config.js` junto a las
existentes, no en nginx, para que vivan con el código.
**Estimación:** 3 horas, la CSP es la que da trabajo.

### 0.4 Cifrar las copias de seguridad antes de subirlas
**Convierte:** 3.2 y 3.9 — de "confiamos en el proveedor" a "cifradas por nosotros".
**Qué:** en `ops/backup.sh`, cifrar el volcado antes del `s3 cp`. Clave fuera del droplet.
**Crítico:** documentar y **probar la restauración** el mismo día. Una copia cifrada que no sabes
descifrar es peor que ninguna.
**Estimación:** 4 horas incluyendo una restauración de prueba.

### 0.5 El borrado de administrador deja de mentir
**Convierte:** 3.12 — de "falla en silencio con un mensaje falso" a un error honesto.
**Qué:** en `customers.routes.js`, el `catch` devuelve 404 "Customer not found" para *cualquier*
excepción. Distinguir el fallo de clave foránea y devolver un 409 que explique que el cliente tiene
reservas y hay que usar la anonimización.
**Nota:** es un parche, no la solución. La solución es 2.1. Pero mientras tanto deja de engañar a
quien intenta atender una solicitud de borrado.
**Estimación:** 1 hora.

### 0.6 Quitar el ejemplo de tarjeta de la documentación de la API
**Convierte:** 3.8 — elimina el peor artefacto del repositorio para un evaluador PCI.
**Qué:** `backend/src/docs/openapi.js` publica un esquema `CardOnFilePayload` con un número de
tarjeta y un CVV de ejemplo, para un endpoint que **no existe y nunca aceptó eso**. Borrarlo y
apuntar las dos rutas que lo referencian al esquema real.
**Estimación:** 1 hora.

---

## Ola 1 — Seguridad de acceso (~4 días)

### 1.1 Doble factor para SUPER_ADMIN y ADMIN
**Convierte:** 3.3 — de **"no"** a **"sí"**. Es el control que un cuestionario británico da por
supuesto y el que más pesa de todos.
**Qué:** TOTP. Campos en el modelo de usuario (secreto cifrado, activado, códigos de respaldo),
inscripción con QR, verificación en el login, y obligatorio por rol. Códigos de respaldo de un solo
uso, hasheados.
**Decisión que necesito de ti:** ¿obligatorio para ADMIN desde el día uno, o periodo de gracia? Con
Rent & Go y Corpusa en producción, imponerlo de golpe genera llamadas.
**Estimación:** 2 días.

### 1.2 Cierre de sesión y revocación de token
**Convierte:** 3.3 y 3.9 — hoy un token robado vive 12 horas y no hay forma de matarlo salvo
desactivar la cuenta entera.
**Qué:** extender el contador `tokenVersion` — que ya existe pero solo se comprueba para cuentas de
servicio — a usuarios humanos, y añadir el endpoint de cierre de sesión.
**Estimación:** 4 horas.

### 1.3 Activar el cortafuegos del droplet
**Convierte:** 3.9 — defensa en profundidad detrás del arreglo de puertos de hoy.
**Qué:** `ufw` permitiendo solo 22, 80 y 443. **Permitir el 22 antes de activarlo** o te quedas
fuera del servidor.
**Alternativa más segura:** cortafuegos en la nube de DigitalOcean desde el panel, que no puede
dejarte fuera por un error de orden.
**Estimación:** 1 hora. Recomiendo la alternativa.

### 1.4 Limitador de login compartido entre procesos
**Convierte:** 3.9 — el límite real hoy es ~20/min por IP, no 5, porque cada uno de los 4 workers
lleva su propio contador en memoria y se reinicia en cada despliegue.
**Qué:** mover el contador a Redis, que ya se usa para el limitador por tenant.
**Estimación:** 3 horas.

### 1.5 El QR de inspección de Corpusa
**Convierte:** no es una pregunta del cuestionario — es una exposición viva de datos de clientes.
**Qué:** la firma del QR es un HMAC estático sobre el ID del vehículo, sin caducidad, impreso en una
pegatina. Devuelve el nombre del cliente que tiene el carro ahora y emite un token de 24 h para
crear reportes de daño. Arreglo: nonce por reserva emitido en el check-out, que caduca en la
devolución; montar el router tras el guard de tasa por IP; separar el secreto de `JWT_SECRET`.
**Sigo esperando tu decisión:** ¿lo apago hoy y lo arreglo, o lo arreglo con él encendido?
**Estimación:** 1 día.

---

## Ola 2 — Derechos e retención (~8 días)

La ola más cara y la que más respuestas mueve. Son cinco preguntas del cuestionario que hoy se
contestan que no.

### 2.1 Servicio único de borrado
**Convierte:** 3.10 y 3.12 — de **"no podemos"** a **"sí, con un conjunto declarado de excepciones
por retención legal"**.
**Qué:** un solo `eraseCustomer(customerId)` que cubra todo lo que hoy se queda fuera:
- las copias desnormalizadas: contrato, conductores adicionales, conductores de reserva, acuerdos de
  cortesía, solicitudes, presupuestos;
- **todas** las imágenes de firma, que están en línea en Postgres;
- los documentos con imagen incrustada;
- `ExternalReservation.rawJson`, el payload verbatim del socio;
- **los archivos en el bucket**, llamando al borrado de almacenamiento — hoy solo se anulan los
  punteros y las imágenes de licencia quedan huérfanas para siempre;
- propagación al procesador de pagos para eliminar el perfil de tarjeta.

Y declarar explícitamente qué se conserva y por qué: contrato, registros contables y de daños.
La bandera de "no alquilar" que hoy se deja al borrar hay que declararla o eliminarla — es una lista
de supresión y no puede presentarse como borrado.
**Estimación:** 3 días. Es delicado: toca datos vivos y hay que probarlo contra una copia.

### 2.2 Exportación por interesado
**Convierte:** 3.12 — de **"no existe"** a **"sí, un fichero"**.
**Qué:** recorrer todas las tablas que contienen datos de una persona — hoy la consulta existente
omite pagos, peajes, multas, mensajes, fotos, firmas, incidentes y presupuestos — y producir un
paquete estructurado con los documentos incluidos.
**Truco de implementación:** derivar la lista de tablas del esquema en tiempo de compilación, con una
prueba que falle si aparece un modelo nuevo con `customerId` que no esté cubierto. Si no, esto se
queda obsoleto en tres meses.
**Estimación:** 2 días.

### 2.3 Calendario de retención implementado
**Convierte:** 3.10 — de **"indefinido en todo"** a una tabla con periodos reales.
**Qué:** campos de fecha de purga en el esquema, un barrido diario, y periodos por categoría.
**Bloqueo real:** los periodos son una decisión de negocio y legal, no técnica. Necesito de ti o del
abogado cuánto se conserva un contrato, un pago, una foto de daños y un registro. La máquina la
construyo en 2 días; los números no me los puedo inventar.
**Estimación:** 2 días de código, más tu decisión sobre los periodos.

### 2.4 Rotación y retención de logs
**Convierte:** 3.10 — hoy los logs van a la salida estándar de Docker sin rotación y crecen para
siempre en el disco del droplet.
**Qué:** bloque `logging:` con `max-size` y `max-file` en `docker-compose.prod.yml`.
**Extra:** la ruta que se registra incluye la query string, y las búsquedas llevan nombres y correos
como parámetros — así que hay PII en los logs de acceso pese al redactor, que actúa sobre el objeto y
no sobre la URL. Hay que redactar también la query string.
**Estimación:** 4 horas.

### 2.5 Restricción y portabilidad
**Convierte:** 3.12 — dos derechos que hoy no existen.
**Qué:** la portabilidad sale casi gratis de 2.2 si el formato es legible por máquina. La restricción
necesita una marca en el registro y que las consultas la respeten.
**Estimación:** 1 día.

---

## Ola 3 — Trazabilidad (~4 días)

### 3.1 Registro de auditoría de verdad
**Convierte:** 3.3 — de **"no podemos registrar accesos"** a **"sí"**.
**Qué:** el problema es estructural: la tabla de auditoría actual exige un ID de reserva como clave
foránea obligatoria, así que no puede registrar un login, un cambio de rol ni la lectura de un
cliente. Hace falta una tabla nueva, independiente de reserva, con actor, acción, objetivo, momento,
IP y contexto. Y su propia retención.
**Estimación:** 1,5 días.

### 3.2 Trazabilidad del impersonate
**Convierte:** 3.3 — el hueco que yo declararía aunque no lo preguntaran.
**Qué:** registrar cada suplantación en la tabla nueva, y **marcar el token** con quién suplanta,
para que las acciones posteriores no queden atribuidas al empleado del cliente. Es lo que hace que
el registro de un tenant sea creíble para ese tenant.
**Estimación:** 1 día.

### 3.3 Registro de accesos a datos personales
**Convierte:** 3.3 — "¿se registra quién accedió a qué dato personal?"
**Qué:** registrar las lecturas de ficha de cliente y las exportaciones. No todas las lecturas de
todo, que sería ruido inútil: la ficha de cliente, la descarga de documentos y los informes.
**Estimación:** 1 día.

### 3.4 Redactar la query string en los logs
Ya cubierto en 2.4.

---

## Ola 4 — Aseguramiento (~3 días + externo)

### 4.1 Escaneo de dependencias y secretos en CI
**Convierte:** 3.9 — de **"ninguno"** a **"sí, en cada cambio"**.
**Qué:** `npm audit` con umbral, Dependabot, y escaneo de secretos. El CI ya corre unas 26 suites; es
añadir pasos, no montar nada nuevo.
**Estimación:** 4 horas.

### 4.2 Análisis estático
**Convierte:** 3.9. CodeQL es gratis en repositorios de GitHub.
**Estimación:** 3 horas.

### 4.3 Escaneo de imágenes de contenedor
**Convierte:** 3.9. Trivy en el CI.
**Estimación:** 2 horas.

### 4.4 Prueba de restauración de copias documentada
**Convierte:** 3.9 — "prueba de restauración". Hoy no se hace con calendario.
**Qué:** un guion que restaure la copia de anoche en una base desechable y verifique conteos, más un
registro de cuándo se corrió. Trimestral.
**Estimación:** 1 día.

### 4.5 Pentest independiente
**Convierte:** 3.9 y la sección 4 — de **"nunca se ha hecho"** a un informe.
**Realidad:** es un proveedor externo, entre dos y seis semanas y varios miles de dólares. **Es el
único elemento del plan con plazo que no controlamos**, así que si lo quieres antes de contestar, hay
que contratarlo ya y trabajar el resto en paralelo.
**Alternativa intermedia:** un escaneo automatizado autenticado no es un pentest y no hay que
presentarlo como tal, pero es mejor que nada y cuesta días en vez de semanas.
**Decisión tuya.**

---

## Ola 5 — Documentos (~4 días)

Los redacto yo a partir de lo que el sistema hace de verdad, no de plantillas. Una política que no
describe el sistema real es peor que no tenerla, porque la primera repregunta la desmonta.

| Documento | Estado | Estimación |
|---|---|---|
| 5.1 Política de seguridad de la información | No existe | 1 día |
| 5.2 Calendario de retención | No existe — depende de los periodos de 2.3 | 0,5 día |
| 5.3 Procedimiento de brechas e incidentes | No existe. Incluye el contacto 24/7 y el compromiso de 24 h que proponemos | 1 día |
| 5.4 Lista de subprocesadores mantenible | Existe dentro del pliego; hay que sacarla como documento propio con proceso de cambio | 0,5 día |
| 5.5 Diagrama de flujo de datos | No existe. Sistemas, ubicaciones, subprocesadores, flujos de entrada y salida | 0,5 día |
| 5.6 Revisar la política de privacidad actual | Existe, hay que contrastarla con lo que el cuestionario exige | 0,5 día |

### Lo que recomiendo NO hacer

**ISO 27001 y SOC 2.** Meses y decenas de miles de dólares. Un socio británico los pide en el
formulario pero casi nunca los exige a un proveedor de este tamaño. La respuesta honesta —
"no los tenemos, aquí está nuestro conjunto de controles y nuestro plan" — con todo lo anterior ya
hecho detrás, se sostiene perfectamente. Si TL los convierte en condición, es una conversación
comercial, no un proyecto que arrancar por si acaso.

**Cifrado a nivel de campo de los datos personales.** Cifrar números de licencia, fechas de
nacimiento y firmas en columna rompe las búsquedas y los índices, y es una refactorización grande de
riesgo alto. La respuesta correcta es que el cifrado en reposo lo da la plataforma, que las
credenciales de integración sí van cifradas a nivel de campo, y que el control de acceso es la
defensa principal. Si TL insiste, se acota a los documentos de identidad y nada más.

---

## Ola 6 — Correcciones de la integración (~4 días)

No las pide el cuestionario, pero sin ellas la integración repite lo que TL sufrió con TSD.

| # | Qué | Por qué | Est. |
|---|---|---|---|
| 6.1 | Conciliación de cancelaciones | Si TL cancela, la reserva se queda viva y el vehículo bloqueado para siempre. Marcar lo ausente del barrido y **que decida una persona** | 1 día |
| 6.2 | Unicidad por tenant en `ExternalReservation` | Hoy dos tenants con el mismo socio colisionan en la misma fila. Migración sobre datos vivos | 0,5 día |
| 6.3 | Tiempos de espera en las llamadas de integración | No hay ninguno; una llamada colgada bloquea un worker | 0,5 día |
| 6.4 | Guardar una copia inmutable del contrato firmado | Hoy el PDF se regenera desde datos que cambian, así que no reproduce lo que el cliente firmó | 1 día |
| 6.5 | PDF del informe de incidentes | Solo existe impresión HTML; TL pide documentos | 0,5 día |
| 6.6 | Sello de verificación de identidad en mostrador | Solo existe en el kiosco | 0,5 día |

---

## Orden que propongo

1. **Ola 0 entera** — dos días, seis respuestas mejoradas. Empezar aquí.
2. **1.5 (QR de Corpusa)** en cuanto decidas, porque es exposición viva.
3. **Ola 2** — es la más larga y la que más pesa; arrancarla pronto aunque se solape.
4. **Ola 1 y 3** en paralelo con la 2.
5. **Ola 4** — el pentest se contrata al principio aunque llegue al final.
6. **Ola 5** al final, cuando las políticas puedan describir lo que ya existe de verdad.
7. **Ola 6** con el desarrollo de la integración, no antes.

**Camino crítico:** el pentest, si lo quieres, y los periodos de retención, que necesito de ti.

---

## Lo que necesito de ti para arrancar

1. **QR de Corpusa** — ¿apagar ya, o arreglar encendido?
2. **Doble factor** — ¿obligatorio para ADMIN desde el día uno o con periodo de gracia?
3. **Periodos de retención** — cuánto se conserva un contrato, un pago, una foto de daños, un
   registro de sistema. Es lo único de la ola 2 que no puedo construir sin ti.
4. **Pentest** — ¿lo contratamos, o contestamos que no tenemos y presentamos el plan?
5. Lo que sigue pendiente del pliego: entidad legal, tres contactos, evidencia PCI.
