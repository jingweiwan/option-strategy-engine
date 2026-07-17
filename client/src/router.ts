import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import StrategyView from '@/views/StrategyView.vue'
import Dashboard from '@/views/Dashboard.vue'
import Recommend from '@/views/Recommend.vue'
import Ticker from '@/views/Ticker.vue'
import Positions from '@/views/Positions.vue'
import SellPut from '@/views/SellPut.vue'
import Wheel from '@/views/Wheel.vue'
import Intel from '@/views/Intel.vue'
import DeepAnalysis from '@/views/DeepAnalysis.vue'
import Performance from '@/views/Performance.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'dashboard',
    component: Dashboard,
    meta: { title: '今日总览' }
  },
  {
    path: '/recommend',
    name: 'recommend',
    component: Recommend,
    meta: { title: '策略推荐' }
  },
  {
    path: '/strategy',
    name: 'strategy',
    component: StrategyView,
    meta: { title: '策略详情' }
  },
  {
    path: '/ticker',
    name: 'ticker',
    component: Ticker,
    meta: { title: '标的 · Greeks' }
  },
  {
    path: '/positions',
    name: 'positions',
    component: Positions,
    meta: { title: '持仓监控' }
  },
  {
    path: '/sell-put',
    name: 'sell-put',
    component: SellPut,
    meta: { title: 'Sell Put 扫描' }
  },
  {
    path: '/wheel',
    name: 'wheel',
    component: Wheel,
    meta: { title: '轮子 · Wheel' }
  },
  {
    path: '/intel',
    name: 'intel',
    component: Intel,
    meta: { title: 'AI 情报' }
  },
  {
    path: '/deep',
    name: 'deep',
    component: DeepAnalysis,
    meta: { title: 'OCIFQ 深度分析' }
  },
  {
    path: '/performance',
    name: 'performance',
    component: Performance,
    meta: { title: 'Performance' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

export const router = createRouter({
  history: createWebHistory(),
  routes
})
