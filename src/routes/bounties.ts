import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const userId = req.userId!;

  const [bounties, completions] = await Promise.all([
    prisma.bounty.findMany({
      where: {
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.bountyCompletion.findMany({ where: { userId } }),
  ]);

  const completedBountyIds = new Set(completions.map((c) => c.bountyId));
  const totalPoints = completions.reduce((sum, c) => {
    const bounty = bounties.find((b) => b.id === c.bountyId);
    return sum + (bounty?.rewardPoints || 0);
  }, 0);

  res.json({
    bounties: bounties.map((b) => ({
      ...b,
      completed: completedBountyIds.has(b.id),
    })),
    totalPoints,
  });
});

router.post("/:id/complete", requireAuth, async (req, res) => {
  const userId = req.userId!;
  const id = String(req.params.id);

  const bounty = await prisma.bounty.findUnique({ where: { id } });
  if (!bounty || !bounty.active) {
    return res.status(404).json({ error: "Bounty not found" });
  }
  if (bounty.expiresAt && bounty.expiresAt < new Date()) {
    return res.status(400).json({ error: "Bounty has expired" });
  }

  const completion = await prisma.bountyCompletion.upsert({
    where: { userId_bountyId: { userId, bountyId: id } },
    create: { userId, bountyId: id },
    update: {},
  });

  res.status(201).json(completion);
});

export default router;
