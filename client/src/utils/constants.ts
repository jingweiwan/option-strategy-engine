import type { StrategyType } from '@/types'

export const STRAT_CN: Record<StrategyType, string> = {
  bull_call_spread: '看涨债务价差',
  bear_call_spread: '看跌信用价差',
  bull_put_spread: '看涨信用价差',
  bear_put_spread: '熊市看跌价差',
  iron_condor: '铁鹰',
  short_strangle: '裸卖宽跨',
  long_straddle: '跨式买入'
}
