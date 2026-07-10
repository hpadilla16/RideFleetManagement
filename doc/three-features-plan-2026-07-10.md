# Plan — 3 features (Ride Fleet Manager) · 2026-07-10

Pipeline (CLAUDE.md): PM → mockup aprobado por Hector → build → Innovation + Graphic Design → QA (SHIP) → deploy → training.
MONEY/access-control → Hector revisa diff línea a línea (F2 y F3 tocan cargos; F1 y F3 tocan permisos).

Todo grounded en el código actual (investigación 2026-07-10).

---

## Feature 1 — Admins pueden override el status de la reserva (hoy solo super admin)

**Qué es:** el control "override status" es el de **Reservation** (round 26): fuerza `Reservation.status` + "smart rewind" (borra el RentalAgreement huérfano, ajusta status del carro, lista pagos que requieren refund manual). Hoy es SUPER_ADMIN-only.

**Decisión Hector:** admins reciben el **mismo poder** (todos los status + el rewind).

**Cambios (mínimos):**
- `backend/src/main.js:244` — `requireRole('SUPER_ADMIN')` → `requireRole('ADMIN','SUPER_ADMIN')` en el mount de `reservationOverrideRouter`.
- `frontend/src/components/admin/ReservationOverridePanel.jsx` — `isSuper` (línea 55) + guard (línea 66) incluir `ADMIN`; actualizar copy "SUPER_ADMIN tools".
- **Audit:** ya existe (`AuditLog action:'ADMIN_OVERRIDE'` con reason, `reservation-override.routes.js:243`). Sin cambio.
- Access-control change → revisión de Hector.

---

## Feature 2 — Misc charge (nombre + monto) por admins

**Hallazgo:** ya existe casi completo como **Admin Corrections → "Add charge / credit"**: `addManualCharge` (`reservation-pricing.service.js:637`) crea un `RentalAgreementCharge` (`chargeType:UNIT`, `taxable:false`, `source:'ADMIN_CORRECTION'`), recalcula balance (`syncAgreementCharges`), y audita (`ADMIN_OVERRIDE`). Rutas `POST /:id/charges` (add) / `/charges/:chargeId/void` (remove), gate `canDoAdminCorrections` = ADMIN/SUPER_ADMIN. UI = `AdminCorrectionsPanel` (`reservations/[id]/page.js:586`), admin-only, con nombre + monto + void + reason.

**Decisión Hector:** **reusar el panel Admin Corrections actual**, re-etiquetado para damages/tickets. Cero UI/tablas nuevas.

**Cambios (mínimos):**
- Re-label del panel/CTA a algo tipo "Add charge / misc item (damage, ticket, etc.)"; ayuda de texto que aclare el uso (daños de valor variable, tickets).
- (Opcional, reporting) `source:'MISC_CHARGE'` distinto de `ADMIN_CORRECTION` — si se hace, añadir el carve-out en `syncAgreementCharges` deleteMany (`:239-247`) y en `listAgreementCharges` (`:713`). Default: mantener `ADMIN_CORRECTION` para no tocar el recompute (más seguro).
- `taxable:false` (daños/tickets no llevan tax) — ya es el default.
- MONEY change → diff para Hector (aunque es re-label, confirmamos que el recompute no cambia).

---

## Feature 3 — Botón "Report Damage" en la reserva (rental agents + admins)

**Objetivo:** un flujo guiado desde la reserva que (a) registra el daño como **hard approval** en el vehicle profile, (b) sube fotos + estimado, (c) pregunta **quién paga** y pone el cargo correcto en el contrato, (d) pone el **status del carro**, y (e) **auto-crea el Incident Report en DRAFT** + empuja al agente a completarlo.

