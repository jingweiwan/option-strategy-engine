/**
 * Version of the SETTLEMENT REGIME — the code that turns a recorded
 * recommendation into a realized P&L.
 *
 * Why this exists
 * ---------------
 * Every outcome in the book was computed in 2026-05/06. The settlement math was
 * then rewritten five times in 2026-08 (phantom entry P&L, per-leg IV marking,
 * `convergeTo`, `maxSteps`, forward-look removal). Nothing recorded which code
 * produced which number, so the tuner and the calibration table were learning
 * from measurements taken with rulers that no longer exist — and no one could
 * tell, because a stale outcome looks exactly like a fresh one.
 *
 * The invariant "display and learning share one managed exit" guarantees the two
 * agree at a MOMENT. It says nothing about comparability ACROSS time. This does.
 *
 * Bump this whenever a change would make the same (snapshot, price history)
 * settle to a different number:
 *   - engine/managedExit.ts        — marking, exit rules, convergence schedule
 *   - feedback/outcome.ts          — window, sigma choice, stop threshold
 *   - engine/payoff.ts             — P&L definition
 *   - the exit policy constants    — take-profit / stop fractions, closeAtDte
 *
 * Do NOT bump for: which candidates get recommended, scoring, gates, the arm
 * ladder. Those change what is in the book, not how the book is measured.
 *
 * Bumping invalidates every existing outcome by design: consumers ignore
 * outcomes from other regimes, and the book must be re-settled with `force`.
 * Erring toward a needless bump costs one re-settle; missing a needed bump
 * silently corrupts everything learned afterwards.
 */
export const SETTLEMENT_VERSION = 's1'

/** Is this outcome comparable with the ones we are producing today? */
export function isCurrentRegime(o: { settlementVersion?: string } | null | undefined): boolean {
  return o != null && o.settlementVersion === SETTLEMENT_VERSION
}

/**
 * Exit policy for a snapshot that carries no `exitPolicy` stamp.
 *
 * Every recommendation taken before 2026-08-31 predates the stamp, because
 * 'managed' (TP 50% / stop 2×) was then the only default. Those cards displayed
 * that rule, so that is the rule their realized outcome must be measured under.
 *
 * This must NOT track the current default. When the default moved to 'user',
 * re-settling the old book under it would have measured every historical
 * recommendation against a rule it never claimed — silently rewriting the
 * learning record rather than extending it. That is also why the default change
 * needed no SETTLEMENT_VERSION bump: the same (snapshot, price history) still
 * settles to the same number.
 */
export const LEGACY_EXIT_POLICY = 'managed' as const
