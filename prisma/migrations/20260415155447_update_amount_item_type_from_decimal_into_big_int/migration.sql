/*
  Warnings:

  - You are about to alter the column `amount` on the `CardStock` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `BigInt`.
  - You are about to alter the column `amount` on the `Distribution` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `BigInt`.
  - You are about to alter the column `amount` on the `Opname` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `BigInt`.

*/
-- AlterTable
ALTER TABLE "CardStock" ALTER COLUMN "amount" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "Distribution" ALTER COLUMN "amount" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "Opname" ALTER COLUMN "amount" SET DATA TYPE BIGINT;

-- AddForeignKey
ALTER TABLE "CardMovement" ADD CONSTRAINT "CardMovement_sourceCode_fkey" FOREIGN KEY ("sourceCode") REFERENCES "Checkpoint"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardMovement" ADD CONSTRAINT "CardMovement_targetCode_fkey" FOREIGN KEY ("targetCode") REFERENCES "Checkpoint"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberMovement" ADD CONSTRAINT "NumberMovement_sourceCode_fkey" FOREIGN KEY ("sourceCode") REFERENCES "Checkpoint"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberMovement" ADD CONSTRAINT "NumberMovement_targetCode_fkey" FOREIGN KEY ("targetCode") REFERENCES "Checkpoint"("code") ON DELETE SET NULL ON UPDATE CASCADE;
