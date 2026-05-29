-- Phase 3.5 — email-on-finalize
--
-- Adds CheckoutSession.autoEmailedAt so the transition-to-CLOSED hook
-- can stamp a single, idempotent marker the first time the agreement
-- PDF is auto-emailed to the customer. The marker is also surfaced to
-- the UI so the "Email Agreement" button can flip to "Resend signed
-- copy · Sent {when}".
ALTER TABLE "CheckoutSession"
  ADD COLUMN "autoEmailedAt" TIMESTAMP(3);
