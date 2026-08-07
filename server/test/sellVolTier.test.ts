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
import { sellVolTier, sellVolDecision, IVR_QUALIFY_FLOOR, IVR_REFERENCE_FLOOR, SELL_IVRV_FLOOR } from '../src/engine/oppScanner.js'

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

test('IV/RV gate: skipped when RV is absent (rv-fallback) — falls back to IVR only', () => {
  // No real RV → cannot judge richness → do not demote (downstream EV filter guards).
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

