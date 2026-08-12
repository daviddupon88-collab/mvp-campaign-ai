-- CreateEnum
CREATE TYPE "BrandMemoryCategory" AS ENUM ('POSITIONING', 'VOICE', 'COPY', 'CREATIVE', 'CHANNEL', 'PERSONA', 'OFFER', 'CTA', 'VISUAL', 'PERFORMANCE', 'COMPETITOR', 'LEGAL', 'PRODUCT');

-- CreateEnum
CREATE TYPE "BrandMemoryScope" AS ENUM ('GLOBAL', 'CHANNEL', 'PERSONA', 'CONTENT_TYPE', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "BrandMemoryStatus" AS ENUM ('ACTIVE', 'OUTDATED', 'CONTRADICTED', 'DISMISSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BrandMemoryType" ADD VALUE 'FACT';
ALTER TYPE "BrandMemoryType" ADD VALUE 'PREFERENCE';
ALTER TYPE "BrandMemoryType" ADD VALUE 'RULE';
ALTER TYPE "BrandMemoryType" ADD VALUE 'LEARNING';
ALTER TYPE "BrandMemoryType" ADD VALUE 'INSIGHT';
ALTER TYPE "BrandMemoryType" ADD VALUE 'ANTI_PATTERN';
ALTER TYPE "BrandMemoryType" ADD VALUE 'CONTRADICTION';

-- AlterTable
ALTER TABLE "brand_memory_entries" ADD COLUMN     "category" "BrandMemoryCategory",
ADD COLUMN     "channel" TEXT,
ADD COLUMN     "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
ADD COLUMN     "contentType" TEXT,
ADD COLUMN     "evidenceCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "negativeSignals" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "persona" TEXT,
ADD COLUMN     "positiveSignals" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sampleSize" INTEGER,
ADD COLUMN     "scope" "BrandMemoryScope" NOT NULL DEFAULT 'GLOBAL',
ADD COLUMN     "source" TEXT,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "status" "BrandMemoryStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "brand_memory_entries_organizationId_status_idx" ON "brand_memory_entries"("organizationId", "status");

-- CreateIndex
CREATE INDEX "brand_memory_entries_organizationId_scope_channel_idx" ON "brand_memory_entries"("organizationId", "scope", "channel");

-- CreateIndex
CREATE INDEX "brand_memory_entries_organizationId_category_idx" ON "brand_memory_entries"("organizationId", "category");

-- Backfill des lignes V1 existantes — jamais de valeur inventée (cf. règle absolue #21),
-- uniquement des déductions directes à partir de données déjà présentes sur la ligne.
-- CAMPAIGN_LEARNING n'a pas de catégorie déduite sans ambiguïté : laissé NULL plutôt
-- qu'inventé.
UPDATE "brand_memory_entries" SET "category" = 'COMPETITOR' WHERE "type" = 'COMPETITOR_NOTE';
UPDATE "brand_memory_entries" SET "category" = 'PERFORMANCE' WHERE "type" = 'PERFORMANCE_INSIGHT';

-- scope=CAMPAIGN quand une campagne source est identifiable (le cas de toutes les lignes V1
-- réellement écrites en pratique) ; GLOBAL (valeur par défaut de la colonne) sinon.
UPDATE "brand_memory_entries" SET "scope" = 'CAMPAIGN' WHERE "sourceCampaignId" IS NOT NULL;

-- source/sourceId déduits du type V1 (seuls call-sites réels : PublishingService, AiOptimizerService).
UPDATE "brand_memory_entries" SET "source" = 'publishing', "sourceId" = "sourceCampaignId" WHERE "type" = 'CAMPAIGN_LEARNING';
UPDATE "brand_memory_entries" SET "source" = 'optimizer', "sourceId" = "sourceCampaignId" WHERE "type" = 'PERFORMANCE_INSIGHT';

-- firstObservedAt/lastObservedAt : la date de création réelle est une meilleure valeur que
-- "maintenant" pour des lignes historiques.
UPDATE "brand_memory_entries" SET "firstObservedAt" = "createdAt", "lastObservedAt" = "createdAt";
