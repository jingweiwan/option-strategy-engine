import test from 'node:test'
import assert from 'node:assert/strict'
import { validateOptionLegs } from '../src/api/rhPositions.js'

const GOOD = {
  sym: 'MU', side: 'long', qty: 1, optionType: 'put',
  strike: 720, expiration: '2026-09-18', avgCost: 744
}
// fetchedAt is part of the gate: without it rhAgeHours() is null and staleness
// warnings go silently dead.
const wrap = (legs: any[]): any =>
  ({ schema: 'rh-positions-v1', fetchedAt: '2026-08-25T01:58:52.053Z', optionLegs: legs })

test('rhPositions: accepts a conforming leg', () => {
  assert.equal(validateOptionLegs(wrap([GOOD])), true)
})

// The exact bridge-file shape written on 2026-08-25: `type`/`avgPrice` instead
// of `optionType`/`avgCost`. It still parsed, still carried a valid schema
// string, and still passed the account-value check — so every consumer read
// zeros in silence: net greeks 0/0/0/0, marks null, structures empty,
// wheelScanner saw no short calls. Only a leg-shape gate catches it.
test('rhPositions: rejects the 2026-08-25 `type`/`avgPrice` writer', () => {
  const bad = { ...GOOD, type: 'put', avgPrice: 7.44 } as any
  delete bad.optionType
  delete bad.avgCost
  assert.equal(validateOptionLegs(wrap([bad])), false)
})

test('rhPositions: one malformed leg rejects the whole file', () => {
  const bad = { ...GOOD, optionType: undefined } as any
  assert.equal(validateOptionLegs(wrap([GOOD, GOOD, bad])), false)
})

test('rhPositions: avgCost must be present — 0 is valid, undefined is not', () => {
  assert.equal(validateOptionLegs(wrap([{ ...GOOD, avgCost: 0 }])), true)
  assert.equal(validateOptionLegs(wrap([{ ...GOOD, avgCost: undefined }])), false)
  assert.equal(validateOptionLegs(wrap([{ ...GOOD, avgCost: null }])), false)
})

test('rhPositions: rejects a non-array optionLegs', () => {
  assert.equal(
    validateOptionLegs({ schema: 'rh-positions-v1', fetchedAt: '2026-08-25T01:58:52.053Z' } as any),
    false
  )
})

test('rhPositions: rejects a file missing fetchedAt (staleness warnings would be dead)', () => {
  const noStamp: any = wrap([GOOD])
  delete noStamp.fetchedAt
  assert.equal(validateOptionLegs(noStamp), false)
  assert.equal(validateOptionLegs({ ...wrap([GOOD]), fetchedAt: 'not-a-date' }), false)
})
