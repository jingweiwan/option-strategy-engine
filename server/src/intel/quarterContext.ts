/**
 * Fiscal-quarter helpers for OCIFQ deep analysis.
 *
 * FMP consolidated statements and Motley Fool transcripts can lag each other
 * right after an earnings release — these helpers surface that gap to the LLM
 * and the UI so thesisItems don't mix Q1 segment data with Q2 CapEx.
 */

import type { QuarterlyIncome } from '../api/fmpFinancials.js'
import type { EarningsTranscript } from '../api/fmpFinancials.js'

export type FiscalQuarter = { year: number; quarter: number }

export function formatFiscalQuarter(fq: FiscalQuarter): string {
  return `${fq.year}Q${fq.quarter}`
}

/** Parse FMP `period` ("Q1" … "Q4") + fiscalYear string. */
export function fiscalFromIncomeRow(row: Pick<QuarterlyIncome, 'fiscalYear' | 'period'>): FiscalQuarter | null {
  const year = parseInt(row.fiscalYear, 10)
  const m = row.period.match(/^Q(\d)$/i)
  if (!Number.isFinite(year) || !m) return null
  const quarter = parseInt(m[1], 10)
  if (quarter < 1 || quarter > 4) return null
  return { year, quarter }
}

export function fiscalFromTranscript(t: Pick<EarningsTranscript, 'year' | 'quarter'>): FiscalQuarter {
  return { year: t.year, quarter: t.quarter }
}

/** Positive when a is later than b. */
export function compareFiscal(a: FiscalQuarter, b: FiscalQuarter): number {
  if (a.year !== b.year) return a.year - b.year
  return a.quarter - b.quarter
}

export type QuarterContext = {
  fmpLatest: FiscalQuarter | null
  transcriptLatest: FiscalQuarter | null
  /** FMP consolidated quarter is strictly ahead of the transcript we have. */
  lag: boolean
  /** Human-readable lines injected at the top of the LLM user prompt. */
  promptLines: string[]
  /** Short UI message when lag is true. */
  lagMessage: string | null
}

export function buildQuarterContext(input: {
  income: QuarterlyIncome[]
  transcripts: EarningsTranscript[]
}): QuarterContext {
  const fmpLatest = input.income.length > 0 ? fiscalFromIncomeRow(input.income[0]) : null
  const transcriptLatest =
    input.transcripts.length > 0 ? fiscalFromTranscript(input.transcripts[0]) : null

  const lag =
    fmpLatest != null &&
    transcriptLatest != null &&
    compareFiscal(fmpLatest, transcriptLatest) > 0

  const fmpLabel = fmpLatest ? formatFiscalQuarter(fmpLatest) : null
  const trLabel = transcriptLatest ? formatFiscalQuarter(transcriptLatest) : null

  const promptLines: string[] = ['\n--- Quarter Alignment (read first) ---']

  if (fmpLabel) {
    promptLines.push(
      `Latest consolidated financials (FMP): ${fmpLabel} — total revenue YoY, CapEx, FCF, margins cite THIS quarter only.`
    )
  }
  if (trLabel) {
    promptLines.push(
      `Latest earnings call transcript: ${trLabel} — segment breakdowns (e.g. Cloud, Search, backlog) only valid for THIS call's quarter.`
    )
  }

  if (lag && fmpLabel && trLabel) {
    promptLines.push(
      `⚠ QUARTER LAG: FMP (${fmpLabel}) is AHEAD of transcript (${trLabel}). This happens when earnings just released but the call transcript is not yet available.`,
      `- thesisItems: every delta MUST use consistent quarter labels — never mix ${fmpLabel} consolidated figures with ${trLabel} segment figures as if both were the latest quarter.`,
      `- Consolidated metrics (CapEx, FCF, total revenue, EPS): cite ${fmpLabel} only.`,
      `- Segment / backlog metrics from transcript: prefix with "${trLabel} 电话会" OR omit until transcript catches up to ${fmpLabel}.`,
      `- Do NOT label segment growth as "${fmpLabel}" when the only source is the ${trLabel} call.`
    )
  } else if (fmpLabel) {
    promptLines.push(
      `Primary reference quarter for all thesisItems.delta fiscal labels: ${fmpLabel} (must be consistent across all items).`
    )
  }

  const lagMessage =
    lag && fmpLabel && trLabel
      ? `合并财报已至 ${fmpLabel}，电话会 transcript 仍为 ${trLabel} — 分部数据可能滞后，请勿混季引用。`
      : null

  return { fmpLatest, transcriptLatest, lag, promptLines, lagMessage }
}
