import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { Pass5BrainCompleteRow } from './types.js';

export async function loadBrainCompleteRowsForRun(sheets: SheetsClient, runId: string): Promise<readonly Pass5BrainCompleteRow[]> {
  const rows = await sheets.read(RANGES.brainCompleteData);
  const out: Pass5BrainCompleteRow[] = [];

  for (const row of rows) {
    const threadId = cell(row, 0);
    if (threadId === '') continue;
    if (cell(row, 27) !== runId) continue; // AB Run_ID

    out.push({
      threadId,
      bhcId: cell(row, 1), // B
      contactName: cell(row, 2), // C
      subject: cell(row, 5), // F
      runningSummary: cell(row, 10), // K
      brainNotes: cell(row, 20), // U
      actionRequired: cell(row, 22), // W
      responseDraft: cell(row, 23), // X
      replyRecipientsJson: cell(row, 28), // AC
      replyMode: cell(row, 29), // AD
    });
  }

  return out;
}
