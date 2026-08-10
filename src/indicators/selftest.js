// Self-test for the indicator math. No network, no DB — run with:
//   node src/indicators/selftest.js
//
// RSI is checked against Wilder's published worked example; the rest are
// checked against hand-computable series and structural invariants.

import { ema, sma, rsi, stochRsi, stochRsiBars, atr, supertrend, crossedOver, crossedUnder } from './compute.js';
import { indicatorSnapshot } from './snapshot.js';
import { evaluateIndicatorSetup, evaluateIndicatorExit, minimumHistoryMs } from './entry.js';

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

// ── sma must skip warmup slots, not read them as zero ────────────────────────
// Number(null) is 0, so an sma that does not check explicitly starts emitting
// values while the series is still warming up. That defeats the whole
// null-means-unknown contract, and it is invisible in the final value.
check('sma treats leading nulls as unknown, not as 0',
  sma([null, null, 1, 2, 3], 3), [null, null, null, null, 2]);
check('sma restarts its window after a null gap',
  sma([1, 2, 3, null, 4, 5, 6], 3), [null, null, 2, null, null, null, 5]);

// ── Stochastic RSI (14, 14, 3, 3) ────────────────────────────────────────────
check('stochRsiBars(14,14,3,3) is 32', stochRsiBars(), 32);
const srSeries = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
const sr = stochRsi(srSeries);
check('stochRsi raw warms up only after RSI plus the stoch window',
  sr.raw.findIndex(v => v !== null), 27);
check('stochRsi %K warms up two bars after raw', sr.k.findIndex(v => v !== null), 29);
check('stochRsi %D warms up exactly at stochRsiBars()',
  sr.d.findIndex(v => v !== null) + 1, stochRsiBars());
const srValues = sr.k.filter(v => v !== null);
check('stochRsi %K stays within 0..100',
  srValues.every(v => v >= 0 && v <= 100), true);
// A monotonic rise pins RSI at 100, so its stochastic range is flat.
const srFlat = stochRsi(Array.from({ length: 60 }, (_, i) => 100 + i));
check('a pinned RSI reads neutral 50, never 0 (which would look oversold)',
  round(srFlat.k[59], 6), 50);
// The whole reason for using StochRSI here: a shallow pullback that leaves raw
// RSI mid-range still registers at the bottom of the StochRSI range.
const pull = [];
let pp = 100;
for (let i = 0; i < 100; i++) { pp += 0.8; pull.push(pp); }
for (let i = 0; i < 5; i++) { pp -= 2; pull.push(pp); }
check('a shallow pullback leaves raw RSI mid-range', round(rsi(pull, 14).at(-1)) > 40, true);
check('but reads at the bottom on StochRSI', round(stochRsi(pull).k.at(-1)) < 20, true);

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
check('mature token exposes a StochRSI reading', mature.stochRsiK !== null, true);
check('empty candle array does not crash', indicatorSnapshot([]).candles, 0);

// ── Entry rules: price in the EMA zone, trend bullish, oscillators bottomed ──
const setupContext = (overrides = {}) => ({
  entry: {
    candles: 260, price: 100, ema50: 100.5, ema100: 99.4, ema200: 101.2,
    emaDeathCross: false, warmup: false,
    ...(overrides.entry || {}),
  },
  osc: {
    candles: 60, rsi: 47, stochRsiK: 12, stochRsiD: 15,
    stochRsiCrossUp: true, stochRsiCrossDown: false,
    ...(overrides.osc || {}),
  },
  trend: { candles: 60, supertrendDirection: 1, supertrend: 95, supertrendFlippedDown: false, ...(overrides.trend || {}) },
});

const good = evaluateIndicatorSetup(setupContext());
check('a complete setup passes', good.passed, true);
check('a complete setup reports no failures', good.failures, []);

const young = evaluateIndicatorSetup(setupContext({ entry: { candles: 120 } }));
check('under 200 candles fails', young.passed, false);
check('under 200 candles fails only on history, not on every rule', young.failures.length, 1);
check('under 200 candles reports the shortfall', young.details.barsNeeded, 80);

const far = evaluateIndicatorSetup(setupContext({ entry: { ema200: 140 } }));
check('price outside the EMA zone fails', far.passed, false);
check('the failure names the EMA that is too far',
  far.failures.some(f => f.startsWith('ema200 proximity')), true);

