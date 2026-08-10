// Pure indicator math. No I/O, no deps — every function takes plain arrays and
// returns plain arrays of the same length, with `null` wherever the indicator
// has not warmed up yet.
//
// The null-padding is deliberate: a filter must be able to tell "indicator says
// no" apart from "indicator does not know yet". Charon already follows this
// pattern for optional enrichment (see candidateBuilder.js — GMGN rules are only
// enforced when GMGN data exists), and newpair tokens spend their first minutes
// entirely inside the warmup window.

// The explicit null/undefined/'' check matters: Number(null) is 0 and
// Number('') is 0, both of which are finite. Without it every "not warmed up
// yet" slot reads as a real zero, and any moving average over a warming-up
// series starts producing values long before it should.
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const value = num(values[i]);
    if (value === null) { sum = 0; count = 0; continue; }
    sum += value;
    count++;
    if (count > period) {
      sum -= num(values[i - period]) ?? 0;
      count = period;
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values, then recurse.
  let seed = 0;
  for (let i = 0; i < period; i++) {
    const value = num(values[i]);
    if (value === null) return out;
    seed += value;
  }
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    const value = num(values[i]);
    if (value === null) { out[i] = prev; continue; }
    prev = value * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI: the smoothing is 1/period, not the 2/(period+1) used by EMA.
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = (num(closes[i]) ?? 0) - (num(closes[i - 1]) ?? 0);
    if (change >= 0) gainSum += change; else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = (num(closes[i]) ?? 0) - (num(closes[i - 1]) ?? 0);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Stochastic RSI — a stochastic applied to the RSI line, not to price.
 *
 * The distinction is what makes this strategy workable. Raw RSI only reaches
 * oversold after a decline long enough to also flip Supertrend bearish on the
 * same candles, so "Supertrend bullish AND RSI oversold" is close to
 * unreachable. StochRSI rescales RSI against its own recent range, so a
 * shallow pullback inside an intact uptrend reads at the bottom while the
 * trend filter still holds.
 *
 * Parameters follow the usual (rsi, stoch, %K, %D) ordering — 14, 14, 3, 3.
 */
export function stochRsi(closes, { rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3 } = {}) {
  const rsiLine = rsi(closes, rsiPeriod);
  const raw = new Array(closes.length).fill(null);
  for (let i = stochPeriod - 1; i < closes.length; i++) {
    let lowest = Infinity;
    let highest = -Infinity;
    let complete = true;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      const value = rsiLine[j];
      if (value === null) { complete = false; break; }
      if (value < lowest) lowest = value;
      if (value > highest) highest = value;
    }
    if (!complete) continue;
    // A flat RSI range carries no information. 50 keeps it neutral — reading it
    // as 0 would make a token whose RSI is pinned at 100 look maximally
    // oversold, which is the exact opposite of the truth.
    raw[i] = highest === lowest ? 50 : (rsiLine[i] - lowest) / (highest - lowest) * 100;
  }
  const k = kSmooth > 1 ? sma(raw, kSmooth) : raw;
  return { rsi: rsiLine, raw, k, d: sma(k, dSmooth) };
}

// Bars required before %D exists: RSI warms up over rsiPeriod, the stochastic
// window then needs stochPeriod RSI values, and each smoothing costs one more.
export function stochRsiBars({ rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3 } = {}) {
  return rsiPeriod + stochPeriod + kSmooth + dSmooth - 2;
}

export function trueRange(highs, lows, closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const high = num(highs[i]);
    const low = num(lows[i]);
    if (high === null || low === null) continue;
    if (i === 0) { out[i] = high - low; continue; }
    const prevClose = num(closes[i - 1]);
    out[i] = prevClose === null
      ? high - low
      : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return out;
}

// Wilder-smoothed ATR, matching the ATR that Supertrend is normally built on.
export function atr(highs, lows, closes, period = 10) {
  const tr = trueRange(highs, lows, closes);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i] ?? 0;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = (prev * (period - 1) + (tr[i] ?? prev)) / period;
    out[i] = prev;
  }
  return out;
}

// Supertrend with the standard sticky-band rule: a band only moves in the
// favourable direction until price closes through it, which is what stops the
// line from whipsawing on every bar.
export function supertrend(highs, lows, closes, { period = 10, multiplier = 3 } = {}) {
  const atrValues = atr(highs, lows, closes, period);
  const line = new Array(closes.length).fill(null);
  const direction = new Array(closes.length).fill(null);
  let finalUpper = null;
  let finalLower = null;
  let dir = null;

  for (let i = 0; i < closes.length; i++) {
    const atrValue = atrValues[i];
    const high = num(highs[i]);
    const low = num(lows[i]);
    const close = num(closes[i]);
    if (atrValue === null || high === null || low === null || close === null) continue;

    const mid = (high + low) / 2;
    const basicUpper = mid + multiplier * atrValue;
    const basicLower = mid - multiplier * atrValue;
    const prevClose = num(closes[i - 1]);

    finalUpper = (finalUpper === null || basicUpper < finalUpper || (prevClose !== null && prevClose > finalUpper))
      ? basicUpper
      : finalUpper;
    finalLower = (finalLower === null || basicLower > finalLower || (prevClose !== null && prevClose < finalLower))
      ? basicLower
      : finalLower;

    if (dir === null) dir = close >= mid ? 1 : -1;
    else if (close > finalUpper) dir = 1;
    else if (close < finalLower) dir = -1;

    direction[i] = dir;
    line[i] = dir === 1 ? finalLower : finalUpper;
  }
  return { line, direction };
}

export const last = (series) => (Array.isArray(series) && series.length ? series[series.length - 1] : null);

// True on the bar where `series` crossed above `other` — both bars must be
// known, so a fresh warmup never reports a cross it did not see.
export function crossedOver(series, other) {
  const n = Math.min(series.length, other.length);
  if (n < 2) return false;
  const a0 = series[n - 2], a1 = series[n - 1];
  const b0 = other[n - 2], b1 = other[n - 1];
  if ([a0, a1, b0, b1].some(value => value === null || value === undefined)) return false;
  return a0 <= b0 && a1 > b1;
}

export const crossedUnder = (series, other) => crossedOver(other, series);
