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
  /** Which load failed — 'calibration' (score multipliers) or 'tuner' (arm stats). */
  what: 'calibration' | 'tuner'
  message: string
  at: string
}

let current: FeedbackDegradation[] = []

/** Record a best-effort load failure and log it loudly. Returns nothing. */
export function noteFeedbackLoadFailure(what: FeedbackDegradation['what'], err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(
    `[feedback] ${what} load FAILED — engine is running WITHOUT learned weights. ` +
    `Recorded outcomes are not influencing selection until this is fixed: ${message}`
  )
  current = [...current.filter((d) => d.what !== what), { what, message, at: new Date().toISOString() }]
}

/** Clear a previously-recorded failure once that load succeeds again. */
export function clearFeedbackLoadFailure(what: FeedbackDegradation['what']): void {
  current = current.filter((d) => d.what !== what)
}

/** Degradations in effect for this process, newest state per source. */
export function feedbackDegradations(): FeedbackDegradation[] {
  return [...current]
}
