/**
 * Boot-time + cron-scheduled warmer for AI caches.
 *
 * Warms ALL AI-dependent caches so the first page-load is instant:
 *   - Dashboard live data (IV/IVR/EM/earnings/FOMC)
 *   - AI narrative (hero + mood + engine commentary)
 *   - AI opps (today's opportunity cards)
 *   - AI ticker notes (one-liner per watchlist ticker)
 *
 * Schedule:
 *   1. On server boot — warm everything (no-op if caches are hot).
 *   2. Daily at configured time — refresh for the new day.
 *   3. **Heartbeat** every 5 min — detects missed cron fires (Mac sleep,
 *      laptop lid close, etc.) and auto-recovers by running dailyRefresh.
 *
 * Default schedule: '0 12 * * *' America/New_York = midnight Beijing time.
 * Override with AI_DASHBOARD_CRON and AI_CRON_TZ env vars.
 *
 * Failure handling:
 *   Warmer NEVER throws. AI/network failures are logged and ignored —
 *   page-time fallback (lazy generation in cached()) still works.
 */

import cron, { type ScheduledTask } from 'node-cron'
import { buildLiveMarketSnapshot } from '../routes/dashboard.js'
import { getMarketNarrative } from './marketNarrative.js'
import { bust, etCalendarDay, getCachedIfValid, HOUR } from './cache.js'
import { hydrateDueSnapshots } from '../feedback/hydrate.js'

/**
 * Warm all dashboard caches. buildLiveMarketSnapshot() internally calls
 * buildLiveDashboard() which triggers:
 *   - fetchLiveIvData (per symbol, 24h self-cache)
 *   - computeIvRank (per symbol, 24h self-cache)
 *   - fetchEarningsData (24h cache)
 *   - getAiOpps (daily cache)
 *   - getAiTickerNotes (daily cache)
 *
 * Then we pass the snapshot to getMarketNarrative() for the AI narrative.
 */
async function warmAll(reason: string) {
  const t0 = Date.now()
  try {
    // Step 1: build full live dashboard (warms IV/IVR/earnings/opps/notes)
    const snap = await buildLiveMarketSnapshot()

    // Step 2: warm the AI narrative from the live snapshot
    await getMarketNarrative(snap)

    const dt = Date.now() - t0
    console.log(`[ai/warmer] all caches ready (${reason}, ${dt}ms)`)
  } catch (err) {
    console.warn(`[ai/warmer] warm FAILED (${reason}):`, (err as Error).message)
  }
}

/**
 * For daily refresh: bust stale caches before re-warming so we don't
 * serve yesterday's narrative/opps/notes on the new trading day.
 */
async function dailyRefresh(reason: string) {
  console.log(`[ai/warmer] daily refresh starting (${reason})`)

  // Bust daily AI caches so warmAll() regenerates them
  bust('narrative-')
  bust('opps-')
  bust('ticker-notes-')
  bust('earnings-calendar')
  bust('dashboard-live')

  await warmAll(reason)

  if (process.env.FEEDBACK_AUTO_HYDRATE === '1') {
    hydrateDueSnapshots({ stopLossFraction: 0.5, maxUpdates: 40 }).then(
      (r) => console.log(`[feedback] auto-hydrate: updated=${r.updated} pendingHorizon=${r.pendingWithinHorizon}`),
      (e) => console.warn('[feedback] auto-hydrate failed:', (e as Error).message)
    )
  }
}

// Default: '0 12 * * *' ET = midnight Beijing time (CST, UTC+8).
// Runs every day including weekends — market analysis is still useful.
const DASHBOARD_CRON = process.env.AI_DASHBOARD_CRON ?? '0 12 * * *'
const TZ = process.env.AI_CRON_TZ ?? 'America/New_York'

let dashboardTask: ScheduledTask | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

/**
 * Track the last date we successfully warmed. When the heartbeat detects
 * a date change (or a gap > HEARTBEAT_STALE_MS), we know the cron was
 * missed (Mac slept through it) and need to recover.
 */
