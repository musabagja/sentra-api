/*
  Warnings:

  - The values [RUNNING] on the enum `OpnameStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "OpnameStatus_new" AS ENUM ('ONGOING', 'COMPLETED', 'CANCELLED');
ALTER TABLE "Opname" ALTER COLUMN "status" TYPE "OpnameStatus_new" USING ("status"::text::"OpnameStatus_new");
ALTER TYPE "OpnameStatus" RENAME TO "OpnameStatus_old";
ALTER TYPE "OpnameStatus_new" RENAME TO "OpnameStatus";
DROP TYPE "public"."OpnameStatus_old";
COMMIT;
