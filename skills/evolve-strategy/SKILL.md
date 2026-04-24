---
name: evolve-strategy
description: Autonomous multi-generation evolutionary search over a trading strategy's parameters and signal filters. Generates random variants, backtests each across a 10-asset universe, mutates the top performers into children across 3 generations, and writes leaderboard.md + FINAL_REPORT.md. Use when the user asks to "evolve", "optimize", "tune", "sweep parameters", or "find best config" for a strategy.
---

# Strategy Evolution Loop

You are running an autonomous 3-generation evolutionary search over a trading
strategy. The scaffolding already exists in `evolve/` — do NOT rebuild it.
The baseline strategy is SFP (Swing Failure Pattern) but the loop generalises
to any rule-based strategy with numeric parameters and on/off filters.

## When to invoke

Trigger this skill when the user asks to:
- "Evolve / optimize / tune / sweep" a strategy
- "Find the best parameters" for a strategy
- "Run an evolution loop / genetic search"
- Iterate over a strategy across multiple assets with a leaderboard

Do NOT invoke for: single-config backtests (use `strategy-report` instead),
Pine Script authoring (use `pine-develop`), or chart inspection.

## Entry point

```bash
node evolve/evolve.js                              # default: SFP + synthetic
node evolve/evolve.js --strategy=sfp               # same, explicit
node evolve/evolve.js --strategy=template          # bundled Donchian example
node evolve/evolve.js --strategy=path/to/my.js     # user-supplied module
node evolve/evolve.js --seed=42 --bars=3000        # synthetic only

# Live mode — pulls real OHLCV from the running TradingView Desktop via CDP.
node evolve/evolve.js --data=live                  # defaults: 10 symbols, tf=D, 500 bars
node evolve/evolve.js --data=live --tf=60 --bars=500 \
                      --symbols=BTCUSD,ETHUSD,AAPL
node evolve/evolve.js --data=live --no-cache       # force a fresh pull
```

Writes:
- `leaderboard.md` (repo root) — all 51 configs ranked across baseline + G1/G2/G3
- `evolve/results/run.json` — raw results for post-hoc analysis
- `evolve/cache/<key>.json` — bar cache (live mode only, git-ignored)
- Console progress: `G1 1/20 ... G3 15/15`

Runtime: ~0.3s synthetic. Live mode adds ~1–3s per symbol on cold run,
instant on cache hit.

## Data sources

### `--data=synthetic` (default)

Deterministic seeded GBM with regime switching and jumps, 10 assets,
1500 bars, no calendar dates. Defined in `evolve/data.js`. Reproducible
across machines.

### `--data=live`

Real bars from TradingView Desktop via CDP on `localhost:9222`. Uses
`src/core/chart.js :: setSymbol/setTimeframe` + `src/core/data.js :: getOhlcv`
under the hood (via dynamic import — bridges from the CJS evolve module
into the ESM core).

**Prerequisites**:
1. TradingView Desktop is running with `--remote-debugging-port=9222`
   (launch via `scripts/launch_tv_debug_*.sh`).
2. A chart tab is open. Any symbol/timeframe — the loader will navigate.
3. `npm install` has been run (for the `chrome-remote-interface` dep).

**Flags**:
- `--symbols=A,B,C` — comma-separated symbols. Default: 10-asset crypto/
  futures/stocks mix. Bare symbols work (TradingView auto-resolves);
  explicit exchange prefixes (`NYMEX:CL1!`) also work.
- `--tf=<resolution>` — timeframe. Default `D`. Values: `1`, `5`, `15`,
  `60`, `240`, `D`, `W`.
- `--bars=<n>` — bars per symbol. Default 500. **Hard-capped at 500 by
  `src/core/data.js :: MAX_OHLCV_BARS`**. For longer history, use a
  smaller timeframe (`60` → 500 hourly bars ≈ 3 weeks of market hours).
- `--no-cache` — ignore the disk cache and re-pull.

**Cache**: keyed by `(timeframe, count, sorted-symbols)` at
`evolve/cache/<key>.json`. Safe to delete; git-ignored.

**Error modes** and what to do:
- `Missing dependency 'chrome-remote-interface'` → run `npm install` at
  repo root.
