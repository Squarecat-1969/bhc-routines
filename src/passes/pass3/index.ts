/**
 * PASS 3 — Slack digest to #aida (SEQUENTIAL). Run only after PASS 2 (and
 * PASS 2.5) fully done, digesting a specific prior run's output.
 */

import { todayIn, type CivilDate } from '../../lib/dates.js';
import type { Logger } from '../../lib/logger.js';
import type { SheetsClient } from '../../lib/sheets.js';
import type { SlackPoster } from '../../lib/slack.js';
import { loadBrainCompleteRowsForRun } from './brain-complete-read.js';
import { buildDigestBody } from './digest.js';
import { loadTaskReconciliationCountsForRun } from './task-reconciliation-line.js';
import type { Pass3Options, Pass3Report } from './types.js';

function emptyReport(partial: { runId: string; dryRun: boolean; startedAt: string; aborted?: boolean; abortReason?: string | null }): Pass3Report {
  return {
    runId: partial.runId,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    finishedAt: new Date().toISOString(),
    aborted: partial.aborted ?? false,
    abortReason: partial.abortReason ?? null,
    rowCount: 0,
    surfacedCount: 0,
    filteredCount: 0,
    bodyKind: null,
    posted: false,
    digestBody: null,
    warnings: [],
  };
}

export interface RunPass3Deps {
  readonly sheets: SheetsClient;
  readonly slack: SlackPoster;
  readonly logger: Logger;
  readonly today?: CivilDate;
}

/** Never throws — same fail-soft posture as every other pass. */
export async function runPass3(opts: Pass3Options, deps: RunPass3Deps): Promise<Pass3Report> {
  const startedAt = new Date().toISOString();
  try {
    return await runPass3Inner(opts, deps, startedAt);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    deps.logger.warn(`PASS 3 aborted: ${message}`);
    return emptyReport({ runId: opts.runId, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: message });
  }
}

async function runPass3Inner(opts: Pass3Options, deps: RunPass3Deps, startedAt: string): Promise<Pass3Report> {
  const { sheets, slack, logger, today = todayIn('UTC') } = deps;
  const { runId, dryRun, driftNotes } = opts;
  const warnings: string[] = [];

  logger.info('PASS 3 — Slack digest');
  logger.info(`  digesting run_id : ${runId}`);
  logger.info(`  mode             : ${dryRun ? 'DRY RUN (no Slack post)' : 'LIVE (posts to #aida)'}`);

  // Distinguish "not given a driftNotes array at all" (genuinely standalone
  // — the caller has no way to know if there was drift) from "given an
  // array that happens to be empty" (chained with PASS 2, which genuinely
  // found zero drift this run). Collapsing both to [] before this check
  // produced a false-positive "running standalone" warning on every
  // chained run with a clean PASS 2 — found on the combined orchestrator's
  // first full-scale live run, 2026-07-19.
  if (driftNotes === undefined) {
    warnings.push(
      "drift alerts require chaining directly with PASS 2's in-memory report — running PASS 3 standalone means any drift this run had is not surfaced in the digest. See docs/pass3-notes.md.",
    );
  }
  const resolvedDriftNotes = driftNotes ?? [];

  logger.info('3a — re-reading Brain_Complete for this run');
  const rows = await loadBrainCompleteRowsForRun(sheets, runId);
  logger.info(`  ${rows.length} row(s) for ${runId}`);

  const taskCounts = await loadTaskReconciliationCountsForRun(sheets, runId);

  logger.info('3b/3c — assembling digest body');
  const result = buildDigestBody(rows, runId, today, taskCounts, resolvedDriftNotes);

  if (result.kind === 'failure') {
    warnings.push(`digest assembly failed: ${result.reason}`);
    const failureAlert = `⚠️ Aida — ${runId} — digest assembly failed. ${rows.length} row(s) were staged but the digest body came out empty. Check Brain_Complete directly.`;
    if (!dryRun) {
      try {
        await slack.post(failureAlert);
      } catch (e) {
        warnings.push(`failed to post the failure alert itself: ${String(e)}`);
      }
    }
    return {
      runId,
      dryRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      aborted: false,
      abortReason: null,
      rowCount: rows.length,
      surfacedCount: 0,
      filteredCount: 0,
      bodyKind: 'failure',
      posted: !dryRun,
      digestBody: failureAlert,
      warnings,
    };
  }

  logger.info(`3d/3e — posting (${result.kind})`);
  let posted = false;
  if (!dryRun) {
    try {
      await slack.post(result.body);
      posted = true;
    } catch (e) {
      // Spec 3e: "Retry once if empty; post failure alert if still empty."
      // The underlying poster already retries transient HTTP failures — a
      // second failure here means the post genuinely didn't go through.
      warnings.push(`Slack post failed after retry: ${String(e)}`);
      try {
        await slack.post(`⚠️ Aida — ${runId} — the digest post failed and could not be verified. Check #aida and Brain_Complete directly.`);
      } catch (e2) {
        warnings.push(`failed to post the failure alert itself: ${String(e2)}`);
      }
    }
  }

  logger.info(
    `3.done — kind=${result.kind} ${result.kind === 'valid' ? `surfaced=${result.surfacedCount} filtered=${result.filteredCount}` : ''} posted=${posted}`,
  );

  return {
    runId,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    aborted: false,
    abortReason: null,
    rowCount: rows.length,
    surfacedCount: result.kind === 'valid' ? result.surfacedCount : 0,
    filteredCount: result.kind === 'valid' ? result.filteredCount : rows.length,
    bodyKind: result.kind,
    posted,
    digestBody: result.body,
    warnings,
  };
}
