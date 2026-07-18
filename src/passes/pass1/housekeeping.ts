/**
 * Pure PASS 1 logic — no I/O, testable without credentials.
 */

import { BRAIN_COMPLETE_RESOLVED_COL, THREAD_STAGING_ROW_STATUS, THREAD_STAGING_STATUS_COL } from '../../config/constants.js';
import { cell } from '../../lib/sheets.js';
import type { SheetsRawRow, ThreadStagingRow } from './types.js';

/** A Sheets boolean cell may render as a real boolean, or as the string "TRUE"/"FALSE". */
function isTrue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return String(value ?? '')
    .trim()
    .toUpperCase() === 'TRUE';
}

/**
 * Spec: "Delete rows where col V = TRUE (rewrite survivors back into A2:AD,
 * clear trailing rows)." Split rather than filter-in-place so the caller can
 * report exact resolved/survivor counts.
 */
export function splitBrainCompleteRows(rows: readonly SheetsRawRow[]): {
  survivors: readonly SheetsRawRow[];
  resolvedCount: number;
} {
  const survivors: SheetsRawRow[] = [];
  let resolvedCount = 0;
  for (const row of rows) {
    if (isTrue(row[BRAIN_COMPLETE_RESOLVED_COL])) {
      resolvedCount += 1;
    } else {
      survivors.push(row);
    }
  }
  return { survivors, resolvedCount };
}

/** Thread_Staging data starts at row 2 (row 1 is the header). */
const THREAD_STAGING_FIRST_ROW = 2;

/**
 * Spec: "Working set = every row where col V ≠ PROCESSED." Parses the columns
 * later passes need (PASS 0's outbound-thread lookup, PASS 2's enrichment
 * loop) rather than just the boolean filter, since both need more than the
 * status column.
 */
export function buildThreadStagingWorkingSet(rows: readonly SheetsRawRow[]): readonly ThreadStagingRow[] {
  const workingSet: ThreadStagingRow[] = [];
  rows.forEach((row, i) => {
    const rowStatus = cell(row, THREAD_STAGING_STATUS_COL);
    if (rowStatus === THREAD_STAGING_ROW_STATUS.PROCESSED) return;

    workingSet.push({
      threadId: cell(row, 0),
      bhcId: cell(row, 1),
      contactName: cell(row, 2),
      sourceMailbox: cell(row, 3),
      direction: cell(row, 4),
      subject: cell(row, 5),
      firstEmailDate: cell(row, 6),
      lastEmailDate: cell(row, 7),
      emailCount: cell(row, 8),
      rawEmailsJson: cell(row, 9),
      rowStatus,
      runId: cell(row, 22),
      sheetRow: THREAD_STAGING_FIRST_ROW + i,
    });
  });
  return workingSet;
}
