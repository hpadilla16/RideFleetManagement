# Sprints Semanales - Roadmap 90 Dias

Fecha base: 2026-03-17

## Objetivo
Traducir el roadmap de 90 dias en sprints semanales ejecutables, con foco en cerrar brechas frente a TSD, HQ Rental Software, Rent Centric y RentALL sin perder estabilidad del core operativo.

## Regla De Prioridad
1. Primero datos estructurados y reporting.
2. Luego portal cliente completo.
3. Luego operaciones moviles.
4. Despues integraciones y automatizacion.
5. Finalmente diferenciadores como telematics y pricing avanzado.

## Sprint 1
### Objetivo
Definir la base tecnica para dejar de depender de metadata embebida en `notes`.

### Entregables
- Inventario completo de bloques `[META]` actuales.
- Mapa de migracion a tablas/modelos reales.
- Decision de ownership por modulo:
  - charges
  - deposits
  - additional drivers
  - inspections
  - payment events
- KPIs y consultas clave que luego alimentaran reportes.

### Resultado esperado
Arquitectura aprobada para que los siguientes sprints no sigan construyendo sobre deuda estructural.

## Sprint 2
### Objetivo
Implementar la primera capa de datos estructurados.

### Entregables
- Modelo estructurado para charges y payment events.
- Modelo estructurado para inspection snapshots.
- Lectura dual temporal: nuevo modelo + compatibilidad legacy.
- Seeds o scripts de backfill para datos recientes.

### Resultado esperado
La app sigue funcionando, pero el reporting ya puede empezar a leer desde datos reales.

## Sprint 3
### Objetivo
Lanzar reportes operativos v1.

### Entregables
- Reporte de utilizacion.
- Reporte de revenue por vehiculo / dia.
- Reporte de no-shows.
- Reporte de agreements abiertos/cerrados.
- Export CSV basico.

### Resultado esperado
El modulo [reports/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/reports/page.js) deja de ser placeholder y pasa a aportar valor de negocio.

## Sprint 4
### Objetivo
Cerrar pre-check-in cliente v1.

### Entregables
- Validacion server-side del token de pre-check-in.
- Formulario real de datos del cliente.
- Upload de licencia / ID / seguro.
- Confirmacion final antes de llegada.
- Registro de auditoria de cambios hechos por el cliente.

### Resultado esperado
El flujo [customer/precheckin/page.js](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/frontend/src/app/customer/precheckin/page.js) deja de ser informativo y se vuelve operativo.

## Sprint 5
### Objetivo
Fortalecer el portal cliente.

### Entregables
- Timeline del cliente:
  - firma
  - pagos
  - documentos
  - agreement
- Descarga de recibos y agreement firmado.
- Mejor feedback de estatus de pago.
- Mensajes y errores mas claros para self-service.

### Resultado esperado
La experiencia del cliente se acerca mas a HQ y Rent Centric en autoservicio.

## Sprint 6
### Objetivo
Preparar operaciones moviles v1.

### Entregables
- Definicion de alcance para PWA staff.
- Lista de pantallas minimas:
  - checkout
  - checkin
  - inspection
  - delivery
  - collection
- Validacion offline/poor network strategy.
- Reglas de permisos y seguridad movil.

### Resultado esperado
Se evita improvisar una app operativa sin base estable.

## Sprint 7
### Objetivo
Entregar PWA staff v1.

### Entregables
- Checkout movil.
- Checkin movil.
- Captura de firma y fotos optimizada para telefono.
- Captura de licencia en flujo operativo.
- UI simplificada para agentes en campo.

### Resultado esperado
El staff ya puede completar un flujo real en movilidad, alineandose mejor con Rent Centric.

## Sprint 8
### Objetivo
Abrir operaciones de delivery y collection.

### Entregables
- Agenda de entregas y recogidas.
- Ventanas horarias.
- Capacidad por agente/location.
- Checklist de handoff.
- Estado operacional del servicio.

### Resultado esperado
Se cubre un hueco donde TSD y Rent Centric suelen verse mas maduros.

## Sprint 9
### Objetivo
Iniciar la base real de mobile app e internal store testing.

### Entregables
- app shell movil compartido
- continuidad de sesion y contexto por surface
- manifest / installability base
- internal wrapper path definido
- `TestFlight internal`
- `Google Play internal testing`

