// Evolution loop: generate variants, backtest each across the universe,
// mutate top-5 into children, repeat for 3 generations.
'use strict';

const fs = require('fs');
const path = require('path');
const { buildUniverse } = require('./data');
const { backtest, aggregate } = require('./strategy');

// ---------- Deterministic PRNG for mutation / sampling ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260424);
const rand = () => rng();
const randInt = (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1));
const randFloat = (lo, hi) => lo + rand() * (hi - lo);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, p) => Math.round(v / p) * p;

// ---------- Parameter space ----------
const BASELINE = {
  name: 'baseline',
  swing_lookback: 10,
  wick_threshold_atr: 0.30,
  rr_ratio: 2.0,
  stop_atr_mult: 1.5,
  confirmation_bars: 0,
  trend_filter: false,
  rsi_filter: false,
  volume_filter: false,
  volume_mult: 1.3,
};

const RANGES = {
  swing_lookback:     [5, 30],
  wick_threshold_atr: [0.0, 1.5],
  rr_ratio:           [1.0, 4.0],
  stop_atr_mult:      [0.5, 3.0],
  confirmation_bars:  [0, 3],
};

const FILTERS = ['trend_filter', 'rsi_filter', 'volume_filter'];

function clampCfg(c) {
  c.swing_lookback     = clamp(Math.round(c.swing_lookback),     RANGES.swing_lookback[0],     RANGES.swing_lookback[1]);
  c.wick_threshold_atr = round(clamp(c.wick_threshold_atr,       RANGES.wick_threshold_atr[0], RANGES.wick_threshold_atr[1]), 0.05);
  c.rr_ratio           = round(clamp(c.rr_ratio,                 RANGES.rr_ratio[0],           RANGES.rr_ratio[1]), 0.1);
  c.stop_atr_mult      = round(clamp(c.stop_atr_mult,            RANGES.stop_atr_mult[0],      RANGES.stop_atr_mult[1]), 0.1);
  c.confirmation_bars  = clamp(Math.round(c.confirmation_bars),  RANGES.confirmation_bars[0],  RANGES.confirmation_bars[1]);
  return c;
}

function randomConfig(name) {
  return clampCfg({
    name,
    swing_lookback:     randInt(RANGES.swing_lookback[0],     RANGES.swing_lookback[1]),
    wick_threshold_atr: randFloat(RANGES.wick_threshold_atr[0], RANGES.wick_threshold_atr[1]),
    rr_ratio:           randFloat(RANGES.rr_ratio[0],           RANGES.rr_ratio[1]),
    stop_atr_mult:      randFloat(RANGES.stop_atr_mult[0],      RANGES.stop_atr_mult[1]),
    confirmation_bars:  randInt(RANGES.confirmation_bars[0],    RANGES.confirmation_bars[1]),
    trend_filter:       rand() < 0.35,
    rsi_filter:         rand() < 0.35,
    volume_filter:      rand() < 0.35,
    volume_mult:        round(randFloat(1.1, 1.8), 0.1),
  });
}

function mutate(parent, childName) {
  // Small perturbation on each numeric param (~15% of range),
  // then swap exactly one filter (on->off or off->on, at random).
  const c = { ...parent, name: childName };
  const perturb = (v, [lo, hi], frac = 0.15) => v + (rand() * 2 - 1) * (hi - lo) * frac;

  c.swing_lookback     = perturb(c.swing_lookback,     RANGES.swing_lookback);
  c.wick_threshold_atr = perturb(c.wick_threshold_atr, RANGES.wick_threshold_atr);
  c.rr_ratio           = perturb(c.rr_ratio,           RANGES.rr_ratio);
  c.stop_atr_mult      = perturb(c.stop_atr_mult,      RANGES.stop_atr_mult);
  if (rand() < 0.4) c.confirmation_bars = perturb(c.confirmation_bars, RANGES.confirmation_bars);

  // One filter swap (toggle exactly one filter)
  const swap = FILTERS[Math.floor(rand() * FILTERS.length)];
  c[swap] = !c[swap];
  c.volume_mult = round(clamp(c.volume_mult + (rand() * 2 - 1) * 0.2, 1.1, 1.8), 0.1);
  return clampCfg(c);
}

// ---------- Running backtests ----------
function runConfigOnUniverse(universe, cfg) {
  const perAsset = universe.map(u => ({
    symbol: u.symbol,
    result: backtest(u.bars, cfg),
  }));
  const agg = aggregate(perAsset);
  return { cfg, perAsset, agg };
}

