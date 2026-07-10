/**
 * CNN Fear & Greed index — semi-public JSON feed used by their public chart.
 * Not an official API; format has been stable for years but could change.
 *
 * Endpoint: https://production.dataviz.cnn.io/index/fearandgreed/graphdata
 *
 * Response (relevant slice):
 *   {
 *     "fear_and_greed": {
 *       "score": 62.4,
 *       "rating": "Greed",
 *       "previous_close": 60.1,
 *       "previous_1_week": 58.0,
 *       ...
 *     },
 *     ...
 *   }
 */

const URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata'

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  Accept: 'application/json,text/plain,*/*'
}

export type FearGreed = {
  score: number // 0-100, integer
  rating: string // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  source: 'cnn' | 'vix-proxy'
}

/** 4 second hard cap. CNN's CDN is sometimes blocked from CN — fail fast,
 *  don't drag the whole /api/dashboard latency along. */
const CNN_TIMEOUT_MS = Number(process.env.CNN_TIMEOUT_MS ?? '4000')

export async function fetchCnnFearGreed(): Promise<FearGreed> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CNN_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(URL, { headers: HEADERS, signal: controller.signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`CNN timeout after ${CNN_TIMEOUT_MS}ms`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`CNN ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as any
  const fg = data?.fear_and_greed
  if (!fg) throw new Error('CNN: response missing fear_and_greed payload')
  const score = Number(fg.score)
  if (!Number.isFinite(score)) throw new Error(`CNN: invalid score ${fg.score}`)
  return {
    score: Math.round(score),
    rating: String(fg.rating ?? 'Unknown'),
    source: 'cnn'
  }
}

/**
 * Derive a Fear & Greed approximation from VIX alone. NOT the same algorithm
 * as CNN (they use 7 inputs); this is a rough single-factor proxy that
 * always works as long as we have VIX. Anchors:
 *   VIX 12  → ~85 (extreme greed)
 *   VIX 16  → ~62 (greed)
 *   VIX 20  → ~46 (neutral)
 *   VIX 25  → ~25 (fear)
 *   VIX 30+ → 4 (extreme fear)
 */
export function fearGreedFromVix(vix: number): FearGreed {
  const score = Math.round(Math.max(0, Math.min(100, 130 - vix * 4.2)))
  let rating = 'Neutral'
  if (score >= 75) rating = 'Extreme Greed'
  else if (score >= 55) rating = 'Greed'
  else if (score >= 45) rating = 'Neutral'
  else if (score >= 25) rating = 'Fear'
  else rating = 'Extreme Fear'
  return { score, rating, source: 'vix-proxy' }
}
