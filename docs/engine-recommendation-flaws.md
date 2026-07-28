# 引擎推荐逻辑缺陷 — 实盘复盘发现

> 记录日期：2026-07-28
> 分支：`docs/engine-recommendation-flaws`
> 来源：结合真实 Robinhood 持仓(account ••••9488)做组合风险分析时发现
> 性质：**产品/策略逻辑缺陷**,非崩溃类 bug;不阻塞,但影响推荐质量与用户风险

关联:`docs/code-review-architecture-and-issues.md` §3 问题清单(本文件是其补充,聚焦「推荐是否 fit 用户处境」这一维度)。

---

## 背景

一次实盘复盘中,账户已是 **净 dollar-delta +$218k ≈ 账户 1.27×** 的严重多头(集中在 Alphabet + META + 科技 LEAP)。在此背景下审视引擎当天的两张推荐卡,暴露出两个独立缺陷。二者共同的根因是:**引擎按「单标的 + 单策略」评分,缺少对「用户全局状态」和「跨信号一致性」的校验。**

---

## 缺陷 1 — 组合级 delta 感知缺失 🔴 P1

### 现象

引擎给出 **QQQ iron_condor**(9/18,POP 80.5%,EV +0.16)。因 put skew,该铁鹰**净多 ~+$5.4k delta/张**。而用户账户已 1.27× 超配多头 —— 推荐**继续往同一方向加码**,与「降风险」完全相反。

### 根因

策略选择只看单标的的 IV/RV/IVR/regime/POP/EV,**完全不读取用户当前持仓的净敞口**。`runEngineLive` / `oppScanner` 的输入里没有「组合 net delta / 单名集中度」这类上下文。

### 影响

- 用户想中性收 theta,却在不知不觉中被推成 1.27× 净多。
- 「诊断出超配 → 引擎却继续推多头」形成反向拉扯,用户需人工识别每张卡的组合贡献。

### 建议修复

1. 引擎/Dashboard 计算并展示**每张推荐卡的净 delta 贡献**($ 与占账户 %)。
2. 可选:传入组合 net-delta 上下文,对「加剧现有敞口」的卡做降权或打标(如 ⚠「会把你的净多头从 1.27× 推到 1.30×」)。
3. 最小版本:先在卡片上显示单卡 `net $delta`,把判断权交给用户,不做自动降权。

---

## 缺陷 2 — `long_straddle` 财报事件触发未校验波动率是否便宜 🔴 P1

### 现象

引擎给出 **WMT long_straddle**(9/18,财报 8/20,POP 38.1%,EV +0.06,净付 $10.14)。同一张卡上:

| 信号 | 值 | 指向 |
|---|---|---|
| IVR | **71(偏高)** | 卖方 |
| IV vs RV | 28.7% > 24.3%(+4.4pp)| 期权**偏贵**,卖方 |
| regime | **sell** | 卖方 |
| 推荐 | **buy** long_straddle | 买方 ⟵ 与上面全部矛盾 |

即:在「三个信号一致喊卖波动率」的环境里,推了个**买波动率**、且穿越财报吃 **IV crush** 的仓。卡片自己承认「IV-RV缺口4.4pp显示期权偏贵」,却用「财报前IV可能进一步上升」自圆。

### 根因(代码定位)

- `directionalView.ts:83-90`:`neutral-vol`(唯一触发 `long_straddle` 的 view)的判据本应是 **IVR 极低(<20)** 或 **临近财报 + IV 偏低**。此处走的是「临近财报」这一路,但**条件里「IV 偏低」那一半未被校验**,靠事件临近单独触发。
- `oppScanner.ts:275-303` `regimeBonus`:`long_straddle` 属 `BUY_STRATEGIES`,在 `regime=sell` 应得 0.6× 惩罚;高 IVR(71,近 75 阈值)也应偏向卖方。**事件驱动路径绕过了这些护栏。**
- `calibration.ts:5-9, 58-63`:代码明确记载 long_straddle **系统性失血**(「52%-win…loses −3.48/trade」「few big-percent winners…hiding that it loses money」),校准专门用「均值 $ 盈亏」而非胜率来压制它。本例说明:**财报事件路径能绕过 regime 惩罚 + 校准抑制。**

### 影响

- 在最不该买波动的环境(高 IVR + IV>RV + sell regime)推荐买入跨式,用户在 IV crush 前买贵波动率。
- POP 38% / EV +0.06,近乎零 edge 的彩票,却被正常呈现为推荐。
- 与引擎自身「straddle 会失血」的设计认知相矛盾 —— 护栏在事件路径上形同虚设。

### 建议修复

1. **加一道 vol 便宜度闸**:事件驱动的 `long_straddle` 需**同时**满足 `IV < RV`(或 `IVR < 阈值`,如 40),否则:
   - 在 `regime=sell` + 高 IVR 时,降级为卖方结构(short_strangle / iron_condor),或
   - 直接不推该 straddle。
2. 若坚持保留财报 straddle,应在卡片显式标注「买入高 IV,穿越财报有 IV crush 风险」,并让 EV 计入 crush(检查 `index.ts:367` 的 `crushIv` 是否已覆盖此路径的定价)。
3. 复核事件驱动路径为何能绕过 `regimeBonus` 的 0.6× 惩罚与 `calibration` 抑制 —— 二者本应对 `long_straddle` 生效。

---

## 优先级与共性

| # | 缺陷 | 级别 | 共性根因 |
|---|---|---|---|
| 1 | 组合级 delta 感知缺失 | P1 | 只看单标的,不看用户全局状态 |
| 2 | straddle 事件触发未校验 vol 便宜度 | P1 | 只看单策略触发,不做跨信号(regime/IVR/IV-RV)一致性校验 |

两条都不阻塞现有功能,但都会让引擎**在错误的时机给出自信的推荐**。建议各自另开分支实现,先做缺陷 2 的 vol 闸(改动集中在 view 触发 + regimeBonus,范围小、收益直接)。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-28 | 初版:实盘复盘发现组合级 delta 感知缺失 + straddle 事件触发未校验 vol 便宜度 |