// Fitness = net pnl / max(worst DD, 5%) with soft penalty for tiny trade counts.
function fitness(run) {
  const { agg } = run;
  const ddFloor = Math.max(agg.worstDrawdown, 0.05);
  const raw = agg.netPnl / ddFloor;
  const tradePenalty = agg.totalTrades < 30 ? 0.3 + agg.totalTrades / 50 : 1.0;
  return raw * Math.min(tradePenalty, 1.0);
}

// ---------- Leaderboard formatting ----------
function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
function fmtNum(x, p = 2) { return Number.isFinite(x) ? x.toFixed(p) : '—'; }
function fmtPf(x)  { return !Number.isFinite(x) ? '∞' : x.toFixed(2); }
function fmtDollar(x) { return (x >= 0 ? '$' : '-$') + Math.abs(x).toFixed(0); }

function rowForRun(rank, run) {
  const c = run.cfg, a = run.agg;
  const filters = [
    c.trend_filter ? 'trend' : null,
    c.rsi_filter ? 'rsi' : null,
    c.volume_filter ? 'vol' : null,
  ].filter(Boolean).join('+') || 'none';

  return `| ${rank} | ${c.name} | ${fmtDollar(a.netPnl)} | ${fmtPct(a.returnPct / 100)} | ${fmtPf(a.profitFactorW)} | ${fmtPct(a.winRate)} | ${fmtPct(a.worstDrawdown)} | ${a.totalTrades} | ${a.assetsPositive}/${a.assetsTotal} | ${c.swing_lookback} | ${fmtNum(c.wick_threshold_atr)} | ${fmtNum(c.rr_ratio, 1)} | ${fmtNum(c.stop_atr_mult, 1)} | ${c.confirmation_bars} | ${filters} | ${fmtNum(fitness(run), 0)} |`;
}

function leaderboardTable(runs) {
  const header = `| Rank | Config | Net P&L | Return | PF | WinRate | MaxDD | Trades | WinAssets | Lkbk | Wick | RR | StopATR | Conf | Filters | Fitness |\n| ---- | ------ | ------- | ------ | -- | ------- | ----- | ------ | --------- | ---- | ---- | -- | ------- | ---- | ------- | ------- |`;
  const sorted = [...runs].sort((a, b) => fitness(b) - fitness(a));
  const rows = sorted.map((r, i) => rowForRun(i + 1, r));
  return [header, ...rows].join('\n');
}

function perAssetTable(run) {
  const lines = [
    `| Asset | Trades | Win% | PF | Net P&L | Return | MaxDD |`,
    `| ----- | ------ | ---- | -- | ------- | ------ | ----- |`,
  ];
  for (const a of run.perAsset) {
    const r = a.result;
    lines.push(
      `| ${a.symbol} | ${r.trades} | ${fmtPct(r.winRate)} | ${fmtPf(r.profitFactor)} | ${fmtDollar(r.netPnl)} | ${fmtPct(r.returnPct / 100)} | ${fmtPct(r.maxDrawdown)} |`
    );
  }
  return lines.join('\n');
}

// ---------- Main evolution ----------
function topN(runs, n) {
  return [...runs].sort((a, b) => fitness(b) - fitness(a)).slice(0, n);
}

