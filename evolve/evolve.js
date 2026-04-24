// Evolution loop: generate variants, backtest each across the universe,
// mutate top-5 into children, repeat for 3 generations.
//
// CLI:
//   node evolve/evolve.js                        # default: sfp
//   node evolve/evolve.js --strategy=sfp         # built-in by name
//   node evolve/evolve.js --strategy=path/to/my.js   # custom module
//   node evolve/evolve.js --seed=42 --bars=2000
//
'use strict';

const fs = require('fs');
const path = require('path');
const { buildUniverse } = require('./data');
const { backtest, aggregate } = require('./strategy');

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function resolveStrategy(spec) {
  if (!spec || spec === true) spec = 'sfp';
  // Built-in? Look in ./strategies/<name>.js first.
  const builtin = path.join(__dirname, 'strategies', `${spec}.js`);
  if (fs.existsSync(builtin)) return require(builtin);
  // Otherwise treat as a file path (absolute or relative to cwd).
  const abs = path.isAbsolute(spec) ? spec : path.resolve(process.cwd(), spec);
  if (fs.existsSync(abs)) return require(abs);
  throw new Error(`Strategy not found: ${spec} (tried ${builtin} and ${abs})`);
}

// ---------- PRNG + helpers ----------
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

function makeHelpers(seed) {
  const rng = mulberry32(seed);
  const rand = () => rng();
  return {
    rand,
    randInt:   (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1)),
    randFloat: (lo, hi) => lo + rand() * (hi - lo),
    clamp:     (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    round:     (v, p) => Math.round(v / p) * p,
  };
}

// ---------- Generic random/mutate fallbacks (used if strategy doesn't override) ----------
function genericClamp(strategy, h, c) {
  for (const [k, [lo, hi]] of Object.entries(strategy.RANGES)) {
    const isInt = Number.isInteger(lo) && Number.isInteger(hi);
    c[k] = h.clamp(isInt ? Math.round(c[k]) : c[k], lo, hi);
  }
  return c;
}

function genericRandomConfig(strategy, h, name) {
  const c = { name };
  for (const [k, [lo, hi]] of Object.entries(strategy.RANGES)) {
    const isInt = Number.isInteger(lo) && Number.isInteger(hi);
    c[k] = isInt ? h.randInt(lo, hi) : h.randFloat(lo, hi);
  }
  for (const f of strategy.FILTERS) c[f] = h.rand() < 0.35;
  return c;
}

function genericMutate(strategy, h, parent, childName) {
  const c = { ...parent, name: childName };
  for (const [k, [lo, hi]] of Object.entries(strategy.RANGES)) {
    c[k] = c[k] + (h.rand() * 2 - 1) * (hi - lo) * 0.15;
  }
  const swap = strategy.FILTERS[Math.floor(h.rand() * strategy.FILTERS.length)];
  c[swap] = !c[swap];
  return genericClamp(strategy, h, c);
}

// ---------- Fitness (strategy-agnostic) ----------
function fitness(run) {
  const { agg } = run;
  const ddFloor = Math.max(agg.worstDrawdown, 0.05);
  const raw = agg.netPnl / ddFloor;
  const tradePenalty = agg.totalTrades < 30 ? 0.3 + agg.totalTrades / 50 : 1.0;
  return raw * Math.min(tradePenalty, 1.0);
}

// ---------- Formatting ----------
function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
function fmtNum(x, p = 2) { return Number.isFinite(x) ? x.toFixed(p) : '—'; }
function fmtPf(x)  { return !Number.isFinite(x) ? '∞' : x.toFixed(2); }
function fmtDollar(x) { return (x >= 0 ? '$' : '-$') + Math.abs(x).toFixed(0); }

