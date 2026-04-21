-- CreateTable
CREATE TABLE "_AccessToUser" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_AccessToUser_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_AccessToUser_B_index" ON "_AccessToUser"("B");

-- AddForeignKey
ALTER TABLE "_AccessToUser" ADD CONSTRAINT "_AccessToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "Access"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AccessToUser" ADD CONSTRAINT "_AccessToUser_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
