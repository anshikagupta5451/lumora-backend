import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// One-off fix for UserProduct rows created before custom products were
// auto-linked to a Product row (see src/routes/userProducts.ts). Without a
// linked Product, those shelf items are invisible anywhere that references
// products by id — the routine builder's "My products" picker included.
async function main() {
  const orphaned = await prisma.userProduct.findMany({
    where: { productId: null, customName: { not: null } },
  });

  for (const up of orphaned) {
    const product = await prisma.product.create({
      data: {
        name: up.customName!,
        brand: up.customBrand || "Custom",
        category: "skincare",
        ingredients: [],
        price: 0,
      },
    });
    await prisma.userProduct.update({
      where: { id: up.id },
      data: { productId: product.id },
    });
  }

  console.log(`Linked ${orphaned.length} custom product(s) to new catalog entries`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
