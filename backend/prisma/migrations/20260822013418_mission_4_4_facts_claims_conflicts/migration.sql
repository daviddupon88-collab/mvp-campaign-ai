-- AlterTable
ALTER TABLE "creative_generation_traces" ADD COLUMN     "productConflicts" JSONB,
ADD COLUMN     "productUrl" TEXT,
ADD COLUMN     "productUrlFacts" JSONB;

-- AlterTable
ALTER TABLE "product_intelligence_profiles" ADD COLUMN     "productClaims" JSONB,
ADD COLUMN     "productConflicts" JSONB,
ADD COLUMN     "productFacts" JSONB,
ADD COLUMN     "productUrl" TEXT,
ADD COLUMN     "productUrlFacts" JSONB;

-- CreateTable
CREATE TABLE "product_url_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "extractedFacts" JSONB NOT NULL,
    "extractedClaims" JSONB NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_url_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_url_snapshots_organizationId_idx" ON "product_url_snapshots"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "product_url_snapshots_organizationId_normalizedUrl_key" ON "product_url_snapshots"("organizationId", "normalizedUrl");

-- AddForeignKey
ALTER TABLE "product_url_snapshots" ADD CONSTRAINT "product_url_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
