// SFP (Swing Failure Pattern) strategy + backtest engine.
// Single-position, one-asset-at-a-time backtest.
// Capital: $1000 per asset. Risk: 1% of current equity per trade.
'use strict';

const { sma, ema, atr, rsi } = require('./indicators');

const STARTING_CAPITAL = 1000;
const RISK_PER_TRADE   = 0.01;

// Detect SFP setups on bar i (using data up to and including i).
// Returns { side: 'long'|'short', stop, entry, swingLevel } or null.
function detectSFP(bars, i, cfg, ctx) {
  if (i < cfg.swing_lookback + 2) return null;
  const bar = bars[i];
  const atrNow = ctx.atrArr[i];
  if (atrNow == null || atrNow <= 0) return null;

  // Prior swing high/low over the window [i - lookback, i - 1]
  let swingHigh = -Infinity;
  let swingLow  =  Infinity;
  for (let j = i - cfg.swing_lookback; j <= i - 1; j++) {
    if (bars[j].high > swingHigh) swingHigh = bars[j].high;
    if (bars[j].low  < swingLow)  swingLow  = bars[j].low;
  }

  const wickMin = cfg.wick_threshold_atr * atrNow;

  // Bearish SFP: swept swing high then closed back below it
  if (bar.high > swingHigh + wickMin && bar.close < swingHigh) {
    // confirmation: require last N bars all close below swingHigh (incl. this one)
    for (let k = 0; k < cfg.confirmation_bars; k++) {
      const idx = i - k;
      if (idx < 0 || bars[idx].close >= swingHigh) return null;
    }
    return { side: 'short', swingLevel: swingHigh, atr: atrNow };
  }

  // Bullish SFP
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

function backtest(bars, cfg) {
  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const ctx = {
    atrArr:    atr(bars, 14),
    emaArr:    ema(closes, 50),
    rsiArr:    rsi(closes, 14),
    volSmaArr: sma(volumes, 20),
  };

  let equity = STARTING_CAPITAL;
  let peakEquity = equity;
  let maxDD = 0;
  const trades = [];
  const equityCurve = [equity];

  let pos = null;     // { side, entry, stop, target, size, entryBar }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Check exits first (intrabar). Pessimistic: if both SL and TP are in-range, SL wins.
    if (pos) {
      let exitPrice = null, exitReason = null;
      const hitStopLong  = pos.side === 'long'  && bar.low  <= pos.stop;
      const hitTpLong    = pos.side === 'long'  && bar.high >= pos.target;
      const hitStopShort = pos.side === 'short' && bar.high >= pos.stop;
      const hitTpShort   = pos.side === 'short' && bar.low  <= pos.target;

      if (pos.side === 'long') {
        if (hitStopLong) { exitPrice = pos.stop; exitReason = 'stop'; }
        else if (hitTpLong) { exitPrice = pos.target; exitReason = 'target'; }
      } else {
        if (hitStopShort) { exitPrice = pos.stop; exitReason = 'stop'; }
        else if (hitTpShort) { exitPrice = pos.target; exitReason = 'target'; }
      }

      if (exitPrice != null) {
        const pnl = pos.side === 'long'
          ? (exitPrice - pos.entry) * pos.size
          : (pos.entry - exitPrice) * pos.size;
        equity += pnl;
        trades.push({
          side: pos.side,
          entry: pos.entry,
          exit: exitPrice,
          pnl,
          rMultiple: pnl / pos.riskDollars,
          reason: exitReason,
          barsHeld: i - pos.entryBar,
        });
        pos = null;
      }
    }

    equityCurve.push(equity);
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDD) maxDD = dd;

    // Entry: only if flat
    if (!pos && equity > 0) {
      const sig = detectSFP(bars, i, cfg, ctx);
      if (sig && passFilters(bars, i, cfg, ctx, sig.side)) {
        const entry = bar.close;
        const atrNow = sig.atr;
        const stopDist = cfg.stop_atr_mult * atrNow;
        if (stopDist > 0) {
          const stop   = sig.side === 'long' ? entry - stopDist : entry + stopDist;
          const target = sig.side === 'long' ? entry + cfg.rr_ratio * stopDist
                                             : entry - cfg.rr_ratio * stopDist;
          const riskDollars = equity * RISK_PER_TRADE;
          const size = riskDollars / stopDist;
          if (size > 0 && isFinite(size)) {
            pos = { side: sig.side, entry, stop, target, size, riskDollars, entryBar: i };
          }
        }
      }
    }
  }

  // Force-close any open position at last close (mark-to-market)
  if (pos) {
    const last = bars[bars.length - 1].close;
    const pnl = pos.side === 'long'
      ? (last - pos.entry) * pos.size
      : (pos.entry - last) * pos.size;
    equity += pnl;
    trades.push({
      side: pos.side, entry: pos.entry, exit: last, pnl,
      rMultiple: pnl / pos.riskDollars, reason: 'eod', barsHeld: bars.length - 1 - pos.entryBar,
    });
  }

  return summarise(trades, equity, equityCurve, maxDD);
}

function summarise(trades, finalEquity, equityCurve, maxDD) {
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const netPnl = finalEquity - STARTING_CAPITAL;

  const avgR = trades.length
    ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const expectancyPerTrade = trades.length ? netPnl / trades.length : 0;

  return {
    startCapital: STARTING_CAPITAL,
    finalEquity,
    netPnl,
    returnPct: (finalEquity / STARTING_CAPITAL - 1) * 100,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    maxDrawdown: maxDD,
    avgR,
    expectancyPerTrade,
    equityCurveLen: equityCurve.length,
  };
}

// Aggregate per-asset stats into a single portfolio-style summary.
function aggregate(perAsset) {
  const totalStart  = perAsset.reduce((s, a) => s + a.result.startCapital, 0);
  const totalFinal  = perAsset.reduce((s, a) => s + a.result.finalEquity, 0);
  const totalTrades = perAsset.reduce((s, a) => s + a.result.trades, 0);
  const totalWins   = perAsset.reduce((s, a) => s + a.result.wins, 0);
  let grossWin = 0, grossLoss = 0;
  for (const a of perAsset) {
    const r = a.result;
    const wR = r.winRate;
    const wins = r.wins;
    const losses = r.losses;
    // Reconstruct gross profit/loss from PF & netPnl when available.
    // (We already have net pnl; keep PF via per-asset, weight by trade count.)
    if (r.profitFactor !== Infinity && r.losses > 0) {
      const avgLoss = (r.grossLoss) || 0;
    }
  }
  // Simpler: mean-weight PF by trade count.
  const pfWeighted = totalTrades > 0
    ? perAsset.reduce((s, a) => s + (isFinite(a.result.profitFactor) ? a.result.profitFactor : 3) * a.result.trades, 0) / totalTrades
    : 0;

  const worstDD = perAsset.reduce((m, a) => Math.max(m, a.result.maxDrawdown), 0);
  const avgDD   = perAsset.reduce((s, a) => s + a.result.maxDrawdown, 0) / perAsset.length;

  const netPnl = totalFinal - totalStart;
  return {
    totalStart,
    totalFinal,
    netPnl,
    returnPct: (totalFinal / totalStart - 1) * 100,
    totalTrades,
    totalWins,
    winRate: totalTrades ? totalWins / totalTrades : 0,
    profitFactorW: pfWeighted,
    worstDrawdown: worstDD,
    avgDrawdown: avgDD,
    assetsPositive: perAsset.filter(a => a.result.netPnl > 0).length,
    assetsTotal: perAsset.length,
  };
}

module.exports = { backtest, aggregate, STARTING_CAPITAL };
