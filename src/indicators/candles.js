// Candle store: fetches OHLCV from Jupiter and caches it in SQLite so the
// 10-second position monitor never re-downloads 200 bars per token per tick.
//
// The API is "count back from `to`" rather than a from/to range, so an
// incremental refresh asks only for the bars that could have closed since the
// newest stored one, plus a small overlap to correct the still-forming bar.

import axios from 'axios';
import { JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';
import { db } from '../db/connection.js';

const INTERVAL_SECONDS = {
  '1_SECOND': 1,
  '5_SECOND': 5,
  '15_SECOND': 15,
  '30_SECOND': 30,
  '1_MINUTE': 60,
  '5_MINUTE': 300,
  '15_MINUTE': 900,
  '30_MINUTE': 1800,
  '1_HOUR': 3600,
  '4_HOUR': 14400,
  '1_DAY': 86400,
};

// Overlap on incremental fetches: the newest stored bar is usually still open,
// so we always re-pull a few and let the upsert correct them.
const REFRESH_OVERLAP_BARS = 3;
const MAX_FETCH_BARS = 500;

let backoffUntil = 0;

export function intervalSeconds(interval) {
  const seconds = INTERVAL_SECONDS[interval];
  if (!seconds) throw new Error(`Unknown candle interval '${interval}'. Known: ${Object.keys(INTERVAL_SECONDS).join(', ')}`);
  return seconds;
}

export function knownIntervals() {
  return Object.keys(INTERVAL_SECONDS);
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
  const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
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
  const newest = newestStoredTime(mint, interval);
  const have = storedCount(mint, interval);

  let needed;
  if (newest === null || have < limit) {
    needed = limit;
  } else {
    const elapsedBars = Math.ceil((now() / 1000 - newest) / seconds);
    needed = Math.max(0, elapsedBars) + REFRESH_OVERLAP_BARS;
    if (needed <= REFRESH_OVERLAP_BARS && elapsedBars < 1) needed = 0;
  }

  if (needed > 0 && now() >= backoffUntil) {
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

export function pruneCandles(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = Math.floor((now() - maxAgeMs) / 1000);
  const result = db.prepare('DELETE FROM candles WHERE time < ?').run(cutoff);
  if (result.changes > 0) console.log(`[candles] pruned ${result.changes} rows`);
  return result.changes;
}
