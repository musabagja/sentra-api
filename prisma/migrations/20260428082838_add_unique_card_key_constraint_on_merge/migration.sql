/*
  Warnings:

  - A unique constraint covering the columns `[cardKey]` on the table `Merge` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Merge_cardKey_key" ON "Merge"("cardKey");

-- AddForeignKey
ALTER TABLE "Merge" ADD CONSTRAINT "Merge_checkpointCode_fkey" FOREIGN KEY ("checkpointCode") REFERENCES "Checkpoint"("code") ON DELETE SET NULL ON UPDATE CASCADE;
