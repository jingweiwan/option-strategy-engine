/**
 * CLI for the walk-forward replay backtester.
 *
 *   node --import tsx src/backtest/run.ts [--dte 30] [--horizon 5]
 *
 * Prints, per (strategy × regime), each short-delta arm's win rate / avg P&L /
 * normalized reward, flags the leader, and warns when buckets are too thin to
 * trust. Use it to validate the pipeline today and to tune parameters offline
 * once a few weeks of chains have accumulated.
 */
import { runReplay, type ArmResult } from './replay.js'

const args = process.argv.slice(2)
function flag(name: string, dflt: number): number {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt
}

const MIN_TRUST_N = 15 // per-arm sample size before a verdict means anything

function fmt(n: number, d = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(d)
}

const report = await runReplay({
  dteTarget: flag('dte', 30),
  horizonDays: flag('horizon', 5)
})

console.log(
  `\n=== Replay backtest ===\n` +
  `days: ${report.daysCovered.length} (${report.daysCovered[0]} .. ${report.daysCovered.at(-1)})\n` +
  `virtual trades: ${report.trades} | skipped: ${report.skipped}\n`
)

// Group by strategy×regime bucket
const byBucket = new Map<string, ArmResult[]>()
for (const a of report.arms) {
  const k = `${a.strategy}|${a.regime}`
  byBucket.set(k, [...(byBucket.get(k) ?? []), a])
}

for (const [k, arms] of byBucket) {
  const leader = [...arms].sort((x, y) => y.avgReward - x.avgReward)[0]
  const enoughN = arms.every((a) => a.n >= MIN_TRUST_N)
  // The delta knob trades premium against tail risk — only weeks that actually
  // contained losses can tell the arms apart. An all-win period just rewards
  // collecting the most premium, which is not the same as the best edge.
  const sawLosses = arms.some((a) => a.winRate < 0.95)
  console.log(`▸ ${k}`)
  for (const a of arms) {
    const lead = a === leader ? ' ◀ best' : ''
    const thin = a.n < MIN_TRUST_N ? ' (样本不足)' : ''
    console.log(
      `    ${a.variant}  n=${String(a.n).padStart(3)}  ` +
      `win=${(a.winRate * 100).toFixed(0).padStart(3)}%  ` +
      `avgPnL=${fmt(a.avgPnl).padStart(7)}  reward=${a.avgReward.toFixed(3)}${lead}${thin}`
    )
  }
  let verdict: string
  if (!enoughN) verdict = `样本不足,仅验证管线(每臂需 ≥${MIN_TRUST_N} 笔)`
  else if (!sawLosses) verdict = '此时段全胜、无亏损 — 区分不出风险,需跨越含下跌的时段'
  else verdict = `结论可信:${leader.variant} 领先`
  console.log(`    → ${verdict}\n`)
}

if (report.trades === 0) {
  console.log('没有产生任何虚拟交易 — 检查 data/chains/ 是否有存档,或放宽 dte/horizon。')
}
