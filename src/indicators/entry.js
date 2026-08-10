// Pure entry/exit rules for the multi-timeframe indicator setup:
//   entry TF (15s default) — price in the EMA 50/100/200 zone, StochRSI bottomed
//   trend TF (5m  default) — Supertrend bullish
//   osc TF   (5m  default) — StochRSI overbought, used for exits only
//
// Entry and exit read StochRSI on different timeframes on purpose: entry reacts
// on the fast series, exit waits for the slower one to call the move over.
//
// Failure strings mirror the style of candidateBuilder.filterCandidate so both
// filter layers read the same way in logs and Telegram messages.

import { intervalSeconds } from './intervals.js';
import { stochRsiBars } from './compute.js';

export const DEFAULT_SETUP_CONFIG = {
  entry_interval: '15_SECOND',
  entry_candles: 260,
  min_entry_candles: 200,
  osc_interval: '5_MINUTE',
  osc_candles: 60,
  trend_interval: '5_MINUTE',
  trend_candles: 60,

  // Price must sit within this % of every EMA. Requiring all three at once is
  // deliberately strict: it only fires when the EMAs have converged and price
  // has pulled back into the cluster, which is the setup being described.
  // Useful range is 3-5; below 3 the setup almost never fires.
  ema_proximity_pct: 5,
  require_price_above_ema200: false,

  require_trend_supertrend_bull: true,

  // Stochastic RSI (rsi, stoch, %K, %D) = 14, 14, 3, 3
  stochrsi_rsi_period: 14,
  stochrsi_stoch_period: 14,
  stochrsi_k_smooth: 3,
  stochrsi_d_smooth: 3,
  supertrend_period: 10,
  supertrend_multiplier: 3,

  // Entry threshold, read on the entry timeframe.
  stochrsi_bottom_max: 20,
  require_stochrsi_cross_up: false,

  // Exits
  exit_on_supertrend_flip: true,
  exit_on_ema_death_cross: true,
  // Exit threshold, read on the osc timeframe.
  exit_stochrsi_overbought: 80,
};

/**
 * How old a token must be before this setup can produce any opinion at all.
 *
 * Derived rather than hardcoded, because the binding constraint is not
 * obvious and moves whenever an interval changes: with the defaults it is the
 * 15m Supertrend at 11 bars (165 min), not the 200-bar EMA on 15s candles
 * (50 min). Getting this wrong does not error — the gate just silently never
 * passes — so the age gate reads this instead of a fixed number.
 */
export function minimumHistoryMs(config = {}) {
  const cfg = { ...DEFAULT_SETUP_CONFIG, ...config };
  // Only what ENTRY needs belongs here. The exit oscillator lives on a slower
  // timeframe and warms up long after entry is possible; gating entry on it
  // would reject tokens the strategy can legitimately trade. An exit indicator
  // that is not ready simply produces no exit signal — TP, SL and trailing
  // still cover the position.
  const needs = [
    [cfg.min_entry_candles, cfg.entry_interval],
    // StochRSI stacks two lookbacks plus two smoothings, so it warms up far
    // later than a plain RSI would — 32 bars with the default 14/14/3/3.
    [stochRsiBars({
      rsiPeriod: cfg.stochrsi_rsi_period,
      stochPeriod: cfg.stochrsi_stoch_period,
      kSmooth: cfg.stochrsi_k_smooth,
      dSmooth: cfg.stochrsi_d_smooth,
    }), cfg.entry_interval],
    // ATR seeds at `period` bars and a direction needs the bar after it.
    [cfg.supertrend_period + 1, cfg.trend_interval],
  ];
  return Math.max(...needs.map(([bars, interval]) => bars * intervalSeconds(interval) * 1000));
}

const pct = (price, level) => (level > 0 ? (price - level) / level * 100 : null);

/**
 * Evaluates the entry setup. Returns the same {passed, failures} shape used by
 * the existing filter layer, plus `details` for logging and the LLM prompt.
 *
 * A missing (warmed-up-but-null) indicator always fails rather than passes —
 * unlike the optional-enrichment gates, these rules ARE the strategy, so
 * "unknown" must never open a position.
 */
