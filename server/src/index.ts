import './env.js' // side-effect: loads .env into process.env BEFORE other imports

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import { strategiesLiveRoutes } from './routes/strategiesLive.js'
import { chainRoutes } from './routes/chain.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { tickerRoutes } from './routes/ticker.js'
import { aiRoutes } from './routes/ai.js'
import { feedbackRoutes } from './routes/feedback.js'
import { rhRoutes } from './routes/rh.js'
import { symbolSearchRoutes } from './routes/symbolSearch.js'
import { watchlistDefaultRoutes } from './routes/watchlistDefault.js'
import { sellPutRoutes } from './routes/sellPut.js'
import { wheelRoutes } from './routes/wheel.js'
import { intelRoutes } from './routes/intel.js'
import { startAiWarmer } from './ai/scheduler.js'

const port = Number(process.env.PORT ?? 3001)

const app = Fastify({ logger: true })

await app.register(strategiesLiveRoutes)
await app.register(chainRoutes)
await app.register(dashboardRoutes)
await app.register(tickerRoutes)
await app.register(aiRoutes)
await app.register(feedbackRoutes)
await app.register(rhRoutes)
await app.register(symbolSearchRoutes)
await app.register(watchlistDefaultRoutes)
await app.register(sellPutRoutes)
await app.register(wheelRoutes)
await app.register(intelRoutes)

app.get('/health', async () => ({ ok: true }))

// ---------- Production: serve Vue SPA static files ----------
// In production, the built client lives at ../client/dist relative to
// the server root. Fastify serves it so everything is same-origin (no CORS).
const clientDist = resolve(process.cwd(), '..', 'client', 'dist')
if (existsSync(clientDist)) {
  const fastifyStatic = await import('@fastify/static')
  await app.register(fastifyStatic.default, {
    root: clientDist,
    prefix: '/',
    wildcard: false // don't override API routes
  })
  // SPA fallback: any non-API, non-file path → index.html
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return reply.sendFile('index.html')
  })
  console.log(`[static] serving Vue SPA from ${clientDist}`)
}

try {
  await app.listen({ port, host: '0.0.0.0' })
  // Pre-warm AI caches in the background — never blocks listen
  startAiWarmer()
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
