-- AlterTable
ALTER TABLE "AdditionalService" ADD COLUMN IF NOT EXISTS "displayDescription" TEXT;
ALTER TABLE "AdditionalService" ADD COLUMN IF NOT EXISTS "displayPriority" INTEGER NOT NULL DEFAULT 0;
