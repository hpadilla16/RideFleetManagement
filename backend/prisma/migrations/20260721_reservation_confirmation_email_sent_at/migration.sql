-- Additive: durable marker that a customer confirmation email was sent for a
-- reservation. reservations.create now consumes the (previously dead)
-- sendConfirmationEmail flag and sends an immediate confirmation email; this
-- column stamps a successful send so it happens EXACTLY ONCE per reservation
-- (and doubles as observability). Nullable; NULL = not yet sent.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "confirmationEmailSentAt" TIMESTAMP(3);
