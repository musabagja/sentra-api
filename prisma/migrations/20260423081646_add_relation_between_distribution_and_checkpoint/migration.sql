-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_sourceCode_fkey" FOREIGN KEY ("sourceCode") REFERENCES "Checkpoint"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_targetCode_fkey" FOREIGN KEY ("targetCode") REFERENCES "Checkpoint"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
