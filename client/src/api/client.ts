import type {
  DashboardData,
  DashboardNarrative,
  DailyIntelBrief,
  DeepAnalysis,
  LiveEngineInput,
  LiveEngineResponse,
  PerformanceData,
  TickerResponse,
  RhPositionsView,
  RhStrategyPnl,
  WheelScanResult
} from '@/types'

export type DashboardSnapshot = {
  asof: string
  spy: { v: number; chg: number }
  vixy: { v: number; chg: number }
  ivRankMedian: number
  fearGreed?: number | null
  /** Watchlist earnings within the entry-span window, soonest first. */
  earningsUpcoming?: { sym: string; label: string; daysUntil: number }[]
  fedDays?: number
  watchlistTickers?: { sym: string; iv: number; ivr: number; ivrReliable?: boolean; em: number; chg: number }[]
  /** What the gated board actually surfaced — grounds the AI enginePose. */
  board?: {
    qualifiedCount: number
    emptyReason?: string
    setups?: { sym: string; strategy: string }[]
  }
}

export async function fetchAiDashboardNarrative(snap: DashboardSnapshot): Promise<DashboardNarrative> {
  const res = await fetch('/api/ai/dashboard-narrative', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snap)
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AI ${res.status}: ${text}`)
  }
  return res.json()
}

export type SymbolSearchHit = {
  symbol: string
  description: string
  type: string
}

export async function fetchSymbolSearch(q: string): Promise<SymbolSearchHit[]> {
  const t = q.trim()
  if (t.length < 1) return []
  const res = await fetch(`/api/symbols/search?q=${encodeURIComponent(t)}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`search ${res.status}: ${text.slice(0, 120)}`)
  }
  const data = (await res.json()) as { results?: SymbolSearchHit[]; error?: string }
  return Array.isArray(data.results) ? data.results : []
}

export async function fetchDashboard(symbols?: string[]): Promise<DashboardData> {
  const qs =
    symbols && symbols.length > 0
      ? `?symbols=${encodeURIComponent(symbols.join(','))}`
      : ''
  const res = await fetch(`/api/dashboard${qs}`)
  if (!res.ok) {
    // Surface structured server errors ({ error, detail, hint }) so the UI
    // can show actionable text instead of "API 502".
    let msg = `API ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) {
        msg = body.error
        if (body.detail) msg += ` — ${body.detail}`
        if (body.hint) msg += ` (${body.hint})`
      }
    } catch {
      /* response wasn't JSON */
    }
    throw new Error(msg)
  }
  return res.json()
}

export async function fetchLiveStrategies(input: LiveEngineInput): Promise<LiveEngineResponse> {
  const res = await fetch('/api/strategies/live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json()
}

export async function fetchTicker(symbol: string, expiration?: string): Promise<TickerResponse> {
  const params = new URLSearchParams({ symbol })
  if (expiration) params.set('expiration', expiration)
  const res = await fetch(`/api/ticker?${params}`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json()
}

export async function fetchWheelScan(symbols?: string[]): Promise<WheelScanResult> {
  const qs =
    symbols && symbols.length > 0
      ? `?symbols=${encodeURIComponent(symbols.join(','))}`
      : ''
  const res = await fetch(`/api/wheel${qs}`)
  if (!res.ok) {
    let msg = `API ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch { /* not JSON */ }
    throw new Error(msg)
  }
  return res.json()
}

export async function fetchDailyIntel(symbols?: string[]): Promise<DailyIntelBrief> {
  const qs =
    symbols && symbols.length > 0
      ? `?symbols=${encodeURIComponent(symbols.join(','))}`
      : ''
  const res = await fetch(`/api/intel/daily${qs}`)
  if (!res.ok) {
    let msg = `API ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch { /* not JSON */ }
    throw new Error(msg)
  }
  return res.json()
}

export async function fetchExpirations(symbol: string): Promise<string[]> {
  const res = await fetch(`/api/expirations?symbol=${encodeURIComponent(symbol)}`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.expirations ?? []
}

export async function fetchDeepAnalysis(symbol: string): Promise<DeepAnalysis> {
  const res = await fetch(`/api/intel/deep/${encodeURIComponent(symbol.toUpperCase())}`)
  if (!res.ok) {
    let msg = `API ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
      if (body?.detail) msg += ` — ${body.detail}`
    } catch { /* not JSON */ }
    throw new Error(msg)
  }
  return res.json()
}

export async function fetchPerformance(): Promise<PerformanceData> {
  const res = await fetch('/api/feedback/performance')
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json()
}

export async function hydrateOutcomes(opts?: {
  horizonDays?: number
  maxUpdates?: number
}): Promise<{ ok: boolean; updated: number; pendingWithinHorizon: number }> {
  const res = await fetch('/api/feedback/recommendations/hydrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {})
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json()
}

export async function fetchRhPositions(): Promise<RhPositionsView | null> {
  const res = await fetch('/api/rh/positions')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`rh positions: ${res.status}`)
  return res.json()
}

export async function fetchRhStrategyPnl(): Promise<RhStrategyPnl | null> {
  const res = await fetch('/api/rh/strategy-pnl')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`rh strategy pnl: ${res.status}`)
  return res.json()
}
