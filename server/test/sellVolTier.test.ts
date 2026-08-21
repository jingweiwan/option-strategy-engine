/**
 * Sell-vol auto-board qualification (oppScanner.sellVolTier):
 *   - qualified: IVR ≥ floor, IV/RV ≥ SELL_IVRV_FLOOR (when RV known), no forward
 *                earnings, not just-reported
 *   - reference: IVR in [ref, floor) (ivr_below_floor); IVR ok but IV/RV < floor
 *                (vol_not_rich); OR just-reported (earnings_recency)
 *   - dropped (null): IVR < ref, OR earnings-spanning (at any IVR)
 *   - directional debit spreads bypass the vol floor (always qualified)
 *   - buy-vol (long_straddle) is guarded to null — must route via buyVolTier
 * Cases that assert `qualified` pass a rich iv/rv so the pass is a GENUINE
 * qualification, not the RV-absent skip (that skip has its own labeled test).
 * Post-print demotion cases live in earningsRecency.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { soldLegIv } from '../src/engine/liveStrategies.js'
import { sellVolTier, sellVolDecision, boardTierDecision, boardTierFor, IVR_QUALIFY_FLOOR, IVR_REFERENCE_FLOOR, SELL_IVRV_FLOOR, CREDIT_WIDTH_FLOOR } from '../src/engine/oppScanner.js'

const G = { delta: 0, gamma: 0, theta: 0, vega: 0 }

test('iron_condor: IVR at/above floor, rich IV/RV, no earnings → qualified', () => {
  assert.equal(sellVolTier('iron_condor', IVR_QUALIFY_FLOOR, false, false, 0.4, 0.3), 'qualified')
  assert.equal(sellVolTier('iron_condor', 55, false, false, 0.4, 0.3), 'qualified')
})

test('iron_condor: IVR in [ref, floor), no earnings → reference', () => {
  assert.equal(sellVolTier('iron_condor', IVR_REFERENCE_FLOOR, false), 'reference')
  assert.equal(sellVolTier('iron_condor', IVR_QUALIFY_FLOOR - 1, false), 'reference')
})

test('iron_condor: IVR below reference floor → dropped', () => {
  assert.equal(sellVolTier('iron_condor', IVR_REFERENCE_FLOOR - 1, false), null)
  assert.equal(sellVolTier('iron_condor', 0, false), null)
})

test('earnings-spanning is dropped even with rich IVR (no reference tier)', () => {
  assert.equal(sellVolTier('iron_condor', 90, true), null)
  assert.equal(sellVolTier('bull_put_spread', 60, true), null)
})

test('credit spreads follow the same floor as condors', () => {
  assert.equal(sellVolTier('bull_put_spread', 40, false, false, 0.4, 0.3), 'qualified')
  assert.equal(sellVolTier('bear_call_spread', 22, false), 'reference') // below IVR floor → ref regardless of iv/rv
  assert.equal(sellVolTier('bear_call_spread', 10, false), null)
})

test('IV/RV gate: high IVR but IV ≤ RV (thin/negative VRP) → reference vol_not_rich', () => {
  // The DIA-condor case: IVR 51 (rank says "high") but IV 13% < RV 14% → 0.93 < 1.2.
  const d = sellVolDecision('iron_condor', 51, false, false, 0.13, 0.14)
  assert.equal(d.tier, 'reference')
  assert.equal(d.reason, 'vol_not_rich')
})

test('IV/RV gate: IVR passes AND IV/RV ≥ floor → still qualified', () => {
  // The XOM case: IVR 43 (>floor) and IV/RV = 1.20 ≥ 1.2 → genuine premium, keep.
  assert.equal(sellVolTier('bull_put_spread', 43, false, false, 0.30, 0.25), 'qualified')
})

test('IV/RV gate: skipped when RV is genuinely absent (rv=null) — falls back to IVR only', () => {
  // rv=null (no RV at all — NOT an rv-fallback IVR rank, which still has RV) →
  // cannot judge richness → do not demote (downstream EV filter guards).
  assert.equal(sellVolTier('iron_condor', 55, false, false, 0.13, null), 'qualified')
  assert.equal(sellVolTier('iron_condor', 55, false, false, null, null), 'qualified')
})

test('IV/RV gate: exactly at the floor qualifies (≥, not >)', () => {
  assert.equal(sellVolTier('iron_condor', 55, false, false, SELL_IVRV_FLOOR, 1), 'qualified')
  assert.equal(sellVolTier('iron_condor', 55, false, false, SELL_IVRV_FLOOR - 0.01, 1), 'reference')
})

test('IV/RV gate does not rescue a below-IVR-floor name (still ivr_below_floor)', () => {
  // Rich IV/RV but IVR in [ref, floor) → the IVR reference reason wins (gate only
  // runs inside the qualify branch).
  const d = sellVolDecision('iron_condor', IVR_REFERENCE_FLOOR, false, false, 0.5, 0.2)
  assert.equal(d.tier, 'reference')
  assert.equal(d.reason, 'ivr_below_floor')
})

test('boardTierDecision wiring: thin IV/RV through the real dispatch → reference vol_not_rich', () => {
  // The production path (boardTierDecision(strategy, {ivr, iv, rv, ...})), not just
  // the helper — proves ctx.iv/ctx.rv reach the gate. DIA-style: IVR 51, IV/RV 0.93.
  const d = boardTierDecision('iron_condor', {
    ivr: 51, iv: 0.13, rv: 0.14, spansEarnings: false, recentlyReported: false
  })
  assert.equal(d.tier, 'reference')
  assert.equal(d.reason, 'vol_not_rich')
  // And a genuinely rich one boards through the same dispatch.
  assert.equal(
    boardTierFor('iron_condor', { ivr: 51, iv: 0.40, rv: 0.30, spansEarnings: false }),
    'qualified'
  )
})

test('directional debit spreads bypass THIS helper (qualified; gated by autoScanEligible)', () => {
  assert.equal(sellVolTier('bull_call_spread', 5, false), 'qualified')
  assert.equal(sellVolTier('bear_put_spread', 5, false), 'qualified')
})

test('buy-vol (long_straddle) is guarded to null — never qualifies via the sell-vol helper', () => {
  // Footgun guard: a stray direct call can't hand a straddle a qualified ticket;
  // buy-vol must route through boardTierFor → buyVolTier.
  assert.equal(sellVolTier('long_straddle', 0, false), null)
  assert.equal(sellVolTier('long_straddle', 90, false), null)
})

// ---- credit/width floor (CREDIT_WIDTH_FLOOR) ----
// Deliberately a LOW outlier-catcher, not the 15% first draft: the resolved
// snapshot history showed no P&L gradient across credit/width buckets and 15%
// would have blocked 46.7% of the board. See the constant's docstring.

test('credit/width: below floor → reference reward_too_thin (not dropped)', () => {
  const d = sellVolDecision('iron_condor', 55, false, false, 0.4, 0.3, 0.042)
  assert.equal(d.tier, 'reference')
  assert.equal(d.reason, 'reward_too_thin')
})

test('credit/width: at/above the floor qualifies (≥, not >)', () => {
  assert.equal(sellVolTier('bull_put_spread', 55, false, false, 0.4, 0.3, CREDIT_WIDTH_FLOOR), 'qualified')
  assert.equal(sellVolTier('bull_put_spread', 55, false, false, 0.4, 0.3, CREDIT_WIDTH_FLOOR - 0.001), 'reference')
})

test('credit/width: the real IWM card — 290/270 passes the LOW floor, and that is intended', () => {
  // IWM 10/02 real chain: credit 2.15 / width 20 = 10.8%. It is above the 10%
  // outlier floor ON PURPOSE — the wing-geometry fix (CREDIT_SPREAD_WING_PCT)
  // is what repairs this card, turning it into 290/285 at 16.1%. The gate is a
  // backstop for pathological geometry, NOT the fix for this case.
  assert.equal(sellVolTier('bull_put_spread', 44, false, false, 0.174, 0.141, 0.1075), 'qualified')
})

test('credit/width: null (unbounded payoff) skips the gate entirely', () => {
  assert.equal(sellVolTier('iron_condor', 55, false, false, 0.4, 0.3, null), 'qualified')
  assert.equal(sellVolTier('iron_condor', 55, false, false, 0.4, 0.3, NaN), 'qualified')
})

test('credit/width: vol_not_rich wins when BOTH fail (thesis beats geometry)', () => {
  const d = sellVolDecision('iron_condor', 55, false, false, 0.13, 0.14, 0.05)
  assert.equal(d.reason, 'vol_not_rich')
})

test('credit/width: earnings recency still outranks it', () => {
  const d = sellVolDecision('iron_condor', 55, false, true, 0.4, 0.3, 0.05)
  assert.equal(d.reason, 'earnings_recency')
})

test('boardTierDecision wiring: creditWidth reaches the gate through ctx', () => {
  const d = boardTierDecision('bull_put_spread', {
    ivr: 55, iv: 0.4, rv: 0.3, spansEarnings: false, creditWidth: 0.05
  })
  assert.equal(d.tier, 'reference')
  assert.equal(d.reason, 'reward_too_thin')
  // ctx without creditWidth behaves exactly as before this change.
  assert.equal(
    boardTierFor('bull_put_spread', { ivr: 55, iv: 0.4, rv: 0.3, spansEarnings: false }),
    'qualified'
  )
})

/**
 * Skew-aware richness: the gate reads the vol the structure SELLS, not ATM.
 * Numbers are the real 2026-08-20 IWM condor (276P/321C short, 274P/323C long)
 * with the chain's own per-strike IVs and marks.
 */
