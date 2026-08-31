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
import type { SlackPoster } from '../../lib/slack.js';
import type { IssueCode } from '../reconciler/types.js';
import { buildFixSlackMessage, outOfScopeCodes } from './report.js';
import { makeAttioIdentityWritePort, makeMasterSheetPort } from './adapters.js';
import { repairS1, type S1Result, type S1Row } from './s1.js';
import { repairS4, type S4Result, type S4Row } from './s4.js';
import { repairA3, type A3Candidate, type A3Result } from './a3.js';
import { repairA1, type A1Candidate, type A1Result } from './a1.js';
import { repairI1, type I1Candidate, type I1Field, type I1Result } from './i1.js';
import type { AttioIdentityWritePort, Logger, MasterSheetPort } from './ports.js';

const REPORT_RANGE = 'Reconciler_Report!A2:N';
/** Reconciler_Report columns, 0-based, per the live schema. */
const COL = { runId: 0, checkedAt: 1, bhcId: 2, fullName: 3, masterRow: 4, attioRecordId: 6, location: 7, code: 8, expected: 11, found: 12, notes: 13 } as const;

/**
 * How far Reconciler_Report's own Checked_At may precede the workflow_run
 * trigger time and still count as fresh.
 *
 * FIVE MINUTES, AND DO NOT TIGHTEN THIS TO ZERO. `workflow_run.created_at` is
 * when GitHub created the triggering run, which is BEFORE the Reconciler
 * process started — checkout and `npm ci` sit in between, a minute or two in
 * practice. A zero grace would therefore refuse perfectly valid chains, which
 * is a worse failure than the one this guard exists to prevent. Five minutes
 * is generous against that setup cost and still catches the observed
 * ten-hour gap by three orders of magnitude.
 */
export const STALE_GRACE_MS = 5 * 60 * 1000;

/** "10h 02m" / "3m 20s" — for a refusal an operator reads in Slack. */
function humanizeMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

export interface ReconcilerFixReport {
  readonly fixRunId: string;
  readonly dryRun: boolean;
  readonly sourceRunId: string | null;
  /**
   * Set ONLY when the freshness guard refused. The message an operator reads;
   * null on every normal run. The CLI exits non-zero when this is non-null.
   */
  readonly staleRefusal: string | null;
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
  /**
   * BHC_IDs whose I1 finding was skipped because that same BHC_ID is an active
   * S1 duplicate this run. Same reasoning and same structural separation as
   * excludedFromA1: "not acted on because ownership is unresolved" is a
   * different fact from I1's needs_manual outcomes, and folding the two
   * together would hide it.
   */
  readonly excludedFromI1: readonly string[];
  /**
   * HIGH/MEDIUM findings in the SOURCE Reconciler run whose code Fix has no
   * repair pass for - S2, S3, S5, G1, G3, A5 as ISSUE_META stands today.
   * Counted in findings-rows, the same unit as `candidates`, and derived
   * purely from the Reconciler_Report rows already read for PASS 1: no extra
   * read, no write. Present so "never attempted" can be told apart from
   * "attempted and needs a human" downstream, which is the whole point of the
   * Slack report.
   */
  readonly outOfScope: Readonly<Partial<Record<IssueCode, number>>>;
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
  /**
   * Optional so the existing unit tests can call this without one. A LIVE run
   * with no poster warns rather than posting silently - the absence of a
   * report is never allowed to look like a clean run. Posting lives here
   * rather than in the CLI so dry-run containment is provable by the same
   * throwing-port method the write paths already use.
   */
  readonly slack?: SlackPoster;
  /**
   * `github.event.workflow_run.created_at` from the chain arm, when Fix was
   * triggered by a Reconciler completing. Absent for workflow_dispatch and
   * for local runs, and when absent the guard does not run at all — a human
   * invoking this by hand gets exactly today's behaviour and no new failure
   * mode.
   */
  readonly triggeredAt?: string;
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

