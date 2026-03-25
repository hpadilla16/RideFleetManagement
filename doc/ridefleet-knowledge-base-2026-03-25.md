# Ride Fleet Knowledge Base

Fecha base: 2026-03-25

## Objetivo

Este documento sirve como base de conocimiento operativa para usar Ride Fleet
de punta a punta. Cubre:

- marketplace web y app
- rental workflow
- car sharing workflow
- dealership loaner workflow
- issues/disputes
- roles internos
- hosts
- guests
- tenant setup
- controles de acceso

## Que Es Ride Fleet

Ride Fleet es una plataforma multi-tenant para operar:

- renta tradicional
- car sharing tipo marketplace
- dealership loaner program
- customer portal y pre-check-in
- host portal
- employee ops
- issue/dispute center

Todo vive sobre una misma base operativa de:

- tenants
- customers
- reservations
- vehicles
- agreements
- inspections
- payments
- audit logs

## Roles Principales

### Super Admin

Puede:

- crear y editar tenants
- asignar admins
- activar o desactivar modulos por tenant
- controlar acceso por usuario
- configurar gateways de pago por tenant
- administrar settings globales y por tenant

### Tenant Admin

Puede:

- operar el tenant
- crear usuarios del tenant
- controlar modulos de los usuarios que creo
- configurar settings del tenant
- administrar operaciones, hosts, inventory y workflows

### Ops / Employee

Puede:

- crear reservas
- buscar clientes
- operar check-out y check-in
- revisar pre-check-in
- manejar loaners
- manejar casos desde Issue Center si tiene acceso

### Host

Puede:

- administrar sus listings de car sharing
- subir fotos
- configurar rates y add-ons de host
- enviar vehiculos para aprobacion
- revisar trips y readiness
- ver su rating y perfil publico

### Guest

Puede:

- crear cuenta guest
- hacer booking
- entrar con magic link
- ver reservas y trips
- completar pre-check-in
- firmar agreement
- pagar
- abrir issues

### Customer Service

Puede:

- revisar issues/disputes
- pedir mas informacion
- revisar historial del caso
- aprobar vehiculos de host
- cambiar status de tickets

## Conceptos Clave

### Tenant

Cada negocio o rooftop vive dentro de un tenant. Los settings, modulos, gateway
de pago, vehicle types y locations pueden variar por tenant.

### Reservation

Es el workflow base de operacion. Tanto renta tradicional como loaner viven
sobre reservaciones.

### Workflow Mode

Los modos principales son:

- `RENTAL`
- `CAR_SHARING`
- `DEALERSHIP_LOANER`

### Agreement

Es el acuerdo operativo/contractual del rental flow. Desde ahi salen:

- firma
- pagos
- inspecciones
- print/email

### Trip

En car sharing, el trip representa el journey del marketplace host/guest. Puede
estar enlazado a una reservacion/workflow interno.

### Module Access

El sistema ahora soporta acceso por:

- tenant
- usuario

Si un modulo esta apagado para el tenant o para el usuario, no debe aparecer ni
ser accesible.

## Modulos Principales

## 1. Marketplace / Book

Ruta:

- `/book`

Uso:

- el guest escoge pickup location publica
- busca inventario
- selecciona paquete
- completa guest details
- confirma booking

Caracteristicas importantes:

- no ensena tenant al cliente
- locations duplicadas se agrupan estilo marketplace
- muestra fotos de host o fallback por vehicle type
- en car sharing ya separa:
  - host service fee
  - mandatory guest trip fee

Flujo:

1. `Search`
2. `Select`
3. `Guest Details`
4. `Confirmation`

## 2. Guest App

Ruta:

- `/guest`

Uso:

- login con magic link
- ver `My Bookings`
- retomar booking o trip
- abrir pre-check-in
- firmar
- pagar
- abrir issues

Caracteristicas:

- guest sign-up
- guest sign-in
- welcome banner
- continuidad del ultimo booking
- wallet/documents
- timeline
- support center

Si el guest no tiene bookings:

- puede ir a `Browse Marketplace`

## 3. Customer Portal

Rutas:

- `/customer/precheckin`
- `/customer/sign-agreement`
- `/customer/pay`

Uso:

- completar customer info
- subir documentos
- firmar acuerdo
- pagar deposito o balance

Caracteristicas:

- snapshots mobile
- continuidad por token
- breakdown mas claro entre:
  - total estimado
  - due now
  - security deposit

## 4. Host App

Ruta:

- `/host`

Uso:

- administrar listings
- editar rates
- editar availability
- subir fotos del vehiculo
- enviar vehiculos a aprobacion
- manejar add-ons
- revisar trips y handoff readiness

Caracteristicas:

