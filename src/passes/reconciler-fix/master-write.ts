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
 *
 * ⚠ TWO PRIMITIVES, BECAUSE COLUMNS C/E AND COLUMN F ARE DIFFERENT KINDS OF CELL.
 * C (Location) and E (Attio_Record_ID) hold ONE value: overwriting is correct,
 * and `writeMasterCell` does exactly that. F (Notes) holds HISTORY - human
 * notes, merge records, dated corrections, earlier Fix notes joined with " | ".
 * Overwriting it erases that history. Until 2026-09-13 every Fix note went
 * through the overwrite, against a spec that says "Append to Master_ID!F" for
 * every one. It overwrote eight live rows; version history showed two had held
 * real content that was lost - Lana Hougham's "Family Member", a HUMAN
 * classification recorded nowhere else, and Patrick Suarez's "Contacts
 * triage", provenance - both restored the same day. Notes now go through
 * `appendMasterNote`, and `writeMasterCell` cannot take column F at all - by
 * type, not by discipline.
 */

import type { Logger, MasterSheetPort } from './ports.js';

/**
 * Columns `writeMasterCell` may OVERWRITE. Col A, B and D are absent on purpose,
 * and so is F: notes are appended, never overwritten - see `appendMasterNote`.
 */
export type WritableColumn = 'C' | 'E';

export type WriteOutcome =
  | 'written'
  | 'already_present'   // appendMasterNote only: the same condition is already recorded; nothing written
  | 'readback_mismatch'
  | 'col_a_changed'
  | 'error';

export interface MasterWriteResult {
  readonly masterRow: number;
  readonly column: WritableColumn | 'F';
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

// --- Column F: notes are APPENDED, and a repeated condition is recorded ONCE --

export const NOTE_SEPARATOR = ' | ';

/**
 * What makes two notes "the same condition": the same MARKER, the same FIELD
 * (when the note concerns one) and the same EXPECTED value. The run ID is
 * deliberately not part of it, so a condition that recurs every run - an A3
 * repoint to the same record, an I1 conflict on the same address - is recorded
 * once rather than appended again on every run.
 */
export interface NoteKey {
  /** The note's leading marker, e.g. `A3-FIXED`. Matched as the segment's prefix. */
  readonly marker: string;
  /** e.g. `Email`. Omit for notes that are not about one field. */
  readonly field?: string;
  /** The value that identifies this condition, e.g. the new record id. Omit when the marker alone does. */
  readonly expected?: string;
}

/** Does an existing note segment record the same condition as `key`? Pure. */
export function sameCondition(segment: string, key: NoteKey): boolean {
  const seg = segment.trim();
  if (!seg.startsWith(`${key.marker}:`)) return false;
  if (key.field !== undefined && key.field !== '' && !seg.includes(key.field)) return false;
  if (key.expected !== undefined && key.expected !== '' && !seg.includes(key.expected)) return false;
  return true;
}

/** Existing notes, split on the separator. Pure. */
export function noteSegments(existing: string): string[] {
  return existing.split(NOTE_SEPARATOR).map((x) => x.trim()).filter((x) => x !== '');
}

/** The cell value after appending. Pure. */
export function composeNotes(existing: string, note: string): string {
  const prior = existing.trim();
  return prior === '' ? note.trim() : `${prior}${NOTE_SEPARATOR}${note.trim()}`;
}

/**
 * Append one note to Master_ID column F - unless the same condition is already
 * recorded there.
 *
 * Same guards as `writeMasterCell` - col A checked before and after, one cell,
 * read back - plus the two that make it an append:
 *
 *   1. The existing cell is READ and the note is joined onto it with " | ".
 *      Nothing already in the cell is removed or rewritten.
 *   2. If any existing segment already records the same condition (see
 *      `sameCondition`), NOTHING is written and the outcome is `already_present`.
 *
 * The read-back must EQUAL the composed value exactly. "Contains the note"
 * would pass an overwrite - a cell holding only the new note contains it - and
 * would pass a concurrent edit that replaced the history.
 */
export async function appendMasterNote(
  sheets: MasterSheetPort,
  logger: Logger,
  opts: {
    readonly masterRow: number;
    readonly note: string;
    readonly key: NoteKey;
    /** The BHC_ID col A must hold, before and after. */
    readonly expectedBhcId: string;
  },
): Promise<MasterWriteResult> {
  const { masterRow, note, key, expectedBhcId } = opts;
  const aRange = `Master_ID!A${masterRow}:A${masterRow}`;
  const cellRange = `Master_ID!F${masterRow}:F${masterRow}`;
  const base = { masterRow, column: 'F' as const, intended: note };

  try {
    const before = cellOf(await sheets.read(aRange));
    if (before !== expectedBhcId) {
      const detail = `col A reads ${JSON.stringify(before)}, expected ${JSON.stringify(expectedBhcId)} - refusing to write`;
      logger.warn(`  ${cellRange}: ${detail}`);
      return { ...base, outcome: 'col_a_changed', found: before, detail };
    }

    const existing = cellOf(await sheets.read(cellRange));
    if (noteSegments(existing).some((segment) => sameCondition(segment, key))) {
      return {
        ...base, outcome: 'already_present', found: existing,
        detail: `${cellRange} already records ${key.marker}${key.field ? ` ${key.field}` : ''}${key.expected ? ` ${key.expected}` : ''} - not appended again`,
      };
    }

    const composed = composeNotes(existing, note);

    // ⚠ THE HAND-EDIT WINDOW. Fix runs one at a time and bhc-aida never writes
    // column F, but a PERSON can edit the notes cell in the sheet. An edit that
    // lands between the read above and this write is REPLACED SILENTLY: this
    // update carries the history as it was read, without that edit, and the
    // read-back below then equals exactly what was sent. Only an edit landing
    // AFTER this write and BEFORE the read-back is caught, by exact equality.
    // A Sheets update carries no if-unchanged condition, so nothing here can
    // fully prevent it; reading immediately before writing only makes it rare.
    await sheets.update(cellRange, [[composed]]);

    const after = cellOf(await sheets.read(aRange));
    if (after !== expectedBhcId) {
      const detail = `col A CHANGED during the note write: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
      logger.warn(`  ${cellRange}: ${detail}`);
      return { ...base, outcome: 'col_a_changed', found: after, detail };
    }

    const got = cellOf(await sheets.read(cellRange));
    if (got !== composed) {
      const detail = `read-back mismatch: cell holds ${JSON.stringify(got.slice(0, 160))}, expected the appended ${JSON.stringify(composed.slice(0, 160))}`;
      logger.warn(`  ${cellRange}: ${detail}`);
      return { ...base, outcome: 'readback_mismatch', found: got, detail };
    }

    return { ...base, outcome: 'written', found: got, detail: `${cellRange} appended ${JSON.stringify(note.slice(0, 80))}` };
  } catch (e) {
    const detail = String(e).slice(0, 200);
    logger.warn(`  ${cellRange}: note append failed - ${detail}`);
    return { ...base, outcome: 'error', found: '', detail };
  }
}
