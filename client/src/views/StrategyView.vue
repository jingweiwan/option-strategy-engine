<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchLiveStrategies, fetchExpirations } from '@/api/client'
import { usePositions } from '@/composables/usePositions'
import PayoffChart from '@/components/PayoffChart.vue'
import HelpTip from '@/components/HelpTip.vue'
import type { LiveMarketState, StrategyResult, StrategyType } from '@/types'
import { STRAT_CN } from '@/utils/constants'

const { add: addPosition } = usePositions()
const justAdded = ref(false)

const route = useRoute()
const router = useRouter()

const symbol = computed(() => ((route.query.sym as string) || '').toUpperCase())
const expFromQuery = computed(() => (route.query.exp as string) || '')
const strategyId = computed(() => route.query.id as StrategyType | undefined)
/** Target DTE from opp card (e.g. 30); used to pick best expiration when exp is absent. */
const targetDte = computed(() => {
  const v = Number(route.query.dte)
  return Number.isFinite(v) && v > 0 ? v : 30
})

const resolvedExp = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const state = ref<LiveMarketState | null>(null)
const allResults = ref<StrategyResult[]>([])

const strategy = computed(() => {
  if (strategyId.value) {
    const match = allResults.value.find((r) => r.strategy === strategyId.value)
    if (match) return match
  }
  // Fallback: show the top-ranked strategy
  return allResults.value.length > 0 ? allResults.value[0] : null
})
const otherStrategies = computed(() =>
  allResults.value.filter((r) => r.strategy !== strategy.value?.strategy)
)


const VIEW_TAG: Record<StrategyType, { dir: string; iv: string }> = {
  bull_call_spread: { dir: '看涨', iv: '中低 IV' },
  bear_call_spread: { dir: '看跌', iv: '中高 IV' },
  bull_put_spread: { dir: '看涨', iv: '中高 IV' },
  bear_put_spread: { dir: '看跌', iv: '中低 IV' },
  iron_condor: { dir: '中性', iv: '高 IV' },
  short_strangle: { dir: '中性', iv: '高 IV' },
  long_straddle: { dir: '买波动', iv: '低 IV' }
}

const contracts = ref(1)
function inc() {
  contracts.value++
}
function dec() {
  if (contracts.value > 1) contracts.value--
}

function fmt(n: number, d = 2) {
  if (!Number.isFinite(n)) return '∞'
  return n.toFixed(d)
}
function fmtSigned(n: number, d = 2) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞'
  return (n >= 0 ? '+' : '') + n.toFixed(d)
}

/** Pick the expiration closest to targetDte days from now. */
function pickExpiration(exps: string[], dte: number): string {
  const today = Date.now()
  let best = exps[0]
  let bestDiff = Infinity
  for (const e of exps) {
    const d = (new Date(e).getTime() - today) / 86400000
    if (d < 7) continue // skip weeklies < 7 DTE
    const diff = Math.abs(d - dte)
    if (diff < bestDiff) { bestDiff = diff; best = e }
  }
  return best
}

async function load() {
  if (!symbol.value) {
    error.value = '缺少 symbol 参数。'
    return
  }

  loading.value = true
  error.value = null

  try {
    // Resolve expiration: use query param if provided, otherwise auto-pick
    let exp = expFromQuery.value
    if (!exp) {
      const exps = await fetchExpirations(symbol.value)
      if (exps.length === 0) {
        error.value = `${symbol.value} 无可用到期日`
        return
      }
      exp = pickExpiration(exps, targetDte.value)
      resolvedExp.value = exp
    } else {
      resolvedExp.value = exp
    }

    const out = await fetchLiveStrategies({
      symbol: symbol.value,
      expiration: exp,
      simulations: 5000,
      seed: 42
    })
    state.value = out.state
    allResults.value = out.results
    await nextTick()
  } catch (e: any) {
    error.value = e?.message ?? 'request failed'
  } finally {
    loading.value = false
  }
}

watch(() => [symbol.value, expFromQuery.value], load, { immediate: true })

