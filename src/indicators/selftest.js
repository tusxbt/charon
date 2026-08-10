// Self-test for the indicator math. No network, no DB — run with:
//   node src/indicators/selftest.js
//
// RSI is checked against Wilder's published worked example; the rest are
// checked against hand-computable series and structural invariants.

import { ema, sma, rsi, stochastic, atr, supertrend, crossedOver, crossedUnder } from './compute.js';
import { indicatorSnapshot } from './snapshot.js';

let failures = 0;
const round = (value, dp = 2) => (value === null ? null : Number(value.toFixed(dp)));

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

// ── EMA: seeded with SMA(period), k = 2/(period+1) ────────────────────────────
// On 1..10 with period 3 the seed is 2 and k is 0.5, so each step is the mean
// of the new value and the previous EMA — an exact integer sequence.
check('ema(1..10, 3)', ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3),
  [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
check('ema returns all-null below period', ema([1, 2], 5), [null, null]);
check('sma(1..5, 3)', sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);

// ── RSI: Wilder's worked example ─────────────────────────────────────────────
// Full precision matters here: rounding these to 2dp shifts the first RSI from
// 70.53 to 70.46, which would make the reference values look wrong.
const wilder = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
  45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028,
  46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
  45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628,
  43.1314,
];
const rsiOut = rsi(wilder, 14);
check('rsi first value warms up at index 14', rsiOut.slice(0, 14).every(v => v === null), true);
check('rsi(14) first three values', [round(rsiOut[14]), round(rsiOut[15]), round(rsiOut[16])],
  [70.53, 66.32, 66.55]);
check('rsi(14) tail', [round(rsiOut[30]), round(rsiOut[31]), round(rsiOut[32])],
  [37.30, 33.08, 37.77]);

// ── Stochastic: close at the top of the range reads 100 ──────────────────────
const rising = Array.from({ length: 30 }, (_, i) => i + 1);
const stochRising = stochastic(rising, rising, rising, { kPeriod: 14, kSmooth: 3, dPeriod: 3 });
check('stoch %K = 100 on a monotonic rise', round(stochRising.k[29], 6), 100);
const flat = new Array(30).fill(5);
const stochFlat = stochastic(flat, flat, flat, { kPeriod: 14, kSmooth: 3, dPeriod: 3 });
check('stoch on a flat series is neutral 50, not 0/100', round(stochFlat.k[29], 6), 50);

// ── ATR: constant bar height means ATR equals that height ────────────────────
const h = new Array(30).fill(11);
const l = new Array(30).fill(10);
const c = new Array(30).fill(10.5);
check('atr of constant 1-wide bars', round(atr(h, l, c, 10)[29], 6), 1);

// ── Supertrend: direction flips on a real reversal, line brackets price ──────
const up = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
const down = Array.from({ length: 60 }, (_, i) => 218 - i * 3);
const closes = [...up, ...down];
const highs = closes.map(v => v + 1);
const lows = closes.map(v => v - 1);
const st = supertrend(highs, lows, closes, { period: 10, multiplier: 3 });
check('supertrend is bullish at the end of the up leg', st.direction[59], 1);
check('supertrend line sits below price in an uptrend', st.line[59] < closes[59], true);
check('supertrend is bearish at the end of the down leg', st.direction[119], -1);
check('supertrend line sits above price in a downtrend', st.line[119] > closes[119], true);
check('supertrend flips exactly once on one reversal',
  st.direction.filter((d, i) => i > 0 && d !== null && st.direction[i - 1] !== null && d !== st.direction[i - 1]).length, 1);

// ── Crosses ──────────────────────────────────────────────────────────────────
check('crossedOver detects an upward cross', crossedOver([1, 3], [2, 2]), true);
check('crossedOver ignores an already-above series', crossedOver([3, 4], [2, 2]), false);
check('crossedUnder detects a downward cross', crossedUnder([3, 1], [2, 2]), true);
check('cross with a null leg is false, not a crash', crossedOver([null, 3], [2, 2]), false);

// ── Snapshot: warmup semantics for a newpair token ───────────────────────────
const candle = (i, price) => ({ time: 1_700_000_000 + i * 60, open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 10 });

const fresh = indicatorSnapshot(Array.from({ length: 12 }, (_, i) => candle(i, 100 + i)));
check('fresh token is flagged as warmup', fresh.warmup, true);
check('fresh token has no EMA200', fresh.ema200, null);
check('fresh token reports EMA200 as not ready', fresh.ready.ema200, false);
check('fresh token has null stack, not false', fresh.emaStackBullish, null);
check('fresh token reports how many bars it still needs', fresh.barsNeeded, 200 - 12);

const mature = indicatorSnapshot(Array.from({ length: 260 }, (_, i) => candle(i, 100 + i)));
check('mature token is out of warmup', mature.warmup, false);
check('mature token has EMA200', mature.ema200 !== null, true);
check('a steady rise produces a bullish EMA stack', mature.emaStackBullish, true);
check('mature token has every indicator ready',
  Object.values(mature.ready).every(Boolean), true);
check('empty candle array does not crash', indicatorSnapshot([]).candles, 0);

console.log(failures === 0 ? '\nAll indicator checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
