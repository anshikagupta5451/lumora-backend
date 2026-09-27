-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "isPromoted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "FaceScan" ADD COLUMN     "webSuggestions" JSONB;
