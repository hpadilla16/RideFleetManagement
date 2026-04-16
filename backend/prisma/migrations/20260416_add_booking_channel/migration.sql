-- Add bookingChannel to Reservation (STAFF, WEBSITE, CAR_SHARING, MIGRATION)
ALTER TABLE "Reservation" ADD COLUMN "bookingChannel" TEXT NOT NULL DEFAULT 'STAFF';
