import { prisma } from "./prisma";

// Marks a bounty complete for a user, identified by its stable `key` rather
// than title (titles are just display copy and can change independently).
// A missing/inactive/expired bounty, or one already completed, is a no-op.
export async function awardBounty(userId: string, key: string) {
  const bounty = await prisma.bounty.findUnique({ where: { key } });
  if (!bounty || !bounty.active) return;
  if (bounty.expiresAt && bounty.expiresAt < new Date()) return;

  await prisma.bountyCompletion.upsert({
    where: { userId_bountyId: { userId, bountyId: bounty.id } },
    create: { userId, bountyId: bounty.id },
    update: {},
  });
}