// Scenario analysis: P&L at -1σ, -½σ, spot, +½σ, +1σ
function payoffAt(price: number) {
  if (!strategy.value) return 0
  let pnl = 0
  for (const leg of strategy.value.legs) {
    const intrinsic =
      leg.type === 'call' ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price)
    const sign = leg.action === 'buy' ? 1 : -1
    const cost = leg.action === 'buy' ? leg.premium : -leg.premium
    pnl += (sign * intrinsic - cost) * leg.quantity
  }
  return pnl
}

const scenarios = computed(() => {
  if (!strategy.value || !state.value) return []
  const spot = state.value.spot
  const em = state.value.expectedMove
  const points = [
    { label: '−1σ', delta: -em, price: spot - em },
    { label: '−½σ', delta: -em / 2, price: spot - em / 2 },
    { label: 'Spot', delta: 0, price: spot },
    { label: '+½σ', delta: em / 2, price: spot + em / 2 },
    { label: '+1σ', delta: em, price: spot + em }
  ]
  return points.map((p) => ({ ...p, pnl: payoffAt(p.price) * contracts.value * 100 }))
})

const orderTotal = computed(() => {
  if (!strategy.value) return 0
  return strategy.value.netPremium * 100 * contracts.value
})

const isCredit = computed(() => (strategy.value ? strategy.value.netPremium > 0 : false))

function backToRecommend() {
  router.push({
    path: '/recommend',
    query: { sym: symbol.value }
  })
}

function jumpToOther(s: StrategyResult) {
  router.push({
    path: '/strategy',
    query: { sym: symbol.value, exp: resolvedExp.value, id: s.strategy }
  })
}

function addToPortfolio() {
  if (!strategy.value || !state.value) return
  addPosition({
    symbol: state.value.symbol,
    expiration: state.value.expiration,
    strategy: strategy.value.strategy,
    legs: strategy.value.legs.map((l) => ({ ...l })),
    netPremium: strategy.value.netPremium,
    netGreeks: { ...strategy.value.netGreeks },
    contracts: contracts.value
  })
  justAdded.value = true
  setTimeout(() => (justAdded.value = false), 2000)
}
</script>

