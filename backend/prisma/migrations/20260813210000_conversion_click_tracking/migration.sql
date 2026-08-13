-- AlterTable
ALTER TABLE "published_posts" ADD COLUMN "destinationUrl" TEXT;

-- CreateTable
CREATE TABLE "tracked_clicks" (
    "id" TEXT NOT NULL,
    "fbclid" TEXT,
    "gclid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "publishedPostId" TEXT NOT NULL,

    CONSTRAINT "tracked_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_capi_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pixelId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_capi_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracked_clicks_campaignId_idx" ON "tracked_clicks"("campaignId");

-- CreateIndex
CREATE INDEX "tracked_clicks_publishedPostId_idx" ON "tracked_clicks"("publishedPostId");

-- CreateIndex
CREATE UNIQUE INDEX "meta_capi_configs_organizationId_key" ON "meta_capi_configs"("organizationId");

-- AddForeignKey
ALTER TABLE "tracked_clicks" ADD CONSTRAINT "tracked_clicks_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_clicks" ADD CONSTRAINT "tracked_clicks_publishedPostId_fkey" FOREIGN KEY ("publishedPostId") REFERENCES "published_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_capi_configs" ADD CONSTRAINT "meta_capi_configs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