const IWM_LEGS = [
  { type: 'put' as const, action: 'buy' as const, strike: 274, premium: 1.435, quantity: 1, iv: 0.2535, greeks: G },
  { type: 'put' as const, action: 'sell' as const, strike: 276, premium: 2.015, quantity: 1, iv: 0.2389, greeks: G },
  { type: 'call' as const, action: 'sell' as const, strike: 321, premium: 0.635, quantity: 1, iv: 0.1525, greeks: G },
  { type: 'call' as const, action: 'buy' as const, strike: 323, premium: 0.29, quantity: 1, iv: 0.1531, greeks: G }
]

test('soldLegIv: premium-weights the SOLD legs only (IWM condor → 21.8%)', () => {
  const s = soldLegIv(IWM_LEGS)
  assert.ok(s != null)
  // (0.2389·2.015 + 0.1525·0.635) / (2.015 + 0.635)
  assert.ok(Math.abs(s - 0.2182) < 0.0005, `got ${s}`)
  // The bought wings must not drag it — a plain 4-leg average would be ~0.199.
  assert.ok(s > 0.21)
})

test('soldLegIv: null when any sold leg has no usable chain IV', () => {
  assert.equal(soldLegIv(IWM_LEGS.map((l) => ({ ...l, iv: undefined }))), null)
  assert.equal(
    soldLegIv(IWM_LEGS.map((l) => (l.action === 'sell' && l.strike === 321 ? { ...l, iv: 0 } : l))),
    null
  )
  // A LONG leg missing its IV is irrelevant — only the sold side is measured.
  assert.ok(
    soldLegIv(IWM_LEGS.map((l) => (l.action === 'buy' ? { ...l, iv: undefined } : l))) != null
  )
})

