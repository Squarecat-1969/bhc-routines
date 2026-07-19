/**
 * PASS 2.5 — Task Reconciliation. Run AFTER PASS 2, BEFORE PASS 3 (spec).
 */

import { makeRunId, RANGES } from '../../config/constants.js';
import type { AnthropicClient } from '../../lib/anthropic.js';
import { todayIn, type CivilDate } from '../../lib/dates.js';
import type { Logger } from '../../lib/logger.js';
import type { SheetsClient } from '../../lib/sheets.js';
import { loadActivityLogCandidates, filterCandidatesForCluster } from './activity-candidates.js';
import { reconcileCluster } from './reconcile.js';
import {
  buildReconciliationQueueRow,
  findSupersedeTarget,
  isMaterialChange,
  loadExistingReconciliationRows,
} from './reconciliation-queue-write.js';
import { clusterOpenTasks, loadOpenTasks } from './tasks.js';
import type { Pass25Report, ReconciliationResult } from './types.js';

export interface Pass25Options {
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly sheets: SheetsClient;
  readonly anthropic: AnthropicClient;
  readonly logger: Logger;
  readonly today?: CivilDate;
  readonly limit?: number;
}

function emptyReport(partial: { runId: string; dryRun: boolean; startedAt: string; aborted?: boolean; abortReason?: string | null }): Pass25Report {
  return {
    runId: partial.runId,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    finishedAt: new Date().toISOString(),
    aborted: partial.aborted ?? false,
    abortReason: partial.abortReason ?? null,
    openTaskCount: 0,
    clusterCount: 0,
    handledCount: 0,
    staleCount: 0,
    openCount: 0,
    enqueuedCount: 0,
    supersededCount: 0,
    results: [],
    warnings: [],
  };
}

/** Never throws — same fail-soft posture as every other pass. */
export async function runPass25(opts: Pass25Options): Promise<Pass25Report> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? makeRunId();

  try {
    return await runPass25Inner({ ...opts, runId, startedAt });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    opts.logger.warn(`PASS 2.5 aborted: ${message}`);
    return emptyReport({ runId, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: message });
  }
}

async function runPass25Inner(opts: Pass25Options & { runId: string; startedAt: string }): Promise<Pass25Report> {
  const { sheets, anthropic, logger, dryRun, runId, startedAt } = opts;
  const today = opts.today ?? todayIn('UTC');
  const warnings: string[] = [];

  logger.info('PASS 2.5 — Task Reconciliation');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes to Sheets)'}`);

  logger.info('2.5a — loading open tasks');
  const openTasks = await loadOpenTasks(sheets);
  logger.info(`  ${openTasks.length} open task(s)`);

  logger.info('2.5b — clustering');
  let clusters = clusterOpenTasks(openTasks);
  logger.info(`  ${clusters.length} cluster(s)`);
  if (opts.limit !== undefined && opts.limit < clusters.length) {
    logger.info(`  --limit ${opts.limit} applied (of ${clusters.length})`);
    clusters = clusters.slice(0, opts.limit);
  }

  logger.info('2.5c — loading Activity_Log candidates');
  const allCandidates = await loadActivityLogCandidates(sheets);
  logger.info(`  ${allCandidates.length} total Activity_Log row(s) to filter per cluster`);

  const existingReconciliation = await loadExistingReconciliationRows(sheets);

  const results: ReconciliationResult[] = [];
  let handledCount = 0;
  let staleCount = 0;
  let openCount = 0;
  let enqueuedCount = 0;
  let supersededCount = 0;

  logger.info('2.5c/d — reconciling each cluster');
  for (const cluster of clusters) {
    const candidates = filterCandidatesForCluster(cluster, allCandidates);
    const outcome = await reconcileCluster(anthropic, cluster, candidates, today);

    if (!outcome.ok) {
      warnings.push(`${cluster.clusterKey}: reconciliation failed — ${outcome.error}. Skipped.`);
      continue;
    }

    const result = outcome.result;
    results.push(result);
    if (result.verdict === 'LIKELY_HANDLED_EVIDENCE') handledCount += 1;
    else if (result.verdict === 'LIKELY_STALE_NO_EVIDENCE') staleCount += 1;
    else openCount += 1;

    const taskIds = cluster.tasks.map((t) => t.taskId);
    const supersedeTarget = findSupersedeTarget(existingReconciliation, taskIds);

    if (supersedeTarget) {
      if (!isMaterialChange(supersedeTarget, result)) {
        continue; // spec: "Write only on material change."
      }
      const row = buildReconciliationQueueRow(runId, supersedeTarget.reconId, result);
      if (!dryRun) {
        await sheets.update(`Reconciliation_Queue!A${supersedeTarget.sheetRow}:N${supersedeTarget.sheetRow}`, [row]);
      }
      supersededCount += 1;
    } else {
      const reconId = `RECON-${Date.now()}-${enqueuedCount + supersededCount + 1}`;
      const row = buildReconciliationQueueRow(runId, reconId, result);
      if (!dryRun) {
        await sheets.append(RANGES.reconciliationQueueAppend, [row]);
      }
      enqueuedCount += 1;
    }
  }

  logger.info(
    `2.5f — done: handled=${handledCount} stale=${staleCount} open=${openCount} ` +
      `(enqueued=${enqueuedCount} superseded=${supersededCount})`,
  );

  return {
    runId,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    openTaskCount: openTasks.length,
    clusterCount: clusters.length,
    handledCount,
    staleCount,
    openCount,
    enqueuedCount,
    supersededCount,
    results,
    warnings,
  };
}
