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
import { appendMasterNote, isHardStop, type MasterWriteResult, type NoteKey } from './master-write.js';
import { fieldEqual } from '../../lib/name-match.js';
import { emailEqual, normaliseEmail } from '../../lib/email-equal.js';
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
  | 'lookup_failed'
  | 'reorder_withheld';    // Email present but not first, and reorder writes are off: REPORT-ONLY

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
  readonly counts: Readonly<Record<'considered' | 'fixed' | 'needsManual' | 'withheld' | 'attioWrites', number>>;
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
/*
 * ⚠ EVERY NOTE'S KEY LIVES BESIDE ITS TEXT, and tests/reconciler-fix/note-keys.test.ts
 * checks each key against its own note. A key that does not match its note
 * never skips, so that note is appended again on every run — growing a cell
 * with a 50,000-character ceiling. Each `expected` is anchored on the text
 * around the value (a colon, a quote, a following word), because a bare
 * substring lets "2 Attio records found" match "12 Attio records found".
 */
export function i1NameMismatchKey(masterName: string, field: I1Field): NoteKey {
  return { marker: 'I1-NAME-MISMATCH', field: `. ${field} not synced`, expected: `Master_ID shows "${masterName}".` };
}
export function i1PointerMismatchKey(expectedBhcId: string, field: I1Field): NoteKey {
  return { marker: 'I1-POINTER-MISMATCH', field: `. ${field} not synced`, expected: `expected ${expectedBhcId}.` };
}
export function i1EmailConflictKey(email: string): NoteKey {
  return { marker: 'I1-EMAIL-UNIQUE-CONFLICT', expected: `I1-EMAIL-UNIQUE-CONFLICT: ${email} already on another record.` };
}

const SLUG: Readonly<Record<Exclude<I1Field, 'Email'>, keyof AttioWritableFields>> = {
  Title: 'job_title',
  Company: 'company_name',
};

/**
 * ⚠ REORDER WRITES ARE OFF. Changing this is a deliberate, reviewed act.
 *
 * On 2026-09-13 Reconciler's Email check tightened from "Google's primary
 * appears anywhere in Attio's list" to "is Attio's FIRST address". That newly
 * surfaces records where the address is present but not first — the first
 * being Suzie Schofield (BHC-00103). Fix runs LIVE and unattended after every
 * successful Reconciler run, so without this switch the first run after the
 * change would rewrite a real person's address list with nobody having seen
 * the finding.
 *
 * So a present-but-not-first address is REPORTED as `reorder_withheld` and
 * NOT written. An address that is ABSENT from the record is still written, as
 * it always was — that case is not new. Turn this on only after a live run's
 * findings have been looked at.
 *
 * A switch in code rather than a "first run only" counter: a counter is state
 * that can be lost, and it would start rewriting on run two whether or not
 * anyone had looked.
 */
export const I1_EMAIL_REORDER_WRITES = false;

interface I1Deps {
  sheets: MasterSheetPort;
  attio: AttioIdentityWritePort;
  logger: Logger;
  fixRunId: string;
  /** Test seam only. Production never passes it, so I1_EMAIL_REORDER_WRITES governs. */
  emailReorderWrites?: boolean;
}

export async function repairI1(
  candidates: readonly I1Candidate[],
  deps: I1Deps,
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
      needsManual: rows.filter((r) => r.outcome !== 'fixed' && r.outcome !== 'already_correct' && r.outcome !== 'reorder_withheld').length,
      withheld: rows.filter((r) => r.outcome === 'reorder_withheld').length,
      attioWrites: rows.filter((r) => r.attioWritten).length,
    },
  };
}

