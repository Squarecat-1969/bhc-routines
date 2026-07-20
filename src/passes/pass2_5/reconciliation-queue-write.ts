/**
 * Spec 2.5e: "Write to Reconciliation_Queue (SUPERSEDE-IN-PLACE)... Supersede
 * existing awaiting rows by Task_ID overlap. Write only on material change."
 *
 * "In-place" is read literally: an existing awaiting (blank Status) row
 * whose Task_IDs overlap this cluster's gets UPDATED at its own row (same
 * Recon_ID, refreshed content), not superseded by a new appended row. Only
 * a cluster with no overlapping awaiting row gets a genuinely new row.
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { ReconciliationResult } from './types.js';

const RECONCILIATION_QUEUE_FIRST_ROW = 2;
const ITEM_TYPE_TASK = 'task'; // spec's own literal constant — confirmed live 2026-07-18: 100% of historical rows use this exact value

export interface ExistingReconciliationRow {
  readonly reconId: string;
  readonly taskIds: readonly string[];
  readonly verdict: string;
  readonly evidenceQuote: string;
  readonly confidence: string;
  readonly proposedCompletionDate: string;
  readonly status: string;
  readonly sheetRow: number;
}

export async function loadExistingReconciliationRows(sheets: SheetsClient): Promise<readonly ExistingReconciliationRow[]> {
  const rows = await sheets.read(RANGES.reconciliationQueueAll);
  const out: ExistingReconciliationRow[] = [];

  rows.forEach((row, i) => {
    const reconId = cell(row, 0);
    if (reconId === '') return;
    out.push({
      reconId,
      taskIds: cell(row, 3)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      verdict: cell(row, 7),
      evidenceQuote: cell(row, 8),
      confidence: cell(row, 11),
      proposedCompletionDate: cell(row, 10),
      status: cell(row, 13),
      sheetRow: RECONCILIATION_QUEUE_FIRST_ROW + i,
    });
  });

  return out;
}

/** An awaiting (blank Status) row whose Task_IDs overlap this cluster's — the supersede-in-place target, if any. */
export function findSupersedeTarget(
  existing: readonly ExistingReconciliationRow[],
  clusterTaskIds: readonly string[],
): ExistingReconciliationRow | null {
  const taskIdSet = new Set(clusterTaskIds);
  return existing.find((row) => row.status === '' && row.taskIds.some((id) => taskIdSet.has(id))) ?? null;
}

/** Skip the write entirely if nothing meaningful changed since the existing row. */
export function isMaterialChange(existing: ExistingReconciliationRow, result: ReconciliationResult): boolean {
  return (
    existing.verdict !== result.verdict ||
    existing.evidenceQuote !== result.evidenceQuote ||
    existing.confidence !== result.confidence ||
    existing.proposedCompletionDate !== result.proposedCompletionDate
  );
}

export function buildReconciliationQueueRow(runId: string, reconId: string, result: ReconciliationResult): readonly unknown[] {
  const { cluster } = result;
  return [
    reconId, // A Recon_ID
    runId, // B Run_ID
    ITEM_TYPE_TASK, // C Item_Type
    cluster.tasks.map((t) => t.taskId).join(','), // D Source_Task_ID (comma-joined)
    cluster.contactId, // E BHC_ID
    cluster.contactName, // F Contact_Name
    cluster.description, // G Item_Description
    result.verdict, // H Verdict
    result.evidenceQuote, // I Evidence_Quote
    result.evidenceSource, // J Evidence_Source
    result.proposedCompletionDate, // K Proposed_Completion_Date
    result.confidence, // L Confidence
    result.brainReasoning, // M Brain_Reasoning
    '', // N Status — blank, awaiting Bobby's review
    '', // O Placeholder_Activity_ID — PASS 0's field only; always blank for a task row
  ];
}
