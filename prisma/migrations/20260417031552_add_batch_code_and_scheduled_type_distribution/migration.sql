-- AlterEnum
ALTER TYPE "DistributionStatus" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "batchCode" TEXT NOT NULL DEFAULT 'UP000000';

-- AlterTable
ALTER TABLE "Distribution" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Number" ADD COLUMN     "batchCode" TEXT NOT NULL DEFAULT 'UP000000';

-- CreateTable
CREATE TABLE "UploadBatch" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadBatch_code_key" ON "UploadBatch"("code");

-- CreateIndex
CREATE INDEX "Card_batchCode_idx" ON "Card"("batchCode");

-- CreateIndex
CREATE INDEX "Number_batchCode_idx" ON "Number"("batchCode");

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_batchCode_fkey" FOREIGN KEY ("batchCode") REFERENCES "UploadBatch"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Number" ADD CONSTRAINT "Number_batchCode_fkey" FOREIGN KEY ("batchCode") REFERENCES "UploadBatch"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