- `Cannot reach TradingView on localhost:9222` → start TV with the
  debug-port launcher, or check that port 9222 is free.
- `warning: <SYM> returned N/500 bars` → TV hadn't loaded enough
  history. Scroll left on that chart once in the UI, then re-run
  with `--no-cache`.

### Providing a different starting strategy

Create a module that exports the interface below (see
`evolve/strategies/template.js` for a complete working example). Point the
CLI at it with `--strategy=path/to/my.js`. Default SFP is unchanged.

**Required exports**

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Shown in leaderboard header + JSON dump |
| `BASELINE` | `{ name: 'baseline', ...cfg }` | Starting config (the "current strategy") |
| `RANGES` | `{ paramKey: [lo, hi] }` | Numeric search space |
| `FILTERS` | `string[]` | Keys of on/off filters |
| `computeContext(bars)` | `bars -> ctx` | Pre-compute indicator arrays once per asset |
| `detect(bars, i, cfg, ctx)` | `-> { side, atr, stopDist? } \| null` | Entry signal on bar `i` |
| `passFilters(bars, i, cfg, ctx, side)` | `-> bool` | Filter gate |

**Optional**

| Field | Purpose |
|---|---|
| `FILTER_LABELS` | Short labels for the `Filters` column (`{ trend_filter: 'trend' }`) |
| `LEADERBOARD_COLUMNS` | Extra columns shown per-row (`[{label, key, fmt}]`, fmt: `int\|f1\|f2\|pct\|bool`) |
| `randomConfig(helpers, name)` | Override sampling to preserve an exact RNG sequence |
| `mutate(helpers, parent, childName)` | Override mutation (default: ±15% numeric perturbation + one filter flip) |

**Signal contract**: `detect()` returns a signal object whose `side` is
`'long'` or `'short'`. If the strategy supplies `stopDist` (price distance
from entry to stop), the engine uses it. Otherwise the engine computes
`stopDist = cfg.stop_atr_mult * sig.atr`. Risk sizing is always 1% of
current equity / stopDist. Target = `cfg.rr_ratio * stopDist`.

**Ranges** with whole-number endpoints are treated as integers and
rounded on both sampling and mutation.

**Helpers** passed to `randomConfig`/`mutate` (when overridden):
`{ rand, randInt, randFloat, clamp, round }`. All share the same seeded
PRNG — don't call `Math.random()`.

## The loop (what `evolve.js` does)

1. **Baseline**: run the canonical config defined in `evolve/evolve.js :: BASELINE`.
2. **Gen 1**: 20 uniformly-random configs across the full parameter space, each
   with filters independently on/off at 35% probability.
3. **Gen 2**: take top 5 of Gen 1 by fitness, produce 3 mutated children each
   (15 total). Mutation = ±15% perturbation on each numeric param + swap
   exactly one filter.
4. **Gen 3**: top 5 of combined Gen 1+2, another 15 mutated children.
5. **Report**: write `leaderboard.md` and return champion + per-asset table.

## Tunable surface

Defined in `evolve/evolve.js :: RANGES` and `FILTERS`. Baseline SFP uses:

| Param | Baseline | Range |
|---|---|---|
| `swing_lookback` | 10 | 5–30 |
| `wick_threshold_atr` | 0.30 | 0.0–1.5 |
| `rr_ratio` | 2.0 | 1.0–4.0 |
| `stop_atr_mult` | 1.5 | 0.5–3.0 |
| `confirmation_bars` | 0 | 0–3 |

Filters: `trend_filter`, `rsi_filter`, `volume_filter` (each on/off).

Full spec in `evolve/BASELINE.md`.

## Fitness function

```
fitness = netPnL ÷ max(worst_asset_drawdown, 5%) × tradePenalty
tradePenalty = min(0.3 + totalTrades/50, 1.0)
```

Risk-adjusted PnL with a soft prior against degenerate low-trade configs.
Defined in `evolve/evolve.js :: fitness()`.

## Data source

Default: deterministic seeded OHLCV for 10 assets (BTCUSD, ETHUSD, SOLUSD,
ES1!, NQ1!, GC1!, CL1!, AAPL, TSLA, NVDA) from `evolve/data.js`.
Reproducible — same seed → same results.

