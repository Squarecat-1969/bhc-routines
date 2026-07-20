/**
 * Part D STEP 4a-4f, deterministic rebuild (2026-07-20). Executes the write
 * sequence for exactly ONE row — called in a loop for RESOLVE (every row in
 * the run set), and singly for MIXED's ACCEPT action on one item. This is
 * the ONE function both paths call; there is deliberately no second copy of
 * "how to write a row" anywhere else in this pass.
 *
 * Verification status of each column mapping below, stated plainly rather
 * than implied — some of this is cross-checked against other live-verified
 * code in this repo, some is spec-prose-only and has NOT been checked
 * against a real row:
 *   - Activity_Log (4a): CROSS-VERIFIED. Column positions match
 *     ACTIVITY_LOG_COLS (config/constants.ts), itself confirmed by PASS 0's
 *     live-verified reads. F/G's "Email · Email" pairing reads unusually in
 *     the spec's own prose — implemented literally as written, worth a
 *     sanity check against one real row before trusting it blindly.
 *   - Google Contacts BZ:CG (4b): CROSS-VERIFIED. WriteTargetsGoogleBlock's
 *     own comment (pass2/write-targets.ts) says these letters were
 *     cross-checked against bhc-aida's commit/route.ts WRITABLE map.
 *   - Personal context, AI/AU (4b.5): spec-prose only, not independently
 *     cross-checked elsewhere in this repo. Best-effort by design (spec: a
 *     failure here does not block the main write), so a wrong column here
 *     is recoverable, unlike a wrong BZ:CG or Activity_Log write.
 *   - Contact_History (4c): UNVERIFIED. Zero references to Contact_History
 *     anywhere else in this codebase to cross-check against — this is the
 *     one piece implemented purely from the spec's prose with nothing to
 *     confirm it against. Recommend a real dry-run shape check
 *     (--dump-shapes style, matching how PASS 4's Attio field slugs got
 *     verified before going live) before this runs against production data.
 *   - Attio last_meeting_summary + task creation (4d): task creation is
 *     UNVERIFIED (see AttioClient.createTask's own doc comment — no genuine
 *     create call exists anywhere in either repo yet). last_meeting_summary
 *     update reuses updatePersonRecord, already live-verified by PASS 4.
 *   - Tasks_Open (4e): CROSS-VERIFIED, and a real discrepancy was FOUND and
 *     fixed here, not assumed away: the spec calls this tab "Tasks_Log" and
 *     describes a 15-field append (...Company · Title at the end). The real,
 *     live-verified tab is Tasks_Open, 13 columns A-M (pass2_5/tasks.ts's
 *     own comment: "verified live 2026-07-19: real tab is Tasks_Open, not
 *     Tasks_Log, a stale name from an old memory summary"), with no
 *     Company/Title columns at all. This module writes to the real,
 *     verified 13-column shape, not the spec's stale 15-field description.
 *
 * Identity-verification gate (added here, not in the spec — see the
 * project's own §6 hard contract and the June 12 corruption incident it
 * exists because of): before writing anything, re-confirm live that the
 * google_row / attio record_id this row's WriteTargets claims still belong
 * to the claimed bhcId in Master_ID right now, not just last night when
 * PASS 2 staged this row. Master_ID can shift between staging and
 * execution (a manual edit, a reconciler run) — trusting a cached row
 * number across that gap is exactly the failure class Master_ID's own
 * "never infer, always look up live" rule exists to prevent. Skips (and
 * flags, never writes) rather than silently writing to a row that no
 * longer belongs to this contact.
 */

import { ATTIO_BOBBY_MEMBER_ID } from '../config/constants.js';
import type { AttioClient } from '../lib/attio.js';
import { textOf } from '../lib/attio.js';
import type { MasterIdIndex } from '../passes/pass4/load.js';
import type { SheetsClient } from '../lib/sheets.js';
import { iso, isBefore, parseFlexibleDate, type CivilDate } from '../lib/dates.js';
import { verifyAttioRecordOwnership, verifyGoogleRowOwnership } from './identity-gate.js';
import type { SecondaryWriteResult, StagedTask, WriteRowInput, WriteRowResult } from './types.js';

const OUTCOME_DEFAULT = 'Neutral';
const ACTIVITY_LOG_APPEND_RANGE = 'Activity_Log!A1'; // append target — actual landing row determined by the API, same convention as PASS 0's own Activity_Log appends
const CONTACT_HISTORY_APPEND_RANGE = 'Contact_History!A1';
const TASKS_OPEN_APPEND_RANGE = 'Tasks_Open!A1';