### Resultado esperado
La plataforma deja de ser solo mobile web pulido y pasa a una base real para app instalada y pruebas internas en stores.

## Sprint 10
### Objetivo
Endurecer la app y preparar public store readiness.

### Entregables
- notifications and reminders
- media / upload polish
- device QA
- privacy and support assets
- App Store / Google Play readiness checklist

### Resultado esperado
Queda lista la base para submission publica mas segura en el siguiente paso.

## Sprint 11
### Objetivo
Agregar pricing y operaciones inteligentes v2.

### Entregables
- Reglas por ocupacion.
- Reglas por lead time.
- Reglas por temporada.
- Reglas por location/branch.
- Simulador interno de pricing para validar impacto.

### Resultado esperado
El pricing deja de ser solo tabla de tarifas y pasa a ser una palanca comercial.

## Sprint 12
### Objetivo
Preparar diferenciadores de siguiente fase.

### Entregables
- Interface/adapters para telematics.
- Modelo de geofence/trip/odometer/fuel sync.
- MFA real para usuarios internos.
- Plan comercial por tiers:
  - Core
  - Pro
  - Enterprise
- Documento de readiness para beta extendida o ventas.

### Resultado esperado
Queda lista la base para una segunda fase mas enterprise.

## Actualizacion 2026-03-19

Despues de avanzar `Reports`, `Pre-check-in`, `Portal Cliente` y el primer build de `Car Sharing`, el plan de siguientes sprints debe incorporar una estrategia de plataformas y apps.

### Nuevo principio

No construir apps separadas con logica duplicada.

Construir:

- un `booking engine` compartido
- una `operations layer` compartida
- varias superficies cliente encima:
  - web booking
  - guest app
  - host app
  - employee app

### Booking System Requerido

El sistema debe permitir reservas desde:

- sitio web
- futura app de guest

Y debe cubrir:

- `rental reservations`
- `car sharing trips`

### Sprints Siguientes Recomendados

#### Sprint 6

- cerrar `car sharing internal MVP`
- definir contrato del `booking engine`
- comenzar el pase fuerte de UX/responsive para desktop, tablet y phone

#### Sprint 7

- public booking web foundation
- quote/search foundation para rental y car sharing

#### Sprint 8

- guest booking experience v1
- timeline y continuidad entre booking, pago, firma y documentos

#### Sprint 9

- host app foundation
- login host, listing management, availability, trip queue, earnings summary

#### Sprint 10

- employee app foundation para rental tradicional
- reservation creation, pre-check-in review, checkout/checkin, inspections, pagos

#### Sprint 11

- cancellations/modifications
- reminders/notifications
- host trip actions
- delivery/collection mobile ops

## Actualizacion 2026-03-23

Despues del cierre practico de `Sprint 7`, la plataforma ya tiene una base mucho mas fuerte en:

- booking web
- guest app
- host app
- employee app
- dealership loaner
- issue/dispute center
- host reviews and trust

La siguiente brecha competitiva principal ya no es el backend core.

La siguiente brecha principal es:

- mobile execution
- listing quality
- trust signals
- communication polish
- day-to-day usability para guest y host

### Ajuste recomendado para Sprint 8

`Sprint 8` debe priorizar:

1. `guest app` depth y polish
2. `host app` depth y polish
3. `employee app` compact operations polish
4. `marketplace trust`:
   - host ratings
   - reviews
   - richer listing presentation
   - better image and add-on presentation
5. `notifications and comms` cleanup

### Resultado esperado de Sprint 8

Un demo donde:

- el guest reserva y gestiona el trip desde phone
- el host administra listing, pricing, disponibilidad, issues y reputacion desde phone
- el employee opera rental, loaner y disputes desde un hub compacto

#### Sprint 12

- polish final:
  - responsive UX pass
- PWA readiness
- analytics/conversion tracking
- launch readiness

## Actualizacion 2026-03-20

Despues de cerrar `Sprint 6` en `main`, el orden de trabajo cambia para reflejar el avance real del producto y la oportunidad comercial mas fuerte siguiente.

### Estado Real Cerrado

`Sprint 6` ya dejo operativo:

- `booking engine` compartido
- `/book` para `rental` y `car sharing`
- `/book/confirmation`
- resume flow por referencia + email
- `guest app` foundation
- `host app` foundation
- flujo guiado de `pre-check-in -> signature -> payment`