function fmtCell(v, fmt) {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  switch (fmt) {
    case 'int': return String(Math.round(v));
    case 'f1':  return fmtNum(v, 1);
    case 'f2':  return fmtNum(v, 2);
    case 'f3':  return fmtNum(v, 3);
    case 'pct': return fmtPct(v);
    case 'bool': return v ? 'on' : 'off';
    default:    return typeof v === 'number' ? fmtNum(v, 2) : String(v);
  }
}

function activeFilters(strategy, cfg) {
  const labels = strategy.FILTER_LABELS || {};
  const active = strategy.FILTERS.filter(f => cfg[f]).map(f => labels[f] || f.replace('_filter', ''));
  return active.length ? active.join('+') : 'none';
}

function rowForRun(strategy, rank, run) {
  const c = run.cfg, a = run.agg;
  const extras = (strategy.LEADERBOARD_COLUMNS || []).map(col => fmtCell(c[col.key], col.fmt));
  const base = [
    rank, c.name, fmtDollar(a.netPnl), fmtPct(a.returnPct / 100),
    fmtPf(a.profitFactorW), fmtPct(a.winRate), fmtPct(a.worstDrawdown),
    a.totalTrades, `${a.assetsPositive}/${a.assetsTotal}`,
  ];
  return `| ${[...base, ...extras, activeFilters(strategy, c), fmtNum(fitness(run), 0)].join(' | ')} |`;
}

