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

router.get('/me', requireAuth, async (req, res) => {
  const profile = await prisma.skinProfile.findUnique({ where: { userId: req.userId! } })
  if (!profile) return res.status(404).json({ error: 'No skin profile yet' })
  res.json(profile)
})

export default router