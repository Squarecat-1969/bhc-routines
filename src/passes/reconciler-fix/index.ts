/**
 * Reconciler Fix - the orchestrator across all five categories.
 *
 * Reads Reconciler_Report for candidates (PASS 1), Master_ID for the row index
 * (PASS 2), then runs S1, A1, A3, S4, I1.
 *
 * DRY-RUN IS THE DEFAULT AND MUST BE CHOSEN AWAY FROM EXPLICITLY. In dry run
 * the ports are swapped for recording no-ops, so the write code paths execute
 * and are counted but no request is ever issued - the same shape resync-ids.yml
 * uses, where live is an explicit choice and never a silent fallback.
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { AttioClient } from '../../lib/attio.js';
import { makeAttioIdentityWritePort, makeMasterSheetPort } from './adapters.js';
import { repairS1, type S1Result, type S1Row } from './s1.js';
import { repairS4, type S4Result, type S4Row } from './s4.js';
import { repairA3, type A3Candidate, type A3Result } from './a3.js';
import { repairA1, type A1Candidate, type A1Result } from './a1.js';
import { repairI1, type I1Candidate, type I1Field, type I1Result } from './i1.js';
import type { AttioIdentityWritePort, Logger, MasterSheetPort } from './ports.js';

const REPORT_RANGE = 'Reconciler_Report!A2:N';
/** Reconciler_Report columns, 0-based, per the live schema. */
const COL = { runId: 0, bhcId: 2, fullName: 3, masterRow: 4, attioRecordId: 6, location: 7, code: 8, expected: 11, found: 12, notes: 13 } as const;

export interface ReconcilerFixReport {
  readonly fixRunId: string;
  readonly dryRun: boolean;
  readonly sourceRunId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly candidates: Readonly<Record<'S1' | 'A1' | 'A3' | 'S4' | 'I1', number>>;
  readonly s1: S1Result;
  readonly a1: A1Result;
  readonly a3: A3Result;
  readonly s4: S4Result;
  readonly i1: I1Result;
  /**
   * BHC_IDs whose A1 finding was skipped because the same pointer is contested
   * by an S4 group this run. A real, distinct category of "not acted on for a
   * good reason" - never folded into A1's needs_manual outcomes.
   */
  readonly excludedFromA1: readonly string[];
  /** Every write that WOULD have been issued, when dryRun. */
  readonly wouldWrite: readonly string[];
  readonly warnings: readonly string[];
}

/** Records what a write WOULD have been, and issues nothing. */
function dryRunPorts(real: { sheets: MasterSheetPort; attio: AttioIdentityWritePort }, sink: string[]): {
  sheets: MasterSheetPort; attio: AttioIdentityWritePort;
} {
  return {
    sheets: {
      read: real.sheets.read,
      async update(range: string, values: unknown[][]) {
        sink.push(`SHEETS ${range} = ${JSON.stringify(values[0]?.[0] ?? '')}`);
        return {};
      },
    },
    attio: {
      getByRecordId: real.attio.getByRecordId,
      queryByBhcContactId: real.attio.queryByBhcContactId,
      queryByEmail: real.attio.queryByEmail,
      async updatePerson(recordId: string, values) {
        sink.push(`ATTIO ${recordId} <- ${JSON.stringify(values)}`);
      },
    },
  };
}