function evolve() {
  const N_BARS = 1500;
  const universe = buildUniverse(N_BARS);
  console.log(`[evolve] Built universe: ${universe.length} assets × ${N_BARS} bars`);

  // Baseline run (for reference)
  console.log('[evolve] Running baseline...');
  const baselineRun = runConfigOnUniverse(universe, BASELINE);

  // ----- Generation 1: baseline + 20 random variants -----
  console.log('[evolve] Generating 20 Gen-1 variants...');
  const gen1Configs = [];
  for (let i = 0; i < 20; i++) gen1Configs.push(randomConfig(`G1-V${i + 1}`));
  const gen1Runs = gen1Configs.map((cfg, i) => {
    process.stdout.write(`\r[evolve]   G1 ${i + 1}/20    `);
    return runConfigOnUniverse(universe, cfg);
  });
  process.stdout.write('\n');

  // ----- Generation 2: top 5 of Gen 1 → 3 children each -----
  console.log('[evolve] Generating 15 Gen-2 children...');
  const gen1Top5 = topN(gen1Runs, 5);
  const gen2Configs = [];
  gen1Top5.forEach((p, pIdx) => {
    for (let k = 0; k < 3; k++) gen2Configs.push(mutate(p.cfg, `G2-P${pIdx + 1}C${k + 1}`));
  });
  const gen2Runs = gen2Configs.map((cfg, i) => {
    process.stdout.write(`\r[evolve]   G2 ${i + 1}/15    `);
    return runConfigOnUniverse(universe, cfg);
  });
  process.stdout.write('\n');

  // ----- Generation 3: top 5 of combined Gen 1+2 → 3 children each -----
  console.log('[evolve] Generating 15 Gen-3 children...');
  const combinedTop5 = topN([...gen1Runs, ...gen2Runs], 5);
  const gen3Configs = [];
  combinedTop5.forEach((p, pIdx) => {
    for (let k = 0; k < 3; k++) gen3Configs.push(mutate(p.cfg, `G3-P${pIdx + 1}C${k + 1}`));
  });
  const gen3Runs = gen3Configs.map((cfg, i) => {
    process.stdout.write(`\r[evolve]   G3 ${i + 1}/15    `);
    return runConfigOnUniverse(universe, cfg);
  });
  process.stdout.write('\n');

  const allRuns = [baselineRun, ...gen1Runs, ...gen2Runs, ...gen3Runs];
  const champion = topN(allRuns.filter(r => r.cfg.name !== 'baseline'), 1)[0];

  // ---------- Write leaderboard.md ----------
  const lbLines = [];
  lbLines.push(`# Evolution Leaderboard`);
  lbLines.push('');
  lbLines.push(`Deterministic backtest: 10 assets × ${N_BARS} bars, \$1000 per asset, 1% risk per trade.`);
  lbLines.push('');
  lbLines.push(`**Fitness** = netPnL ÷ max(worst-DD, 5%), with a soft penalty when totalTrades < 30.`);
  lbLines.push('');

  lbLines.push(`## Baseline`);
  lbLines.push('');
  lbLines.push(leaderboardTable([baselineRun]));
  lbLines.push('');

  lbLines.push(`## Generation 1 — 20 random variants (ranked)`);
  lbLines.push('');
  lbLines.push(leaderboardTable(gen1Runs));
  lbLines.push('');

  lbLines.push(`## Generation 2 — 15 children of Gen-1 top-5 (ranked)`);
  lbLines.push('');
  lbLines.push(leaderboardTable(gen2Runs));
  lbLines.push('');

  lbLines.push(`## Generation 3 — 15 children of combined Gen-1+2 top-5 (ranked)`);
  lbLines.push('');
  lbLines.push(leaderboardTable(gen3Runs));
  lbLines.push('');

  lbLines.push(`## Overall top 10 (all variants)`);
  lbLines.push('');
  const overallTop = topN(allRuns, 10);
  lbLines.push(leaderboardTable(overallTop));
  lbLines.push('');

  lbLines.push(`## Champion per-asset breakdown — **${champion.cfg.name}**`);
  lbLines.push('');
  lbLines.push(perAssetTable(champion));
  lbLines.push('');

  fs.writeFileSync(path.join(__dirname, '..', 'leaderboard.md'), lbLines.join('\n'));
  console.log('[evolve] Wrote leaderboard.md');

  // ---------- Save raw JSON for analysis ----------
  const jsonDump = {
    seed: 20260424,
    nBars: N_BARS,
    baseline: { cfg: baselineRun.cfg, agg: baselineRun.agg, perAsset: baselineRun.perAsset },
    gen1: gen1Runs.map(r => ({ cfg: r.cfg, agg: r.agg })),
    gen2: gen2Runs.map(r => ({ cfg: r.cfg, agg: r.agg })),
    gen3: gen3Runs.map(r => ({ cfg: r.cfg, agg: r.agg })),
    champion: { cfg: champion.cfg, agg: champion.agg, perAsset: champion.perAsset },
  };
  fs.writeFileSync(
    path.join(__dirname, 'results', 'run.json'),
    JSON.stringify(jsonDump, null, 2),
  );
  console.log('[evolve] Wrote evolve/results/run.json');

  return { baselineRun, gen1Runs, gen2Runs, gen3Runs, champion };
}

if (require.main === module) evolve();

module.exports = { evolve, runConfigOnUniverse, BASELINE, fitness };
