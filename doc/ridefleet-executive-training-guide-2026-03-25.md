# Ride Fleet Executive Training Guide

Fecha base: 2026-03-25

## Objetivo

Este manual ejecutivo resume como usar Ride Fleet sin entrar en detalle tecnico.
Esta pensado para:

- entrenamiento interno rapido
- onboarding de admins y ops
- demo guiada por rol
- repaso operativo antes de salir en vivo

## Que Es Ride Fleet

Ride Fleet es una plataforma para operar:

- rental tradicional
- car sharing tipo marketplace
- dealership loaner
- customer portal
- host portal
- employee operations
- issue and dispute handling

Todo corre sobre una sola base operativa:

- tenants
- customers
- reservations
- vehicles
- agreements
- inspections
- payments

## Roles Del Sistema

### Super Admin

Usa el sistema para:

- crear tenants
- activar modulos por tenant
- controlar acceso por usuario
- configurar payment gateway por tenant
- supervisar la operacion general

### Tenant Admin

Usa el sistema para:

- configurar locations, vehicle types, rates y servicios
- crear usuarios de su tenant
- revisar operaciones y reportes

### Employee / Ops

Usa el sistema para:

- crear y manejar reservas
- revisar pre-check-in
- hacer check-out y check-in
- manejar loaners
- atender issues si tiene acceso

### Host

Usa el sistema para:

- administrar listings
- subir fotos
- editar rates y availability
- enviar vehiculos para aprobacion
- revisar trips y payouts

### Guest

Usa el sistema para:

- hacer booking
- entrar por magic link
- ver reservas
- completar pre-check-in
- firmar y pagar
- abrir tickets

## Flujo Recomendado De Entrenamiento

1. Entrar como Super Admin
2. Revisar tenant y settings
3. Revisar People y access control
4. Crear una reserva
5. Completar customer portal
6. Hacer check-out y check-in
7. Revisar issues
8. Revisar host y marketplace
9. Revisar loaner

## Modulos Que Todo Lider Debe Conocer

## 1. Marketplace / Book

Ruta:

- `/book`

Se usa para:

- buscar inventario por location
- seleccionar paquete
- completar guest details
- confirmar booking

Puntos clave:

- el guest no ve tenant
- locations se presentan como marketplace
- car sharing muestra host trust y fotos

## 2. Guest App

Ruta:

- `/guest`

Se usa para:

- sign up
- sign in por magic link
- ver `My Bookings`
- retomar pre-check-in, signature y payment
- abrir tickets

Puntos clave:

- experiencia pensada para customer continuity
- guest account queda limitada a acciones de guest

## 3. Host App

Ruta:

- `/host`

Se usa para:

- manejar fleet/listings
- editar rates
- editar availability
- subir fotos y docs
- enviar vehiculos para aprobacion

Puntos clave:

- los hosts tienen perfil publico y rating
- los vehiculos pasan por approval workflow

## 4. Employee App

Ruta:

- `/employee`

Se usa para:

- quick create reservation
- search operacional
- lanes de pickups, returns, issues y loaners

Puntos clave:

- sirve como hub del turno
- ideal para counter, dispatch y support interno

## 5. Reservations

Rutas:

- `/reservations`
- `/reservations/:id`

Se usa para:

- operar la reserva completa
- pricing
- payments
- additional drivers
- audit logs

Puntos clave:

- es el workflow central del negocio
- desde aqui salen checkout, checkin e inspection

## 6. Issue Center

Ruta:

- `/issues`

Se usa para:

- revisar disputes
- pedir mas informacion
- mover status
- ver history y communications
- aprobar vehiculos de host

Puntos clave:

- centraliza support y customer service
- mantiene trazabilidad del caso

## 7. Dealership Loaner

Ruta:

- `/loaner`

Se usa para:

- intake
- advisor ops
- borrower packet
- billing control
- accounting closeout
- exports y print packets

Puntos clave:

- pensado para service lane
- soporta workflow profundo tipo dealership loaner program

## 8. Settings

Ruta:

- `/settings`

Se usa para:

- agreement
- locations
- vehicle types
- rates
- services
- fees
- insurance
- payment gateway
- access control

Puntos clave:

- en Super Admin siempre revisar `Settings Tenant Scope`

## 9. People

Ruta:

- `/people`

Se usa para:

- crear usuarios
- reasignar tenant
- reset de password
- definir modulos por usuario

Puntos clave:

- tenant admins solo manejan usuarios que ellos crearon

## 10. Tenants

Ruta:

- `/tenants`

Se usa para:

- crear tenants
- activar capacidades
- administrar tenant admins

## Workflows Que Deben Practicarse

## Rental

1. Crear reservation
2. Enviar pre-check-in
3. Guest completa customer info
4. Guest firma
5. Guest paga
6. Staff revisa readiness
7. Checkout
8. Check-in
9. Inspection y cierre

## Car Sharing

1. Host crea listing
2. Guest reserva desde marketplace
3. Guest completa portal
4. Trip corre
5. Si hay issue, entra al Issue Center
6. Al completar, se envia review

## Dealership Loaner

1. Intake
2. Borrower packet
3. Advisor ops
4. Billing
5. Extend / swap / complete service
6. Accounting closeout
7. Print invoice / PO / monthly packet

## Lo Mas Importante Para Training

- siempre confirmar tenant scope
- siempre validar permisos del usuario
- reservations es el centro de la operacion
- Issue Center es el centro de soporte
- loaner vive sobre reservaciones, no aparte
- guest y host deben sentirse como app, no solo como backoffice web

## Checklist Rapido Para Go-Live

- tenants configurados
- modules activados correctamente
- payment gateway configurado por tenant
- locations y vehicle types creados
- host approvals probados
- guest sign-in probado
- customer portal probado
- issue center probado
- loaner probado

## Resumen Ejecutivo

Ride Fleet ya permite operar una experiencia completa para:

- rental
- car sharing
- dealership loaner
- support
- host operations
- employee operations

La mejor forma de entrenar el equipo es por flujo y por rol, no por pantalla
sueltas. Primero tenant y settings, luego reservation lifecycle, luego support,
y finalmente host y marketplace.
