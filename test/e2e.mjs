// End-to-end test: runs the real bot against stub market data and a stub
// Jupiter swap API, then asserts on what actually landed in SQLite.
//
//   npm run test:e2e            dry_run mode
//   npm run test:e2e -- live    live mode, with a throwaway keypair
//
// No network, no funds, no Telegram. Everything the bot needs is served from
// localhost, so this is safe to run anywhere — and it is the only check that
// exercises signing, order placement and the sell path.
//
// The stub scripts it launches are deliberately faithful on the two points
// that previously produced false results: candle prices are a pure function of
// absolute bar time on the interval grid, and the swap stub returns a genuinely
// signable VersionedTransaction.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import Database from 'better-sqlite3';

const MODE = process.argv[2] === 'live' ? 'live' : 'dry_run';
const MARKET_PORT = 3999;
const SWAP_PORT = 4000;
const PHASE_MS = 12_000;
const RUN_MS = 45_000;

const workDir = mkdtempSync(join(tmpdir(), 'charon-e2e-'));
const dbPath = join(workDir, 'e2e.sqlite');
const wallet = Keypair.generate();
const children = [];

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
};

function start(script, env, label) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const log = [];
  child.stdout.on('data', chunk => log.push(String(chunk)));
  child.stderr.on('data', chunk => log.push(String(chunk)));
  child.on('error', error => console.log(`[${label}] ${error.message}`));
  return { child, log };
}

function stopAll() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

process.on('exit', () => {
  stopAll();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

console.log(`\nCharon end-to-end (${MODE})\n`);

start('test/stub-market.mjs', { STUB_PORT: String(MARKET_PORT), STUB_PHASE_MS: String(PHASE_MS) }, 'market');
start('test/stub-swap.mjs', { SWAP_STUB_PORT: String(SWAP_PORT), STUB_TAKER: wallet.publicKey.toBase58() }, 'swap');
await wait(1500);

// Activate the indicator strategy before the bot starts, the same way the
// runbook does.
const setup = spawn(process.execPath, ['src/strategy.js', 'indicator_pullback'], {
  env: { ...process.env, DB_PATH: dbPath, TRADING_MODE: MODE },
  stdio: 'ignore',
});
await new Promise(resolve => setup.on('exit', resolve));

const botEnv = {
  DB_PATH: dbPath,
  TRADING_MODE: MODE,
  TELEGRAM_BOT_TOKEN: '1:e2e-stub',
  TELEGRAM_CHAT_ID: '1',
  SIGNAL_SERVER_URL: `http://localhost:${MARKET_PORT}`,
  SIGNAL_SERVER_KEY: 'e2e',
  JUPITER_DATA_URL: `http://localhost:${MARKET_PORT}`,
  JUPITER_PRICE_URL: `http://localhost:${MARKET_PORT}`,
  SOLANA_RPC_URL: `http://localhost:${SWAP_PORT}`,
  SOLANA_WS_URL: `ws://localhost:${SWAP_PORT}`,
  JUPITER_SWAP_BASE_URL: `http://localhost:${SWAP_PORT}`,
  JUPITER_API_KEY: 'e2e',
  SOLANA_PRIVATE_KEY: bs58.encode(wallet.secretKey),
  HELIUS_API_KEY: 'e2e',
  GMGN_ENABLED: 'false',
  SIGNAL_POLL_MS: '4000',
  POSITION_CHECK_MS: '3000',
};

const bot = start('index.js', botEnv, 'bot');
console.log(`running the bot for ${RUN_MS / 1000}s...\n`);
await wait(RUN_MS);
bot.child.kill('SIGTERM');
await wait(1000);

// ── Assertions against what the bot actually stored ──────────────────────────
const db = new Database(dbPath, { readonly: true });
const position = db.prepare('SELECT * FROM dry_run_positions ORDER BY id LIMIT 1').get();
const trades = db.prepare('SELECT side, reason FROM dry_run_trades ORDER BY id').all();
const actions = db.prepare('SELECT action FROM decision_logs ORDER BY id').all().map(row => row.action);
const candles = db.prepare('SELECT interval, COUNT(*) AS count FROM candles GROUP BY interval').all();

check('a position was opened', Boolean(position), true);
if (position) {
  check('execution mode matches the requested mode', position.execution_mode, MODE);
  check('the position was closed by an exit rule', position.status, 'closed');
  check('two trades were recorded (buy then sell)', trades.map(t => t.side), ['buy', 'sell']);
  check('the exit reason is recorded', Boolean(position.exit_reason), true);
  check('PnL was computed', Number.isFinite(position.pnl_percent), true);
  if (MODE === 'live') {
    check('the buy carries an on-chain signature', Boolean(position.entry_signature), true);
    check('the sell carries an on-chain signature', Boolean(position.exit_signature), true);
    check('the token amount was recorded', Boolean(position.token_amount_raw), true);
  }
  console.log(`\n      ${position.exit_reason} at ${position.pnl_percent?.toFixed(1)}% `
    + `(mcap ${position.entry_mcap} -> ${position.exit_mcap})`);
}
check('an entry was logged', actions.some(a => a.endsWith('_entry') || a === 'live_entry_executed'), true);
check('both candle series were cached', candles.length, 2);

db.close();
stopAll();

console.log(failures === 0
  ? `\nEnd-to-end passed (${MODE}).\n`
  : `\n${failures} check(s) failed (${MODE}).\n`);
process.exit(failures === 0 ? 0 : 1);
