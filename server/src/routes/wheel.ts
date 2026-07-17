import type { FastifyInstance } from 'fastify'
import { runWheelScan } from '../engine/wheelScanner.js'
import { parseWatchlistSymbolsQuery } from '../watchlistDefaults.js'

export async function wheelRoutes(app: FastifyInstance) {
  /**
   * GET /api/wheel?symbols=AAPL,NVDA,...
   *
   * Wheel-strategy recommendations: fundamentals-gated cash-secured puts
   * (assignment-ready, earnings-free, sized against real account cash) plus
   * covered-call suggestions on held 100-share lots (strike never below cost).
   */
  app.get('/api/wheel', async (req, reply) => {
    try {
      const raw = req.query as { symbols?: string | string[] }
      const wl = parseWatchlistSymbolsQuery(raw.symbols)
      return await runWheelScan(wl)
    } catch (e) {
      const msg = (e as Error).message
      app.log.warn({ err: msg }, '[wheel] scan failed')
      return reply.code(502).send({ error: '轮子扫描失败', detail: msg })
    }
  })
}
