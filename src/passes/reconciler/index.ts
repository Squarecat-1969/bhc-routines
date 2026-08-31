/**
 * BHC Reconciler - read-only data-integrity sweep, ported from
 * routines/BHC_Reconciler.md.
 *
 * WRITE CONTRACT, the load-bearing one: this routine writes EXACTLY TWO tabs -
 * Reconciler_Report (cleared and rewritten each run) and Name_Conflicts
 * (append-only enqueue). It never writes Contacts, Master_ID, Attio, or
 * Activity_Log. Both targets are staging tabs, not live CRM records, so the
 * read/verify/report contract holds.
 *
 * There is no dry-run gate on the read side because there is nothing to gate -
 * every external call in passes 1-4 is a GET. `dryRun` suppresses the two
 * staging writes and the Slack post, for testing.
 */

import { RANGES } from '../../config/constants.js';
import { emailsOf, nameOf, textOf, type AttioClient } from '../../lib/attio.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { Logger } from '../../lib/logger.js';
import type { SlackPoster } from '../../lib/slack.js';
import { attioChecks, type AttioLookup } from './attio-checks.js';
import { buildContactsIndex, googleChecks } from './google.js';
import { applySuppression, shouldWrite, toNameConflictRow } from './name-conflicts.js';
import { buildSlackMessage, countBySeverity, toReportRow } from './report.js';
import { loadMasterRows, structuralChecks } from './structural.js';
import type { Finding, ReconcilerCounts } from './types.js';

const ATTIO_BATCH = 10;
const RATE_LIMIT_PAUSE_MS = 5000;
const MAX_RETRIES = 2;

export const REPORT_RANGES = {
  header: 'Reconciler_Report!A1:N1',
  data: 'Reconciler_Report!A2:N',
} as const;

export interface ReconcilerOptions {
  readonly sheets: SheetsClient;
  readonly attio: AttioClient;
  readonly logger: Logger;
  readonly slack: SlackPoster;
  readonly runId: string;
  /** Suppresses the two staging writes and the Slack post. Reads are unaffected. */
  readonly dryRun: boolean;
}

export interface ReconcilerReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly counts: ReconcilerCounts;
  readonly findings: readonly Finding[];
  readonly byCode: Readonly<Record<string, number>>;
  readonly nameConflicts: {
    readonly candidates: number;
    readonly enqueued: number;
    readonly suppressedResolvedOld: number;
    readonly skippedAwaiting: number;
    readonly reRaised: number;
  };
  readonly warnings: readonly string[];
}

