/**
 * Snapshot store safety: load must not swallow corrupt files as [], and
 * replace-today writers must not overwrite a nonempty book after an empty load.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SnapshotStoreError,
  assertLoadedHistoryMatchesFile,
  loadSnapshots,
  saveSnapshots
} from '../src/feedback/store.js'
import { recordDashboardScanSnapshots } from '../src/feedback/record.js'
import type { ScannedOpp } from '../src/engine/oppScanner.js'

async function withCacheDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ose-snap-'))
  const prev = process.env.AI_CACHE_DIR
  process.env.AI_CACHE_DIR = dir
  try {
    await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.AI_CACHE_DIR
    else process.env.AI_CACHE_DIR = prev
  }
}

function recDir(cache: string): string {
  return join(cache, 'recommendations')
}

function snapPath(cache: string): string {
  return join(recDir(cache), 'snapshots.json')
}

const historyRow = {
  id: 'hist-1',
  etDay: '2026-05-11',
  capturedAt: '2026-05-11T12:00:00.000Z',
  source: 'dashboard' as const,
  sym: 'AAPL',
  strategyId: 'iron_condor' as const,
  expiration: '2026-06-20',
  spot: 200,
  iv: 0.25,
  ivr: 60,
  rvAtScan: null,
  ivRvGap: null,
  regime: 'sell' as const,
  score: 1,
  pop: 0.7,
  ev: 0.1,
  netPremium: 1,
  maxProfit: 1,
  maxLoss: -4,
  dte: 30,
  breakevens: [],
  legs: [],
  variant: null,
  aiView: null,
  aiViewConfidence: null,
  exitPolicy: null,
  outcome: null
}

function scannedOpp(): ScannedOpp {
  return {
    sym: 'MSFT',
    name: 'Microsoft',
    expiration: '2026-09-18',
    strategyId: 'iron_condor',
    strategy: '铁鹰',
    score: 1,
    spot: 400,
    iv: 0.3,
    ivr: 55,
    dte: 30,
    pop: 0.7,
    ev: 0.2,
    maxProfit: 1,
    maxLoss: -3,
    netPremium: 1.2,
    delta: 0,
    gamma: 0,
    vega: 0,
    theta: 0,
    regime: 'sell',
    rvAtScan: null,
    breakevens: [],
    legs: [{ type: 'put', action: 'sell', strike: 390, premium: 2, quantity: 1 }]
  }
}

test('loadSnapshots: missing file → empty array', async () => {
  await withCacheDir(async () => {
    assert.deepEqual(await loadSnapshots(), [])
  })
})

test('loadSnapshots: corrupt JSON throws (does not return [])', async () => {
  await withCacheDir(async (cache) => {
    await mkdir(recDir(cache), { recursive: true })
    await writeFile(snapPath(cache), '{not-json', 'utf8')
    await assert.rejects(() => loadSnapshots(), SnapshotStoreError)
  })
})

test('loadSnapshots: non-array JSON throws', async () => {
  await withCacheDir(async (cache) => {
    await mkdir(recDir(cache), { recursive: true })
    await writeFile(snapPath(cache), '{"oops":true}', 'utf8')
    await assert.rejects(() => loadSnapshots(), SnapshotStoreError)
  })
})

test('saveSnapshots: atomic write + rolling backup', async () => {
  await withCacheDir(async (cache) => {
    await saveSnapshots([historyRow])
    const first = JSON.parse(await readFile(snapPath(cache), 'utf8'))
    assert.equal(first.length, 1)
    await saveSnapshots([historyRow, { ...historyRow, id: 'hist-2' }])
    const second = JSON.parse(await readFile(snapPath(cache), 'utf8'))
    assert.equal(second.length, 2)
    const { readdir, writeFile } = await import('node:fs/promises')
    await writeFile(join(recDir(cache), 'snapshots.backup-1782788643.json'), '[]', 'utf8')
    await saveSnapshots([historyRow])
    const names = await readdir(recDir(cache))
    assert.ok(names.includes('snapshots.backup-1782788643.json'), 'must not prune manual/legacy backup-* files')
    const backups = names.filter((n) => n.startsWith('snapshots.bak-'))
    assert.ok(backups.length >= 1, `expected a backup, got ${backups.join(',')}`)
  })
})

test('assertLoadedHistoryMatchesFile: refuses empty load against nonempty file', async () => {
  await withCacheDir(async (cache) => {
    await mkdir(recDir(cache), { recursive: true })
    await writeFile(snapPath(cache), 'x'.repeat(64), 'utf8')
    await assert.rejects(() => assertLoadedHistoryMatchesFile([]), SnapshotStoreError)
  })
})

test('recordDashboardScanSnapshots: keeps prior days when replacing today', async () => {
  await withCacheDir(async () => {
    await saveSnapshots([historyRow])
    await recordDashboardScanSnapshots([scannedOpp()])
    const all = await loadSnapshots()
    assert.equal(all.some((s) => s.id === 'hist-1'), true)
    assert.equal(all.some((s) => s.sym === 'MSFT' && s.source === 'dashboard'), true)
  })
})

test('recordDashboardScanSnapshots: corrupt book is not overwritten', async () => {
  await withCacheDir(async (cache) => {
    await mkdir(recDir(cache), { recursive: true })
    const poison = '{truncated'
    await writeFile(snapPath(cache), poison, 'utf8')
    await assert.rejects(() => recordDashboardScanSnapshots([scannedOpp()]), SnapshotStoreError)
    assert.equal(await readFile(snapPath(cache), 'utf8'), poison)
  })
})
