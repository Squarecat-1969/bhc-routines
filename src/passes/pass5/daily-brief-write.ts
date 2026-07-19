/**
 * Spec 5f: "write EXACTLY ONE ROW, EXACTLY TWO COLUMNS. Col A = run_date
 * string. Col B = entire game_plan JSON as a single string. DO NOT iterate
 * over game_plan.items(). DO NOT write individual keys as separate rows. DO
 * NOT write more than 2 columns."
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { GamePlan } from './types.js';

const DAILY_BRIEF_FIRST_ROW = 2;

export function serializeGamePlan(gamePlan: GamePlan): string {
  return JSON.stringify(gamePlan);
}

/** Finds an existing row for today's date, if the pass has already run once today. */
async function findExistingRowForDate(sheets: SheetsClient, runDate: string): Promise<number | null> {
  const rows = await sheets.read(RANGES.dailyBriefDates);
  for (let i = 0; i < rows.length; i++) {
    if (cell(rows[i]!, 0) === runDate) return DAILY_BRIEF_FIRST_ROW + i;
  }
  return null;
}

export async function writeDailyBrief(sheets: SheetsClient, runDate: string, gamePlan: GamePlan): Promise<void> {
  const briefJson = serializeGamePlan(gamePlan);
  const oneRow: readonly unknown[] = [runDate, briefJson]; // the ONLY valid write shape: one row, two values

  const existingRow = await findExistingRowForDate(sheets, runDate);
  if (existingRow !== null) {
    await sheets.update(`Daily_Brief!A${existingRow}:B${existingRow}`, [oneRow]);
  } else {
    await sheets.append('Daily_Brief!A2:B', [oneRow]);
  }
}