### Piezas existentes que se reúsan (NO se reconstruyen)
- **Vehicle damage module** = `customer-inspection`: `VehicleDamageReport` con `DamageReportStatus` REPORTED→SOFT_APPROVED→**HARD_APPROVED**→FIXED. `addManualDamage` (`customer-inspection.service.js:494`) ya crea un HARD_APPROVED con foto obligatoria en un diagrama del carro — pero SIN contexto de reserva/cliente/estimado/costo.
- **Incident Report** = `incident-report`: `create` auto-llena cliente/vehículo/depósito, `type:DAMAGE`, evidencia (fotos, pull de inspección), §6 resumen de cargos con tax prorrateado (fix TL-ZE40809640BA). **NO escribe cargos ni manda email.** Roles ADMIN/OPS/AGENT.
- **Cargo al contrato** = `addManualCharge` (el único path que pone un cargo). Hoy ADMIN-only.

### Decisiones Hector
- **Roles:** rental agents (AGENT) + admins (y OPS/SUPER_ADMIN) pueden reportar daño.
- **Cargo:** el **agente también** puede añadir el cargo, **dentro de este flujo** (excepción acotada — no abre `addManualCharge` general para agentes).
- **Incident:** al someter → **auto-crea Incident Report DRAFT** pre-llenado + **notifica al agente** que debe completarlo + botón **"Complete now"** que lo baja al Incident Report en la misma reserva. (NO auto-emite ni auto-email; eso lo hace el agente/admin al certificar.)
- **Status del carro:** selector al someter (Available / Maintenance / Out of Service / … valores reales de `Vehicle.status`).

### Flujo del wizard (UI nueva)
1. **Resumen auto-llenado** (read-only): cliente, vehículo (placa), # reserva.
2. **Daño:** posición en el diagrama del carro (reusa `vehicleDiagrams.js` + `VehicleView`), descripción, **fotos obligatorias (≥1)**.
3. **Estimado:** subir documento/foto del estimado.
4. **¿Quién paga?** (3 opciones):
   - **Cliente** → entra el costo del daño → se suma al contrato.
   - **Seguro del cliente** → entra el costo del daño → se suma al contrato.
   - **Seguro nuestro** → pregunta **nuestro deducible** → ese monto va al contrato.
5. **Status del carro:** dropdown (queda Available / Maintenance / Out of Service / etc.).
6. **Submit** →
   - `VehicleDamageReport` **HARD_APPROVED** con `reservationId`/`reservationNumber` + estimado + costo + `responsibleParty` + link al incident.
   - Cargo al contrato vía `addManualCharge` (excepción de rol acotada), `source:'DAMAGE_CHARGE'`, monto = costo del daño (cliente/seguro cliente) o deducible (seguro nuestro). Audita.
   - `Vehicle.status` = lo elegido.
   - **Incident Report DRAFT** auto-creado (`type:DAMAGE`, evidencia = las fotos del daño, `chargeIdsJson` = el cargo) + notificación al agente + botón "Complete now".
7. **Failsafe:** admins pueden **editar/borrar** `VehicleDamageReport` (rutas NUEVAS — hoy no existen), void del cargo (existe), y el incident draft es editable.

### Cambios de schema (aditivos)
- `VehicleDamageReport`: añadir `reservationChargeId?`/`incidentId?` (links), `estimatePhotoJson?` (estimado), `damageCostCents?`/`responsibleParty?` (CUSTOMER | CUSTOMER_INSURANCE | OUR_INSURANCE) `ourDeductibleCents?`. (O una tabla puente ligera; preferir columnas aditivas.)
- Migración aditiva idempotente.

### Overlap / conexión (resumen de la investigación)
Incident-report = documento + selección de cargos + artefacto al cliente. VehicleDamageReport = registro permanente del carro. `addManualCharge` = el cargo. El "Report Damage" es un **orquestador delgado** que los cose: 1 decisión nueva (quién paga) + 1 cross-link + rutas de failsafe + el nudge al incident draft.

### Notas
- MONEY: el cargo del daño SÍ se pone en el contrato (es el punto). `estimatedTotal`/balance recalculan vía `syncAgreementCharges`. Diff línea a línea para Hector.
- Access-control: agente puede crear el cargo SOLO por este flujo. Revisión de Hector.
- Email al cliente: net-new cuando se emita el incident (patrón `sendEmail`/`renderBrandedEmail` de customer-inspection). En esta fase el flujo llega hasta el DRAFT + nudge; el email va cuando el agente/admin certifica y emite (se puede incluir aquí o en una fase siguiente — confirmar en QA).
