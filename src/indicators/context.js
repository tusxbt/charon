// Builds the multi-timeframe indicator context for a mint: one fast timeframe
// for the EMA/RSI/Stochastic setup, one slow timeframe for the Supertrend
// direction filter. This is the only file in src/indicators that does I/O.

import { getCandles } from './candles.js';
import { indicatorSnapshot } from './snapshot.js';
import { DEFAULT_SETUP_CONFIG } from './entry.js';

export async function buildIndicatorContext(mint, config = {}) {
  const cfg = { ...DEFAULT_SETUP_CONFIG, ...config };

  const needsTrend = cfg.require_trend_supertrend_bull || cfg.exit_on_supertrend_flip;
  // Oscillators and Supertrend default to the same 5m timeframe. Fetching it
  // twice would double the request cost per candidate for identical data, so
  // when the intervals match we pull the deeper of the two once and share it.
  const sharedOscTrend = needsTrend && cfg.osc_interval === cfg.trend_interval;

  const [entryCandles, oscCandles, trendOnlyCandles] = await Promise.all([
    getCandles(mint, cfg.entry_interval, cfg.entry_candles).catch(() => []),
    getCandles(mint, cfg.osc_interval, sharedOscTrend ? Math.max(cfg.osc_candles, cfg.trend_candles) : cfg.osc_candles).catch(() => []),
    needsTrend && !sharedOscTrend
      ? getCandles(mint, cfg.trend_interval, cfg.trend_candles).catch(() => [])
      : Promise.resolve([]),
  ]);
  const trendCandles = sharedOscTrend ? oscCandles : trendOnlyCandles;

  return {
    mint,
    entryInterval: cfg.entry_interval,
    oscInterval: cfg.osc_interval,
    trendInterval: cfg.trend_interval,
    entry: indicatorSnapshot(entryCandles, { ema_periods: [50, 100, 200] }),
    osc: oscCandles.length
      ? indicatorSnapshot(oscCandles, {
          stochrsi_rsi_period: cfg.stochrsi_rsi_period,
          stochrsi_stoch_period: cfg.stochrsi_stoch_period,
          stochrsi_k_smooth: cfg.stochrsi_k_smooth,
          stochrsi_d_smooth: cfg.stochrsi_d_smooth,
        })
      : null,
    trend: trendCandles.length
      ? indicatorSnapshot(trendCandles, {
          supertrend_period: cfg.supertrend_period,
          supertrend_multiplier: cfg.supertrend_multiplier,
        })
      : null,
  };
}

// Compact form for logs, Telegram, and the LLM prompt — the full snapshot
// carries every EMA series and would bloat the prompt for no benefit.
export function compactIndicators(context, setup = null) {
  if (!context) return null;
  return {
    entryInterval: context.entryInterval,
    oscInterval: context.oscInterval,
    trendInterval: context.trendInterval,
    candles: context.entry?.candles ?? 0,
    oscCandles: context.osc?.candles ?? 0,
    trendCandles: context.trend?.candles ?? 0,
    warmup: context.entry?.warmup ?? true,
    barsNeeded: context.entry?.barsNeeded ?? null,
    price: context.entry?.price ?? null,
    ema50: context.entry?.ema50 ?? null,
    ema100: context.entry?.ema100 ?? null,
    ema200: context.entry?.ema200 ?? null,
    rsi: context.osc?.rsi ?? null,
    stochRsiK: context.osc?.stochRsiK ?? null,
    stochRsiD: context.osc?.stochRsiD ?? null,
    supertrendDirection: context.trend?.supertrendDirection ?? null,
    setupPassed: setup?.passed ?? null,
    setupFailures: setup?.failures ?? [],
    emaDistancePct: setup?.details?.emaDistancePct ?? null,
  };
}
