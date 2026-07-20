/**
 * Part D STEP 5 — QA read-back. Spec: "Primary: read back Activity_Log
 * (Contact_ID + Channel + Subject), Google BZ:CG, Contact_History (BHC_ID +
 * Activity_Log_Ref), Attio last_meeting_summary... On MISMATCH: correct
 * once, re-read. Still fails -> leave col V BLANK, flag in Slack as ⚠. On
 * PASS: sheets('update', f'Brain_Complete!V{row}', [['TRUE']])."
 *
 * "Correct once" is implemented at the FIELD level, not by re-running
 * writeRow wholesale. writeRow's own writes are appends (Activity_Log,
 * Contact_History) — calling it a second time to "correct" a mismatch would
 * append a SECOND Activity_Log row and a SECOND Contact_History row rather
 * than fix anything, doubling the very data QA exists to protect. Each of
 * the four primary checks below re-issues only its own specific write (the
 * same target cells/record write-row.ts used) when it finds a mismatch,
 * then re-reads once more before giving up on that one field.
 *
 * Personal-context checks (Google col AI date-stamp, Attio personal_notes)
 * are tracked entirely separately and never affect whether V gets set —
 * spec, explicit: "personal context writes are enrichment, not
 * load-bearing." Secondary checks likewise never block the PRIMARY's
 * V=TRUE ("Secondary QA failure flags that secondary but does NOT block
 * primary V=TRUE") — each secondary's own pass/fail is tracked
 * independently and is informational (Slack flag) only; there's no
 * per-secondary V column to set (secondaries aren't Brain_Complete rows of
 * their own, they're written from the primary's row).
 */

import type { AttioClient } from '../lib/attio.js';
import { textOf } from '../lib/attio.js';
import type { MasterIdIndex } from '../passes/pass4/load.js';
import type { SheetsClient } from '../lib/sheets.js';
import { verifyAttioRecordOwnership, verifyGoogleRowOwnership } from './identity-gate.js';
import { currentActivityLogRowFor } from './write-row.js';
import type { WriteRowInput, WriteRowResult } from './types.js';

const CONTACT_HISTORY_READ_RANGE = 'Contact_History!A2:Q';

export interface FieldCheck {
  readonly field: string;
  readonly ok: boolean;
  readonly correctedOnRetry: boolean;
  readonly detail?: string;
}

export interface PersonalContextCheck {
  readonly field: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface SecondaryQACheck {
  readonly bhcId: string;
  readonly ok: boolean;
  readonly checks: readonly FieldCheck[];
}

export interface QAResult {
  readonly bhcId: string;
  readonly brainCompleteRow: number;
  readonly vSet: boolean;
  readonly primaryChecks: readonly FieldCheck[];
  readonly personalContextChecks: readonly PersonalContextCheck[];
  readonly secondaryChecks: readonly SecondaryQACheck[];
  readonly warnings: readonly string[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Live-scan Contact_History for the row this Activity_Log_Ref landed on — same "never trust a cached row, look it up" principle as everywhere else in this project, including write-row.ts's own Activity_Log lookup. */
async function findContactHistoryRow(sheets: SheetsClient, activityLogRef: string): Promise<{ row: number; bhcId: string } | null> {
  const rows = await sheets.read(CONTACT_HISTORY_READ_RANGE);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]?.[16] ?? '') === activityLogRef) {
      return { row: i + 2, bhcId: String(rows[i]?.[1] ?? '') };
    }
  }
  return null;
}

async function checkActivityLog(
  sheets: SheetsClient,
  activityId: string,
  expected: { bhcId: string; subject: string },
): Promise<FieldCheck> {
  const field = 'Activity_Log (Contact_ID + Channel + Subject)';
  const verify = async (): Promise<boolean> => {
    const row = await currentActivityLogRowFor(sheets, activityId);
    const data = await sheets.read(`Activity_Log!C${row}:I${row}`);
    const [contactId, , , , , , subject] = (data[0] ?? []) as string[];
    return contactId === expected.bhcId && subject === expected.subject;
  };

  if (await verify()) return { field, ok: true, correctedOnRetry: false };

  const row = await currentActivityLogRowFor(sheets, activityId);
  await sheets.update(`Activity_Log!C${row}:I${row}`, [[expected.bhcId, '', '', 'Email', 'Email', '', expected.subject]]);
  if (await verify()) return { field, ok: true, correctedOnRetry: true };
  return { field, ok: false, correctedOnRetry: true, detail: 'still mismatched after one correction attempt' };
}

