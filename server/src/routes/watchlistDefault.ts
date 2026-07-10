import type { FastifyInstance } from 'fastify'
import { DEFAULT_WATCHLIST } from '../watchlistDefaults.js'

/**
 * Canonical default watchlist for client + server. Single source: watchlistDefaults.ts
 */
export async function watchlistDefaultRoutes(app: FastifyInstance) {
  app.get('/api/watchlist/default', async () => ({
    entries: DEFAULT_WATCHLIST.map((e) => ({ sym: e.sym, name: e.name }))
  }))
}
