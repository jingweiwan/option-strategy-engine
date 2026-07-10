import type { FastifyInstance } from 'fastify'
import { searchStockSymbols } from '../api/finnhub.js'

export async function symbolSearchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>('/api/symbols/search', async (req, reply) => {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    try {
      const results = await searchStockSymbols(q)
      return { results }
    } catch (e: any) {
      app.log.warn({ err: e?.message }, '[symbols/search] finnhub failed')
      return reply.code(502).send({ results: [], error: e?.message ?? 'search failed' })
    }
  })
}
