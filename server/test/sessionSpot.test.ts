/**
 * Spot must come from the same session as the option chain.
 *
 * The production observation (2026-10-09 05:30 ET): QQQ's quote `last` was the
 * pre-market 754.21 while the chain still carried the 747.58 close's premiums.
 * Same 778/794 call spread, same 3.92 credit: POP 75.8% / EV −0.35 at the
 * pre-market spot versus 81.4% / EV +0.47 at the close; the put spread moved the
 * other way. CBOE reports the regular-session last separately (`close`), equal
 * to `current_price` whenever the market is open, so preferring it is a no-op in
 * regular hours and the close everywhere else.
 *
 * Payload values below are the real QQQ fields from that morning and from an
 * intraday archive sample (SPY 2026-06-22 14:11 ET).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainSpotBasis, alignQuoteToChain } from '../src/api/sessionSpot.js'
import { getQuote as cboeQuote } from '../src/api/cboe.js'
import { runEngineLive } from '../src/engine/index.js'
import { enrichWithGreeks } from '../src/engine/liveStrategies.js'
import { syntheticChain } from './fixtures.js'
import type { Quote } from '../src/api/types.js'

const PRE_MARKET: Quote = {
  symbol: 'QQQ', last: 753.805, bid: 753.86, ask: 753.92, change: 6.27, changePct: 0.8387,
  regularClose: 747.58, regularTradeTime: '2026-10-08T15:59:59'
}
const INTRADAY: Quote = {
  symbol: 'SPY', last: 744.4499, bid: 744.44, ask: 744.46,
  regularClose: 744.4499, regularTradeTime: '2026-06-22T13:41:27'
}

test('outside regular hours the chain is priced at the close, and the gap is reported', () => {
  const b = chainSpotBasis(PRE_MARKET)
  assert.equal(b.basis, 'regular_close')
  assert.equal(b.spot, 747.58)
  assert.equal(b.extendedLast, 753.805)
  assert.ok(Math.abs((b.extendedGapPct as number) - 0.8327) < 1e-3, `gap ${b.extendedGapPct}`)
  assert.equal(b.asOf, '2026-10-08T15:59:59')
})

test('in regular hours the live last is used untouched', () => {
  const b = chainSpotBasis(INTRADAY)
  assert.deepEqual(
    { basis: b.basis, spot: b.spot, extendedLast: b.extendedLast, extendedGapPct: b.extendedGapPct },
    { basis: 'live', spot: 744.4499, extendedLast: null, extendedGapPct: null }
  )
  assert.equal(alignQuoteToChain(INTRADAY), INTRADAY)
})

test('a provider with no regular-session price, or a junk one, falls back to last', () => {
  const bare: Quote = { symbol: 'X', last: 100, bid: 0, ask: 0 }
  assert.equal(chainSpotBasis(bare).basis, 'live')
  assert.equal(chainSpotBasis(bare).spot, 100)
  for (const junk of [0, -1, NaN, Infinity]) {
    const b = chainSpotBasis({ ...bare, regularClose: junk })
    assert.equal(b.basis, 'live', `regularClose=${junk}`)
    assert.equal(b.spot, 100)
  }
  // The scanner's "no quote" stub must stay a no-quote, not become the close.
  assert.equal(alignQuoteToChain({ ...bare, last: 0, regularClose: 99 }).last, 0)
})

test('alignQuoteToChain moves only `last`', () => {
  const q = alignQuoteToChain(PRE_MARKET)
  assert.equal(q.last, 747.58)
  assert.deepEqual({ ...q, last: PRE_MARKET.last }, PRE_MARKET)
})

test('cboe.getQuote carries the regular-session close and its trade time', async () => {
  const realFetch = globalThis.fetch
  const payload = (data: Record<string, unknown>) =>
    new Response(JSON.stringify({ timestamp: '2026-10-09 10:09:01', data: { options: [], ...data } }))
  try {
    globalThis.fetch = (async () =>
      payload({
        current_price: 753.805, price_change: 6.27, price_change_percent: 0.8387,
        bid: 753.86, ask: 753.92, close: 747.58, prev_day_close: 747.58,
        last_trade_time: '2026-10-08T15:59:59'
      })) as typeof fetch
    const q = await cboeQuote('ZZSESSA') // unique symbol: cboe caches raw payloads for 60s
    assert.equal(q.last, 753.805)
    assert.equal(q.regularClose, 747.58)
    assert.equal(q.regularTradeTime, '2026-10-08T15:59:59')
    assert.equal(chainSpotBasis(q).spot, 747.58)

    // Older/odd payloads without the fields must not invent a close.
    globalThis.fetch = (async () => payload({ current_price: 50, bid: 0, ask: 0, close: 0 })) as typeof fetch
    const bare = await cboeQuote('ZZSESSB')
    assert.equal(bare.regularClose, undefined)
    assert.equal(bare.regularTradeTime, undefined)
    assert.equal(chainSpotBasis(bare).spot, 50)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('why it matters: a gap over a frozen chain moves call-side and put-side POP in opposite directions', () => {
  // A vendor chain quoted at `spot` — premiums AND greeks frozen there, as CBOE's
  // are after the close — then the underlying gaps +0.84% in extended hours.
  const base = syntheticChain({ iv: 0.2 })
  const { expiration, spot } = base
  const chain = enrichWithGreeks(base.chain, { spot, T: base.dteDays / 365, r: 0.045, q: 0 })
  const run = (s: number) =>
    runEngineLive({ symbol: 'TEST', spot: s, expiration, chain, ivRank: 40, currentRv: 0.15, seed: 42, simulations: 2000 })
  const pick = (res: ReturnType<typeof run>, st: string) => {
    const r = res.results.find((x) => x.strategy === st)
    assert.ok(r && r.legs.length > 0, `fixture must build ${st}`)
    return { pop: r.metrics.probabilityProfit, legs: r.legs.map((l) => `${l.action}${l.strike}@${l.premium}`).join(' ') }
  }
  const atClose = run(spot)
  const gapped = run(spot * 1.0084)

  const call = { close: pick(atClose, 'bear_call_spread'), gap: pick(gapped, 'bear_call_spread') }
  const put = { close: pick(atClose, 'bull_put_spread'), gap: pick(gapped, 'bull_put_spread') }
  // Same structure at the same premiums — only the paths' starting point moved.
  assert.equal(call.gap.legs, call.close.legs)
  assert.equal(put.gap.legs, put.close.legs)
  assert.ok(call.gap.pop < call.close.pop, `call spread POP ${call.close.pop} → ${call.gap.pop} should fall`)
  assert.ok(put.gap.pop > put.close.pop, `put spread POP ${put.close.pop} → ${put.gap.pop} should rise`)

  // Aligning the quote restores the at-close result exactly.
  const aligned = alignQuoteToChain({ symbol: 'TEST', last: spot * 1.0084, bid: 0, ask: 0, regularClose: spot })
  assert.deepEqual(run(aligned.last).results.map((r) => r.metrics), atClose.results.map((r) => r.metrics))
})
