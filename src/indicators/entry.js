// Pure entry/exit rules for the multi-timeframe indicator setup:
//   entry TF  (15s default) — price sitting in the EMA 50/100/200 zone,
//                             with RSI and Stochastic at the bottom
//   trend TF  (15m default) — Supertrend bullish
//
// Failure strings mirror the style of candidateBuilder.filterCandidate so both
// filter layers read the same way in logs and Telegram messages.

export const DEFAULT_SETUP_CONFIG = {
  entry_interval: '15_SECOND',
  entry_candles: 260,
  min_entry_candles: 200,
  trend_interval: '15_MINUTE',
  trend_candles: 80,

  // Price must sit within this % of every EMA. Requiring all three at once is
  // deliberately strict: it only fires when the EMAs have converged and price
  // has pulled back into the cluster, which is the setup being described.
  ema_proximity_pct: 3,
  require_price_above_ema200: false,

  require_trend_supertrend_bull: true,

  rsi_bottom_max: 35,
  stoch_bottom_max: 20,
  require_stoch_cross_up: false,

  // Exits
  exit_on_supertrend_flip: true,
  exit_on_ema_death_cross: true,
  exit_rsi_overbought: 80,
};

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
  const trend = context?.trend || null;
  const details = {
    entryInterval: cfg.entry_interval,
    trendInterval: cfg.trend_interval,
    entryCandles: entry?.candles ?? 0,
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

  // ── Oscillators at the bottom ─────────────────────────────────────────────
  details.rsi = entry.rsi;
  details.stochK = entry.stochK;
  details.stochD = entry.stochD;
  if (entry.rsi === null) failures.push('RSI: unavailable');
  else if (entry.rsi > cfg.rsi_bottom_max) failures.push(`RSI: ${entry.rsi.toFixed(1)} > ${cfg.rsi_bottom_max}`);

  if (entry.stochK === null) failures.push('Stochastic: unavailable');
  else if (entry.stochK > cfg.stoch_bottom_max) failures.push(`Stoch %K: ${entry.stochK.toFixed(1)} > ${cfg.stoch_bottom_max}`);

  if (cfg.require_stoch_cross_up && !entry.stochCrossUp) {
    failures.push('Stoch: no %K/%D cross up on the last bar');
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
  const trend = context?.trend || null;

  if (cfg.exit_on_supertrend_flip && trend?.supertrendFlippedDown) return 'ST_FLIP';
  if (cfg.exit_on_ema_death_cross && entry?.emaDeathCross) return 'EMA_CROSS';
  if (cfg.exit_rsi_overbought > 0 && entry?.rsi !== null && entry?.rsi !== undefined
    && entry.rsi >= cfg.exit_rsi_overbought && entry.stochCrossDown) {
    return 'RSI_EXIT';
  }
  return null;
}
