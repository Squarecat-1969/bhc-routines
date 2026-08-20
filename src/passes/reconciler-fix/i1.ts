/**
 * Reconciler Fix PASS 6.5 - I1, identity field drift onto the Attio mirror.
 *
 * Syncs Google's authoritative Title / Company / Email. NEVER a name: name drift
 * routes to Name_Conflicts for human resolution, and AttioWritableFields has no
 * `name` key, so this is enforced by the type rather than by discipline.
 *
 * THE GATE IS TWO-PART HERE, and that is the difference from PASS 4.
 * A1 requires only the name gate. I1 additionally requires
 * `bhc_contact_id == BHC_ID`, because I1 syncs fields onto a record whose
 * identity is already supposed to be confirmed. If the pointer does NOT match,
 * that is an A1-shaped defect and A1's job to repair - I1 writing anyway would
 * push Google's values onto a record that may belong to someone else.
 *
 * The pointer check is deliberately NOT folded into nameGate: that function is
 * scoped to judging two name strings, and widening it would make every caller
 * carry an identity concept it does not need.
 */

import { buildEmailList } from './email-list.js';
import { nameGate } from './name-gate.js';
import { writeMasterCell, isHardStop, type MasterWriteResult } from './master-write.js';
import { fieldEqual } from '../../lib/name-match.js';
import type { AttioIdentityWritePort, AttioWritableFields, Logger, MasterSheetPort } from './ports.js';

/** One I1 report row = one drifted field (Reconciler emits up to three per contact). */
export type I1Field = 'Title' | 'Company' | 'Email';

export interface I1Candidate {
  readonly masterRow: number;
  readonly bhcId: string;
  readonly fullName: string;
  readonly attioRecordId: string;
  readonly field: I1Field;
  /** Reconciler_Report col K - Google's authoritative value. */
  readonly expected: string;
}

export type I1Outcome =
  | 'fixed'
  | 'already_correct'
  | 'name_mismatch'
  | 'name_unavailable'
  | 'pointer_mismatch'      // name fine, bhc_contact_id wrong -> A1's job
  | 'email_unique_conflict'
  | 'record_not_found'
  | 'write_failed'
  | 'qa_failed'
  | 'lookup_failed';

export interface I1RowResult {
  readonly bhcId: string;
  readonly field: I1Field;
  readonly outcome: I1Outcome;
  readonly attioWritten: boolean;
  readonly notes: readonly MasterWriteResult[];
  readonly reason: string;
}

export interface I1Result {
  readonly rows: readonly I1RowResult[];
  readonly counts: Readonly<Record<'considered' | 'fixed' | 'needsManual' | 'attioWrites', number>>;
}

export function i1NameMismatchNote(attioName: string, masterName: string, field: I1Field, fixRunId: string): string {
  return `I1-NAME-MISMATCH: Attio shows "${attioName}", Master_ID shows "${masterName}". ${field} not synced - pointer may reference wrong person. Reconciler Fix ${fixRunId}.`;
}
export function i1PointerMismatchNote(found: string, expected: string, field: I1Field, fixRunId: string): string {
  return `I1-POINTER-MISMATCH: Attio bhc_contact_id is ${found || '(blank)'}, expected ${expected}. ${field} not synced - this is an A1 condition. Reconciler Fix ${fixRunId}.`;
}
export function i1EmailConflictNote(email: string, fixRunId: string): string {
  return `I1-EMAIL-UNIQUE-CONFLICT: ${email} already on another record. Reconciler Fix ${fixRunId}.`;
}

const SLUG: Readonly<Record<I1Field, keyof AttioWritableFields>> = {
  Title: 'job_title',
  Company: 'company_name',
  Email: 'email_addresses',
};

export async function repairI1(
  candidates: readonly I1Candidate[],
  deps: { sheets: MasterSheetPort; attio: AttioIdentityWritePort; logger: Logger; fixRunId: string },
): Promise<I1Result> {
  const rows: I1RowResult[] = [];
  // One field at a time, each isolated: a Title failure must not stop the
  // Company or Email sync for the same contact (non-negotiable 5, at field
  // granularity - a contact can carry up to three independent I1 rows).
  for (const c of candidates) {
    try {
      rows.push(await repairOne(c, deps));
    } catch (e) {
      rows.push({
        bhcId: c.bhcId, field: c.field, outcome: 'write_failed', attioWritten: false, notes: [],
        reason: `unexpected error: ${String(e).slice(0, 140)}`,
      });
    }
  }

  return {
    rows,
    counts: {
      considered: rows.length,
      fixed: rows.filter((r) => r.outcome === 'fixed').length,
      needsManual: rows.filter((r) => r.outcome !== 'fixed' && r.outcome !== 'already_correct').length,
      attioWrites: rows.filter((r) => r.attioWritten).length,
    },
  };
}

