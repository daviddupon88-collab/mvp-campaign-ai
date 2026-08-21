-- CreateTable
CREATE TABLE "creative_generation_traces" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creativeIntelligence" JSONB NOT NULL,
    "creativeConcept" JSONB NOT NULL,
    "shotPlanVersions" JSONB NOT NULL,
    "judgeAttempts" JSONB NOT NULL,
    "repairs" JSONB NOT NULL,
    "costEstimate" JSONB NOT NULL,
    "finalOutcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creative_generation_traces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creative_generation_traces_campaignId_key" ON "creative_generation_traces"("campaignId");

-- CreateIndex
CREATE INDEX "creative_generation_traces_organizationId_idx" ON "creative_generation_traces"("organizationId");

-- AddForeignKey
ALTER TABLE "creative_generation_traces" ADD CONSTRAINT "creative_generation_traces_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_generation_traces" ADD CONSTRAINT "creative_generation_traces_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
