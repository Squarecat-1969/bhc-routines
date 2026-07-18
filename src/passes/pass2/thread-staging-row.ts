/**
 * Full Thread_Staging row parsing (A-W), for the Brain_Complete A-U mirror
 * plus marking the source PROCESSED (V/W).
 */

import { RANGES, THREAD_STAGING_ROW_STATUS } from '../../config/constants.js';
import { cell } from '../../lib/sheets.js';
import type { SheetsClient } from '../../lib/sheets.js';
import type { ThreadStagingFullRow } from './types.js';

const THREAD_STAGING_FIRST_ROW = 2;

export async function loadThreadStagingFullRows(sheets: SheetsClient): Promise<readonly ThreadStagingFullRow[]> {
  const rows = await sheets.read(RANGES.threadStagingData);
  return parseThreadStagingFullRows(rows);
}

export function parseThreadStagingFullRows(rows: readonly (readonly unknown[])[]): readonly ThreadStagingFullRow[] {
  return rows.map((row, i) => ({
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
    runningSummary: cell(row, 10),
    keyCommitments: cell(row, 11),
    personalDetailsFlag: cell(row, 12),
    companyIntel: cell(row, 13),
    threadStatus: cell(row, 14),
    readyToArchive: cell(row, 15),
    parentThreadId: cell(row, 16),
    contactHistoryRowId: cell(row, 17),
    crmLastSynced: cell(row, 18),
    pipelineSignals: cell(row, 19),
    brainNotes: cell(row, 20),
    rowStatus: cell(row, 21),
    runId: cell(row, 22),
    sheetRow: THREAD_STAGING_FIRST_ROW + i,
  }));
}

/** Spec: "Working set = every row where col V ≠ PROCESSED." */
export function filterWorkingSet(rows: readonly ThreadStagingFullRow[]): readonly ThreadStagingFullRow[] {
  return rows.filter((r) => r.rowStatus !== THREAD_STAGING_ROW_STATUS.PROCESSED);
}
