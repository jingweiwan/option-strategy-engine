import type { FastifyInstance } from 'fastify'
import { getQuote, getExpirations, getOptionChain } from '../api/marketdata.js'
import { getIvHistory } from '../api/ivHistory.js'
import type { OptionContract, Quote } from '../api/types.js'

export type TickerResponse = {
  quote: Quote
  expirations: string[]
  expiration: string
  chain: OptionContract[]
}

export async function tickerRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { symbol: string; expiration?: string } }>(
    '/api/ticker',
    async (req, reply) => {
      const { symbol, expiration } = req.query
      if (!symbol) return reply.code(400).send({ error: 'symbol required' })

      const sym = symbol.toUpperCase()
      try {
        // Fetch quote + expirations in parallel
        const [quote, expirations] = await Promise.all([
          getQuote(sym),
          getExpirations(sym)
        ])

        if (expirations.length === 0) {
          return reply.code(502).send({ error: `No expirations for ${sym}` })
        }

        // Pick expiration: explicit > closest >= 21 DTE > first
        let chosen = expiration
        if (!chosen || !expirations.includes(chosen)) {
          const today = Date.now()
          chosen =
            expirations.find((e) => {
              const dte = (new Date(e).getTime() - today) / 86400000
              return dte >= 21
            }) ?? expirations[0]
        }

        const chain = await getOptionChain(sym, chosen)

        const response: TickerResponse = {
          quote,
          expirations,
          expiration: chosen,
          chain
        }
        return response
      } catch (e: any) {
        app.log.error(e)
        return reply.code(502).send({ error: e?.message ?? 'fetch failed' })
      }
    }
  )

  /**
   * GET /api/ticker/iv-history/:symbol
   * Returns the self-accumulated ATM IV history for a symbol.
   * Useful for charting IV trend and understanding IVR basis.
   */
  app.get<{ Params: { symbol: string } }>(
    '/api/ticker/iv-history/:symbol',
    async (req, reply) => {
      const sym = ((req.params as any).symbol ?? '').toUpperCase().trim()
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) {
        return reply.code(400).send({ error: 'Invalid symbol' })
      }
      return { symbol: sym, history: getIvHistory(sym) }
    }
  )
}