async function checkGoogleBzCg(
  sheets: SheetsClient,
  googleRow: number,
  expectedFields: { CA: string; CB: string; CD: string; CE: string; CG: string },
): Promise<FieldCheck> {
  const field = 'Google Contacts BZ:CG';
  const expectedValues = [expectedFields.CA, expectedFields.CB, expectedFields.CD, expectedFields.CE, expectedFields.CG];
  const verify = async (): Promise<boolean> => {
    const data = await sheets.read(`Contacts!CA${googleRow}:CG${googleRow}`);
    const [ca, cb, , cd, ce, , cg] = (data[0] ?? []) as string[];
    return ca === expectedFields.CA && cb === expectedFields.CB && cd === expectedFields.CD && ce === expectedFields.CE && cg === expectedFields.CG;
  };

  if (await verify()) return { field, ok: true, correctedOnRetry: false };

  await sheets.update(`Contacts!BZ${googleRow}:CG${googleRow}`, [
    [today(), expectedFields.CA, expectedFields.CB, '', expectedFields.CD, expectedFields.CE, '', expectedFields.CG],
  ]);
  if (await verify()) return { field, ok: true, correctedOnRetry: true };
  return { field, ok: false, correctedOnRetry: true, detail: `still mismatched after one correction attempt (expected ${JSON.stringify(expectedValues)})` };
}

async function checkContactHistory(
  sheets: SheetsClient,
  activityId: string,
  expected: { bhcId: string; contactName: string; direction: string; subject: string; runningSummary: string },
): Promise<FieldCheck> {
  const field = 'Contact_History (BHC_ID + Activity_Log_Ref)';
  const found = await findContactHistoryRow(sheets, activityId);
  if (found && found.bhcId === expected.bhcId) return { field, ok: true, correctedOnRetry: false };

  if (found) {
    await sheets.update(`Contact_History!B${found.row}:B${found.row}`, [[expected.bhcId]]);
    const recheck = await findContactHistoryRow(sheets, activityId);
    if (recheck && recheck.bhcId === expected.bhcId) return { field, ok: true, correctedOnRetry: true };
    return { field, ok: false, correctedOnRetry: true, detail: 'BHC_ID still mismatched after one correction attempt' };
  }

  const row: unknown[] = [
    '', expected.bhcId, expected.contactName, new Date().toISOString(), 'Email', 'Email',
    expected.direction, expected.subject, expected.runningSummary, '', '', '', '', '', '', 'Late_Edition', activityId,
  ];
  await sheets.append('Contact_History!A1', [row]);
  const recheck = await findContactHistoryRow(sheets, activityId);
  if (recheck && recheck.bhcId === expected.bhcId) return { field, ok: true, correctedOnRetry: true };
  return { field, ok: false, correctedOnRetry: true, detail: 'row still not found after one correction attempt' };
}

async function checkAttioSummary(attio: AttioClient, recordId: string, expectedSummary: string): Promise<FieldCheck> {
  const field = 'Attio last_meeting_summary';
  const verify = async (): Promise<boolean> => {
    const record = await attio.getPersonRecord(recordId);
    return (textOf(record.values, 'last_meeting_summary') ?? '') === expectedSummary;
  };

  if (await verify()) return { field, ok: true, correctedOnRetry: false };
  await attio.updatePersonRecord(recordId, { last_meeting_summary: expectedSummary });
  if (await verify()) return { field, ok: true, correctedOnRetry: true };
  return { field, ok: false, correctedOnRetry: true, detail: 'still mismatched after one correction attempt' };
}

async function checkPersonalContextGoogle(sheets: SheetsClient, googleRow: number): Promise<PersonalContextCheck> {
  const field = 'Google AI (personal notes date-stamp)';
  const data = await sheets.read(`Contacts!AI${googleRow}:AI${googleRow}`);
  const text = String(data[0]?.[0] ?? '');
  const ok = text.includes(`[${today()} LE]`);
  return ok ? { field, ok } : { field, ok, detail: `col AI does not contain today's [${today()} LE] stamp` };
}