function makeActivityId(now: Date = new Date()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `ACT-${now.getTime()}-${rand}`;
}

function makeTaskId(now: Date = new Date()): string {
  return `TASK-${now.getTime()}`;
}

/**
 * The identity-verification gate. Returns null (safe to proceed) or a
 * warning string explaining why a given write target was withheld.
 * Deliberately narrow: only checks that the claimed row/record still
 * belongs to this bhcId RIGHT NOW — it does not re-derive or second-guess
 * anything else WriteTargets claims. "Verify, don't re-derive."
 */
export async function writeRow(
  sheets: SheetsClient,
  attio: AttioClient,
  masterId: MasterIdIndex,
  input: WriteRowInput,
): Promise<WriteRowResult> {
  const writes: string[] = [];
  const warnings: string[] = [];
  const taskIds: string[] = [];
  const now = new Date();
  const nowIso = now.toISOString();
  const dateOnly = nowIso.slice(0, 10);

  const { bhcId, contactName, direction, subject, runningSummary, writeTargets, tasks } = input;
  const { primary } = writeTargets;

  // Identity gate — check both write targets up front, before anything is
  // written, so a withheld Google write doesn't leave Activity_Log pointing
  // at a stale row while Attio still gets updated (or vice versa).
  let googleOk = false;
  let attioOk = false;
  if (primary.google) {
    const problem = verifyGoogleRowOwnership(masterId, bhcId, primary.google.google_row);
    if (problem) warnings.push(problem);
    else googleOk = true;
  }
  if (primary.attio) {
    const problem = verifyAttioRecordOwnership(masterId, bhcId, primary.attio.record_id);
    if (problem) warnings.push(problem);
    else attioOk = true;
  }

  // Fetch the Attio person record ONCE, up front, and reuse it for LinkedIn
  // extraction below AND both personal-context reads in 4b.5 — not three
  // separate GETs against the same record. Each GET independently retries
  // on failure (withRetry, 3 attempts with backoff), so three sequential
  // calls against a genuinely failing record meant up to 9 retried requests
  // for what's fundamentally one piece of data. If this fetch fails, both
  // LinkedIn and the Attio-side personal-context write degrade gracefully
  // (blank LinkedIn, personal-context skipped with a warning) rather than
  // each independently re-attempting and re-failing against the same record.
  let attioRecord: Awaited<ReturnType<AttioClient['getPersonRecord']>> | null = null;
  if (attioOk && primary.attio) {
    try {
      attioRecord = await attio.getPersonRecord(primary.attio.record_id);
    } catch (e) {
      warnings.push(`Could not fetch Attio record ${primary.attio.record_id} (LinkedIn + personal context both degrade for this row): ${String(e)}`);
    }
  }

  // Best-effort LinkedIn URL for Activity_Log col D (PERSON_SLUGS.linkedin,
  // the same slug already live-verified in PASS 4.5). Never blocks the row
  // on a lookup failure — LinkedIn_URL is a nice-to-have on this row, not
  // load-bearing.
  const linkedinUrl = attioRecord ? (textOf(attioRecord.values, 'linkedin') ?? '') : '';

  // ── 4a. Activity_Log (append) — FIRST, always ────────────────────────────
  const activityId = makeActivityId(now);
  const outcome = (googleOk && primary.google?.fields.CG) || OUTCOME_DEFAULT;
  // "from Tasks_JSON earliest due" — the earliest by actual parsed calendar
  // date, not array order or raw string comparison (a numeric-Excel-serial
  // due_date would otherwise sort wrong purely lexicographically — the same
  // bug already found and fixed once in this repo, in PASS 5's plan
  // building and PASS 2.5's task clustering; worth applying the same fix
  // here rather than reintroducing it a third time).
  const withParsedDue = tasks
    .map((t) => ({ task: t, parsed: parseFlexibleDate(t.due_date) }))
    .filter((x): x is { task: StagedTask; parsed: CivilDate } => x.parsed !== null)
    .sort((a, b) => (isBefore(a.parsed, b.parsed) ? -1 : isBefore(b.parsed, a.parsed) ? 1 : 0));
  const earliestTask = withParsedDue[0]?.task;
  const nextActionDate = earliestTask ? iso(withParsedDue[0]!.parsed) : '';
  const nextActionNote = earliestTask?.description ?? '';

  const activityLogRow: unknown[] = [
    activityId, // A
    nowIso, // B Timestamp
    bhcId, // C Contact_ID
    linkedinUrl, // D LinkedIn_URL
    contactName, // E Contact_Name
    'Email', // F — spec literal, see module doc comment
    'Email', // G — spec literal, see module doc comment
    direction, // H
    subject, // I
    runningSummary, // J Body
    '', '', '', // K-M blank
    outcome, // N
    nextActionDate, // O
    nextActionNote, // P
    'late_edition', // Q source
    'Part D Resolve Handler', // R created_by
    googleOk && attioOk ? 'BOTH' : googleOk ? 'GOOGLE' : attioOk ? 'ATTIO' : '', // S Source_CRM — reflects what was actually written, not merely claimed (a withheld write via the identity gate shouldn't be recorded as if it landed)
    '', // T — filled after 4d if exactly one task
    '', // U
  ];
  await sheets.append(ACTIVITY_LOG_APPEND_RANGE, [activityLogRow]);
  writes.push(`Activity_Log ${activityId} appended`);

  // ── 4b. Google Contacts BZ:CG (update) ───────────────────────────────────
  if (googleOk && primary.google) {
    const { google_row, fields } = primary.google;
    await sheets.update(`Contacts!BZ${google_row}:CG${google_row}`, [
      [dateOnly, fields.CA, fields.CB, '', fields.CD, fields.CE, '', fields.CG],
    ]);
    writes.push(`Contacts BZ:CG @ row ${google_row}`);
  }

  // ── 4b.5. Personal context (conditional, best-effort, non-blocking) ──────
  if (googleOk && primary.google && primary.personal_context) {
    const { personal_notes_extract, topics_of_interest_extract } = primary.personal_context;
    const googleRow = primary.google.google_row;
    try {
      if (personal_notes_extract) {
        const existing = await sheets.read(`Contacts!AI${googleRow}:AI${googleRow}`);
        const existingText = String(existing[0]?.[0] ?? '');
        const entry = `[${dateOnly} LE] ${personal_notes_extract}`;
        const combined = existingText ? `${existingText}\n${entry}` : entry;
        await sheets.update(`Contacts!AI${googleRow}:AI${googleRow}`, [[combined]]);
        writes.push(`Contacts AI @ row ${googleRow} (personal notes)`);
      }
      if (topics_of_interest_extract) {
        const existing = await sheets.read(`Contacts!AU${googleRow}:AU${googleRow}`);
        const existingText = String(existing[0]?.[0] ?? '');
        if (!existingText.includes(topics_of_interest_extract)) {
          const combined = existingText ? `${existingText}\n${topics_of_interest_extract}` : topics_of_interest_extract;
          await sheets.update(`Contacts!AU${googleRow}:AU${googleRow}`, [[combined]]);
          writes.push(`Contacts AU @ row ${googleRow} (topics of interest)`);
        }
      }
    } catch (e) {
      // Non-negotiable per spec: personal context failures never block the main thread.
      warnings.push(`Personal context write failed (non-blocking): ${String(e)}`);
    }
  }
  if (attioRecord && primary.attio && primary.personal_context) {
    const { personal_notes_extract, topics_of_interest_extract } = primary.personal_context;
    const recordId = primary.attio.record_id;
    try {
      if (personal_notes_extract) {
        const existingText = textOf(attioRecord.values, 'personal_notes') ?? '';
        const entry = `[${dateOnly} LE] ${personal_notes_extract}`;
        const combined = existingText ? `${existingText}\n${entry}` : entry;
        await attio.updatePersonRecord(recordId, { personal_notes: combined });
        writes.push(`Attio personal_notes @ ${recordId}`);
      }
      if (topics_of_interest_extract) {
        const existingText = textOf(attioRecord.values, 'topics_of_interest') ?? '';
        if (!existingText.includes(topics_of_interest_extract)) {
          const combined = existingText ? `${existingText}\n${topics_of_interest_extract}` : topics_of_interest_extract;
          await attio.updatePersonRecord(recordId, { topics_of_interest: combined });
          writes.push(`Attio topics_of_interest @ ${recordId}`);
        }
      }
    } catch (e) {
      warnings.push(`Attio personal context write failed (non-blocking): ${String(e)}`);
    }
  }

  // ── 4c. Contact_History (append) — UNVERIFIED shape, see module doc ─────
  const contactHistoryRow: unknown[] = [
    '', // Run_ID — filled by caller if needed; not part of WriteRowInput today
    bhcId,
    contactName,
    nowIso, // Entry_Date, ISO-Z
    'Email',
    'Email',
    direction,
    subject,
    runningSummary, // Summary
    '', // Key_Commitments — not currently threaded into WriteRowInput; TODO if needed
    '', // Personal_Details_Flag
    '', // Company_Intel
    '', // blank
    '', // blank
    '', // Email_Thread_ID
    'Late_Edition',
    activityId,
  ];
  try {
    await sheets.append(CONTACT_HISTORY_APPEND_RANGE, [contactHistoryRow]);
    writes.push(`Contact_History appended for ${activityId}`);
  } catch (e) {
    warnings.push(`Contact_History append failed: ${String(e)} — UNVERIFIED shape, see write-row.ts doc comment`);
  }

  // ── 4d. Attio (connector) ────────────────────────────────────────────────
  if (attioOk && primary.attio) {
    try {
      await attio.updatePersonRecord(primary.attio.record_id, primary.attio.fields);
      writes.push(`Attio fields updated @ ${primary.attio.record_id}`);
    } catch (e) {
      warnings.push(`Attio field update failed: ${String(e)}`);
    }

    for (const task of tasks) {
      try {
        const { taskId } = await attio.createTask({
          content: task.description,
          deadlineAt: task.due_date || null,
          linkedRecordId: primary.attio.record_id,
          assigneeId: ATTIO_BOBBY_MEMBER_ID,
        });
        taskIds.push(taskId);
        writes.push(`Attio task ${taskId} created`);
      } catch (e) {
        warnings.push(`Attio task creation failed for "${task.description}": ${String(e)} — UNVERIFIED shape, see AttioClient.createTask's doc comment`);
      }
    }

    if (taskIds.length === 1) {
      await sheets.update(`Activity_Log!T${await currentActivityLogRowFor(sheets, activityId)}`, [[taskIds[0]!]]);
      writes.push(`Activity_Log col T @ ${activityId} = ${taskIds[0]}`);
    }
  }

  // ── 4e. Tasks_Open (append, one row per task) — real 13-col A-M shape ───
  for (const task of tasks) {
    const taskId = makeTaskId(now);
    const taskRow: unknown[] = [
      taskId, // A
      nowIso, // B Created_At
      bhcId, // C Contact_ID
      linkedinUrl, // D LinkedIn_URL
      contactName, // E Contact_Name
      'Follow-up', // F Task_Type
      task.description, // G
      task.due_date, // H
      'Open', // I Status
      task.priority || 'Medium', // J
      'Bobby', // K Owner
      '', // L Closed_At
      activityId, // M Related_Activity_ID
    ];
    await sheets.append(TASKS_OPEN_APPEND_RANGE, [taskRow]);
    writes.push(`Tasks_Open ${taskId} appended`);
  }

  // ── 4f. Secondary contacts (lighter loop) ────────────────────────────────
  // No Tasks_Log, no personal_context for secondaries (spec, explicit).
  // Each secondary's failure is caught independently — one bad secondary
  // never blocks another secondary or the primary's already-determined
  // V=TRUE eligibility ("Secondary QA failure flags that secondary but does
  // NOT block primary V=TRUE").
  //
  // No google branch here despite the spec's own STEP 4f prose ("Google
  // BZ:CG: only if secondary has google object with google_row") —
  // WriteTargetsSecondary (pass2/write-targets.ts) has no google field at
  // all; buildSecondary never produces one. Confirmed against the real
  // type, not assumed away — TypeScript itself would refuse to compile a
  // reference to a field that doesn't exist on the type.
  //
  // Role-note text for Activity_Log's Body: the only place a secondary's
  // role note survives into Write_Targets_JSON is inside
  // attio.fields.last_meeting_summary, when an attio target exists at all
  // (SecondaryTargetInput.roleNote feeds ONLY that field in buildSecondary,
  // nothing separate). A secondary with no attio target has no role-note
  // source data left to reconstruct — falls back to a generic line.
  const secondaries: SecondaryWriteResult[] = [];
  for (const secondary of writeTargets.secondary) {
    const secWarnings: string[] = [];
    let secAttioOk = false;
    if (secondary.attio) {
      const problem = verifyAttioRecordOwnership(masterId, secondary.bhc_id, secondary.attio.record_id);
      if (problem) secWarnings.push(problem);
      else secAttioOk = true;
    }

    const roleNote = secondary.attio?.fields.last_meeting_summary || 'Secondary contact on this thread.';
    const secActivityId = makeActivityId(now);

    let secOk = true;
    try {
      const secActivityRow: unknown[] = [
        secActivityId, // A
        nowIso, // B
        secondary.bhc_id, // C
        '', // D LinkedIn_URL — not looked up for secondaries, lighter loop
        '', // E Contact_Name — not carried in WriteTargetsSecondary; blank rather than guessed
        'Email', // F
        'Email', // G
        direction, // H
        `[cc] ${subject}`, // I Subject
        roleNote, // J Body
        '', '', '', // K-M
        'Neutral', // N Outcome — secondaries have no outcome field to draw from
        '', '', // O, P — no next-action for secondaries
        'late_edition', // Q
        'Part D Resolve Handler', // R
        secAttioOk ? 'ATTIO' : '', // S Source_CRM
        '', // T
        '', // U
      ];
      await sheets.append(ACTIVITY_LOG_APPEND_RANGE, [secActivityRow]);
      writes.push(`Activity_Log ${secActivityId} appended (secondary ${secondary.bhc_id})`);
    } catch (e) {
      secOk = false;
      secWarnings.push(`Secondary Activity_Log append failed: ${String(e)}`);
    }

    if (secAttioOk && secondary.attio) {
      try {
        await attio.updatePersonRecord(secondary.attio.record_id, { last_meeting_summary: roleNote });
        writes.push(`Attio last_meeting_summary updated @ ${secondary.attio.record_id} (secondary)`);
      } catch (e) {
        secOk = false;
        secWarnings.push(`Secondary Attio update failed: ${String(e)}`);
      }
    }

    try {
      const secContactHistoryRow: unknown[] = [
        '', // Run_ID
        secondary.bhc_id,
        '', // Contact_Name — not carried in WriteTargetsSecondary
        nowIso,
        'Email', 'Email',
        direction,
        `[cc] ${subject}`,
        roleNote,
        '', '', '', '', '', // Key_Commitments, Personal_Details_Flag, Company_Intel, blank, blank
        '', // Email_Thread_ID
        'Late_Edition',
        secActivityId, // Activity_Log_Ref = the SECONDARY's own fresh ACT- id, per spec
      ];
      await sheets.append(CONTACT_HISTORY_APPEND_RANGE, [secContactHistoryRow]);
      writes.push(`Contact_History appended for secondary ${secActivityId}`);
    } catch (e) {
      secOk = false;
      secWarnings.push(`Secondary Contact_History append failed: ${String(e)} — UNVERIFIED shape, see module doc comment`);
    }

    secondaries.push({
      bhcId: secondary.bhc_id,
      activityId: secActivityId,
      attioRecordId: secAttioOk ? (secondary.attio?.record_id ?? null) : null,
      ok: secOk,
      warnings: secWarnings,
    });
  }

  // Reaching this point means Activity_Log succeeded — and Google BZ:CG too,
  // if it was attempted — since neither is wrapped in try/catch above (a
  // failure there is meant to propagate and stop the row, matching the
  // spec's own "if Sheets proxy unreachable, stop immediately"). Everything
  // else that can fail is caught into `warnings` without stopping the row.
  // So `ok` here just means "completed without a fatal, uncaught error" —
  // callers wanting to know about partial failures should check
  // warnings.length, which is the real, itemized signal, not this boolean.
  return { ok: true, bhcId, activityId, writes, warnings, taskIds, secondaries };
}

/**
 * Find the sheet row an Activity_ID just landed on, for the col-T follow-up
 * write in 4d. Reads back rather than trusting an assumed "last row" —
 * append's landing row isn't returned by the Sheets proxy today, and
 * scanning col A for the ID we just wrote is the same live-lookup principle
 * used everywhere else in this project (never infer a row, always look it
 * up), just applied to a row we ourselves wrote a moment ago instead of one
 * someone else wrote earlier.
 */
export async function currentActivityLogRowFor(sheets: SheetsClient, activityId: string): Promise<number> {
  const rows = await sheets.read('Activity_Log!A2:A');
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]?.[0] ?? '') === activityId) return i + 2;
  }
  throw new Error(`Could not find just-written Activity_Log row for ${activityId} — col T task-ID write skipped`);
}
