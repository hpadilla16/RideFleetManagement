-- Add token-based chat room access
ALTER TABLE "Conversation" ADD COLUMN "hostToken" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "guestToken" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "hostTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "guestTokenExpiresAt" TIMESTAMP(3);

-- Add pickup coordination fields
ALTER TABLE "Conversation" ADD COLUMN "pickupAddress" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "pickupLat" DECIMAL(10, 7);
ALTER TABLE "Conversation" ADD COLUMN "pickupLng" DECIMAL(10, 7);
ALTER TABLE "Conversation" ADD COLUMN "pickupInstructions" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "pickupPhotoUrl" TEXT;

-- Add message type for system/pickup messages
ALTER TABLE "Message" ADD COLUMN "messageType" TEXT NOT NULL DEFAULT 'TEXT';

-- Unique indexes for token lookup
CREATE UNIQUE INDEX "Conversation_hostToken_key" ON "Conversation"("hostToken");
CREATE UNIQUE INDEX "Conversation_guestToken_key" ON "Conversation"("guestToken");
