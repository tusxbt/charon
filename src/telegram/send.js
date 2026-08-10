import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { now, json } from '../utils.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { numSetting } from '../db/settings.js';
import { candidateSummary, formatPosition } from './format.js';
import { candidateButtons, positionButtons, intentButtons } from './menus.js';

export async function sendTelegram(text, extra = {}) {
  return bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  });
}

export async function sendCandidateAlert(candidateId, candidate, decision) {
  const sent = await sendTelegram(candidateSummary(candidate, decision), candidateButtons(candidateId, decision));
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, candidate.token.mint, 'candidate', now(), sent.message_id, json({ candidate, decision }));
}

export async function sendPositionOpen(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  const label = position?.execution_mode === 'live' ? 'Live buy executed' : 'Dry-run buy stored';
  if (position) await sendTelegram(`✅ <b>${label}</b>\n\n${formatPosition(position)}`, positionButtons(positionId));
}

export async function sendPositionExit(position) {
  const label = position?.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  await sendTelegram(`🏁 <b>${label}: ${escapeHtml(position.exitReason)}</b>\n\n${formatPosition({ ...position, status: 'closed' })}`);
}

export async function sendTradeIntent(intentId, candidate, decision) {
  await sendTelegram([
    '🧾 <b>Trade intent awaiting confirmation</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Size: <b>${fmtSol(numSetting('dry_run_buy_sol', 0.1))} SOL</b>`,
    'Execution: confirmation required before signing.',
  ].join('\n'), intentButtons(intentId));
}
