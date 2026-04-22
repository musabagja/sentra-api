-- CreateEnum
CREATE TYPE "UploadBatchStatus" AS ENUM ('ONGOING', 'COMPLETED');

-- AlterTable
ALTER TABLE "UploadBatch" ADD COLUMN     "status" "UploadBatchStatus" NOT NULL DEFAULT 'ONGOING',
ADD COLUMN     "total" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "UploadBatchProgress" (
    "id" SERIAL NOT NULL,
    "batchCode" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadBatchProgress_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "UploadBatchProgress" ADD CONSTRAINT "UploadBatchProgress_batchCode_fkey" FOREIGN KEY ("batchCode") REFERENCES "UploadBatch"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
