import test from 'node:test'
import assert from 'node:assert/strict'
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
