/**
 * PASS 5 — Game Plan Generation (runs AFTER PASS 4.5 in the spec's intended
 * nightly order). Digests a specific prior run (like PASS 3) and reuses
 * PASS 4's already-tested cadence functions directly (read-only re-fetch,
 * not a chained in-memory report) rather than re-deriving cadence math.
 */

import { ATTIO_PIPELINE_LIST } from '../../config/constants.js';
import type { AttioClient } from '../../lib/attio.js';
import { todayIn, type CivilDate } from '../../lib/dates.js';
import type { Logger } from '../../lib/logger.js';
import type { SheetsClient } from '../../lib/sheets.js';
import { evaluateContact, fetchRecords } from '../pass4/index.js';
import { loadMasterId, loadTierIndex } from '../pass4/load.js';
import { loadOpenTasks } from '../pass2_5/tasks.js';
import { buildBriefText } from './brief-text.js';
import { loadBrainCompleteRowsForRun } from './brain-complete-read.js';
import { computeCounts } from './counts.js';
import { writeDailyBrief } from './daily-brief-write.js';
import { computeMissionStatus, deriveEntryStages } from './mission-status.js';
import { buildOverflowItems, buildPlanItems } from './plan.js';
import { countMeetingsToReview } from './zoom-review-count.js';
import type { CadenceRow, GamePlan, Pass5Options, Pass5Report } from './types.js';

function emptyReport(partial: { runId: string; dryRun: boolean; startedAt: string; aborted?: boolean; abortReason?: string | null }): Pass5Report {
  return {
    runId: partial.runId,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    finishedAt: new Date().toISOString(),
    aborted: partial.aborted ?? false,
    abortReason: partial.abortReason ?? null,
    openTaskCount: 0,
    brainCompleteRowCount: 0,
    pipelineEntryCount: 0,
    meetingsToReviewCount: 0,
    planItemCount: 0,
    overflowItemCount: 0,
    written: false,
    gamePlan: null,
    warnings: [],
  };
}

export interface RunPass5Deps {
  readonly sheets: SheetsClient;
  readonly attio: AttioClient;
  readonly logger: Logger;
  readonly today?: CivilDate;
}

/**
 * Never throws — same fail-soft posture as every other pass, emphasized
 * further by spec 5g: "PASS 5 never blocks earlier passes... degrade
 * silently on any failure."
 */
export async function runPass5(opts: Pass5Options, deps: RunPass5Deps): Promise<Pass5Report> {
  const startedAt = new Date().toISOString();
  try {
    return await runPass5Inner(opts, deps, startedAt);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    deps.logger.warn(`PASS 5 aborted: ${message}`);
    return emptyReport({ runId: opts.runId, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: message });
  }
}

async function runPass5Inner(opts: Pass5Options, deps: RunPass5Deps, startedAt: string): Promise<Pass5Report> {
  const { sheets, attio, logger, today = todayIn('UTC') } = deps;
  const { runId, dryRun } = opts;
  const warnings: string[] = [];

  logger.info('PASS 5 — Game Plan Generation');
  logger.info(`  digesting run_id : ${runId}`);
  logger.info(`  mode             : ${dryRun ? 'DRY RUN (no Daily_Brief write)' : 'LIVE (writes Daily_Brief)'}`);

  logger.info('5a — loading open tasks, Brain_Complete rows, pipeline entries, meeting-review count');
  const [openTasks, brainCompleteRows, master, tiers, meetingsToReviewCount] = await Promise.all([
    loadOpenTasks(sheets),
    loadBrainCompleteRowsForRun(sheets, runId),
    loadMasterId(sheets),
    loadTierIndex(sheets, logger),
    countMeetingsToReview(sheets),
  ]);

  const entries = await attio.listEntries(ATTIO_PIPELINE_LIST);
  logger.info(
    `  open_tasks=${openTasks.length} brain_complete_rows=${brainCompleteRows.length} pipeline_entries=${entries.length} meetings_to_review=${meetingsToReviewCount}`,
  );
  if (entries.length === 0) {
    warnings.push('Attio pipeline list returned 0 entries — check the list ID or the API key scope');
  }

  const records = await fetchRecords(attio, entries, logger);
  const cadenceResults: readonly CadenceRow[] = entries.map((entry) =>
    evaluateContact({ entry, record: records.get(entry.recordId) ?? null, master, tiers, today }),
  );
  const entryStages = entries.map(deriveEntryStages);

  logger.info('5b — computing mission status');
  const missionStatus = computeMissionStatus(entryStages, cadenceResults, today);

  logger.info('5c — computing counts');
  const counts = computeCounts(brainCompleteRows, openTasks, cadenceResults, meetingsToReviewCount, today);

  logger.info('5d — building the plan');
  const plan = buildPlanItems(openTasks, brainCompleteRows, cadenceResults, today);
  const overflow = buildOverflowItems(openTasks, brainCompleteRows, cadenceResults, today, plan);

  logger.info('5e — generating brief text');
  const brief = buildBriefText(counts, brainCompleteRows, missionStatus, plan[0] ?? null);

  const gamePlan: GamePlan = {
    brief,
    missionStatus,
    counts,
    plan,
    overflow,
    generatedAt: new Date().toISOString(),
    runId,
  };

  let written = false;
  if (!dryRun) {
    logger.info('5f — writing Daily_Brief');
    try {
      const result = await writeDailyBrief(sheets, today, gamePlan);
      if (result.written) {
        written = true;
      } else {
        warnings.push(`Daily_Brief write skipped: ${result.reason}`);
      }
    } catch (e) {
      // Spec 5g: never blocks earlier passes, degrade silently — but this
      // orchestrator still surfaces it as a warning rather than pretending
      // success, since the caller (CLI or a future combined orchestrator)
      // should know the write didn't land.
      warnings.push(`Daily_Brief write failed: ${String(e)}`);
    }
  }

  logger.info(`5.done — plan_items=${plan.length} overflow_items=${overflow.length} written=${written}`);

  return {
    runId,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    openTaskCount: openTasks.length,
    brainCompleteRowCount: brainCompleteRows.length,
    pipelineEntryCount: entries.length,
    meetingsToReviewCount,
    planItemCount: plan.length,
    overflowItemCount: overflow.length,
    written,
    gamePlan,
    warnings,
  };
}