<template>
  <div class="page">
    <button class="back-link mono" @click="backToRecommend">← 返回推荐列表</button>

    <div v-if="loading && !strategy" class="loading mono">加载中…</div>
    <div v-else-if="error" class="error">⚠ {{ error }}</div>

    <template v-else-if="strategy && state">
      <!-- Page head -->
      <div class="page-head">
        <div>
          <div class="eyebrow" style="margin-bottom: 14px">
            策略详情 · {{ VIEW_TAG[strategy.strategy].dir }} · {{ VIEW_TAG[strategy.strategy].iv }} ·
            {{ state.symbol }} · {{ state.expiration }}
          </div>
          <div class="h-title serif">
            {{ STRAT_CN[strategy.strategy] }}
            <em>· {{ strategy.strategy }}</em>
          </div>
          <p class="h-deck">{{ strategy.rationale }}</p>
        </div>
        <div class="h-meta">
          <span :class="['chip', isCredit ? 'gain' : 'info']" style="font-size: 12px; padding: 6px 12px">
            {{ isCredit ? '收 CREDIT' : '付 DEBIT' }} {{ fmt(Math.abs(strategy.netPremium)) }}
            <span style="opacity: 0.6">×100</span>
          </span>
          <div style="margin-top: 12px">
            POP <b>{{ fmt(strategy.metrics.probabilityProfit * 100, 1) }}%</b>
            · EV <b>{{ fmtSigned(strategy.metrics.ev) }}</b>
          </div>
          <div style="margin-top: 4px">
            SPOT <b>{{ fmt(state.spot) }}</b> · IV {{ (state.iv * 100).toFixed(1) }}% · DTE {{ state.dte }}d
          </div>
        </div>
      </div>

      <!-- Body: 2-col -->
      <div class="detail-body">
        <!-- LEFT: chart + scenarios + legs -->
        <div class="left-col">
          <section class="block">
            <div class="eyebrow" style="margin-bottom: 12px">到期收益曲线</div>
            <hr class="rule-hair" />
            <PayoffChart
              :legs="strategy.legs"
              :spot="state.spot"
              :expected-move="state.expectedMove"
              :breakevens="strategy.metrics.breakevens"
              :curve="strategy.payoffCurve"
            />
          </section>

          <section class="block">
            <div class="eyebrow" style="margin-bottom: 12px">
              情景分析 · ±1σ 预期波动
              <HelpTip
                align="left"
                text="假设到期日股价分别落在 −1σ / −½σ / spot / +½σ / +1σ 的位置，单张合约盈亏。已乘 100 转成实际美元，并按你设的合约张数 ×。"
              />
            </div>
            <table class="scenario-table">
              <thead>
                <tr>
                  <th>情景</th>
                  <th class="rt">股价</th>
                  <th class="rt">变化</th>
                  <th class="rt">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in scenarios" :key="s.label">
                  <td class="mono">{{ s.label }}</td>
                  <td class="mono tnum rt">${{ fmt(s.price) }}</td>
                  <td class="mono tnum rt">{{ fmtSigned(s.delta) }}</td>
                  <td
                    class="mono tnum rt"
                    :class="s.pnl >= 0 ? 'up' : 'dn'"
                    style="font-weight: 600"
                  >
                    {{ fmtSigned(s.pnl, 0) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="block">
            <div class="eyebrow" style="margin-bottom: 10px">合约腿</div>
            <table class="legs-table">
              <thead>
                <tr>
                  <th>方向</th>
                  <th>类型</th>
                  <th class="rt">行权价</th>
                  <th class="rt">权利金</th>
                  <th class="rt">Δ</th>
                  <th class="rt">Γ</th>
                  <th class="rt">Θ</th>
                  <th class="rt">ν</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(leg, i) in strategy.legs" :key="i">
                  <td>
                    <span :class="['leg-side', leg.action]">{{ leg.action === 'buy' ? '买' : '卖' }}</span>
                  </td>
                  <td>{{ leg.type.toUpperCase() }}</td>
                  <td class="mono tnum rt">${{ leg.strike }}</td>
                  <td class="mono tnum rt">${{ fmt(leg.premium) }}</td>
                  <td class="mono tnum rt">{{ fmtSigned(leg.greeks.delta, 2) }}</td>
                  <td class="mono tnum rt">{{ fmt(leg.greeks.gamma, 4) }}</td>
                  <td class="mono tnum rt">{{ fmt(leg.greeks.theta, 3) }}</td>
                  <td class="mono tnum rt">{{ fmt(leg.greeks.vega, 3) }}</td>
                </tr>
                <tr class="legs-total">
                  <td colspan="3" class="rt">每张合约净额</td>
                  <td class="mono tnum rt" :class="{ up: isCredit }">
                    {{ fmtSigned(strategy.netPremium) }}
                  </td>
                  <td class="mono tnum rt">{{ fmtSigned(strategy.netGreeks.delta, 3) }}</td>
                  <td class="mono tnum rt">{{ fmt(strategy.netGreeks.gamma, 4) }}</td>
                  <td class="mono tnum rt">{{ fmt(strategy.netGreeks.theta, 3) }}</td>
                  <td class="mono tnum rt">{{ fmt(strategy.netGreeks.vega, 3) }}</td>
                </tr>
              </tbody>
            </table>
            <div class="be-line mono">
              盈亏平衡 ·
              <span v-for="(b, i) in strategy.metrics.breakevens" :key="i">
                <span v-if="i > 0"> / </span>${{ fmt(b) }}
              </span>
              <span v-if="strategy.metrics.breakevens.length === 0" style="color: var(--ink-3)">—</span>
            </div>
          </section>
        </div>

        <!-- RIGHT: greeks + KPI + order ticket -->
        <aside class="right-col">
          <div class="eyebrow" style="margin-bottom: 14px">核心数据</div>
          <div class="kpi-grid">
            <div class="kpi-cell">
              <div class="l">
                最大盈利
                <HelpTip align="left" text="到期日单张合约能赚到的最高金额。" />
              </div>
              <div :class="['v', 'mono', { warn: strategy.metrics.unboundedProfit }]">
                <template v-if="strategy.metrics.unboundedProfit">∞</template>
                <template v-else>{{ fmt(strategy.metrics.theoMaxProfit) }}</template>
              </div>
              <div class="sub">{{ strategy.metrics.unboundedProfit ? '无上限' : '完全限定' }}</div>
            </div>
            <div class="kpi-cell">
              <div class="l">
                最大亏损
                <HelpTip
                  align="left"
                  text="单张合约可能亏到的最高金额。−∞ = 裸露敞口。"
                />
              </div>
              <div :class="['v', 'mono', { dn: !strategy.metrics.unboundedLoss, bad: strategy.metrics.unboundedLoss }]">
                <template v-if="strategy.metrics.unboundedLoss">−∞</template>
                <template v-else>{{ fmt(strategy.metrics.theoMaxLoss) }}</template>
              </div>
              <div class="sub">{{ strategy.metrics.unboundedLoss ? '裸露敞口 ⚠' : '完全限定' }}</div>
            </div>
            <div class="kpi-cell">
              <div class="l">
                VaR 95%
                <HelpTip align="left" text="95% 概率下亏损不超过此值；最差 5% 情景下亏损至少这么多。" />
              </div>
              <div class="v mono dn">{{ fmt(strategy.metrics.var95) }}</div>
              <div class="sub">5% 概率下亏损至少</div>
            </div>
            <div class="kpi-cell">
              <div class="l">
                CVaR 95%
                <HelpTip align="left" text="最差 5% 情景的平均亏损 (Expected Shortfall)。比 VaR 更谨慎。" />
              </div>
              <div class="v mono dn">{{ fmt(strategy.metrics.cvar95) }}</div>
              <div class="sub">尾部平均损失</div>
            </div>
          </div>

          <div class="eyebrow" style="margin-top: 22px; margin-bottom: 10px">
            净 Greeks
            <HelpTip
              align="left"
              text="整个策略所有 leg 加总后的暴露：方向 (Δ) / 方向变化速度 (Γ) / 时间衰减 (Θ) / IV 敏感度 (ν)。"
            />
          </div>
          <div class="greeks">
            <div class="greek-row">
              <span class="greek-name">Delta</span>
              <span class="greek-val mono">{{ fmtSigned(strategy.netGreeks.delta, 3) }}</span>
              <div class="bar">
                <span
                  :style="{
                    width: Math.min(Math.abs(strategy.netGreeks.delta) * 200, 100) + '%',
                    background: strategy.netGreeks.delta >= 0 ? 'var(--gain)' : 'var(--loss)'
                  }"
                />
              </div>
            </div>
            <div class="greek-row">
              <span class="greek-name">Gamma</span>
              <span class="greek-val mono">{{ fmtSigned(strategy.netGreeks.gamma, 4) }}</span>
              <div class="bar">
                <span
                  :style="{
                    width: Math.min(Math.abs(strategy.netGreeks.gamma) * 1500, 100) + '%',
                    background: strategy.netGreeks.gamma >= 0 ? 'var(--gain)' : 'var(--loss)'
                  }"
                />
              </div>
            </div>
            <div class="greek-row">
              <span class="greek-name">Theta</span>
              <span class="greek-val mono">{{ fmtSigned(strategy.netGreeks.theta, 3) }}</span>
              <div class="bar">
                <span
                  :style="{
                    width: Math.min(Math.abs(strategy.netGreeks.theta) * 400, 100) + '%',
                    background: strategy.netGreeks.theta >= 0 ? 'var(--gain)' : 'var(--loss)'
                  }"
                />
              </div>
            </div>
            <div class="greek-row">
              <span class="greek-name">Vega</span>
              <span class="greek-val mono">{{ fmtSigned(strategy.netGreeks.vega, 3) }}</span>
              <div class="bar">
                <span
                  :style="{
                    width: Math.min(Math.abs(strategy.netGreeks.vega) * 200, 100) + '%',
                    background: strategy.netGreeks.vega >= 0 ? 'var(--gain)' : 'var(--loss)'
                  }"
                />
              </div>
            </div>
          </div>

          <!-- Order ticket -->
          <div class="ticket">
            <div class="eyebrow" style="margin-bottom: 14px">下单工单</div>
            <div class="ticket-amount">
              <span class="serif amount-num">
                {{ isCredit ? '+' : '−' }}${{ fmt(Math.abs(orderTotal), 2) }}
              </span>
              <span class="mono ticket-sub">{{ isCredit ? '收到 credit' : '支付 debit' }}</span>
            </div>

            <div class="ticket-row">
              <span class="ticket-l">合约张数</span>
              <div class="counter">
                <button @click="dec">−</button>
                <span class="mono count-val">{{ contracts }}</span>
                <button @click="inc">+</button>
              </div>
            </div>
            <div class="ticket-row">
              <span class="ticket-l">最大盈利</span>
              <span class="mono tnum up">
                <template v-if="strategy.metrics.unboundedProfit">∞</template>
                <template v-else>+${{ fmt(strategy.metrics.theoMaxProfit * 100 * contracts, 0) }}</template>
              </span>
            </div>
            <div class="ticket-row">
              <span class="ticket-l">最大亏损</span>
              <span class="mono tnum dn">
                <template v-if="strategy.metrics.unboundedLoss">−∞</template>
                <template v-else>−${{ fmt(Math.abs(strategy.metrics.theoMaxLoss * 100 * contracts), 0) }}</template>
              </span>
            </div>
            <div class="ticket-row">
              <span class="ticket-l">盈亏平衡</span>
              <span class="mono tnum">
                {{ strategy.metrics.breakevens.map((b) => '$' + fmt(b)).join(' / ') || '—' }}
              </span>
            </div>

            <button class="btn primary order-btn" disabled title="券商对接开发中，敬请期待">复核并下单 →</button>
            <button class="btn ghost tiny portfolio-btn" @click="addToPortfolio">
              {{ justAdded ? '✓ 已加入持仓' : '+ 加入持仓监控' }}
            </button>
            <div class="ticket-disclaimer mono">
              限价 @ 中间价 · 当日 · 智能路由 · 需 Lvl 3 期权权限
            </div>
          </div>
        </aside>
      </div>

      <!-- Other strategies for this expiration -->
      <section v-if="otherStrategies.length" class="other-section">
        <div class="other-head">
          <span class="eyebrow">同到期 · 其他策略</span>
          <span class="other-sub mono">点击切换到对应策略详情</span>
        </div>
        <div class="other-grid">
          <button
            v-for="s in otherStrategies"
            :key="s.strategy"
            class="other-card"
            @click="jumpToOther(s)"
          >
            <div class="serif other-name">{{ STRAT_CN[s.strategy] }}</div>
            <div class="other-meta mono">
              POP {{ fmt(s.metrics.probabilityProfit * 100, 1) }}% ·
              EV {{ fmtSigned(s.metrics.ev) }} ·
              {{ s.netPremium > 0 ? '+' : '−' }}${{ fmt(Math.abs(s.netPremium * 100), 0) }}
            </div>
          </button>
        </div>
      </section>

      <div class="disclaimer serif">
        引擎输出仅供参考。期权交易涉及重大风险，并非适合所有投资者。模型策略的历史表现不预示未来回报。
      </div>
    </template>
  </div>
