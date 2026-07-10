function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeNormal(rng: () => number) {
  return () => {
    let u = 0
    let v = 0
    while (u === 0) u = rng()
    while (v === 0) v = rng()
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
  }
}

/**
 * Cornish–Fisher skew transform, variance-normalized so Var[g(z)] = 1.
 *
 * Injects skewness `gamma` into a standard normal draw while preserving mean 0
 * and unit variance — it redistributes the SAME total variance into an
 * asymmetric shape rather than inflating it. Negative gamma fattens the LEFT
 * tail, matching equity put skew (OTM puts richer than OTM calls).
 *
 * Cornish–Fisher stays monotonic in z only while |gamma·z/3| < 1; the caller
 * clamps gamma to [-1, 1], pushing the fold-over past |z|≈3 (<0.2% of draws),
 * where its effect on the terminal distribution is negligible.
 */
function skewTransform(z: number, gamma: number): number {
  if (gamma === 0) return z
  const raw = z + (gamma / 6) * (z * z - 1)
  return raw / Math.sqrt(1 + (gamma * gamma) / 18)
}

export type SimInput = {
  S0: number
  sigma: number
  T: number
  r: number
  q: number
  simulations?: number
  seed?: number
  /**
   * Target skewness of log-returns. Negative = fat left tail (equity put skew).
   * Calibrated from the option chain's put/call IV asymmetry. Default 0
   * reproduces the symmetric lognormal model.
   */
  skew?: number
  /**
   * One-time earnings shock std-dev as a fraction of price (e.g. 0.08 = 8%
   * expected one-day move), applied multiplicatively when an earnings event
   * falls inside the simulation window. Diffusion sigma should already be the
   * ex-earnings (RV-based) value so the jump adds the discrete event variance
   * on top.
   */
  earningsJump?: number
}

/**
 * Simulate terminal prices under (skewed) geometric Brownian motion with an
 * optional discrete earnings jump.
 *
 * Martingale is enforced numerically via Empirical Martingale Simulation
 * (Duan & Simonato 1998): each raw multiplier is rescaled by the sample mean so
 * the realized E[S_T] equals the forward S0·e^((r−q)T) EXACTLY — for any shock
 * distribution. This is what lets us add skew and jumps without re-deriving a
 * closed-form drift correction, and it removes Monte-Carlo drift error as a
 * bonus.
 */
export function simulatePrices({
  S0,
  sigma,
  T,
  r,
  q,
  simulations = 5000,
  seed,
  skew,
  earningsJump
}: SimInput): number[] {
  const rng = seed != null ? mulberry32(seed) : Math.random
  const normal = makeNormal(rng)
  const sigmaT = sigma * Math.sqrt(T)
  const gamma = Math.max(-1, Math.min(1, skew ?? 0))
  const n = simulations
  const half = Math.floor(n / 2)

  // Raw, drift-free multipliers. Antithetic pairing on the base draw (and on
  // the jump draw) for variance reduction.
  const raw = new Array<number>(n)
  for (let i = 0; i < half; i++) {
    const z = normal()
    raw[2 * i] = Math.exp(sigmaT * skewTransform(z, gamma))
    raw[2 * i + 1] = Math.exp(sigmaT * skewTransform(-z, gamma))
  }
  if (n % 2 === 1) {
    const z = normal()
    raw[n - 1] = Math.exp(sigmaT * skewTransform(z, gamma))
  }

  if (earningsJump != null && earningsJump > 0) {
    const j = earningsJump
    for (let i = 0; i < half; i++) {
      const zj = normal()
      raw[2 * i] *= Math.exp(j * zj)
      raw[2 * i + 1] *= Math.exp(-j * zj)
    }
    if (n % 2 === 1) {
      const zj = normal()
      raw[n - 1] *= Math.exp(j * zj)
    }
  }

  let sum = 0
  for (let i = 0; i < n; i++) sum += raw[i]
  const mean = sum / n
  const forward = S0 * Math.exp((r - q) * T)

  const results = new Array<number>(n)
  for (let i = 0; i < n; i++) results[i] = (forward * raw[i]) / mean
  return results
}

export function expectedMove(S: number, sigma: number, T: number): number {
  return S * sigma * Math.sqrt(T)
}

export type PathInput = {
  S0: number
  sigma: number
  /** Years per step (e.g. 1/252 for daily). */
  dtYears: number
  /** Number of forward observations per path (the management window). */
  steps: number
  r: number
  q: number
  simulations?: number
  seed?: number
  /** 0-indexed step where an earnings event lands (−1 = none). */
  earningsStep?: number
  /** One-time earnings shock std-dev (fraction of price), applied at earningsStep. */
  earningsJump?: number
}

/**
 * Simulate daily price PATHS (not just terminal) for managed-exit evaluation.
 * Each path is `steps` forward prices (day 1..steps); S0 is the entry and not
 * included. Antithetic pairs reduce variance. Standard GBM per step — the
 * managed exit usually triggers within the window, so the terminal-tail skew
 * modeled in simulatePrices matters little here.
 */
export function simulatePaths({
  S0,
  sigma,
  dtYears,
  steps,
  r,
  q,
  simulations = 2000,
  seed,
  earningsStep = -1,
  earningsJump = 0
}: PathInput): number[][] {
  const rng = seed != null ? mulberry32(seed) : Math.random
  const normal = makeNormal(rng)
  const drift = (r - q - 0.5 * sigma * sigma) * dtYears
  const diffusion = sigma * Math.sqrt(dtYears)
  const j = earningsStep >= 0 && earningsStep < steps && earningsJump > 0 ? earningsJump : 0
  const n = simulations
  const half = Math.floor(n / 2)
  const paths: number[][] = new Array(n)

  // zs = daily diffusion draws; zj = the one-time earnings shock draw.
  // exp(j·zj − ½j²) keeps E[shock]=1 (martingale-preserving), so it widens the
  // distribution on earnings day without biasing the drift.
  const walk = (zs: number[], zj: number): number[] => {
    const path = new Array<number>(steps)
    let s = S0
    for (let t = 0; t < steps; t++) {
      s *= Math.exp(drift + diffusion * zs[t])
      if (t === earningsStep && j > 0) s *= Math.exp(j * zj - 0.5 * j * j)
      path[t] = s
    }
    return path
  }

  for (let i = 0; i < half; i++) {
    const zs = new Array<number>(steps)
    for (let t = 0; t < steps; t++) zs[t] = normal()
    const zj = j > 0 ? normal() : 0
    paths[2 * i] = walk(zs, zj)
    paths[2 * i + 1] = walk(zs.map((z) => -z), -zj) // antithetic mirror
  }
  if (n % 2 === 1) {
    const zs = new Array<number>(steps)
    for (let t = 0; t < steps; t++) zs[t] = normal()
    paths[n - 1] = walk(zs, j > 0 ? normal() : 0)
  }
  return paths
}
