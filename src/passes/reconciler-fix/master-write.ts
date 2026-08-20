/**
 * Reconciler Fix Phase 2 - the guarded Master_ID write primitive.
 *
 * Every write this routine makes goes through here, so the invariants live in
 * one place rather than being re-typed per pass:
 *
 *   1. SMALL EXPLICIT RANGE, one cell (non-negotiable 2). Never a positional
 *      full-row write, which would carry every other column along with it.
 *   2. COL A SELF-CHECK, read immediately before AND after the write. Col A is
 *      READ-ONLY to this routine in every pass, for any reason: four separate
 *      allocators derive the next BHC_ID by scanning col A for the maximum, so
 *      an altered ID is reallocatable to a different human. This is PASS 7's
 *      invariant, scoped to the one write in front of us.
 *   3. QA READ-BACK of the written cell (non-negotiable 4). "The update call
 *      returned" is intent; re-reading the cell is outcome.
 *
 * A col-A change is a HARD STOP for that row - not a warning. It means
 * something wrote to a column this routine has no permission to touch, and per
 * PASS 7 it is "the one failure here that cannot be undone by re-running".
 */

import type { Logger, MasterSheetPort } from './ports.js';

/** Columns this routine may write. Col A, B and D are absent on purpose. */
export type WritableColumn = 'C' | 'E' | 'F';

export type WriteOutcome =
  | 'written'
  | 'readback_mismatch'
  | 'col_a_changed'
  | 'error';

export interface MasterWriteResult {
  readonly masterRow: number;
  readonly column: WritableColumn;
  readonly intended: string;
  readonly outcome: WriteOutcome;
  readonly found: string;
  readonly detail: string;
}

export function isHardStop(r: MasterWriteResult): boolean {
  return r.outcome === 'col_a_changed';
}

function cellOf(rows: readonly (readonly unknown[])[]): string {
  return String(rows[0]?.[0] ?? '').trim();
}

/**
 * Write one Master_ID cell, verifying col A on both sides and reading the cell
 * back. Never throws for an ordinary failure - it returns the outcome so the
 * caller can log and continue (non-negotiable 5: one bad row never aborts a run).
 */
export async function writeMasterCell(
  sheets: MasterSheetPort,
  logger: Logger,
  opts: {
    readonly masterRow: number;
    readonly column: WritableColumn;
    readonly value: string;
    /** The BHC_ID col A must hold, before and after. */
    readonly expectedBhcId: string;
  },
): Promise<MasterWriteResult> {
  const { masterRow, column, value, expectedBhcId } = opts;
  const aRange = `Master_ID!A${masterRow}:A${masterRow}`;
  const cellRange = `Master_ID!${column}${masterRow}:${column}${masterRow}`;
  const base = { masterRow, column, intended: value };

  try {
    const before = cellOf(await sheets.read(aRange));
    if (before !== expectedBhcId) {
      const detail = `col A reads ${JSON.stringify(before)}, expected ${JSON.stringify(expectedBhcId)} - refusing to write`;
      logger.warn(`  ${cellRange}: ${detail}`);
      return { ...base, outcome: 'col_a_changed', found: before, detail };
    }

    await sheets.update(cellRange, [[value]]);

    // Col A first: if this routine has somehow written outside its permitted
    // columns, that matters more than whether the intended cell landed.
    const after = cellOf(await sheets.read(aRange));
    if (after !== expectedBhcId) {
      const detail = `col A CHANGED during the write: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
      logger.warn(`  ${cellRange}: ${detail}`);
      return { ...base, outcome: 'col_a_changed', found: after, detail };
    }

    const got = cellOf(await sheets.read(cellRange));
    if (got !== value.trim()) {
      const detail = `read-back mismatch: cell holds ${JSON.stringify(got)}, wrote ${JSON.stringify(value)}`;
      logger.warn(`  ${cellRange}: ${detail}`);
      return { ...base, outcome: 'readback_mismatch', found: got, detail };
    }

    return { ...base, outcome: 'written', found: got, detail: `${cellRange} = ${JSON.stringify(value)}` };
  } catch (e) {
    const detail = String(e).slice(0, 200);
    logger.warn(`  ${cellRange}: write failed - ${detail}`);
    return { ...base, outcome: 'error', found: '', detail };
  }
}