- welcome banner
- account snapshot
- public host profile link
- next handoff
- guest readiness lane
- draft persistence

## 5. Public Host Profile

Ruta:

- `/host-profile/:id`

Uso:

- ensenar rating del host antes del booking
- mostrar listings publicas
- mostrar reviews recientes

El rating del host viene de reviews enviadas por guests despues de completar
trips de car sharing.

## 6. Employee App

Ruta:

- `/employee`

Uso:

- hub operativo del staff
- quick create reservation
- search de clientes y workflows
- lanes para pickups, returns, loaners e issues

Caracteristicas:

- mobile shell
- priority board
- shift board
- contexto persistente

## 7. Reservations

Rutas:

- `/reservations`
- `/reservations/:id`

Uso:

- operar el ciclo de una reserva
- revisar customer, vehicle, pricing, status y audit logs
- iniciar rental workflow
- check-out
- check-in
- inspections
- payments

Submodulos:

- `/reservations/:id/checkout`
- `/reservations/:id/checkin`
- `/reservations/:id/inspection`
- `/reservations/:id/inspection-report`
- `/reservations/:id/inspection-compare`
- `/reservations/:id/payments`
- `/reservations/:id/additional-drivers`
- `/reservations/:id/ops-view`

## 8. Vehicles

Ruta:

- `/vehicles`

Uso:

- administrar inventario interno
- crear unidades
- importar unidades
- ver status operativos

Caracteristicas:

- fleet ops hub
- service risk
- on-rent view

## 9. Customers

Rutas:

- `/customers`
- `/customers/:id`

Uso:

- administrar customer records
- ver balances
- revisar docs y profile state
- reset de password cuando aplique

Caracteristicas:

- support hub
- holds
- docs missing
- email-ready indicators

## 10. Planner

Ruta:

- `/planner`

Uso:

- coordinar pickups, returns y units
- revisar asignaciones
- identificar unidades no asignadas

Caracteristicas:

- planner ops board
- focus filters

## 11. Issues / Disputes Center

Ruta:

- `/issues`

Uso:

- revisar tickets abiertos
- manejar disputes
- pedir mas informacion a host o guest
- cambiar status
- revisar historial
- aprobar vehicle submissions de hosts

Caracteristicas:

- issue history
- communications log
- priority board
- case handling
- vehicle approval review

Estados comunes:

- `OPEN`
- `UNDER_REVIEW`
- `RESOLVED`
- `CLOSED`

## 12. Public Issue Response

Ruta:

- `/issue-response?token=...`

Uso:

- host o guest responde a una solicitud del representante
- agrega nota
- sube documentos o evidencia

## 13. Car Sharing Control Center

Ruta:

- `/car-sharing`

Uso:

- ver hosts
- ver listings
- ver trips
- revisar instant book
- revisar atencion requerida

Caracteristicas:

- control center
- focus filters
- host economics
- guest total / host net / host fee / trip fee

## 14. Dealership Loaner

Ruta:

- `/loaner`

Uso:

- intake de loaner
- dashboard de service lane
- billing follow-up
- SLA alerts
- export y print de statements

Caracteristicas:

- borrower packet
- advisor ops
- billing control
- accounting closeout
- dealer invoice packet
- purchase order print
- monthly packet
- service lane priority board

## 15. Reports

Ruta:

- `/reports`

Uso:

- revisar overview financiero y operativo
- balances
- utilization
- services sold

## 16. Settings

Ruta:

- `/settings`

Uso:

- configurar el tenant activo

Secciones principales:

- agreement
- locations
- vehicle types
- rates
- additional services
- fees
- insurance plans
- email templates
- reservation options
- payment gateway
- access control

### Settings Tenant Scope

Cuando el usuario es `SUPER_ADMIN`, debe escoger el tenant antes de editar
configuracion. Esto afecta:

- locations
- vehicle types
- rates
- services
- insurance
- payment gateway
- tenant modules

## 17. Tenants

Ruta:

- `/tenants`

Uso:

- crear tenants
- activar modulos
- administrar tenant admins
- revisar portfolio

## 18. People

Ruta:

- `/people`

Uso:

- crear admins, ops, hosts y perfiles relacionados
- reassign tenant cuando haga falta
- definir modulos por usuario
- reset de password

Restricciones:

- `SUPER_ADMIN` puede ver mas ampliamente
- `ADMIN` de tenant solo maneja usuarios que creo

## Setup Inicial Recomendado Por Tenant

1. crear tenant
2. activar modulos correctos
3. crear tenant admin
4. configurar:
   - locations
   - vehicle types
   - rates
   - services
   - fees
   - insurance
   - payment gateway
5. crear usuarios internos
6. si aplica:
   - hosts
   - host profiles
   - host vehicle approvals

## Rental Workflow Estandar

