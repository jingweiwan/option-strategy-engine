<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fetchWheelScan } from '@/api/client'
import { useWatchlist } from '@/composables/useWatchlist'
import type { WheelScanResult } from '@/types'

const { syms } = useWatchlist()

const data = ref<WheelScanResult | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const showSkipped = ref(false)

const cashOkOnly = ref(false)

const csp = computed(() => {
  if (!data.value) return []
  return data.value.csp.filter((c) => !cashOkOnly.value || c.cashOk === true)
})

function fmtPct(n: number, d = 1) {
  return (n * 100).toFixed(d) + '%'
}
function fmtMoney(n: number) {
  return '$' + Math.round(n).toLocaleString()
}

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchWheelScan(syms.value)
  } catch (e: any) {
    error.value = e?.message ?? '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="wheel-page">
    <header class="page-header">
      <div>
        <h1 class="serif">轮子 · Wheel</h1>
        <p class="subtitle">基本面把关的接股卖 Put + 持仓 Covered Call · 接股是目的,不是事故</p>
      </div>
      <button class="refresh-btn mono" :disabled="loading" @click="load">
        {{ loading ? '扫描中…' : '刷新' }}
      </button>
    </header>

    <div v-if="error" class="error-box mono">{{ error }}</div>
    <div v-else-if="loading && !data" class="dim" style="padding: 24px 0">扫描中…(基本面 + 期权链 + 财报日历)</div>

    <template v-if="data">
      <!-- Cash context -->
      <div class="cash-bar mono">
        <span>可接股现金:<strong class="tnum">{{ data.cash != null ? fmtMoney(data.cash) : '未知(刷新持仓)' }}</strong></span>
        <label class="toggle">
          <input v-model="cashOkOnly" type="checkbox" />
          只看现金接得住的
        </label>
      </div>

      <!-- CSP table -->
      <section>
        <div class="sec-head">
          <h2 class="serif">卖 Put 接股(CSP)</h2>
          <span class="dim mono">{{ csp.length }} 个 · 已过基本面/财报/杠杆ETF门</span>
        </div>
        <div v-if="csp.length > 0" class="table-wrap">
          <table class="wheel-table">
            <thead>
              <tr>
                <th class="mono">标的</th>
                <th class="mono">基本面</th>
                <th class="mono">到期</th>
                <th class="mono r">行权价</th>
                <th class="mono r">收权利金</th>
                <th class="mono r">Δ</th>
                <th class="mono r">年化</th>
                <th class="mono r">折价</th>
                <th class="mono r">接股成本</th>
                <th class="mono">现金</th>
                <th class="mono r">评分</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in csp" :key="c.optionSymbol">
                <td>
                  <span class="sym">{{ c.sym }}</span>
                  <span v-if="c.concentrated" class="warn-chip" title="已重仓该标的,再接会加集中度">⚠集中</span>
                </td>
                <td class="fund-cell">
                  <span class="fund-score tnum mono" :class="c.fundamentals.score >= 0.6 ? 'good' : ''">{{ c.fundamentals.score.toFixed(2) }}</span>
                  <span class="fund-notes dim">{{ c.fundamentals.notes.join(' · ') }}</span>
                </td>
                <td class="mono tnum">{{ c.expiration }} <span class="dim">{{ c.dte }}d</span></td>
                <td class="mono tnum r">${{ c.strike }}</td>
                <td class="mono tnum r gain">${{ (c.premium * 100).toFixed(0) }}</td>
                <td class="mono tnum r">{{ c.delta.toFixed(2) }}</td>
                <td class="mono tnum r">{{ fmtPct(c.rocAnnualized) }}</td>
                <td class="mono tnum r">{{ c.discountPct.toFixed(1) }}%</td>
                <td class="mono tnum r">{{ fmtMoney(c.assignmentCost) }}</td>
                <td class="mono">
                  <span v-if="c.cashOk === true" class="ok">✓够</span>
                  <span v-else-if="c.cashOk === false" class="no">✗超</span>
                  <span v-else class="dim">?</span>
                </td>
                <td class="mono tnum r"><span class="score-chip">{{ c.wheelScore.toFixed(2) }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="dim empty">无达标 CSP —— 门槛没放水:基本面不过关、跨财报、或现金筛掉了。空着也是对的。</p>
      </section>

      <!-- Covered calls -->
      <section>
        <div class="sec-head">
          <h2 class="serif">持仓 Covered Call</h2>
          <span class="dim mono">行权价永不低于成本 · 已有短 call 的持仓自动跳过</span>
        </div>
        <div v-if="data.coveredCalls.length > 0" class="table-wrap">
          <table class="wheel-table">
            <thead>
              <tr>
                <th class="mono">标的</th>
                <th class="mono r">持股@成本</th>
                <th class="mono r">现价</th>
                <th class="mono">到期</th>
                <th class="mono r">建议行权价</th>
                <th class="mono r">收/张</th>
                <th class="mono r">可卖张数</th>
                <th class="mono r">年化收益</th>
                <th class="mono r">被叫走总回报</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in data.coveredCalls" :key="c.sym">
                <td><span class="sym">{{ c.sym }}</span> <span v-if="c.underwater" class="warn-chip">{{ c.note }}</span></td>
                <td class="mono tnum r">{{ c.heldQty }}@{{ c.costBasis.toFixed(2) }}</td>
                <td class="mono tnum r">{{ c.spot.toFixed(2) }}</td>
                <td class="mono tnum">{{ c.expiration }} <span class="dim">{{ c.dte }}d</span></td>
                <td class="mono tnum r">${{ c.strike }}</td>
                <td class="mono tnum r gain">${{ (c.premium * 100).toFixed(0) }}</td>
                <td class="mono tnum r">{{ c.contractsAvailable }}</td>
                <td class="mono tnum r">{{ fmtPct(c.yieldAnnualized) }}</td>
                <td class="mono tnum r">{{ c.ifCalledReturnPct.toFixed(1) }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="dim empty">当前无 CC 建议(持仓不足 100 股、已有短 call、或数据暂不可用)。</p>
      </section>

      <!-- Skipped -->
      <section v-if="data.skipped.length > 0">
        <button class="link-btn mono dim" @click="showSkipped = !showSkipped">
          {{ showSkipped ? '▾' : '▸' }} 跳过 {{ data.skipped.length }} 个(点开看原因)
        </button>
        <ul v-if="showSkipped" class="skip-list mono dim">
          <li v-for="s in data.skipped" :key="s.sym + s.reason">{{ s.sym }}: {{ s.reason }}</li>
        </ul>
      </section>

      <p class="dim disclaimer">轮子纪律:只卖愿意持有的、财报前不卖、接股后 call 永不低于成本。数据延迟 ~15 分钟,下单前核对实时盘口。</p>
    </template>
  </div>
</template>

<style scoped>
.wheel-page { max-width: 1180px; }
.page-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; }
.page-header h1 { font-size: 32px; }
.subtitle { color: var(--ink-3); margin-top: 6px; font-size: 13px; }
.refresh-btn { padding: 8px 18px; border: 1px solid var(--rule); background: none; cursor: pointer; font-size: 13px; }
.refresh-btn:hover { background: var(--paper-3); }
.error-box { color: var(--loss); padding: 14px 0; }
.cash-bar { display: flex; gap: 24px; align-items: center; padding: 12px 14px; background: var(--paper-3); font-size: 13px; margin-bottom: 24px; }
.toggle { display: flex; gap: 6px; align-items: center; cursor: pointer; color: var(--ink-3); }
.sec-head { display: flex; align-items: baseline; gap: 14px; margin: 26px 0 10px; }
.sec-head h2 { font-size: 20px; }
.table-wrap { overflow-x: auto; }
.wheel-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.wheel-table th { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); color: var(--ink-4); font-size: 11px; }
.wheel-table th.r, .wheel-table td.r { text-align: right; }
.wheel-table td { padding: 10px; border-bottom: 1px solid var(--rule-hair); }
.sym { font-weight: 600; }
.fund-cell { max-width: 230px; }
.fund-score { margin-right: 6px; }
.fund-score.good { color: var(--gain); }
.fund-notes { font-size: 11px; display: block; }
.gain { color: var(--gain); }
.ok { color: var(--gain); }
.no { color: var(--loss); }
.warn-chip { font-size: 11px; color: var(--loss); margin-left: 6px; }
.score-chip { background: var(--paper-3); padding: 2px 8px; }
.empty { padding: 14px 0; font-size: 13px; }
.link-btn { background: none; border: none; cursor: pointer; padding: 8px 0; font-size: 12px; }
.skip-list { font-size: 12px; line-height: 1.9; padding-left: 16px; }
.disclaimer { margin-top: 30px; font-size: 12px; }
</style>
