/**
 * Reconciler Fix PASS 3 - S1, duplicate BHC_IDs. FLAG ONLY, never resolve.
 *
 * The single most restricted pass in the routine. It writes ONE cell per
 * orphan - col F, a note - and nothing else, ever.
 *
 * WHY IT NEVER RESOLVES. Two independent reasons from the spec, either of which
 * alone would be sufficient:
 *
 *   1. Clearing col A is forbidden outright. Four separate allocators derive
 *      the next BHC_ID by scanning col A for the maximum, so a cleared ID
 *      becomes REALLOCATABLE - handed back out to a different human. No damage
 *      has occurred to date only because the four IDs S1 has ever cleared sit
 *      mid-sequence, below the maximum.
 *   2. A duplicate BHC_ID is not mechanically resolvable at all. Deciding which
 *      row is which person is a human identity judgment, and getting it wrong
 *      merges two people. Seven BHC_IDs are currently stamped on more than one
 *      live Attio record, and two of those (BHC-02493/02494) are INTENTIONAL
 *      merge groups awaiting a merge - a scoring heuristic cannot tell those
 *      apart from genuine corruption.
 *
 * So the scorer is used only to decide which row to leave alone. It never
 * confers permission to change anything.
 */

import { chooseCanonical, groupByDuplicateBhcId, type CandidateRow } from './canonical.js';
import { isHardStop, writeMasterCell, type MasterWriteResult } from './master-write.js';
import type { Logger, MasterSheetPort } from './ports.js';

/** A candidate plus the Master_ID full_name the note needs to name the canonical. */
export type S1Row = CandidateRow & { readonly fullName: string };

export type S1GroupOutcome = 'flagged' | 'nothing_to_do';

export interface S1GroupResult {
  readonly bhcId: string;
  readonly outcome: S1GroupOutcome;
  readonly canonicalRow: number | null;
  readonly orphansFlagged: readonly number[];
  readonly writes: readonly MasterWriteResult[];
  readonly reason: string;
}

export interface S1Result {
  readonly groups: readonly S1GroupResult[];
  readonly counts: {
    readonly groups: number;
    readonly orphansFlagged: number;
    readonly hardStops: number;
    readonly writeFailures: number;
  };
}

/**
 * The S1-DUPLICATE note.
 *
 * The canonical is named by NAME, not BHC_ID - unavoidably, because every row in
 * an S1 group carries the SAME BHC_ID, so "also appears on the row for
 * BHC-00143" would point at itself. The spec's own template says
 * "{canonical_bhc_id_or_name}" for exactly this reason. Still no row number
 * (non-negotiable 6b).
 */
export function s1DuplicateNote(bhcId: string, canonicalName: string, fixRunId: string): string {
  const who = canonicalName.trim() !== '' ? canonicalName.trim() : '(unnamed row)';
  return `S1-DUPLICATE: BHC_ID ${bhcId} also appears on the row for ${who}. Flagged for review by Reconciler Fix ${fixRunId}. No BHC_ID or pointer changed - Notes only.`;
}

export async function repairS1(
  rows: readonly S1Row[],
  deps: { sheets: MasterSheetPort; logger: Logger; fixRunId: string },
): Promise<S1Result> {
  const { sheets, logger, fixRunId } = deps;
  const groups: S1GroupResult[] = [];

  for (const [bhcId, members] of groupByDuplicateBhcId(rows)) {
    groups.push(await flagGroup(bhcId, members as readonly S1Row[], { sheets, logger, fixRunId }));
  }

  const flat = groups.flatMap((g) => g.writes);
  return {
    groups,
    counts: {
      groups: groups.length,
      orphansFlagged: groups.reduce((n, g) => n + g.orphansFlagged.length, 0),
      hardStops: flat.filter(isHardStop).length,
      writeFailures: flat.filter((w) => w.outcome === 'readback_mismatch' || w.outcome === 'error').length,
    },
  };
}

async function flagGroup(
  bhcId: string,
  members: readonly S1Row[],
  deps: { sheets: MasterSheetPort; logger: Logger; fixRunId: string },
): Promise<S1GroupResult> {
  const { sheets, logger, fixRunId } = deps;

  // SUPERSEDED rows are excluded inside chooseCanonical (non-negotiable 6c) -
  // a retirement is correct as it stands and must never be flagged as a duplicate.
  const scored = chooseCanonical(members);
  if (scored.excludedSuperseded.length > 0) {
    logger.info(`  ${bhcId}: ${scored.excludedSuperseded.length} SUPERSEDED row(s) excluded from the group`);
  }
  if (!scored.canonical || scored.orphans.length === 0) {
    return {
      bhcId, outcome: 'nothing_to_do', canonicalRow: scored.canonical?.masterRow ?? null,
      orphansFlagged: [], writes: [],
      reason: scored.canonical ? 'only one live row after exclusions - not a duplicate' : 'every member was SUPERSEDED',
    };
  }

  const canonical = scored.canonical as S1Row;
  const writes: MasterWriteResult[] = [];
  const flagged: number[] = [];

  for (const orphan of scored.orphans) {
    // ONE write. Column F. Nothing else - not C, not D, not E, and never A.
    const note = await writeMasterCell(sheets, logger, {
      masterRow: orphan.masterRow, column: 'F',
      value: s1DuplicateNote(bhcId, canonical.fullName, fixRunId),
      expectedBhcId: orphan.bhcId,
    });
    writes.push(note);
    if (isHardStop(note)) {
      logger.warn(`  HARD STOP on ${bhcId} @ row ${orphan.masterRow}: ${note.detail}`);
      continue;
    }
    if (note.outcome !== 'written') continue;
    flagged.push(orphan.masterRow);
  }

  return {
    bhcId, outcome: 'flagged', canonicalRow: canonical.masterRow, orphansFlagged: flagged, writes,
    reason: `${flagged.length}/${scored.orphans.length} orphan row(s) flagged for review`,
  };
}
