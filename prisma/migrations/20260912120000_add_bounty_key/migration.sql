-- AlterTable
ALTER TABLE "Bounty" ADD COLUMN "key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Bounty_key_key" ON "Bounty"("key");
