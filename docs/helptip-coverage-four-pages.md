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
| 波动率倾斜标题「每个 strike 的 IV」 | IV skew | 负偏 = 市场为下跌买保险；曲线越陡尾部越贵；卖方偏好在 IV 高的一侧收权利金 |
| 期权链副标题 | Δ / IV / OI / 买卖价 | 一次性解释表头所有缩写 + ATM 高亮行含义 |

### 3.2 `client/src/views/Positions.vue`（3 处）

| 位置 | 术语 | 提示要点 |
|------|------|----------|
| 净 Delta | 组合方向敞口 | 换算等效股数；+100 ≈ 持 100 股；接近 0 = 中性 |
| 净 Theta | 时间价值日流 | 正 = 每天躺赚（卖方常见）；负 = 被时间侵蚀 |
| 净 Vega | IV 敞口 | IV 每变 1% 的盈亏；卖方组合常为负 Vega，靠 IV 回落获利 |

### 3.3 `client/src/views/Intel.vue`（3 处）

| 位置 | 概念 | 提示要点 |
|------|------|----------|
| 情报流 | AI 新闻/文件扫描 | 按对论点的影响分级；色条 = 利好/利空/中性；可跳 OCIFQ |
| 跨公司联动 | 传导关系 | from→to 方向 + strength 强度；发现单看个股会漏的连锁风险 |
| 扫描统计 | 覆盖面/新鲜度 | 数量偏低或生成时间过旧时结论要打折 |

### 3.4 `client/src/views/DeepAnalysis.vue`（4 处）

| 位置 | 概念 | 提示要点 |
|------|------|----------|
| **五维详解** | **OCIFQ 全称** | O 寡头定价权 · C 长周期催化 · I 行业利润断层 · F 财务三爆 · Q 连续季报验证；合计为 TOTAL（**全站最不透明的术语，最高价值提示**）|
| Thesis Tracker | 论点追踪/证伪 | delta = 本季变化；证伪条件 = 预写死的卖出信号，触发即离场；季度标签含义 |
| 数据来源 | 季度对齐 | ⚠ FMP 最新季 ≠ 电话会最新季时，分部数据可能滞后，跨季指标以标注季为准（呼应 `fix/ocifq-quarter-alignment`）|
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
- **旁路发现（不在本 PR 处理）**：`client/src/utils/constants.js` 是被 git 跟踪的**编译产物**，且与 `constants.ts` 不同步（缺 `SCAN_SIMULATIONS`，由更早的 PR 改了 `.ts` 未重新生成 `.js` 所致）。本次构建曾顺手同步它，但为保持 PR 聚焦已还原。建议单独跟进：要么把编译产物移出 `src/`+ 加 gitignore，要么补一次同步提交。

---

## 7. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-27 | 初版：四页补 12 处 HelpTip，覆盖 Greeks / IV skew / OCIFQ / 季度对齐 |
