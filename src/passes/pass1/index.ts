/**
 * PASS 1 — Housekeeping.
 *
 * The entire spec for this pass, verbatim: "Read Brain_Complete!A:AD. Delete
 * rows where col V = TRUE (rewrite survivors back into A2:AD, clear trailing
 * rows). Read Thread_Staging!A:W. Working set = every row where col V ≠
 * PROCESSED." Two housekeeping steps, both against explicitly spec'd column
 * layouts — no open questions the way PASS 0 has. See docs/pass1-notes.md for
 * the one inferred (not spec-mandated) choice: fail-soft wrapping, for
 * consistency with PASS 4.5 now that multiple passes exist.
 */

import { RANGES } from '../../config/constants.js';
import { makeRunId } from '../../config/constants.js';
import type { SheetsClient } from '../../lib/sheets.js';
import type { Logger } from '../../lib/logger.js';
import { buildThreadStagingWorkingSet, splitBrainCompleteRows } from './housekeeping.js';
import type { Pass1Report } from './types.js';

export interface Pass1Options {
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly sheets: SheetsClient;
  readonly logger: Logger;
}

function emptyReport(partial: {
  runId: string;
  dryRun: boolean;
  startedAt: string;
  aborted?: boolean;
  abortReason?: string | null;
}): Pass1Report {
  return {
    runId: partial.runId,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    finishedAt: new Date().toISOString(),
    aborted: partial.aborted ?? false,
    abortReason: partial.abortReason ?? null,
    brainCompletePriorCount: 0,
    brainCompleteResolvedCount: 0,
    brainCompleteSurvivorCount: 0,
    threadStagingTotalCount: 0,
    workingSet: [],
    warnings: [],
  };
}

/** Never throws — same fail-soft posture as PASS 4.5, for the same reason: one bad housekeeping run shouldn't block the rest of the night. */
export async function runPass1(opts: Pass1Options): Promise<Pass1Report> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? makeRunId();

  try {
    return await runPass1Inner({ ...opts, runId, startedAt });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    opts.logger.warn(`PASS 1 aborted: ${message}`);
    return emptyReport({ runId, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: message });
  }
}

async function runPass1Inner(
  opts: Pass1Options & { runId: string; startedAt: string },
): Promise<Pass1Report> {
  const { sheets, logger, dryRun, runId, startedAt } = opts;
  const warnings: string[] = [];

  logger.info('PASS 1 — Housekeeping');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes to Sheets)'}`);

  // 1a — Brain_Complete: delete resolved rows (col V = TRUE), compact survivors.
  logger.info('1a — reading Brain_Complete, splitting resolved vs survivors');
  const brainCompleteRows = await sheets.read(RANGES.brainCompleteData);
  const { survivors, resolvedCount } = splitBrainCompleteRows(brainCompleteRows);
  logger.info(
    `  Brain_Complete: ${brainCompleteRows.length} row(s) total, ${resolvedCount} resolved (deleted), ${survivors.length} survivor(s)`,
  );

  if (!dryRun) {
    const priorLastRow = 1 + brainCompleteRows.length; // A2:AD read; row 1 is header
    const newLastRow = 1 + survivors.length;

    if (survivors.length > 0) {
      await sheets.update(`Brain_Complete!A2:AD${newLastRow}`, survivors);
    }
    if (priorLastRow > newLastRow) {
      const blankRow = new Array(30).fill(''); // A-AD = 30 columns
      const blankCount = priorLastRow - newLastRow;
      const blankRows = Array.from({ length: blankCount }, () => blankRow);
      await sheets.update(`Brain_Complete!A${newLastRow + 1}:AD${priorLastRow}`, blankRows);
      logger.info(`  blanked ${blankCount} trailing row(s)`);
    }
  } else {
    logger.info('  DRY RUN: would rewrite survivors and blank trailing rows');
  }

  // 1b — Thread_Staging: compute tonight's working set (not PROCESSED).
  logger.info('1b — reading Thread_Staging, building working set');
  const threadStagingRows = await sheets.read(RANGES.threadStagingData);
  const workingSet = buildThreadStagingWorkingSet(threadStagingRows);
  logger.info(`  Thread_Staging: ${threadStagingRows.length} row(s) total, ${workingSet.length} in tonight's working set`);

  return {
    runId,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    brainCompletePriorCount: brainCompleteRows.length,
    brainCompleteResolvedCount: resolvedCount,
    brainCompleteSurvivorCount: survivors.length,
    threadStagingTotalCount: threadStagingRows.length,
    workingSet,
    warnings,
  };
}
