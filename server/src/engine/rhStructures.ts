/**
 * RH raw legs → recognized STRUCTURES with tasty-style management alerts.
 *
 * Robinhood reports positions as flat legs; a trader thinks in structures.
 * Within each (symbol × expiration): greedy nearest-strike pairing of
 * long/short same-type legs → vertical spreads; a credit put spread + credit
 * call spread → iron condor; leftover shorts stay standalone (each naked short
 * is its own risk unit); leftover longs merge into one combo (LEAPS stacks).
 *
 * Alerts follow the tasty playbook for short premium, most urgent first:
 *   1. ≤21 DTE  — the roll/close line the user asked to emphasize
 *   2. short leg ITM / near ITM (needs spot)
 *   3. unrealized ≥ 50% of credit → take-profit line reached
 *   4. unrealized ≤ −1× credit   → approaching the 2× stop
 */
import type { RhOptionLeg } from '../api/rhPositions.js'

export type RhStructureAlert = { level: 'warn' | 'good' | 'info'; text: string }

export type RhStructure = {
  sym: string
  expiration: string
  dte: number
  kind: 'iron_condor' | 'put_spread' | 'call_spread' | 'short_put' | 'short_call' | 'long_combo' | 'other'
  label: string
  legs: RhOptionLeg[]
  /** Σ signed cost (long paid > 0, short credit < 0), qty included. */
  netCost: number
  credit: boolean
  /** Σ leg unrealized (null when any leg lacks a mark). */
  unrealized: number | null
  alerts: RhStructureAlert[]
}

const dteOf = (exp: string): number =>
  Math.max(0, Math.round((new Date(exp + 'T16:00:00-04:00').getTime() - Date.now()) / 86_400_000))

const fmtK = (k: number) => (Number.isInteger(k) ? String(k) : String(k))

type MarkedLeg = RhOptionLeg & { unrealized: number | null }

function sumUnrealized(legs: MarkedLeg[]): number | null {
  let s = 0
  for (const l of legs) {
    if (l.unrealized == null) return null
    s += l.unrealized
  }
  return s
}

const netCostOf = (legs: RhOptionLeg[]) => legs.reduce((a, l) => a + l.avgCost * l.qty, 0)

/** Greedy nearest-strike pairing of longs↔shorts within one option type. */
function pairVerticals(legs: MarkedLeg[]): { pairs: [MarkedLeg, MarkedLeg][]; leftovers: MarkedLeg[] } {
  const longs = legs.filter((l) => l.side === 'long').sort((a, b) => a.strike - b.strike)
  const shorts = legs.filter((l) => l.side === 'short').sort((a, b) => a.strike - b.strike)
  const usedShort = new Set<number>()
  const pairs: [MarkedLeg, MarkedLeg][] = []
  for (const lg of longs) {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < shorts.length; i++) {
      if (usedShort.has(i)) continue
      const d = Math.abs(shorts[i].strike - lg.strike)
      if (d < bestD) { bestD = d; best = i }
    }
    if (best >= 0) { usedShort.add(best); pairs.push([lg, shorts[best]]) }
  }
  const leftovers = [
    ...longs.filter((lg) => !pairs.some(([a]) => a === lg)),
    ...shorts.filter((_, i) => !usedShort.has(i))
  ]
  return { pairs, leftovers }
}

function buildAlerts(s: Omit<RhStructure, 'alerts'>, spot: number | null): RhStructureAlert[] {
  const alerts: RhStructureAlert[] = []
  if (!s.credit) return alerts // tasty management rules are for short premium
  const creditAmt = -s.netCost // > 0

  // 1. The 21-DTE line (user-requested emphasis)
  if (s.dte <= 21) {
    alerts.push({
      level: 'warn',
      text: s.dte <= 7
        ? `⚠ ${s.dte}d 到期 — gamma 风险区,tasty 规则:立即移仓或了结`
        : `⚠ ≤21 DTE(剩 ${s.dte}d)— tasty 规则:该移仓或平仓了`
    })
  }
  // 2. Short-leg ITM / near-ITM (needs a live spot)
  if (spot != null && spot > 0) {
    for (const l of s.legs) {
      if (l.side !== 'short') continue
      const itm = l.optionType === 'put' ? spot < l.strike : spot > l.strike
      const near = Math.abs(spot - l.strike) / spot < 0.02
      if (itm) alerts.push({ level: 'warn', text: `⚠ 短腿 ${fmtK(l.strike)} 已 ITM(现价 ${spot.toFixed(0)})` })
      else if (near) alerts.push({ level: 'info', text: `△ 短腿 ${fmtK(l.strike)} 距现价 <2%,被测试中` })
    }
  }
  // 3./4. P&L lines vs credit received
  if (s.unrealized != null && creditAmt > 0) {
    if (s.unrealized >= creditAmt * 0.5) {
      alerts.push({ level: 'good', text: `✓ 已达 50% 止盈线(赚 $${Math.round(s.unrealized)}/收 $${Math.round(creditAmt)})—可平仓锁定` })
    } else if (s.unrealized <= -creditAmt) {
      alerts.push({ level: 'warn', text: `⚠ 浮亏超 1× 权利金 — 接近 2× 止损线` })
    }
  }
  return alerts.slice(0, 2)
}

