/**
 * IV Rank source-priority chain (see ivHistory.ts):
 *   1. own history ≥ 1yr → own annual IVR (graduate, confidence 1)
 *   2. else DoltHub 52-week range → true IVR now (source 'dolt-iv')
 *   3. else own history 30–251 pts → shrunk toward 50 (confidence = pts/252)
 *   4. else → RV fallback
 * Uses an isolated IV_HISTORY_FILE so the real accumulating store isn't touched.
 * The store caches in memory on first read, so all seeds are written up front.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'ivrank-'))
const STORE = join(tmp, 'iv-history.json')
process.env.IV_HISTORY_FILE = STORE // must be set BEFORE importing the module

// Seed the whole store once, up front (load() memoizes on first read).
writeFileSync(STORE, JSON.stringify({
  ZSHALLOW: Array.from({ length: 42 }, (_, i) => ({ date: `2026-05-${i + 1}`, iv: 0.20 + i * 0.001 })),
  ZMATURE: Array.from({ length: 260 }, (_, i) => ({ date: `d${i}`, iv: 0.10 + (i % 31) * 0.01 }))
}))

let computeIvRankFromHistory: typeof import('../src/api/ivHistory.js').computeIvRankFromHistory
before(async () => {
  ;({ computeIvRankFromHistory } = await import('../src/api/ivHistory.js'))
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const rv = { rank: 40, samples: 200, currentRv: 0.25, rvLow: 0.1, rvHigh: 0.5 }

test('DoltHub range is primary while own history is immature → true annual IVR', () => {
  // AAPL real numbers: 0.2872 in [0.1748, 0.3290] → 72.9
  const r = computeIvRankFromHistory('ZAAPL', 0.2872, rv, { yearHigh: 0.329, yearLow: 0.1748, asOf: '2026-07-01' })!
  assert.equal(r.source, 'dolt-iv')
  assert.ok(Math.abs(r.rank - 72.9) < 0.5, `rank ${r.rank}`)
  assert.equal(r.confidence, 1)
  assert.equal(r.currentRv, 0.25) // RV threaded through for the IV-RV edge
})

test('no DoltHub + shallow own history → shrunk toward 50 (not a hard 100)', () => {
  // current 0.30 is a fresh max → raw 100, confidence ≈ 43/252 ≈ 0.17 → ~58.5
  const r = computeIvRankFromHistory('ZSHALLOW', 0.30, rv, null)!
  assert.equal(r.source, 'iv-history')
  assert.ok(r.rank > 50 && r.rank < 70, `shrunk rank should be mildly elevated, got ${r.rank}`)
  assert.ok(r.rank < 100, 'must not read a hard 100 on a shallow window')
  assert.ok((r.confidence ?? 1) < 0.3, `confidence ${r.confidence}`)
})

test('own history ≥ 1yr graduates to self-sufficient (ignores DoltHub)', () => {
  const r = computeIvRankFromHistory('ZMATURE', 0.25, rv, { yearHigh: 0.9, yearLow: 0.1, asOf: '2026-07-01' })!
  assert.equal(r.source, 'iv-history') // graduated — did NOT use DoltHub
  assert.equal(r.confidence, 1)
})

test('no history + no DoltHub → RV fallback', () => {
  const r = computeIvRankFromHistory('ZFRESH', 0.30, rv, null)!
  assert.equal(r.source, 'rv-fallback')
  assert.equal(r.rank, 40)
})
