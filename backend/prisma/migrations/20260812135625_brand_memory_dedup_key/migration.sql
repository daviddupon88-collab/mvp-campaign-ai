-- AlterTable
ALTER TABLE "brand_memory_entries" ADD COLUMN     "dedupKey" TEXT;

-- CreateIndex
CREATE INDEX "brand_memory_entries_organizationId_dedupKey_idx" ON "brand_memory_entries"("organizationId", "dedupKey");
