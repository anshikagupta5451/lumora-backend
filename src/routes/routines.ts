import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { awardBounty } from "../lib/bounties";

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
  const routines = await prisma.routine.findMany({
    where: { userId: req.userId! },
    include: {
      steps: {
        include: { product: { select: { id: true, name: true } } },
        orderBy: { stepOrder: "asc" },
      },
    },
  });

  const formatted = routines.map((r) => ({
    id: r.id,
    name: r.name,
    timeOfDay: r.timeOfDay,
    steps: r.steps.map((s) => ({
      id: s.id,
      productId: s.productId,
      productName: s.product.name,
      stepOrder: s.stepOrder,
      completed: s.completedToday,
    })),
  }));

  res.json(formatted);
});

router.post("/", requireAuth, async (req, res) => {
  const { name, timeOfDay, productIds } = req.body;

  if (
    !name ||
    !timeOfDay ||
    !Array.isArray(productIds) ||
    productIds.length === 0
  ) {
    return res
      .status(400)
      .json({ error: "name, timeOfDay, and productIds are required" });
  }

  const routine = await prisma.routine.create({
    data: {
      userId: req.userId!,
      name,
      timeOfDay,
      steps: {
        create: productIds.map((productId: string, index: number) => ({
          productId,
          stepOrder: index,
        })),
      },
    },
    include: { steps: { include: { product: true } } },
  });

  await awardBounty(req.userId!, "first_routine");

  res.status(201).json(routine);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);

  const routine = await prisma.routine.findUnique({ where: { id } });
  if (!routine || routine.userId !== req.userId) {
    return res.status(404).json({ error: "Routine not found" });
  }

  // Delete steps first (foreign key constraint), then the routine itself
  await prisma.routineStep.deleteMany({ where: { routineId: id } });
  await prisma.routine.delete({ where: { id } });

  res.json({ success: true });
});

export default router;