</template>

<style scoped>
.back-link {
  background: transparent;
  border: 0;
  color: var(--ink-3);
  font-size: 11px;
  padding: 0;
  margin-bottom: 14px;
  cursor: pointer;
}
.back-link:hover {
  color: var(--ink);
}

.h-meta b {
  color: var(--ink) !important;
  font-weight: 500;
}

/* ===== body grid ===== */
.detail-body {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 36px;
  align-items: start;
  padding: 24px 0 32px;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}
.left-col {
  display: flex;
  flex-direction: column;
  gap: 36px;
}
.block { }

/* ===== KPI tiles ===== */
.kpi-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid var(--rule);
}
.kpi-cell {
  padding: 14px 16px;
  border-right: 1px solid var(--rule-hair);
  border-bottom: 1px solid var(--rule-hair);
}
.kpi-cell:nth-child(2n) { border-right: 0; }
.kpi-cell:nth-last-child(-n+2) { border-bottom: 0; }
.kpi-cell .l {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 6px;
}
.kpi-cell .v {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1;
}
.kpi-cell .v.dn { color: var(--loss); }
.kpi-cell .v.warn { color: var(--warn); }
.kpi-cell .v.bad { color: var(--loss); }
.kpi-cell .sub {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-3);
  margin-top: 6px;
}

