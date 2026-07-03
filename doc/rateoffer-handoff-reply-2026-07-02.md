# Respuesta al scraper team — RateOffer (2026-07-02)

De: equipo Ride Fleet Manager · Re: handoff "modelo Prisma RateOffer"

**Estado: implementado y QA'd** (schema Prisma + migración `20260702_rate_offer`, ship
`v0.9.0-beta.281`). La tabla queda igual a su propuesta con estos ajustes verificados:

## Ajustes al modelo propuesto

1. **FKs formales: SÍ** (su ítem opcional). `runId → MarketScrapeRun` y
   `profileId → MarketScrapeProfile`, ambas `ON DELETE CASCADE` — mismo patrón que
   `MarketObservation`. Borrar un run borra sus offers.
2. **`id` con DEFAULT en la DB**: `gen_random_uuid()::text`. Su `@default(cuid())`
   es client-side de Prisma y NO genera default en la DB — su primer INSERT crudo sin
   `id` habría fallado con NOT NULL violation. Con el default pueden **omitir `id`
   siempre** (verificado con inserts reales). No manden ids propios.
3. **`status`**: se reusa `MarketObservationStatus` (FOUND/CLOSED/UNMAPPED/ERROR),
   default FOUND — como propusieron. No ajusten nada.
4. El unique quedó con el nombre exacto `rateoffer_identity_key` en la DB (índice único).

## Sintaxis de upsert OBLIGATORIA (verificada contra Postgres real)

`ON CONFLICT ON CONSTRAINT "rateoffer_identity_key"` **FALLA** — es un índice único,
no un constraint. Usen la lista de columnas:

```sql
INSERT INTO "RateOffer"("runId","profileId","source","provider","supplier",
  "pickupDate","returnDate","lorDays","sipp","rawCategory","carExample",
  "dailyPrice","totalPrice","effectiveDailyPrice")
VALUES (...)
ON CONFLICT ("runId","source","provider","supplier","rawCategory","sipp","pickupDate","returnDate")
DO UPDATE SET
  "dailyPrice" = EXCLUDED."dailyPrice",
  "totalPrice" = EXCLUDED."totalPrice",
  "effectiveDailyPrice" = EXCLUDED."effectiveDailyPrice",
  "observedAt" = now(),          -- ¡importante! el DEFAULT solo aplica en INSERT
  "status" = 'FOUND';
```

- `supplier`/`sipp`/`rawCategory`/`provider`: manden `''` cuando falte el dato, nunca
  NULL (como acordamos — el dedup lo exige y está probado con la fila `supplier=''`).
- En el `DO UPDATE` incluyan `"observedAt" = now()` — si no, las filas re-scrapeadas
  se ven stale.

## Handshake del run (importante)

Cada batch necesita su fila `MarketScrapeRun` ANTES (FKs NOT NULL). Ojo:
`MarketScrapeRun.id` tampoco tiene default en la DB. Opciones:

```sql
INSERT INTO "MarketScrapeRun"("id","profileId")
VALUES (gen_random_uuid()::text, $profileId)
RETURNING id;   -- status/startedAt/contadores tienen defaults
```

o sigan generando el id ustedes como hacían con el pipeline de Expedia. Cierren el run
actualizando su status/contadores como antes.

## Acceso / GRANTs

Si su credencial del droplet es la misma que usaban para `MarketObservation` (rol owner),
no hay nada que hacer. Si es un rol acotado, Hector aplica:

```sql
GRANT USAGE ON SCHEMA public TO <scraper_role>;
GRANT SELECT, INSERT, UPDATE ON "RateOffer" TO <scraper_role>;
GRANT SELECT, INSERT, UPDATE ON "MarketScrapeRun" TO <scraper_role>;
GRANT SELECT ON "MarketScrapeProfile" TO <scraper_role>;
```

(Enums usables por PUBLIC; no hay sequences — el PK es UUID.)

## Criterios de aceptación — estado

1. ✅ `RateOffer` vía migración Prisma house-style, sin drift (reconciliada contra
   `prisma migrate diff`, cero diferencias semánticas).
2. ✅ Inserts batch con `source='KAYAK'` + provider/supplier — probado (ids omitidos).
3. ✅ `WHERE provider='Expedia'` y `GROUP BY provider` — probados.
4. ✅ Misma oferta con distinta `source` = 2 filas — probado.
5. ✅ Lectura para monitoreo: Hector tiene acceso (misma DB/roles de siempre).

## Pendiente en nuestro lado (follow-up, no los bloquea)

- El dashboard de Market Intelligence todavía lee solo `MarketObservation` — la data de
  Kayak no se visualiza hasta que conectemos el consumer (`market-scrape-comparison` /
  pricing engine) a `RateOffer`. Ticket aparte.
- Semántica de `MarketScrapeRun.observationsCount` para corridas Kayak: por ahora
  escriban ahí su count de offers; lo renombramos/duplicamos cuando hagamos el consumer.
