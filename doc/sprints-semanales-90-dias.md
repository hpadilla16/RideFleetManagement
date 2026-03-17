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
Crear la base de integraciones externas.

### Entregables
- Event bus o capa de domain events.
- Webhooks firmados v1.
- Registro de intentos y estado de entrega.
- Payloads estables para:
  - reservation created/updated
  - agreement finalized/closed
  - payment posted/refunded

### Resultado esperado
El producto deja de estar cerrado sobre si mismo y se vuelve integrable.

## Sprint 10
### Objetivo
Entregar primeras integraciones de negocio.

### Entregables
- Export contable o adaptador inicial.
- Integracion de automation/email/CRM.
- Contrato tecnico para insurance verification provider.
- Configuracion por tenant para integraciones.

### Resultado esperado
Se empieza a competir mejor con HQ, TSD y Rent Centric en ecosistema.

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
