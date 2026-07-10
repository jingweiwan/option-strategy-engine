# Engine tests

A safety net for the quant core (`src/engine/**`). You don't need to understand
the math to maintain it — these tests turn "is the algorithm still correct?"
into "did a number change that I didn't mean to change?".

## Running

```bash
# Node 20 required (default node may be too old for tsx/tsc)
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20

npm test                  # run everything
npm run test:update-golden  # accept new golden outputs (see below)
npm run check             # typecheck + tests in one shot — run before shipping
```

## The two layers

### 1. Golden tests (`engine.golden.test.ts`)

Lock the engine's full output for fixed inputs. The simulator is seeded and the
clock is pinned, so identical inputs **must** produce identical outputs. The
expected values live as readable JSON in `__golden__/`.

When a golden test fails it means an engine number moved. Two cases:

- **You didn't expect it** → you introduced a silent regression. Investigate.
- **You changed scoring / sigma / slippage / earnings on purpose** → run
  `npm run test:update-golden`, then **read the diff in `__golden__/*.json`**
  and confirm the numbers moved the way you intended before committing.

You don't need to know why `1.83` is "right" — only that it shouldn't change
unless you meant it to.

### 2. Invariant tests (`engine.invariants.test.ts`, `simulator.test.ts`)

Assert common-sense properties that must hold no matter how the math evolves —
checkable with zero quant background. Examples:

- probability of profit ∈ [0, 1]
- credit strategies collect a credit (`netPremium > 0`); debit strategies pay one
- `maxProfit ≥ maxLoss`; a finite max loss is ≤ 0
- a long straddle's max loss equals exactly the debit paid
- a naked short strangle is flagged as unbounded loss
- Monte Carlo paths are positive, deterministic per seed, and risk-neutral on average
- the earnings jump widens the distribution **without** biasing the mean

## Fixtures

`fixtures.ts` builds a synthetic option chain priced with the same Black–Scholes
the engine uses, so tests are fully offline (no API, no network) and reproducible.

## What is NOT covered here (by design)

The scanner orchestration (`oppScanner.ts`), dashboard route, AI copywriting,
and the feedback store — those are the parts you *can* reason about as a web
dev, and they touch network/LLM/disk. This suite deliberately targets only the
deterministic engine core.

## When you adopt git

Once `git init` is done, block pushes on a failing suite:

```bash
# .git/hooks/pre-push  (chmod +x)
#!/bin/sh
cd "$(git rev-parse --show-toplevel)/server" || exit 0
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null
npm run check || { echo "❌ engine tests/typecheck failed — push aborted"; exit 1; }
```
