-- CreateTable
CREATE TABLE "FaceScan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "concerns" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaceScan_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "FaceScan" ADD CONSTRAINT "FaceScan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
