# Plan — Admin Corrections (arreglar check-in/out + fees sin SQL)

**Fecha:** 2026-06-22 · **Pedido por:** Hector · **Acceso:** SOLO ADMIN · **Estado:** PLAN (pendiente aprobación)

## Objetivo
Una herramienta nativa para que los **admins** arreglen errores de piso en una reserva
**sin tocar la DB por SQL** (como tuvimos que hacer hoy con el fuel fee de RES-721750).
4 capacidades, todas con **audit log** (quién, cuándo, razón) y **recompute por el motor**
(`syncAgreementCharges(..., {allowClosed:true})`) para que `fees/total/balance` nunca queden mal.

## Reglas de seguridad (duras)
- **Solo ADMIN** (`requireRole('ADMIN')`). Nada de OPS/staff.
- **Cada mutación → `AuditLog`** con `actorUserId`, `reason` (obligatoria), y before/after del balance.
- **El balance NUNCA se calcula a mano** — siempre vía `syncAgreementCharges(allowClosed:true)`
  (misma fórmula del motor: `fees`=Σ FEE_ENGINE, `total`=subtotal+taxes+fees, `balance`=max(0,total−paid)).
- **Money code → Hector revisa los diffs y deploya.** Cowork no deploya.
- Nada de esto toca payment-gateway/Authorize.Net (no se mueve dinero real; solo se ajustan cargos/balance).

---

## FASE 1 — Correcciones de cargos (reemplaza el SQL) · riesgo BAJO
Cubre el caso más común (fee mal cobrado en el piso). **Recomendado arrancar aquí.**

**Backend (`reservations` module, todos `requireRole('ADMIN')`):**
- `POST /api/reservations/:id/charges/:chargeId/void` — anula un `RentalAgreementCharge`
  (incluye los post-check-in fees `source=FEE_ENGINE_CHECKIN`: fuel/cleaning/smoking/late).
  Body: `{ reason }`. Marca `selected=false` (queda en historial, sale de los totales) →
  `syncAgreementCharges(allowClosed:true)` → `AuditLog`. Devuelve el pricing actualizado.
- `POST /api/reservations/:id/charges` — añade un **cargo o crédito manual**.
  Body: `{ name, amount (negativo = crédito), taxable, reason }`. Crea `RentalAgreementCharge`
  `source='ADMIN_CORRECTION'` → sync → audit. (Reusa el patrón de issue-center `createChargeDraft`.)

**Frontend (perfil de la reserva):** panel **"⚙️ Admin Corrections"** (solo ADMIN):
- En cada línea de Charges y de Post-Check-in Fees → botón **"Void"** → modal con razón obligatoria.
- Botón **"Add charge / credit"** → modal (nombre, monto ±, taxable, razón).
- Muestra el balance antes→después antes de confirmar.

**Migración:** ninguna (selected=false + AuditLog). Opcional luego: columnas `voidedAt/voidedByUserId/voidReason`
si quieres que el "void" se vea explícito en el historial (aditivo).

---

## FASE 2 — Corregir valores del check-in/out · riesgo MEDIO
Arreglar la **causa raíz** (lectura mal capturada) y que los fees se recalculen solos.

**Backend:**
- `PATCH /api/reservations/:id/inspection` (ADMIN) — corrige odómetro / nivel de combustible /
  limpieza / fechas pickup-return. Body: `{ odometerOut?, fuelOut?, fuelIn?, cleanlinessOut?, ...,
  reason }`. Pasos: actualiza los valores en el agreement/`RentalAgreementInspection` → **borra los
  fees FEE_ENGINE_CHECKIN viejos** → re-corre el cómputo del fee-engine con los valores corregidos
  (reusa la lógica de `checkin-close.service`) → re-inserta los fees → `syncAgreementCharges` → audit.
- Garantía clave: el fee-engine es idempotente sobre los valores corregidos → **no duplica** fees.

**Frontend:** en el panel de Corrections → **"Edit check-in/out values"** → modal con los campos
(odo, fuel out/in, limpieza, fechas) precargados → al guardar muestra qué fees cambiaron.

---

## FASE 3 — Reabrir el check-in/out completo · riesgo ALTO
Volver a abrir el wizard para rehacerlo desde cero.

**Backend:**
- `POST /api/reservations/:id/reopen-checkout` y `/reopen-checkin` (ADMIN) — revierte el estado
  (ej. `CHECKED_IN_UNPAID` → estado donde el wizard puede rehacer) con guardas: preservar pagos ya
  capturados, no doble-cobrar, respetar `vehicle-status-sync` (no pisar locked states), audit.
- **Toca la state machine de `checkout-session` + sincronización de Vehicle.status** → se construye
  AL FINAL, con tests de las transiciones y verificación extra. Requiere investigación adicional del
  wizard-v2 antes de implementar.

**Frontend:** botón **"Reopen check-in/out"** con confirmación fuerte ("Are you sure?") + razón.

---

## Cross-cutting
- **Permiso:** `requireRole('ADMIN')` en todas las rutas nuevas.
- **Audit:** helper `logAdminCorrection({ reservationId, action, reason, before, after, actorUserId })`.
- **UI gate:** el panel Corrections solo se renderiza para `role==='ADMIN'` (o SUPER_ADMIN).
- **Tests:** unit del recompute tras void/add (balance correcto); test de no-duplicación de fees en Fase 2.

## Recomendación de entrega
1. **Fase 1 primero** (cierra el dolor inmediato — el SQL de hoy se vuelve un botón). Backend+frontend, sin migración.
2. **Fase 2** después (corrección de valores + recompute).
3. **Fase 3** al final (reopen, alto riesgo, con su propia investigación + tests).

Cada fase = su propio ship script `v0.9.0-beta.NNN`, Hector revisa diff + deploya.
