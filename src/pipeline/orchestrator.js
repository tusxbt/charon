import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, candidateById } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  // Skip if max positions reached — don't waste enrichment calls
  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  const strat = activeStrategy();
  const selectedRow = candidateById(candidateId);
  if (!selectedRow) return;
  const rows = [selectedRow];

  // Passing the filters IS the decision. There is no model to consult and no
  // batch to rank against: a candidate that satisfies every rule in the active
  // strategy is bought, subject to the guards below.
  const decision = {
    verdict: 'BUY',
    confidence: 100,
    selected_candidate_id: candidateId,
    selected_mint: candidate.token.mint,
    selected_row: selectedRow,
    reason: `Strategy '${strat.id}': all filters passed.`,
    risks: [],
    suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
    suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
  };
  decision.id = storeDecision(candidateId, candidate, decision);
  updateCandidateStatus(candidateId, 'buy');

  if (!boolSetting('agent_enabled', true)) {
    console.log(`[agent] disabled, skipping buy ${candidate.token.mint.slice(0, 8)}...`);
    logDecisionEvent({
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision,
      action: 'entry_skipped_agent_disabled',
      guardrails: { agentEnabled: false },
    });
    return;
  }

  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${candidate.token.mint}`);
    logDecisionEvent({
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision,
      action: 'entry_skipped_max_positions',
      guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
    });
    return;
  }

  await handleApprovedBuy(selectedRow, decision, rows, candidateId);
}

export async function handleApprovedBuy(selectedRow, decision, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, 'rule_entry');
    logDecisionEvent({
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
