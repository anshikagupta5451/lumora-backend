import express from 'express'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/requireAuth'
import { awardBounty } from '../lib/bounties'

const router = express.Router()

router.post('/', requireAuth, async (req, res) => {
  const userId = req.userId!
  const { skinType, concerns, sensitivities, goals, climateZone } = req.body

  const profile = await prisma.skinProfile.upsert({
    where: { userId },
    update: { skinType, concerns, sensitivities, goals, climateZone },
    create: { userId, skinType, concerns, sensitivities, goals, climateZone },
  })

  await awardBounty(userId, 'skin_assessment')

  res.json(profile)
})

router.patch('/budget', requireAuth, async (req, res) => {
  const userId = req.userId!
  const { monthlyBudget } = req.body

  if (typeof monthlyBudget !== 'number' || monthlyBudget < 0) {
    return res.status(400).json({ error: 'monthlyBudget must be a non-negative number' })
  }

  try {
    const profile = await prisma.skinProfile.update({ where: { userId }, data: { monthlyBudget } })
    res.json(profile)
  } catch {
    res.status(404).json({ error: 'Complete your skin assessment first' })
  }
})

router.get('/me', requireAuth, async (req, res) => {
  const profile = await prisma.skinProfile.findUnique({ where: { userId: req.userId! } })
  if (!profile) return res.status(404).json({ error: 'No skin profile yet' })
  res.json(profile)
})

export default router