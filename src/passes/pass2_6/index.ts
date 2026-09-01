/**
 * PASS 2.6 — calendar-evidence reconciliation.
 *
 * pass2_5 reconciles open tasks against Activity_Log. This does the same job
 * against CALENDAR evidence, and it is deliberately its own pass: pass2_5 is
 * already the pass with the most moving parts, and the two run on different
 * clocks. Activity_Log is filled nightly by Late Edition; the calendar is
 * continuously fresh. Folding them together forces one cadence onto two
 * sources that do not move at the same rate.
 *
 * ⚠ THE PRIVILEGED BODY NEVER REACHES THIS FILE. Extraction happens in
 * attendees.ts and returns addresses; toSafeEvent strips body and bodyPreview
 * structurally. Nothing here can log or write a body because nothing here holds
 * one — enforced by the type, not by discipline.
 */

import { RANGES } from '../../config/constants.js';
import type { SheetsClient } from '../../lib/sheets.js';
import { toSafeEvent, type CalendarClient } from '../../lib/calendar.js';
import { loadOpenTasks } from '../pass2_5/tasks.js';
import { attributePath, extractParticipants } from './attendees.js';
import { applyNoiseFilter, isExternalAddress } from './filter.js';
import { buildContactDirectory, resolveByAddress, resolveBySubject } from './identity.js';
import { reconcileTask } from './match.js';
import {
  QUEUE_APPEND_RANGE, buildQueueRow, isEnqueueable,
  ITEM_TYPE_CALENDAR, EVIDENCE_SOURCE_CALENDAR,
} from './queue-write.js';
import {
  WATERMARK_TAB, WATERMARK_COLUMNS, WATERMARK_LAST_COLUMN, WATERMARK_FIRST_DATA_ROW,
  loadWatermark, shouldEvaluate, watermarkRowValues,
} from './watermark.js';
import type { CandidateEvent, CalendarReconciliationResult, Pass26Report } from './types.js';

export interface Logger { info(m: string): void; warn(m: string): void }

export interface Pass26Options {
  readonly sheets: SheetsClient;
  readonly calendar: CalendarClient;
  readonly logger: Logger;
  readonly dryRun: boolean;
  readonly runId: string;
  readonly lookbackDays?: number;
  readonly now?: Date;
  /**
   * Exercise the watermark live while leaving Reconciliation_Queue untouched.
   * The queue write is gated behind human review of a dry run; the watermark is
   * not, and proving watermark suppression needs a real write.
   */
  readonly skipQueueWrite?: boolean;
}

function emptyReport(p: Partial<Pass26Report> & { runId: string; dryRun: boolean; startedAt: string }): Pass26Report {
  return {
    finishedAt: new Date().toISOString(), aborted: false, abortReason: null,
    windowStart: '', windowEnd: '', eventsFetched: 0, windowComplete: false,
    extractionPaths: { path1: 0, path2: 0, path3: 0 }, filterSurvivors: 0, filterDrops: {},
    participantsResolved: 0, openTaskCount: 0, tasksEvaluated: 0, tasksSkippedByWatermark: 0,
    verdictCounts: {}, unevaluableCount: 0, enqueuedCount: 0, supersededCount: 0,
    watermarkRowsWritten: 0, results: [], wouldWrite: [], warnings: [], ...p,
  };
}

/** Never throws — same fail-soft posture as every other pass. */
export async function runPass26(opts: Pass26Options): Promise<Pass26Report> {
  const startedAt = (opts.now ?? new Date()).toISOString();
  try {
    return await inner(opts, startedAt);
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    opts.logger.warn(`PASS 2.6 aborted: ${msg}`);
    return emptyReport({ runId: opts.runId, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: msg });
  }
}

