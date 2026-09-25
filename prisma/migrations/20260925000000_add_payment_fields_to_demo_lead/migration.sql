-- AlterTable: Add payment tracking fields to DemoLead
ALTER TABLE "DemoLead" ADD COLUMN IF NOT EXISTS "paymentCompleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DemoLead" ADD COLUMN IF NOT EXISTS "paymentSessionId" TEXT;
ALTER TABLE "DemoLead" ADD COLUMN IF NOT EXISTS "selectedPlanId" TEXT;
