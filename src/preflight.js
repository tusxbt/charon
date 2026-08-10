// Configuration preflight: reports what is set, what is missing, and what the
// active strategy will actually require at runtime. Reads .env and the local
// SQLite only — makes no network calls, so it is safe to run before the bot
// has ever started.
//
//   npm run preflight

import 'dotenv/config';
import { initDb } from './db/connection.js';
import { activeStrategy } from './db/settings.js';
import { minimumHistoryMs } from './indicators/entry.js';
import { intervalSeconds, knownIntervals } from './indicators/intervals.js';

const env = (key) => String(process.env[key] || '').trim();
const has = (key) => env(key).length > 0;

let blockers = 0;
let warnings = 0;

const line = (status, label, detail = '') => {
  const mark = { ok: ' ok ', miss: 'MISS', warn: 'warn', off: ' -- ' }[status];
  console.log(`  [${mark}] ${label.padEnd(24)} ${detail}`);
};
const blocker = (label, detail) => { blockers++; line('miss', label, detail); };
const warn = (label, detail) => { warnings++; line('warn', label, detail); };

console.log('\nCharon preflight\n');

// ── Telegram: required in every mode ─────────────────────────────────────────
console.log('Telegram');
has('TELEGRAM_BOT_TOKEN')
  ? line('ok', 'TELEGRAM_BOT_TOKEN', 'set')
  : blocker('TELEGRAM_BOT_TOKEN', 'required — create a bot with @BotFather');
has('TELEGRAM_CHAT_ID')
  ? line('ok', 'TELEGRAM_CHAT_ID', env('TELEGRAM_CHAT_ID'))
  : blocker('TELEGRAM_CHAT_ID', 'required — only this chat is accepted');

// ── Signal source ────────────────────────────────────────────────────────────
console.log('\nSignal source');
if (has('SIGNAL_SERVER_URL')) {
  line('ok', 'SIGNAL_SERVER_URL', env('SIGNAL_SERVER_URL') + ' (server mode)');
  has('SIGNAL_SERVER_KEY')
    ? line('ok', 'SIGNAL_SERVER_KEY', 'set')
    : warn('SIGNAL_SERVER_KEY', 'empty — the server will likely reject requests');
} else {
  warn('SIGNAL_SERVER_URL', 'empty — falls back to standalone mode (Helius websocket)');
}

// ── RPC: validateConfig enforces this even in dry_run ────────────────────────
console.log('\nSolana RPC');
if (has('SOLANA_RPC_URL') && has('SOLANA_WS_URL')) {
  line('ok', 'SOLANA_RPC_URL', 'explicit RPC + WS set');
} else if (has('HELIUS_API_KEY')) {
  line('ok', 'HELIUS_API_KEY', 'set — Helius mainnet URLs will be derived');
} else {
  blocker('HELIUS_API_KEY', 'required unless both SOLANA_RPC_URL and SOLANA_WS_URL are set');
}

// ── Optional enrichment ──────────────────────────────────────────────────────
console.log('\nEnrichment');
if (env('GMGN_ENABLED') === 'false') {
  line('off', 'GMGN', 'disabled — Jupiter/server data is used instead');
} else if (has('GMGN_API_KEY')) {
  line('ok', 'GMGN_API_KEY', 'set');
} else {
  blocker('GMGN_API_KEY', 'required unless GMGN_ENABLED=false');
}
line('ok', 'Jupiter datapi', 'no key needed (candles, price, holders)');

// ── Execution mode ───────────────────────────────────────────────────────────
const mode = env('TRADING_MODE') || 'dry_run';
console.log(`\nExecution (TRADING_MODE=${mode})`);
if (mode === 'dry_run') {
  line('off', 'wallet', 'not needed — trades are simulated into SQLite');
} else {
  has('SOLANA_PRIVATE_KEY')
    ? line('ok', 'SOLANA_PRIVATE_KEY', 'set')
    : blocker('SOLANA_PRIVATE_KEY', `required for ${mode} mode`);
  has('JUPITER_API_KEY')
    ? line('ok', 'JUPITER_API_KEY', 'set')
    : blocker('JUPITER_API_KEY', `required for ${mode} mode (swap execution)`);
  line('ok', 'LIVE_MIN_SOL_RESERVE', `${env('LIVE_MIN_SOL_RESERVE') || '0.02'} SOL kept back after any buy`);
}

