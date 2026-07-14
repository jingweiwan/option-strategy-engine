/**
 * Lightweight technical indicators computed from OHLCV bars.
 *
 * These feed into the AI directional-view prompt to give the model
 * richer signals than just "today's chg%".
 *
 * All indicators are computed locally — no external TA library needed.
 */

import type { OhlcBar } from '../api/marketdata.js'

// ---------- Types ----------

/** A price level that has repeatedly acted as support/resistance. `touches` is
 *  how many swing pivots clustered there — higher = more significant. */
export type KeyLevel = { price: number; touches: number }

export type TechnicalSnapshot = {
  /** 5-trading-day cumulative return (%) */
  chg5d: number | null
  /** 20-trading-day cumulative return (%) */
  chg20d: number | null
  /** Where current price sits relative to 52-week range (0-100) */
  week52Pct: number | null
  /** 52-week high price */
  week52High: number | null
  /** 52-week low price */
  week52Low: number | null
  /** 20-day SMA value (not just above/below). */
  sma20: number | null
  /** 50-day SMA value. */
  sma50: number | null
  /** Support/resistance levels from clustered swing pivots + 52wk extremes. */
  keyLevels: KeyLevel[]
  /** MACD line (12-EMA minus 26-EMA) */
  macd: number | null
  /** MACD signal line (9-EMA of MACD) */
  macdSignal: number | null
  /** MACD histogram (macd - signal) */
  macdHist: number | null
  /** MACD interpretation: bullish / bearish / neutral */
  macdView: 'bullish' | 'bearish' | 'neutral'
  /** RSI(14) value (0-100) */
  rsi14: number | null
  /** RSI interpretation */
  rsiView: 'overbought' | 'oversold' | 'neutral'
  /** Whether price is above 20-day SMA */
  aboveSma20: boolean | null
  /** Whether price is above 50-day SMA */
  aboveSma50: boolean | null
  /** 20-day average volume */
  avgVolume20d: number | null
  /** Latest volume / 20-day avg (> 1.5 = unusual) */
  volumeRatio: number | null
}

// ---------- Helpers ----------

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

function ema(values: number[], period: number): number[] {
  if (values.length < period) return []
  const k = 2 / (period + 1)
  // Seed with SMA of first `period` values
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  const result: number[] = new Array(period - 1).fill(NaN)
  result.push(prev)
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    result.push(prev)
  }
  return result
}

function computeRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let avgGain = 0
  let avgLoss = 0

  // Initial average
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) avgGain += diff
    else avgLoss -= diff
  }
  avgGain /= period
  avgLoss /= period

  // Smoothed
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function computeMacd(closes: number[]): {
  macd: number | null
  signal: number | null
  hist: number | null
} {
  if (closes.length < 35) return { macd: null, signal: null, hist: null }
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)

  // MACD line = EMA12 - EMA26
  const macdLine: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (Number.isNaN(ema12[i]) || Number.isNaN(ema26[i])) {
      macdLine.push(NaN)
    } else {
      macdLine.push(ema12[i] - ema26[i])
    }
  }

  // Signal = 9-EMA of MACD line (only valid values)
  const validMacd = macdLine.filter((x) => !Number.isNaN(x))
  if (validMacd.length < 9) return { macd: null, signal: null, hist: null }

  const signalLine = ema(validMacd, 9)
  const latestMacd = validMacd[validMacd.length - 1]
  const latestSignal = signalLine[signalLine.length - 1]

  if (Number.isNaN(latestSignal)) return { macd: latestMacd, signal: null, hist: null }

  return {
    macd: latestMacd,
    signal: latestSignal,
    hist: latestMacd - latestSignal
  }
}

function periodReturn(closes: number[], lookback: number): number | null {
  if (closes.length < lookback + 1) return null
  const old = closes[closes.length - 1 - lookback]
  const cur = closes[closes.length - 1]
  if (!old || !cur) return null
  return ((cur - old) / old) * 100
}

/**
 * Support/resistance from swing pivots. A fractal swing high/low is a bar whose
 * high/low is the extreme of a ±k window; nearby pivots (within CLUSTER_PCT) are
 * merged, and 52-week extremes are always included. `touches` = pivots in the
 * cluster (how often price turned there). Kept: clusters with ≥2 pivots (a level
 * tested more than once), capped to the most-tested. Pure + exported for tests.
 */
