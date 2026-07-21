# Handoff RFM — exponer `insurancePlans` en `/api/quotes/preview` (1 línea)

**Fecha:** 2026-07-21 · **Estado:** PREPARADO en working tree, pendiente de review + deploy por el equipo RFM · **Riesgo:** bajo (aditivo, display-only, sin lógica de cargo)

## Qué y por qué

El endpoint `GET /api/quotes/preview` (`backend/src/modules/quotes/quotes.service.js`, función `mapEngineRow`) **descartaba** los planes de seguro que el motor ya calcula. `bookingEngineService.searchRental` adjunta `row.insurancePlans` (booking-engine.service.js ~1407, cada plan ya prorrateado por `computeInsuranceLine`), pero `mapEngineRow` construía un objeto de forma fija que no los reenviaba → todo consumidor del preview recibía las clases **sin** seguro.

Esto bloqueaba el **upsell de VozIA** (repo `voice-ai-customer-service`, 2026-07-20): Chloe ofrece, tras reservar, el seguro del local + prepaid tolls. VozIA lee `PreviewRow.insurancePlans`; sin este passthrough el seguro sale vacío en vivo (los tolls funcionan por otro endpoint). El sitio público también podría usarlos.

## El cambio (aditivo)

En `mapEngineRow`, junto a los demás campos del return:
```js
insurancePlans: Array.isArray(row?.insurancePlans) ? row.insurancePlans : []
```
Nada más cambia. No toca cálculo de precio ni de cargo — solo reenvía datos ya computados.

## Verificación

- `npm run test:quotes` → 28/28 (incluye 2 tests nuevos: passthrough con planes y default `[]` sin planes).
- Contrato: cada plan trae `{ code, name, description, chargeBy, amount, total }` (shape de `computeInsuranceLine`).

## Nota

Es money-path, por eso NO se auto-deployó — el equipo RFM lo revisa y lo bundlea con su trabajo de rates. Hasta que aterrice, el guión de VozIA degrada elegante (se salta el seguro, ofrece solo el toll pass). Ver memoria `vozia-upsell`.
