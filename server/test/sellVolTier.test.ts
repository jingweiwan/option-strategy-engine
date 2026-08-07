/**
 * Sell-vol auto-board qualification (oppScanner.sellVolTier):
 *   - qualified: IVR ≥ floor, no forward earnings, not just-reported
 *   - reference: IVR in [ref, floor), OR just-reported demotion from qualified
 *   - dropped (null): IVR < ref, OR earnings-spanning (at any IVR)
 *   - directional debit spreads bypass the vol floor (always qualified)
 *   - buy-vol (long_straddle) is guarded to null — must route via buyVolTier
 * Post-print demotion cases live in earningsRecency.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sellVolTier, IVR_QUALIFY_FLOOR, IVR_REFERENCE_FLOOR } from '../src/engine/oppScanner.js'

test('iron_condor: IVR at/above floor, no earnings → qualified', () => {
  assert.equal(sellVolTier('iron_condor', IVR_QUALIFY_FLOOR, false), 'qualified')
  assert.equal(sellVolTier('iron_condor', 55, false), 'qualified')
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
  assert.equal(sellVolTier('bull_put_spread', 40, false), 'qualified')
  assert.equal(sellVolTier('bear_call_spread', 22, false), 'reference')
  assert.equal(sellVolTier('bear_call_spread', 10, false), null)
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

