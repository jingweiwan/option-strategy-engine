import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ungroundedTickers } from '../src/ai/marketNarrative.js'

const SNAP: any = {
  asof: '2026-08-25',
  spy: { v: 640, chg: 0.1 },
  vixy: { v: 40, chg: -0.2 },
  watchlistTickers: [
    { sym: 'IWM', iv: 0.17, ivr: 47, ivrReliable: true, em: 2, chg: 0.3 },
    { sym: 'GLD', iv: 0.26, ivr: 59, ivrReliable: true, em: 2, chg: 0.1 }
  ],
  earningsUpcoming: [{ sym: 'VST', label: 'Nov 04', daysUntil: 72 }],
  board: { qualifiedCount: 1, setups: [{ sym: 'IWM', strategy: 'bull_put_spread' }] }
}
const narr = (enginePose: string): any => ({
  heroLine1: '标题', heroLine2: '副标题', deck: '导语', enginePose, factors: []
})

// The exact card that shipped on 2026-08-25. ADBE was never in the snapshot
// (it is a HOLDING; the narrative is not given the book) and no symbol had an
// IVR of 72 — the only 72 in the payload was VST's earnings daysUntil.
test('narrative: catches the 2026-08-25 ADBE fabrication verbatim', () => {
  const bad = ungroundedTickers(
    narr('引擎今日仅上板IWM看涨信用价差，IVR 45，属合理偏高水平，可考虑轻仓参与。' +
         '其余标的IVR虽有个别偏高（如ADBE 72），但未通过硬门槛，不宜强行开仓。'),
    SNAP
  )
  assert.deepEqual(bad, ['ADBE'])
})

test('narrative: accepts tickers that ARE in the snapshot', () => {
  assert.deepEqual(
    ungroundedTickers(narr('引擎今日仅上板 IWM 看涨信用价差；GLD 的 IVR 更高但未过闸门。VST 财报临近。'), SNAP),
    []
  )
})

test('narrative: jargon and macro abbreviations are not read as tickers', () => {
  assert.deepEqual(
    ungroundedTickers(
      narr('IV 高于 RV，IVR 47，EV 为正，POP 65%，30 DTE；FOMC 前 CPI 与 PCE 是主要风险，SPY 与 VIXY 背离。'),
      SNAP
    ),
    []
  )
})

test('narrative: an unfed ticker is caught anywhere in the card, not just enginePose', () => {
  const n: any = narr('引擎今日仅上板 IWM。')
  n.heroLine1 = 'NVDA 领涨'
  n.factors = [{ tone: 'ink', label: '能源', detail: 'XLE 走强' }]
  assert.deepEqual(ungroundedTickers(n, SNAP).sort(), ['NVDA', 'XLE'])
})

// A cached narrative is NOT exempt from the check. The day-cache short-circuit
// returns before the producer runs, so a poisoned entry written by an older
// build would keep shipping — and the 08-25 「ADBE 72」 card is sitting in day
// caches right now. Both the read-path guard and the key bump are required;
// either alone leaves the poisoned entry reachable.
test('narrative: cache key is bumped past the pre-grounding generation', async () => {
  const { narrativeCacheKey } = await import('../src/ai/marketNarrative.js')
  const key = narrativeCacheKey(SNAP)
  assert.ok(!key.includes('narrative-v2-'), `key must leave v2 behind: ${key}`)
  assert.match(key, /^narrative-v3-/)
})

test('narrative: the cached read path validates too (source check)', () => {
  const src = readFileSync(new URL('../src/ai/marketNarrative.js'.replace('.js', '.ts'), import.meta.url), 'utf8')
  const i = src.indexOf('getCachedNarrativeDailyWithLegacy<DashboardNarrative>')
  assert.ok(i > 0, 'expected the day-cache short-circuit to exist')
  const after = src.slice(i, i + 700)
  assert.match(
    after, /ungroundedTickers\(pre, snap\)/,
    'the cache hit must be validated before it is returned, not only at generation time'
  )
})
