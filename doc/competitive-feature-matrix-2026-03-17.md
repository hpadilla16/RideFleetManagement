# Competitive Feature Matrix - 2026-03-17

Fecha base: 2026-03-17

## Objetivo
Traducir la comparacion contra TSD, Rent Centric, RentALL y HQ Rental Software en una matriz accionable para roadmap y sprints.

## Lectura General
Hoy Ride Fleet compite bien en:
- core rental ops
- multi-tenant
- portal de firma/pago
- inspecciones
- pricing/pagos estructurados
- configuracion por tenant/location

Hoy Ride Fleet queda por detras en:
- reporting real
- pre-check-in operativo
- mobile ops
- integraciones/webhooks
- verificacion documental/seguro
- telematics
- delivery/collection
- customer portal avanzado

## Matriz

| Feature / Capability | Estado actual Ride Fleet | Competidor mas fuerte | Impacto | Esfuerzo | Sprint recomendado |
|---|---|---|---|---|---|
| Reportes operativos v1 | Placeholder | HQ | Alto | Medio | Sprint 3 |
| Pre-check-in real con upload de docs | Kickoff page, no operativo | Rent Centric / HQ | Alto | Medio | Sprint 4 |
| Customer timeline + receipts + agreement download | Parcial | HQ / RentALL | Alto | Medio | Sprint 5 |
| Mobile Agent PWA para checkout/checkin | No entregado | Rent Centric | Alto | Alto | Sprint 6-7 |
| Delivery & Collection ops | No dedicado | TSD / Rent Centric | Medio-Alto | Alto | Sprint 8 |
| Webhooks firmados + event layer | No visible como producto | Rent Centric / HQ | Alto | Medio | Sprint 9 |
| Integracion contable / automation / CRM | Parcial o no expuesta | HQ | Alto | Medio-Alto | Sprint 10 |
| Insurance verification | No operativo | TSD | Alto | Medio | Sprint 10 |
| License/document verification | No operativo | Rent Centric / RentALL | Alto | Medio | Sprint 10 |
| Rule-based dynamic pricing | Basico | HQ | Medio-Alto | Medio | Sprint 11 |
| Telematics adapters | No operativo | HQ / TSD / Rent Centric | Alto | Alto | Sprint 12 |
| MFA real interno | Parcial con lock PIN, no MFA completo | TSD / enterprise baseline | Medio | Medio | Sprint 12 |
| Car sharing marketplace / Turo competitor module | No entregado | Turo / RentALL style customer UX | Muy Alto | Muy Alto | Fase 2 despues de Sprint 8, discovery desde Sprint 5 |

## Oportunidades Donde Podemos Ser Mejores

### 1. Simplicidad operativa
Podemos ganar a TSD y HQ con:
- menos complejidad visual
- onboarding mas rapido
- mejor UX para equipos pequenos y medianos

### 2. API y webhooks modernos
Podemos ganar con:
- webhooks firmados
- payloads estables
- docs Swagger
- integraciones por tenant mas simples

### 3. Customer self-service mas limpio
Podemos ganar a muchos stacks tradicionales si hacemos:
- pre-check-in fluido
- timeline claro
- pagos y firma sin friccion
- app/PWA movil agradable

### 4. Car sharing como diferenciador
TSD y HQ son fuertes en rental ops clasico. Si extendemos bien hacia car sharing, podemos jugar en una categoria distinta y acercarnos a una experiencia tipo Turo sin perder el backoffice de fleet manager.

## Modulo Nuevo Recomendado: Car Sharing

## Vision
Agregar un modulo de car sharing que converse con Fleet Manager y permita competir con Turo usando la misma base de:
- fleet
- reservations
- pricing
- payments
- inspections
- agreements

## Capacidades Minimas Del Modulo

### Marketplace / customer app
- busqueda por ubicacion, fecha y tipo de vehiculo
- listing page por vehiculo
- checkout self-service
- perfil de conductor
- historial de viajes
- recibos
- reviews basicas

### Fleet manager / host ops
- publicar/despublicar vehiculos al marketplace
- reglas de disponibilidad separadas para rental vs car sharing
- pricing dedicado por hora/dia
- blackout dates
- reglas de pickup self-service
- damage workflow post-trip

### Trip operations
- pre-trip verification
- pickup/checkin self-service
- check-out/check-in con fotos
- kilometraje, fuel, tolls, cleaning, late return
- dispute/claim note trail

### Payments / payouts
- cobro al driver
- fee de plataforma
- payout interno al owner o branch
- ajustes post-trip

### Security / trust
- document verification
- license verification
- deposit hold
- risk flags

## Dependencias Para Lanzarlo Bien
- pre-check-in real
- mobile ops
- webhooks/event layer
- document verification
- telematics o smart key strategy minima

## Recomendacion
No meter car sharing completo dentro de Sprint 2.

Lo correcto es:
1. incluir discovery y arquitectura en los sprints medios
2. construir el backoffice reusable primero
3. lanzar marketplace/car-sharing despues de estabilizar:
   - reporting
   - pre-check-in
   - mobile ops
   - verification

## Fuentes Oficiales Usadas
- HQ pricing: https://hqrentalsoftware.com/pricing/
- HQ telematics: https://hqrentalsoftware.com/telematics/
- Rent Centric mobile app: https://www.rentcentric.com/products/why-rent-centric/mobile-app/
- Rent Centric webhooks: https://www.rentcentric.com/products/technology-add-ons/web-hooks/
- TSD insurance verification: https://content.tsdweb.com/prod/help/cirro/hyundai/Content/Definitions/Require%20Axle%20Insurance%20Verification.htm
- TSD delivery & collection: https://content.tsdweb.com/prod/help/cirro/base/Content/PDFs/Delivery%20and%20Collection%20Setup%20Guide%20%287_5_23%29.pdf
- TSD key reader: https://content.tsdweb.com/prod/help/cirro/bmw/Content/PDFs/KAI%20Key%20Reader%20Implementation.pdf
- RentALL vacation rental script: https://www.rentallscript.com/vacation-rental-script/
- RentALL car rental script: https://www.rentallscript.com/airbnb-clone-for-cars/
