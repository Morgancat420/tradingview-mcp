// Baseline SFP (Swing Failure Pattern) strategy module.
// Drop-in for the evolve loop — also a reference for what a strategy
// module must export.
'use strict';

const { sma, ema, atr, rsi } = require('../indicators');

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

const FILTER_LABELS = {
  trend_filter:  'trend',
  rsi_filter:    'rsi',
  volume_filter: 'vol',
};

// Columns shown in the leaderboard alongside the standard metrics.
const LEADERBOARD_COLUMNS = [
  { label: 'Lkbk',    key: 'swing_lookback',     fmt: 'int' },
  { label: 'Wick',    key: 'wick_threshold_atr', fmt: 'f2'  },
  { label: 'RR',      key: 'rr_ratio',           fmt: 'f1'  },
  { label: 'StopATR', key: 'stop_atr_mult',      fmt: 'f1'  },
  { label: 'Conf',    key: 'confirmation_bars',  fmt: 'int' },
];

function computeContext(bars) {
  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  return {
    atrArr:    atr(bars, 14),
    emaArr:    ema(closes, 50),
    rsiArr:    rsi(closes, 14),
    volSmaArr: sma(volumes, 20),
  };
}

function detect(bars, i, cfg, ctx) {
  if (i < cfg.swing_lookback + 2) return null;
  const bar = bars[i];
  const atrNow = ctx.atrArr[i];
  if (atrNow == null || atrNow <= 0) return null;

  let swingHigh = -Infinity;
  let swingLow  =  Infinity;
  for (let j = i - cfg.swing_lookback; j <= i - 1; j++) {
    if (bars[j].high > swingHigh) swingHigh = bars[j].high;
    if (bars[j].low  < swingLow)  swingLow  = bars[j].low;
  }

  const wickMin = cfg.wick_threshold_atr * atrNow;

  if (bar.high > swingHigh + wickMin && bar.close < swingHigh) {
    for (let k = 0; k < cfg.confirmation_bars; k++) {
      const idx = i - k;
      if (idx < 0 || bars[idx].close >= swingHigh) return null;
    }
    return { side: 'short', swingLevel: swingHigh, atr: atrNow };
  }

  if (bar.low < swingLow - wickMin && bar.close > swingLow) {
    for (let k = 0; k < cfg.confirmation_bars; k++) {
      const idx = i - k;
      if (idx < 0 || bars[idx].close <= swingLow) return null;
    }
    return { side: 'long', swingLevel: swingLow, atr: atrNow };
  }

  return null;
}

function passFilters(bars, i, cfg, ctx, side) {
  if (cfg.trend_filter) {
    const e = ctx.emaArr[i];
    if (e == null) return false;
    if (side === 'long'  && bars[i].close <= e) return false;
    if (side === 'short' && bars[i].close >= e) return false;
  }
  if (cfg.rsi_filter) {
    const r = ctx.rsiArr[i];
    if (r == null) return false;
    if (side === 'long'  && r >= 40) return false;
    if (side === 'short' && r <= 60) return false;
  }
  if (cfg.volume_filter) {
    const v = ctx.volSmaArr[i];
    if (v == null || v <= 0) return false;
    if (bars[i].volume < cfg.volume_mult * v) return false;
  }
  return true;
}

// --- SFP-specific sampling / mutation (preserves prior RNG sequence exactly) ---

function clampCfg(c, h) {
  c.swing_lookback     = h.clamp(Math.round(c.swing_lookback),     RANGES.swing_lookback[0],     RANGES.swing_lookback[1]);
  c.wick_threshold_atr = h.round(h.clamp(c.wick_threshold_atr,     RANGES.wick_threshold_atr[0], RANGES.wick_threshold_atr[1]), 0.05);
  c.rr_ratio           = h.round(h.clamp(c.rr_ratio,               RANGES.rr_ratio[0],           RANGES.rr_ratio[1]), 0.1);
  c.stop_atr_mult      = h.round(h.clamp(c.stop_atr_mult,          RANGES.stop_atr_mult[0],      RANGES.stop_atr_mult[1]), 0.1);
  c.confirmation_bars  = h.clamp(Math.round(c.confirmation_bars),  RANGES.confirmation_bars[0],  RANGES.confirmation_bars[1]);
  return c;
}

function randomConfig(h, name) {
  return clampCfg({
    name,
    swing_lookback:     h.randInt(RANGES.swing_lookback[0],     RANGES.swing_lookback[1]),
    wick_threshold_atr: h.randFloat(RANGES.wick_threshold_atr[0], RANGES.wick_threshold_atr[1]),
    rr_ratio:           h.randFloat(RANGES.rr_ratio[0],           RANGES.rr_ratio[1]),
    stop_atr_mult:      h.randFloat(RANGES.stop_atr_mult[0],      RANGES.stop_atr_mult[1]),
    confirmation_bars:  h.randInt(RANGES.confirmation_bars[0],    RANGES.confirmation_bars[1]),
    trend_filter:       h.rand() < 0.35,
    rsi_filter:         h.rand() < 0.35,
    volume_filter:      h.rand() < 0.35,
    volume_mult:        h.round(h.randFloat(1.1, 1.8), 0.1),
  }, h);
}

function mutate(h, parent, childName) {
  const c = { ...parent, name: childName };
  const perturb = (v, [lo, hi], frac = 0.15) => v + (h.rand() * 2 - 1) * (hi - lo) * frac;

  c.swing_lookback     = perturb(c.swing_lookback,     RANGES.swing_lookback);
  c.wick_threshold_atr = perturb(c.wick_threshold_atr, RANGES.wick_threshold_atr);
  c.rr_ratio           = perturb(c.rr_ratio,           RANGES.rr_ratio);
  c.stop_atr_mult      = perturb(c.stop_atr_mult,      RANGES.stop_atr_mult);
  if (h.rand() < 0.4) c.confirmation_bars = perturb(c.confirmation_bars, RANGES.confirmation_bars);

  const swap = FILTERS[Math.floor(h.rand() * FILTERS.length)];
  c[swap] = !c[swap];
  c.volume_mult = h.round(h.clamp(c.volume_mult + (h.rand() * 2 - 1) * 0.2, 1.1, 1.8), 0.1);
  return clampCfg(c, h);
}

module.exports = {
  name: 'sfp',
  BASELINE,
  RANGES,
  FILTERS,
  FILTER_LABELS,
  LEADERBOARD_COLUMNS,
  computeContext,
  detect,
  passFilters,
  randomConfig,
  mutate,
};