  // ── FRESHNESS GUARD — before any repair pass, before any write. ──────────
  //
  // WHY THIS EXISTS. The workflow_run arm runs LIVE unconditionally, which is
  // deliberate and documented. But it assumes the Reconciler that triggered it
  // WROTE Reconciler_Report. A DRY Reconciler writes nothing at all — the whole
  // writeReport call sits inside its `else` — so the tab still holds whatever
  // the last LIVE run left. Fix then chains live, reads that older report, and
  // repairs from it. Observed 2026-08-30: a dry Reconciler chained into a live
  // Fix which quoted a ten-hour-old audit as current.
  //
  // THE SHEET CANNOT TELL DRY FROM LIVE. A dry run leaves no marker of any
  // kind, so there is nothing to detect. What the sheet CAN say is when the
  // last live write happened — col B, Checked_At — which makes this a
  // STALENESS check rather than a dry-run check. That is the better test
  // anyway: it also catches a live Reconciler that aborted before PASS 5, or
  // one whose report write was refused.
  //
  // AN EMPTY REPORT PROCEEDS. Decided explicitly, not by omission. A live
  // Reconciler with zero findings writes no rows — and writeReport blanks any
  // prior rows over the same span, so an empty tab is positive evidence of a
  // clean live audit, not an absence of one. Refusing here would break the
  // healthy case permanently, which is worse than the bug being fixed, and
  // there is nothing to repair anyway: no rows means no candidates and no
  // writes, so proceeding is a no-op. The hazard is acting on stale FINDINGS;
  // with no findings there is no hazard.
  let staleRefusal: string | null = null;
  if (opts.triggeredAt && issues.length > 0) {
    const triggeredMs = Date.parse(opts.triggeredAt);
    const checkedAtRaw = issues.map((r) => cell(r, COL.checkedAt)).find((v) => v !== '') ?? '';
    const checkedMs = Date.parse(checkedAtRaw);

    if (Number.isNaN(triggeredMs)) {
      // Our own flag is malformed. Do not refuse on it — that would make a
      // typo in the workflow disable the routine.
      warnings.push(`--triggered-at ${JSON.stringify(opts.triggeredAt)} is not a parseable timestamp - freshness guard SKIPPED`);
      logger.warn(`  ${warnings[warnings.length - 1]}`);
    } else if (Number.isNaN(checkedMs)) {
      // Rows present but no readable Checked_At. writeReport always writes one,
      // so this is an anomaly, and it means freshness CANNOT be established on
      // a pass that writes Attio and Master_ID unattended. Refuse.
      staleRefusal =
        `⚠ Reconciler Fix REFUSED - the audit it would act on cannot be dated.\n` +
        `Reconciler_Report holds ${issues.length} row(s) for source run ${sourceRunId ?? '(none)'}, but col B (Checked_At) ` +
        `reads ${JSON.stringify(checkedAtRaw)}, which is not a parseable timestamp. Freshness cannot be established, so no ` +
        `repair pass ran and nothing was written.`;
    } else if (checkedMs < triggeredMs - STALE_GRACE_MS) {
      const age = humanizeMs(triggeredMs - checkedMs);
      staleRefusal =
        `⚠ Reconciler Fix REFUSED - the audit it would act on is STALE.\n` +
        `Reconciler_Report was written ${checkedAtRaw} (source run ${sourceRunId ?? '(none)'}); this run was triggered at ` +
        `${opts.triggeredAt}. The report predates its own trigger by ${age}, beyond the ${humanizeMs(STALE_GRACE_MS)} grace.\n` +
        `A dry Reconciler writes nothing, so the tab still holds an older LIVE run. Repairing from it would act on a view of ` +
        `the CRM ${age} out of date. No repair pass ran and nothing was written.`;
    }
  }

