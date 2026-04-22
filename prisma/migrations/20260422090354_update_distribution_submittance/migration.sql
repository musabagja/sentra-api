-- CreateTable
CREATE TABLE "DistributionSubmittance" (
    "id" SERIAL NOT NULL,
    "distributionID" INTEGER NOT NULL,
    "userCode" TEXT NOT NULL,
    "longitude" DOUBLE PRECISION,
    "latitude" DOUBLE PRECISION,
    "signURL" TEXT,
    "imageURL" TEXT,
    "storeURL" TEXT,
    "note" TEXT,
    "recipientName" TEXT,
    "recipientURL" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributionSubmittance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DistributionSubmittance_distributionID_key" ON "DistributionSubmittance"("distributionID");

-- CreateIndex
CREATE INDEX "DistributionSubmittance_distributionID_idx" ON "DistributionSubmittance"("distributionID");

-- AddForeignKey
ALTER TABLE "DistributionSubmittance" ADD CONSTRAINT "DistributionSubmittance_distributionID_fkey" FOREIGN KEY ("distributionID") REFERENCES "Distribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
