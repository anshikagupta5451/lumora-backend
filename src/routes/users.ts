import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { id: true, name: true, email: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

router.patch("/me", requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) {
    return res
      .status(400)
      .json({ error: "Name must be at least 2 characters" });
  }

  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: { name: name.trim() },
    select: { id: true, name: true, email: true },
  });

  res.json(user);
});

router.post("/push-token", requireAuth, async (req, res) => {
  const { pushToken } = req.body;
  if (!pushToken) return res.status(400).json({ error: "pushToken required" });

  await prisma.user.update({
    where: { id: req.userId! },
    data: { pushToken },
  });
  res.json({ success: true });
});


router.get('/:id/public', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, name: true, createdAt: true },
  })
  if (!user) return res.status(404).json({ error: 'User not found' })

  const [postCount, reviewCount] = await Promise.all([
    prisma.post.count({ where: { userId: user.id } }),
    prisma.review.count({ where: { userId: user.id } }),
  ])

  res.json({ id: user.id, name: user.name, memberSince: user.createdAt, postCount, reviewCount })
})

export default router;