  if (staleRefusal !== null) {
    logger.warn(staleRefusal);
    if (!dryRun && opts.slack) await opts.slack.post(staleRefusal);
    else if (dryRun) logger.info('DRY RUN - Slack suppressed. Would post the refusal above.');
    return {
      fixRunId, dryRun, sourceRunId, staleRefusal,
      startedAt, finishedAt: new Date().toISOString(),
      candidates: { S1: 0, A1: 0, A3: 0, S4: 0, I1: 0 },
      s1: { groups: [], counts: { groups: 0, orphansFlagged: 0, hardStops: 0, writeFailures: 0 } },
      a1: { rows: [], counts: { considered: 0, fixed: 0, needsManual: 0, attioWrites: 0 } },
      a3: { rows: [], counts: { considered: 0, repointed: 0, setGoogleOnly: 0, ambiguous: 0, lookupFailed: 0, writeFailed: 0, hardStops: 0 } },
      s4: { groups: [], counts: { groups: 0, repaired: 0, needsManual: 0, lookupFailed: 0, orphansCleared: 0, hardStops: 0 } },
      i1: { rows: [], counts: { considered: 0, fixed: 0, needsManual: 0, attioWrites: 0 } },
      excludedFromA1: [], excludedFromI1: [], outOfScope: {}, wouldWrite: [], warnings,
    };
  }

  // Same frozen snapshot, no extra read: what this run's source audit raised
  // that Fix has no pass for. Reported, never acted on.
  const outOfScope: Partial<Record<IssueCode, number>> = {};
  for (const code of outOfScopeCodes()) {
    const n = of(code).length;
    if (n > 0) outOfScope[code] = n;
  }
  if (Object.keys(outOfScope).length > 0) {
    logger.info(`  out of Fix's scope (reported, never repaired): ${JSON.stringify(outOfScope)}`);
  }

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

  // I1 MUST NOT SYNC ONTO A DISPUTED IDENTITY.
  //
  // The residual the A1/S4 exclusion found and left for its own follow-up.
  // I1's two-part gate (name + bhc_contact_id == BHC_ID) is not enough here,
  // and passes for a reason that looks like correctness: when two Master_ID
  // rows claim the same BHC_ID while pointing at their OWN distinct Attio
  // records, each record genuinely carries that BHC_ID and a matching name, so
  // each row's gate passes correctly FROM THAT ROW'S OWN PERSPECTIVE. Neither
  // row can see that a human has not yet decided which of the two is the real
  // person.
  //
  // Milder than the A1/S4 bug - no cross-contamination, each write stays on its
  // own record - but still a write onto an identity formally under dispute, and
  // S1 exists precisely because that judgment is not mechanically resolvable.
  //
  // Reuses s1Ids, already built above for PASS 3. Keyed on BHC_ID, which is
  // what S1 disputes; the A1 exclusion keys on the Attio pointer, which is what
  // S4 disputes. Different disputes, different keys.
  const excludedFromI1: string[] = [];
  const i1: I1Candidate[] = of('I1').flatMap((r) => {
    const bhcId = cell(r, COL.bhcId);
    if (s1Ids.has(bhcId)) {
      excludedFromI1.push(bhcId);
      logger.info(`  ${bhcId} excluded from I1: S1-disputed, ownership not yet resolved - a human must settle the duplicate first`);
      return [];
    }
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
  logger.info(`PASS 6.5 - I1: ${i1.length} candidate(s)${excludedFromI1.length > 0 ? ` (${excludedFromI1.length} excluded as S1-disputed)` : ''}`);
  const i1Result = await repairI1(i1, { sheets: ports.sheets, attio: ports.attio, logger, fixRunId });

  if (dryRun) logger.info(`DRY RUN - ${wouldWrite.length} write(s) computed, 0 issued`);

  // `report` is already taken above - it is the raw Reconciler_Report rows.
  const fixReport: ReconcilerFixReport = {
    fixRunId, dryRun, sourceRunId, staleRefusal: null, startedAt, finishedAt: new Date().toISOString(),
    candidates, s1, a1: a1Result, a3: a3Result, s4, i1: i1Result,
    excludedFromA1, excludedFromI1, outOfScope, wouldWrite, warnings,
  };

  // SLACK IS SUPPRESSED ON DRY RUN, exactly as reconciler/index.ts does it. A
  // dry run is meant to be indistinguishable from not having run at all from
  // outside this process, and a post to #aida is outside this process.
  const message = buildFixSlackMessage(fixReport);
  if (dryRun) {
    logger.info('DRY RUN - Slack suppressed. Would post:');
    logger.info(message);
  } else if (opts.slack) {
    await opts.slack.post(message);
  } else {
    logger.warn('LIVE run with no Slack poster configured - report NOT posted:');
    logger.info(message);
  }

  return fixReport;
}
