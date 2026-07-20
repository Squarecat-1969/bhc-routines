/**
 * Part D STEP 3 — branch on command. Spec:
 *   "PROCEED: Set col V = TRUE for all run-set rows."
 *   "CORRECTIONS: For each {n, note}: find digest-position-[n] row, append
 *    CORRECTION: {note} to col U, leave col V blank."
 *   "RESOLVE: Continue to STEP 4" (process every row with non-empty
 *    Write_Targets; empty Write_Targets -> mark V=TRUE, nothing to write).
 * Plus STEP 4-MIXED (this session's addition, not in the original spec):
 * per-item ACCEPT / CORRECT / DISMISS from a single command.
 *
 * "Append CORRECTION: {note} to col U" is a real read-then-append, not a
 * write to a blank column — col U is Brain_Notes (brain-complete-row.ts:
 * "K/L/M/N/O/P/T/U overridden by enrichment content"), populated by PASS
 * 2's own enrichment output and potentially already non-empty. Confirmed
 * against that source before writing this, not assumed.
 *
 * RunSetRow maps directly onto WriteRowInput (same field names, sheetRow ->
 * brainCompleteRow) for every field except writeTargets, which is nullable
 * on RunSetRow and required on WriteRowInput — toWriteRowInput narrows that
 * for exactly the call sites (RESOLVE, MIXED's ACCEPT) that already checked
 * writeTargets is non-null before calling it.
 */

import type { AttioClient } from '../lib/attio.js';
import type { MasterIdIndex } from '../passes/pass4/load.js';
import type { SheetsClient } from '../lib/sheets.js';
import type { ItemAction } from './parse-command.js';
import { qaVerifyAndClose, type QAResult } from './qa-readback.js';
import type { RunSet, RunSetRow } from './load-run-set.js';
import type { WriteRowInput, WriteRowResult } from './types.js';
import { writeRow } from './write-row.js';

export type RowOutcome =
  | 'closed' // PROCEED — V=TRUE, no write
  | 'corrected' // CORRECTIONS / MIXED CORRECT — col U appended, V left blank
  | 'dismissed' // MIXED DISMISS — V=TRUE, no write
  | 'resolved' // RESOLVE / MIXED ACCEPT — writeRow + QA ran
  | 'skipped_no_target' // writeTargets was null — V=TRUE, nothing to write
  | 'skipped_invalid_position'; // {n} didn't match any digest position in the run set

export interface AppliedRowResult {
  readonly digestPosition: number | null;
  readonly bhcId: string | null; // null only for skipped_invalid_position, where there's no row to attribute this to
  readonly outcome: RowOutcome;
  /** Present only for 'resolved' rows — confirm.ts's own source of truth for Google/Attio/task counts, rather than reverse-engineering them from QA's check labels (which exist to verify writes, not to enumerate them for a different caller). */
  readonly writeResult?: WriteRowResult;
  readonly qa?: QAResult;
  readonly warnings: readonly string[];
}

export interface BranchResult {
  readonly command: 'PROCEED' | 'CORRECTIONS' | 'RESOLVE' | 'MIXED';
  readonly runId: string;
  readonly runSetSize: number;
  readonly applied: readonly AppliedRowResult[];
  /** Malformed MIXED lines, passed through from parse-command.ts for confirm.ts's own "N line(s) skipped" reporting. */
  readonly skippedLines: readonly string[];
}

function toWriteRowInput(row: RunSetRow): WriteRowInput {
  if (!row.writeTargets) throw new Error(`toWriteRowInput called on a row with no writeTargets (digest position ${row.digestPosition ?? 'n/a'}) — caller must check first`);
  return {
    bhcId: row.bhcId,
    contactName: row.contactName,
    direction: row.direction,
    subject: row.subject,
    runningSummary: row.runningSummary,
    writeTargets: row.writeTargets,
    tasks: row.tasks,
    brainCompleteRow: row.sheetRow,
  };
}

async function appendCorrection(sheets: SheetsClient, sheetRow: number, note: string): Promise<void> {
  const existing = await sheets.read(`Brain_Complete!U${sheetRow}:U${sheetRow}`);
  const existingText = String(existing[0]?.[0] ?? '');
  const entry = `CORRECTION: ${note}`;
  const combined = existingText ? `${existingText}\n${entry}` : entry;
  await sheets.update(`Brain_Complete!U${sheetRow}:U${sheetRow}`, [[combined]]);
}

async function closeRow(sheets: SheetsClient, sheetRow: number): Promise<void> {
  await sheets.update(`Brain_Complete!V${sheetRow}:V${sheetRow}`, [['TRUE']]);
}

