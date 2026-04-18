-- CreateEnum
CREATE TYPE "CheckpointType" AS ENUM ('DC', 'STORE', 'HQ');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('DELIVERED', 'HOLD');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('INITIAL', 'TRANSFER', 'SALE', 'ADJUSTMENT', 'RETURN');

-- CreateEnum
CREATE TYPE "OpnameItemType" AS ENUM ('ICCID', 'MSISDN');

-- CreateEnum
CREATE TYPE "OpnameConditionStatus" AS ENUM ('OK', 'BROKEN', 'LOST');

-- CreateTable
CREATE TABLE "Checkpoint" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "type" "CheckpointType" NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "key" TEXT NOT NULL,
    "checkpointCode" TEXT NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'AVAILABLE',
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Number" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "key" TEXT NOT NULL,
    "checkpointCode" TEXT,
    "status" "ItemStatus" NOT NULL DEFAULT 'AVAILABLE',
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Number_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merge" (
    "id" SERIAL NOT NULL,
    "numberKey" TEXT NOT NULL,
    "cardKey" TEXT NOT NULL,
    "remark" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardStock" (
    "id" SERIAL NOT NULL,
    "checkpointCode" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardMovement" (
    "id" SERIAL NOT NULL,
    "cardID" INTEGER NOT NULL,
    "type" "MovementType" NOT NULL,
    "userCode" TEXT NOT NULL,
    "sourceCode" INTEGER,
    "targetCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberMovement" (
    "id" SERIAL NOT NULL,
    "numberId" INTEGER NOT NULL,
    "type" "MovementType" NOT NULL,
    "userCode" TEXT NOT NULL,
    "sourceCode" INTEGER,
    "targetCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NumberMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Distribution" (
    "id" SERIAL NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "targetCode" TEXT NOT NULL,
    "batch" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "status" "DistributionStatus" NOT NULL,
    "userCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Distribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionItem" (
    "id" SERIAL NOT NULL,
    "itemID" INTEGER NOT NULL,
    "distributionID" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opname" (
    "id" SERIAL NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "batch" TEXT,
    "type" "OpnameItemType" NOT NULL,
    "checkpointCode" TEXT NOT NULL,
    "userCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Opname_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpnameUpdate" (
    "id" SERIAL NOT NULL,
    "itemID" INTEGER NOT NULL,
    "status" "OpnameConditionStatus" NOT NULL,
    "opnameID" INTEGER NOT NULL,
    "userCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpnameUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "imageURL" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Access" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" SERIAL NOT NULL,
    "userCode" TEXT NOT NULL,
    "accessCode" TEXT NOT NULL,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Checkpoint_code_key" ON "Checkpoint"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Card_key_key" ON "Card"("key");

-- CreateIndex
CREATE INDEX "Card_checkpointCode_idx" ON "Card"("checkpointCode");

-- CreateIndex
CREATE INDEX "Card_status_idx" ON "Card"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Number_key_key" ON "Number"("key");

-- CreateIndex
CREATE INDEX "Number_checkpointCode_idx" ON "Number"("checkpointCode");

-- CreateIndex
CREATE INDEX "Number_status_idx" ON "Number"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Merge_numberKey_key" ON "Merge"("numberKey");

-- CreateIndex
CREATE UNIQUE INDEX "Merge_cardKey_key" ON "Merge"("cardKey");

-- CreateIndex
CREATE INDEX "Merge_soldAt_idx" ON "Merge"("soldAt");

-- CreateIndex
CREATE UNIQUE INDEX "CardStock_checkpointCode_key" ON "CardStock"("checkpointCode");

-- CreateIndex
CREATE INDEX "CardMovement_cardID_idx" ON "CardMovement"("cardID");

-- CreateIndex
CREATE INDEX "CardMovement_createdAt_idx" ON "CardMovement"("createdAt");

-- CreateIndex
CREATE INDEX "NumberMovement_numberId_idx" ON "NumberMovement"("numberId");

-- CreateIndex
CREATE INDEX "NumberMovement_createdAt_idx" ON "NumberMovement"("createdAt");

-- CreateIndex
CREATE INDEX "DistributionItem_distributionID_idx" ON "DistributionItem"("distributionID");

-- CreateIndex
CREATE INDEX "OpnameUpdate_itemID_idx" ON "OpnameUpdate"("itemID");

-- CreateIndex
CREATE UNIQUE INDEX "User_code_key" ON "User"("code");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Access_code_key" ON "Access"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_userCode_accessCode_key" ON "Permission"("userCode", "accessCode");

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_checkpointCode_fkey" FOREIGN KEY ("checkpointCode") REFERENCES "Checkpoint"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Number" ADD CONSTRAINT "Number_checkpointCode_fkey" FOREIGN KEY ("checkpointCode") REFERENCES "Checkpoint"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merge" ADD CONSTRAINT "Merge_numberKey_fkey" FOREIGN KEY ("numberKey") REFERENCES "Number"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merge" ADD CONSTRAINT "Merge_cardKey_fkey" FOREIGN KEY ("cardKey") REFERENCES "Card"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardStock" ADD CONSTRAINT "CardStock_checkpointCode_fkey" FOREIGN KEY ("checkpointCode") REFERENCES "Checkpoint"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardMovement" ADD CONSTRAINT "CardMovement_cardID_fkey" FOREIGN KEY ("cardID") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberMovement" ADD CONSTRAINT "NumberMovement_numberId_fkey" FOREIGN KEY ("numberId") REFERENCES "Number"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionItem" ADD CONSTRAINT "DistributionItem_itemID_fkey" FOREIGN KEY ("itemID") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionItem" ADD CONSTRAINT "DistributionItem_distributionID_fkey" FOREIGN KEY ("distributionID") REFERENCES "Distribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpnameUpdate" ADD CONSTRAINT "OpnameUpdate_opnameID_fkey" FOREIGN KEY ("opnameID") REFERENCES "Opname"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_accessCode_fkey" FOREIGN KEY ("accessCode") REFERENCES "Access"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userCode_fkey" FOREIGN KEY ("userCode") REFERENCES "User"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
