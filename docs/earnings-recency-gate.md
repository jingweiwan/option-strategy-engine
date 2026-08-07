# 方案：fix/earnings-recency-gate（缺陷 3 · 杠杆①）

> 状态：已批可做 · 2026-07-31
> 基线分支：`fix/straddle-hardgate`（继承 `opp-scan-v11` / `opps-copy-v8`）
> 关联：`docs/engine-recommendation-flaws.md` 缺陷 3

---

## 1. 目标与范围

**止血**「财报刚发完、次日仍用尖峰 IVR 自动荐卖方」：

某标的在**美东财报日历日当天**（默认；可用 N 加长）报过财报时，其 IVR「极高」常是盘后瞬时尖峰（IV crush 将至/进行中）→ 该标的的**卖方**自动板机会从 `qualified` **降级为 `reference`**（可见、带标签、不自动荐、不进 feedback）。

**产品口径（2026-07-31 修订）：** 昨晚 AMC 发完 → **今天开盘应可再荐**（默认 N=0，只挡「今天」）。多日 lookback 过严，会误伤次日正常卖权。若次日 IV 仍尖，留给杠杆② IV-RV，不靠拉长日历窗。

这是前向 `spansEarnings`（到期前还有未发生财报 → 硬禁 `null`）的**后向镜像**。

**关键优点（别一刀切）：** 只在该股票自己近 N 天报过时降级 → 大盘富波动、未报财报的名字不误杀。

### 不做（follow-up）

| 项 | 说明 |
|----|------|
| 杠杆② ex-earnings IVR | 根因级重算 IVR，另开 |
| 杠杆③ 盘后新鲜度 | 报价/链时点感知，另开 |
| 原则① 单边 vertical | 产品决策 |
| IV-RV 感知降级（v2） | 见 §5；v1 不做 |

---

## 2. 审查拍板

| 点 | 裁决 |
|----|------|
| 降级目标 | **`reference`**（非 `null`） |
| IV-RV 感知 | **v1 不做**：近期报过即降；v2 若做，规则应是「仍贵才压」，不是「已 crush 才压」 |
| 数据层 | **拆两条线**：`nextEarnings` 与 `recentlyReported` 禁止共用一个「最早日期」map |
| 缓存 | **必须 bump**：`opp-scan-v13`、`opps-copy-v10`；earnings `v3`（today 退出 nextEarn） |
| 分支 | 从 `fix/straddle-hardgate` 切 |

---

## 3. 硬约束：分桶 + 可达性（方案 A）

`nextEarnIsoBySymbol` 每标的只留**最早一档严格未来日期**（`date > today`）。

### 3.1 禁止把过去日写入 nextEarn

若把过去日写入同一 map：`spansEarningsDate` → 过去日 ≤ 任意远期到期 → 卖方全 `null`。

### 3.2 禁止把「今天」写入 nextEarn（否则 recency 死代码）

默认 N=0 时 `recentlyReported ⟺ 当天有财报`。若当天仍进 `nextEarnIso`：

```
recentlyReported → nextEarn=today → spansEarnings(today, 未来到期)=true
                → sellVolDecision 先 return null
                → earnings_recency 降级永不执行
```

**方案 A（已落地）：** `buildNextEarnIsoMap` 用 `date > today`（`<= today` 全跳过）。
当天由 `recentlyReported` 降为 `reference`；未来未报由 `spansEarnings` 硬 `null`。
`partitionEarningsForScan` 是单一分桶入口。

| 场景 | nextEarn | recent | 卖方结果 |
|------|----------|--------|----------|
| 今天报 | 下季（或无） | true | **reference** / earnings_recency |
| 昨晚 AMC | 下季 | false | qualified（若 IVR 够） |
| 未来未报且到期跨事件 | 该日 | false | **null** |

---

## 4. 改动清单

### 4.1 数据