/* ===== greeks bar ===== */
.greeks { display: flex; flex-direction: column; gap: 8px; }
.greek-row {
  display: grid;
  grid-template-columns: 60px 80px 1fr;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.greek-name { color: var(--ink-3); }
.greek-val { text-align: right; color: var(--ink); }
.bar {
  height: 4px;
  background: var(--paper-3);
  position: relative;
  overflow: hidden;
}
.bar span {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  display: block;
  transition: width 0.3s;
}

/* ===== order ticket ===== */
.ticket {
  margin-top: 28px;
  padding: 22px;
  background: var(--paper-2);
  border: 1px solid var(--rule);
}
.ticket-amount {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
}
.amount-num {
  font-size: 32px;
  font-weight: 500;
  letter-spacing: -0.02em;
}
.ticket-sub {
  font-size: 11px;
  color: var(--ink-3);
}
.ticket-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-hair);
  font-size: 12px;
}
.ticket-l {
  color: var(--ink-3);
}
.counter {
  display: flex;
  align-items: center;
  border: 1px solid var(--rule);
}
.counter button {
  background: transparent;
  border: 0;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
  color: var(--ink);
}
.counter button:hover { background: var(--paper-3); }
.count-val {
  padding: 0 14px;
  font-size: 13px;
}
.order-btn {
  width: 100%;
  margin-top: 18px;
  padding: 13px 0;
  justify-content: center;
  font-size: 14px;
}
.portfolio-btn {
  width: 100%;
  margin-top: 8px;
  justify-content: center;
}
.ticket-disclaimer {
  font-size: 10px;
  color: var(--ink-3);
  margin-top: 10px;
  line-height: 1.6;
}