export async function runReconcilerFix(opts: {
  readonly sheets: SheetsClient;
  readonly attio: AttioClient;
  readonly logger: Logger;
  readonly dryRun: boolean;
  readonly fixRunId: string;
}): Promise<ReconcilerFixReport> {
  const { logger, dryRun, fixRunId } = opts;
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const wouldWrite: string[] = [];

  logger.info(`BHC Reconciler Fix - ${fixRunId}`);
  logger.info(`  mode : ${dryRun ? 'DRY RUN (no writes issued anywhere)' : 'LIVE (writes Master_ID + Attio)'}`);

  const realPorts = {
    sheets: makeMasterSheetPort(opts.sheets),
    attio: makeAttioIdentityWritePort(opts.attio),
  };
  const ports = dryRun ? dryRunPorts(realPorts, wouldWrite) : realPorts;

  // PASS 1 - the issue set.
  const report = await opts.sheets.read(REPORT_RANGE);
  const runIds = [...new Set(report.map((r) => cell(r, COL.runId)).filter((v) => v !== ''))];
  const sourceRunId = runIds.length > 0 ? runIds.sort().at(-1)! : null;
  const issues = report.filter((r) => cell(r, COL.runId) === sourceRunId);
  const of = (code: string) => issues.filter((r) => cell(r, COL.code) === code);
  logger.info(`PASS 1 - source run ${sourceRunId ?? '(none)'} · ${issues.length} row(s)`);

  // PASS 2 - Master_ID index.
  const master = await opts.sheets.read(RANGES.masterId);
  const masterRows = master.map((r, i) => ({
    masterRow: i + 2, bhcId: cell(r, 0), fullName: cell(r, 1), location: cell(r, 2).toUpperCase(),
    googleRow: Number.parseInt(cell(r, 3), 10) || null, attioRecordId: cell(r, 4),
  }));
  logger.info(`PASS 2 - ${masterRows.length} Master_ID row(s) indexed`);

  const candidates = {
    S1: of('S1').length, A1: of('A1').length, A3: of('A3').length, S4: of('S4').length, I1: of('I1').length,
  } as const;
  logger.info(`  candidates: ${JSON.stringify(candidates)}`);

  // S1 and S4 work off Master_ID's own grouping, scoped to the BHC_IDs /
  // pointers the Reconciler actually flagged - never the whole sheet.
  const s1Ids = new Set(of('S1').map((r) => cell(r, COL.bhcId)));
  const s1Rows: S1Row[] = masterRows.filter((r) => s1Ids.has(r.bhcId));
  logger.info(`PASS 3 - S1: ${s1Ids.size} flagged BHC_ID(s), ${s1Rows.length} matching Master_ID row(s)`);
  const s1 = await repairS1(s1Rows, { sheets: ports.sheets, logger, fixRunId });

  // A1 AND S4 MUST NOT BOTH ACT ON THE SAME POINTER.
  //
  // Hoisted above A1 deliberately. Both candidate lists are built from the same
  // frozen Reconciler_Report snapshot before either pass runs, so this is NOT
  // fixable by reordering the passes: whichever ran second would still hold its
  // own candidate for the row and could re-corrupt what the first had just
  // resolved, merely in the opposite direction.
  //
  // A row whose Attio pointer is contested is not an independent A1 defect. Its
  // "Master_ID claims X, Attio says Y" disagreement IS the ownership question,
  // and adjudicating that is S4's job exclusively - S4 asks Attio who actually
  // owns the record, which A1 cannot do. Confirmed live: A1 ran first, wrote the
  // wrong claimant's BHC_ID onto the shared record, and S4's own correct
  // ownership check then read back the value A1 had just corrupted and cleared
  // the TRUE owner's pointer.
  //
  // The name gate is no defence here. Rows share a pointer precisely because
  // they are usually the same human, so their names match and the gate passes.
  //
  // Skipping is correct rather than deferring: once S4 resolves the group, Attio
  // and Master_ID agree, and a future Reconciler pass will not raise an A1
  // finding for that row at all.
  const s4Pointers = new Set(of('S4').map((r) => cell(r, COL.attioRecordId)).filter((v) => v !== ''));

  const excludedFromA1: string[] = [];
  const a1: A1Candidate[] = of('A1').filter((r) => {
    const pointer = cell(r, COL.attioRecordId);
    if (pointer !== '' && s4Pointers.has(pointer)) {
      const bhcId = cell(r, COL.bhcId);
      excludedFromA1.push(bhcId);
      logger.info(`  ${bhcId} excluded from A1: pointer ${pointer} is contested by an S4 group this run - ownership is S4's to resolve`);
      return false;
    }
    return true;
  }).map((r) => ({
    masterRow: Number.parseInt(cell(r, COL.masterRow), 10) || 0,
    bhcId: cell(r, COL.bhcId), fullName: cell(r, COL.fullName),
    attioRecordId: cell(r, COL.attioRecordId), expectedBhcId: cell(r, COL.expected) || cell(r, COL.bhcId),
  }));
  logger.info(`PASS 4 - A1: ${a1.length} candidate(s)${excludedFromA1.length > 0 ? ` (${excludedFromA1.length} excluded as S4-contested)` : ''}`);
  const a1Result = await repairA1(a1, { sheets: ports.sheets, attio: ports.attio, logger, fixRunId });

  const a3: A3Candidate[] = of('A3').map((r) => ({
    masterRow: Number.parseInt(cell(r, COL.masterRow), 10) || 0,
    bhcId: cell(r, COL.bhcId), fullName: cell(r, COL.fullName),
    location: cell(r, COL.location).toUpperCase(), attioRecordId: cell(r, COL.attioRecordId),
  }));
  logger.info(`PASS 5 - A3: ${a3.length} candidate(s)`);
  const a3Result = await repairA3(a3, { sheets: ports.sheets, attio: ports.attio, logger, fixRunId });

  const s4Rows: S4Row[] = masterRows.filter((r) => s4Pointers.has(r.attioRecordId));
  logger.info(`PASS 6 - S4: ${s4Pointers.size} flagged pointer(s), ${s4Rows.length} matching Master_ID row(s)`);
  const s4 = await repairS4(s4Rows, { sheets: ports.sheets, attio: ports.attio, logger, fixRunId });

  const i1: I1Candidate[] = of('I1').flatMap((r) => {
    const field = cell(r, COL.notes).trim();
    if (field !== 'Title' && field !== 'Company' && field !== 'Email') {
      warnings.push(`I1 row for ${cell(r, COL.bhcId)} has unrecognised Field ${JSON.stringify(field)} - skipped`);
      return [];
    }
    return [{
      masterRow: Number.parseInt(cell(r, COL.masterRow), 10) || 0,
      bhcId: cell(r, COL.bhcId), fullName: cell(r, COL.fullName),
      attioRecordId: cell(r, COL.attioRecordId), field: field as I1Field, expected: cell(r, COL.expected),
    }];
  });
  logger.info(`PASS 6.5 - I1: ${i1.length} candidate(s)`);
  const i1Result = await repairI1(i1, { sheets: ports.sheets, attio: ports.attio, logger, fixRunId });

  if (dryRun) logger.info(`DRY RUN - ${wouldWrite.length} write(s) computed, 0 issued`);

  return {
    fixRunId, dryRun, sourceRunId, startedAt, finishedAt: new Date().toISOString(),
    candidates, s1, a1: a1Result, a3: a3Result, s4, i1: i1Result,
    excludedFromA1, wouldWrite, warnings,
  };
}