function leaderboardTable(strategy, runs) {
  const extraLabels = (strategy.LEADERBOARD_COLUMNS || []).map(c => c.label);
  const headerCols = [
    'Rank', 'Config', 'Net P&L', 'Return', 'PF', 'WinRate', 'MaxDD', 'Trades', 'WinAssets',
    ...extraLabels, 'Filters', 'Fitness',
  ];
  const sep = headerCols.map(h => '-'.repeat(Math.max(3, h.length)));
  const sorted = [...runs].sort((a, b) => fitness(b) - fitness(a));
  return [
    `| ${headerCols.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...sorted.map((r, i) => rowForRun(strategy, i + 1, r)),
  ].join('\n');
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

// ---------- Running ----------
function runConfigOnUniverse(universe, cfg, strategy) {
  const perAsset = universe.map(u => ({
    symbol: u.symbol,
    result: backtest(u.bars, cfg, strategy),
  }));
  return { cfg, perAsset, agg: aggregate(perAsset) };
}

function topN(runs, n) {
  return [...runs].sort((a, b) => fitness(b) - fitness(a)).slice(0, n);
}

// ---------- Main ----------
function evolve(options = {}) {
  const strategy = options.strategy || resolveStrategy('sfp');
  const seed   = options.seed   || 20260424;
  const nBars  = options.nBars  || 1500;
  const outDir = options.outDir || path.join(__dirname, '..');

  // Strategy must provide random/mutate OR we use generic defaults.
  const randomConfig = strategy.randomConfig
    ? (h, name) => strategy.randomConfig(h, name)
    : (h, name) => genericRandomConfig(strategy, h, name);
  const mutate = strategy.mutate
    ? (h, p, name) => strategy.mutate(h, p, name)
    : (h, p, name) => genericMutate(strategy, h, p, name);

  const h = makeHelpers(seed);
  const universe = buildUniverse(nBars);
  console.log(`[evolve] Strategy: ${strategy.name}`);
  console.log(`[evolve] Built universe: ${universe.length} assets × ${nBars} bars`);

  console.log('[evolve] Running baseline...');
  const baselineRun = runConfigOnUniverse(universe, strategy.BASELINE, strategy);

  console.log('[evolve] Generating 20 Gen-1 variants...');
  const gen1Configs = [];
  for (let i = 0; i < 20; i++) gen1Configs.push(randomConfig(h, `G1-V${i + 1}`));
  const gen1Runs = gen1Configs.map((cfg, i) => {
    process.stdout.write(`\r[evolve]   G1 ${i + 1}/20    `);
    return runConfigOnUniverse(universe, cfg, strategy);
  });
  process.stdout.write('\n');

  console.log('[evolve] Generating 15 Gen-2 children...');
  const gen1Top5 = topN(gen1Runs, 5);
  const gen2Configs = [];
  gen1Top5.forEach((p, pIdx) => {
    for (let k = 0; k < 3; k++) gen2Configs.push(mutate(h, p.cfg, `G2-P${pIdx + 1}C${k + 1}`));
  });
  const gen2Runs = gen2Configs.map((cfg, i) => {
    process.stdout.write(`\r[evolve]   G2 ${i + 1}/15    `);
    return runConfigOnUniverse(universe, cfg, strategy);
  });
  process.stdout.write('\n');

  console.log('[evolve] Generating 15 Gen-3 children...');
  const combinedTop5 = topN([...gen1Runs, ...gen2Runs], 5);
  const gen3Configs = [];
  combinedTop5.forEach((p, pIdx) => {
    for (let k = 0; k < 3; k++) gen3Configs.push(mutate(h, p.cfg, `G3-P${pIdx + 1}C${k + 1}`));
  });
  const gen3Runs = gen3Configs.map((cfg, i) => {
    process.stdout.write(`\r[evolve]   G3 ${i + 1}/15    `);
    return runConfigOnUniverse(universe, cfg, strategy);
  });
  process.stdout.write('\n');

  const allRuns = [baselineRun, ...gen1Runs, ...gen2Runs, ...gen3Runs];
  const champion = topN(allRuns.filter(r => r.cfg.name !== 'baseline'), 1)[0];

  // leaderboard.md
  const lbLines = [];
  lbLines.push(`# Evolution Leaderboard`);
  lbLines.push('');
  lbLines.push(`**Strategy:** ${strategy.name} · **Seed:** ${seed} · **Universe:** ${universe.length} assets × ${nBars} bars · **Capital:** $1000 / asset · **Risk:** 1% per trade`);
  lbLines.push('');
  lbLines.push(`**Fitness** = netPnL ÷ max(worst-DD, 5%), with a soft penalty when totalTrades < 30.`);
  lbLines.push('');

  lbLines.push('## Baseline');
  lbLines.push('');
  lbLines.push(leaderboardTable(strategy, [baselineRun]));
  lbLines.push('');

  lbLines.push('## Generation 1 — 20 random variants (ranked)');
  lbLines.push('');
  lbLines.push(leaderboardTable(strategy, gen1Runs));
  lbLines.push('');

  lbLines.push('## Generation 2 — 15 children of Gen-1 top-5 (ranked)');
  lbLines.push('');
  lbLines.push(leaderboardTable(strategy, gen2Runs));
  lbLines.push('');

  lbLines.push('## Generation 3 — 15 children of combined Gen-1+2 top-5 (ranked)');
  lbLines.push('');
  lbLines.push(leaderboardTable(strategy, gen3Runs));
  lbLines.push('');

  lbLines.push('## Overall top 10 (all variants)');
  lbLines.push('');
  lbLines.push(leaderboardTable(strategy, topN(allRuns, 10)));
  lbLines.push('');

  lbLines.push(`## Champion per-asset breakdown — **${champion.cfg.name}**`);
  lbLines.push('');
  lbLines.push(perAssetTable(champion));
  lbLines.push('');

  fs.writeFileSync(path.join(outDir, 'leaderboard.md'), lbLines.join('\n'));
  console.log('[evolve] Wrote leaderboard.md');

  const jsonDump = {
    strategy: strategy.name,
    seed, nBars,
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

  return { strategy, baselineRun, gen1Runs, gen2Runs, gen3Runs, champion };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const strategy = resolveStrategy(args.strategy);
  evolve({
    strategy,
    seed:  args.seed  ? Number(args.seed)  : undefined,
    nBars: args.bars  ? Number(args.bars)  : undefined,
    outDir: args.out,
  });
}

module.exports = { evolve, runConfigOnUniverse, resolveStrategy, fitness };
