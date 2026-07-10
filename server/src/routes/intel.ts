import type { FastifyInstance } from 'fastify'
import { parseWatchlistSymbolsQuery } from '../watchlistDefaults.js'
import { generateDailyBrief } from '../intel/briefGenerator.js'
import { generateDeepAnalysis } from '../intel/deepAnalysis.js'

export async function intelRoutes(app: FastifyInstance) {
  app.get('/api/intel/daily', async (req, reply) => {
    try {
      const raw = req.query as { symbols?: string | string[] }
      const wl = parseWatchlistSymbolsQuery(raw.symbols)
      const symbols = wl.map((e) => e.sym)
      return await generateDailyBrief(symbols)
    } catch (e) {
      const msg = (e as Error).message
      app.log.warn({ err: msg }, '[intel] daily brief failed')
      return reply.code(502).send({
        error: '情报摘要生成失败',
        detail: msg
      })
    }
  })

  app.get('/api/intel/deep/:symbol', async (req, reply) => {
    try {
      const { symbol } = req.params as { symbol: string }
      const sym = (symbol ?? '').toUpperCase().trim()
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) {
        return reply.code(400).send({ error: 'Invalid symbol' })
      }
      return await generateDeepAnalysis(sym)
    } catch (e) {
      const msg = (e as Error).message
      app.log.warn({ err: msg }, '[intel] deep analysis failed')
      return reply.code(502).send({
        error: 'OCIFQ 深度分析失败',
        detail: msg
      })
    }
  })
}
