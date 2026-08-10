// Candle store: fetches OHLCV from Jupiter and caches it in SQLite so the
// 10-second position monitor never re-downloads 200 bars per token per tick.
//
// The API is "count back from `to`" rather than a from/to range, so an
// incremental refresh asks only for the bars that could have closed since the
// newest stored one, plus a small overlap to correct the still-forming bar.

import axios from 'axios';
import { JSON_HEADERS, JUPITER_DATA_URL } from '../config.js';
import { now } from '../utils.js';
import { db } from '../db/connection.js';
import { intervalSeconds } from './intervals.js';

export { intervalSeconds, knownIntervals } from './intervals.js';

// Overlap on incremental fetches: the newest stored bar is usually still open,
// so we always re-pull a few and let the upsert correct them.
const REFRESH_OVERLAP_BARS = 3;
const MAX_FETCH_BARS = 500;

// A series is refreshed at most this often, expressed as a fraction of its own
// bar length. Without it the cache is decorative: the position monitor runs
// every 10 seconds, and the newest stored bar is always the one still forming,
// so every single call finds "new" data to pull. A 5-minute series would be
// re-fetched 30 times per bar.
const REFRESH_FRACTION = 0.2;
const MIN_REFRESH_MS = 3_000;

let backoffUntil = 0;
const lastFetchAt = new Map();

const seriesKey = (mint, interval) => `${mint}:${interval}`;

export function refreshIntervalMs(intervalSec) {
  return Math.max(MIN_REFRESH_MS, Math.round(intervalSec * 1000 * REFRESH_FRACTION));
}

/**
 * How many bars to request, or 0 to serve from cache. Pure so the decision can
 * be tested without a network or a database — it is the part that determines
 * whether the bot stays inside Jupiter's rate limit.
 */
export function barsToFetch({ nowMs, newestTimeSec, haveCount, limit, intervalSec, lastFetchMs = null }) {
  // Nothing stored: there is no cache to serve and no reason to wait.
  if (newestTimeSec === null || haveCount === 0) return limit;

  // Cooldown comes before the "window not full yet" case below. A token with
  // less history than `limit` never fills the window, so without this it would
  // re-download the whole window on every single call, forever.
  if (lastFetchMs !== null && nowMs - lastFetchMs < refreshIntervalMs(intervalSec)) return 0;

  if (haveCount < limit) return limit;

  // floor, not ceil: while still inside the forming bar this is 0, and the
  // overlap alone refreshes that bar.
  const elapsedBars = Math.floor((nowMs / 1000 - newestTimeSec) / intervalSec);
  return Math.max(0, elapsedBars) + REFRESH_OVERLAP_BARS;
}

// Jupiter has returned both second and millisecond timestamps across endpoints;
// normalise to seconds so the primary key stays stable either way.
function normalizeTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time)) return null;
  return time > 1e12 ? Math.floor(time / 1000) : Math.floor(time);
}

function storeCandles(mint, interval, candles) {
  if (!candles.length) return 0;
  const insert = db.prepare(`
    INSERT INTO candles (mint, interval, time, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint, interval, time) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, volume = excluded.volume
  `);
  return db.transaction(() => {
    let written = 0;
    for (const candle of candles) {
      const time = normalizeTime(candle.time);
      const close = Number(candle.close);
      if (time === null || !Number.isFinite(close)) continue;
      insert.run(
        mint, interval, time,
        Number(candle.open ?? close), Number(candle.high ?? close),
        Number(candle.low ?? close), close, Number(candle.volume ?? 0),
      );
      written++;
    }
    return written;
  })();
}

export function storedCandles(mint, interval, limit) {
  const rows = db.prepare(`
    SELECT time, open, high, low, close, volume FROM candles
    WHERE mint = ? AND interval = ?
    ORDER BY time DESC LIMIT ?
  `).all(mint, interval, limit);
  return rows.reverse();
}

function newestStoredTime(mint, interval) {
  return db.prepare('SELECT MAX(time) AS time FROM candles WHERE mint = ? AND interval = ?')
    .get(mint, interval)?.time ?? null;
}

function storedCount(mint, interval) {
  return db.prepare('SELECT COUNT(*) AS count FROM candles WHERE mint = ? AND interval = ?')
    .get(mint, interval).count;
}

async function fetchFromApi(mint, interval, count) {
  const url = new URL(`${JUPITER_DATA_URL}/v2/charts/${mint}`);
  url.searchParams.set('interval', interval);
  url.searchParams.set('to', String(now()));
  url.searchParams.set('candles', String(Math.min(count, MAX_FETCH_BARS)));
  url.searchParams.set('type', 'price');
  url.searchParams.set('quote', 'native');
  const res = await axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS });
  return Array.isArray(res.data?.candles) ? res.data.candles : [];
}

/**
 * Returns up to `limit` candles for a mint, refreshing only what is missing.
 * On any API failure it falls back to whatever is already stored, so a rate
 * limit degrades the signal rather than crashing the pipeline.
 */
export async function getCandles(mint, interval, limit) {
  const seconds = intervalSeconds(interval);
  const key = seriesKey(mint, interval);
  const needed = barsToFetch({
    nowMs: now(),
    newestTimeSec: newestStoredTime(mint, interval),
    haveCount: storedCount(mint, interval),
    limit,
    intervalSec: seconds,
    lastFetchMs: lastFetchAt.get(key) ?? null,
  });

  if (needed > 0 && now() >= backoffUntil) {
    // Stamped before the request, not after: a failed call must still start the
    // cooldown, otherwise an erroring series is retried on every tick.
    lastFetchAt.set(key, now());
    try {
      const fetched = await fetchFromApi(mint, interval, needed);
      storeCandles(mint, interval, fetched);
    } catch (err) {
      if (err.response?.status === 429) {
        backoffUntil = now() + 30_000;
        console.log(`[candles] 429 on ${interval}, backing off 30s`);
      } else {
        console.log(`[candles] ${mint.slice(0, 8)}... ${interval} ${err.response?.status || ''} ${err.message}`);
      }
    }
  }
  return storedCandles(mint, interval, limit);
}

/**
 * Keeps the newest `keepPerSeries` bars of every series and drops series that
 * have gone quiet for `staleAfterMs`.
 *
 * Pruning by age alone was wrong: 200 bars of a 1-hour series spans 200 hours,
 * so a 24-hour cutoff would delete history the strategy still needs and force a
 * full re-download on the next call. Row count per series is the thing that
 * actually bounds the table.
 */
export function pruneCandles({ keepPerSeries = 600, staleAfterMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const trimmed = db.prepare(`
    DELETE FROM candles WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY mint, interval ORDER BY time DESC) AS rn
        FROM candles
      ) WHERE rn > ?
    )
  `).run(keepPerSeries).changes;

  const staleCutoff = Math.floor((now() - staleAfterMs) / 1000);
  const dropped = db.prepare(`
    DELETE FROM candles WHERE (mint, interval) IN (
      SELECT mint, interval FROM candles GROUP BY mint, interval HAVING MAX(time) < ?
    )
  `).run(staleCutoff).changes;

  for (const key of lastFetchAt.keys()) {
    if (now() - lastFetchAt.get(key) > staleAfterMs) lastFetchAt.delete(key);
  }
  if (trimmed || dropped) console.log(`[candles] pruned ${trimmed} old bars, ${dropped} rows from stale series`);
  return trimmed + dropped;
}