/**
 * Pure: flat legs (+ per-leg unrealized and per-symbol spot) → structures,
 * nearest expirations first.
 */
export function buildRhStructures(
  legs: MarkedLeg[],
  spots: Map<string, number>
): RhStructure[] {
  const groups = new Map<string, MarkedLeg[]>()
  for (const l of legs) {
    const k = `${l.sym}|${l.expiration}`
    const arr = groups.get(k) ?? []
    arr.push(l)
    groups.set(k, arr)
  }

  const out: RhStructure[] = []
  for (const [key, gl] of groups) {
    const [sym, expiration] = key.split('|')
    const dte = dteOf(expiration)
    const spot = spots.get(sym) ?? null

    const puts = pairVerticals(gl.filter((l) => l.optionType === 'put'))
    const calls = pairVerticals(gl.filter((l) => l.optionType === 'call'))

    const mk = (kind: RhStructure['kind'], label: string, sl: MarkedLeg[]): RhStructure => {
      const netCost = netCostOf(sl)
      const base = {
        sym, expiration, dte, kind, label, legs: sl,
        netCost, credit: netCost < 0, unrealized: sumUnrealized(sl)
      }
      return { ...base, alerts: buildAlerts(base, spot) }
    }

    const spreadOf = ([a, b]: [MarkedLeg, MarkedLeg], type: 'put' | 'call'): RhStructure => {
      const lo = Math.min(a.strike, b.strike)
      const hi = Math.max(a.strike, b.strike)
      return mk(type === 'put' ? 'put_spread' : 'call_spread',
        `${type === 'put' ? 'Put' : 'Call'} 价差 ${fmtK(lo)}/${fmtK(hi)}`, [a, b])
    }

    const putSpreads = puts.pairs.map((p) => spreadOf(p, 'put'))
    const callSpreads = calls.pairs.map((p) => spreadOf(p, 'call'))

    // One credit put spread + one credit call spread → iron condor
    if (putSpreads.length === 1 && callSpreads.length === 1 && putSpreads[0].credit && callSpreads[0].credit) {
      const condorLegs = [...puts.pairs[0], ...calls.pairs[0]]
      const pks = puts.pairs[0].map((l) => l.strike).sort((x, y) => x - y)
      const cks = calls.pairs[0].map((l) => l.strike).sort((x, y) => x - y)
      out.push(mk('iron_condor',
        `铁鹰 ${fmtK(pks[0])}/${fmtK(pks[1])} · ${fmtK(cks[0])}/${fmtK(cks[1])}`,
        condorLegs))
    } else {
      out.push(...putSpreads, ...callSpreads)
    }

    // Leftover shorts: each stands alone as its own risk unit
    for (const l of [...puts.leftovers, ...calls.leftovers].filter((x) => x.side === 'short')) {
      out.push(mk(l.optionType === 'put' ? 'short_put' : 'short_call',
        `卖 ${l.optionType === 'put' ? 'Put' : 'Call'} ${fmtK(l.strike)}${l.qty > 1 ? ` ×${l.qty}` : ''}`, [l]))
    }
    // Leftover longs: merge into one combo (LEAPS stacks read as one line)
    const longLeft = [...puts.leftovers, ...calls.leftovers].filter((x) => x.side === 'long')
    if (longLeft.length > 0) {
      const type = longLeft[0].optionType
      const sameType = longLeft.every((l) => l.optionType === type)
      const desc = longLeft
        .sort((a, b) => a.strike - b.strike)
        .map((l) => `${fmtK(l.strike)}${l.qty > 1 ? ` ×${l.qty}` : ''}`)
        .join(' + ')
      out.push(mk('long_combo',
        sameType ? `买 ${type === 'put' ? 'Put' : 'Call'} ${desc}` : `买入组合 ${desc}`, longLeft))
    }
  }

  return out.sort((a, b) => a.dte - b.dte || a.sym.localeCompare(b.sym))
}
