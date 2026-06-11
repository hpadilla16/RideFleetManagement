# Inspección por el cliente + Damage Approval — plan de diseño (2026-06-11)

**Estado: APROBADO por Hector 2026-06-10 noche (mockups v4 con line-art violeta aprobados —
los diagramas de producción se generan como assets SVG por vehicle type con ese estilo).
Fase A en implementación.**
Spec dictado por Hector 2026-06-10 noche (post deploy beta.158). Reemplaza/expande el spec
original del item de Monday "Check-in/Checkout: inspección por el cliente".

## 0. Idea central
Empujar la responsabilidad de la inspección al CLIENTE (opt-in por tenant), con el flujo
actual del agente como fail-safe. Lo que el cliente reporta entra a una cola de
**Damage Approval** del agente (soft/hard), y los hard-approved viven en un
**Damage History** nuevo en el perfil del vehículo hasta que se reparen.

## 1. Checkout — Step 4 con dos salidas (solo si el setting del tenant está activo)
Hoy el step 4 del wizard muestra el QR para que el agente haga el walkthrough. Con el
setting activo, el step 4 muestra DOS botones:

1. **"Send inspection link to customer"** — envía el email al cliente con el link (+
   disclosures de responsabilidad) y **avanza el wizard hasta el final** (CLOSED): el
   checkout termina y se emaila el agreement como siempre. La inspección queda pendiente
   del lado del cliente.
2. **"Do inspection for customer"** (fail-safe) — muestra el QR como hoy; el agente
   escanea con la tablet y hace el walkthrough actual. Nada cambia en ese camino.

Setting: tenant-level (Settings), default OFF. Sin el setting, el step 4 queda como hoy.

## 2. Flujo del cliente (móvil, link del email) — 2 pasos
- **Paso 1 — Confirmación**: "¿Eres tú y es este el carro?" — nombre del cliente + carro
  (año/make/model/placa, foto si hay). Confirmar → paso 2.
- **Paso 2 — Anotación de daños sobre diagrama**: imagen del vehículo (diagrama tipo
  blueprint). El cliente TOCA donde está el daño (ej. el aro) → se coloca un **dot** →
  popup inmediato: **tomar foto + descripción breve** de lo que reporta. Repite por cada
  daño. Botón "Finish inspection" → todo se envía al sistema a la cola de **damage
  approval**. (También puede terminar sin reportar nada.)

## 3. Cola de Damage Approval (agente)
- **Dashboard**: alerta/tile "X inspections need your review".
- Click → lista de inspecciones de checkout pendientes de revisión.
- Click en una → el MISMO diagrama que vio el cliente con sus dots. Por cada dot: la
  foto + descripción + dos acciones:
  - **Soft approve** — "lo vimos, queda registrado que lo reportaste", se trackea en la
    inspección pero NO pasa al récord permanente del vehículo.
  - **Hard approve** — prompt "Are you sure?" (yes/no) → el daño pasa al **Damage
    History** del vehículo.

## 4. Damage History en el Vehicle Profile (NUEVO)
- Sección con el mismo diagrama del vehículo mostrando **todos los daños hard-approved
  activos** como dots. Son daños que **hay que reparar**.
- Click en un dot → detalle del daño (foto, descripción, fecha, reserva de origen) +
  pregunta **"Was this fixed?"** → si sí: **foto de la reparación obligatoria** + confirmar
  → el daño cambia de status DAMAGED → FIXED, **se queda en el historial** pero el dot
  desaparece del diagrama principal.

## 5. Check-in (del spec original de Monday — sigue vigente)
- Email automático el día ANTES del retorno: instrucciones de devolución + link de
  inspección de check-in con los mismos disclosures.
- El agente hace el check-in en el sistema sin la parte de inspección (ya la hizo el
  cliente o decidió no hacerla).
- **QR fallback impreso dentro del vehículo** para que nadie alegue "no me llegó el email".

## 6. Piezas técnicas (borrador, a confirmar al implementar)
- Modelos nuevos: `VehicleDamageReport` (vehicleId, reservationId/agreementId, x/y en el
  diagrama, foto (Supabase), descripción, status REPORTED|SOFT_APPROVED|HARD_APPROVED|FIXED,
  approvedBy, fixedPhoto, fixedAt) + token público del flujo de cliente (mismo patrón
  HandoffToken/terms-signing: el token ES el auth).
- Reusa: mobile-inspection plumbing (token + fotos a Supabase), checkout-session state
  machine (nueva transición step 4 → CLOSED con email), patrón de tiles del dashboard.
- Diagrama del vehículo (DECIDIDO por Hector 2026-06-11): la imagen hace match con el
  **vehicle type** del carro (sedan/SUV/van/pickup/...), y el cliente puede **cambiar de
  vista**: front / rear / lado izquierdo / lado derecho / **interior**. Los dots se guardan
  por vista (view + x/y en %). El review del agente y el Damage History usan el mismo set
  de vistas con un selector idéntico.
- Emails: template nuevo (link + disclosures); scheduler para el email de check-in D-1
  (worker poll, mismo patrón de reminders del loaner).

## 7. Fases propuestas
1. **Fase A** — modelos + setting + step 4 con dos botones + email checkout + flujo móvil
   del cliente (2 pasos, dots, fotos). MIGRACIÓN additive.
2. **Fase B** — cola de Damage Approval (tile + lista + review con soft/hard) .
3. **Fase C** — Damage History en el perfil + fix workflow (foto de reparación).
4. **Fase D** — check-in: email D-1 automático + QR impreso fallback + check-in sin
   inspección del agente.

## 8. Decisiones (cerradas 2026-06-11 con Hector)
1. "Send link to customer" cierra el wizard de inmediato y emaila el agreement (dictado).
2. Link del cliente: expira a 24h, re-enviable desde la reserva (default propuesto, OK).
3. Daños de check-IN entran a la misma cola de approval, marcados "check-in" (default
   propuesto, OK).
4. **Diagrama**: imagen por VEHICLE TYPE + selector de vistas para el cliente:
   front / rear / left / right / **interior**. Dots guardados por vista (view, x%, y%).
   Mismo selector en el review del agente y en el Damage History del perfil.
