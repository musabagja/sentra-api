-- CreateEnum
CREATE TYPE "MergeType" AS ENUM ('SIMCARD', 'ESIM');

-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'OPNAME';

-- AlterTable
ALTER TABLE "Merge" ADD COLUMN     "TRN" TEXT,
ADD COLUMN     "checkpointCode" TEXT,
ADD COLUMN     "type" TEXT;
