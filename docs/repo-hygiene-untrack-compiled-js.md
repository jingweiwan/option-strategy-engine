# 仓库卫生 — 停止跟踪编译产物 .js

> 日期：2026-07-27
> 分支：`chore/untrack-compiled-js`（从 `main` 切出）
> 类型：仓库卫生 · 构建配置 · 无运行时/逻辑改动

---

## 1. 问题

`client/` 是 Vue 3 + TypeScript 项目，源码只有 `.ts` / `.vue`，真正的打包由 Vite/esbuild 完成。但有 **5 个从 `.ts` 编译出来的 `.js` 产物被误提交进了版本库**：

```
client/src/composables/useDeepAnalysisStore.js
client/src/composables/useEtMarketClock.js
client/src/composables/usePositions.js
client/src/composables/useThesisDrift.js
client/src/utils/constants.js
client/tsconfig.tsbuildinfo      # TS 增量构建缓存，同样不该跟踪
```

**危害**：这些是构建产物，与 `.ts` 源不同步会误导 review。实证——`constants.js` 曾缺失 `SCAN_SIMULATIONS`（更早的 PR 改了 `constants.ts` 却没重新生成被跟踪的 `.js`）。每次 `npm run build` 还会在 `client/src` 里吐出 ~25 个 stray `.js`，污染 `git status`。

**根因**：`client/tsconfig.json` 未设 `noEmit`，`build` 脚本里的 `vue-tsc -b` 于是把 `.ts` 逐个编译落盘；而 `.gitignore` 只忽略了 `**/*.vue.js`（Volar 产物），没覆盖 `.ts`→`.js` 的产物。

---

## 2. 修复（三管齐下）

### 2.1 源头：`vue-tsc` 只做类型检查，不落盘

`client/tsconfig.json` 增加 `"noEmit": true`。Vite 走 esbuild 转译，本就不依赖 tsc 产物；`vue-tsc -b` 退化为纯 typecheck，不再吐 `.js`。

### 2.2 清理：停止跟踪已污染的产物

```bash
git rm --cached \
  client/src/composables/useDeepAnalysisStore.js \
  client/src/composables/useEtMarketClock.js \
  client/src/composables/usePositions.js \
  client/src/composables/useThesisDrift.js \
  client/src/utils/constants.js \
  client/tsconfig.tsbuildinfo
```

（`--cached` 只从索引移除，磁盘文件保留；磁盘上的 stray 产物由 gitignore 兜底、随时可删。）

### 2.3 兜底：`.gitignore` 补规则

```gitignore
# TS→JS compiled output emitted next to sources — Vite/esbuild does the real build,
# so any .js under client/src is a stray artifact, never a source file.
client/src/**/*.js

# TypeScript incremental build cache
*.tsbuildinfo
```

---

## 3. 为什么安全

- `client/src` 内**所有** `.js` 都有对应 `.ts` 兄弟（逐一核对），无手写 `.js` 源——`client/src/**/*.js` 不会误伤源码。
- import 均用无扩展名路径（`@/utils/constants`），Vite 解析到 `.ts`/`.vue`，从不依赖 `.js` 产物。
- `noEmit` 只影响 `vue-tsc`，不影响 Vite 打包（Vite 用 esbuild/rollup）。
- 根目录的 `.js` 配置文件（若有）在 `client/src` 之外，不受规则影响。

---

## 4. 验证

```bash
cd client && npm run build     # vue-tsc -b && vite build
```

- ✅ `BUILD_EXIT=0`，`vue-tsc -b` 类型检查通过，644 模块编译，产出 `dist/`
- ✅ **构建后 `client/src` 下 `.js` 数 = 0**（改前每次 build 落盘 ~25 个）——证明 `noEmit` 生效
- ✅ `tsconfig.tsbuildinfo` 仍会写盘（build 模式特性），但已被 gitignore，`git status` 不再出现

---

## 5. 改动文件

```
 .gitignore                                          (+ 2 条规则)
 client/tsconfig.json                                (+ "noEmit": true)
 client/src/composables/useDeepAnalysisStore.js      (untrack)
 client/src/composables/useEtMarketClock.js          (untrack)
 client/src/composables/usePositions.js              (untrack)
 client/src/composables/useThesisDrift.js            (untrack)
 client/src/utils/constants.js                       (untrack)
 client/tsconfig.tsbuildinfo                          (untrack)
```

---

## 6. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-27 | 初版：noEmit + untrack 6 产物 + gitignore 兜底 |
