/**
 * Spec 5f: "write EXACTLY ONE ROW, EXACTLY TWO COLUMNS. Col A = run_date
 * string. Col B = entire game_plan JSON as a single string. DO NOT iterate
 * over game_plan.items(). DO NOT write individual keys as separate rows. DO
 * NOT write more than 2 columns."
 *
 * Deliberately one cell, not split across cells — the spec's insistence on
 * "the ONLY valid write shape" is protecting a downstream contract (Aida
 * reads this one cell and parses it as a single JSON blob), not just being
 * cautious. Splitting would require coordinated changes on the Aida side
 * for a problem the plan's own design doesn't actually create: the plan is
 * hard-capped at 10 items, each item's fields are naturally bounded (a
 * response_draft is already constrained to a few sentences by PASS 2's own
 * prompt), so realistic worst-case size is a small fraction of Sheets'
 * per-cell limit. See the size guard below for what happens on the
 * (currently theoretical) day that stops being true.
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { GamePlan } from './types.js';

const DAILY_BRIEF_FIRST_ROW = 2;

/** Google Sheets' documented, non-adjustable hard limit per cell. */
const GOOGLE_SHEETS_CELL_CHAR_LIMIT = 50_000;
/** A safety margin below the hard limit — leave room rather than writing right up to the edge. */
const SAFE_CHAR_LIMIT = 45_000;

export function serializeGamePlan(gamePlan: GamePlan): string {
  return JSON.stringify(gamePlan);
}

export type DailyBriefWriteResult =
  | { readonly written: true }
  | { readonly written: false; readonly reason: string };

/** Finds an existing row for today's date, if the pass has already run once today. */
async function findExistingRowForDate(sheets: SheetsClient, runDate: string): Promise<number | null> {
  const rows = await sheets.read(RANGES.dailyBriefDates);
  for (let i = 0; i < rows.length; i++) {
    if (cell(rows[i]!, 0) === runDate) return DAILY_BRIEF_FIRST_ROW + i;
  }
  return null;
}

export async function writeDailyBrief(sheets: SheetsClient, runDate: string, gamePlan: GamePlan): Promise<DailyBriefWriteResult> {
  const briefJson = serializeGamePlan(gamePlan);

  // Refuse to write rather than risk silent truncation or an API rejection.
  // Same "stop silently, don't write a broken shape" instinct the spec
  // itself uses elsewhere in this step — this just extends it to a failure
  // mode the spec didn't anticipate (an oversized blob), rather than one it
  // did (a malformed shape).
  if (briefJson.length > SAFE_CHAR_LIMIT) {
    return {
      written: false,
      reason:
        `game_plan JSON is ${briefJson.length} chars, over the ${SAFE_CHAR_LIMIT}-char safety margin ` +
        `(Sheets' hard per-cell limit is ${GOOGLE_SHEETS_CELL_CHAR_LIMIT}) — refusing to write a value ` +
        'that could be silently truncated or rejected by the Sheets API.',
    };
  }

  const oneRow: readonly unknown[] = [runDate, briefJson]; // the ONLY valid write shape: one row, two values

  const existingRow = await findExistingRowForDate(sheets, runDate);
  if (existingRow !== null) {
    await sheets.update(`Daily_Brief!A${existingRow}:B${existingRow}`, [oneRow]);
  } else {
    await sheets.append('Daily_Brief!A2:B', [oneRow]);
  }
  return { written: true };
}
