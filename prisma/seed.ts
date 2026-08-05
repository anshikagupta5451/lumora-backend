import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const products = [
  {
    name: "Gentle Foaming Cleanser",
    brand: "CeraVe",
    category: "cleanser",
    ingredients: ["ceramides", "hyaluronic acid"],
    price: 450,
    imageUrl: null,
  },
  {
    name: "Salicylic Acid 2% Cleanser",
    brand: "The Ordinary",
    category: "cleanser",
    ingredients: ["salicylic acid"],
    price: 550,
    imageUrl: null,
  },
  {
    name: "Niacinamide 10% + Zinc 1%",
    brand: "The Ordinary",
    category: "serum",
    ingredients: ["niacinamide", "zinc"],
    price: 700,
    imageUrl: null,
  },
  {
    name: "Hyaluronic Acid Serum",
    brand: "Minimalist",
    category: "serum",
    ingredients: ["hyaluronic acid"],
    price: 650,
    imageUrl: null,
  },
  {
    name: "Vitamin C Serum 15%",
    brand: "Dot & Key",
    category: "serum",
    ingredients: ["vitamin c", "ferulic acid"],
    price: 900,
    imageUrl: null,
  },
  {
    name: "Oil-Free Moisturizer",
    brand: "Neutrogena",
    category: "moisturizer",
    ingredients: ["glycerin"],
    price: 400,
    imageUrl: null,
  },
  {
    name: "Ceramide Moisturizing Cream",
    brand: "CeraVe",
    category: "moisturizer",
    ingredients: ["ceramides", "petrolatum"],
    price: 550,
    imageUrl: null,
  },
  {
    name: "Ultra Light Gel Moisturizer",
    brand: "Minimalist",
    category: "moisturizer",
    ingredients: ["hyaluronic acid", "squalane"],
    price: 500,
    imageUrl: null,
  },
  {
    name: "Sunscreen SPF 50 PA++++",
    brand: "La Shield",
    category: "sunscreen",
    ingredients: ["zinc oxide"],
    price: 600,
    imageUrl: null,
  },
  {
    name: "Matte Sunscreen SPF 50",
    brand: "Dot & Key",
    category: "sunscreen",
    ingredients: ["titanium dioxide"],
    price: 650,
    imageUrl: null,
  },
  {
    name: "Hydrating Toner",
    brand: "Simple",
    category: "toner",
    ingredients: ["glycerin", "vitamin b5"],
    price: 350,
    imageUrl: null,
  },
  {
    name: "Exfoliating BHA Toner",
    brand: "Paula's Choice",
    category: "toner",
    ingredients: ["salicylic acid"],
    price: 1800,
    imageUrl: null,
  },
];

const ingredients = [
  {
    name: "Niacinamide",
    description:
      "A form of vitamin B3 that helps regulate oil production, minimize pores, and even out skin tone.",
    goodFor: ["acne", "oiliness", "dullness"],
    category: "active",
  },
  {
    name: "Hyaluronic Acid",
    description:
      "A humectant that draws water into the skin, providing intense hydration without heaviness.",
    goodFor: ["dryness", "hydration"],
    category: "hydrator",
  },
  {
    name: "Salicylic Acid",
    description:
      "A BHA that exfoliates inside pores, making it effective for acne and blackheads.",
    goodFor: ["acne", "texture"],
    category: "exfoliant",
  },
  {
    name: "Vitamin C",
    description:
      "An antioxidant that brightens skin, fades dark spots, and protects against environmental damage.",
    goodFor: ["dullness", "pigmentation"],
    category: "active",
  },
  {
    name: "Retinol",
    description:
      "A vitamin A derivative that speeds up cell turnover, reducing fine lines and improving texture over time.",
    goodFor: ["anti-aging", "texture"],
    category: "active",
  },
  {
    name: "Ceramides",
    description:
      "Lipids that restore and strengthen the skin barrier, locking in moisture and reducing sensitivity.",
    goodFor: ["dryness", "sensitivity"],
    category: "hydrator",
  },
  {
    name: "Zinc Oxide",
    description:
      "A mineral sunscreen agent that physically blocks UV rays without irritating sensitive skin.",
    goodFor: ["sun protection", "sensitivity"],
    category: "sunscreen agent",
  },
  {
    name: "Glycerin",
    description:
      "A gentle humectant found in most moisturizers, helping skin retain water and stay soft.",
    goodFor: ["dryness", "hydration"],
    category: "hydrator",
  },
  {
    name: "Ferulic Acid",
    description:
      "An antioxidant often paired with Vitamin C to boost its stability and effectiveness against free radicals.",
    goodFor: ["dullness", "anti-aging"],
    category: "active",
  },
  {
    name: "Squalane",
    description:
      "A lightweight, non-greasy oil that mimics skin's natural sebum, softening and hydrating without clogging pores.",
    goodFor: ["dryness", "hydration"],
    category: "hydrator",
  },
];

async function main() {
  for (const p of products) {
    await prisma.product.create({ data: p });
  }
  console.log(`Seeded ${products.length} products`);

  await prisma.ingredient.createMany({ data: ingredients });
  console.log(`Seeded ${ingredients.length} ingredients`);

  const allProducts = await prisma.product.findMany();
  const testUser = await prisma.user.findFirst();

  if (testUser && allProducts.length > 6 && allProducts[0] && allProducts[2] && allProducts[6]) {
    await prisma.review.createMany({
      data: [
        {
          productId: allProducts[0].id,
          userId: testUser.id,
          rating: 5,
          title: "Holy grail cleanser",
          comment: "Cleared my acne in 3 weeks, no dryness at all.",
          skinType: "oily",
          concerns: ["acne"],
          isVerifiedPurchase: true,
        },
        {
          productId: allProducts[2].id,
          userId: testUser.id,
          rating: 4,
          title: "Good but slow results",
          comment: "Took about 2 months to see real brightening, but worth it.",
          skinType: "combo",
          concerns: ["dullness", "pigmentation"],
          isAnonymous: true,
        },
        {
          productId: allProducts[6].id,
          userId: testUser.id,
          rating: 3,
          title: "Decent, a bit heavy",
          comment: "Great hydration but felt slightly heavy under makeup.",
          skinType: "dry",
          concerns: ["hydration"],
        },
      ],
    });
    console.log("Seeded 3 reviews");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
