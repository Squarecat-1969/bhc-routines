/**
 * Spec 3b: "Task reconciliation line (2.5f)." Rather than requiring PASS 3
 * to be chained with PASS 2.5 in the same process, this re-derives the H/S/O
 * counts by reading Reconciliation_Queue rows tagged with this run's
 * Run_ID (col B) — the same tab PASS 2.5 wrote to, filtered the same way
 * PASS 3 already filters Brain_Complete. Keeps PASS 3 genuinely standalone.
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';

export interface TaskReconciliationCounts {
  readonly handled: number;
  readonly stale: number;
  readonly open: number;
}

export async function loadTaskReconciliationCountsForRun(sheets: SheetsClient, runId: string): Promise<TaskReconciliationCounts> {
  const rows = await sheets.read(RANGES.reconciliationQueueAll);
  let handled = 0;
  let stale = 0;
  let open = 0;

  for (const row of rows) {
    const reconId = cell(row, 0);
    if (reconId === '') continue;
    if (cell(row, 1) !== runId) continue; // B Run_ID

    const verdict = cell(row, 7); // H Verdict
    if (verdict === 'LIKELY_HANDLED_EVIDENCE') handled += 1;
    else if (verdict === 'LIKELY_STALE_NO_EVIDENCE') stale += 1;
    else if (verdict === 'GENUINELY_OPEN') open += 1;
  }

  return { handled, stale, open };
}

/** Spec 2.5f's exact line, reused for the digest. */
export function buildTaskReconciliationLine(counts: TaskReconciliationCounts): string {
  return `🗂️ Task reconciliation: ${counts.handled} likely handled · ${counts.stale} likely stale · ${counts.open} still open — review & Accept/Deny in Aida. Nothing auto-closed.`;
}
