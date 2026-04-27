/*
  Warnings:

  - Added the required column `userCode` to the `Merge` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Merge" ADD COLUMN     "userCode" TEXT NOT NULL;