let lastWarmedDay: string | null = null
let lastHeartbeatTs = 0
let recovering = false

/** Heartbeat interval — check every 5 minutes. */
const HEARTBEAT_MS = 5 * 60 * 1000

/**
 * If the gap between two heartbeats exceeds this, the machine likely slept.
 * Normal interval is 5 min; anything > 7 min means we were suspended.
 */
const SLEEP_GAP_MS = 7 * 60 * 1000

/**
 * Heartbeat: runs every 5 min via setInterval.
 *
 * Detects two scenarios:
 *   1. Day changed but cron hasn't fired yet (e.g. slept through midnight)
 *   2. Large gap between heartbeats (Mac sleep detected by wall-clock jump)
 *
 * In either case: trigger dailyRefresh to recover.
 */
async function heartbeat() {
  const now = Date.now()
  const today = etCalendarDay()
  const gap = lastHeartbeatTs > 0 ? now - lastHeartbeatTs : 0
  lastHeartbeatTs = now

  // Detect sleep: gap between heartbeats >> normal interval
  const wasSleeping = gap > SLEEP_GAP_MS
  if (wasSleeping) {
    console.log(`[ai/warmer] sleep detected — gap ${(gap / 1000 / 60).toFixed(1)} min`)
  }

  // Check if today's narrative cache exists (proxy for "has today been warmed?")
  const narrativeKey = `narrative-${today}`
  const hasToday = await getCachedIfValid<unknown>(narrativeKey, 12 * HOUR)

  const needsRefresh =
    // Day changed and we haven't warmed today
    (lastWarmedDay !== today && hasToday == null) ||
    // Or we just woke from sleep and today's cache is missing
    (wasSleeping && hasToday == null)

  if (!needsRefresh) {
    // Cache is still valid — update lastWarmedDay if needed
    if (hasToday != null) lastWarmedDay = today
    return
  }

  if (recovering) return // avoid concurrent recovery
  recovering = true

  console.log(
    `[ai/warmer] heartbeat recovery: today=${today}, lastWarmed=${lastWarmedDay ?? 'never'}, slept=${wasSleeping}`
  )

  try {
    await dailyRefresh('heartbeat-recovery')
    lastWarmedDay = today
  } finally {
    recovering = false
  }
}

export function startAiWarmer() {
  lastWarmedDay = null
  lastHeartbeatTs = Date.now()

  // Boot: warm immediately but non-blocking (cache may already be hot)
  warmAll('boot')
    .then(() => {
      lastWarmedDay = etCalendarDay()
    })
    .catch(() => {
      /* swallowed in warmer */
    })

  // Daily refresh on cron schedule
  if (dashboardTask) dashboardTask.stop()
  dashboardTask = cron.schedule(
    DASHBOARD_CRON,
    () => {
      dailyRefresh(`cron ${DASHBOARD_CRON}`)
        .then(() => {
          lastWarmedDay = etCalendarDay()
        })
        .catch(() => {
          /* swallowed */
        })
    },
    { timezone: TZ }
  )

  // Heartbeat: catches missed cron fires after Mac sleep / suspend
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    heartbeat().catch((err) => {
      console.warn('[ai/warmer] heartbeat error:', (err as Error).message)
    })
  }, HEARTBEAT_MS)

  // Compute next fire time for the log
  const [min, hour] = DASHBOARD_CRON.split(' ')
  const nextFireET = `${hour.padStart(2, '0')}:${min.padStart(2, '0')} ${TZ}`
  console.log(
    `[ai/warmer] schedule started:\n` +
      `  boot: warming now\n` +
      `  cron: '${DASHBOARD_CRON}' (next fire: ${nextFireET}, daily incl. weekends)\n` +
      `  heartbeat: every ${HEARTBEAT_MS / 60000} min (sleep recovery)`
  )
}

export function stopAiWarmer() {
  if (dashboardTask) {
    dashboardTask.stop()
    dashboardTask = null
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}
