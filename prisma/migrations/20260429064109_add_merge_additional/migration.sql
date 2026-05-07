/*
  Warnings:

  - You are about to drop the column `type` on the `Merge` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Merge" DROP COLUMN "type";

-- CreateTable
CREATE TABLE "MergeAdditional" (
    "id" SERIAL NOT NULL,
    "numberKey" TEXT NOT NULL,
    "cardKey" TEXT NOT NULL,
    "remark" TEXT,
    "checkpointCode" TEXT,
    "userCode" TEXT NOT NULL,
    "TRN" TEXT,
    "type" TEXT,
    "soldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "MergeAdditional_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MergeAdditional_numberKey_key" ON "MergeAdditional"("numberKey");

-- CreateIndex
CREATE UNIQUE INDEX "MergeAdditional_cardKey_key" ON "MergeAdditional"("cardKey");

-- CreateIndex
CREATE INDEX "MergeAdditional_soldAt_idx" ON "MergeAdditional"("soldAt");

-- AddForeignKey
ALTER TABLE "Merge" ADD CONSTRAINT "Merge_cardKey_fkey" FOREIGN KEY ("cardKey") REFERENCES "Card"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeAdditional" ADD CONSTRAINT "MergeAdditional_checkpointCode_fkey" FOREIGN KEY ("checkpointCode") REFERENCES "Checkpoint"("code") ON DELETE SET NULL ON UPDATE CASCADE;