export function computeKeyLevels(bars: OhlcBar[], k = 5, clusterPct = 0.015, max = 10): KeyLevel[] {
  if (bars.length < 2 * k + 5) return []
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)

  const pivots: number[] = []
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - k; j <= i + k; j++) {
      if (highs[j] > highs[i]) isHigh = false
      if (lows[j] < lows[i]) isLow = false
    }
    if (isHigh) pivots.push(highs[i])
    if (isLow) pivots.push(lows[i])
  }
  // 52-week extremes are always meaningful levels.
  pivots.push(highs.reduce((a, b) => (b > a ? b : a), -Infinity))
  pivots.push(lows.reduce((a, b) => (b < a ? b : a), Infinity))

  pivots.sort((a, b) => a - b)
  const clusters: number[][] = []
  for (const p of pivots) {
    const last = clusters[clusters.length - 1]
    const lastAvg = last ? last.reduce((a, b) => a + b, 0) / last.length : 0
    if (last && lastAvg > 0 && Math.abs(p - lastAvg) / lastAvg < clusterPct) last.push(p)
    else clusters.push([p])
  }

  return clusters
    .map((c) => ({ price: Math.round((c.reduce((a, b) => a + b, 0) / c.length) * 100) / 100, touches: c.length }))
    .filter((l) => l.touches >= 2)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, max)
    .sort((a, b) => a.price - b.price)
}

// ---------- Public ----------

/**
 * Compute all technical indicators from OHLCV bars.
 * Expects bars in chronological order, ideally 60+ bars for reliable signals.
 */
export function computeTechnicals(bars: OhlcBar[]): TechnicalSnapshot {
  if (bars.length < 5) {
    return {
      chg5d: null, chg20d: null,
      week52Pct: null, week52High: null, week52Low: null,
      sma20: null, sma50: null, keyLevels: [],
      macd: null, macdSignal: null, macdHist: null, macdView: 'neutral',
      rsi14: null, rsiView: 'neutral',
      aboveSma20: null, aboveSma50: null,
      avgVolume20d: null, volumeRatio: null
    }
  }

  const closes = bars.map((b) => b.close)
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const volumes = bars.map((b) => b.volume)
  const latest = closes[closes.length - 1]

  // Returns
  const chg5d = periodReturn(closes, Math.min(5, closes.length - 1))
  const chg20d = periodReturn(closes, Math.min(20, closes.length - 1))

  // 52-week high/low (use all available bars, up to 252)
  // Use reduce instead of Math.max(...arr) to avoid stack overflow on large arrays
  const w52High = highs.reduce((a, b) => (b > a ? b : a), -Infinity)
  const w52Low = lows.reduce((a, b) => (b < a ? b : a), Infinity)
  const w52Range = w52High - w52Low
  const week52Pct = w52Range > 0 ? ((latest - w52Low) / w52Range) * 100 : null

  // MACD
  const { macd, signal: macdSignal, hist: macdHist } = computeMacd(closes)
  let macdView: 'bullish' | 'bearish' | 'neutral' = 'neutral'
  if (macdHist != null) {
    if (macdHist > 0) macdView = 'bullish'
    else if (macdHist < 0) macdView = 'bearish'
  }

  // RSI
  const rsi14 = computeRsi(closes, 14)
  let rsiView: 'overbought' | 'oversold' | 'neutral' = 'neutral'
  if (rsi14 != null) {
    if (rsi14 >= 70) rsiView = 'overbought'
    else if (rsi14 <= 30) rsiView = 'oversold'
  }

  // SMA
  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)

  // Volume
  const avgVol20 = sma(volumes, Math.min(20, volumes.length))
  const latestVol = volumes[volumes.length - 1]
  const volumeRatio = avgVol20 && avgVol20 > 0 ? latestVol / avgVol20 : null

  return {
    chg5d,
    chg20d,
    week52Pct,
    week52High: w52High,
    week52Low: w52Low,
    sma20: sma20 != null ? Math.round(sma20 * 100) / 100 : null,
    sma50: sma50 != null ? Math.round(sma50 * 100) / 100 : null,
    keyLevels: computeKeyLevels(bars),
    macd: macd != null ? Math.round(macd * 100) / 100 : null,
    macdSignal: macdSignal != null ? Math.round(macdSignal * 100) / 100 : null,
    macdHist: macdHist != null ? Math.round(macdHist * 100) / 100 : null,
    macdView,
    rsi14: rsi14 != null ? Math.round(rsi14 * 10) / 10 : null,
    rsiView,
    aboveSma20: sma20 != null ? latest > sma20 : null,
    aboveSma50: sma50 != null ? latest > sma50 : null,
    avgVolume20d: avgVol20 != null ? Math.round(avgVol20) : null,
    volumeRatio: volumeRatio != null ? Math.round(volumeRatio * 100) / 100 : null
  }
}