async function checkPersonalContextAttio(attio: AttioClient, recordId: string, expectedFragment: string): Promise<PersonalContextCheck> {
  const field = 'Attio personal_notes';
  const record = await attio.getPersonRecord(recordId);
  const text = textOf(record.values, 'personal_notes') ?? '';
  const ok = text.includes(expectedFragment);
  return ok ? { field, ok } : { field, ok, detail: 'personal_notes does not contain the expected extract' };
}

export async function qaVerifyAndClose(
  sheets: SheetsClient,
  attio: AttioClient,
  masterId: MasterIdIndex,
  input: WriteRowInput,
  writeResult: WriteRowResult,
): Promise<QAResult> {
  const { writeTargets, bhcId, contactName, direction, subject, runningSummary, brainCompleteRow } = input;
  const { primary } = writeTargets;
  const warnings: string[] = [];
  const primaryChecks: FieldCheck[] = [];
  const personalContextChecks: PersonalContextCheck[] = [];

  if (writeResult.activityId) {
    primaryChecks.push(await checkActivityLog(sheets, writeResult.activityId, { bhcId, subject }));
  }

  // Only check what was actually eligible to be written — re-derive
  // eligibility via the SAME identity-gate functions write-row.ts used,
  // not by parsing writeResult.writes' human-readable strings, so this
  // never drifts from what write-row.ts itself decided.
  const googleEligible = Boolean(primary.google) && !verifyGoogleRowOwnership(masterId, bhcId, primary.google?.google_row ?? -1);
  const attioEligible = Boolean(primary.attio) && !verifyAttioRecordOwnership(masterId, bhcId, primary.attio?.record_id ?? '');

  if (googleEligible && primary.google) {
    primaryChecks.push(await checkGoogleBzCg(sheets, primary.google.google_row, primary.google.fields));
  }
  if (writeResult.activityId) {
    primaryChecks.push(await checkContactHistory(sheets, writeResult.activityId, { bhcId, contactName, direction, subject, runningSummary }));
  }
  if (attioEligible && primary.attio) {
    primaryChecks.push(await checkAttioSummary(attio, primary.attio.record_id, primary.attio.fields.last_meeting_summary ?? ''));
  }

  if (primary.personal_context) {
    if (googleEligible && primary.google && primary.personal_context.personal_notes_extract) {
      personalContextChecks.push(await checkPersonalContextGoogle(sheets, primary.google.google_row));
    }
    if (attioEligible && primary.attio && primary.personal_context.personal_notes_extract) {
      personalContextChecks.push(await checkPersonalContextAttio(attio, primary.attio.record_id, primary.personal_context.personal_notes_extract));
    }
  }

  const secondaryChecks: SecondaryQACheck[] = [];
  for (const sec of writeResult.secondaries) {
    const checks: FieldCheck[] = [];
    if (sec.attioRecordId) {
      const wtSecondary = writeTargets.secondary.find((s) => s.bhc_id === sec.bhcId);
      const expectedSummary = wtSecondary?.attio?.fields.last_meeting_summary ?? '';
      checks.push(await checkAttioSummary(attio, sec.attioRecordId, expectedSummary));
    }
    const ok = checks.every((c) => c.ok);
    secondaryChecks.push({ bhcId: sec.bhcId, ok, checks });
    if (!ok) warnings.push(`Secondary ${sec.bhcId} failed QA — flagged, does not block primary.`);
  }

  const allPrimaryOk = primaryChecks.every((c) => c.ok);
  for (const check of primaryChecks) {
    if (!check.ok) warnings.push(`QA mismatch: ${check.field} — ${check.detail ?? 'no detail'}`);
    else if (check.correctedOnRetry) warnings.push(`QA note: ${check.field} required one correction before passing.`);
  }
  for (const check of personalContextChecks) {
    if (!check.ok) warnings.push(`QA note (non-blocking): ${check.field} — ${check.detail ?? 'no detail'}`);
  }

  let vSet = false;
  if (allPrimaryOk) {
    await sheets.update(`Brain_Complete!V${brainCompleteRow}`, [['TRUE']]);
    vSet = true;
  } else {
    warnings.push(`Row for ${bhcId} left OPEN (col V blank) — one or more primary QA checks failed after correction.`);
  }

  return { bhcId, brainCompleteRow, vSet, primaryChecks, personalContextChecks, secondaryChecks, warnings };
}