1. crear reserva
2. enviar pre-check-in
3. customer completa customer info
4. customer firma agreement
5. customer paga
6. staff revisa readiness
7. check-out
8. durante el rental:
   - cambios
   - fees
   - support
9. check-in
10. inspeccion final
11. balance/finalizacion

## Car Sharing Workflow Estandar

1. host configura listing
2. host define fotos, rates y add-ons
3. guest hace booking desde marketplace
4. guest completa portal
5. trip se opera
6. si hay issue:
   - guest u host abre ticket
   - issue center lo maneja
7. al completar trip:
   - se envia review al guest
   - rating del host se actualiza

## Dealership Loaner Workflow Estandar

1. intake en `/loaner`
2. capturar:
   - RO
   - claim
   - advisor
   - service vehicle
   - billing mode
3. borrower packet
4. advisor ops
5. billing control
6. extender / swap / complete service si aplica
7. accounting closeout
8. imprimir:
   - handoff packet
   - billing summary
   - invoice packet
   - PO
   - monthly packet

## Host Vehicle Approval Workflow

1. host o super admin en support mode abre `/host`
2. `Add Vehicle To My Fleet`
3. subir:
   - 1-6 fotos
   - insurance
   - registration
   - initial inspection
4. submit para aprobacion
5. entra a `/issues`
6. customer service revisa:
   - checklist
   - docs
   - respuesta del host
7. puede:
   - pedir mas info
   - aprobar
8. al aprobar:
   - host recibe email
   - vehiculo se activa

## Payments

El sistema soporta gateway por tenant.

Desde `Settings > Payments`, `SUPER_ADMIN` puede definir por tenant:

- Authorize.Net
- Stripe
- Square

Tambien existe:

- `Run Health Check`

para validar si al tenant le faltan credenciales.

## Car Sharing Economics

Modelo actual:

- `host service fee`
- `guest mandatory trip fee`

La idea es que:

- el host vea su neto
- el guest vea su total con trip fee separado
- la plataforma capture revenue del host fee y del trip fee

## Control De Acceso

Hay dos capas:

- `tenant module access`
- `user module access`

Si un modulo esta apagado en cualquiera de las dos:

- no debe salir en navegacion
- no debe responder en backend

Esto aplica a modulos como:

- host app
- employee app
- issue center
- planner
- loaner
- car sharing
- settings
- reports

## Mobile App / Wrapper

Actualmente la app usa un wrapper movil sobre el runtime web.

Base actual:

- dominio principal: `ridefleetmanager.com`
- Android wrapper funcionando
- iOS/TestFlight pendiente para siguiente pase

El comportamiento movil ya soporta:

- shell compartido
- continuidad por modulo
- resume context
- install/app-like behavior

## Soporte y Troubleshooting

### Veo todo vacio despues de cambiar de dominio

Normalmente es:

- sesion nueva
- localStorage nuevo
- tenant scope reiniciado

No implica que la base se borro.

### Un host no ve vehicle types

Revisar:

- tenant assignment del host en `People`
- `Settings Tenant Scope`
- vehicle types configurados en ese tenant

### Un guest no puede completar booking

Revisar:

- pickup/return location
- insurance choice
- required guest details
- payment gateway del tenant

### Un ticket no avanza

Revisar:

- status del caso
- history
- communications
- si se pidio mas informacion y el publico respondio

### Un tenant no puede cobrar

Revisar:

- `Settings > Payments`
- gateway correcto
- health check
- credenciales faltantes

## Orden Recomendado Para Entrenamiento

### Para Super Admin

1. tenants
2. settings tenant scope
3. people
4. access control
5. payments
6. reports

### Para Tenant Admin

1. settings
2. people
3. vehicles
4. reservations
5. customers
6. planner
7. issues

### Para Ops / Employee

1. employee app
2. reservations
3. checkout/checkin
4. customers
5. issues
6. loaner

### Para Hosts

1. host app
2. my fleet vehicles
3. rates and listing
4. availability
5. host vehicle approval
6. host profile

### Para Guests

1. sign up / sign in
2. marketplace
3. my bookings
4. pre-check-in
5. sign agreement
6. payment
7. report issue

## Resumen Ejecutivo

Ride Fleet ya opera como una plataforma bastante completa para:

- rental
- car sharing
- dealership loaner
- customer service
- host operations
- employee operations
- tenant administration

La forma mas efectiva de usarla es verla como un sistema modular:

- el tenant activa capacidades
- el usuario recibe acceso segun su rol
- cada workflow corre sobre reservaciones, pagos, inspecciones, comunicaciones y
  audit trail

La base de conocimiento debe seguir creciendo a medida que el producto avance a:

- Android internal testing
- TestFlight
- store submission
- marketing website publica
