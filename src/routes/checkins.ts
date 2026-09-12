import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { awardBounty } from "../lib/bounties";

const router = express.Router();

async function getCurrentStreak(userId: string) {
  const checkIns = await prisma.checkIn.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  const dayStrings = new Set(
    checkIns.map((c) => {
      const d = new Date(c.createdAt);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }),
  );

  while (dayStrings.has(cursor.toISOString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

router.post("/", requireAuth, async (req, res) => {
  const { mood, note } = req.body;
  if (!mood || mood < 1 || mood > 5) {
    return res.status(400).json({ error: "Mood must be between 1 and 5" });
  }

  const checkIn = await prisma.checkIn.create({
    data: { userId: req.userId!, mood, note: note || null },
  });

  const streak = await getCurrentStreak(req.userId!);
  if (streak >= 3) {
    await awardBounty(req.userId!, "checkin_streak_3");
  }

  res.status(201).json(checkIn);
});

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

router.patch("/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const { mood, note } = req.body;

  const checkIn = await prisma.checkIn.findUnique({ where: { id } });
  if (!checkIn || checkIn.userId !== req.userId) {
    return res.status(404).json({ error: "Check-in not found" });
  }
  if (!isSameDay(new Date(checkIn.createdAt), new Date())) {
    return res.status(400).json({ error: "Only today's check-in can be edited" });
  }
  if (mood !== undefined && (mood < 1 || mood > 5)) {
    return res.status(400).json({ error: "Mood must be between 1 and 5" });
  }

  const updated = await prisma.checkIn.update({
    where: { id },
    data: {
      ...(mood !== undefined ? { mood } : {}),
      ...(note !== undefined ? { note: note || null } : {}),
    },
  });
  res.json(updated);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);

  const checkIn = await prisma.checkIn.findUnique({ where: { id } });
  if (!checkIn || checkIn.userId !== req.userId) {
    return res.status(404).json({ error: "Check-in not found" });
  }

  await prisma.checkIn.delete({ where: { id } });
  res.json({ success: true });
});

router.get("/streak", requireAuth, async (req, res) => {
  const checkIns = await prisma.checkIn.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  // Calculate consecutive-day streak
  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  const dayStrings = new Set(
    checkIns.map((c) => {
      const d = new Date(c.createdAt);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }),
  );

  while (dayStrings.has(cursor.toISOString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  res.json({ streak, totalCheckIns: checkIns.length });
});

router.get("/today", requireAuth, async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const checkIn = await prisma.checkIn.findFirst({
    where: { userId: req.userId!, createdAt: { gte: startOfDay } },
    orderBy: { createdAt: "desc" },
  });
  res.json(checkIn || null);
});

router.get("/history", requireAuth, async (req, res) => {
  const checkIns = await prisma.checkIn.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
    take: 30, // last 30 check-ins
  });
  res.json(checkIns);
});

router.get("/stats", requireAuth, async (req, res) => {
  const userId = req.userId!;

  const [streakData, totalCheckIns, userProducts, reviewCount] =
    await Promise.all([
      prisma.checkIn.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.checkIn.count({ where: { userId } }),
      prisma.userProduct.findMany({ where: { userId } }),
      prisma.review.count({ where: { userId } }),
    ]);

  // Streak calculation (same logic as /streak)
  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const dayStrings = new Set(
    streakData.map((c) => {
      const d = new Date(c.createdAt);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }),
  );
  while (dayStrings.has(cursor.toISOString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  res.json({
    streak,
    totalCheckIns,
    productsOpened: userProducts.filter((p) => p.openedAt).length,
    productsTracked: userProducts.length,
    reviewsWritten: reviewCount,
  });
});

export default router;
