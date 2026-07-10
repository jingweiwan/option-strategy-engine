import type { FastifyInstance } from 'fastify'
import { runSellPutScan } from '../engine/sellPutScanner.js'
import { parseWatchlistSymbolsQuery } from '../watchlistDefaults.js'

export async function sellPutRoutes(app: FastifyInstance) {
  /**
   * GET /api/sell-put?symbols=AAPL,NVDA,...
   *
   * Scans watchlist for optimal sell-put (short put) candidates.
   * Returns candidates ranked by TastyTrade-style composite score.
   */
  app.get('/api/sell-put', async (req, reply) => {
    try {
      const raw = req.query as { symbols?: string | string[] }
      const wl = parseWatchlistSymbolsQuery(raw.symbols)
      return await runSellPutScan(wl)
    } catch (e) {
      const msg = (e as Error).message
      app.log.warn({ err: msg }, '[sell-put] scan failed')
      return reply.code(502).send({
        error: 'Sell put 扫描失败',
        detail: msg
      })
    }
  })
}
