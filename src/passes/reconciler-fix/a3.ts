/**
 * Reconciler Fix PASS 5 - A3, dead Attio record IDs. Master_ID writes only.
 *
 * READS Attio (queries people by bhc_contact_id, which is the whole point of
 * the pass: find out whether the record moved or is genuinely gone) but NEVER
 * writes to it - the injected port has no write method.
 *
 * Four outcomes, straight from the spec:
 *   A  exactly one record  -> repoint Master_ID col E at the live record_id
 *   B  zero records        -> Location = GOOGLE, col E cleared
 *   C  two or more         -> NEEDS_MANUAL, write nothing. Never guess.
 *   D  lookup failed       -> manual list, continue
 */

import { isHardStop, writeMasterCell, type MasterWriteResult } from './master-write.js';
import type { AttioReadPort, Logger, MasterSheetPort } from './ports.js';

export interface A3Candidate {
  readonly masterRow: number;
  readonly bhcId: string;
  readonly fullName: string;
  readonly location: string;
  /** The dead pointer currently in col E. */
  readonly attioRecordId: string;
}

export type A3Outcome =
  | 'repointed'        // A
  | 'set_google_only'  // B
  | 'ambiguous'        // C - NEEDS_MANUAL
  | 'lookup_failed'    // D
  | 'write_failed'
  | 'hard_stop'
  | 'skipped_superseded';

export interface A3RowResult {
  readonly bhcId: string;
  readonly masterRow: number;
  readonly outcome: A3Outcome;
  readonly matchCount: number;
  readonly newRecordId: string | null;
  readonly writes: readonly MasterWriteResult[];
  readonly reason: string;
}

export interface A3Result {
  readonly rows: readonly A3RowResult[];
  readonly counts: {
    readonly considered: number;
    readonly repointed: number;
    readonly setGoogleOnly: number;
    readonly ambiguous: number;
    readonly lookupFailed: number;
    readonly writeFailed: number;
    readonly hardStops: number;
  };
}

/** Notes reference the contact by BHC_ID, never a row number (non-negotiable 6b). */
export function a3RepointNote(oldId: string, newId: string, fixRunId: string): string {
  return `A3-FIXED: Attio record_id updated from ${oldId} to ${newId} by Reconciler Fix ${fixRunId}.`;
}
export function a3GoogleOnlyNote(fixRunId: string): string {
  return `A3-FIXED: no Attio record found. Location set to GOOGLE, Attio_Record_ID cleared by Reconciler Fix ${fixRunId}.`;
}
export function a3AmbiguousNote(n: number, fixRunId: string): string {
  return `A3-AMBIGUOUS: ${n} Attio records found. Manual review required. Reconciler Fix ${fixRunId}.`;
}

export async function repairA3(
  candidates: readonly A3Candidate[],
  deps: { sheets: MasterSheetPort; attio: AttioReadPort; logger: Logger; fixRunId: string },
): Promise<A3Result> {
  const rows: A3RowResult[] = [];
  for (const c of candidates) {
    rows.push(await repairOne(c, deps));
  }

  const count = (o: A3Outcome) => rows.filter((r) => r.outcome === o).length;
  return {
    rows,
    counts: {
      considered: rows.length,
      repointed: count('repointed'),
      setGoogleOnly: count('set_google_only'),
      ambiguous: count('ambiguous'),
      lookupFailed: count('lookup_failed'),
      writeFailed: count('write_failed'),
      hardStops: count('hard_stop'),
    },
  };
}

