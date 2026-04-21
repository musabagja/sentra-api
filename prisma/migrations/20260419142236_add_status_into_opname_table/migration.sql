/*
  Warnings:

  - Added the required column `status` to the `Opname` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OpnameStatus" AS ENUM ('RUNNING', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Opname" ADD COLUMN     "status" "OpnameStatus" NOT NULL;
