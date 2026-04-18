/*
  Warnings:

  - Added the required column `userCode` to the `UploadBatch` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Card" ALTER COLUMN "batchCode" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Number" ALTER COLUMN "batchCode" DROP DEFAULT;

-- AlterTable
ALTER TABLE "UploadBatch" ADD COLUMN     "userCode" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
