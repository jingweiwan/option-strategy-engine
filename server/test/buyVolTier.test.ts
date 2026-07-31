/**
 * Buy-vol auto-board qualification (oppScanner.buyVolTier) + board dispatch
 * (oppScanner.boardTierFor).
 *
 * buyVolTier semantics — IV<RV is the AUTHORITATIVE cheapness gate; a low IVR
 * must NOT override an IV>=RV reading (calibration shows straddle bleeds even in
 * the low-IVR / buy regime). IVR is only a fallback proxy when RV is missing.
 *   - qualified: IV < RV; or (no IV/RV pair) IVR < BUY_VOL_IVR_CEIL
 *   - null:      IV >= RV; or (no IV/RV pair) IVR >= ceil
 *   - reference: no IV/RV pair AND no IVR (cannot judge)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buyVolTier, boardTierFor, BUY_VOL_IVR_CEIL } from '../src/engine/oppScanner.js'

// ---- buyVolTier: IV/RV pair present → IV<RV decides outright ----

test('WMT-style rich vol (IV>RV) → dropped, regardless of high IVR', () => {
  // Core stop-bleed: was auto-qualified via sellVolTier bypass + EV>0.
  assert.equal(buyVolTier(0.287, 0.243, 71), null)
})

test('IV cheaper than RV → qualified even at mid/high IVR', () => {
  assert.equal(buyVolTier(0.20, 0.25, 55), 'qualified')
})

test('low IVR does NOT override IV>=RV when the IV/RV pair is present', () => {
  // The key hardening: IV<RV is authoritative; a low IVR cannot rescue it.
  assert.equal(buyVolTier(0.30, 0.30, 15), null) // IV == RV → not cheaper → null
  assert.equal(buyVolTier(0.31, 0.30, 5), null)  // IV > RV, very low IVR → still null
})

test('IV == RV is not "cheaper" (strict <) → dropped', () => {
  assert.equal(buyVolTier(0.30, 0.30, 40), null)
})

// ---- buyVolTier: RV missing → IVR fallback proxy ----

test('RV missing → falls back to IVR percentile', () => {
  assert.equal(buyVolTier(0.30, null, 15), 'qualified')                 // low IVR proxy
  assert.equal(buyVolTier(0.30, null, BUY_VOL_IVR_CEIL - 1), 'qualified')
  assert.equal(buyVolTier(0.30, null, BUY_VOL_IVR_CEIL), null)          // at ceil → not cheap
  assert.equal(buyVolTier(0.30, null, 71), null)                       // high IVR proxy
})

test('no IV/RV pair AND no IVR → reference (cannot judge; not auto-rec)', () => {
  assert.equal(buyVolTier(null, null, NaN), 'reference')
  assert.equal(buyVolTier(0.30, null, NaN), 'reference') // IV present but no RV, no IVR
})

// ---- boardTierFor: dispatch wiring (the line that runs in scanSymbol) ----

test('boardTierFor routes long_straddle to buyVolTier', () => {
  // WMT inputs through the real dispatch → dropped (not qualified).
  assert.equal(
    boardTierFor('long_straddle', { ivr: 71, iv: 0.287, rv: 0.243, spansEarnings: false }),
    null
  )
  // Genuinely cheap straddle still boards.
  assert.equal(
    boardTierFor('long_straddle', { ivr: 55, iv: 0.20, rv: 0.25, spansEarnings: false }),
    'qualified'
  )
})

test('boardTierFor routes sell-vol to sellVolTier (floor + earnings gate intact)', () => {
  assert.equal(
    boardTierFor('iron_condor', { ivr: 50, iv: 0.30, rv: 0.30, spansEarnings: false }),
    'qualified'
  )
  assert.equal(
    boardTierFor('iron_condor', { ivr: 50, iv: 0.30, rv: 0.30, spansEarnings: true }),
    null // never auto-sell premium through earnings
  )
  assert.equal(
    boardTierFor('bear_call_spread', { ivr: 10, iv: 0.30, rv: 0.30, spansEarnings: false }),
    null // below reference floor
  )
})

test('boardTierFor leaves directional debit spreads to autoScanEligible (qualified here)', () => {
  assert.equal(
    boardTierFor('bull_call_spread', { ivr: 5, iv: 0.30, rv: 0.30, spansEarnings: false }),
    'qualified'
  )
})
