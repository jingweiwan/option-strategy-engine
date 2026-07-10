import type { FastifyInstance } from 'fastify'
import { getQuote, getExpirations, getOptionChain } from '../api/marketdata.js'

export async function chainRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { symbol: string } }>('/api/quote', async (req, reply) => {
    const { symbol } = req.query
    if (!symbol) return reply.code(400).send({ error: 'symbol required' })
    try {
      const q = await getQuote(symbol.toUpperCase())
      return q
    } catch (e: any) {
      return reply.code(502).send({ error: e.message })
    }
  })

  app.get<{ Querystring: { symbol: string } }>('/api/expirations', async (req, reply) => {
    const { symbol } = req.query
    if (!symbol) return reply.code(400).send({ error: 'symbol required' })
    try {
      const exp = await getExpirations(symbol.toUpperCase())
      return { expirations: exp }
    } catch (e: any) {
      return reply.code(502).send({ error: e.message })
    }
  })

  app.get<{ Querystring: { symbol: string; expiration: string } }>(
    '/api/chain',
    async (req, reply) => {
      const { symbol, expiration } = req.query
      if (!symbol || !expiration) {
        return reply.code(400).send({ error: 'symbol and expiration required' })
      }
      try {
        const chain = await getOptionChain(symbol.toUpperCase(), expiration)
        return { chain }
      } catch (e: any) {
        return reply.code(502).send({ error: e.message })
      }
    }
  )
}
