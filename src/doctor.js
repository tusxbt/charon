// Live connectivity check: the counterpart to preflight, which is deliberately
// offline. This one makes real requests and answers the two questions that
// otherwise only surface as "the bot runs but never trades":
//
//   1. does the chart API actually serve the configured candle intervals?
//   2. does the signal server still list tokens old enough for those intervals?
//
//   npm run doctor            uses a mint from the signal server
//   npm run doctor <mint>     uses a mint you name

import 'dotenv/config';
import axios from 'axios';
import { SIGNAL_SERVER_URL, SIGNAL_SERVER_KEY, JSON_HEADERS } from './config.js';
import { initDb } from './db/connection.js';
import { activeStrategy } from './db/settings.js';
import { minimumHistoryMs } from './indicators/entry.js';
import { indicatorSnapshot } from './indicators/snapshot.js';

const MIN = 60 * 1000;
let problems = 0;
const fail = (msg) => { problems++; console.log(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);
const info = (msg) => console.log(`        ${msg}`);

initDb();
const strat = activeStrategy();
const requiredAgeMs = strat.use_indicators
  ? Math.max(Number(strat.token_age_min_ms || 0), minimumHistoryMs(strat))
  : Number(strat.token_age_min_ms || 0);

console.log(`\nCharon doctor — strategy "${strat.id}"\n`);

// ── 1. Signal server ─────────────────────────────────────────────────────────
console.log('Signal server');
let signals = [];
try {
  const url = new URL('/api/signals', SIGNAL_SERVER_URL);
  url.searchParams.set('limit', '100');
  url.searchParams.set('minSources', '1');
  const res = await axios.get(url.toString(), {
    timeout: 15_000,
    headers: SIGNAL_SERVER_KEY ? { 'x-api-key': SIGNAL_SERVER_KEY } : {},
  });
  signals = Array.isArray(res.data?.signals) ? res.data.signals : [];
  ok(`reachable, ${signals.length} signals returned`);
  if (!signals.length) fail('the feed is empty — nothing to screen right now');
} catch (err) {
  const status = err.response?.status;
  fail(`${status || ''} ${err.message}`.trim());
  if (status === 401 || status === 403) info('the API key was rejected');
}

// ── 2. Are any of them old enough? ───────────────────────────────────────────
if (signals.length && requiredAgeMs > 0) {
  console.log('\nToken age vs. indicator requirement');
  const ages = signals.map(s => Number(s.ageMs)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ages.length) {
    fail('no signal carries an ageMs field — the age gate cannot work');
    info('every token would be treated as age 0 and skipped');
  } else {
    const median = ages[Math.floor(ages.length / 2)];
    info(`required: >= ${(requiredAgeMs / MIN).toFixed(0)} min`);
    info(`feed ages: min ${(ages[0] / MIN).toFixed(0)} / median ${(median / MIN).toFixed(0)} / max ${(ages[ages.length - 1] / MIN).toFixed(0)} min`);
    const eligible = ages.filter(age => age >= requiredAgeMs).length;
    if (eligible === 0) {
      fail(`0 of ${ages.length} tokens are old enough — the bot would never enter`);
      info('either lower the timeframes or use a feed that keeps older tokens');
    } else {
      ok(`${eligible} of ${ages.length} tokens are old enough`);
    }
  }
}

// ── 3. Candle intervals ──────────────────────────────────────────────────────
const argMint = process.argv[2];
const mint = argMint || signals.find(s => s.mint)?.mint;

if (!strat.use_indicators) {
  console.log('\nCandles\n        skipped — the active strategy does not use indicators');
} else if (!mint) {
  console.log('\nCandles');
  fail('no mint to test with — pass one: npm run doctor <mint>');
} else {
  console.log(`\nCandles for ${mint.slice(0, 8)}...`);
  const intervals = [...new Set([strat.entry_interval, strat.osc_interval, strat.trend_interval])];
  for (const interval of intervals) {
    const want = interval === strat.entry_interval ? strat.entry_candles : strat.osc_candles;
    try {
      const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
      url.searchParams.set('interval', interval);
      url.searchParams.set('to', String(Date.now()));
      url.searchParams.set('candles', String(want));
      url.searchParams.set('type', 'price');
      url.searchParams.set('quote', 'native');
      const res = await axios.get(url.toString(), { timeout: 15_000, headers: JSON_HEADERS });
      const candles = Array.isArray(res.data?.candles) ? res.data.candles : [];
      if (!candles.length) {
        fail(`${interval}: accepted but returned 0 candles`);
        continue;
      }
      const need = interval === strat.entry_interval ? strat.min_entry_candles : 32;
      if (candles.length < need) {
        fail(`${interval}: only ${candles.length} candles, need ${need} for this token`);
      } else {
        ok(`${interval}: ${candles.length} candles`);
      }
      if (interval === strat.entry_interval) {
        const snap = indicatorSnapshot(candles, { ema_periods: [50, 100, 200] });
        info(`EMA50 ${snap.ema50?.toFixed(8) ?? 'null'} / EMA200 ${snap.ema200?.toFixed(8) ?? 'null'}`);
      }
      if (interval === strat.osc_interval) {
        const snap = indicatorSnapshot(candles, {
          stochrsi_rsi_period: strat.stochrsi_rsi_period, stochrsi_stoch_period: strat.stochrsi_stoch_period,
          supertrend_period: strat.supertrend_period, supertrend_multiplier: strat.supertrend_multiplier,
        });
        info(`RSI ${snap.rsi?.toFixed(1) ?? 'null'} / StochRSI %K ${snap.stochRsiK?.toFixed(1) ?? 'null'} / Supertrend ${snap.supertrendDirection ?? 'null'}`);
      }
    } catch (err) {
      const status = err.response?.status;
      fail(`${interval}: ${status || ''} ${err.message}`.trim());
      if (status === 400 || status === 404) info(`this interval is probably not supported — try a larger one`);
      if (status === 429) info('rate limited, not a support problem — retry in a minute');
    }
  }
}

console.log(problems === 0
  ? '\nAll live checks passed.\n'
  : `\n${problems} problem${problems > 1 ? 's' : ''} above. The bot will run, but may never enter a trade.\n`);
process.exit(problems === 0 ? 0 : 1);
