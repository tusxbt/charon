// Turns a candle array into the compact, warmup-aware object that filters,
// exit rules, and the LLM prompt all read from.
//
// The important field is `warmup`. A newpair token has no history, so EMA200 is
// unknowable for its first 200 bars — and "unknowable" must never be silently
// treated as "bearish". Every consumer is expected to skip a gate whose inputs
// are null rather than fail it.

import { ema, stochRsi, stochRsiBars, supertrend, last, crossedOver, crossedUnder } from './compute.js';

export const DEFAULT_INDICATOR_CONFIG = {
  ema_periods: [50, 100, 200],
  stochrsi_rsi_period: 14,
  stochrsi_stoch_period: 14,
  stochrsi_k_smooth: 3,
  stochrsi_d_smooth: 3,
  supertrend_period: 10,
  supertrend_multiplier: 3,
};

export function candleSeries(candles = []) {
  const rows = [...candles]
    .filter(candle => candle && Number.isFinite(Number(candle.close)))
    .sort((a, b) => Number(a.time) - Number(b.time));
  return {
    time: rows.map(row => Number(row.time)),
    open: rows.map(row => Number(row.open)),
    high: rows.map(row => Number(row.high)),
    low: rows.map(row => Number(row.low)),
    close: rows.map(row => Number(row.close)),
    volume: rows.map(row => Number(row.volume ?? 0)),
    length: rows.length,
  };
}

export function indicatorSnapshot(candles = [], config = {}) {
  const cfg = { ...DEFAULT_INDICATOR_CONFIG, ...config };
  const series = candleSeries(candles);
  const periods = [...cfg.ema_periods].sort((a, b) => a - b);
  const stochRsiConfig = {
    rsiPeriod: cfg.stochrsi_rsi_period,
    stochPeriod: cfg.stochrsi_stoch_period,
    kSmooth: cfg.stochrsi_k_smooth,
    dSmooth: cfg.stochrsi_d_smooth,
  };
  const longest = Math.max(
    ...periods,
    stochRsiBars(stochRsiConfig),
    cfg.supertrend_period + 1,
  );

  const emas = {};
  const emaSeries = {};
  for (const period of periods) {
    const line = ema(series.close, period);
    emaSeries[period] = line;
    emas[`ema${period}`] = last(line);
  }
  const stoch = stochRsi(series.close, stochRsiConfig);
  const st = supertrend(series.high, series.low, series.close, {
    period: cfg.supertrend_period,
    multiplier: cfg.supertrend_multiplier,
  });

  const price = last(series.close);
  const stDirection = last(st.direction);
  const prevStDirection = st.direction.length >= 2 ? st.direction[st.direction.length - 2] : null;

  // Bullish stack = price above every EMA and each faster EMA above the slower
  // one. Null when any leg has not warmed up, so callers can tell it apart from
  // a genuine "no".
  const stackLegs = periods.map(period => emas[`ema${period}`]);
  const stackKnown = price !== null && stackLegs.every(value => value !== null);
  const emaStackBullish = stackKnown
    ? stackLegs.every((value, index) => (index === 0 ? price > value : stackLegs[index - 1] > value))
    : null;
  const emaStackBearish = stackKnown
    ? stackLegs.every((value, index) => (index === 0 ? price < value : stackLegs[index - 1] < value))
    : null;

  const fast = periods[0];
  const mid = periods[1] ?? periods[0];

  return {
    candles: series.length,
    lastCandleTime: last(series.time),
    price,
    warmup: series.length < longest,
    barsNeeded: Math.max(0, longest - series.length),
    ...emas,
    emaStackBullish,
    emaStackBearish,
    emaGoldenCross: emaSeries[fast] && emaSeries[mid] ? crossedOver(emaSeries[fast], emaSeries[mid]) : false,
    emaDeathCross: emaSeries[fast] && emaSeries[mid] ? crossedUnder(emaSeries[fast], emaSeries[mid]) : false,
    rsi: last(stoch.rsi),
    stochRsiK: last(stoch.k),
    stochRsiD: last(stoch.d),
    stochRsiCrossUp: crossedOver(stoch.k, stoch.d),
    stochRsiCrossDown: crossedUnder(stoch.k, stoch.d),
    supertrend: last(st.line),
    supertrendDirection: stDirection,
    supertrendFlippedUp: prevStDirection === -1 && stDirection === 1,
    supertrendFlippedDown: prevStDirection === 1 && stDirection === -1,
    // Per-indicator readiness, so a strategy can trade on RSI/Stoch long before
    // EMA200 exists — the two-phase design depends on this being granular.
    ready: {
      ...Object.fromEntries(periods.map(period => [`ema${period}`, emas[`ema${period}`] !== null])),
      stochRsi: last(stoch.d) !== null,
      supertrend: stDirection !== null,
    },
  };
}
