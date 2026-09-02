# Manejo y Protección de Información — Ride Fleet Manager

**Para:** Rent & Go by VPH Motors
**De:** Ride Car Sharing LLC
**Fecha:** 26 de agosto de 2026

---

Estimados:

A continuación les detallamos cómo Ride Fleet Manager protege la información de su empresa, la de sus clientes y la de sus reservas, y quién puede acceder a ella.

---

## 1. La información es de ustedes

Los datos que ustedes y sus clientes ingresan en la plataforma —reservas, contratos, información de clientes, flota, tarifas y reportes— **son propiedad de Rent & Go by VPH Motors**. Ride Car Sharing LLC los procesa únicamente para prestarles el servicio.

No vendemos, alquilamos ni compartimos su información con terceros con fines comerciales, y no la usamos para fines ajenos a la operación de la plataforma.

## 2. Separación entre clientes de la plataforma

Ride Fleet Manager es una plataforma multi-empresa: varias empresas de renta operan sobre la misma infraestructura. **Ninguna de ellas puede ver la información de otra.**

Esa separación no depende de que alguien recuerde aplicarla. Está construida en tres capas:

- **En la aplicación:** cada consulta a la base de datos se filtra automáticamente por la empresa del usuario que la hace. Un usuario de otra empresa que solicite una reserva de ustedes recibe un rechazo, no un resultado.
- **En la base de datos:** las tablas tienen políticas de seguridad a nivel de fila (*Row Level Security*) activadas, como segunda barrera independiente de la aplicación.
- **En las pruebas automatizadas:** mantenemos una batería de pruebas dedicadas específicamente a verificar este aislamiento. Se ejecutan antes de cada cambio que sale a producción; si un cambio rompiera la separación entre empresas, no llega a instalarse.

Adicionalmente, dentro de su propia empresa la información puede restringirse **por sede**, de modo que un empleado asignado a una localidad vea solo la operación de esa localidad.

## 3. Quién tiene acceso a su información

**Ustedes.** Los usuarios que ustedes creen, con los permisos que ustedes les asignen. Ustedes controlan quién entra, con qué rol y a qué sedes.

**Nuestro equipo técnico.** Un grupo reducido de personal técnico de Ride tiene acceso administrativo a la plataforma. Ese acceso existe para darles soporte: diagnosticar un problema que reporten, corregir una configuración, o investigar una falla.

Queremos ser explícitos en esto en vez de dejarlo implícito: **ese acceso existe y es real.** Está sujeto a los mismos controles que el resto —autenticación de dos factores obligatoria y registro de auditoría— y se usa para atender su operación, nunca con fines comerciales ni para compartir su información con nadie.

**Nadie más.** Ni otras empresas de renta de la plataforma, ni terceros.

Los proveedores de infraestructura que utilizamos (alojamiento, base de datos, procesamiento de pagos, correo) procesan datos únicamente como parte de su servicio, bajo sus propios contratos y controles.

## 4. Cifrado

- **En tránsito:** toda comunicación entre los navegadores de su personal, los teléfonos de sus clientes y nuestros servidores viaja cifrada mediante HTTPS/TLS.
- **En reposo:** la base de datos y los respaldos están cifrados en almacenamiento.
- **A nivel de campo:** además de lo anterior, los datos personales más sensibles —**número de licencia de conducir, dirección, fecha de nacimiento y las imágenes de firmas**— se cifran individualmente dentro de la base de datos con AES-256-GCM. Esto significa que aun con acceso directo al almacenamiento, esos campos no son legibles sin la llave, que se administra por separado.
- **Credenciales de integraciones:** las llaves de sus servicios conectados (pasarela de pago, telemática y otros) se guardan cifradas y nunca se devuelven en pantalla una vez guardadas.

## 5. Control de acceso

- **Autenticación de dos factores obligatoria** para todo el personal con acceso a la plataforma, en todos los roles.
- **Permisos por rol**: cada usuario ve y hace únicamente lo que su rol permite.
- **Restricción por sede**, cuando ustedes decidan aplicarla.
- **Revocación de sesión**: al cerrar sesión o desactivar un usuario, sus accesos quedan invalidados de inmediato.
- **Límites de intentos** en los puntos de acceso públicos, para frenar ataques automatizados.

## 6. Datos de tarjetas de crédito

**Ride Fleet Manager no almacena números de tarjeta.** Todo el procesamiento de pagos se delega a procesadores certificados; en nuestra base de datos quedan únicamente referencias (marca de la tarjeta, últimos cuatro dígitos y un identificador del procesador) que por sí solas no permiten realizar un cobro fuera de la plataforma.

Ride Car Sharing LLC está **certificada PCI DSS, cuestionario SAQ C, versión 4.0.1**, validada por SecurityMetrics con fecha 10 de junio de 2026. El certificado de cumplimiento está disponible si su equipo o su auditor lo solicitan.

## 7. Ubicación de los datos

Toda la información se almacena y procesa **en Estados Unidos**. Es una decisión deliberada de arquitectura y la aplicamos también al escoger proveedores auxiliares, incluidos los de monitoreo y registro.

## 8. Registro de auditoría

La plataforma mantiene un registro de auditoría de las acciones relevantes: quién hizo qué y cuándo. Esto aplica tanto a su personal como al nuestro. El registro se preserva de forma independiente de los datos operativos, de modo que la actividad quede documentada aunque un registro operativo cambie después.

## 9. Derechos sobre los datos y retención

La plataforma incluye funciones para **exportar** la información de un cliente y para **eliminarla** cuando corresponda atender una solicitud de ese tipo, respetando los períodos de retención que la ley exige conservar para efectos contables y fiscales.

Si en algún momento terminan su relación con nosotros, su información puede exportarse; no la retenemos como mecanismo de retención comercial.

## 10. Seguridad en el desarrollo y la operación

- **Revisión automática de secretos** en cada cambio de código, para impedir que una credencial llegue al repositorio.
- **Escaneo de vulnerabilidades** sobre las imágenes que se despliegan.
- **Pruebas de seguridad de aplicación** ejecutadas contra la plataforma autenticada.
- **Despliegues sin interrupción**, con capacidad de revertir un cambio que resulte problemático.
- **Respaldos** de la base de datos, cifrados.
- **Batería de pruebas automatizadas** que se ejecuta antes de cada despliegue, incluyendo las pruebas de aislamiento entre empresas mencionadas en la sección 2.

---

## Contacto

Si su equipo, su asegurador o un auditor necesitan detalle adicional, documentación de cumplimiento, o quieren coordinar una revisión, con gusto lo atendemos.

**Ride Car Sharing LLC**
[nombre y puesto]
[correo] · [teléfono]

---

*Este documento describe los controles vigentes al 26 de agosto de 2026. Los controles evolucionan; ante cualquier duda sobre el estado actual, contáctennos.*
