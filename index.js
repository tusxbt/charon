import { startCharon } from './src/app.js';

// A crash is not just lost uptime here: while the process is down, nothing
// evaluates TP, SL or trailing stops, so an open position sits unattended. The
// handlers below make sure a failure is announced rather than silent, and that
// the exit code lets a supervisor bring the bot back. Open positions resume
// from SQLite on restart.

const MAX_ALERT_CHARS = 3000;
const ALERT_COOLDOWN_MS = 60_000;

// Measured, not assumed: Telegram long-polling raises a raw socket ECONNRESET
// that escapes the library's own polling_error handler and lands here. That is
// a routine network hiccup with no bearing on trading state, so restarting the
// bot for it would be pure churn — and on a host without a supervisor it would
// simply end the run. Faults in this list are logged and survived; anything
// else is treated as a genuine defect.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EFATAL', 'EPARSE',
]);

function isTransientNetworkError(error) {
  const code = error?.code || error?.cause?.code;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return /ECONNRESET|ETIMEDOUT|socket hang up|network|EAI_AGAIN/i.test(String(error?.message || ''));
}

const lastAlertAt = new Map();

async function alert(kind, error) {
  // A flapping network produces one of these per second; the point of the
  // alert is to be noticed, which stops being true if it repeats. The caller
  // has already logged a one-line summary, so suppressing here loses nothing.
  const previous = lastAlertAt.get(kind) ?? 0;
  if (Date.now() - previous < ALERT_COOLDOWN_MS) return;
  lastAlertAt.set(kind, Date.now());
  const detail = String(error?.stack || error?.message || error);
  console.error(`[${kind}]`, error);
  try {
    const [{ sendTelegram }, { escapeHtml }] = await Promise.all([
      import('./src/telegram/send.js'),
      import('./src/format.js'),
    ]);
    // Bounded: a stack trace can exceed Telegram's message limit, and a failed
    // alert about a failure helps nobody.
    const message = `☠️ <b>Charon ${escapeHtml(kind)}</b>\n\n<code>${escapeHtml(detail.slice(0, MAX_ALERT_CHARS))}</code>`;
    await Promise.race([
      sendTelegram(message),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  } catch (sendError) {
    console.error('[alert] could not reach Telegram:', sendError.message);
  }
}

// Kept alive on purpose. A rejected promise usually comes from one polling
// loop, and every loop runs on its own interval — staying up means the next
// tick recovers and, more importantly, open positions keep being monitored.
process.on('unhandledRejection', (reason) => {
  alert('unhandled rejection (still running)', reason);
});

process.on('uncaughtException', async (error) => {
  if (isTransientNetworkError(error)) {
    console.log(`[network] ${error.code || 'fault'}: ${error.message} — continuing`);
    alert('network fault (still running)', error);
    return;
  }
  // Not a network blip, so process state may be inconsistent. Hand over to the
  // supervisor rather than trading on from an unknown state — run under pm2 or
  // systemd so the restart is automatic and positions resume from SQLite.
  await alert('crashed — restarting is required', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[bot] ${signal} received, shutting down`);
    process.exit(0);
  });
}

startCharon().catch(async (error) => {
  await alert('failed to start', error);
  process.exit(1);
});
