# Baseline SFP Strategy

A Swing Failure Pattern (SFP) fires when price sweeps a prior swing high/low
(liquidity grab) and closes back inside the range, trapping breakout traders.

Implementation: `evolve/strategies/sfp.js`. The evolver loads this by default;
pass `--strategy=<name-or-path>` to swap in a different starting strategy.

## Entry rules (baseline)

- **Bearish SFP**: `high > prior_swing_high` AND `close < prior_swing_high`.
  Enter short on the close of the signal bar.
- **Bullish SFP**: `low  < prior_swing_low`  AND `close > prior_swing_low`.
  Enter long on the close of the signal bar.

## Risk management (baseline)

- Stop: `stop_atr_mult * ATR(14)` beyond entry (above for shorts, below for longs).
- Target: `rr_ratio * stop_distance` from entry (take-profit).
- Position size: risk 1% of current equity per trade.
- One position at a time per asset. Starting capital: **$1,000 per asset**.
- Exit: first touch of TP or SL (intrabar). Ties broken pessimistically: SL wins.

## 5 Tunable Parameters

| Param | Baseline | Search range |
|-------|----------|--------------|
| `swing_lookback`     | 10   | 5 – 30 bars |
| `wick_threshold_atr` | 0.30 | 0.0 – 1.5   (min wick beyond swing, in ATR units) |
| `rr_ratio`           | 2.0  | 1.0 – 4.0   |
| `stop_atr_mult`      | 1.5  | 0.5 – 3.0   |
| `confirmation_bars`  | 0    | 0 – 3       (bars of close-inside confirmation required) |

## 3 Optional Signal Filters

| Filter | Logic |
|--------|-------|
| `trend_filter`  | Require `close > EMA(50)` for longs, `close < EMA(50)` for shorts. Only take SFPs **with** the higher-timeframe trend. |
| `rsi_filter`    | Require `RSI(14) > 60` for bearish SFPs (short into overbought) and `RSI(14) < 40` for bullish SFPs (long into oversold). |
| `volume_filter` | Require the signal bar's volume > `volume_mult * SMA(volume, 20)`. Default mult = 1.3. |

Each filter is independently on/off (0/1). Baseline = all **off**.

## Baseline config

```json
{
  "swing_lookback": 10,
  "wick_threshold_atr": 0.30,
  "rr_ratio": 2.0,
  "stop_atr_mult": 1.5,
  "confirmation_bars": 0,
  "trend_filter": false,
  "rsi_filter": false,
  "volume_filter": false,
  "volume_mult": 1.3
}
```