async function inner(opts: Pass26Options, startedAt: string): Promise<Pass26Report> {
  const { sheets, calendar, logger, dryRun, runId } = opts;
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? 7;
  const warnings: string[] = [];
  const wouldWrite: string[] = [];

  logger.info(`BHC PASS 2.6 — calendar reconciliation · ${runId}`);
  logger.info(`  mode : ${dryRun ? 'DRY RUN (no writes issued anywhere)' : opts.skipQueueWrite ? 'LIVE, queue write SKIPPED' : 'LIVE'}`);

  // ── 1. Calendar window. END IS EXCLUSIVE — [start, end). ────────────────
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();
  const fetched = await calendar.listEvents(windowStart, windowEnd);
  logger.info(`  window ${windowStart.slice(0, 10)} → ${windowEnd.slice(0, 10)} (end exclusive) · ${fetched.eventCount} event(s) · ${fetched.pagesFetched} page(s) · preRead ${fetched.preReadMs}ms`);

  // ⚠ A PARTIAL PAGE IS NOT A SMALLER MONTH — IT IS AN UNKNOWN ONE. Judging
  // against a truncated set produces NO_EVIDENCE for meetings that exist.
  if (!fetched.complete) {
    const w = `⚠ calendar window INCOMPLETE (${fetched.partialReason ?? 'no reason given'}) — a partial page is an UNKNOWN window, not a smaller one. Skipping the run rather than judging on a truncated set.`;
    logger.warn(`  ${w}`);
    return emptyReport({
      runId, dryRun, startedAt, windowStart, windowEnd,
      eventsFetched: fetched.eventCount, windowComplete: false, warnings: [w],
    });
  }

  // ── 2. Extract, then DISCARD the body. ──────────────────────────────────
  const extractionPaths = { path1: 0, path2: 0, path3: 0 };
  const filterDrops: Record<string, number> = {};
  const surviving: { safe: ReturnType<typeof toSafeEvent>; participants: ReturnType<typeof extractParticipants> }[] = [];

  for (const raw of fetched.events) {
    const p = attributePath(raw);
    extractionPaths[p === 1 ? 'path1' : p === 2 ? 'path2' : 'path3'] += 1;
    const participants = extractParticipants(raw);
    const safe = toSafeEvent(raw);
    const outcome = applyNoiseFilter(safe, participants);
    if (!outcome.keep) { filterDrops[outcome.reason!] = (filterDrops[outcome.reason!] ?? 0) + 1; continue; }
    surviving.push({ safe, participants });
  }
  logger.info(`  extraction: path1=${extractionPaths.path1} path2=${extractionPaths.path2} path3=${extractionPaths.path3}`);
  logger.info(`  filter: ${surviving.length} survivor(s) · dropped ${JSON.stringify(filterDrops)}`);

  // ── 3. Identity. ────────────────────────────────────────────────────────
  const [contactsHeader, contactsData] = await Promise.all([
    sheets.read(RANGES.contactsHeader),
    sheets.read(RANGES.contactsData),
  ]);
  const dir = buildContactDirectory(contactsHeader, contactsData);

  const candidates: CandidateEvent[] = surviving.map(({ safe, participants }) => ({
    event: safe,
    participants,
    byAddress: resolveByAddress(participants.addresses, dir),
    bySubject: resolveBySubject(participants.subject, dir),
  }));
  const participantsResolved = new Set(candidates.flatMap((c) => [...c.byAddress, ...c.bySubject])).size;
  const externalSeen = candidates.reduce((n, c) => n + c.participants.addresses.filter(isExternalAddress).length, 0);
  logger.info(`  identity: ${participantsResolved} distinct contact(s) resolved · ${externalSeen} external address(es) seen`);

  // ── 4. Open tasks + watermark. ──────────────────────────────────────────
  const openTasks = await loadOpenTasks(sheets);
  const wm = await loadWatermark(sheets);
  if (!wm.headerPresent) {
    warnings.push(`${WATERMARK_TAB} has no header row — a live run writes it; the Sheets proxy cannot create tabs, and the tab itself already exists.`);
  }
  const wmByTask = new Map(wm.rows.map((r) => [r.taskId, r]));

  const results: CalendarReconciliationResult[] = [];
  let skipped = 0;
  for (const task of openTasks) {
    const contactStarts = candidates
      .filter((c) => task.contactId !== '' && (c.byAddress.includes(task.contactId) || c.bySubject.includes(task.contactId)))
      .map((c) => c.event.startIso);
    if (!shouldEvaluate(task.taskId, contactStarts, wmByTask)) { skipped += 1; continue; }
    results.push(reconcileTask(task, candidates, {
      windowStartIso: windowStart,
      lastEventSeen: wmByTask.get(task.taskId)?.lastEventSeen ?? '',
    }));
  }

  const verdictCounts: Record<string, number> = {};
  for (const r of results) verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;
  const unevaluableCount = results.filter((r) => r.verdict === 'UNEVALUABLE').length;
  logger.info(`  tasks: ${openTasks.length} open · ${results.length} evaluated · ${skipped} skipped by watermark`);
  logger.info(`  verdicts: ${JSON.stringify(verdictCounts)}`);

  // ── 5. Queue write — gated. UNEVALUABLE is a count, never a card. ───────
  const enqueueable = results.filter(isEnqueueable);
  const rows = enqueueable.map((r, i) => buildQueueRow(runId, `RECON-CAL-${Date.now()}-${i}`, r));
  let enqueuedCount = 0;
  if (rows.length > 0) {
    if (dryRun || opts.skipQueueWrite) {
      for (const row of rows) wouldWrite.push(`APPEND ${QUEUE_APPEND_RANGE} ${JSON.stringify(row)}`);
      logger.info(`  ${dryRun ? 'DRY RUN' : 'queue write SKIPPED'} — ${rows.length} queue row(s) computed, 0 written`);
    } else {
      const res = await sheets.append(QUEUE_APPEND_RANGE, rows);
      // Count CONFIRMED writes, never intended.
      enqueuedCount = Math.min(res.updatedRows, rows.length);
      if (!res.updatedRowsFieldPresent) {
        warnings.push(`⚠ Reconciliation_Queue append is UNVERIFIABLE — no updatedRows (transport or proxy fault), NOT a refusal. ${rows.length} row(s) may or may not have landed; the watermark was NOT advanced.`);
      } else if (enqueuedCount < rows.length) {
        warnings.push(`⚠ Reconciliation_Queue: ${enqueuedCount} of ${rows.length} row(s) confirmed — ${rows.length - enqueuedCount} did NOT land.`);
      }
    }
  }

  // ── 6. Watermark — GATED on the queue write. ────────────────────────────
  // ⚠ NEVER STAMP A WATERMARK OVER AN UNCONFIRMED QUEUE WRITE. Doing so would
  // suppress re-evaluation of a task whose proposal never reached Bobby — the
  // same shape as pass2's PROCESSED stamp over a lost Brain_Complete row.
  let watermarkRowsWritten = 0;
  const queueConfirmed = rows.length === 0 || enqueuedCount === rows.length;
  if (dryRun) {
    for (const r of results) wouldWrite.push(`WATERMARK ${r.taskId} lastEventSeen=${r.lastEventSeen} verdict=${r.verdict}`);
  } else if (!queueConfirmed && !opts.skipQueueWrite) {
    warnings.push(`⚠ watermark NOT advanced for ${results.length} task(s) — the queue write was not confirmed, so these must be re-evaluated next run.`);
  } else if (results.length > 0) {
    const batch: { range: string; values: readonly unknown[][] }[] = [];
    if (!wm.headerPresent) {
      batch.push({ range: `${WATERMARK_TAB}!A1:${WATERMARK_LAST_COLUMN}1`, values: [[...WATERMARK_COLUMNS]] });
    }
    let nextRow = Math.max(wm.rows.reduce((m, r) => Math.max(m, r.sheetRow), WATERMARK_FIRST_DATA_ROW - 1) + 1, WATERMARK_FIRST_DATA_ROW);
    for (const r of results) {
      const existing = wmByTask.get(r.taskId);
      const values = watermarkRowValues({
        taskId: r.taskId, source: r.source, bhcId: r.bhcId,
        lastEvaluatedAt: new Date().toISOString(), lastEventSeen: r.lastEventSeen,
        lastVerdict: r.verdict, evalCount: (existing?.evalCount ?? 0) + 1, notes: '',
      });
      const row = existing?.sheetRow ?? nextRow++;
      batch.push({ range: `${WATERMARK_TAB}!A${row}:${WATERMARK_LAST_COLUMN}${row}`, values: [values] });
    }
    const res = await sheets.batchUpdate(batch);
    if (!res.fieldsPresent) warnings.push(`⚠ ${WATERMARK_TAB} write is UNVERIFIABLE — no totalUpdatedCells, NOT a refusal.`);
    else if (res.totalUpdatedCells === 0) warnings.push(`⚠ ${WATERMARK_TAB} write was REFUSED — 0 cells written; nothing is watermarked and the next run re-evaluates everything.`);
    else watermarkRowsWritten = results.length;
  }

  for (const w of warnings) logger.warn(`  ${w}`);
  logger.info(`  ITEM_TYPE=${ITEM_TYPE_CALENDAR} EVIDENCE_SOURCE=${EVIDENCE_SOURCE_CALENDAR}`);

  return {
    runId, dryRun, startedAt, finishedAt: new Date().toISOString(), aborted: false, abortReason: null,
    windowStart, windowEnd, eventsFetched: fetched.eventCount, windowComplete: true,
    extractionPaths, filterSurvivors: surviving.length, filterDrops, participantsResolved,
    openTaskCount: openTasks.length, tasksEvaluated: results.length, tasksSkippedByWatermark: skipped,
    verdictCounts, unevaluableCount, enqueuedCount, supersededCount: 0,
    watermarkRowsWritten, results, wouldWrite, warnings,
  };
}
