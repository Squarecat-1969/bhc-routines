/**
 * PASS 0 — Reply-placeholder reconciliation.
 *
 * Hybrid write model, per the July 18 conversation with Bobby resolving the
 * spec contradiction found while scoping this (docs/pass1-and-pass0-notes.md):
 *   - EXACT Thread_ID match → unambiguous fact, not a judgment call. Writes
 *     Activity_Log directly (closes the placeholder) and marks the matched
 *     Thread_Staging row PROCESSED — the same live-write posture as PASS 4's
 *     cadence fields, and consistent with the project's own §4.10: "Exact
 *     matches... may finalize a manual mark automatically because the match
 *     is unambiguous."
 *   - Contact+72h-window (INFERRED) match → a heuristic, not a fact. Per
 *     §4.10's own rule ("an inferred resolution is always proposed, never
 *     silently executed"), this stages a Reconciliation_Queue row instead —
 *     confirmed reusable after reading both bhc-aida's reconciliation-queue
 *     reader (generic itemType passthrough) and its commit-route Accept
 *     handler (currently task-specific; a PASS0 row's Accept action needs a
 *     follow-up commit-route change before it's actionable in Aida — see the
 *     notes doc).
 *   - AMBIGUOUS (>1 fallback candidate) → leave the placeholder open, tag the
 *     candidate Thread_Staging rows' Brain_Notes, let them flow through PASS 2
 *     normally (their Row_Status is NOT marked PROCESSED).
 *   - NO_MATCH → nothing written; tracked for staleness reporting only (see
 *     the notes doc — no write target for the 7-day stale tag is spec'd).
 *
 * The exact-match write's col J ("real content") is intentionally
 * conservative — see resolveExactMatchBody's own comment. Never guesses at
 * Raw_Emails_JSON's shape.
 */

import { RANGES } from '../../config/constants.js';
import { makeRunId } from '../../config/constants.js';
import type { SheetsClient } from '../../lib/sheets.js';
import type { Logger } from '../../lib/logger.js';
import { buildThreadStagingWorkingSet } from '../pass1/housekeeping.js';
import type { ThreadStagingRow } from '../pass1/types.js';
import { findOpenPlaceholders, findOutboundCandidates, isStalePlaceholder, matchPlaceholder } from './matching.js';
import type { ActivityLogWriteResult, Pass0Report, ReconciliationQueueEnqueue } from './types.js';

export interface Pass0Options {
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly sheets: SheetsClient;
  readonly logger: Logger;
  readonly now?: Date;
  /** Reuse PASS 1's already-computed working set instead of re-reading Thread_Staging. */
  readonly threadStagingWorkingSet?: readonly ThreadStagingRow[];
}

function emptyReport(partial: {
  runId: string;
  dryRun: boolean;
  startedAt: string;
  aborted?: boolean;
  abortReason?: string | null;
}): Pass0Report {
  return {
    runId: partial.runId,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    finishedAt: new Date().toISOString(),
    aborted: partial.aborted ?? false,
    abortReason: partial.abortReason ?? null,
    placeholderCount: 0,
    exactMatches: [],
    inferredMatches: [],
    ambiguousCount: 0,
    noMatchCount: 0,
    stalePlaceholderCount: 0,
    warnings: [],
  };
}

/**
 * Conservative col-J content for an EXACT match. Raw_Emails_JSON's shape for
 * extracting the actual sent email's body is NOT live-verified (spec only
 * confirms `sender_email`/`recipient_email`/`cc_list` keys, for PASS 2's dedup
 * step — nothing about a body/content key). Guessing a key name here risks
 * writing garbage into Activity_Log, the permanent record. Closes the loop
 * with what's actually known (which thread, what subject) rather than
 * guessing at unverified JSON structure.
 */
function resolveExactMatchBody(candidate: ThreadStagingRow): string {
  return (
    `Reply confirmed via PASS 0 reconciliation — matched Thread_ID ${candidate.threadId} ` +
    `("${candidate.subject}", sent ${candidate.lastEmailDate}). ` +
    `[Full email body not extracted — Raw_Emails_JSON shape not yet verified.]`
  );
}

/** Never throws — same fail-soft posture as PASS 1/4.5. */
export async function runPass0(opts: Pass0Options): Promise<Pass0Report> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? makeRunId();

  try {
    return await runPass0Inner({ ...opts, runId, startedAt });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    opts.logger.warn(`PASS 0 aborted: ${message}`);
    return emptyReport({ runId, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: message });
  }
}