async function repairOne(
  c: I1Candidate,
  deps: I1Deps,
): Promise<I1RowResult> {
  const { sheets, attio, logger, fixRunId } = deps;
  const base = { bhcId: c.bhcId, field: c.field, attioWritten: false, notes: [] as MasterWriteResult[] };

  // Notes are APPENDED to col F, and a condition already recorded is not repeated.
  const note = async (text: string, key: NoteKey): Promise<MasterWriteResult[]> => {
    const w = await appendMasterNote(sheets, logger, { masterRow: c.masterRow, note: text, key, expectedBhcId: c.bhcId });
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
      notes: await note(i1NameMismatchNote(record.name, c.fullName, c.field, fixRunId), i1NameMismatchKey(c.fullName, c.field)),
      reason: gate.reason,
    };
  }
  if (record.bhcContactId !== c.bhcId) {
    // Name looks right but the pointer is wrong - an A1 defect, not I1's to fix.
    logger.warn(`  ${c.bhcId} ${c.field}: bhc_contact_id is ${JSON.stringify(record.bhcContactId)} - A1 condition`);
    return {
      ...base,
      outcome: 'pointer_mismatch',
      notes: await note(i1PointerMismatchNote(record.bhcContactId, c.bhcId, c.field, fixRunId), i1PointerMismatchKey(c.bhcId, c.field)),
      reason: `bhc_contact_id ${JSON.stringify(record.bhcContactId)} != ${c.bhcId}`,
    };
  }

  // Step 2 - Email has its own path: different verb, different verification.
  if (c.field === 'Email') return syncEmail(c, base, deps, note);

  const currentValue = (c.field === 'Title' ? record.jobTitle : record.companyName) ?? '';
  if (fieldEqual(currentValue, c.expected)) {
    return { ...base, outcome: 'already_correct', reason: `${c.field} already matches` };
  }
  const values = { [SLUG[c.field]]: c.expected } as AttioWritableFields;

  try {
    await attio.updatePerson(c.attioRecordId, values);
  } catch (e) {
    return { ...base, outcome: 'write_failed', reason: `Attio update failed: ${String(e).slice(0, 140)}` };
  }

  // Step 3 - QA read-back, one retry.
  const qa = await verifyI1(attio, c, logger, null);
  if (!qa.ok) return { ...base, outcome: 'qa_failed', attioWritten: true, reason: qa.reason };

  return { ...base, outcome: 'fixed', attioWritten: true, reason: `${c.field} synced to ${JSON.stringify(c.expected)}` };
}

/**
 * The Email repair: fresh read, PUT the whole list, verify the whole list.
 *
 * "Correct" means Google's primary is Attio's FIRST address — the decision
 * recorded in routines/BHC_Reconciler.md, which Reconciler's detector now
 * applies too, so the two sides of the chain agree.
 */
