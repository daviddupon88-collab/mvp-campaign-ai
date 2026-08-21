-- CreateTable
CREATE TABLE "product_intelligence_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "sourceImageUrl" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT,
    "subcategory" TEXT,
    "productType" TEXT,
    "brand" TEXT,
    "productName" TEXT,
    "model" TEXT,
    "visionAnalysis" JSONB NOT NULL,
    "identification" JSONB NOT NULL,
    "features" JSONB,
    "benefits" JSONB,
    "usps" JSONB,
    "visibleClaims" JSONB,
    "verifiedClaims" JSONB,
    "unverifiedClaims" JSONB,
    "targetAudience" TEXT,
    "customerProblems" JSONB,
    "customerNeeds" JSONB,
    "customerObjections" JSONB,
    "competitors" JSONB,
    "marketingAngles" JSONB,
    "keywords" JSONB,
    "trends" JSONB,
    "sources" JSONB,
    "webResearchStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "confidence" DOUBLE PRECISION NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_intelligence_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_intelligence_profiles_organizationId_idx" ON "product_intelligence_profiles"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "product_intelligence_profiles_organizationId_imageHash_key" ON "product_intelligence_profiles"("organizationId", "imageHash");

-- AddForeignKey
ALTER TABLE "product_intelligence_profiles" ADD CONSTRAINT "product_intelligence_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
