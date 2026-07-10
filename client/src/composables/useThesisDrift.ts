/**
 * Thesis drift detection — tracks OCIFQ score history per symbol.
 *
 * Every time a DeepAnalysis is completed, `record(analysis)` snapshots
 * the scores. When the user loads a symbol again later, `getDrift(sym)`
 * compares current vs last-recorded to surface meaningful changes.
 *
 * Storage: localStorage `ose-thesis-history-v1`
 * Keeps last 5 snapshots per symbol, max 30 symbols.
 */

import { reactive, computed } from 'vue'
import type { DeepAnalysis, OcifqScore } from '@/types'

export type ScoreSnapshot = {
  total: number
  O: number
  C: number
  I: number
  F: number
  Q: number
  view: 'bullish' | 'bearish' | 'neutral'
  viewConfidence: number
  date: string        // YYYY-MM-DD
  generatedAt: string // ISO timestamp
}

export type DriftResult = {
  symbol: string
  current: ScoreSnapshot
  previous: ScoreSnapshot | null
  /** total score change (current - previous). null if no history. */
  totalDelta: number | null
  /** Per-dimension deltas */
  dimensionDeltas: { key: string; delta: number; from: number; to: number }[]
  /** Significant = |totalDelta| >= 10 or view changed */
  significant: boolean
  /** Human-readable drift label */
  label: string
}

const STORAGE_KEY = 'ose-thesis-history-v1'
const MAX_SNAPSHOTS_PER_SYM = 5
const MAX_SYMBOLS = 30

type HistoryStore = Record<string, ScoreSnapshot[]>

function readStorage(): HistoryStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as HistoryStore
  } catch { return {} }
}

function writeStorage(store: HistoryStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch { /* quota exceeded */ }
}

const history = reactive<HistoryStore>(readStorage())

function toSnapshot(a: DeepAnalysis): ScoreSnapshot {
  const today = new Date().toISOString().slice(0, 10)
  return {
    total: a.scores.total,
    O: a.scores.O,
    C: a.scores.C,
    I: a.scores.I,
    F: a.scores.F,
    Q: a.scores.Q,
    view: a.view,
    viewConfidence: a.viewConfidence,
    date: today,
    generatedAt: a.generatedAt
  }
}

export function useThesisDrift() {
  /** Record a new analysis snapshot. Dedupes by date (one per day). */
  function record(analysis: DeepAnalysis) {
    const sym = analysis.symbol.toUpperCase()
    const snap = toSnapshot(analysis)
    const list = history[sym] ?? []

    // Dedupe: if we already have a snapshot for today, replace it
    const today = snap.date
    const filtered = list.filter((s) => s.date !== today)
    filtered.unshift(snap)

    // Keep only last N
    history[sym] = filtered.slice(0, MAX_SNAPSHOTS_PER_SYM)

    // Evict oldest symbols if over limit
    const syms = Object.keys(history)
    if (syms.length > MAX_SYMBOLS) {
      // Find symbol with oldest latest snapshot
      const sorted = syms
        .map((s) => ({ s, latest: history[s]?.[0]?.generatedAt ?? '' }))
        .sort((a, b) => a.latest.localeCompare(b.latest))
      for (let i = 0; i < syms.length - MAX_SYMBOLS; i++) {
        delete history[sorted[i].s]
      }
    }

    writeStorage(history)
  }

  /** Get drift for a symbol. Returns null if no history. */
  function getDrift(symbol: string, currentAnalysis: DeepAnalysis): DriftResult | null {
    const sym = symbol.toUpperCase()
    const list = history[sym]
    if (!list || list.length === 0) return null

    const current = toSnapshot(currentAnalysis)
    // Find the most recent PREVIOUS snapshot (different date from current)
    const previous = list.find((s) => s.date !== current.date) ?? null

    if (!previous) return null

    const totalDelta = current.total - previous.total
    const dims: DriftResult['dimensionDeltas'] = []
    for (const key of ['O', 'C', 'I', 'F', 'Q'] as const) {
      const from = previous[key]
      const to = current[key]
      if (from !== to) {
        dims.push({ key, delta: to - from, from, to })
      }
    }

    const viewChanged = current.view !== previous.view
    const significant = Math.abs(totalDelta) >= 10 || viewChanged

    let label = ''
    if (totalDelta > 0) {
      label = `+${totalDelta} pts`
    } else if (totalDelta < 0) {
      label = `${totalDelta} pts`
    } else {
      label = 'unchanged'
    }
    if (viewChanged) {
      label += ` (${previous.view} → ${current.view})`
    }

    return { symbol: sym, current, previous, totalDelta, dimensionDeltas: dims, significant, label }
  }

  /** Get all symbols with significant drift alerts (for dashboard/positions). */
  const driftAlerts = computed(() => {
    const alerts: { symbol: string; totalDelta: number; label: string; previousDate: string }[] = []
    for (const sym of Object.keys(history)) {
      const list = history[sym]
      if (!list || list.length < 2) continue
      const current = list[0]
      const previous = list[1]
      const totalDelta = current.total - previous.total
      const viewChanged = current.view !== previous.view
      if (Math.abs(totalDelta) >= 10 || viewChanged) {
        let label = `${sym}: ${totalDelta > 0 ? '+' : ''}${totalDelta} pts`
        if (viewChanged) label += ` (${previous.view} → ${current.view})`
        alerts.push({ symbol: sym, totalDelta, label, previousDate: previous.date })
      }
    }
    return alerts
  })

  /** Get score history for a symbol (for sparkline / trend display). */
  function getHistory(symbol: string): ScoreSnapshot[] {
    return history[symbol.toUpperCase()] ?? []
  }

  return { record, getDrift, driftAlerts, getHistory }
}
