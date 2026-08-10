// Switch the active strategy from the shell, before the bot is running.
//
//   npm run strategy                    list strategies, mark the active one
//   npm run strategy indicator_pullback activate it
//
// The Telegram /strategy command does the same thing, but it needs the bot to
// be up — and on a fresh database the default active strategy is `sniper`,
// which is not the one this setup is built around. Switching first avoids a
// first run that screens against the wrong rules.

import 'dotenv/config';
import { initDb } from './db/connection.js';
import { allStrategies, activeStrategy, setActiveStrategy } from './db/settings.js';
import { minimumHistoryMs } from './indicators/entry.js';

initDb();

const wanted = process.argv[2];
const strategies = allStrategies();

if (!wanted) {
  const active = activeStrategy();
  console.log('\nStrategies\n');
  for (const strategy of strategies) {
    const mark = strategy.id === active.id ? '▶' : ' ';
    const kind = strategy.use_indicators ? 'indicators' : 'filters only';
    console.log(`  ${mark} ${strategy.id.padEnd(20)} ${strategy.name.padEnd(20)} ${kind}`);
  }
  console.log(`\nActivate with: npm run strategy <id>\n`);
  process.exit(0);
}

const match = strategies.find(strategy => strategy.id === wanted);
if (!match) {
  console.log(`\nUnknown strategy "${wanted}". Available: ${strategies.map(s => s.id).join(', ')}\n`);
  process.exit(1);
}

setActiveStrategy(wanted);
const active = activeStrategy();
console.log(`\nActive strategy: ${active.id} (${active.name})`);
console.log(`  size ${active.position_size_sol} SOL, max ${active.max_open_positions} open, TP ${active.tp_percent}% / SL ${active.sl_percent}%`);
if (active.use_indicators) {
  const minAge = Math.max(Number(active.token_age_min_ms || 0), minimumHistoryMs(active));
  console.log(`  entry  ${active.entry_interval}: EMA zone +/-${active.ema_proximity_pct}%, StochRSI %K < ${active.stochrsi_bottom_max}`);
  console.log(`  trend  ${active.trend_interval}: Supertrend ${active.supertrend_period}x${active.supertrend_multiplier} bullish`);
  console.log(`  exit   ${active.osc_interval}: StochRSI %K >= ${active.exit_stochrsi_overbought}`);
  console.log(`  skips tokens younger than ${(minAge / 60000).toFixed(0)} min`);
}
console.log('\nNext: npm run preflight\n');
