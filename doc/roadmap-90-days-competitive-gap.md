# Roadmap 90 Dias - Competitive Gap Plan

Fecha base: 2026-03-17

## Objetivo
Cerrar las brechas mas importantes entre el producto actual y plataformas como TSD, HQ Rental Software, Rent Centric y RentALL, sin perder foco en el negocio principal de rental operations.

## Estado Actual Resumido
- Fortaleza actual: reservas, rental agreements, inspecciones, portal publico de firma/pago, configuracion por tenant/location, auditoria, fees/rates/depositos.
- Debilidades principales: reportes reales, portal cliente completo, operaciones moviles, integraciones externas, telematics, delivery/collection, y exceso de logica almacenada en `notes`.

## Matriz De Gap
| Area | Estado actual | Competencia mas fuerte | Prioridad |
|---|---|---|---|
| Reporting y exportacion | Modulo placeholder | HQ | Alta |
| Portal cliente / self service | Firma y pago bien; pre-check-in incompleto | HQ, Rent Centric | Alta |
| Operaciones moviles | Web operativa, no app/PWA madura | Rent Centric, HQ | Alta |
| Integraciones / webhooks / API | Parcial | HQ, Rent Centric, TSD | Alta |
| Datos estructurados vs `notes` | Mucha metadata embebida | Todos los maduros | Alta |
| Delivery / collection | No dedicado | TSD, Rent Centric | Media-alta |
| Telematics / connected fleet | No visible hoy | HQ, TSD | Media-alta |
| Pricing avanzado | Reglas base si; optimization no | HQ | Media |
| Customer messaging / inbox | Email templates si; portal conversacional no | RentALL | Media |
| Verificacion documental / seguro | Base parcial | TSD, Rent Centric, RentALL | Media |

## Principios Del Roadmap
1. Primero cerrar producto vendible.
2. Luego automatizar integraciones y movilidad.
3. No agregar features grandes encima de metadata escondida en `notes`.
4. Medir exito con KPIs de operacion, no solo con features entregadas.

## Dias 1-30
### Objetivo
Convertir el sistema en una plataforma mas cerrada y vendible para operaciones diarias.

### Entregables
- Reportes v1:
  - Utilizacion de flota
  - Revenue por vehiculo / dia
  - No-shows
  - Agreements abiertos/cerrados
  - Depositos capturados / liberados
  - Export CSV basico
- Portal cliente v1 completo:
  - Pre-check-in real
  - Actualizacion de datos del cliente
  - Upload de licencia / ID / seguro
  - Confirmacion de datos antes de llegada
- Timeline operacional unificado por reservacion:
  - pagos
  - firma
  - inspecciones
  - cambios de estado
  - overrides
- Definicion tecnica para reemplazar metadata en `notes` por modelos/tablas reales:
  - charges meta
  - deposit meta
  - additional drivers
  - inspection snapshots
  - payment events

### Cambios de arquitectura sugeridos
- Crear modelos persistentes para eventos y metadata operativa.
- Diseñar una capa de reporting que lea datos estructurados, no parsing de texto.
- Dejar `notes` solo para observaciones humanas.

### KPI de salida
- 5 reportes operativos disponibles y exportables.
- 80% del pre-check-in puede completarse sin llamada del staff.
- 0 nuevas funcionalidades criticas guardadas en `notes`.

## Dias 31-60
### Objetivo
Extender el sistema a operaciones de campo y automatizacion externa.

### Entregables
- PWA / mobile ops v1 para staff:
  - checkout/checkin
  - captura de firma
  - captura de fotos
  - lectura/captura de licencia
  - cobro basico en campo
- Delivery / collection v1:
  - agenda de entregas
  - agenda de recogidas
  - ventanas horarias
  - capacidad por location / agente
  - checklist de handoff
- Webhooks/API v1:
  - customer created/updated
  - reservation created/updated
  - agreement finalized/closed
  - payment posted/refunded
- Integraciones iniciales:
  - CRM/email automation
  - accounting export
  - insurance verification adapter contract

### Cambios de arquitectura sugeridos
- Crear capa de eventos de dominio con payload estable.
- Exponer webhooks firmados y logs de entrega.
- Separar adapters externos por proveedor.

### KPI de salida
- 1 flujo de checkout o checkin completado desde dispositivo movil.
- 4 eventos de negocio disponibles via webhook.
- 1 integracion externa piloto funcionando.

## Dias 61-90
### Objetivo
Agregar capacidades diferenciales de mercado y preparar posicionamiento comercial.

### Entregables
- Telematics foundation:
  - vehicle telemetry adapter interface
  - odometer/fuel sync
  - trip history ingestion
  - geofence alert model
- Pricing v2:
  - reglas por ocupacion
  - reglas por lead time
  - reglas por temporada
  - reglas por branch/location
- Customer experience v2:
  - portal con historial de transacciones
  - recibos descargables
  - recordatorios automatizados
  - SMS/WhatsApp trigger design
- Compliance v2:
  - MFA real para usuarios internos
  - workflow de verificacion documental
  - enforcement configurable para seguro/licencia antes de checkout

### Cambios de arquitectura sugeridos
- Incorporar job runner/queue para sincronizaciones externas y notificaciones.
- Crear esquema de feature flags por tenant/plan.
- Preparar package comercial por tiers: Core, Pro, Enterprise.

### KPI de salida
- 1 adapter de telematics funcionando en ambiente beta.
- Pricing rule engine aplicado a nuevas reservas.
- 25% menos intervencion manual en onboarding y checkout.

## Orden Recomendado Por Impacto
1. Reporting y datos estructurados
2. Pre-check-in real y portal cliente
3. PWA/mobile ops
4. Webhooks + API + integraciones
5. Delivery/collection
6. Telematics
7. Pricing avanzado
8. Messaging/comms avanzadas

## Riesgos A Vigilar
- Seguir agregando logica en `notes` y romper reporting futuro.
- Meter telematics antes de estabilizar modelos/eventos.
- Lanzar mobile sin resolver auth, sync y permisos.
- Intentar competir con todos a la vez en vez de dominar un nicho.

## Posicionamiento Recomendado
- Frente a HQ: competir primero en flexibilidad multi-tenant y velocidad de customizacion.
- Frente a TSD: competir en UX moderna y configuracion rapida, no de entrada en todo el ecosistema enterprise.
- Frente a Rent Centric: acercarte con mobile ops, contactless y webhooks.
- Frente a RentALL: tomar ideas de UX cliente, messaging e identidad, no necesariamente su enfoque marketplace.

## Fuentes De Referencia
- HQ Pricing: https://hqrentalsoftware.com/pricing/
- HQ Telematics: https://hqrentalsoftware.com/telematics/
- Rent Centric Mobile App: https://www.rentcentric.com/products/why-rent-centric/mobile-app/
- Rent Centric Web Hooks: https://www.rentcentric.com/products/technology-add-ons/web-hooks/
- Rent Centric Smart Key / Lock Box: https://www.rentcentric.com/products/technology-add-ons/smart-car-rental-key-management-system/
- TSD Axle Insurance Verification: https://content.tsdweb.com/prod/help/cirro/hyundai/Content/Definitions/Require%20Axle%20Insurance%20Verification.htm
- TSD Key Reader Implementation: https://content.tsdweb.com/prod/help/cirro/bmw/Content/PDFs/KAI%20Key%20Reader%20Implementation.pdf
- RentALL Release Notes / Product Page: https://www.rentallscript.com/vacation-rental-script/
