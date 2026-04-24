// Live OHLCV loader — pulls bars over CDP from TradingView Desktop.
//
// Requires TradingView running with --remote-debugging-port=9222
// (use scripts/launch_tv_debug_*.sh). Bridges from this CJS module into the
// ESM core modules in ../src via dynamic import().
//
// Constraints:
//   - getOhlcv caps at 500 bars per call (MAX_OHLCV_BARS in src/core/data.js).
//     For longer history, use a smaller timeframe (60 → 500h ≈ 3 weeks of
//     market hours) or extend this loader with chart_scroll_to_date + merge.
//   - setSymbol/setTimeframe each wait for chart-ready (~0.5–2s each).
//     10 symbols ≈ 10–30 s cold, instant after first run thanks to disk cache.
//   - Results are cached on disk keyed by (timeframe, count, symbols).
//     Pass `noCache: true` (or `--no-cache`) to force a fresh pull.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LIVE_SYMBOLS = [
  'BTCUSD', 'ETHUSD', 'SOLUSD',
  'ES1!', 'NQ1!', 'GC1!', 'CL1!',
  'AAPL', 'TSLA', 'NVDA',
];

const CACHE_DIR = path.join(__dirname, 'cache');

function cacheKey({ symbols, timeframe, count }) {
  const sig = `${timeframe}_${count}_${[...symbols].sort().join(',')}`;
  return sig.replace(/[^a-zA-Z0-9._,-]/g, '_');
}

function readCache(key) {
  const f = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key, universe) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(universe));
}

async function fetchUniverse({ symbols, timeframe, count }) {
  // Dynamic import — the core modules are ESM, this package is CJS.
  let chart, data, connection;
  try {
    chart      = await import('../src/core/chart.js');
    data       = await import('../src/core/data.js');
    connection = await import('../src/connection.js');
  } catch (err) {
    if (/Cannot find package 'chrome-remote-interface'/.test(err.message)) {
      throw new Error(
        `Missing dependency 'chrome-remote-interface'. Run 'npm install' at the ` +
        `repo root first, then retry.`
      );
    }
    throw err;
  }

  // Fail fast if CDP isn't reachable.
  try {
    await connection.getClient();
  } catch (err) {
    throw new Error(
      `Cannot reach TradingView on localhost:9222. Start it with ` +
      `scripts/launch_tv_debug_*.sh and open a chart first. ` +
      `Original error: ${err.message}`
    );
  }

  if (timeframe) {
    console.log(`[live] Setting timeframe ${timeframe}...`);
    await chart.setTimeframe({ timeframe });
  }

  const universe = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    process.stdout.write(`\r[live]   ${i + 1}/${symbols.length} ${sym.padEnd(20)}`);
    await chart.setSymbol({ symbol: sym });
    const res = await data.getOhlcv({ count });
    const raw = res.bars || [];
    if (raw.length === 0) {
      console.warn(`\n[live]   ${sym}: no bars returned, skipping`);
      continue;
    }
    // Normalise to the evolve bar shape: { t (integer index), open, high, low, close, volume }.
    // Preserve `time` (unix seconds from TradingView) for reporting.
    const bars = raw.map((b, idx) => ({
      t: idx,
      time: b.time,
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume || 0,
    }));
    universe.push({ symbol: sym, bars, profile: null, source: 'live' });
  }
  process.stdout.write('\n');

  try { await connection.disconnect(); } catch {}
  return universe;
}

async function loadLiveUniverse(opts = {}) {
  const symbols   = opts.symbols   || DEFAULT_LIVE_SYMBOLS;
  const timeframe = opts.timeframe || 'D';
  const count     = Math.min(opts.count || 500, 500);
  const noCache   = !!opts.noCache;

  const key = cacheKey({ symbols, timeframe, count });

  if (!noCache) {
    const cached = readCache(key);
    if (cached) {
      console.log(`[live] Using cached universe (${cached.length} assets) → ${CACHE_DIR}/${key}.json`);
      console.log(`[live] Pass --no-cache to force a fresh pull.`);
      return cached;
    }
  }

  console.log(`[live] Pulling ${symbols.length} symbols at tf=${timeframe}, count=${count} from TradingView...`);
  const universe = await fetchUniverse({ symbols, timeframe, count });
  writeCache(key, universe);
  console.log(`[live] Cached to ${path.join('evolve', 'cache', key + '.json')}`);

  // Warn if any asset came back short (TV hadn't loaded enough history yet).
  for (const u of universe) {
    if (u.bars.length < count * 0.9) {
      console.warn(`[live]   warning: ${u.symbol} returned ${u.bars.length}/${count} bars`);
    }
  }
  return universe;
}

module.exports = { loadLiveUniverse, DEFAULT_LIVE_SYMBOLS };
