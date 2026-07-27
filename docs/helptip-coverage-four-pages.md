# HelpTip 覆盖补齐 — 零帮助四页

> 日期：2026-07-27
> 分支：`feature/helptip-coverage-four-pages`（从 `main` 切出）
> 类型：纯前端 · 交互体验补齐 · 无逻辑/数据改动

---

## 1. 背景

产品评审发现：术语解释（`HelpTip` ⓘ 悬浮提示）在各页覆盖严重不均。

| 页面 | 改动前 HelpTip 数 |
|------|:---:|
| StrategyView | 8 |
| Dashboard | 4 |
| Recommend | 3 |
| Wheel / Performance | 2 |
| **Ticker** | **0** |
| **Positions** | **0** |
| **Intel** | **0** |
| **DeepAnalysis** | **0** |

问题在于：**零帮助的四页恰恰术语最密**（Greeks、IV 倾斜、OCIFQ 五维、季度对齐）。当下作者门儿清，但半年后回看会忘记字段含义——这是"可解释性/上手性"这一维度被拉低的直接原因。

本次改动只做一件事：**给这四页的核心术语补 `HelpTip`**，把可解释性覆盖拉平。零后端、零逻辑、零数据路径改动。

---

## 2. 复用现有组件，不造新轮子

沿用既有 `client/src/components/HelpTip.vue`（已在 StrategyView 等页使用 8 次，样式/无障碍已验证）：

```vue
<HelpTip align="left|right|center" text="纯中文、口语化的一句话解释" />
```

- `align` 按提示所在位置选择，避免气泡溢出视口（靠右的统计项用 `right`，靠左的标题用 `left`）。
- 文案风格对齐现有用法：**先说是什么、再说怎么用、必要时给一句"别踩的坑"**。

---

## 3. 逐条改动清单（共 12 处提示）

### 3.1 `client/src/views/Ticker.vue`（2 处）

| 位置 | 术语 | 提示要点 |
|------|------|----------|
| 波动率倾斜标题「每个 strike 的 IV」 | IV skew | 负偏 = 市场为下跌买保险；曲线越陡尾部定价越高；**仅描述定价结构，不诱导某一侧卖出** |
| 期权链副标题 | Δ / IV / OI / 买卖价 | 解释表头缩写；**Δ≈价内概率标注为「粗略近似，严格不等」**；OI 因果软化为「通常」 |

### 3.2 `client/src/views/Positions.vue`（3 处）

| 位置 | 术语 | 提示要点 |
|------|------|----------|
| 净 Delta | 组合方向敞口 | 等效股数；**单一标的** +100 ≈ 持 100 股，**跨标的是合计、非同一只涨 $1**；接近 0 只是当前中性，**短 gamma 下大波动仍可能明显盈亏** |
| 净 Theta | 时间价值日流 | **ceteris-paribus 理论盈亏，非确定日收益**；一旦波动 gamma/vega 盈亏可能远超 theta（去掉原「躺赚」表述）|
| 净 Vega | IV 敞口 | IV 每变 1% 的盈亏；卖方组合常为负 Vega，靠 IV 回落获利 |

### 3.3 `client/src/views/Intel.vue`（3 处）