To run against **live TradingView bars** via the MCP server, swap
`buildUniverse()` in `evolve/evolve.js` for a loop that pulls data over CDP:

```js
// For each symbol: chart_set_symbol → data_get_ohlcv(count: 1500) → push bars
const universe = [];
for (const sym of ASSET_SYMBOLS) {
  await tv.chart_set_symbol({ symbol: sym });
  const bars = await tv.data_get_ohlcv({ count: 1500 });
  universe.push({ symbol: sym, bars });
}
```

Everything downstream (strategy, backtest, evolve, fitness, report) is
data-source-agnostic.

## Your workflow when invoked

### Step 1 — Confirm the strategy to evolve

Default = SFP baseline (`evolve/strategies/sfp.js`, spec in
`evolve/BASELINE.md`). If the user named a different strategy:

1. Check `evolve/strategies/` — maybe it already exists.
2. Otherwise create a new module modelled on
   `evolve/strategies/template.js` and invoke with
   `--strategy=<name>` (bundled) or `--strategy=<path>` (custom).
3. **Do not modify** `evolve/strategies/sfp.js` to fit a new strategy —
   it's the default and other users rely on it.

### Step 2 — Run the evolver

```bash
node evolve/evolve.js
```

Confirm it finished by checking that `leaderboard.md` and
`evolve/results/run.json` exist and have non-zero size.

### Step 3 — Summarise results

Read `evolve/results/run.json` and report to the user:
- Baseline vs. champion headline (net PnL, PF, win rate, worst DD, trade count)
- Generation progression (best fitness per gen)
- Champion config (full JSON)
- Champion's per-asset breakdown table
- 2–4 bullets on what the evolver discovered (which params/filters moved,
  why that likely helped)

### Step 4 — Write `FINAL_REPORT.md`

Structure:
1. **Assumptions** — explicitly note if real data wasn't available
2. **Tunable surface** — params + filter definitions
3. **Fitness formula**
4. **Champion vs. baseline headline table**
5. **Generation progression**
6. **Champion configuration (JSON)**
7. **Per-asset result table**
8. **Commentary** — explain each dominant parameter change in a sentence or
   two, including a subsection on what the evolver **rejected** (filters/
   combinations that appeared in top-5 but didn't survive)
9. **Robustness caveats** — synthetic vs. real, single holdout, no costs,
   per-asset variance
10. **Next steps** — walk-forward, cost modelling, ensemble, finer mutation

Keep it evidence-driven: every claim should cite a specific metric change.

### Step 5 — Track progress with TodoWrite

Use TodoWrite with roughly these tasks (mark each complete as you go):
1. Confirm / adapt strategy
2. Run the evolver
3. Summarise champion vs baseline
4. Write FINAL_REPORT.md
5. Commit + push (only if the user asks)

## Customising the search

Per-strategy (edit the strategy module):
- `RANGES` — parameter search bounds
- `FILTERS` — list of on/off filter keys
- `randomConfig()` — sampling distribution (override the default uniform sampler)
- `mutate()` — perturbation rule (override the default ±15% + filter flip)

Global (edit `evolve/evolve.js`):
- `fitness()` — swap in Sharpe, Sortino, CAR/MDD, etc.
- Gen sizes in `evolve()` — currently 20 / 15 / 15
- CLI flags already exposed: `--seed`, `--bars`, `--strategy`, `--out`

For **convergence runs** (after exploration): reduce the mutation step to ~5%
(pass through a custom `mutate()` on the strategy) and run 2–3 more generations
seeded from the current champion's neighborhood.

## Rules

- **Don't regenerate the universe between generations** — same seed, same
  bars, so mutation deltas are measured against fixed data.
- **Don't stop and ask** when running autonomously — make reasonable
  assumptions and document them in `FINAL_REPORT.md` section 1.
- **Don't claim statistical significance** from a single run. 51 configs on
  one holdout is exploration, not validation. Always include the robustness
  caveats section.
- **Don't commit** unless the user asks. Write the files, summarise, stop.
- **Do preserve determinism**: if you change the seed (`mulberry32(20260424)`),
  document it in the report.