test('richness gate: IWM condor fails on ATM 18.2% but passes on sold-leg 21.8%', () => {
  const base = { ivr: 45, rv: 0.16, spansEarnings: false }
  // ATM: 0.182 / 0.16 = 1.14 < 1.2 → demoted as thin premium.
  const atm = boardTierDecision('iron_condor', { ...base, iv: 0.182 })
  assert.equal(atm.tier, 'reference')
  assert.equal(atm.reason, 'vol_not_rich')
  // Sold-leg: 0.2182 / 0.16 = 1.36 ≥ 1.2 → the vol it actually collects is rich.
  const skewed = boardTierDecision('iron_condor', {
    ...base, iv: 0.182, ivSold: soldLegIv(IWM_LEGS)
  })
  assert.equal(skewed.tier, 'qualified')
})

test('richness gate: ivSold null/absent falls back to ATM (pre-skew behaviour)', () => {
  const ctx = { ivr: 45, iv: 0.182, rv: 0.16, spansEarnings: false }
  assert.equal(boardTierDecision('iron_condor', { ...ctx, ivSold: null }).reason, 'vol_not_rich')
  assert.equal(boardTierDecision('iron_condor', ctx).reason, 'vol_not_rich')
})

test('buy-vol keeps ATM: ivSold never reaches the straddle path', () => {
  // A straddle IS an ATM position; it sells nothing, so ivSold is meaningless
  // here. Passing a rich one must not flip a not-cheap reading into 'buy'.
  const withSold = boardTierFor('long_straddle', {
    ivr: 40, iv: 0.182, rv: 0.16, spansEarnings: false, ivSold: 0.2182
  })
  const withoutSold = boardTierFor('long_straddle', {
    ivr: 40, iv: 0.182, rv: 0.16, spansEarnings: false
  })
  assert.equal(withSold, withoutSold)
  assert.equal(withSold, null) // IV > RV → not cheap → never auto-boards
})
