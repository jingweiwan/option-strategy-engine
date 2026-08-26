/**
 * Feedback-layer load health.
 *
 * Calibration and tuner data are loaded best-effort: a failure must NOT break a
 * scan, so both call sites swallow the error and fall back to neutral defaults
 * (multiplier 1×, empty arm stats). That fallback is silent by design — and
 * that silence is exactly how a wiped/corrupt snapshot book went unnoticed:
 * the board quietly reverted to un-calibrated behaviour and surfaced strategies
 * the recorded outcomes had already disabled.
 *
 * So the degradation is recorded here instead: loudly logged at the call site
 * and surfaced to the dashboard, so "the engine is running WITHOUT its learned
 * weights" is visible rather than inferred from odd-looking cards.
 */

export type FeedbackDegradation = {
  /**
   * 'calibration' / 'tuner' — a best-effort load failed.
   * 'settlement'  — outcomes exist but were produced by a SUPERSEDED settlement
   *                 regime, so learning is ignoring them. Not a failure: it is
   *                 the correct behaviour after a regime bump, and it stays
   *                 visible until the book is re-settled with `force`.
   */
  what: 'calibration' | 'tuner' | 'settlement'
  message: string
  at: string
}

/**
 * Keyed by `what` for load failures, and by `what:source` for stale
 * settlements. Calibration and the tuner scan DIFFERENT subsets (calibration
 * drops shadow rows and directional debits), so they legitimately arrive at
 * different `skipped/total` denominators. Deduping both onto a bare
 * 'settlement' key made the number the operator sees depend on which table
 * happened to build last — a flapping count reads as a bug in the count.
 */
const current = new Map<string, FeedbackDegradation>()

/** Record a best-effort load failure and log it loudly. Returns nothing. */
export function noteFeedbackLoadFailure(what: FeedbackDegradation['what'], err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(
    `[feedback] ${what} load FAILED — engine is running WITHOUT learned weights. ` +
    `Recorded outcomes are not influencing selection until this is fixed: ${message}`
  )
  current.set(what, { what, message, at: new Date().toISOString() })
}

/**
 * Record that N outcomes were skipped because they predate the current
 * settlement regime. Called on every table build so the count tracks reality.
 *
 * MUST be called on every path out of the builder, including the empty-table
 * early return: "everything is stale" is the case that most needs saying.
 */
export function noteStaleSettlements(
  source: 'calibration' | 'tuner',
  skipped: number,
  total: number,
  version: string
): void {
  const key = `settlement:${source}`
  if (skipped <= 0) {
    current.delete(key)
    return
  }
  const message =
    `${source}: ${skipped}/${total} 条 outcome 由已被替换的结算口径算出（当前 ${version}），` +
    `学习层已忽略它们。跑一次 force 重结算即可恢复。`
  console.warn(`[feedback] ${message}`)
  current.set(key, { what: 'settlement', message, at: new Date().toISOString() })
}

/** Clear a previously-recorded failure once that load succeeds again. */
export function clearFeedbackLoadFailure(what: FeedbackDegradation['what']): void {
  current.delete(what)
}

/** Degradations in effect for this process, newest state per source. */
export function feedbackDegradations(): FeedbackDegradation[] {
  return [...current.values()]
}
