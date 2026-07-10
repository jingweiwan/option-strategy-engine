<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  LegendComponent,
  TitleComponent
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { OptionLeg, PayoffCurve } from '@/types'
import { useTweaks } from '@/composables/useTweaks'

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  LegendComponent,
  TitleComponent,
  SVGRenderer
])

const props = defineProps<{
  legs: OptionLeg[]
  spot: number
  expectedMove: number
  breakevens: number[]
  curve: PayoffCurve
}>()

const chartEl = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
const { tweaks } = useTweaks()

function cssVar(name: string): string {
  if (typeof window === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const series = computed(() => {
  const expirationData = props.curve.points
  const profitData: [number, number][] = expirationData.map(([x, y]) => [x, y > 0 ? y : 0])
  const lossData: [number, number][] = expirationData.map(([x, y]) => [x, y < 0 ? y : 0])
  return { expirationData, profitData, lossData, lo: props.curve.xMin, hi: props.curve.xMax }
})

function buildOption() {
  const { expirationData, profitData, lossData, lo, hi } = series.value

  const ink = cssVar('--ink') || '#1a1a1a'
  const ink3 = cssVar('--ink-3') || '#6e6a60'
  const ink4 = cssVar('--ink-4') || '#9a9588'
  const ruleHair = cssVar('--rule-hair') || '#ddd6c4'
  const ruleSoft = cssVar('--rule-soft') || '#c9c2b1'
  const accent = cssVar('--accent') || 'oklch(0.58 0.13 35)'
  const gain = cssVar('--gain') || 'oklch(0.55 0.13 145)'
  const loss = cssVar('--loss') || 'oklch(0.55 0.16 25)'

  return {
    animation: false,
    // 纸色由外层 .chart 的 CSS 提供，避免 Canvas/SVG 与 DOM 背景双层叠加在重绘时产生色差抖动
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'JetBrains Mono, ui-monospace, monospace' },
    grid: { top: 18, left: 60, right: 28, bottom: 56 },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      transitionDuration: 0,
      axisPointer: { type: 'line', animation: false },
      backgroundColor: cssVar('--paper') || '#faf8f3',
      borderColor: ruleSoft,
      textStyle: { color: ink, fontFamily: 'JetBrains Mono, ui-monospace, monospace' },
      formatter: (params: any) => {
        const pnlSeries = params.find((p: any) => p.seriesName === 'P&L at expiration') ?? params[0]
        const price = pnlSeries.data[0]
        const pnl = pnlSeries.data[1]
        const sign = pnl >= 0 ? '+' : ''
        const color = pnl >= 0 ? cssVar('--gain') : cssVar('--loss')
        return `
          <div style="font-size:11px;font-family:JetBrains Mono,ui-monospace,monospace;letter-spacing:0.04em">
            <div style="color:${ink3}">PRICE</div>
            <div style="font-size:13px;margin-bottom:6px"><b>${price.toFixed(2)}</b></div>
            <div style="color:${ink3}">P&amp;L</div>
            <div style="font-size:13px;color:${color}"><b>${sign}${pnl.toFixed(2)}</b></div>
          </div>
        `
      }
    },
    xAxis: {
      type: 'value',
      name: 'Stock Price',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { color: ink3, fontSize: 10, fontFamily: 'JetBrains Mono, monospace' },
      min: lo,
      max: hi,
      axisLine: { lineStyle: { color: ruleSoft } },
      axisTick: { lineStyle: { color: ruleSoft } },
      axisLabel: { formatter: (v: number) => v.toFixed(0), color: ink3, fontSize: 10 },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      name: 'P&L',
      nameLocation: 'middle',
      nameGap: 44,
      nameTextStyle: { color: ink3, fontSize: 10, fontFamily: 'JetBrains Mono, monospace' },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { formatter: (v: number) => v.toFixed(1), color: ink3, fontSize: 10 },
      splitLine: { lineStyle: { color: ruleHair } }
    },
    series: [
      {
        name: 'Profit',
        type: 'line',
        data: profitData,
        silent: true,
        showSymbol: false,
        lineStyle: { width: 0 },
        areaStyle: { color: gain, opacity: 0.12 },
        z: 1,
        tooltip: { show: false },
        emphasis: { disabled: true }
      },
      {
        name: 'Loss',
        type: 'line',
        data: lossData,
        silent: true,
        showSymbol: false,
        lineStyle: { width: 0 },
        areaStyle: { color: loss, opacity: 0.12 },
        z: 1,
        tooltip: { show: false },
        emphasis: { disabled: true }
      },
      {
        name: 'P&L at expiration',
        type: 'line',
        data: expirationData,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 2, color: accent },
        emphasis: { scale: false, focus: 'none' },
        z: 3,
        markLine: {
          symbol: 'none',
          data: [
            {
              yAxis: 0,
              lineStyle: { color: ruleSoft, width: 1, type: 'solid' as const },
              label: { show: false }
            },
            {
              xAxis: props.spot,
              lineStyle: { color: ink, width: 1.5 },
              label: {
                formatter: `SPOT ${props.spot.toFixed(0)}`,
                position: 'insideEndTop',
                fontSize: 9,
                color: ink,
                fontWeight: 600,
                fontFamily: 'JetBrains Mono, monospace'
              }
            },
            ...props.breakevens.map((b, i) => ({
              xAxis: b,
              lineStyle: { color: accent, width: 1, type: 'dashed' as const },
              label: {
                formatter: `BE ${b.toFixed(2)}`,
                position: i === 0 ? 'insideStartTop' as const : 'insideEndTop' as const,
                fontSize: 9,
                color: accent,
                fontFamily: 'JetBrains Mono, monospace'
              }
            })),
            ...props.legs.map((leg) => ({
              xAxis: leg.strike,
              lineStyle: { color: ink4, width: 1, type: 'dotted' as const, opacity: 0.7 },
              label: {
                formatter: `${leg.action === 'buy' ? '+' : '−'}${leg.type[0].toUpperCase()}${leg.strike}`,
                position: 'insideEndBottom' as const,
                fontSize: 9,
                color: ink3,
                fontFamily: 'JetBrains Mono, monospace',
                distance: 2
              }
            }))
          ]
        }
      }
    ]
  }
}

let rafId: number | null = null
function render() {
  if (!chart) return
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    chart?.setOption(buildOption(), { notMerge: true, lazyUpdate: false, silent: true })
    rafId = null
  })
}

onMounted(() => {
  if (chartEl.value) {
    // SVG 在 axis tooltip 连续更新时比 Canvas 更稳定，避免半透明 area 与网格亚像素抖动
    chart = echarts.init(chartEl.value, undefined, { renderer: 'svg' })
    render()
    window.addEventListener('resize', resize)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
  chart = null
})

function resize() {
  chart?.resize()
}

watch(
  () => [props.curve, props.spot, props.expectedMove, props.breakevens, props.legs],
  render,
  { deep: true }
)

watch(() => [tweaks.theme, tweaks.accent], render)
</script>

<template>
  <div ref="chartEl" class="chart" />
</template>

<style scoped>
.chart {
  width: 100%;
  height: 300px;
  background: var(--paper);
}
</style>
