# Spike 2 — Re-emisión del handoff token al drenar la bandeja

**Fecha:** 2026-08-16 · **Contra:** main @ 6d8173c · **Veredicto: RESUELTO EN CLIENTE — sin pedido de backend.**

## La prueba que tenía que pasar

Capturar fotos de inspección offline → esperar >15 min (TTL del token) → reconectar →
las fotos llegan.

## Por qué funciona (verificado en código, no supuesto)

1. **La emisión del token es state-agnostic.** `mintHandoffToken`
   (`checkout-session.service.js:700-771`) solo exige que la sesión exista — no valida
   `currentStep`, ni terminal, ni nada. Un staff JWT puede re-emitir
   `POST /api/checkout-sessions/:id/handoff-token` horas después de la captura.
2. **La re-emisión produce token fresco cuando el viejo venció.** El mint es idempotente
   solo dentro del TTL (reusa un token no consumido con >2 min de vida,
   `checkout-session.service.js:717-734`); vencido el viejo, crea uno nuevo de 15 min.
3. **`savePhoto` tampoco valida estado de sesión.** `mobile-inspection.service.js:145-179`
   solo exige token válido (kind correcto, no vencido, **no consumido** — ojo, este loader
   SÍ rechaza `consumedAt`, línea 64, a diferencia del exchange con tolerancia a reload) y
   agreement vinculado. El upsert por `angleKey` sobre `RentalAgreementInspection` es
   naturalmente idempotente: re-subir el mismo ángulo reemplaza, no duplica.
4. **`complete` consume el token** (`mobile-inspection.service.js:282-284`) y estampa
   `inspectionCompletedAt` (+ `customerSignedAt` si lleva firma), lo que dispara la cascada
   del wizard hasta CLOSED.

## Contrato de drenado para la bandeja (M0-7)

```
al drenar, por sesión de inspección pendiente:
  1. POST /api/checkout-sessions/:id/handoff-token   (staff JWT, Dio autenticado)
  2. por cada foto:  POST /api/mobile-inspection/:token/photo   (Dio limpio, sin bearer)
  3. AL FINAL, y solo si procede:  POST /api/mobile-inspection/:token/complete
```

Reglas derivadas del código:

- **`complete` va al último y es condicional.** Consume el token; cualquier foto después
  necesitaría re-mint. Antes de mandarlo, consultar
  `GET /api/checkout-sessions/by-reservation/:rid` — si `inspectionCompletedAt` ya está
  estampado (otra superficie terminó la inspección), **omitir** `complete`: el servidor no
  lo guarda contra re-estampado y pisaría el timestamp de una sesión posiblemente CLOSED.
- **Drenado largo:** si el lote tarda >13 min (TTL−2), re-mint intermedio — mientras el
  token viva >2 min el mint devuelve el mismo (`reused: true`), así que re-mint es gratis.
- **410 `TOKEN_CONSUMED` a media subida** (un `complete` ajeno se cruzó): re-mint y seguir
  con las fotos restantes.
- **409 "No agreement linked"** o sesión/reserva desaparecida: dead-letter visible, no
  reintentar en loop.
- **Errores por código:** `TOKEN_INVALID`/`TOKEN_EXPIRED` → re-mint una vez; si persiste,
  dead-letter. `REQUIRED_ANGLES_MISSING` (falta front/rear) → dead-letter con mensaje
  claro al usuario.
- Fotos viajan como dataURL JSON (límite 15 MB por request,
  `mobile-inspection.routes.js:21`) — la compresión al capturar (DoD #8) no es opcional.

## Acoplamiento con el spike 1

El paso 1 del drenado exige el **staff JWT vigente** en el momento del drain. Si el spike 1
(leer token seguro desde isolate de background) falla en una plataforma, el drenado en esa
plataforma queda condicionado a hidratación en primer plano — pero el problema del TTL está
resuelto igual: la re-emisión ocurre al drenar, sea en background o en foreground.

## Impacto en el plan

- Gap #2 del PROJECT_PLAN: **cerrado** — no hace falta endpoint de fotos sin TTL.
- Pregunta abierta §9-2: **moot** salvo que el spike 1 falle en ambas plataformas Y el
  drenado en foreground se considere inaceptable.
- Hallazgo lateral: la atribución de comisión viaja en `createdByUserId` del token
  (`mobile-inspection.service.js:157-158,262`) — al re-emitir desde la app, el token lo
  crea el mismo empleado, así que la comisión queda bien atribuida incluso en drain tardío.
