// Template strategy module — copy this file as a starting point for a new
// strategy. Replace `detect` with your entry logic and adjust RANGES.
//
// Interface that the evolve loop consumes:
//
//   name:                string (shown in leaderboard header)
//   BASELINE:            { name: 'baseline', ...cfg }      (your starting config)
//   RANGES:              { paramKey: [lo, hi] }             (numeric search space)
//   FILTERS:             ['some_filter', ...]               (on/off filter keys)
//   FILTER_LABELS:       { some_filter: 'short-label' }     (optional display)
//   LEADERBOARD_COLUMNS: [{label, key, fmt}]                (extra columns; fmt: 'int'|'f1'|'f2'|'pct'|'bool')
//   computeContext(bars)                        -> ctx     (per-series indicators)
//   detect(bars, i, cfg, ctx)                   -> signal | null
//                                                  signal = { side: 'long'|'short', atr, stopDist? }
//                                                  If you return `stopDist`, it overrides cfg.stop_atr_mult*atr.
//   passFilters(bars, i, cfg, ctx, side)        -> bool
//
// Optional overrides (only needed to preserve an exact RNG sequence):
//   randomConfig(helpers, name)                 -> cfg
//   mutate(helpers, parent, childName)          -> cfg
// If omitted, the generic samplers in evolve.js iterate RANGES/FILTERS
// (uniform sampling; ±15% perturbation; one filter flip per mutation).
//
// The backtest engine supplies cfg.stop_atr_mult and cfg.rr_ratio for risk
// management. If your strategy doesn't use ATR stops, return `stopDist` on
// the signal object and the engine will use that.

'use strict';

const { sma, ema, atr } = require('../indicators');

// --- Example: simple Donchian breakout with an optional trend filter ---

const BASELINE = {
  name: 'baseline',
  channel_lookback: 20,
  stop_atr_mult:    2.0,
  rr_ratio:         2.0,
  trend_filter:     false,
};

const RANGES = {
  channel_lookback: [10, 60],
  stop_atr_mult:    [1.0, 3.5],
  rr_ratio:         [1.0, 4.0],
};

const FILTERS = ['trend_filter'];
const FILTER_LABELS = { trend_filter: 'trend' };

const LEADERBOARD_COLUMNS = [
  { label: 'Channel', key: 'channel_lookback', fmt: 'int' },
  { label: 'StopATR', key: 'stop_atr_mult',    fmt: 'f1'  },
  { label: 'RR',      key: 'rr_ratio',         fmt: 'f1'  },
];

function computeContext(bars) {
  const closes = bars.map(b => b.close);
  return {
    atrArr: atr(bars, 14),
    emaArr: ema(closes, 50),
  };
}

function detect(bars, i, cfg, ctx) {
  if (i < cfg.channel_lookback + 1) return null;
  const atrNow = ctx.atrArr[i];
  if (atrNow == null || atrNow <= 0) return null;

  let hh = -Infinity, ll = Infinity;
  for (let j = i - cfg.channel_lookback; j <= i - 1; j++) {
    if (bars[j].high > hh) hh = bars[j].high;
    if (bars[j].low  < ll) ll = bars[j].low;
  }

  if (bars[i].close > hh) return { side: 'long',  atr: atrNow };
  if (bars[i].close < ll) return { side: 'short', atr: atrNow };
  return null;
}

function passFilters(bars, i, cfg, ctx, side) {
  if (cfg.trend_filter) {
    const e = ctx.emaArr[i];
    if (e == null) return false;
    if (side === 'long'  && bars[i].close <= e) return false;
    if (side === 'short' && bars[i].close >= e) return false;
  }
  return true;
}

module.exports = {
  name: 'donchian-template',
  BASELINE,
  RANGES,
  FILTERS,
  FILTER_LABELS,
  LEADERBOARD_COLUMNS,
  computeContext,
  detect,
  passFilters,
  // randomConfig / mutate not provided -> evolve.js uses generic defaults.
};