async function resolveOneRow(
  sheets: SheetsClient,
  attio: AttioClient,
  masterId: MasterIdIndex,
  row: RunSetRow,
): Promise<AppliedRowResult> {
  if (!row.writeTargets) {
    await closeRow(sheets, row.sheetRow);
    return { digestPosition: row.digestPosition, bhcId: row.bhcId, outcome: 'skipped_no_target', warnings: [] };
  }
  const input = toWriteRowInput(row);
  const writeResult = await writeRow(sheets, attio, masterId, input);
  const qa = await qaVerifyAndClose(sheets, attio, masterId, input, writeResult);
  return { digestPosition: row.digestPosition, bhcId: row.bhcId, outcome: 'resolved', writeResult, qa, warnings: [...writeResult.warnings, ...qa.warnings] };
}

export async function applyProceed(sheets: SheetsClient, runSet: RunSet): Promise<BranchResult> {
  const applied: AppliedRowResult[] = [];
  for (const row of runSet.rows) {
    await closeRow(sheets, row.sheetRow);
    applied.push({ digestPosition: row.digestPosition, bhcId: row.bhcId, outcome: 'closed', warnings: [] });
  }
  return { command: 'PROCEED', runId: runSet.runId, runSetSize: runSet.rows.length, applied, skippedLines: [] };
}

export async function applyCorrections(
  sheets: SheetsClient,
  runSet: RunSet,
  corrections: readonly { n: number; note: string }[],
): Promise<BranchResult> {
  const applied: AppliedRowResult[] = [];
  for (const { n, note } of corrections) {
    const row = runSet.byDigestPosition.get(n);
    if (!row) {
      applied.push({ digestPosition: n, bhcId: null, outcome: 'skipped_invalid_position', warnings: [`Line for position ${n} skipped — no matching row`] });
      continue;
    }
    await appendCorrection(sheets, row.sheetRow, note);
    applied.push({ digestPosition: n, bhcId: row.bhcId, outcome: 'corrected', warnings: [] });
  }
  return { command: 'CORRECTIONS', runId: runSet.runId, runSetSize: runSet.rows.length, applied, skippedLines: [] };
}

export async function applyResolve(
  sheets: SheetsClient,
  attio: AttioClient,
  masterId: MasterIdIndex,
  runSet: RunSet,
): Promise<BranchResult> {
  const applied: AppliedRowResult[] = [];
  for (const row of runSet.rows) {
    applied.push(await resolveOneRow(sheets, attio, masterId, row));
  }
  return { command: 'RESOLVE', runId: runSet.runId, runSetSize: runSet.rows.length, applied, skippedLines: [] };
}

export async function applyMixed(
  sheets: SheetsClient,
  attio: AttioClient,
  masterId: MasterIdIndex,
  runSet: RunSet,
  itemActions: readonly ItemAction[],
  skippedLines: readonly string[],
): Promise<BranchResult> {
  const applied: AppliedRowResult[] = [];
  // Process in ascending digest-position order, per spec — itemActions may
  // not arrive in that order (Bobby's own submission order isn't
  // guaranteed to match digest order).
  const sorted = [...itemActions].sort((a, b) => a.n - b.n);

  for (const action of sorted) {
    const row = runSet.byDigestPosition.get(action.n);
    if (!row) {
      applied.push({ digestPosition: action.n, bhcId: null, outcome: 'skipped_invalid_position', warnings: [`Line for position ${action.n} skipped — no matching row`] });
      continue;
    }

    if (action.action === 'DISMISS') {
      await closeRow(sheets, row.sheetRow);
      applied.push({ digestPosition: action.n, bhcId: row.bhcId, outcome: 'dismissed', warnings: [] });
      continue;
    }
    if (action.action === 'CORRECT') {
      await appendCorrection(sheets, row.sheetRow, action.note);
      applied.push({ digestPosition: action.n, bhcId: row.bhcId, outcome: 'corrected', warnings: [] });
      continue;
    }
    // ACCEPT — reuses the exact same per-row resolution RESOLVE uses, just
    // for one row instead of a loop over the whole run set. Not a second
    // implementation of "how to resolve a row."
    applied.push(await resolveOneRow(sheets, attio, masterId, row));
  }

  // Any digest position mentioned more than once in itemActions only gets
  // processed once above (Map lookup keyed by digest position is the same
  // row object regardless of how many action lines named it) — but the
  // spec's own model is "each row appears once," so this isn't something
  // that needs de-duplicating further; a second line for the same position
  // just re-runs whatever it says, which is a Bobby-authored ambiguity, not
  // something this function should silently resolve on his behalf.

  return { command: 'MIXED', runId: runSet.runId, runSetSize: runSet.rows.length, applied, skippedLines };
}
