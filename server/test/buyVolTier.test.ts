/**
 * Buy-vol auto-board qualification (oppScanner.buyVolTier), board dispatch
 * (oppScanner.boardTierFor), and the sell-vol footgun guard (sellVolTier).
 *
 * buyVolTier delegates the "is vol cheap enough to buy" judgment to deriveRegime
 * (the single source of truth) so it stays consistent by construction:
 *   - dead-zone: 'buy' needs IV below RV by max(RV·15%, 2pp), not noise-level iv<rv
 *   - high-IVR guard: RV>IV but IVR>70 → deriveRegime → 'mid' → not qualified
 *   - no real RV → only the unreliable IVR-fallback rank → 'reference', never a rec
 *   Tiers: 'qualified' (real RV + regime 'buy') / null (regime ≠ buy) / 'reference' (no RV)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buyVolTier, boardTierFor, sellVolTier } from '../src/engine/oppScanner.js'

// ---- buyVolTier: real RV present → delegate to deriveRegime ----

test('WMT-style rich vol (IV>RV, high IVR) → dropped', () => {
  // Core stop-bleed. gap=+0.044 > threshold 0.0365 → sell-edge → not 'buy'.
  assert.equal(buyVolTier(0.287, 0.243, 71), null)
})

test('IV cheaper than RV by a meaningful margin → qualified', () => {
  // gap=-0.05 < -threshold(0.0375), IVR 55 ≤ 70 → deriveRegime 'buy'.
  assert.equal(buyVolTier(0.20, 0.25, 55), 'qualified')
})

test('noise-level cheap (inside deriveRegime dead-zone) → dropped', () => {
  // gap=-0.001, |gap| < max(RV·15%,2pp)=0.0375 → 'mid', not 'buy'. (review pt 3)
  assert.equal(buyVolTier(0.249, 0.25, 55), null)
})

test('cheap by margin but IVR historically high (>70) → dropped', () => {
  // gap=-0.05 buy-edge, but IVR 80 > 70 → deriveRegime downgrades to 'mid'. (review pt 2)
  assert.equal(buyVolTier(0.20, 0.25, 80), null)
})

test('IV >= RV → dropped regardless of IVR', () => {
  assert.equal(buyVolTier(0.30, 0.30, 40), null)
  assert.equal(buyVolTier(0.30, 0.30, 15), null) // low IVR must not rescue it
})

// ---- buyVolTier: no real RV → reference, never qualify on the IVR fallback (review pt 1) ----

test('RV missing → reference, even at low IVR (no authoritative cheapness signal)', () => {
  assert.equal(buyVolTier(0.30, null, 15), 'reference')
  assert.equal(buyVolTier(0.30, null, 5), 'reference')
})

test('IV missing / no signal at all → reference', () => {
  assert.equal(buyVolTier(null, 0.25, 55), 'reference')
  assert.equal(buyVolTier(null, null, NaN), 'reference')
})

// ---- sellVolTier footgun guard: a stray buy-vol call must NOT get 'qualified' (review pt 4) ----

test('sellVolTier(long_straddle) returns null, not qualified', () => {
  assert.equal(sellVolTier('long_straddle', 71, false), null)
  assert.equal(sellVolTier('long_straddle', 5, false), null)
})

// ---- boardTierFor: dispatch wiring (the line that runs in scanSymbol) ----

test('boardTierFor routes long_straddle to buyVolTier', () => {
  assert.equal(
    boardTierFor('long_straddle', { ivr: 71, iv: 0.287, rv: 0.243, spansEarnings: false }),
    null // WMT through the real dispatch → dropped
  )
  assert.equal(
    boardTierFor('long_straddle', { ivr: 55, iv: 0.20, rv: 0.25, spansEarnings: false }),
    'qualified' // genuinely cheap straddle still boards
  )
})

test('boardTierFor routes sell-vol to sellVolTier (floor + earnings gate intact)', () => {
  // iv/rv rich (1.33 ≥ SELL_IVRV_FLOOR) so the IV/RV gate passes and this stays a
  // pure routing/floor/earnings test — IV/RV demotion is covered in sellVolTier.test.
  assert.equal(
    boardTierFor('iron_condor', { ivr: 50, iv: 0.40, rv: 0.30, spansEarnings: false }),
    'qualified'
  )
  assert.equal(
    boardTierFor('iron_condor', { ivr: 50, iv: 0.40, rv: 0.30, spansEarnings: true }),
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