- 新增 `EARNINGS_RECENCY_DAYS`（默认 **`0`** = 仅 today；`1` = 含昨天；`<0` 关闭）— **美东日历日**
- 纯函数：`buildRecentlyReportedMap(entries, symbols, today, N)`（单测：N=0 昨天不中；N=1 边界）
- `fetchEarningsData`：N>0 时才多拉过去窗；返回 `recentlyReportedBySymbol`
- `nextEarnIsoBySymbol` **仅** `date >= today`
- earnings 日缓存 key bump（结果 shape 变了）

### 4.2 透传

`recentlyReported` 随 `earningsIso` 进入 `getScannedOpps` → `runScan` → `scanSymbol` → `boardTierDecision` ctx（与 `spansEarnings` 并列）。

### 4.3 闸（`sellVolDecision` → `{tier, reason}`）

单一真源：tier 与 UI reason 同一次判定产出，禁止另写 `boardTierReasonFor` 重推逻辑。

仅在 **sell-vol 分支**内（`SELL_VOL_STRATEGIES`，且已过 `spansEarnings` 检查之后）：

```
if ivr >= FLOOR:
  recentlyReported → { reference, earnings_recency }
  else → { qualified }
elif ivr >= REF → { reference, ivr_below_floor }
else → { null }
```

- debit / buy-vol 不走此降级（debit early-return；straddle 走 `buyVolDecision`）
- 薄包装 `sellVolTier` / `boardTierFor` 仅返回 `.tier`，供旧测与只关心分层的调用方

### 4.4 DTO / UI

- `ScannedOpp` / `Opp` / client types 增加 `boardTierReason?: 'ivr_below_floor' | 'earnings_recency' | …`（来自 decision.reason）
- Dashboard 参考位文案按原因区分：
  - `earnings_recency` →「刚报财报·IV 未稳定」
  - `ivr_below_floor`（默认）→「IVR 未及门槛」

### 4.5 缓存（不可漏）

| Key | 旧 → 新 |
|-----|---------|
| opp scan | → `opp-scan-v13` |
| opps copy | → `opps-copy-v10` |
| earnings calendar | → `earnings-calendar-v3` |

---

## 5. v2 备注（本次不做）

若以后做 IV-RV 感知，正确方向是：

> 近期报过 **且仍偏贵**（IV≫RV / 高 IVR）→ 降级；已明显 crush 回中性 → 可恢复 `qualified`

**错误方向：**「已 crush 回 RV 附近才降级」——会放过尖峰未散的 MSFT/META 盘。

---

## 6. 测试与验证

- `sellVolTier`：`recentlyReported=true` + 高 IVR 卖方 → `reference`；`false` → 不变；debit/straddle 不受影响
- `buildRecentlyReportedMap`：today / N / N+1 边界；**过去日不得进入 next map**（若同测聚合）
- `boardTierFor` 接线：`recentlyReported` 传入后卖方可降、buy-vol 仍走 `buyVolTier`
- `cd server && npm run check` 全绿
- golden：引擎 golden 无 `boardTier`；以跑测为准，不预设改

### 配置 / 回滚

- 默认 `EARNINGS_RECENCY_DAYS=0`（仅财报当日）
- `EARNINGS_RECENCY_DAYS=-1` 关闭后向闸
- `EARNINGS_RECENCY_DAYS=1` 或 `3` 恢复更长 lookback（偏保守）

---

## 7. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-31 | 初版：审查拍板写入；禁止污染 nextEarn；reference；v1 无 IV-RV；缓存 bump |
| 2026-07-31 | 复审 follow-up：`sellVolDecision`/`boardTierDecision` 一次产出 `{tier,reason}`；日历日注释 |
| 2026-07-31 | **默认 N=0**：昨晚 AMC → 今日可荐；多日窗改为可选 |
| 2026-07-31 | **方案 A 可达性**：today 不进 nextEarnIso；耦合测试；earnings-calendar-v3 |
