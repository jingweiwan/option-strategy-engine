/**
 * Sell-vol auto-board qualification (oppScanner.sellVolTier):
 *   - qualified: IVR ≥ floor, no earnings
 *   - reference: IVR in [ref, floor), no earnings
 *   - dropped (null): IVR < ref, OR earnings-spanning (at any IVR)
 *   - non-sell-vol structures bypass the vol floor (always qualified)
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

test('non-sell-vol structures bypass the vol floor (always qualified)', () => {
  // Directional debit spreads are gated by autoScanEligible, not the vol floor.
  assert.equal(sellVolTier('bull_call_spread', 5, false), 'qualified')
  assert.equal(sellVolTier('long_straddle', 0, false), 'qualified')
})
