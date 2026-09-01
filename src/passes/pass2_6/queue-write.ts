/**
 * Reconciliation_Queue writer — same tab, same 15 columns A–O, so Part D's
 * Accept path works unchanged and everything surfaces in one place.
 *
 * ⚠ Range letters are DERIVED from the column list, never hardcoded.
 */

import type { CalendarReconciliationResult } from './types.js';

export const QUEUE_TAB = 'Reconciliation_Queue';
export const QUEUE_COLUMNS = [
  'Recon_ID', 'Run_ID', 'Item_Type', 'Source_Task_ID', 'BHC_ID', 'Contact_Name', 'Item_Description',
  'Verdict', 'Evidence_Quote', 'Evidence_Source', 'Proposed_Completion_Date', 'Confidence',
  'Brain_Reasoning', 'Status', 'Placeholder_Activity_ID',
] as const;

const colLetter = (i: number): string => String.fromCharCode(65 + i);
export const QUEUE_LAST_COLUMN = colLetter(QUEUE_COLUMNS.length - 1); // O
export const QUEUE_APPEND_RANGE = `${QUEUE_TAB}!A1`;

/** Baked in, and distinct from every existing row — all 364 read `task`. */
export const ITEM_TYPE_CALENDAR = 'calendar_reconciliation';
export const EVIDENCE_SOURCE_CALENDAR = 'calendar';

export function buildQueueRow(runId: string, reconId: string, r: CalendarReconciliationResult): unknown[] {
  const row = [
    reconId,                       // A Recon_ID
    runId,                         // B Run_ID
    ITEM_TYPE_CALENDAR,            // C Item_Type
    r.taskId,                      // D Source_Task_ID
    r.bhcId,                       // E BHC_ID
    r.contactName,                 // F Contact_Name
    r.description,                 // G Item_Description
    r.verdict,                     // H Verdict
    r.evidenceQuote,               // I Evidence_Quote — SUBJECT AND DATE ONLY
    EVIDENCE_SOURCE_CALENDAR,      // J Evidence_Source
    r.proposedCompletionDate,      // K Proposed_Completion_Date
    r.confidence,                  // L Confidence
    r.brainReasoning,              // M Brain_Reasoning
    '',                            // N Status — blank, awaiting Bobby's review
    // ⚠ O is Placeholder_Activity_ID, PASS 0's field. Blank. It is populated on
    // zero of 364 rows because pass0's INFERRED path has never fired live —
    // that is an unexercised path, not a free column.
    '',
  ];
  if (row.length !== QUEUE_COLUMNS.length) {
    throw new Error(`queue row width ${row.length} != ${QUEUE_COLUMNS.length} — buildQueueRow and QUEUE_COLUMNS have drifted`);
  }
  return row;
}

/**
 * ⚠ UNEVALUABLE NEVER BECOMES A REVIEW CARD. It surfaces as a count.
 *
 * Twelve cards each demanding a verdict on a question that cannot be answered
 * is the Reconciler's twenty findings again — the alert-fatigue shape removed
 * on 2026-08-30, rebuilt somewhere new. An UNEVALUABLE task is not waiting on a
 * decision, it is waiting on evidence to exist; when evidence appears the next
 * run reclassifies it and it surfaces then, on its own merits.
 */
export function isEnqueueable(r: CalendarReconciliationResult): boolean {
  return r.verdict !== 'UNEVALUABLE';
}
