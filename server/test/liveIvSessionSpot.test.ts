/**
 * The ATM IV that feeds IV history (and so IVR) must be read at the strike
 * nearest the price the chain was quoted against.
 *
 * `impliedVolFromChain` takes "the strike nearest spot" and returns the chain's
 * own IV there. Outside regular hours the chain is frozen at the close while
 * `last` follows extended trading, so an unaligned spot can land on the next
 * strike and record that strike's IV as ATM. Measured 2026-10-10 on the live
 * watchlist (39 symbols, chains frozen at Friday's close): 31 had an
 * extended-hours gap, 4 crossed to another strike — GS +0.56 vol pts on a 0.26%
 * gap, worth ~6.6 IVR points on its short history.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate every store this path writes BEFORE the modules load.
const dir = mkdtempSync(join(tmpdir(), 'ose-liveiv-'))
process.env.IV_HISTORY_FILE = join(dir, 'iv-history.json')
process.env.AI_CACHE_DIR = dir
process.env.LIVE_IV_MARKETDATA_FALLBACK = '0'

const { fetchLiveIvData } = await import('../src/api/marketdata.js')

function occ(sym: string, exp: Date, cp: 'C' | 'P', strike: number): string {
  const ymd = exp.toISOString().slice(2, 10).replace(/-/g, '')
  return `${sym}${ymd}${cp}${String(Math.round(strike * 1000)).padStart(8, '0')}`
}

/** A two-strike chain with a steep skew: 100 → 30% IV, 101 → 20% IV. */
function payload(sym: string, quote: Record<string, unknown>) {
  const exp = new Date(Date.now() + 30 * 86_400_000)
  const leg = (cp: 'C' | 'P', strike: number, iv: number) => ({
    option: occ(sym, exp, cp, strike), bid: 2, ask: 2.1, iv,
    open_interest: 100, volume: 10, delta: cp === 'C' ? 0.5 : -0.5,
    gamma: 0.01, vega: 0.1, theta: -0.01, last_trade_price: 2.05
  })
  return new Response(JSON.stringify({
    timestamp: '2026-10-10 05:30:00',
    data: {
      price_change: 0, price_change_percent: 0, bid: 0, ask: 0, prev_day_close: 100,
      ...quote,
      options: [leg('C', 100, 0.30), leg('P', 100, 0.30), leg('C', 101, 0.20), leg('P', 101, 0.20)]
    }
  }))
}

async function liveIv(sym: string, quote: Record<string, unknown>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => payload(sym, quote)) as typeof fetch
  try {
    return await fetchLiveIvData(sym)
  } finally {
    globalThis.fetch = realFetch
  }
}

test('extended-hours last over a frozen chain: ATM IV is read at the close, and that is what gets recorded', async () => {
  // Closed at 100.00; trading 100.60 after hours — nearer the 101 strike.
  const r = await liveIv('ZZIVA', { current_price: 100.6, close: 100, last_trade_time: '2026-10-09T15:59:59' })
  assert.ok(r, 'expected a CBOE-derived reading')
  assert.equal(r.iv, 0.30, 'must be the 100 strike the chain was at the money on, not the 101 strike')
  // Expected move is spot × IV × √T — on the same spot as the IV.
  assert.ok(Math.abs(r.em - 100 * 0.30 * Math.sqrt(r.dte / 365)) < 1e-9, `em ${r.em} is not on the closing spot`)

  const hist = JSON.parse(readFileSync(process.env.IV_HISTORY_FILE!, 'utf8'))
  assert.equal(hist.ZZIVA.at(-1).iv, 0.30, 'IV history must not receive the off-strike reading')
})

test('regular hours: the live last still picks the strike', async () => {
  // Market open → close === current_price, so alignment is a no-op and a real
  // move to 100.60 legitimately makes 101 the ATM strike.
  const r = await liveIv('ZZIVB', { current_price: 100.6, close: 100.6, last_trade_time: '2026-10-09T11:00:00' })
  assert.ok(r)
  assert.equal(r.iv, 0.20)
})
