/**
 * Reconciler Fix PASS 6 - S4, duplicate Attio pointers. Master_ID writes only.
 *
 * READS Attio (Step 2 fetches the record to learn who actually owns it) but
 * NEVER writes to it - the injected port has no write method at all.
 *
 * Grouping and scoring come from Phase 1 (groupBySharedAttioPointer,
 * chooseCanonical) rather than being restated here: the 245-blank-col-E trap
 * and the SUPERSEDED exclusion are already solved and tested there.
 */

import { chooseCanonical, groupBySharedAttioPointer, type CandidateRow } from './canonical.js';
import { isHardStop, writeMasterCell, type MasterWriteResult } from './master-write.js';
import { sharesWord } from '../../lib/name-match.js';
import type { AttioReadPort, Logger, MasterSheetPort } from './ports.js';

/**
 * A candidate plus the Master_ID full_name that Step 2's name comparison needs.
 *
 * Declared here rather than widening Phase 1's CandidateRow: scoring genuinely
 * does not care about the name, and adding a field the scorer ignores would
 * invite someone to start scoring on it later.
 */
export type S4Row = CandidateRow & { readonly fullName: string };

export type S4GroupOutcome = 'repaired' | 'needs_manual' | 'lookup_failed' | 'nothing_to_do';

export interface S4GroupResult {
  readonly attioRecordId: string;
  readonly outcome: S4GroupOutcome;
  readonly canonicalBhcId: string | null;
  /** True when Step 2's Attio evidence overrode Phase 1's score-based pick. */
  readonly canonicalFromAttio: boolean;
  readonly orphansCleared: readonly string[];
  readonly writes: readonly MasterWriteResult[];
  readonly reason: string;
}

export interface S4Result {
  readonly groups: readonly S4GroupResult[];
  readonly counts: {
    readonly groups: number;
    readonly repaired: number;
    readonly needsManual: number;
    readonly lookupFailed: number;
    readonly orphansCleared: number;
    readonly hardStops: number;
  };
}

/**
 * The S4-ORPHAN note.
 *
 * DELIBERATE DEVIATION FROM THE SPEC'S OWN TEMPLATE. PASS 6 Step 3 writes
 * "belongs to {canonical_bhc_id} at row {canonical_row}" - but non-negotiable
 * 6b says "Never write a row number into a note", because row references decay
 * as rows are inserted above them (notes from 2026-06-12 are off by +11 today).
 * The template contradicts the rule; the rule wins and carries its own
 * reasoning. The canonical is identified by BHC_ID, which is stable.
 */
export function s4OrphanNote(attioRecordId: string, canonicalBhcId: string, fixRunId: string): string {
  return `S4-ORPHAN: Attio_Record_ID ${attioRecordId} belongs to ${canonicalBhcId}. Pointer cleared by Reconciler Fix ${fixRunId}.`;
}

export async function repairS4(
  rows: readonly S4Row[],
  deps: { sheets: MasterSheetPort; attio: AttioReadPort; logger: Logger; fixRunId: string },
): Promise<S4Result> {
  const { sheets, attio, logger, fixRunId } = deps;
  const groups: S4GroupResult[] = [];

  for (const [attioRecordId, members] of groupBySharedAttioPointer(rows)) {
    groups.push(await repairGroup(attioRecordId, members as readonly S4Row[], { sheets, attio, logger, fixRunId }));
  }

  const flat = groups.flatMap((g) => g.writes);
  return {
    groups,
    counts: {
      groups: groups.length,
      repaired: groups.filter((g) => g.outcome === 'repaired').length,
      needsManual: groups.filter((g) => g.outcome === 'needs_manual').length,
      lookupFailed: groups.filter((g) => g.outcome === 'lookup_failed').length,
      orphansCleared: groups.reduce((n, g) => n + g.orphansCleared.length, 0),
      hardStops: flat.filter(isHardStop).length,
    },
  };
}

