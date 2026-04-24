// Backtest engine — strategy-agnostic.
// A strategy module provides: computeContext, detect, passFilters.
// Capital: $1000 per asset. Risk: 1% of current equity per trade.
'use strict';

const STARTING_CAPITAL = 1000;
const RISK_PER_TRADE   = 0.01;

function backtest(bars, cfg, strategy) {
  const ctx = strategy.computeContext(bars);

  let equity = STARTING_CAPITAL;
  let peakEquity = equity;
  let maxDD = 0;
  const trades = [];
  const equityCurve = [equity];

  let pos = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Exits first (intrabar, pessimistic: SL wins on ties).
    if (pos) {
      let exitPrice = null, exitReason = null;
      if (pos.side === 'long') {
        if (bar.low  <= pos.stop)   { exitPrice = pos.stop;   exitReason = 'stop'; }
        else if (bar.high >= pos.target) { exitPrice = pos.target; exitReason = 'target'; }
      } else {
        if (bar.high >= pos.stop)   { exitPrice = pos.stop;   exitReason = 'stop'; }
        else if (bar.low  <= pos.target) { exitPrice = pos.target; exitReason = 'target'; }
      }

      if (exitPrice != null) {
        const pnl = pos.side === 'long'
          ? (exitPrice - pos.entry) * pos.size
          : (pos.entry - exitPrice) * pos.size;
        equity += pnl;
        trades.push({
          side: pos.side, entry: pos.entry, exit: exitPrice, pnl,
          rMultiple: pnl / pos.riskDollars, reason: exitReason,
          barsHeld: i - pos.entryBar,
        });
        pos = null;
      }
    }

    equityCurve.push(equity);
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDD) maxDD = dd;

    // Entry: only if flat.
    if (!pos && equity > 0) {
      const sig = strategy.detect(bars, i, cfg, ctx);
      if (sig && strategy.passFilters(bars, i, cfg, ctx, sig.side)) {
        const entry = bar.close;
        // Strategy may supply its own stop distance; otherwise use ATR × stop_atr_mult.
        let stopDist;
        if (typeof sig.stopDist === 'number') {
          stopDist = sig.stopDist;
        } else if (typeof sig.atr === 'number' && cfg.stop_atr_mult != null) {
          stopDist = cfg.stop_atr_mult * sig.atr;
        } else {
          stopDist = 0;
        }
        const rr = cfg.rr_ratio != null ? cfg.rr_ratio : 2.0;
        if (stopDist > 0) {
          const stop   = sig.side === 'long' ? entry - stopDist : entry + stopDist;
          const target = sig.side === 'long' ? entry + rr * stopDist : entry - rr * stopDist;
          const riskDollars = equity * RISK_PER_TRADE;
          const size = riskDollars / stopDist;
          if (size > 0 && isFinite(size)) {
            pos = { side: sig.side, entry, stop, target, size, riskDollars, entryBar: i };
          }
        }
      }
    }
  }

  if (pos) {
    const last = bars[bars.length - 1].close;
    const pnl = pos.side === 'long'
      ? (last - pos.entry) * pos.size
      : (pos.entry - last) * pos.size;
    equity += pnl;
    trades.push({
      side: pos.side, entry: pos.entry, exit: last, pnl,
      rMultiple: pnl / pos.riskDollars, reason: 'eod',
      barsHeld: bars.length - 1 - pos.entryBar,
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

function aggregate(perAsset) {
  const totalStart  = perAsset.reduce((s, a) => s + a.result.startCapital, 0);
  const totalFinal  = perAsset.reduce((s, a) => s + a.result.finalEquity, 0);
  const totalTrades = perAsset.reduce((s, a) => s + a.result.trades, 0);
  const totalWins   = perAsset.reduce((s, a) => s + a.result.wins, 0);

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