async function repairOne(
  c: A3Candidate,
  deps: { sheets: MasterSheetPort; attio: AttioReadPort; logger: Logger; fixRunId: string },
): Promise<A3RowResult> {
  const { sheets, attio, logger, fixRunId } = deps;
  const base = { bhcId: c.bhcId, masterRow: c.masterRow, writes: [] as MasterWriteResult[] };

  // A retirement is correct as it stands (non-negotiable 6c). One should never
  // reach this routine; if one does, skip it rather than rewriting its Location.
  if (c.location.trim().toUpperCase() === 'SUPERSEDED') {
    return { ...base, outcome: 'skipped_superseded', matchCount: 0, newRecordId: null, reason: 'SUPERSEDED row - retired identity, left untouched' };
  }

  let matches: readonly { recordId: string }[];
  try {
    matches = await attio.queryByBhcContactId(c.bhcId);
  } catch (e) {
    const reason = `lookup failed: ${String(e).slice(0, 140)}`;
    logger.warn(`  ${c.bhcId}: ${reason}`);
    return { ...base, outcome: 'lookup_failed', matchCount: 0, newRecordId: null, reason };
  }

  // Outcome C - ambiguous. Do NOT touch Master_ID. Note only.
  if (matches.length > 1) {
    const reason = `${matches.length} Attio records carry ${c.bhcId} - ambiguous, manual review required`;
    logger.warn(`  ${c.bhcId}: ${reason}`);
    const note = await writeMasterCell(sheets, logger, {
      masterRow: c.masterRow, column: 'F', value: a3AmbiguousNote(matches.length, fixRunId), expectedBhcId: c.bhcId,
    });
    return { ...base, outcome: isHardStop(note) ? 'hard_stop' : 'ambiguous', matchCount: matches.length, newRecordId: null, writes: [note], reason };
  }

  // Outcome B - zero results. Google-only: Location = GOOGLE, pointer cleared.
  if (matches.length === 0) {
    const writes: MasterWriteResult[] = [];
    const loc = await writeMasterCell(sheets, logger, { masterRow: c.masterRow, column: 'C', value: 'GOOGLE', expectedBhcId: c.bhcId });
    writes.push(loc);
    if (isHardStop(loc)) return { ...base, outcome: 'hard_stop', matchCount: 0, newRecordId: null, writes, reason: loc.detail };
    if (loc.outcome !== 'written') return { ...base, outcome: 'write_failed', matchCount: 0, newRecordId: null, writes, reason: loc.detail };

    const clear = await writeMasterCell(sheets, logger, { masterRow: c.masterRow, column: 'E', value: '', expectedBhcId: c.bhcId });
    writes.push(clear);
    if (isHardStop(clear)) return { ...base, outcome: 'hard_stop', matchCount: 0, newRecordId: null, writes, reason: clear.detail };
    if (clear.outcome !== 'written') return { ...base, outcome: 'write_failed', matchCount: 0, newRecordId: null, writes, reason: clear.detail };

    // Note last, only after both writes verified (note discipline 1).
    writes.push(await writeMasterCell(sheets, logger, { masterRow: c.masterRow, column: 'F', value: a3GoogleOnlyNote(fixRunId), expectedBhcId: c.bhcId }));
    return { ...base, outcome: 'set_google_only', matchCount: 0, newRecordId: null, writes, reason: 'no Attio record found - contact is Google-only' };
  }

  // Outcome A - exactly one. Repoint col E at the live record.
  const newId = matches[0]!.recordId;
  const writes: MasterWriteResult[] = [];
  const repoint = await writeMasterCell(sheets, logger, { masterRow: c.masterRow, column: 'E', value: newId, expectedBhcId: c.bhcId });
  writes.push(repoint);
  if (isHardStop(repoint)) return { ...base, outcome: 'hard_stop', matchCount: 1, newRecordId: null, writes, reason: repoint.detail };
  if (repoint.outcome !== 'written') return { ...base, outcome: 'write_failed', matchCount: 1, newRecordId: null, writes, reason: repoint.detail };

  writes.push(await writeMasterCell(sheets, logger, {
    masterRow: c.masterRow, column: 'F', value: a3RepointNote(c.attioRecordId, newId, fixRunId), expectedBhcId: c.bhcId,
  }));
  return { ...base, outcome: 'repointed', matchCount: 1, newRecordId: newId, writes, reason: `record moved to ${newId}` };
}
