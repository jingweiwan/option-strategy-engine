/**
 * Daily option-chain archiver — the data flywheel for offline strategy tuning.
 *
 * Snapshots each watchlist symbol's FULL CBOE chain (all expirations, IV +
 * greeks, raw vendor payload) to disk once per ET calendar day:
 *
 *   server/data/chains/YYYY-MM-DD/SYM.json.gz
 *
 * Today's engine only stores the legs it actually picked, so historical
 * "what if we had sold the 25-delta instead?" questions are unanswerable.
 * These snapshots make walk-forward parameter replay possible once a few
 * weeks have accumulated. Costs nothing: CBOE is free and one request per
 * symbol per day (~a few hundred KB gzipped each).
 *
 * Design:
 *   - Idempotent per (day, symbol): existing files are skipped, so it can be
 *     triggered by every dashboard build (boot warm, cron, page loads).
 *   - Never throws — archiving must not break the dashboard path.
 *   - Retention pruned to CHAIN_ARCHIVE_KEEP_DAYS (default 365).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { getRawPayload } from './cboe.js'
import { etCalendarDay } from '../ai/cache.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE_DIR = join(__dirname, '..', '..', 'data', 'chains')

const KEEP_DAYS = Math.max(7, Number(process.env.CHAIN_ARCHIVE_KEEP_DAYS) || 365)

/** Pause between symbol fetches — be polite to the free endpoint. */
const FETCH_GAP_MS = 250

let running = false

/**
 * Archive today's chains for `symbols`. Fire-and-forget friendly: resolves
 * quickly when everything is already archived, never throws, and a single
 * in-flight run is enforced so concurrent dashboard builds don't double-fetch.
 */
export async function archiveChains(symbols: string[]): Promise<void> {
  if (running) return
  running = true
  try {
    const day = etCalendarDay()
    const dir = join(BASE_DIR, day)
    const pending = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(
      (sym) => !existsSync(join(dir, `${sym}.json.gz`))
    )
    if (pending.length === 0) return

    mkdirSync(dir, { recursive: true })
    let saved = 0
    for (const sym of pending) {
      try {
        const payload = await getRawPayload(sym)
        const record = { symbol: sym, day, archivedAt: new Date().toISOString(), payload }
        writeFileSync(join(dir, `${sym}.json.gz`), gzipSync(JSON.stringify(record)))
        saved++
      } catch (err) {
        console.warn(`[chainArchive] ${sym} failed: ${(err as Error).message}`)
      }
      await new Promise((r) => setTimeout(r, FETCH_GAP_MS))
    }
    if (saved > 0) {
      console.log(`[chainArchive] ${day}: archived ${saved}/${pending.length} chains`)
      prune()
    }
  } finally {
    running = false
  }
}

/** Delete day-directories older than the retention window. */
function prune(): void {
  try {
    const dirs = readdirSync(BASE_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    if (dirs.length <= KEEP_DAYS) return
    const stale = dirs.sort().slice(0, dirs.length - KEEP_DAYS)
    for (const d of stale) rmSync(join(BASE_DIR, d), { recursive: true, force: true })
    console.log(`[chainArchive] pruned ${stale.length} day(s) beyond ${KEEP_DAYS}-day retention`)
  } catch {
    /* best effort */
  }
}