/* ===== scenario + legs tables ===== */
.scenario-table,
.legs-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 12px;
}
.scenario-table thead tr,
.legs-table thead tr {
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}
.scenario-table th,
.legs-table th {
  padding: 9px 10px;
  font-weight: 500;
  color: var(--ink-3);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: left;
}
.scenario-table th.rt,
.legs-table th.rt { text-align: right; }
.scenario-table td,
.legs-table td {
  padding: 11px 10px;
  border-bottom: 1px solid var(--rule-hair);
}
.scenario-table td.rt,
.legs-table td.rt { text-align: right; }

.legs-table tr.legs-total {
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}
.legs-total td {
  border-bottom: 0;
  color: var(--ink-3);
  letter-spacing: 0.06em;
  font-size: 10.5px;
  padding-top: 12px;
  padding-bottom: 12px;
  font-weight: 500;
}
.legs-total td.up { color: var(--gain); font-weight: 600; }

.leg-side {
  display: inline-block;
  padding: 2px 8px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
}
.leg-side.buy { background: var(--gain-wash); color: var(--gain); }
.leg-side.sell { background: var(--loss-wash); color: var(--loss); }

.be-line {
  margin-top: 16px;
  font-size: 11px;
  color: var(--ink-2);
  letter-spacing: 0.04em;
}
.be-line span { color: var(--ink); font-weight: 500; }

/* ===== other strategies ===== */
.other-section {
  margin-top: 40px;
}
.other-head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 14px;
}
.other-sub {
  font-size: 11px;
  color: var(--ink-3);
}
.other-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0;
  border-top: 1px solid var(--rule);
}
.other-card {
  text-align: left;
  padding: 16px 18px;
  background: transparent;
  border: 0;
  border-right: 1px solid var(--rule-hair);
  border-bottom: 1px solid var(--rule);
  cursor: pointer;
  transition: background 0.15s;
}
.other-card:hover { background: var(--paper-2); }
.other-name {
  font-size: 16px;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin-bottom: 4px;
}
.other-meta {
  font-size: 11px;
  color: var(--ink-3);
}

.disclaimer {
  margin-top: 40px;
  padding-top: 22px;
  border-top: 1px solid var(--rule);
  color: var(--ink-3);
  font-size: 13px;
  max-width: 62ch;
}

.loading {
  font-size: 12px;
  color: var(--ink-3);
  padding: 80px 0;
  text-align: center;
}
.error {
  border: 1px solid var(--loss);
  color: var(--loss);
  background: var(--loss-wash);
  padding: 12px 16px;
  font-family: var(--mono);
  font-size: 12px;
}

@media (max-width: 1100px) {
  .detail-body { grid-template-columns: 1fr; }
}
</style>
