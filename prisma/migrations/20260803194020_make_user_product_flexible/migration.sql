-- DropForeignKey
ALTER TABLE "UserProduct" DROP CONSTRAINT "UserProduct_productId_fkey";

-- AlterTable
ALTER TABLE "UserProduct" ADD COLUMN     "customBrand" TEXT,
ADD COLUMN     "customName" TEXT,
ADD COLUMN     "quantityLeft" DOUBLE PRECISION,
ADD COLUMN     "quantityTotal" DOUBLE PRECISION,
ADD COLUMN     "quantityUnit" TEXT,
ALTER COLUMN "productId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "UserProduct" ADD CONSTRAINT "UserProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
