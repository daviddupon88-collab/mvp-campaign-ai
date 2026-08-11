-- CreateTable
CREATE TABLE "http_error_logs" (
    "id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "requestId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "http_error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "http_error_logs_createdAt_idx" ON "http_error_logs"("createdAt");

-- CreateIndex
CREATE INDEX "http_error_logs_statusCode_idx" ON "http_error_logs"("statusCode");
