-- Ride Kiosk ↔ Valet remote assist — F1 (2026-09-03).
-- Plan: doc/kiosk-valet-remote-assist-plan-2026-09-03.md (§4 MUST-CHANGE 3 +
-- SHOULD "Historial antes de Get Help").
--
-- KioskSession.voziaConversationId — the Valet conversation bound to the
-- session (device-guarded write; every service-account read must match it).
-- KioskSession.idPhotosStoredAt   — server-written marker that persistIdPhotos
-- stored a license photo (the assist-view truth; never derived from eventsJson).
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor. Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "voziaConversationId" TEXT;
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "idPhotosStoredAt" TIMESTAMP(3);
