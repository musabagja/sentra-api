/*
  Warnings:

  - You are about to drop the `_AccessToUser` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `circleCode` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CircleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ItemStatus" ADD VALUE 'DELIVERY';
ALTER TYPE "ItemStatus" ADD VALUE 'OPNAME';

-- DropForeignKey
ALTER TABLE "_AccessToUser" DROP CONSTRAINT "_AccessToUser_A_fkey";

-- DropForeignKey
ALTER TABLE "_AccessToUser" DROP CONSTRAINT "_AccessToUser_B_fkey";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "circleCode" TEXT NOT NULL,
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- DropTable
DROP TABLE "_AccessToUser";

-- CreateTable
CREATE TABLE "OpnameSubmittance" (
    "id" SERIAL NOT NULL,
    "opnameID" INTEGER NOT NULL,
    "userCode" TEXT NOT NULL,
    "signURL" TEXT,
    "picSignURL" TEXT,
    "picName" TEXT,
    "documentationURL" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpnameSubmittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpnameSubmittanceDocumentation" (
    "id" SERIAL NOT NULL,
    "submittanceID" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpnameSubmittanceDocumentation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Circle" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "CircleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Circle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckpointCircle" (
    "id" SERIAL NOT NULL,
    "checkpointCode" TEXT NOT NULL,
    "circleCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckpointCircle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpnameSubmittance_opnameID_key" ON "OpnameSubmittance"("opnameID");

-- CreateIndex
CREATE UNIQUE INDEX "Circle_code_key" ON "Circle"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CheckpointCircle_checkpointCode_circleCode_key" ON "CheckpointCircle"("checkpointCode", "circleCode");

-- CreateIndex
CREATE INDEX "CardStock_checkpointCode_idx" ON "CardStock"("checkpointCode");

-- CreateIndex
CREATE INDEX "Session_userCode_idx" ON "Session"("userCode");

-- AddForeignKey
ALTER TABLE "Merge" ADD CONSTRAINT "Merge_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeAdditional" ADD CONSTRAINT "MergeAdditional_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardMovement" ADD CONSTRAINT "CardMovement_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberMovement" ADD CONSTRAINT "NumberMovement_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionSubmittance" ADD CONSTRAINT "DistributionSubmittance_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opname" ADD CONSTRAINT "Opname_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opname" ADD CONSTRAINT "Opname_checkpointCode_fkey" FOREIGN KEY ("checkpointCode") REFERENCES "Checkpoint"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpnameSubmittance" ADD CONSTRAINT "OpnameSubmittance_opnameID_fkey" FOREIGN KEY ("opnameID") REFERENCES "Opname"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpnameSubmittance" ADD CONSTRAINT "OpnameSubmittance_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpnameSubmittanceDocumentation" ADD CONSTRAINT "OpnameSubmittanceDocumentation_submittanceID_fkey" FOREIGN KEY ("submittanceID") REFERENCES "OpnameSubmittance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpnameUpdate" ADD CONSTRAINT "OpnameUpdate_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_circleCode_fkey" FOREIGN KEY ("circleCode") REFERENCES "Circle"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointCircle" ADD CONSTRAINT "CheckpointCircle_checkpointCode_fkey" FOREIGN KEY ("checkpointCode") REFERENCES "Checkpoint"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointCircle" ADD CONSTRAINT "CheckpointCircle_circleCode_fkey" FOREIGN KEY ("circleCode") REFERENCES "Circle"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