const bear = evaluateIndicatorSetup(setupContext({ trend: { supertrendDirection: -1 } }));
check('bearish trend supertrend fails', bear.failures.some(f => f.includes('supertrend')), true);

const noTrend = evaluateIndicatorSetup({ ...setupContext(), trend: null });
check('missing trend timeframe fails rather than passes', noTrend.passed, false);

check('StochRSI above the bottom threshold fails',
  evaluateIndicatorSetup(setupContext({ osc: { stochRsiK: 55 } })).failures.some(f => f.startsWith('StochRSI %K 5_MINUTE:')), true);
check('raw RSI is not gated — only StochRSI is',
  evaluateIndicatorSetup(setupContext({ osc: { rsi: 88 } })).passed, true);
check('a null StochRSI fails instead of passing silently',
  evaluateIndicatorSetup(setupContext({ osc: { stochRsiK: null } })).passed, false);
check('a missing oscillator timeframe fails',
  evaluateIndicatorSetup({ ...setupContext(), osc: null }).passed, false);
check('the oscillator is read from the osc TF, not the entry TF',
  evaluateIndicatorSetup(setupContext({ entry: { stochRsiK: 99 } })).passed, true);
check('require_stochrsi_cross_up is off by default',
  evaluateIndicatorSetup(setupContext({ osc: { stochRsiCrossUp: false } })).passed, true);
check('require_stochrsi_cross_up rejects when enabled',
  evaluateIndicatorSetup(setupContext({ osc: { stochRsiCrossUp: false } }), { require_stochrsi_cross_up: true }).passed, false);
check('default proximity is 5%: a 4.5% gap passes',
  evaluateIndicatorSetup(setupContext({ entry: { ema200: 104.5 } })).passed, true);
check('default proximity is 5%: a 6% gap fails',
  evaluateIndicatorSetup(setupContext({ entry: { ema200: 106 } })).passed, false);
check('proximity tolerance is configurable down to 3%',
  evaluateIndicatorSetup(setupContext({ entry: { ema200: 104.5 } }), { ema_proximity_pct: 3 }).passed, false);

// ── Minimum history is derived from the configured intervals ────────────────
const MIN = 60 * 1000;
check('default minimum history is the 5m StochRSI at 32 bars (160 min)',
  minimumHistoryMs() / MIN, 160);
// With the oscillator on 1m the binding constraint becomes the 5m Supertrend
// at 11 bars (55 min), not the 200-bar EMA on 15s candles (50 min).
check('a 1m oscillator TF drops the floor to the 5m Supertrend (55 min)',
  minimumHistoryMs({ osc_interval: '1_MINUTE' }) / MIN, 55);
check('and with a 1m trend TF too it is the 200-bar EMA (50 min)',
  minimumHistoryMs({ osc_interval: '1_MINUTE', trend_interval: '1_MINUTE' }) / MIN, 50);
check('a 1m entry TF raises the floor to 200 min',
  minimumHistoryMs({ entry_interval: '1_MINUTE' }) / MIN, 200);
check('an unknown interval throws rather than silently passing', (() => {
  try { minimumHistoryMs({ osc_interval: '7_MINUTE' }); return false; } catch { return true; }
})(), true);

// ── Exit rules ───────────────────────────────────────────────────────────────
check('supertrend flip triggers an exit',
  evaluateIndicatorExit(setupContext({ trend: { supertrendFlippedDown: true } })), 'ST_FLIP');
check('EMA death cross triggers an exit',
  evaluateIndicatorExit(setupContext({ entry: { emaDeathCross: true } })), 'EMA_CROSS');
check('overbought StochRSI alone does not exit without a cross down',
  evaluateIndicatorExit(setupContext({ osc: { stochRsiK: 85 } })), null);
check('overbought StochRSI plus a cross down exits',
  evaluateIndicatorExit(setupContext({ osc: { stochRsiK: 85, stochRsiCrossDown: true } })), 'STOCHRSI_EXIT');
check('a healthy position is not exited', evaluateIndicatorExit(setupContext()), null);
check('exit rules can be switched off',
  evaluateIndicatorExit(setupContext({ trend: { supertrendFlippedDown: true } }), { exit_on_supertrend_flip: false }), null);

console.log(failures === 0 ? '\nAll indicator checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