export async function runReconciler(opts: ReconcilerOptions): Promise<ReconcilerReport> {
  const { sheets, attio, logger, slack, runId, dryRun } = opts;
  const startedAt = new Date().toISOString();
  const checkedAt = startedAt;
  const warnings: string[] = [];

  logger.info(`BHC Reconciler - ${runId}`);
  logger.info(`  mode : ${dryRun ? 'DRY RUN (no staging writes, no Slack)' : 'LIVE (writes Reconciler_Report + Name_Conflicts only)'}`);

  // PASS 1
  const masterRaw = await sheets.read(RANGES.masterId);
  if (masterRaw.length === 0) throw new Error('Master_ID read returned 0 rows - refusing to report against an empty read.');
  const master = loadMasterRows(masterRaw);
  logger.info(`PASS 1 - ${master.rows.length} rows loaded · ${master.supersededCount} superseded skipped · ${master.gapRowsSkipped} gap rows · ${master.blankBhcIds} blank BHC_ID · ${master.blankNames} blank names`);

  // PASS 2
  const structural = structuralChecks(master);
  logger.info(`PASS 2 - ${structural.length} structural finding(s)`);

  // PASS 3 - ONE read, serving both the pointer check and I1's identity map.
  const [contactsHeader, contactsData] = await Promise.all([
    sheets.read(RANGES.contactsHeader),
    sheets.read(RANGES.contactsData),
  ]);
  const contacts = buildContactsIndex(contactsHeader, contactsData);
  if (contacts.missingHeaders.length > 0) {
    const w = `Contacts header(s) not found: ${contacts.missingHeaders.join(', ')} - those I1 fields are skipped rather than guessed`;
    warnings.push(w);
    logger.warn(`  ${w}`);
  }
  const google = googleChecks(master.rows, contacts);
  logger.info(`PASS 3 - ${contactsData.length} Contacts rows indexed (last populated ${contacts.lastRow}) · ${google.length} Google finding(s)`);

  // PASS 4
  const existingConflicts = await sheets.read(RANGES.nameConflictsAll);
  const attioIds = [...new Set(master.rows.map((r) => r.attioRecordId).filter((id) => id !== ''))];
  logger.info(`PASS 4 - fetching ${attioIds.length} Attio record(s) in batches of ${ATTIO_BATCH}`);
  const lookups = await fetchAttio(attio, attioIds, logger);
  const { findings: attioFindings, nameConflictCandidates } = attioChecks(master.rows, lookups, contacts.identity);
  logger.info(`PASS 4 - ${attioFindings.length} Attio/I1 finding(s) · ${nameConflictCandidates.length} name-conflict candidate(s)`);

  const decisions = applySuppression(nameConflictCandidates, existingConflicts);
  const toEnqueue = decisions.filter(shouldWrite);
  /** Confirmed by the append's own updatedRows. Stays the PLAN on a dry run, where nothing is issued. */
  let ncEnqueuedConfirmed = toEnqueue.length;
  const nameConflicts = {
    candidates: decisions.length,
    enqueued: toEnqueue.length,
    suppressedResolvedOld: decisions.filter((d) => d.outcome === 'suppressed_resolved_old').length,
    skippedAwaiting: decisions.filter((d) => d.outcome === 'skipped_awaiting').length,
    reRaised: decisions.filter((d) => d.outcome === 're_raised_resolved_new').length,
  };
  logger.info(`  suppression: ${nameConflicts.enqueued} enqueue · ${nameConflicts.suppressedResolvedOld} suppressed (RESOLVED_OLD) · ${nameConflicts.skippedAwaiting} already queued · ${nameConflicts.reRaised} re-raised (RESOLVED_NEW)`);

  const findings = [...structural, ...google, ...attioFindings];
  const sev = countBySeverity(findings);
  const flagged = new Set(findings.map((f) => f.row.masterRow));
  const counts: ReconcilerCounts = {
    totalRowsChecked: master.rows.length,
    high: sev.HIGH, medium: sev.MEDIUM, low: sev.LOW, info: sev.INFO,
    clean: master.rows.length - flagged.size,
    superseded: master.supersededCount,
  };

  const byCode: Record<string, number> = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;

  // PASS 5 - the only two writes in the entire routine.
  const priorRunIds = [...new Set((await sheets.read(REPORT_RANGES.data)).map((r) => cell(r, 0)).filter((v) => v !== ''))];
  if (dryRun) {
    logger.info(`PASS 5 - DRY RUN: ${findings.length} report row(s) and ${toEnqueue.length} conflict row(s) computed, 0 written`);
  } else {
    await writeReport(sheets, findings, { runId, checkedAt }, logger, warnings);
    if (toEnqueue.length > 0) {
      const rows = toEnqueue.map((d, i) =>
        toNameConflictRow(d.candidate, { runId, conflictId: `NC-${Date.now()}-${i}`, detectedAt: checkedAt }),
      );
      // COUNT CONFIRMED, NOT INTENDED. `nameConflicts.enqueued` above is the
      // PLAN — computed from the suppression decisions before anything is
      // written — and it is what the Slack post used to quote as "N name
      // conflict(s) queued for review in Aida". A silent no-op therefore
      // announced a review queue that did not exist, on the one surface Bobby
      // actually reads. The append already returns updatedRows; it was simply
      // discarded.
      const res = await sheets.append(RANGES.nameConflictsAppend, rows as unknown[][]);
      ncEnqueuedConfirmed = Math.min(res.updatedRows, rows.length);
      if (!res.updatedRowsFieldPresent) {
        warnings.push(
          `⚠ Name_Conflicts append is UNVERIFIABLE — the response carried no updatedRows (transport or proxy fault), ` +
            `NOT a refusal. ${rows.length} conflict(s) may or may not have queued; re-run to confirm.`,
        );
      } else if (ncEnqueuedConfirmed < rows.length) {
        warnings.push(
          `⚠ Name_Conflicts: ${ncEnqueuedConfirmed} of ${rows.length} conflict row(s) confirmed written — ` +
            `${rows.length - ncEnqueuedConfirmed} did NOT queue and will not reach Aida's review card.`,
        );
      }
      logger.info(`PASS 5 - enqueued ${ncEnqueuedConfirmed} of ${rows.length} Name_Conflicts row(s) (confirmed)`);
    }
  }

  // PASS 6
  const message = buildSlackMessage({
    runId, counts,
    a5Count: byCode['A5'] ?? 0,
    i1Count: byCode['I1'] ?? 0,
    ncCount: ncEnqueuedConfirmed, // confirmed, not planned — see PASS 5
    foreignRunIds: priorRunIds.filter((r) => r !== runId),
  });
  if (dryRun) {
    logger.info('PASS 6 - DRY RUN, Slack suppressed. Would post:');
    logger.info(message);
  } else {
    await slack.post(message);
  }

  return {
    runId, dryRun, startedAt, finishedAt: new Date().toISOString(),
    counts, findings, byCode, nameConflicts, warnings,
  };
}

