/**
 * Reconciler Fix PASS 4 - A1, Attio bhc_contact_id mismatch.
 *
 * THE FIRST ATTIO WRITE THIS ROUTINE MAKES. The gate below is the guardrail
 * whose absence corrupted ~82 records in June 2026: writing to a record whose
 * pointer has drifted to a different person makes the corruption worse, not
 * better. Non-negotiable 8 - an ID-string match alone is not sufficient.
 */

import { nameGate } from './name-gate.js';
import { writeMasterCell, isHardStop, type MasterWriteResult } from './master-write.js';
import type { AttioIdentityWritePort, Logger, MasterSheetPort } from './ports.js';

export interface A1Candidate {
  readonly masterRow: number;
  readonly bhcId: string;
  readonly fullName: string;
  readonly attioRecordId: string;
  /** Reconciler_Report col K - the BHC_ID Attio SHOULD carry. */
  readonly expectedBhcId: string;
}

export type A1Outcome =
  | 'fixed'
  | 'name_mismatch'       // zero significant words in common
  | 'name_unavailable'    // cannot verify
  | 'record_not_found'    // has become an A3
  | 'write_failed'
  | 'qa_failed'
  | 'lookup_failed';

export interface A1RowResult {
  readonly bhcId: string;
  readonly masterRow: number;
  readonly outcome: A1Outcome;
  readonly attioWritten: boolean;
  readonly notes: readonly MasterWriteResult[];
  readonly reason: string;
}

export interface A1Result {
  readonly rows: readonly A1RowResult[];
  readonly counts: Readonly<Record<'considered' | 'fixed' | 'needsManual' | 'attioWrites', number>>;
}

export function a1NameMismatchNote(attioName: string, masterName: string, expectedBhcId: string, fixRunId: string): string {
  return `A1-NAME-MISMATCH: Attio shows "${attioName}", Master_ID shows "${masterName}". Expected BHC_ID was ${expectedBhcId}. Pointer may reference wrong person - manual review required. Reconciler Fix ${fixRunId}.`;
}
export function a1NameUnavailableNote(expectedBhcId: string, fixRunId: string): string {
  return `A1-NEEDS-MANUAL: name unavailable for verification. Expected BHC_ID was ${expectedBhcId}. Reconciler Fix ${fixRunId}.`;
}

export async function repairA1(
  candidates: readonly A1Candidate[],
  deps: { sheets: MasterSheetPort; attio: AttioIdentityWritePort; logger: Logger; fixRunId: string },
): Promise<A1Result> {
  const rows: A1RowResult[] = [];
  for (const c of candidates) rows.push(await repairOne(c, deps));

  const needsManual = rows.filter((r) => r.outcome !== 'fixed').length;
  return {
    rows,
    counts: {
      considered: rows.length,
      fixed: rows.filter((r) => r.outcome === 'fixed').length,
      needsManual,
      attioWrites: rows.filter((r) => r.attioWritten).length,
    },
  };
}

async function repairOne(
  c: A1Candidate,
  deps: { sheets: MasterSheetPort; attio: AttioIdentityWritePort; logger: Logger; fixRunId: string },
): Promise<A1RowResult> {
  const { sheets, attio, logger, fixRunId } = deps;
  const base = { bhcId: c.bhcId, masterRow: c.masterRow, attioWritten: false, notes: [] as MasterWriteResult[] };

  const note = async (text: string): Promise<MasterWriteResult[]> => {
    const w = await writeMasterCell(sheets, logger, { masterRow: c.masterRow, column: 'F', value: text, expectedBhcId: c.bhcId });
    if (isHardStop(w)) logger.warn(`  HARD STOP writing note for ${c.bhcId}: ${w.detail}`);
    return [w];
  };

  // Step 1 - does the record still exist?
  let record;
  try {
    record = await attio.getByRecordId(c.attioRecordId);
  } catch (e) {
    return { ...base, outcome: 'lookup_failed', reason: `lookup failed: ${String(e).slice(0, 140)}` };
  }
  if (!record) {
    // Spec: this has become an A3. PASS 5 owns it; A1 writes nothing.
    return { ...base, outcome: 'record_not_found', reason: `Attio record ${c.attioRecordId} not found - now an A3 condition` };
  }

  // Step 1.5 - the gate. Mandatory, non-skippable, BEFORE any write.
  const gate = nameGate(record.name, c.fullName);
  if (gate.decision === 'NEEDS_MANUAL') {
    const unavailable = gate.verdict === 'UNVERIFIABLE';
    const text = unavailable
      ? a1NameUnavailableNote(c.expectedBhcId, fixRunId)
      : a1NameMismatchNote(record.name, c.fullName, c.expectedBhcId, fixRunId);
    logger.warn(`  ${c.bhcId}: gate ${gate.verdict} - ${gate.reason}`);
    return {
      ...base,
      outcome: unavailable ? 'name_unavailable' : 'name_mismatch',
      notes: await note(text),
      reason: gate.reason,
    };
  }

  // Step 2 - the write.
  try {
    await attio.updatePerson(c.attioRecordId, { bhc_contact_id: c.expectedBhcId });
  } catch (e) {
    return { ...base, outcome: 'write_failed', reason: `Attio update failed: ${String(e).slice(0, 140)}` };
  }

  // Step 3 - QA read-back: the value landed AND we wrote to the right person.
  const qa = await verifyA1(attio, c, logger);
  if (!qa.ok) {
    return { ...base, outcome: 'qa_failed', attioWritten: true, reason: qa.reason };
  }

  return { ...base, outcome: 'fixed', attioWritten: true, reason: `bhc_contact_id set to ${c.expectedBhcId}` };
}

/** Re-fetch and confirm both facts. One retry, per spec. */
async function verifyA1(
  attio: AttioIdentityWritePort,
  c: A1Candidate,
  logger: Logger,
): Promise<{ ok: boolean; reason: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let after;
    try {
      after = await attio.getByRecordId(c.attioRecordId);
    } catch (e) {
      return { ok: false, reason: `QA re-fetch failed: ${String(e).slice(0, 120)}` };
    }
    if (!after) return { ok: false, reason: 'record disappeared between write and QA read-back' };

    const idOk = after.bhcContactId === c.expectedBhcId;
    // The name is re-checked deliberately: it confirms the write landed on the
    // person we verified, not merely that some record now holds the value.
    const nameOk = nameGate(after.name, c.fullName).decision === 'PROCEED';
    if (idOk && nameOk) return { ok: true, reason: 'verified' };

    if (attempt === 0) { logger.warn(`  ${c.bhcId}: QA mismatch, retrying once`); continue; }
    return {
      ok: false,
      reason: !idOk
        ? `QA: bhc_contact_id reads ${JSON.stringify(after.bhcContactId)}, expected ${JSON.stringify(c.expectedBhcId)}`
        : `QA: name no longer matches after write (${JSON.stringify(after.name)})`,
    };
  }
  return { ok: false, reason: 'unreachable' };
}
