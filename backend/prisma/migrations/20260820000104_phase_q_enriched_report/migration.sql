-- AlterTable
ALTER TABLE "creative_generation_traces" ADD COLUMN     "attemptCount" INTEGER,
ADD COLUMN     "elapsedMs" INTEGER,
ADD COLUMN     "escalationLevel" TEXT,
ADD COLUMN     "report" JSONB;
