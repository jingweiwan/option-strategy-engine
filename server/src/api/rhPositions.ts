/**
 * Robinhood positions bridge — READ side.
 *
 * The engine can never call Robinhood itself (the RH MCP's auth lives in the
 * user's Claude session; reverse-engineered libs were explicitly rejected), so
 * the bridge is a file: a Claude session pulls portfolio + positions via MCP
 * on demand and writes `cache/rh-positions.json`; this module is the engine's
 * only view of it. Refresh model: ON-DEMAND + staleness surfaced in the UI —
 * positions are 21–45 DTE structures, they change when the user trades, not
 * intraday, so freshness matters at refresh points, not in real time.
 *
 * Consumers: real ACCOUNT_SIZE for checklist #8 / risk budget (file beats env),
 * and the real-book greeks aggregation on the dashboard risk card.
 */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CACHE_DIR = process.env.AI_CACHE_DIR
  ? resolve(process.env.AI_CACHE_DIR)
  : resolve(process.cwd(), 'cache')
// Overridable so tests point at a fixture instead of the real bridge file.
const FILE = process.env.RH_POSITIONS_FILE ?? join(CACHE_DIR, 'rh-positions.json')

export type RhOptionLeg = {
  sym: string
  side: 'long' | 'short'
  qty: number
  /** Per-contract dollars as RH reports (long positive, short negative). */
  avgCost: number
  expiration: string
  strike: number
  optionType: 'call' | 'put'
  openedAt?: string
}

export type RhEquity = { sym: string; qty: number; avgCost: number }

export type RhPositions = {
  schema: string
  fetchedAt: string
  accountNumber: string
  account: {
    totalValue: number
    equityValue?: number
    optionsValue?: number
    cryptoValue?: number
    cash?: number
  }
  optionLegs: RhOptionLeg[]
  equities: RhEquity[]
  /** Realized P&L summary pulled alongside positions (RH realized endpoints). */
  realized?: {
    totalAll: number
    rateAll: number
    last3m: number
    asOf: string
  }
}

let cached: { at: number; mtimeMs: number; data: RhPositions | null } | null = null
const TTL_MS = 60_000

/**
 * Leg-shape gate. The schema string alone is NOT enough: a writer that emits
 * `type`/`avgPrice` instead of `optionType`/`avgCost` still stamps
 * `rh-positions-v1`, still parses, and still passes the account-value check —
 * and then EVERY consumer degrades to zeros in silence. That happened on
 * 2026-08-25: all 50 legs missed the chain lookup (`keyOf(..., undefined)`),
 * so net greeks read 0/0/0/0, marks and unrealized came back null, the
 * structures list emptied (no management alerts on live positions), and
 * wheelScanner saw zero short calls.
 *
 * A wrong number is worse than no number here, so a malformed file is REJECTED
 * loudly rather than half-consumed. The log names the first offending leg —
 * that is the line that would have caught it in seconds.
 */
export function validateOptionLegs(data: RhPositions): boolean {
  const legs = data?.optionLegs
  if (!Array.isArray(legs)) {
    console.warn('[rhPositions] rejected: optionLegs is not an array')
    return false
  }
  for (const [i, l] of legs.entries()) {
    const why =
      l?.optionType !== 'call' && l?.optionType !== 'put' ? `optionType=${JSON.stringify(l?.optionType)} (expected 'call'|'put')`
      : !Number.isFinite(l?.avgCost) ? `avgCost=${JSON.stringify(l?.avgCost)} (per-CONTRACT dollars, side-signed)`
      : !Number.isFinite(l?.strike) ? `strike=${JSON.stringify(l?.strike)}`
      : !Number.isFinite(l?.qty) ? `qty=${JSON.stringify(l?.qty)}`
      : typeof l?.expiration !== 'string' ? `expiration=${JSON.stringify(l?.expiration)}`
      : l?.side !== 'long' && l?.side !== 'short' ? `side=${JSON.stringify(l?.side)}`
      : typeof l?.sym !== 'string' ? `sym=${JSON.stringify(l?.sym)}`
      : null
    if (why) {
      console.warn(
        `[rhPositions] rejected bridge file: optionLegs[${i}] (${l?.sym ?? '?'}) bad ${why}. ` +
        'Every consumer would silently read zeros; fix the writer rather than the reader.'
      )
      return false
    }
  }
  return true
}

/** Parsed bridge file, or null when absent/invalid. 60s + mtime cache. */
export function loadRhPositions(): RhPositions | null {
  const now = Date.now()
  try {
    const mtimeMs = statSync(FILE).mtimeMs
    if (cached && now - cached.at < TTL_MS && cached.mtimeMs === mtimeMs) return cached.data
    const data = JSON.parse(readFileSync(FILE, 'utf8')) as RhPositions
    const ok =
      data?.schema?.startsWith('rh-positions') &&
      Number.isFinite(data?.account?.totalValue) &&
      validateOptionLegs(data)
    cached = { at: now, mtimeMs, data: ok ? data : null }
    return cached.data
  } catch {
    cached = { at: now, mtimeMs: -1, data: null }
    return null
  }
}

/** Hours since the bridge file was pulled; null when no file. */
export function rhAgeHours(): number | null {
  const p = loadRhPositions()
  if (!p) return null
  const t = Date.parse(p.fetchedAt)
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null
}

export type AccountSizeInfo = { size: number; source: 'rh' | 'env' }

/** Real account size: bridge file first, ACCOUNT_SIZE env as fallback. */
export function getAccountSize(): AccountSizeInfo | null {
  const p = loadRhPositions()
  if (p && p.account.totalValue > 0) return { size: p.account.totalValue, source: 'rh' }
  const env = Number(process.env.ACCOUNT_SIZE) || 0
  return env > 0 ? { size: env, source: 'env' } : null
}
