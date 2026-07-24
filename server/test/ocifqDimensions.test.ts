import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OCIFQ_DIM_LABELS,
  normalizeOcifqDimensions
} from '../src/intel/deepAnalysis.js'

test('normalizeOcifqDimensions fills blank C label from canonical map', () => {
  const dims = normalizeOcifqDimensions([
    { key: 'O', label: '寡头定价权', score: 9, signal: 'bullish' },
    { key: 'C', label: '', score: 9, signal: 'bullish', reasoning: 'AI infra' },
    { key: 'I', label: '行业利润断层', score: 8 },
    { key: 'F', label: '财务三爆', score: 7 },
    { key: 'Q', label: '连续季报验证', score: 8 }
  ])
  assert.equal(dims.find((d) => d.key === 'C')!.label, '长周期催化')
  assert.equal(dims.find((d) => d.key === 'C')!.reasoning, 'AI infra')
})

test('normalizeOcifqDimensions restores missing dimensions and stable order', () => {
  const dims = normalizeOcifqDimensions([
    { key: 'F', label: 'wrong', score: 5 },
    { key: 'O', label: 'wrong', score: 9 }
  ])
  assert.deepEqual(dims.map((d) => d.key), ['O', 'C', 'I', 'F', 'Q'])
  assert.deepEqual(
    dims.map((d) => d.label),
    Object.values(OCIFQ_DIM_LABELS)
  )
  assert.equal(dims.find((d) => d.key === 'C')!.score, 0)
  assert.equal(dims.find((d) => d.key === 'C')!.signal, 'neutral')
})

test('normalizeOcifqDimensions clamps score and ignores unknown signal', () => {
  const dims = normalizeOcifqDimensions([
    { key: 'O', score: 99, signal: 'maybe' as any }
  ])
  assert.equal(dims[0].score, 10)
  assert.equal(dims[0].signal, 'neutral')
})
