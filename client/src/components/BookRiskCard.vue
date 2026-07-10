<script setup lang="ts">
import { computed } from 'vue'
import type { BookRisk, RealBook } from '@/types'

const props = defineProps<{ risk: BookRisk; real?: RealBook | null }>()

const carryUsd = computed(() => Math.round(props.risk.netThetaUsd))
const maxLossUsd = computed(() => Math.round(props.risk.aggMaxLossUsd))
const ratio = computed(() =>
  props.risk.netThetaUsd > 0 ? Math.round(props.risk.aggMaxLossUsd / props.risk.netThetaUsd) : null
)
// 1 red square per day of carry the tail wipes out; capped so a huge ratio
// still lays out. 1 green square = the single day just earned.
const redCells = computed(() => (ratio.value ? Math.min(ratio.value, 400) : 0))

const greeks = computed(() => {
  const r = props.risk
  const dn = Math.abs(r.netDelta) <= 1
  return [
    { cn: '方向', sym: 'Δ', en: 'DELTA', val: r.netDelta,
      status: dn ? '中性' : r.netDelta > 0 ? '偏多' : '偏空', good: dn,
      meaning: dn ? '多空基本对冲，不赌方向' : '篮子整体有方向' },
    { cn: '跳空', sym: 'Γ', en: 'GAMMA', val: r.netGamma,
      status: r.netGamma < 0 ? '净空' : '净多', good: r.netGamma >= 0,
      meaning: '标的跳空时，亏损会加速' },
    { cn: '波动率', sym: 'V', en: 'VEGA', val: r.netVega,
      status: r.netVega < 0 ? '净空' : '净多', good: r.netVega >= 0,
      meaning: 'IV 上冲会同时打击整篮' },
    { cn: '时间', sym: 'Θ', en: 'THETA', val: r.netTheta,
      status: r.netTheta > 0 ? '收租' : '贴钱', good: r.netTheta > 0,
      meaning: 'carry 来源 · 每天时间价值入账' }
  ]
})

const fmt2 = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2)
const usd = (n: number) => Math.round(n).toLocaleString('en-US')
</script>

