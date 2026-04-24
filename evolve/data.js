// Deterministic synthetic OHLCV generator for 10 assets.
// Each asset has distinct volatility / drift / regime structure so the
// backtest sees a realistic cross-section, not one synthetic distribution.

'use strict';

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

function boxMuller(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Per-asset profile: annualized drift, annualized vol, regime switching, price scale.
const ASSETS = [
  { symbol: 'BTCUSD',  seed: 1001, startPrice: 42000, drift: 0.40, vol: 0.75, regime: 0.15, jump: 0.02 },
  { symbol: 'ETHUSD',  seed: 1002, startPrice: 2300,  drift: 0.30, vol: 0.85, regime: 0.15, jump: 0.02 },
  { symbol: 'SOLUSD',  seed: 1003, startPrice: 95,    drift: 0.50, vol: 1.10, regime: 0.20, jump: 0.03 },
  { symbol: 'ES1!',    seed: 1004, startPrice: 4800,  drift: 0.08, vol: 0.18, regime: 0.05, jump: 0.005 },
  { symbol: 'NQ1!',    seed: 1005, startPrice: 17000, drift: 0.15, vol: 0.25, regime: 0.08, jump: 0.008 },
  { symbol: 'GC1!',    seed: 1006, startPrice: 2050,  drift: 0.05, vol: 0.15, regime: 0.04, jump: 0.004 },
  { symbol: 'CL1!',    seed: 1007, startPrice: 75,    drift: 0.00, vol: 0.42, regime: 0.25, jump: 0.015 },
  { symbol: 'AAPL',    seed: 1008, startPrice: 180,   drift: 0.12, vol: 0.28, regime: 0.06, jump: 0.008 },
  { symbol: 'TSLA',    seed: 1009, startPrice: 240,   drift: 0.05, vol: 0.55, regime: 0.18, jump: 0.025 },
  { symbol: 'NVDA',    seed: 1010, startPrice: 480,   drift: 0.45, vol: 0.48, regime: 0.10, jump: 0.020 },
];

// Generate N bars of daily OHLCV for one asset.
// Uses a regime-switching GBM with occasional jumps to produce wicks/sweeps
// that SFP setups can actually hunt.
function generateSeries(profile, nBars = 1500) {
  const rng = mulberry32(profile.seed);
  const dtY = 1 / 252;                       // daily bar in years
  const sigmaBar = profile.vol * Math.sqrt(dtY);
  const muBar    = (profile.drift - 0.5 * profile.vol * profile.vol) * dtY;

  let price = profile.startPrice;
  let regime = 1.0;                          // volatility regime multiplier
  const bars = [];

  for (let i = 0; i < nBars; i++) {
    // Regime switch occasionally (creates vol clusters)
    if (rng() < profile.regime) regime = 0.5 + rng() * 2.0;

    const z = boxMuller(rng);
    const barReturn = muBar + sigmaBar * regime * z;
    const open = price;
    const close = open * Math.exp(barReturn);

    // Intrabar range: centred around bar return, wider in high-vol regimes.
    // This is the key for SFP: we need wicks that poke beyond recent extremes.
    const intrabarVol = sigmaBar * regime * (0.9 + rng() * 0.8);
    const wickUp   = Math.abs(boxMuller(rng)) * intrabarVol * open;
    const wickDown = Math.abs(boxMuller(rng)) * intrabarVol * open;

    // Occasional jumps (liquidity sweeps / news spikes) — mostly wick, partially filled
    let jumpHigh = 0, jumpLow = 0;
    if (rng() < profile.jump) {
      const dir = rng() < 0.5 ? 1 : -1;
      const mag = (1 + rng() * 3) * intrabarVol * open;
      if (dir > 0) jumpHigh = mag; else jumpLow = mag;
    }

    const high = Math.max(open, close) + wickUp + jumpHigh;
    const low  = Math.min(open, close) - wickDown - jumpLow;

    // Volume: baseline + shock proportional to range
    const range = high - low;
    const baseVol = 1_000_000 * (0.8 + rng() * 0.4);
    const volume = baseVol * (1 + (range / open) * 20 * (0.5 + rng()));

    bars.push({
      t: i,
      open,
      high,
      low,
      close,
      volume: Math.round(volume),
    });

    price = close;
  }

  return bars;
}

function buildUniverse(nBars = 1500) {
  return ASSETS.map(p => ({
    symbol: p.symbol,
    profile: p,
    bars: generateSeries(p, nBars),
  }));
}

module.exports = { ASSETS, buildUniverse, generateSeries };
