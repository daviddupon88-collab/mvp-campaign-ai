-- CreateEnum
CREATE TYPE "ContradictionResolutionStatus" AS ENUM ('UNRESOLVED', 'RESOLVED_A', 'RESOLVED_B', 'CONTEXT_DEPENDENT');

-- CreateTable
CREATE TABLE "brand_memory_contradictions" (
    "id" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeAId" TEXT NOT NULL,
    "knowledgeBId" TEXT NOT NULL,
    "evidenceA" INTEGER NOT NULL,
    "evidenceB" INTEGER NOT NULL,
    "confidenceA" DOUBLE PRECISION NOT NULL,
    "confidenceB" DOUBLE PRECISION NOT NULL,
    "resolutionStatus" "ContradictionResolutionStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "brand_memory_contradictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brand_memory_contradictions_organizationId_resolutionStatus_idx" ON "brand_memory_contradictions"("organizationId", "resolutionStatus");

-- AddForeignKey
ALTER TABLE "brand_memory_contradictions" ADD CONSTRAINT "brand_memory_contradictions_knowledgeAId_fkey" FOREIGN KEY ("knowledgeAId") REFERENCES "brand_memory_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_memory_contradictions" ADD CONSTRAINT "brand_memory_contradictions_knowledgeBId_fkey" FOREIGN KEY ("knowledgeBId") REFERENCES "brand_memory_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_memory_contradictions" ADD CONSTRAINT "brand_memory_contradictions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
