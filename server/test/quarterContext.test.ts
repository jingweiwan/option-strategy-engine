import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQuarterContext,
  compareFiscal,
  fiscalFromIncomeRow,
  formatFiscalQuarter
} from '../src/intel/quarterContext.js'

test('fiscalFromIncomeRow parses FMP period labels', () => {
  assert.deepEqual(
    fiscalFromIncomeRow({ fiscalYear: '2026', period: 'Q2' }),
    { year: 2026, quarter: 2 }
  )
  assert.equal(fiscalFromIncomeRow({ fiscalYear: 'x', period: 'Q5' }), null)
})

test('buildQuarterContext detects FMP ahead of transcript (quarter lag)', () => {
  const ctx = buildQuarterContext({
    income: [{ fiscalYear: '2026', period: 'Q2' } as any],
    transcripts: [{ year: 2026, quarter: 1, symbol: 'GOOGL', date: '', content: 'x', entries: [] }]
  })
  assert.equal(ctx.lag, true)
  assert.equal(formatFiscalQuarter(ctx.fmpLatest!), '2026Q2')
  assert.equal(formatFiscalQuarter(ctx.transcriptLatest!), '2026Q1')
  assert.ok(ctx.promptLines.some((l) => l.includes('QUARTER LAG')))
  assert.ok(ctx.lagMessage?.includes('2026Q2'))
})

test('buildQuarterContext aligned quarters — no lag banner', () => {
  const ctx = buildQuarterContext({
    income: [{ fiscalYear: '2026', period: 'Q2' } as any],
    transcripts: [{ year: 2026, quarter: 2, symbol: 'GOOGL', date: '', content: 'x', entries: [] }]
  })
  assert.equal(ctx.lag, false)
  assert.equal(ctx.lagMessage, null)
  assert.ok(ctx.promptLines.some((l) => l.includes('Primary reference quarter')))
})

test('compareFiscal orders quarters chronologically', () => {
  assert.equal(compareFiscal({ year: 2026, quarter: 2 }, { year: 2026, quarter: 1 }), 1)
  assert.equal(compareFiscal({ year: 2025, quarter: 4 }, { year: 2026, quarter: 1 }), -1)
})
