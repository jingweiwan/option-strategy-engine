import type { ExitPolicy } from '../engine/managedExit.js'

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
export const SETTLEMENT_VERSION = 's2'

/** Is this outcome comparable with the ones we are producing today? */
export function isCurrentRegime(o: { settlementVersion?: string } | null | undefined): boolean {
  return o != null && o.settlementVersion === SETTLEMENT_VERSION
}

/**
 * Exit policy for an unstamped snapshot taken BEFORE `USER_DEFAULT_SINCE`
 * (`exitPolicyOf` is what callers should use — it picks between this and the
 * current default by date).
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

/**
 * First ET day on which 'user' (TP 75% / no stop / ride to expiry) was the
 * engine's default — commit 1e4237f, "加 'user' 退出政策并设为默认". Snapshots
 * from this day onward were SCORED and DISPLAYED under 'user'.
 */
export const USER_DEFAULT_SINCE = '2026-08-31'

/**
 * The rule a snapshot's realized outcome must be measured under.
 *
 * A stamp always wins. Without one, the answer is "whatever the card that day
 * actually claimed", which is a function of the date — not of today's default
 * and not of the legacy rule for all time:
 *
 *   stamped            → that policy (condor A/B arms, and everything scanned
 *                        after the stamp gap was closed on 2026-09-16)
 *   null, on/after     → 'user'. The scanner stamped only iron_condor, so every
 *   USER_DEFAULT_SINCE   credit spread in this window is null-stamped while its
 *                        card promised TP 75% and no stop. Settling those as
 *                        'managed' closed them at 50% or stopped them at 2× —
 *                        trades the account never made — and the tuner learned
 *                        from the phantom.
 *   null, before       → LEGACY_EXIT_POLICY. Those cards really did say TP 50%
 *                        / stop 2× / 21 DTE; re-settling them under 'user'
 *                        would rewrite history instead of extending it.
 */
export function exitPolicyOf(
  s: { exitPolicy?: ExitPolicy | null; etDay?: string; capturedAt?: string }
): ExitPolicy {
  if (s.exitPolicy != null) return s.exitPolicy
  const day = s.etDay || (s.capturedAt ?? '').slice(0, 10)
  return day >= USER_DEFAULT_SINCE ? 'user' : LEGACY_EXIT_POLICY
}