async function syncEmail(
  c: I1Candidate,
  base: { bhcId: string; field: I1Field; attioWritten: boolean; notes: MasterWriteResult[] },
  deps: I1Deps,
  note: (text: string, key: NoteKey) => Promise<MasterWriteResult[]>,
): Promise<I1RowResult> {
  const { attio, logger, fixRunId } = deps;
  const reorderWrites = deps.emailReorderWrites ?? I1_EMAIL_REORDER_WRITES;

  const conflict = await emailConflict(attio, c, logger);
  if (conflict) {
    return { ...base, outcome: 'email_unique_conflict', notes: await note(i1EmailConflictNote(c.expected, fixRunId), i1EmailConflictKey(c.expected)), reason: conflict };
  }

  // ⚠ THE READ THE LIST IS BUILT FROM IS TAKEN HERE — immediately before the
  // write, after the uniqueness query, and NEVER the gate's read from earlier
  // in this function. A PUT replaces the whole list, so a list built from an
  // older read silently deletes any address added since it was taken.
  let fresh;
  try {
    fresh = await attio.getByRecordId(c.attioRecordId);
  } catch (e) {
    return { ...base, outcome: 'lookup_failed', reason: `read immediately before the email write failed: ${String(e).slice(0, 120)}` };
  }
  if (!fresh) return { ...base, outcome: 'record_not_found', reason: `Attio record ${c.attioRecordId} disappeared before the email write` };
  // The identity pointer is re-confirmed on the SAME read the list comes from.
  if (fresh.bhcContactId !== c.bhcId) {
    return {
      ...base, outcome: 'pointer_mismatch',
      notes: await note(i1PointerMismatchNote(fresh.bhcContactId, c.bhcId, c.field, fixRunId), i1PointerMismatchKey(c.bhcId, c.field)),
      reason: `bhc_contact_id changed to ${JSON.stringify(fresh.bhcContactId)} before the email write`,
    };
  }

  const current = fresh.emails ?? [];
  if (emailEqual(current[0], c.expected)) {
    return { ...base, outcome: 'already_correct', reason: `${c.expected} is already the first address` };
  }
  const at = current.findIndex((e) => emailEqual(e, c.expected));
  if (at > 0 && !reorderWrites) {
    return {
      ...base, outcome: 'reorder_withheld',
      reason: `${c.expected} is on the record at position ${at + 1} of ${current.length}, not first — REPORT-ONLY (I1_EMAIL_REORDER_WRITES is off)`,
    };
  }

  const list = buildEmailList(current, c.expected);

  // ⚠ THE PUT WINDOW — A LOSS NO CHECK HERE CAN SEE.
  // A PUT removes every address it does not list. The fresh read above shrinks
  // the gap between reading the list and replacing it to milliseconds — but if
  // Attio's email sync adds an address INSIDE that gap, this PUT deletes it,
  // and the read-back below matches exactly what was sent. The verification
  // passes and the loss is unseen. Attio's PUT carries no if-unchanged
  // condition, so nothing in this code fully prevents it; the fresh read only
  // makes it unlikely.
  try {
    await attio.replaceEmails(c.attioRecordId, list);
  } catch (e) {
    const msg = String(e);
    // Attio's real rejection is HTTP 400 `uniqueness_conflict` (measured
    // 2026-09-13). The pre-check should catch it first; this is the second line
    // of defence for a race or a holder the query could not see.
    if (/uniqu/i.test(msg)) {
      return { ...base, outcome: 'email_unique_conflict', notes: await note(i1EmailConflictNote(c.expected, fixRunId), i1EmailConflictKey(c.expected)), reason: `write rejected: ${msg.slice(0, 120)}` };
    }
    return { ...base, outcome: 'write_failed', reason: `Attio email replace failed: ${msg.slice(0, 140)}` };
  }

  const qa = await verifyI1(attio, c, logger, list);
  if (!qa.ok) return { ...base, outcome: 'qa_failed', attioWritten: true, reason: qa.reason };

  return { ...base, outcome: 'fixed', attioWritten: true, reason: `Email list replaced, ${c.expected} first (${list.length} address(es))` };
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
  /** Email only: the exact list written. Null for Title / Company. */
  writtenEmails: readonly string[] | null,
): Promise<{ ok: boolean; reason: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let after;
    try {
      after = await attio.getByRecordId(c.attioRecordId);
    } catch (e) {
      return { ok: false, reason: `QA re-fetch failed: ${String(e).slice(0, 120)}` };
    }
    if (!after) return { ok: false, reason: 'record disappeared between write and QA read-back' };

    let got: string;
    let want: string;
    let valueOk: boolean;
    if (c.field === 'Email') {
      // ⚠ THE WHOLE LIST, IN ORDER — never just position 0. A read-back that
      // only checks the first address passes over a lost secondary, and passed
      // over a PATCH that changed nothing when the address was already there.
      const stored = (after.emails ?? []).map(normaliseEmail);
      const expectedList = (writtenEmails ?? [c.expected]).map(normaliseEmail);
      got = stored.join(', ');
      want = expectedList.join(', ');
      valueOk = stored.length === expectedList.length && stored.every((e, i) => e === expectedList[i]);
    } else {
      got = (c.field === 'Title' ? after.jobTitle : after.companyName) ?? '';
      want = c.expected;
      valueOk = fieldEqual(got, c.expected);
    }
    const nameOk = nameGate(after.name, c.fullName).decision === 'PROCEED';
    if (valueOk && nameOk) return { ok: true, reason: 'verified' };

    if (attempt === 0) { logger.warn(`  ${c.bhcId} ${c.field}: QA mismatch, retrying once`); continue; }
    return {
      ok: false,
      reason: !valueOk
        ? `QA: ${c.field} reads ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`
        : `QA: name no longer matches after write (${JSON.stringify(after.name)})`,
    };
  }
  return { ok: false, reason: 'unreachable' };
}