### Nuevo Orden Recomendado

#### Sprint 7

Objetivo:

- lanzar `guest app` y `host app` a una segunda capa mas fuerte
- lanzar `employee app foundation`
- comenzar `dealership loaner program foundation`
- preparar material de demo / presentacion comercial

Entregables:

- `guest app` con continuidad mejorada, estados y acciones mas claras
- `host app` con mejor trip queue, disponibilidad y acciones
- `employee app` mobile-first shell
- reservation lookup/create para staff
- `pre-check-in review`, `checkout`, `check-in`, `inspections`, `payments`
- modelo base de `dealership loaner`:
  - `service appointment / RO`
  - `courtesy vs paid rental`
  - `insurance verification`
  - `liability acceptance`
- deck/demo outline y matriz de capacidades

Resultado esperado:

- guest, host y employee avanzan juntos en el mismo sprint
- un empleado puede completar un flujo operativo real desde telefono o tablet
- el producto ya puede demostrarse como:
  - rental
  - car sharing
  - dealership loaner
  - one platform

#### Sprint 8

Objetivo:

- ir mas a profundidad con `guest app`
- ir mas a profundidad con `host app`
- profundizar tambien `employee app`
- extender `dealership loaner workflow v1`

Entregables:

- `guest app` con continuidad y wallet de documentos
- `host app` con disponibilidad, earnings y trip inbox mas fuerte
- `employee app` con acciones mas rapidas y mejor operacion movil
- `dealership loaner` con flujo de service lane y courtesy contract

Resultado esperado:

- `guest` y `host` ya se sienten como apps reales
- el `loaner program` se puede demoear end-to-end en contexto de dealership

### Referencia Nueva

- [platform-app-roadmap-2026-03-19.md](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/doc/platform-app-roadmap-2026-03-19.md)
- [sprint-8-closeout-and-sprint-9-mobile-plan-2026-03-24.md](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/doc/sprint-8-closeout-and-sprint-9-mobile-plan-2026-03-24.md)

## Actualizacion 2026-03-24

Despues del trabajo acumulado en `Sprint 8`, el siguiente salto ya no debe ser mas polish web aislado.

El siguiente salto correcto es:

- mobile app foundation
- internal device builds
- internal store testing

### Estado Real Al Cierre De Sprint 8

Ya existen y fueron profundizados:

- `public booking web`
- `guest account`
- `customer portal`
- `host account`
- `employee app`
- `issue center`
- `dealership loaner`
- `marketplace trust surfaces`

### Nuevo Orden Recomendado

#### Sprint 9

- mobile app foundation
- guest / host / employee app shell
- session persistence
- internal builds on device
- `TestFlight internal`
- `Google Play internal testing`

#### Sprint 10

- app hardening
- notifications and reminders
- media / upload polish
- QA on devices
- App Store and Google Play submission readiness

#### Sprint 11

- public website and marketplace polish
- stronger listing pages
- host landing and trust marketing pages
- dealership loaner demo and commercial surfaces

#### Sprint 12

- messaging / communication layer
- trust and account hardening
- post-store feedback iteration

## Dependencias Criticas
- No arrancar telematics antes de cerrar eventos y modelos estructurados.
- No lanzar PWA operativa antes de estabilizar auth/permisos/flujo.
- No construir reporting serio sobre parsing de `notes`.
- No abrir integraciones externas antes de definir payloads estables.

## KPIs Del Programa
- Reduccion de trabajo manual en pre-check-in.
- Tiempo promedio de checkout/checkin.
- Utilizacion de flota visible por branch.
- Porcentaje de pagos y documentos completados antes de llegada.
- Numero de acciones operativas ejecutadas desde movil.
- Numero de eventos expuestos via webhook.

## Cadencia Recomendada
- Lunes: refinamiento y cierre de alcance.
- Martes a jueves: implementacion.
- Viernes: smoke test, demo interna y decision go/no-go.

## Sugerencia De Agrupacion De Equipo
- Backend/data
- Frontend/portal
- Ops/mobile
- Integrations/reporting

## Referencias
- Roadmap base: [roadmap-90-days-competitive-gap.md](/c:/Users/silve/.openclaw/workspace/RideFleetManagement-working-clean/doc/roadmap-90-days-competitive-gap.md)
