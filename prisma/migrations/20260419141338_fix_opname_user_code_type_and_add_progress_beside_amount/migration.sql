/*
  Warnings:

  - Added the required column `progress` to the `Opname` table without a default value. This is not possible if the table is not empty.
  - Made the column `batch` on table `Opname` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Opname" ADD COLUMN     "progress" INTEGER NOT NULL,
ALTER COLUMN "batch" SET NOT NULL,
ALTER COLUMN "userCode" SET DATA TYPE TEXT;
