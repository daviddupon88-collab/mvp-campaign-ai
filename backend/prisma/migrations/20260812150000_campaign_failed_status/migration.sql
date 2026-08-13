-- AlterEnum
ALTER TYPE "CampaignStatus" ADD VALUE 'FAILED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CAMPAIGN_GENERATION_FAILED';

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "productDescription" TEXT;