| 位置 | 概念 | 提示要点 |
|------|------|----------|
| 情报流 | AI 新闻/文件扫描 | 扫描范围是**自选 watchlist**（后端 `parseWatchlistSymbolsQuery`），**持仓仅影响置顶排序**；色条 = 利好/利空/中性/**需监控(Monitor) 四类**（`thesisImpact` 枚举）；可跳 OCIFQ |
| 跨公司联动 | 传导关系 | 与情报流**同源 watchlist**（原误作「持仓公司」）；from→to 方向 + strength 强度 |
| 扫描统计 | 覆盖面/新鲜度 | 数量偏低或生成时间过旧时结论要打折 |

### 3.4 `client/src/views/DeepAnalysis.vue`（4 处）

| 位置 | 概念 | 提示要点 |
|------|------|----------|
| **五维详解** | **OCIFQ 全称** | 按源码校准：**F = 营收 + 利润率 + FCF** · **I = 行业内利润率差距扩大** · **TOTAL =（O+C+I+F+Q）×2，满分 100**（`deepAnalysis.ts:427`，原误作「合计满分 10」）|
| Thesis Tracker | 论点追踪/证伪 | delta = 本季变化；证伪条件 = **供手动执行的纪律线，触发应考虑离场，系统不自动平仓**（`invalidation` 仅展示字段）|
| 数据来源 | 季度对齐 | ⚠ 两源最新季不一致时**不断言方向**（呼应 `docs/ocifq-quarter-alignment.md` §6 反向滞后未处理），跨季指标以各自标注季为准 |
| 管理层信心 | Call tone 信心分 | transcript 语气分析 0–100；仅反映语气，需与财务数据交叉验证 |

---

## 4. 改动文件

```
 client/src/views/DeepAnalysis.vue | 9 +++++----   (1 import + 4 tips)
 client/src/views/Intel.vue        | 7 ++++---     (1 import + 3 tips)
 client/src/views/Positions.vue    | 7 ++++---     (1 import + 3 tips)
 client/src/views/Ticker.vue       | 5 +++--       (1 import + 2 tips)
 4 files changed, 16 insertions(+), 12 deletions(-)
```

改动后四页 HelpTip 覆盖：均 ≥ 2 处，术语密集页（DeepAnalysis）4 处。

---

## 5. 验证

```bash
cd client && npm run build     # vue-tsc -b && vite build
```

- ✅ `vue-tsc -b` 类型检查通过（无报错）
- ✅ `vite build` 通过，644 模块全部编译（含本次改动的 4 个模板），exit 0
- ✅ 复用组件，`HelpTip` 的 props（`text` 必填、`align` 可选）与既有 8 处用法一致

**验证边界（诚实声明）**：本次验证止于类型检查 + 生产构建。因提示为**静态文案 + 已验证组件的悬浮渲染**（无任何数据路径），构建通过即覆盖了此类改动的主要风险。**未**启动全栈 + 浏览器做真机悬浮截图；如需，可另起 dev server 做一次可视巡检。

---

## 6. 已知边界 / 非本次范围

- **只补了核心术语**，非穷举。每页仍有次要缩写（如 Positions 的「资金占用」、Intel 的 category pill）未加提示——判断为自解释或低价值，刻意留白避免 ⓘ 泛滥。
- **未做首次运行引导（onboarding）**：评审提到但属独立改动，另议。
- **旁路发现已单独解决**：`constants.js` 等被 git 跟踪的编译产物，已由 `chore/untrack-compiled-js` 分支处理（tsconfig 加 `noEmit` + untrack + gitignore）。

---

## 7. 审核修订（Cursor 自动审核 · OSE 严审）

第 1 轮审核**未发现引擎/资金路径阻塞**（纯前端静态文案），但正确指出多处提示会削弱**投资诚实度**或**越界描述产品能力**。逐条已改，其中 2 条经**回源码核实**后修正：

| # | 级别 | 问题 | 处理 |
|---|------|------|------|
| 1 | High | 净 Theta「躺赚」写成确定日收益 | 改为 ceteris-paribus 理论盈亏，点明 gamma/vega 可远超 theta |
| 2 | High | 净 Delta「涨跌影响都不大」+ 跨标的当同一只 | 点明短 gamma 风险；区分单标的 vs 跨标的合计 |
| 3 | High | 数据来源断言「FMP 比电话会新一季」与 §6 反向滞后矛盾 | 改为「两源最新季不同步」，不断言方向 |
| 4 | High | Thesis「触发即离场」暗示自动平仓 | 改为手动纪律线，明示「系统不自动平仓、仅展示」 |
| 5 | Med | skew「卖方偏好 IV 高侧收权利金」诱导裸卖 crash wing | 删除，改为「仅描述定价结构，不诱导卖出」 |
| 6 | Med | F 维「利润」应为「利润率」 | **核实 `deepAnalysis.ts:8/308`：F=营收+利润率+FCF**，已改；I 维收窄为「peers 利润率差距扩大」 |
| 7 | Med | Intel「持仓相关」实际扫自选 | **核实 `routes/intel.ts` 用 `parseWatchlistSymbolsQuery`**，改为「自选 watchlist，持仓仅排序」 |
| 8 | Med | Δ≈价内概率混用 N(d1)/N(d2) | 降级为「粗略近似，严格说二者不等」 |
| — | Low | OI→价差必然收窄因果过强 | 软化为「通常越大流动性越好」 |

---

## 8. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-27 | 初版：四页补 12 处 HelpTip，覆盖 Greeks / IV skew / OCIFQ / 季度对齐 |
| 2026-07-27 | 第 1 轮审核修订：8 条文案（4 High + 4 Med + 1 Low）投资诚实度/能力边界修正；#6/#7 回源码核实 |
| 2026-07-27 | 第 2 轮审核修订：TOTAL 公式 =（O+C+I+F+Q）×2、impact 补 Monitor 四类、crossLinks 改自选、Thesis 横幅仅 FMP 领先时；OCIFQ tip 精简、doc §6 去重复 bullet |
