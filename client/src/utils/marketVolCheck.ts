import type { MarketVolCheck } from '@/types'

/**
 * 卡片和详情页共用同一段解释。分开写过一次,结果两处对同一个数字讲了
 * 不同的故事——最早的版本把整段差额说成「RV 会低于 IV」,那是错的:
 *
 *   1. marketSigma 取自卖出腿(短腿行权价上),simSigma 从 ATM IV 推;
 *      两者的缺口里本来就含 skew,RV 还没进场就已经存在。
 *   2. 发布口径除了路径走 simSigma,盯市也一路衰减到 simSigma(收 VRP);
 *      对照口径两处一起撤掉。卖出腿比 ATM 贵时,convergeTo 按引擎既定的
 *      「只向下收敛」规则是空操作,对照那边根本不收 VRP。
 *
 * 所以差额是「整个 VRP 赌注」,不是「只换了扩散 σ」。
 */
export function marketVolCheckTitle(mv: MarketVolCheck): string {
  const pct = (x: number) => (x * 100).toFixed(1) + '%'
  return (
    `发布的 POP/EV 押的是「已实现波动会低于隐含」,这个赌注同时进入两处:` +
    `路径按 σ=${pct(mv.simSigma)}(= max(0.7·RV + 0.3·IV, 0.6·IV))扩散,` +
    `并且持仓期内盯市也一路衰减到这个水平(收 VRP)。\n\n` +
    `对照口径把这两处一起撤掉,改用市场为这些卖出腿定的价 σ=${pct(mv.marketSigma)}:` +
    `同样的腿、同样的退出政策、同一批随机数,得到 ${pct(mv.pop)}。\n\n` +
    `差额不是单纯的「RV<IV」——marketSigma 取在短腿行权价上,带着 skew;` +
    `也不是「只换了扩散 σ」——盯市那一半同样撤掉了(卖出腿比 ATM 贵时,` +
    `引擎只向下收敛,对照这边就完全不收 VRP)。`
  )
}
