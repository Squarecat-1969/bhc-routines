/**
 * IDENTITY RE-RESOLUTION — revisits Brain_Complete rows written without one.
 *
 * `resolveContact` has exactly one caller: the thread being processed that
 * night. Nothing ever writes column B again, so a row written unresolved stays
 * unresolved — even when its contact is bridged days later. Joleen Hughes
 * appears twice, five weeks apart; the earlier row never caught up.
 *
 * ⚠⚠ THIS PASS DOES NOT EXTEND PART D'S REACH, AND THAT IS DELIBERATE.
 *
 * Part D is gated twice: `AB == runId` AND `V` blank (load-run-set.ts:154-156).
 * Every one of the 347 blank-B rows has `V` blank — Part D has never closed
 * one — but a July row is unreachable by tonight's Part D because its `AB` is
 * a July Run_ID. Writing column B makes a row CAPABLE of being processed; it
 * does not cause it to be processed, and nothing here changes that.
 *
 * ⚠ NOTHING IN THIS PASS MAY WRITE `AB` OR `V`. Re-stamping `AB` would sweep
 * months of historical interactions into a live Part D run and write them onto
 * real contact records in one go. That is a far larger decision than a
 * backfill, it must not arrive as a side effect of one, and the absence of any
 * such write here is the enforcement. This pass writes column B and its own
 * state tab. Nothing else.
 */

import type { AttioClient, AttioPersonRecord } from '../../lib/attio.js';
import type { Logger } from '../../lib/logger.js';
import { sleep } from '../../lib/http.js';
import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient, type SheetRow } from '../../lib/sheets.js';
import { MASTER_ID_COLS, TRIAGE_RANGES } from '../../config/triage-constants.js';
import { loadContactsEmailMap, type ContactsEmailMap } from '../pass2/contacts-email-map.js';
import { loadMasterId, type MasterIdIndex } from '../pass4/load.js';
import { parseRawEmailsJson } from '../pass2/parse-emails.js';
import { identifyPrimaryAndSecondary } from '../pass2/participants.js';
import { checkDrift, resolveContact } from '../pass2/resolve.js';
import type { DriftCheckResult, ResolvedContact } from '../pass2/types.js';
import {
  DERIVATION_VERSION,
  MAX_RESOLVE_ATTEMPTS_PER_RUN,
  RESOLVE_CONCURRENCY,
  RESOLVE_WAVE_PAUSE_MS,
  STATE_RANGES,
  WRITE_PAUSE_EVERY,
  WRITE_PAUSE_MS,
  makeReresolutionRunId,
  type ResolutionClass,
} from './constants.js';
import {
  corpusFingerprint,
  parseStateRow,
  serializeStateRow,
  shouldAttempt,
  type RowState,
} from './state.js';

/** Brain_Complete column indices, from part-d/load-run-set.ts's own table. */
const BC = { threadId: 0, bhcId: 1, contactName: 2, direction: 4, rawEmails: 9, actionRequired: 22 } as const;

export type Verdict =
  | 'write'
  | 'withheld-drift'
  | 'withheld-superseded'
  | 'withheld-absent-from-master'
  | 'withheld-primary-not-on-thread'
  | 'no-resolution';

export interface RowOutcome {
  readonly threadId: string;
  readonly sheetRow: number;
  readonly contactName: string;
  readonly actionRequired: string;
  readonly primaryEmail: string | null;
  readonly cls: ResolutionClass;
  readonly bhcId: string | null;
  readonly source: string;
  readonly drift: DriftCheckResult | null;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly written: boolean;
}

