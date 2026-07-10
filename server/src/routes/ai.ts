import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getMarketNarrative, type MarketSnapshot } from '../ai/marketNarrative.js'
import { mergeLiveMacroIntoSnapshot } from '../ai/liveMacro.js'

export async function aiRoutes(app: FastifyInstance) {
  app.post('/api/ai/dashboard-narrative', async (req: FastifyRequest<{ Body: MarketSnapshot }>, reply) => {
    const snap = req.body
    if (!snap?.spy || !snap?.vixy) {
      return reply.code(400).send({ error: 'snapshot must include spy and vixy' })
    }
    try {
      const merged = await mergeLiveMacroIntoSnapshot(snap)
      return await getMarketNarrative(merged)
    } catch (e: any) {
      app.log.error(e)
      return reply.code(502).send({ error: e?.message ?? 'ai failed' })
    }
  })
}