<template>
  <section class="brc">
    <div class="brc-head">
      <div>
        <div class="brc-eyebrow mono">风险体检</div>
        <div class="brc-name serif">组合风险</div>
      </div>
      <div class="brc-meta">
        <div>整块推荐板 · 每仓位 1 张合约</div>
        <div v-if="risk.accountSize" class="dim">
          账户 ${{ usd(risk.accountSize) }}{{ risk.accountSource === 'rh' ? '(RH)' : '' }}
          <template v-if="risk.rhAgeHours != null"> · 持仓数据 {{ Math.round(risk.rhAgeHours) }}h 前</template>
          <span v-if="(risk.rhAgeHours ?? 0) > 24" class="loss"> · 已过期,叫我刷新</span>
        </div>
        <div v-else class="dim">非真实账户敞口 — 券商持仓未接入</div>
      </div>
    </div>

    <!-- 一句话结论 -->
    <div class="brc-lede serif">
      <template v-if="ratio">
        把板上 {{ risk.positions }} 个仓位都开 1 张，每天靠时间价值挣
        <span class="gain">+${{ usd(risk.netThetaUsd) }}</span>；但尾部同时打满，一次亏
        <span class="loss">−${{ usd(risk.aggMaxLossUsd) }}</span>——
        <em class="loss">{{ ratio }} 天的 carry 一笔归零</em>。
      </template>
      <template v-else>
        把板上 {{ risk.positions }} 个仓位都开 1 张，尾部同时打满一次亏
        <span class="loss">−${{ usd(risk.aggMaxLossUsd) }}</span>。
      </template>
    </div>

    <div class="brc-box">
      <!-- 收益 vs 尾部 -->
      <div class="brc-row brc-row-hero">
        <div class="brc-hero-left">
          <div class="brc-col-label mono">收益 VS 尾部</div>
          <div class="brc-fig-label">每日 CARRY</div>
          <div class="brc-fig gain">+${{ usd(risk.netThetaUsd) }}<span class="brc-fig-unit">/日</span></div>
          <div class="brc-fig-label" style="margin-top: 18px">同时打满最大亏损</div>
          <div class="brc-fig loss">
            −${{ usd(risk.aggMaxLossUsd) }}
            <span v-if="risk.undefinedRiskCount > 0" class="brc-uncapped">+{{ risk.undefinedRiskCount }} 无封顶</span>
          </div>
        </div>

        <div class="brc-hero-right">
          <div class="brc-grid-scale mono">1 格 = 1 天 carry (${{ usd(risk.netThetaUsd) }})</div>
          <div v-if="ratio" class="brc-legend">
            <span class="brc-leg"><span class="cell green" /> 今天挣到的:<b>1</b>格</span>
            <span class="brc-leg"><span class="cell red" /> 尾部一次打满要还回去的:<b>{{ ratio }}</b>格</span>
          </div>
          <div class="brc-grid">
            <span class="cell green" />
            <span v-for="i in redCells" :key="i" class="cell red" />
          </div>
          <div class="brc-col-cap">最大亏损仅统计定义风险仓位 · 金额为每仓位 1 张的美元口径（×100）</div>
        </div>
      </div>

      <!-- 净敞口 -->
      <div class="brc-row brc-greeks-row">
        <div class="brc-greeks">
          <div v-for="g in greeks" :key="g.sym" class="brc-greek">
            <div class="brc-greek-head">
              <span class="brc-greek-name">{{ g.cn }} · {{ g.sym }} {{ g.en }}</span>
              <span class="brc-badge" :class="g.good ? 'good' : 'bad'">{{ g.status }}</span>
            </div>
            <div class="brc-greek-val mono">{{ fmt2(g.val) }}</div>
            <div class="brc-greek-mean">{{ g.meaning }}</div>
          </div>
        </div>
        <div class="brc-col-cap">净敞口 = 每仓位 1 张的原始 greek 求和 · 只表达符号与相对大小，不是美元</div>
      </div>

      <!-- 尾部提示 -->
      <div v-if="risk.flags.length" class="brc-row brc-flags-row">
        <div class="brc-col-label mono">尾部提示</div>
        <div class="brc-flags">
          <div v-for="(f, i) in risk.flags" :key="i" class="brc-flag">
            <span class="brc-flag-no mono">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="brc-flag-text">{{ f }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="real" class="brc-real mono">
      <span class="brc-real-label">真实账簿(RH)</span>
      <span>Δ {{ fmt2(real.netDelta) }}</span>
      <span>Γ {{ fmt2(real.netGamma) }}</span>
      <span>V {{ fmt2(real.netVega) }}</span>
      <span>Θ {{ fmt2(real.netTheta) }}</span>
      <span class="dim">{{ real.matchedLegs }}/{{ real.optionLegCount }} 腿已解析<template v-if="real.unmatchedLegs"> · {{ real.unmatchedLegs }} 腿(远期 LEAPS)无 greeks</template></span>
    </div>

    <div class="brc-foot">
      <span>{{ risk.positions }} 个仓位 · 其中 {{ risk.shortVolCount }} 个卖波动(净空 vega)</span>
      <span class="mono dim">bookRisk · summarizeBookRisk v1</span>
    </div>
  </section>
</template>

<style scoped>
.brc { margin: 30px 0; }
.gain { color: var(--gain); }
.loss { color: var(--loss); }
.dim { color: var(--ink-3); }

.brc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.brc-eyebrow { font-size: 11px; letter-spacing: 0.14em; color: var(--ink-3); margin-bottom: 10px; }
.brc-name { font-size: 30px; color: var(--ink); font-weight: 500; }
.brc-meta { text-align: right; font-size: 13px; line-height: 1.5; color: var(--ink-2); white-space: nowrap; }

.brc-lede {
  font-size: 27px; line-height: 1.5; color: var(--ink); font-weight: 500;
  margin: 18px 0 26px; max-width: 62ch;
}
.brc-lede .gain, .brc-lede .loss { font-weight: 500; }
.brc-lede em { font-style: italic; }

.brc-box { border: 1px solid var(--rule); border-radius: 4px; overflow: hidden; }
.brc-row { padding: 24px 28px; }
.brc-row + .brc-row { border-top: 1px solid var(--rule); }
.brc-col-label { font-size: 11px; letter-spacing: 0.12em; color: var(--ink-3); margin-bottom: 18px; }
.brc-col-cap { font-size: 12px; line-height: 1.5; color: var(--ink-3); margin-top: 16px; }

.brc-row-hero { display: flex; gap: 40px; }
.brc-hero-left { flex-shrink: 0; width: 190px; }
.brc-hero-right { flex: 1; min-width: 0; }
.brc-fig-label { font-size: 13px; color: var(--ink-2); margin-bottom: 4px; }
.brc-fig { font-size: 30px; font-weight: 500; line-height: 1.1; }
.brc-fig-unit { font-size: 15px; }
.brc-uncapped { font-size: 11px; color: var(--loss); margin-left: 6px; }

.brc-grid-scale { font-size: 12px; color: var(--ink-3); text-align: right; margin-bottom: 12px; }
.brc-legend { display: flex; gap: 24px; margin-bottom: 12px; font-size: 12px; color: var(--ink-2); }
.brc-leg { display: inline-flex; align-items: center; gap: 6px; }
.brc-leg b { font-weight: 500; color: var(--ink); margin: 0 1px; }
.brc-grid { display: flex; flex-wrap: wrap; gap: 3px; }
.cell { width: 10px; height: 10px; border-radius: 1px; flex-shrink: 0; }
.cell.green { background: var(--gain); }
.cell.red { background: var(--loss); }

.brc-greeks { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--rule); }
.brc-greek { background: var(--paper); padding: 4px 20px 4px 0; }
.brc-greek:not(:first-child) { padding-left: 20px; }
.brc-greek-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; }
.brc-greek-name { font-size: 12px; color: var(--ink-2); }
.brc-badge { font-size: 11px; padding: 2px 8px; border-radius: 3px; white-space: nowrap; }
.brc-badge.good { background: var(--gain-wash); color: var(--gain); }
.brc-badge.bad { background: var(--loss-wash); color: var(--loss); }
.brc-greek-val { font-size: 26px; font-weight: 500; color: var(--ink); line-height: 1; margin-bottom: 10px; }
.brc-greek-mean { font-size: 12px; line-height: 1.4; color: var(--ink-2); }

.brc-flags-row { background: var(--paper-3); }
.brc-flags { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.brc-flag { display: grid; grid-template-columns: 22px 1fr; gap: 10px; }
.brc-flag-no { font-size: 12px; color: var(--accent); padding-top: 2px; }
.brc-flag-text { font-size: 13px; line-height: 1.5; color: var(--ink-2); }

.brc-real {
  display: flex; flex-wrap: wrap; gap: 14px; align-items: baseline;
  margin-top: 12px; padding: 10px 14px;
  border: 1px solid var(--rule); border-radius: 4px;
  font-size: 12.5px; color: var(--ink);
}
.brc-real-label { color: var(--ink-3); letter-spacing: 0.08em; font-size: 11px; }

.brc-foot {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-top: 14px; font-size: 12px; color: var(--ink-2);
}

@media (max-width: 880px) {
  .brc-lede { font-size: 22px; }
  .brc-row-hero { flex-direction: column; gap: 24px; }
  .brc-hero-left { width: auto; }
  .brc-greeks { grid-template-columns: repeat(2, 1fr); }
  .brc-flags { grid-template-columns: 1fr; }
  .brc-head { flex-direction: column; gap: 10px; }
  .brc-meta { text-align: left; white-space: normal; }
}
</style>