export interface ReresolutionReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;
  readonly totalRows: number;
  readonly blankRows: number;
  readonly fingerprint: string;
  readonly derivationVersion: string;
  readonly skipped: Readonly<Record<string, number>>;
  readonly attempted: number;
  readonly byClass: Readonly<Record<string, number>>;
  readonly byVerdict: Readonly<Record<string, number>>;
  readonly outcomes: readonly RowOutcome[];
  /** CONFIRMED by reading the cell back, never the count we intended to write. */
  readonly writesConfirmed: number;
  readonly writesAttempted: number;
  readonly stateRowsWritten: number;
  /** True when the run aborted after writes could have started. Never assume zero. */
  readonly writesMayHaveLanded?: boolean;
  readonly warnings: readonly string[];
}

class AbortRun extends Error {}

export interface ReresolutionOptions {
  readonly dryRun: boolean;
  readonly sheets: SheetsClient;
  readonly attio: AttioClient;
  readonly logger: Logger;
  readonly runId?: string;
  readonly today?: string;
  readonly maxAttempts?: number;
  /** Ignore the retry gate. Recovery/diagnostic only — costs a full sweep. */
  readonly ignoreGate?: boolean;
}

export async function runReresolution(opts: ReresolutionOptions): Promise<ReresolutionReport> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? makeReresolutionRunId();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  try {
    return await runInner(opts, runId, today, startedAt);
  } catch (error) {
    /**
     * ⚠ AN ABORTED RUN DOES NOT KNOW WHETHER IT WROTE, AND MUST NOT SAY IT DID
     * NOT.
     *
     * The first live attempt died on a Sheets 429 inside the write loop and
     * this path reported `writesConfirmed: 0` — which the renderer printed as
     * "Nothing was written." That was a hardcoded constant presented as a
     * measurement, and it was false: writes had already landed. A caller
     * reading it would have re-run and double-written.
     *
     * `writesMayHaveLanded` defaults to TRUE and drops to false only where the
     * failure provably preceded any write.
     */
    return {
      runId, dryRun: opts.dryRun, startedAt, finishedAt: new Date().toISOString(),
      aborted: true, abortReason: error instanceof Error ? (error.stack ?? error.message) : String(error),
      totalRows: 0, blankRows: 0, fingerprint: '', derivationVersion: DERIVATION_VERSION,
      skipped: {}, attempted: 0, byClass: {}, byVerdict: {}, outcomes: [],
      writesConfirmed: 0, writesAttempted: 0, stateRowsWritten: 0,
      writesMayHaveLanded: !opts.dryRun,
      warnings: [
        opts.dryRun
          ? 'aborted during a dry run — nothing can have been written'
          : '⚠ ABORTED MID-RUN. Column-B writes MAY HAVE LANDED — the counters below are not a measurement of ' +
            'what the sheet holds. Re-read Brain_Complete column B before re-running.',
      ],
    };
  }
}

