import express from 'express'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/requireAuth'
import { awardBounty } from '../lib/bounties'

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

router.post('/', requireAuth, async (req, res) => {
  const { productId, newProduct, rating, comment, skinType, concerns, isAnonymous } = req.body

  if (!rating || !comment) {
    return res.status(400).json({ error: 'Rating and comment are required' })
  }

  let finalProductId = productId

  // Support creating a brand-new product inline, same as your Next.js "new" source flow
  if (!finalProductId && newProduct?.name && newProduct?.brand) {
    const created = await prisma.product.create({
      data: {
        name: newProduct.name,
        brand: newProduct.brand,
        category: newProduct.category || 'skincare',
        ingredients: [],
        price: 0,
      },
    })
    finalProductId = created.id
  }

  if (!finalProductId) {
    return res.status(400).json({ error: 'A product must be selected or created' })
  }

  const review = await prisma.review.create({
    data: {
      productId: finalProductId,
      userId: req.userId!,
      rating,
      comment,
      skinType: skinType || null,
      concerns: concerns || [],
      isAnonymous: Boolean(isAnonymous),
    },
    include: {
      product: { select: { id: true, name: true, brand: true, category: true } },
      user: { select: { id: true, name: true } },
    },
  })

  await awardBounty(req.userId!, 'first_review')

  res.status(201).json(review)
})

export default router