async function repairGroup(
  attioRecordId: string,
  members: readonly S4Row[],
  deps: { sheets: MasterSheetPort; attio: AttioReadPort; logger: Logger; fixRunId: string },
): Promise<S4GroupResult> {
  const { sheets, attio, logger, fixRunId } = deps;
  const base = { attioRecordId, orphansCleared: [] as string[], writes: [] as MasterWriteResult[] };

  // Step 1 - score (Phase 1). SUPERSEDED rows are excluded inside chooseCanonical.
  const scored = chooseCanonical(members);
  if (scored.excludedSuperseded.length > 0) {
    logger.warn(`  ${attioRecordId}: ${scored.excludedSuperseded.length} SUPERSEDED row(s) excluded - a retirement should never reach S4`);
  }
  if (!scored.canonical) {
    return { ...base, outcome: 'nothing_to_do', canonicalBhcId: null, canonicalFromAttio: false, reason: 'every member was SUPERSEDED' };
  }

  // Step 2 - ask Attio who actually owns the record. This OVERRIDES scoring.
  let record;
  try {
    record = await attio.getByRecordId(attioRecordId);
  } catch (e) {
    return { ...base, outcome: 'lookup_failed', canonicalBhcId: null, canonicalFromAttio: false, reason: `Attio lookup failed: ${String(e).slice(0, 120)}` };
  }
  if (!record) {
    // The pointer is dead, which is an A3 condition, not an S4 repair. Clearing
    // pointers here would be guessing at which row should have kept it.
    return { ...base, outcome: 'needs_manual', canonicalBhcId: null, canonicalFromAttio: false, reason: `Attio record ${attioRecordId} not found - this is an A3 condition, not S4` };
  }

  const byId = members.find((m) => m.bhcId !== '' && m.bhcId === record.bhcContactId);
  const byName = members.find((m) => sharesWord(record.name, m.fullName));

  // "If no row's BHC_ID matches AND no row's name matches the Attio person's
  // name: flag the whole S4 group as NEEDS_MANUAL - the Attio record may belong
  // to someone not represented in this S4 group."
  if (!byId && !byName) {
    return {
      ...base, outcome: 'needs_manual', canonicalBhcId: null, canonicalFromAttio: false,
      reason: `no member's BHC_ID or name matches the Attio person (${JSON.stringify(record.name)} / ${record.bhcContactId}) - the record may belong to someone outside this group`,
    };
  }

  const canonical = byId ?? byName ?? scored.canonical;
  const canonicalFromAttio = canonical.masterRow !== scored.canonical.masterRow;
  if (canonicalFromAttio) {
    logger.info(`  ${attioRecordId}: Attio evidence overrode scoring - canonical is ${canonical.bhcId}, not ${scored.canonical.bhcId}`);
  }

  // Step 3 - clear each orphan. The canonical row is never modified.
  const orphans = members.filter(
    (m) => m.masterRow !== canonical.masterRow && m.location.trim().toUpperCase() !== 'SUPERSEDED',
  );
  const writes: MasterWriteResult[] = [];
  const cleared: string[] = [];

  for (const orphan of orphans) {
    const clear = await writeMasterCell(sheets, logger, {
      masterRow: orphan.masterRow, column: 'E', value: '', expectedBhcId: orphan.bhcId,
    });
    writes.push(clear);
    if (isHardStop(clear)) {
      logger.warn(`  HARD STOP on ${orphan.bhcId}: ${clear.detail}`);
      continue; // this row only; the run continues (non-negotiable 5)
    }
    if (clear.outcome !== 'written') continue; // failed QA - no note, per note discipline 1

    // Location: an orphan no longer has a valid Attio record.
    //
    // Its outcome is CHECKED, exactly as a3.ts's Outcome B checks each write in
    // sequence. A half-applied repair is the failure mode this three-column
    // write exists to prevent: pointer cleared but Location still BOTH/ATTIO is
    // precisely the S3 defect, so proceeding would repair S4 by manufacturing
    // an S3 - and the note would claim "Pointer cleared" over a row left in a
    // state nobody chose.
    const loc = orphan.location.trim().toUpperCase();
    if (loc === 'BOTH' || loc === 'ATTIO') {
      const locWrite = await writeMasterCell(sheets, logger, {
        masterRow: orphan.masterRow, column: 'C', value: 'GOOGLE', expectedBhcId: orphan.bhcId,
      });
      writes.push(locWrite);
      if (isHardStop(locWrite)) {
        logger.warn(`  HARD STOP on ${orphan.bhcId}: ${locWrite.detail}`);
        continue; // this row only; the run continues (non-negotiable 5)
      }
      if (locWrite.outcome !== 'written') continue; // failed QA - no note, per note discipline 1
    }

    // The note goes LAST and only after the clear was read back - note
    // discipline 1: never describe an action that was not performed and verified.
    const note = await writeMasterCell(sheets, logger, {
      masterRow: orphan.masterRow, column: 'F', value: s4OrphanNote(attioRecordId, canonical.bhcId, fixRunId), expectedBhcId: orphan.bhcId,
    });
    writes.push(note);
    cleared.push(orphan.bhcId);
  }

  return {
    attioRecordId, outcome: 'repaired', canonicalBhcId: canonical.bhcId, canonicalFromAttio,
    orphansCleared: cleared, writes,
    reason: `${cleared.length}/${orphans.length} orphan pointer(s) cleared`,
  };
}