async function runInner(
  opts: ReresolutionOptions,
  runId: string,
  today: string,
  startedAt: string,
): Promise<ReresolutionReport> {
  const { sheets, attio, logger, dryRun } = opts;
  const warnings: string[] = [];

  logger.info('IDENTITY RE-RESOLUTION');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes Brain_Complete column B only)'}`);
  logger.info(`  derivation version: ${DERIVATION_VERSION}`);

  const rows = await sheets.read(RANGES.brainCompleteData);
  const contactsMap = await loadContactsEmailMap(sheets);
  const masterIndex = await loadMasterId(sheets);
  const masterRows = await sheets.read(TRIAGE_RANGES.masterId);

  // Master_ID by ID, INCLUDING blank-BHC_ID rows — loadMasterId skips those,
  // and they are exactly the SUPERSEDED retired identities this gate must see.
  const masterById = new Map<string, { row: number; name: string; location: string }[]>();
  masterRows.forEach((r, i) => {
    const id = cell(r, MASTER_ID_COLS.bhcId).trim();
    if (id === '') return;
    const e = { row: i + 2, name: cell(r, MASTER_ID_COLS.fullName), location: cell(r, MASTER_ID_COLS.location) };
    const a = masterById.get(id);
    if (a) a.push(e); else masterById.set(id, [e]);
  });

  const bridgedAttioCount = await countBridgedAttio(attio);
  const fingerprint = corpusFingerprint({ contactsEmailCount: contactsMap.byEmail.size, bridgedAttioCount });
  logger.info(`  corpus fingerprint: ${fingerprint}  (${contactsMap.byEmail.size} contact addresses, ${bridgedAttioCount} bridged Attio records)`);

  const stateRaw = await readState(sheets, logger, dryRun, warnings);
  const stateByThread = new Map<string, RowState>();
  for (const r of stateRaw) {
    const s = parseStateRow(r);
    if (s) stateByThread.set(s.threadId, s);
  }
  logger.info(`  prior state rows: ${stateByThread.size}`);

  const blank = rows
    .map((r, i) => ({ sheetRow: i + 2, r }))
    .filter((x) => cell(x.r, BC.threadId) !== '' && cell(x.r, BC.bhcId) === '');
  logger.info(`  ${rows.length} Brain_Complete rows, ${blank.length} with column B blank`);

  // --- the retry gate --------------------------------------------------------
  const skipped: Record<string, number> = {};
  const candidates: { sheetRow: number; r: SheetRow; threadId: string; why: string }[] = [];
  for (const { sheetRow, r } of blank) {
    const threadId = cell(r, BC.threadId);
    const decision = opts.ignoreGate
      ? ({ attempt: true, reason: 'never-attempted' } as const)
      : shouldAttempt(stateByThread.get(threadId), fingerprint);
    if (!decision.attempt) {
      skipped[decision.reason] = (skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    candidates.push({ sheetRow, r, threadId, why: decision.reason });
  }
  for (const [k, n] of Object.entries(skipped)) logger.info(`  ${String(n).padStart(4, ' ')}  skipped: ${k}`);
  logger.info(`  ${candidates.length} row(s) to attempt`);

  const cap = opts.maxAttempts ?? MAX_RESOLVE_ATTEMPTS_PER_RUN;
  const toAttempt = candidates.slice(0, cap);
  if (candidates.length > toAttempt.length) {
    warnings.push(`attempt cap of ${cap} hit — ${candidates.length - toAttempt.length} row(s) left for the next run`);
  }

  // --- resolve ---------------------------------------------------------------
  const attioCache = new Map<string, AttioPersonRecord | null>();
  const outcomes: RowOutcome[] = [];

  for (let i = 0; i < toAttempt.length; i += RESOLVE_CONCURRENCY) {
    const wave = toAttempt.slice(i, i + RESOLVE_CONCURRENCY);
    const results = await Promise.all(
      wave.map((c) => judgeRow(c, { contactsMap, masterIndex, attio, masterById, attioCache })),
    );
    outcomes.push(...results);
    if (i + RESOLVE_CONCURRENCY < toAttempt.length) await sleep(RESOLVE_WAVE_PAUSE_MS);
  }

  const byClass: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  for (const o of outcomes) {
    byClass[o.cls] = (byClass[o.cls] ?? 0) + 1;
    byVerdict[o.verdict] = (byVerdict[o.verdict] ?? 0) + 1;
  }
  logger.info('  by class:');
  for (const [k, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) logger.info(`  ${String(n).padStart(4, ' ')}  ${k}`);
  logger.info('  by verdict:');
  for (const [k, n] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) logger.info(`  ${String(n).padStart(4, ' ')}  ${k}`);

  // --- write -----------------------------------------------------------------
  const toWrite = outcomes.filter((o) => o.verdict === 'write');
  let writesConfirmed = 0;
  const written = new Set<number>();

  if (dryRun) {
    logger.info(`  DRY RUN — would write ${toWrite.length} column-B cell(s) and ${outcomes.length} state row(s)`);
  } else {
    /**
     * ⚠ THE FRESHNESS CHECK AND THE READ-BACK ARE BATCHED, NOT PER-ROW.
     *
     * The first live attempt did read → update → read PER ROW: three API calls
     * each, 102 for 34 rows, on top of the run's own reads. Google's Sheets
     * READ quota is 60/minute/user and the run died on a 429 partway through
     * the loop — leaving some writes landed and some not, which is the worst
     * shape a write loop can fail in.
     *
     * One read of the whole B column answers the freshness question for every
     * row at once, and one more afterwards confirms every write. Two reads
     * instead of 68, with identical evidence: the read-back still reads STORED
     * state and still names exactly which rows landed.
     */
    const colBefore = await sheets.read('Brain_Complete!B2:B');
    const valueAt = (rows: SheetRow[], sheetRow: number): string => cell(rows[sheetRow - 2], 0);

    const sent: RowOutcome[] = [];
    for (const o of toWrite) {
      if (valueAt(colBefore, o.sheetRow) !== '') {
        // Something else populated it since the scan; this write is not ours.
        warnings.push(`row ${o.sheetRow}: column B is no longer blank — skipped`);
        continue;
      }
      // ⚠ COLUMN B ONLY, one narrow range per row. A wide write from a partial
      // read fabricates every column it did not read (PASS 2 REVIEW, 2026-08-27).
      await sheets.update(`Brain_Complete!B${o.sheetRow}`, [[o.bhcId]]);
      sent.push(o);
      if (sent.length % WRITE_PAUSE_EVERY === 0) await sleep(WRITE_PAUSE_MS);
    }

    // ⚠ CONFIRMED BY RE-READING STORED STATE, never by the absence of a throw.
    const colAfter = await sheets.read('Brain_Complete!B2:B');
    for (const o of sent) {
      if (valueAt(colAfter, o.sheetRow) === o.bhcId) {
        writesConfirmed += 1;
        written.add(o.sheetRow);
      } else {
        warnings.push(
          `row ${o.sheetRow}: read-back returned "${valueAt(colAfter, o.sheetRow)}", expected ${o.bhcId}`,
        );
      }
    }
    logger.info(`  ${writesConfirmed} of ${sent.length} column-B write(s) CONFIRMED by read-back`);
  }

  const stateRows = outcomes.map((o) =>
    serializeStateRow({
      threadId: o.threadId,
      brainCompleteRow: o.sheetRow,
      cls: o.cls,
      fingerprint,
      today,
      notes: `${o.verdict}${o.detail ? ` — ${o.detail}` : ''}`,
    }),
  );
  let stateRowsWritten = 0;
  if (!dryRun && stateRows.length > 0) {
    stateRowsWritten = await writeState(sheets, stateRaw, stateByThread, outcomes, stateRows, warnings);
    logger.info(`  ${stateRowsWritten} state row(s) written`);
  }

  return {
    runId, dryRun, startedAt, finishedAt: new Date().toISOString(),
    aborted: false, abortReason: null,
    totalRows: rows.length, blankRows: blank.length,
    fingerprint, derivationVersion: DERIVATION_VERSION,
    skipped, attempted: outcomes.length, byClass, byVerdict,
    outcomes: outcomes.map((o) => ({ ...o, written: written.has(o.sheetRow) })),
    writesConfirmed, writesAttempted: dryRun ? 0 : toWrite.length,
    stateRowsWritten, warnings,
  };
}

/**
 * Judge one row: derive its primary email, run the EXISTING cascade unchanged,
 * then gate on drift.
 *
 * ⚠ THE GATE IS `checkDrift`, NOT `verifyName`. Measured 2026-09-07 over the 35
 * resolvable rows, `verifyName(column C, Master_ID name)` gives 30 MATCH and 5
 * MISMATCH — and ALL FIVE MISMATCHES ARE FALSE ALARMS. Column C is a
 * Thread_Staging display-name field: four of the five hold a RAW ADDRESS
 * (`gsaproposal@gmail.com` resolving correctly to Patrick Suarez), and row 63
 * names a different person entirely from the thread's actual primary. Gating
 * on a label would withhold 14% of the only rows that matter and teach the
 * reader to override the gate.
 *
 * `checkDrift` verifies the ID against the SYSTEMS OF RECORD instead — Attio's
 * own `bhc_contact_id`, `Master_ID.Attio_Record_ID`, and Contacts column A at
 * the Google_Row. The identity key here is the EMAIL, which is what the
 * cascade matched on; the name is not evidence.
 */
async function judgeRow(
  c: { sheetRow: number; r: SheetRow; threadId: string },
  ctx: {
    contactsMap: ContactsEmailMap;
    masterIndex: MasterIdIndex;
    attio: AttioClient;
    masterById: Map<string, { row: number; name: string; location: string }[]>;
    attioCache: Map<string, AttioPersonRecord | null>;
  },
): Promise<RowOutcome> {
  const base = {
    threadId: c.threadId,
    sheetRow: c.sheetRow,
    contactName: cell(c.r, BC.contactName),
    actionRequired: cell(c.r, BC.actionRequired),
    written: false,
  };

  const messages = parseRawEmailsJson(cell(c.r, BC.rawEmails));
  const participants = identifyPrimaryAndSecondary(messages, cell(c.r, BC.direction));
  const primaryEmail = participants.primaryEmail;

  if (!primaryEmail) {
    return { ...base, primaryEmail: null, cls: 'NO_PRIMARY_EMAIL', bhcId: null, source: '-', drift: null,
      verdict: 'no-resolution', detail: 'no external party derivable from the thread' };
  }

  const resolved: ResolvedContact = await resolveContact(primaryEmail, {
    contactsMap: ctx.contactsMap, masterIndex: ctx.masterIndex, attio: ctx.attio,
  });

  const cls: ResolutionClass =
    resolved.bhcId ? 'RESOLVABLE' : resolved.source === 'NEW_CANDIDATE' ? 'NEW_CANDIDATE' : 'UNRESOLVED';

  if (!resolved.bhcId) {
    return { ...base, primaryEmail, cls, bhcId: null, source: resolved.source, drift: null,
      verdict: 'no-resolution', detail: resolved.source };
  }

  // --- the gate --------------------------------------------------------------
  const masterHits = ctx.masterById.get(resolved.bhcId) ?? [];
  if (masterHits.length === 0) {
    return { ...base, primaryEmail, cls, bhcId: resolved.bhcId, source: resolved.source, drift: null,
      verdict: 'withheld-absent-from-master', detail: `${resolved.bhcId} is not in Master_ID` };
  }
  if (masterHits.every((h) => h.location.toUpperCase() === 'SUPERSEDED')) {
    return { ...base, primaryEmail, cls, bhcId: resolved.bhcId, source: resolved.source, drift: null,
      verdict: 'withheld-superseded',
      detail: `${resolved.bhcId} is SUPERSEDED in Master_ID (row(s) ${masterHits.map((h) => h.row).join(', ')})` };
  }

  const attioValues = await fetchAttioValues(ctx.attio, resolved, ctx.attioCache);
  const contactsColA = resolved.googleRow !== null
    ? (ctx.contactsMap.contactIdByGoogleRow.get(resolved.googleRow) ?? null)
    : null;
  const drift = checkDrift({ resolved, contactsColAAtGoogleRow: contactsColA, attioRecordValues: attioValues });

  if (!drift.clean) {
    return { ...base, primaryEmail, cls, bhcId: resolved.bhcId, source: resolved.source, drift,
      verdict: 'withheld-drift', detail: drift.notes.join('; ') };
  }

  /**
   * ⚠ THE ONE JUDGEMENT THIS PASS REFUSES TO MAKE.
   *
   * On a multi-party thread the question is not "what does this address
   * resolve to" — that is settled — but "is this the right primary contact".
   * Brain_Complete rows 63 and 151 are both that shape: the resolution is
   * correct for the address and the address may be the wrong participant.
   * Where the derived primary is not among the addresses the row itself
   * records, the row goes to a human rather than being guessed.
   */
  const recorded = cell(c.r, BC.contactName).toLowerCase();
  const namesLookLikeAddresses = recorded.includes('@');
  if (namesLookLikeAddresses && !recorded.includes(primaryEmail.toLowerCase())) {
    return { ...base, primaryEmail, cls, bhcId: resolved.bhcId, source: resolved.source, drift,
      verdict: 'withheld-primary-not-on-thread',
      detail: `derived primary ${primaryEmail} is not among the addresses column C records` };
  }

  return { ...base, primaryEmail, cls, bhcId: resolved.bhcId, source: resolved.source, drift,
    verdict: 'write', detail: `${resolved.source}, drift clean` };
}

async function fetchAttioValues(
  attio: AttioClient,
  resolved: ResolvedContact,
  cache: Map<string, AttioPersonRecord | null>,
): Promise<Record<string, unknown> | null> {
  if (!resolved.attioRecordId) return null;
  if (cache.has(resolved.attioRecordId)) return cache.get(resolved.attioRecordId)?.values ?? null;
  try {
    const record = await attio.getPersonRecord(resolved.attioRecordId);
    cache.set(resolved.attioRecordId, record);
    return record.values;
  } catch {
    cache.set(resolved.attioRecordId, null);
    return null;
  }
}

/** Half the fingerprint: how many Attio people carry a bhc_contact_id today. */
async function countBridgedAttio(attio: AttioClient): Promise<number> {
  const { people } = await attio.listAllPeople({});
  let n = 0;
  for (const p of people) {
    const v = p.values['bhc_contact_id'];
    if (Array.isArray(v) && v.length > 0) n += 1;
  }
  return n;
}

async function readState(
  sheets: SheetsClient,
  logger: Logger,
  dryRun: boolean,
  warnings: string[],
): Promise<SheetRow[]> {
  try {
    return await sheets.read(STATE_RANGES.data);
  } catch (error) {
    const msg = `${STATE_RANGES.data} is unreadable (${error instanceof Error ? error.message : String(error)})`;
    if (!dryRun) {
      // The Sheets proxy cannot create a tab; say so with the fix in the message.
      throw new AbortRun(
        `${msg}. This routine cannot create tabs — create "Reresolution_State" with the header: thread_id, ` +
          'brain_complete_row, last_class, terminal, derivation_version, corpus_fingerprint, last_attempt_date, notes',
      );
    }
    logger.warn(`  ${msg} — dry run continues with no prior state`);
    warnings.push(`${msg} (a live run would stop here)`);
    return [];
  }
}

/** Full rewrite of the state block, then blank the tail. State is derived, never authored. */
async function writeState(
  sheets: SheetsClient,
  priorRaw: readonly SheetRow[],
  priorByThread: Map<string, RowState>,
  outcomes: readonly RowOutcome[],
  freshRows: readonly unknown[][],
  warnings: string[],
): Promise<number> {
  const touched = new Set(outcomes.map((o) => o.threadId));
  const untouched = [...priorByThread.values()].filter((s) => !touched.has(s.threadId)).map((s) => s.cells);
  const all = [...untouched, ...freshRows];
  const lastRow = 1 + all.length;
  if (all.length > 0) await sheets.update(`Reresolution_State!A2:H${lastRow}`, all);
  const priorLast = 1 + priorRaw.length;
  if (priorLast > lastRow) {
    const blank = new Array(8).fill('');
    await sheets.update(
      `Reresolution_State!A${lastRow + 1}:H${priorLast}`,
      Array.from({ length: priorLast - lastRow }, () => blank),
    );
  }
  const back = await sheets.read(STATE_RANGES.data);
  const live = back.filter((r) => cell(r, 0) !== '').length;
  if (live !== all.length) warnings.push(`state tab read back ${live} row(s), wrote ${all.length}`);
  return live;
}
