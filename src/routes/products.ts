import express from 'express'
import { prisma } from '../lib/prisma'

const router = express.Router()

router.get('/', async (req, res) => {
  const { category, query } = req.query

  const products = await prisma.product.findMany({
    where: {
      ...(category ? { category: String(category) } : {}),
      ...(query ? { name: { contains: String(query), mode: 'insensitive' } } : {}),
    },
    orderBy: { name: 'asc' },
  })

  res.json(products)
})

router.get('/:id', async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } })
  if (!product) return res.status(404).json({ error: 'Product not found' })
  res.json(product)
})

export default router