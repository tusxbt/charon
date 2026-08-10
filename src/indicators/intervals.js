// Candle interval names and their length in seconds. Kept separate from
// candles.js so the pure rule modules can do interval arithmetic without
// pulling in the database.

export const INTERVAL_SECONDS = {
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

export function intervalSeconds(interval) {
  const seconds = INTERVAL_SECONDS[interval];
  if (!seconds) throw new Error(`Unknown candle interval '${interval}'. Known: ${Object.keys(INTERVAL_SECONDS).join(', ')}`);
  return seconds;
}

export function knownIntervals() {
  return Object.keys(INTERVAL_SECONDS);
}