// ── Active strategy ──────────────────────────────────────────────────────────
console.log('\nActive strategy');
try {
  initDb();
  const strat = activeStrategy();
  line('ok', 'strategy', `${strat.id} (${strat.name})`);
  line('ok', 'entry', 'rule based — a candidate that passes every filter is bought');
  line('ok', 'position size', `${strat.position_size_sol} SOL, max ${strat.max_open_positions} open`);
  line('ok', 'TP / SL', `${strat.tp_percent}% / ${strat.sl_percent}%`);

  if (strat.use_indicators) {
    console.log('\nIndicator timeframes');
    const unknown = [strat.entry_interval, strat.osc_interval, strat.trend_interval]
      .filter(interval => !knownIntervals().includes(interval));
    if (unknown.length) {
      blocker('interval', `unknown: ${unknown.join(', ')} — known: ${knownIntervals().join(', ')}`);
    } else {
      const sr = `StochRSI(${strat.stochrsi_rsi_period},${strat.stochrsi_stoch_period},${strat.stochrsi_k_smooth},${strat.stochrsi_d_smooth})`;
      line('ok', 'entry: EMA zone', `${strat.entry_interval} x ${strat.min_entry_candles} bars, +/-${strat.ema_proximity_pct}%`);
      line('ok', 'entry: oscillator', `${strat.entry_interval} — ${sr} %K < ${strat.stochrsi_bottom_max}`);
      line('ok', 'entry: trend', `${strat.trend_interval} — Supertrend ${strat.supertrend_period}x${strat.supertrend_multiplier}`);
      line('ok', 'exit: oscillator', `${strat.osc_interval} — ${sr} %K >= ${strat.exit_stochrsi_overbought}`);
      if (strat.osc_interval === strat.trend_interval) {
        line('ok', 'candle requests', '2 per candidate (osc and trend share a timeframe)');
      } else {
        line('ok', 'candle requests', '3 per candidate');
      }
      const derived = minimumHistoryMs(strat);
      const effective = Math.max(Number(strat.token_age_min_ms || 0), derived);
      line('ok', 'minimum token age', `${(effective / 60000).toFixed(0)} min — a token younger than this is skipped`);
      const driver = [
        [strat.min_entry_candles * intervalSeconds(strat.entry_interval) * 1000, `EMA200 on ${strat.entry_interval}`],
        [(strat.stochrsi_rsi_period + strat.stochrsi_stoch_period + strat.stochrsi_k_smooth + strat.stochrsi_d_smooth - 2) * intervalSeconds(strat.entry_interval) * 1000, `StochRSI on ${strat.entry_interval}`],
        [(strat.supertrend_period + 1) * intervalSeconds(strat.trend_interval) * 1000, `Supertrend on ${strat.trend_interval}`],
      ].sort((a, b) => b[0] - a[0])[0];
      line('ok', 'binding constraint', driver[1]);
      const exitBars = strat.stochrsi_rsi_period + strat.stochrsi_stoch_period + strat.stochrsi_k_smooth + strat.stochrsi_d_smooth - 2;
      const exitReadyMin = exitBars * intervalSeconds(strat.osc_interval) / 60;
      if (exitReadyMin > effective / 60000) {
        warn('exit lag', `the ${strat.osc_interval} StochRSI exit only works from ${exitReadyMin.toFixed(0)} min of token age — before that, TP/SL/Supertrend cover exits`);
      }
      if (strat.entry_interval.endsWith('SECOND')) {
        warn('unverified', `${strat.entry_interval} support on datapi.jup.ag is not confirmed — test it before trading live`);
      }
    }
  }
} catch (err) {
  blocker('strategy', `could not read the database: ${err.message}`);
}

console.log(`\nDB_PATH=${env('DB_PATH') || './charon.sqlite'}`);
console.log(blockers === 0
  ? `\nReady${warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}. Start with: npm start\n`
  : `\n${blockers} blocker${blockers > 1 ? 's' : ''}, ${warnings} warning${warnings === 1 ? '' : 's'} — fix the MISS lines above.\n`);
process.exit(blockers === 0 ? 0 : 1);