export function evaluateIndicatorSetup(context, config = {}) {
  const cfg = { ...DEFAULT_SETUP_CONFIG, ...config };
  const failures = [];
  const entry = context?.entry || null;
  const osc = context?.osc || null;
  const trend = context?.trend || null;
  const details = {
    entryInterval: cfg.entry_interval,
    oscInterval: cfg.osc_interval,
    trendInterval: cfg.trend_interval,
    entryCandles: entry?.candles ?? 0,
    oscCandles: osc?.candles ?? 0,
    trendCandles: trend?.candles ?? 0,
  };

  if (!entry) {
    return { passed: false, failures: [`entry candles: none for ${cfg.entry_interval}`], details };
  }

  // ── History gate: no opinion at all until 200 bars exist ───────────────────
  if (entry.candles < cfg.min_entry_candles) {
    failures.push(`entry candles: ${entry.candles} < ${cfg.min_entry_candles} required on ${cfg.entry_interval}`);
    // Everything below reads EMA200, so stop here rather than pile on noise.
    return { passed: false, failures, details: { ...details, warmup: true, barsNeeded: cfg.min_entry_candles - entry.candles } };
  }

  const price = entry.price;
  const emas = { ema50: entry.ema50, ema100: entry.ema100, ema200: entry.ema200 };
  const missing = Object.entries(emas).filter(([, value]) => value === null).map(([key]) => key);
  if (price === null || missing.length) {
    failures.push(`EMA unavailable: ${missing.join(', ') || 'no price'}`);
    return { passed: false, failures, details };
  }

  // ── Price inside the EMA cluster ───────────────────────────────────────────
  const distances = {
    ema50: pct(price, emas.ema50),
    ema100: pct(price, emas.ema100),
    ema200: pct(price, emas.ema200),
  };
  details.emaDistancePct = distances;
  details.emaClusterSpreadPct = pct(Math.max(...Object.values(emas)), Math.min(...Object.values(emas)));
  for (const [key, distance] of Object.entries(distances)) {
    if (Math.abs(distance) > cfg.ema_proximity_pct) {
      failures.push(`${key} proximity: ${distance.toFixed(2)}% outside ±${cfg.ema_proximity_pct}%`);
    }
  }
  if (cfg.require_price_above_ema200 && price <= emas.ema200) {
    failures.push(`price below EMA200: ${distances.ema200.toFixed(2)}%`);
  }

  // ── Trend filter on the higher timeframe ──────────────────────────────────
  details.supertrendDirection = trend?.supertrendDirection ?? null;
  details.supertrend = trend?.supertrend ?? null;
  if (cfg.require_trend_supertrend_bull) {
    if (!trend || trend.supertrendDirection === null) {
      failures.push(`supertrend ${cfg.trend_interval}: unavailable (${trend?.candles ?? 0} candles)`);
    } else if (trend.supertrendDirection !== 1) {
      failures.push(`supertrend ${cfg.trend_interval}: bearish`);
    }
  }

  // ── Stochastic RSI at the bottom, on the entry timeframe ──────────────────
  details.stochRsiK = entry.stochRsiK ?? null;
  details.stochRsiD = entry.stochRsiD ?? null;
  details.exitStochRsiK = osc?.stochRsiK ?? null;
  if (entry.stochRsiK === null || entry.stochRsiK === undefined) {
    failures.push(`StochRSI ${cfg.entry_interval}: unavailable (${entry.candles} candles)`);
  } else {
    if (entry.stochRsiK > cfg.stochrsi_bottom_max) {
      failures.push(`StochRSI %K ${cfg.entry_interval}: ${entry.stochRsiK.toFixed(1)} > ${cfg.stochrsi_bottom_max}`);
    }
    if (cfg.require_stochrsi_cross_up && !entry.stochRsiCrossUp) {
      failures.push(`StochRSI ${cfg.entry_interval}: no %K/%D cross up on the last bar`);
    }
  }

  return { passed: failures.length === 0, failures, details };
}

/**
 * Indicator-based exit. Returns a reason string or null, and is meant to run
 * ahead of the existing TP/SL/trailing checks — those stay as the safety net.
 */
export function evaluateIndicatorExit(context, config = {}) {
  const cfg = { ...DEFAULT_SETUP_CONFIG, ...config };
  const entry = context?.entry || null;
  const osc = context?.osc || null;
  const trend = context?.trend || null;

  if (cfg.exit_on_supertrend_flip && trend?.supertrendFlippedDown) return 'ST_FLIP';
  if (cfg.exit_on_ema_death_cross && entry?.emaDeathCross) return 'EMA_CROSS';
  if (cfg.exit_stochrsi_overbought > 0 && osc?.stochRsiK !== null && osc?.stochRsiK !== undefined
    && osc.stochRsiK >= cfg.exit_stochrsi_overbought && osc.stochRsiCrossDown) {
    return 'STOCHRSI_EXIT';
  }
  return null;
}
