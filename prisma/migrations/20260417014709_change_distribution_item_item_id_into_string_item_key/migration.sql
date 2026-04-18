/*
  Warnings:

  - You are about to drop the column `itemID` on the `DistributionItem` table. All the data in the column will be lost.
  - Added the required column `itemKey` to the `DistributionItem` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "DistributionItem" DROP CONSTRAINT "DistributionItem_itemID_fkey";

-- AlterTable
ALTER TABLE "DistributionItem" DROP COLUMN "itemID",
ADD COLUMN     "itemKey" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "DistributionItem" ADD CONSTRAINT "DistributionItem_itemKey_fkey" FOREIGN KEY ("itemKey") REFERENCES "Card"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
