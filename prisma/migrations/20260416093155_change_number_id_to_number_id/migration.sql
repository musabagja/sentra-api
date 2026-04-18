/*
  Warnings:

  - You are about to drop the column `numberId` on the `NumberMovement` table. All the data in the column will be lost.
  - Added the required column `numberID` to the `NumberMovement` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "NumberMovement" DROP CONSTRAINT "NumberMovement_numberId_fkey";

-- DropIndex
DROP INDEX "NumberMovement_numberId_idx";

-- AlterTable
ALTER TABLE "NumberMovement" DROP COLUMN "numberId",
ADD COLUMN     "numberID" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "NumberMovement_numberID_idx" ON "NumberMovement"("numberID");

-- AddForeignKey
ALTER TABLE "NumberMovement" ADD CONSTRAINT "NumberMovement_numberID_fkey" FOREIGN KEY ("numberID") REFERENCES "Number"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
