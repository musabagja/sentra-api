/*
  Warnings:

  - The values [AVAILABLE,UNAVAILABLE] on the enum `ItemStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ItemStatus_new" AS ENUM ('VERIFIED', 'SOLD', 'HOLD', 'UNVERIFIED');
ALTER TABLE "public"."Card" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."Number" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Card" ALTER COLUMN "status" TYPE "ItemStatus_new" USING ("status"::text::"ItemStatus_new");
ALTER TABLE "Number" ALTER COLUMN "status" TYPE "ItemStatus_new" USING ("status"::text::"ItemStatus_new");
ALTER TYPE "ItemStatus" RENAME TO "ItemStatus_old";
ALTER TYPE "ItemStatus_new" RENAME TO "ItemStatus";
DROP TYPE "public"."ItemStatus_old";
ALTER TABLE "Card" ALTER COLUMN "status" SET DEFAULT 'UNVERIFIED';
ALTER TABLE "Number" ALTER COLUMN "status" SET DEFAULT 'VERIFIED';
COMMIT;

-- AlterTable
ALTER TABLE "Card" ALTER COLUMN "status" SET DEFAULT 'UNVERIFIED';

-- AlterTable
ALTER TABLE "Number" ALTER COLUMN "status" SET DEFAULT 'VERIFIED';
