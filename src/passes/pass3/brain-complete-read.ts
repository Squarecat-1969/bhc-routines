/**
 * Spec 3a: "Re-read Brain_Complete!A:AD filtered to rows where col AB ==
 * RUN_ID." A genuine re-read (not reused in-memory data), since PASS 3 is
 * meant to run after PASS 2 has fully finished and committed everything.
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { DigestBrainCompleteRow } from './types.js';

export async function loadBrainCompleteRowsForRun(sheets: SheetsClient, runId: string): Promise<readonly DigestBrainCompleteRow[]> {
  const rows = await sheets.read(RANGES.brainCompleteData);
  const out: DigestBrainCompleteRow[] = [];

  for (const row of rows) {
    const threadId = cell(row, 0);
    if (threadId === '') continue; // blank trailing row
    const rowRunId = cell(row, 27); // AB Run_ID
    if (rowRunId !== runId) continue;

    out.push({
      threadId,
      actionRequired: cell(row, 22), // W Action_Required
      slackMessage: cell(row, 26), // AA Slack_Message
    });
  }

  return out;
}
