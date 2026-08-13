-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('en', 'de', 'fr', 'ar');

-- AlterTable
-- Additive only: existing rows get the "en" default, nothing else on the users table changes.
ALTER TABLE "users" ADD COLUMN "preferredLanguage" "Locale" NOT NULL DEFAULT 'en';
