/**
 * Spec 5a: "Count pending meeting reviews. Read Zoom_Staging!A:B (just cols
 * A-B for speed). Count rows where col B is blank or 'PENDING'... Verify col
 * B is the status column before relying on it — if the status column is
 * elsewhere in Zoom_Staging, use the correct column."
 *
 * Verified live 2026-07-19: it is elsewhere. Col B is `title`; the real
 * status column is H. RANGES.zoomStagingStatus already points at H2:H —
 * this is exactly the narrow, single-column read the spec asked for, just
 * aimed at the column that's actually there.
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';

const PENDING_VALUES = new Set(['', 'PENDING']);

export async function countMeetingsToReview(sheets: SheetsClient): Promise<number> {
  const rows = await sheets.read(RANGES.zoomStagingStatus);
  let count = 0;
  for (const row of rows) {
    const status = cell(row, 0).trim().toUpperCase();
    if (PENDING_VALUES.has(status)) count += 1;
  }
  return count;
}