async function runPass0Inner(opts: Pass0Options & { runId: string; startedAt: string }): Promise<Pass0Report> {
  const { sheets, logger, dryRun, runId, startedAt } = opts;
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  logger.info('PASS 0 — Reply-placeholder reconciliation');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes to Sheets)'}`);

  logger.info('0a — finding open placeholders in Activity_Log');
  const activityLogRows = await sheets.read(RANGES.activityLogData);
  const placeholders = findOpenPlaceholders(activityLogRows);
  logger.info(`  ${placeholders.length} open placeholder(s)`);

  logger.info('0b — finding tonight\'s outbound Thread_Staging candidates');
  const workingSet =
    opts.threadStagingWorkingSet ?? buildThreadStagingWorkingSet(await sheets.read(RANGES.threadStagingData));
  const candidates = findOutboundCandidates(workingSet);
  logger.info(`  ${candidates.length} outbound candidate(s) in tonight's working set`);

  const exactMatches: ActivityLogWriteResult[] = [];
  const inferredMatches: ReconciliationQueueEnqueue[] = [];
  let ambiguousCount = 0;
  let noMatchCount = 0;
  let stalePlaceholderCount = 0;
  let reconSeq = 0;

  logger.info('0c — matching');
  for (const placeholder of placeholders) {
    const result = matchPlaceholder(placeholder, candidates);

    if (result.verdict === 'EXACT' && result.candidate) {
      const candidate = result.candidate;
      logger.info(`  EXACT: ${placeholder.activityId} <- ${candidate.threadId} (${result.reason})`);

      if (!dryRun) {
        await sheets.update(`Activity_Log!J${placeholder.sheetRow}:J${placeholder.sheetRow}`, [
          [resolveExactMatchBody(candidate)],
        ]);
        await sheets.update(`Activity_Log!N${placeholder.sheetRow}:N${placeholder.sheetRow}`, [['Replied']]);
        await sheets.update(`Activity_Log!P${placeholder.sheetRow}:P${placeholder.sheetRow}`, [['']]);
        await sheets.update(`Thread_Staging!U${candidate.sheetRow}:V${candidate.sheetRow}`, [
          [`recon:matched ${placeholder.activityId}`, 'PROCESSED'],
        ]);
      }
      exactMatches.push({ activityId: placeholder.activityId, sheetRow: placeholder.sheetRow, threadId: candidate.threadId });
      continue;
    }

    if (result.verdict === 'INFERRED' && result.candidate) {
      const candidate = result.candidate;
      logger.info(`  INFERRED: ${placeholder.activityId} ~ ${candidate.threadId} (${result.reason})`);

      reconSeq += 1;
      const reconId = `RECON-${Date.now()}-${reconSeq}`;
      if (!dryRun) {
        await sheets.append(RANGES.reconciliationQueueAppend, [
          [
            reconId,
            runId,
            'placeholder_reconciliation',
            '', // Source_Task_ID — intentionally blank, not a task (see notes doc)
            placeholder.contactId,
            placeholder.contactName,
            `Placeholder ${placeholder.activityId} (opened ${placeholder.timestamp}) may match outbound ` +
              `thread "${candidate.subject}" (Thread_ID ${candidate.threadId}, last sent ${candidate.lastEmailDate}) ` +
              `— contact+72h window match, not an exact Thread_ID match.`,
            'LIKELY_PLACEHOLDER_MATCH',
            candidate.subject,
            candidate.threadId,
            '', // Proposed_Completion_Date — not applicable here
            'medium',
            result.reason,
            '', // Status — awaiting
          ],
        ]);
      }
      inferredMatches.push({ reconId, placeholder, candidate });
      continue;
    }

    if (result.verdict === 'AMBIGUOUS') {
      ambiguousCount += 1;
      logger.info(`  AMBIGUOUS: ${placeholder.activityId} (${result.reason})`);
      if (!dryRun) {
        for (const c of result.ambiguousCandidates) {
          await sheets.update(`Thread_Staging!U${c.sheetRow}:U${c.sheetRow}`, [['recon:ambiguous']]);
        }
      }
      continue;
    }

    // NO_MATCH
    noMatchCount += 1;
    if (isStalePlaceholder(placeholder, now.getTime())) {
      stalePlaceholderCount += 1;
      warnings.push(`${placeholder.activityId} is a stale placeholder (>7 days, no write target spec'd — reported only)`);
    }
  }

  logger.info(
    `0d — done: exact=${exactMatches.length} inferred=${inferredMatches.length} ` +
      `ambiguous=${ambiguousCount} no_match=${noMatchCount} (${stalePlaceholderCount} stale)`,
  );

  return {
    runId,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    placeholderCount: placeholders.length,
    exactMatches,
    inferredMatches,
    ambiguousCount,
    noMatchCount,
    stalePlaceholderCount,
    warnings,
  };
}
