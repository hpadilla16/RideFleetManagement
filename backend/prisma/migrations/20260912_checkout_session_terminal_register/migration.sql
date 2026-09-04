-- 2026-09-04 — the agent's terminal pick for a checkout session.
-- A pickup location can run more than one Dejavoo device (LAX Counter 1 /
-- Counter 2). The agent chooses once; every terminal op of the session
-- (clauses, signature, sale, card-present deposit) pins that register.
-- Null keeps the pre-existing behaviour: resolve by location.
ALTER TABLE "CheckoutSession" ADD COLUMN "terminalRegisterId" TEXT;
