/**
 * Pass26_Watermark — per-TASK, which is why it is a tab and not a column.
 *
 * A Reconciliation_Queue row is per-PROPOSAL. Tasks that have never produced a
 * proposal have no queue row — and those are precisely the ones with no
 * evidence yet, which is exactly what this pass must keep re-checking. A column
 * there would track only tasks that already have verdicts and silently skip the
 * rest. Tasks_Log fails too: Attio-native tasks have no row there.
 *
 * ⚠ Range letters are DERIVED from the column list below, never hardcoded.
 */

import { cell, type SheetsClient } from '../../lib/sheets.js';

export const WATERMARK_TAB = 'Pass26_Watermark';
export const WATERMARK_COLUMNS = [
  'Task_ID', 'Source', 'BHC_ID', 'Last_Evaluated_At', 'Last_Event_Seen', 'Last_Verdict', 'Eval_Count', 'Notes',
] as const;

const colLetter = (i: number): string => String.fromCharCode(65 + i);
export const WATERMARK_LAST_COLUMN = colLetter(WATERMARK_COLUMNS.length - 1);
export const WATERMARK_FIRST_DATA_ROW = 2;

export interface WatermarkRow {
  readonly taskId: string;
  readonly source: string;
  readonly bhcId: string;
  readonly lastEvaluatedAt: string;
  readonly lastEventSeen: string;
  readonly lastVerdict: string;
  readonly evalCount: number;
  readonly notes: string;
  readonly sheetRow: number;
}

export async function loadWatermark(sheets: SheetsClient): Promise<{ rows: WatermarkRow[]; headerPresent: boolean; lastRow: number }> {
  const header = await sheets.read(`${WATERMARK_TAB}!A1:${WATERMARK_LAST_COLUMN}1`);
  const headerPresent = (header[0] ?? []).some((h) => String(h ?? '').trim() !== '');
  const data = await sheets.read(`${WATERMARK_TAB}!A${WATERMARK_FIRST_DATA_ROW}:${WATERMARK_LAST_COLUMN}`);
  const rows: WatermarkRow[] = [];
  data.forEach((r, i) => {
    const taskId = cell(r, 0);
    if (taskId === '') return;
    rows.push({
      taskId, source: cell(r, 1), bhcId: cell(r, 2),
      lastEvaluatedAt: cell(r, 3), lastEventSeen: cell(r, 4), lastVerdict: cell(r, 5),
      evalCount: Number.parseInt(cell(r, 6), 10) || 0, notes: cell(r, 7),
      sheetRow: WATERMARK_FIRST_DATA_ROW + i,
    });
  });
  return { rows, headerPresent, lastRow: WATERMARK_FIRST_DATA_ROW + data.length - 1 };
}

export function watermarkRowValues(r: Omit<WatermarkRow, 'sheetRow'>): unknown[] {
  return [r.taskId, r.source, r.bhcId, r.lastEvaluatedAt, r.lastEventSeen, r.lastVerdict, r.evalCount, r.notes];
}

/**
 * ⚠ EVALUATE ONLY WHEN SOMETHING HAS MOVED — a calendar event newer than
 * Last_Event_Seen involving that contact. Without this the pass re-judges every
 * open task against the same events 48 times a day: real Anthropic spend for no
 * new information.
 *
 * A task with no watermark row has never been evaluated and always qualifies.
 */
export function shouldEvaluate(
  taskId: string,
  contactEventStarts: readonly string[],
  watermark: ReadonlyMap<string, WatermarkRow>,
): boolean {
  const wm = watermark.get(taskId);
  if (!wm || wm.lastEventSeen === '') return true;
  return contactEventStarts.some((s) => s > wm.lastEventSeen);
}
