import express from 'express'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/requireAuth'

const router = express.Router()

router.post('/:id/log', requireAuth, async (req, res) => {
  const { completed } = req.body
  const id = String(req.params.id)

  const step = await prisma.routineStep.update({
    where: { id },
    data: { completedToday: Boolean(completed) },
  })

  res.json(step)
})

export default router