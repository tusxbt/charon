// Builds the multi-timeframe indicator context for a mint: one fast timeframe
// for the EMA/RSI/Stochastic setup, one slow timeframe for the Supertrend
// direction filter. This is the only file in src/indicators that does I/O.

import { getCandles } from './candles.js';
import { indicatorSnapshot } from './snapshot.js';
import { DEFAULT_SETUP_CONFIG } from './entry.js';

export async function buildIndicatorContext(mint, config = {}) {
  const cfg = { ...DEFAULT_SETUP_CONFIG, ...config };

  const [entryCandles, trendCandles] = await Promise.all([
    getCandles(mint, cfg.entry_interval, cfg.entry_candles).catch(() => []),
    cfg.require_trend_supertrend_bull || cfg.exit_on_supertrend_flip
      ? getCandles(mint, cfg.trend_interval, cfg.trend_candles).catch(() => [])
      : Promise.resolve([]),
  ]);

  return {
    mint,
    entryInterval: cfg.entry_interval,
    trendInterval: cfg.trend_interval,
    entry: indicatorSnapshot(entryCandles, {
      ema_periods: [50, 100, 200],
      rsi_period: cfg.rsi_period ?? 14,
      stoch_k_period: cfg.stoch_k_period ?? 14,
    }),
    trend: trendCandles.length
      ? indicatorSnapshot(trendCandles, {
          supertrend_period: cfg.supertrend_period ?? 10,
          supertrend_multiplier: cfg.supertrend_multiplier ?? 3,
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
    trendInterval: context.trendInterval,
    candles: context.entry?.candles ?? 0,
    warmup: context.entry?.warmup ?? true,
    barsNeeded: context.entry?.barsNeeded ?? null,
    price: context.entry?.price ?? null,
    ema50: context.entry?.ema50 ?? null,
    ema100: context.entry?.ema100 ?? null,
    ema200: context.entry?.ema200 ?? null,
    rsi: context.entry?.rsi ?? null,
    stochK: context.entry?.stochK ?? null,
    stochD: context.entry?.stochD ?? null,
    supertrendDirection: context.trend?.supertrendDirection ?? null,
    setupPassed: setup?.passed ?? null,
    setupFailures: setup?.failures ?? [],
    emaDistancePct: setup?.details?.emaDistancePct ?? null,
  };
}
