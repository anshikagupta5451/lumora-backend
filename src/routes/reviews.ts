import express from 'express'
import { prisma } from '../lib/prisma'

const router = express.Router()

router.get('/', async (req, res) => {
  const reviews = await prisma.review.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      product: { select: { id: true, name: true, brand: true, category: true } },
      user: { select: { id: true, name: true } },
    },
  })
  res.json(reviews)
})

export default router