/**
 * Clear the previous run's rows, keep the header, then write this run's.
 * Cleared by overwriting with blanks over the previously-occupied span - the
 * proxy has no delete, and a short write would leave the tail of a longer prior
 * report sitting under this run's rows looking current.
 */
async function writeReport(
  sheets: SheetsClient,
  findings: readonly Finding[],
  opts: { runId: string; checkedAt: string },
  logger: Logger,
  warnings: string[],
): Promise<void> {
  const prior = await sheets.read(REPORT_RANGES.data);
  const rows = findings.map((f) => toReportRow(f, opts));

  const span = Math.max(prior.length, rows.length);
  if (span === 0) { logger.info('PASS 5 - no findings and no prior rows; report left empty'); return; }

  const padded: unknown[][] = [];
  for (let i = 0; i < span; i++) {
    padded.push(i < rows.length ? [...rows[i]!] : Array.from({ length: 14 }, () => ''));
  }
  const range = `Reconciler_Report!A2:N${1 + span}`;
  await sheets.update(range, padded);

  // THE READ-BACK ALREADY RAN; ITS VERDICT NOW REACHES A HUMAN.
  //
  // This compared nothing and warned about nothing — it logged a number
  // beside another number and left the reader to notice. That is the third
  // instance of this exact shape in this repo (resync-ids' Slack post,
  // Part D's counts.tasks, this), where verification happens and the operator
  // never sees the verdict. A check nobody reads is not a check.
  const back = await sheets.read(REPORT_RANGES.data);
  const landed = back.filter((r) => cell(r, 0) === opts.runId).length;
  logger.info(`PASS 5 - wrote ${rows.length} finding(s) to ${range}; read-back sees ${landed} row(s) for this run`);
  if (landed !== rows.length) {
    const w =
      `⚠ Reconciler_Report read-back disagrees: wrote ${rows.length} finding(s) to ${range}, ` +
      `but only ${landed} row(s) for run ${opts.runId} read back. The report Aida shows is incomplete.`;
    warnings.push(w);
    logger.warn(`  ${w}`);
  }
}

/** Batches of 10, retry with a pause on failure, A4 after MAX_RETRIES. */
async function fetchAttio(
  attio: AttioClient,
  ids: readonly string[],
  logger: Logger,
): Promise<Map<string, AttioLookup>> {
  const out = new Map<string, AttioLookup>();

  for (let i = 0; i < ids.length; i += ATTIO_BATCH) {
    const batch = ids.slice(i, i + ATTIO_BATCH);
    const settled = await Promise.allSettled(batch.map((id) => fetchOne(attio, id)));
    settled.forEach((res, j) => {
      const id = batch[j]!;
      out.set(id, res.status === 'fulfilled' ? res.value : { kind: 'failed', error: String(res.reason) });
    });
    if ((i / ATTIO_BATCH) % 20 === 0) logger.info(`  ...${Math.min(i + ATTIO_BATCH, ids.length)}/${ids.length}`);
  }

  return out;
}

async function fetchOne(attio: AttioClient, id: string): Promise<AttioLookup> {
  for (let attempt = 0; ; attempt++) {
    try {
      const rec = await attio.getPersonRecord(id);
      return {
        kind: 'ok',
        bhcContactId: textOf(rec.values, 'bhc_contact_id') ?? '',
        name: nameOf(rec.values) ?? '',
        jobTitle: textOf(rec.values, 'job_title') ?? '',
        companyName: textOf(rec.values, 'company_name') ?? '',
        emails: emailsOf(rec.values, 'email_addresses'),
      };
    } catch (e) {
      const msg = String(e);
      if (/404|not found/i.test(msg)) return { kind: 'not_found' };
      if (attempt >= MAX_RETRIES) return { kind: 'failed', error: msg.slice(0, 200) };
      if (/429|rate/i.test(msg)) await new Promise((r) => setTimeout(r, RATE_LIMIT_PAUSE_MS));
    }
  }
}