async function repairOne(
  c: I1Candidate,
  deps: { sheets: MasterSheetPort; attio: AttioIdentityWritePort; logger: Logger; fixRunId: string },
): Promise<I1RowResult> {
  const { sheets, attio, logger, fixRunId } = deps;
  const base = { bhcId: c.bhcId, field: c.field, attioWritten: false, notes: [] as MasterWriteResult[] };

  const note = async (text: string): Promise<MasterWriteResult[]> => {
    const w = await writeMasterCell(sheets, logger, { masterRow: c.masterRow, column: 'F', value: text, expectedBhcId: c.bhcId });
    if (isHardStop(w)) logger.warn(`  HARD STOP writing note for ${c.bhcId}: ${w.detail}`);
    return [w];
  };

  // Step 1 - record exists?
  let record;
  try {
    record = await attio.getByRecordId(c.attioRecordId);
  } catch (e) {
    return { ...base, outcome: 'lookup_failed', reason: `lookup failed: ${String(e).slice(0, 140)}` };
  }
  if (!record) return { ...base, outcome: 'record_not_found', reason: `Attio record ${c.attioRecordId} not found` };

  // Step 1.5 - BOTH conditions. Name first, then the identity pointer.
  const gate = nameGate(record.name, c.fullName);
  if (gate.decision === 'NEEDS_MANUAL') {
    const unavailable = gate.verdict === 'UNVERIFIABLE';
    logger.warn(`  ${c.bhcId} ${c.field}: gate ${gate.verdict}`);
    return {
      ...base,
      outcome: unavailable ? 'name_unavailable' : 'name_mismatch',
      notes: await note(i1NameMismatchNote(record.name, c.fullName, c.field, fixRunId)),
      reason: gate.reason,
    };
  }
  if (record.bhcContactId !== c.bhcId) {
    // Name looks right but the pointer is wrong - an A1 defect, not I1's to fix.
    logger.warn(`  ${c.bhcId} ${c.field}: bhc_contact_id is ${JSON.stringify(record.bhcContactId)} - A1 condition`);
    return {
      ...base,
      outcome: 'pointer_mismatch',
      notes: await note(i1PointerMismatchNote(record.bhcContactId, c.bhcId, c.field, fixRunId)),
      reason: `bhc_contact_id ${JSON.stringify(record.bhcContactId)} != ${c.bhcId}`,
    };
  }

  // Step 2 - build the one field's value.
  let values: AttioWritableFields;
  if (c.field === 'Email') {
    const conflict = await emailConflict(attio, c, logger);
    if (conflict) {
      return { ...base, outcome: 'email_unique_conflict', notes: await note(i1EmailConflictNote(c.expected, fixRunId)), reason: conflict };
    }
    const current = record.emails ?? [];
    if (fieldEqual(current[0] ?? '', c.expected)) {
      return { ...base, outcome: 'already_correct', reason: `${c.expected} is already the primary` };
    }
    values = { email_addresses: buildEmailList(current, c.expected) };
  } else {
    const currentValue = (c.field === 'Title' ? record.jobTitle : record.companyName) ?? '';
    if (fieldEqual(currentValue, c.expected)) {
      return { ...base, outcome: 'already_correct', reason: `${c.field} already matches` };
    }
    values = { [SLUG[c.field]]: c.expected } as AttioWritableFields;
  }

  try {
    await attio.updatePerson(c.attioRecordId, values);
  } catch (e) {
    const msg = String(e);
    // The spec's own fallback: a rejection on the workspace-unique constraint is
    // NEEDS_MANUAL, never a forced overwrite. The pre-check above should catch
    // this first; this is the second line of defence for a race or a conflict
    // the query could not see.
    if (c.field === 'Email' && /uniqu/i.test(msg)) {
      return { ...base, outcome: 'email_unique_conflict', notes: await note(i1EmailConflictNote(c.expected, fixRunId)), reason: `write rejected: ${msg.slice(0, 120)}` };
    }
    return { ...base, outcome: 'write_failed', reason: `Attio update failed: ${msg.slice(0, 140)}` };
  }

  // Step 3 - QA read-back, one retry.
  const qa = await verifyI1(attio, c, logger);
  if (!qa.ok) return { ...base, outcome: 'qa_failed', attioWritten: true, reason: qa.reason };

  return { ...base, outcome: 'fixed', attioWritten: true, reason: `${c.field} synced to ${JSON.stringify(c.expected)}` };
}

/**
 * The workspace-uniqueness PRE-CHECK.
 *
 * `email_addresses` is workspace-unique in Attio. buildEmailList only shapes the
 * list; it cannot know whether the address already belongs to somebody else.
 * Writing it anyway would either be rejected or, worse, merge two people's
 * contact details. Any hit on a DIFFERENT record aborts to NEEDS_MANUAL - a hit
 * on the record being updated is just the address already being there.
 */
async function emailConflict(
  attio: AttioIdentityWritePort,
  c: I1Candidate,
  logger: Logger,
): Promise<string | null> {
  let holders: readonly { recordId: string }[];
  try {
    holders = await attio.queryByEmail(c.expected);
  } catch (e) {
    // Cannot prove it is free -> do not write. Never assume clear.
    return `uniqueness pre-check failed (${String(e).slice(0, 100)}) - refusing to write an unverified email`;
  }
  const others = holders.filter((h) => h.recordId !== c.attioRecordId);
  if (others.length === 0) return null;
  logger.warn(`  ${c.bhcId}: ${c.expected} already on ${others.length} other record(s)`);
  return `${c.expected} already belongs to ${others.map((o) => o.recordId).join(', ')}`;
}

async function verifyI1(
  attio: AttioIdentityWritePort,
  c: I1Candidate,
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

    const got = c.field === 'Email' ? (after.emails?.[0] ?? '') : (c.field === 'Title' ? after.jobTitle : after.companyName) ?? '';
    const valueOk = fieldEqual(got, c.expected);
    const nameOk = nameGate(after.name, c.fullName).decision === 'PROCEED';
    if (valueOk && nameOk) return { ok: true, reason: 'verified' };

    if (attempt === 0) { logger.warn(`  ${c.bhcId} ${c.field}: QA mismatch, retrying once`); continue; }
    return {
      ok: false,
      reason: !valueOk
        ? `QA: ${c.field} reads ${JSON.stringify(got)}, expected ${JSON.stringify(c.expected)}`
        : `QA: name no longer matches after write (${JSON.stringify(after.name)})`,
    };
  }
  return { ok: false, reason: 'unreachable' };
}
