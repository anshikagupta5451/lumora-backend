import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const bounties = [
  {
    key: "skin_assessment",
    title: "Complete your skin assessment",
    description: "Answer the skin quiz so we can personalize your routine.",
    rewardPoints: 50,
  },
  {
    key: "checkin_streak_3",
    title: "3-day check-in streak",
    description: "Check in three days in a row to earn this bounty.",
    rewardPoints: 30,
  },
  {
    key: "first_review",
    title: "Write your first review",
    description: "Share your experience with a product you've tried.",
    rewardPoints: 25,
  },
  {
    key: "first_routine",
    title: "Build your first routine",
    description: "Add at least one product to a morning or evening routine.",
    rewardPoints: 20,
  },
  {
    key: "community_post",
    title: "Post in the community",
    description: "Share a tip, question, or story with the community.",
    rewardPoints: 15,
  },
];

async function main() {
  for (const b of bounties) {
    const existing = await prisma.bounty.findFirst({
      where: { title: b.title },
    });
    if (existing) {
      await prisma.bounty.update({ where: { id: existing.id }, data: { key: b.key } });
    } else {
      await prisma.bounty.create({ data: b });
    }
  }
  console.log(`Seeded ${bounties.length} bounties`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
