/**
 * Resync IDs — standalone routine, NOT a Late Edition pass.
 *
 * Re-derives Master_ID.Google_Row for every GOOGLE/BOTH identity by matching
 * Contact_ID against Contacts col A. Writes ONLY Master_ID col D, one small
 * explicit range per correction, batched into as few requests as possible and
 * verified by a single read of the whole column afterwards — no correction
 * counts as fixed until that read shows the expected value.
 *
 * Verification is END-OF-RUN, not per-write, and that is deliberate: it checks
 * the FINAL state of column D, so it also catches a correction that landed and
 * was then overwritten later in the same run. Per-write read-back could not see
 * that. It is also what keeps the run inside Google's 60 requests/minute — see
 * applyCorrections.
 *
 * Never writes Contacts. Never writes Attio. Never mints. Never deletes.
 * Never touches a SUPERSEDED row.
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { Logger } from '../../lib/logger.js';
import type { SlackPoster } from '../../lib/slack.js';
import { buildContactsIndex, computeResync, formatSlackMessage } from './resync.js';
import type {
  MasterIdRowLite, ResyncReport, ResyncWriteOutcome, ResyncWriteResult, RowCorrection,
} from './types.js';

export interface ResyncOptions {
  readonly sheets: SheetsClient;
  readonly logger: Logger;
  readonly slack: SlackPoster;
  readonly dryRun: boolean;
  readonly runId: string;
}

function parseMasterRows(rows: readonly (readonly unknown[])[]): MasterIdRowLite[] {
  return rows.map((row, i) => {
    const raw = cell(row, 3); // D Google_Row
    const n = Number.parseInt(raw, 10);
    return {
      bhcId: cell(row, 0),
      location: cell(row, 2).toUpperCase(),
      storedGoogleRow: Number.isFinite(n) && n > 0 ? n : null,
      masterRow: i + 2, // RANGES.masterId starts at row 2
    };
  });
}

export async function runResyncIds(opts: ResyncOptions): Promise<ResyncReport> {
  const { sheets, logger, slack, dryRun, runId } = opts;
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];

  logger.info('Resync IDs — re-derive Master_ID.Google_Row from Contacts col A');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes Master_ID col D)'}`);

  // ── read both sides ONCE ────────────────────────────────────────────────
  const masterRaw = await sheets.read(RANGES.masterId);
  const contactsRaw = await sheets.read(RANGES.contactsIdColumn);
  logger.info(`  Master_ID rows read : ${masterRaw.length}`);
  logger.info(`  Contacts rows read  : ${contactsRaw.length}`);

  // A read that returns nothing is a failure, not an empty sheet — both tabs
  // hold thousands of rows in production. Proceeding would compute "every
  // pointer is unresolvable" and, worse, look like a clean run.
  if (masterRaw.length === 0) throw new Error('Master_ID read returned 0 rows — refusing to run against an empty read.');
  if (contactsRaw.length === 0) throw new Error('Contacts read returned 0 rows — refusing to run against an empty read.');

  const contacts = buildContactsIndex(contactsRaw);
  if (contacts.duplicates.size > 0) {
    const w = `${contacts.duplicates.size} Contact_ID(s) appear on multiple Contacts rows — those are left untouched`;
    warnings.push(w);
    logger.warn(`  ${w}`);
  }

  const plan = computeResync(parseMasterRows(masterRaw), contacts);
  logger.info(
    `  checked=${plan.checked} corrections=${plan.corrections.length} alreadyCorrect=${plan.alreadyCorrect} ` +
      `unresolvable=${plan.unresolvable.length} skipped(superseded=${plan.skippedSuperseded} notGoogle=${plan.skippedNotGoogle} gaps=${plan.skippedGapRows})`,
  );
  for (const c of plan.corrections) {
    logger.info(`    FIX ${c.bhcId} @ Master_ID row ${c.masterRow}: Google_Row ${c.oldRow ?? '(blank)'} → ${c.newRow}`);
  }
  for (const u of plan.unresolvable) {
    logger.info(`    UNRESOLVABLE ${u.bhcId} @ Master_ID row ${u.masterRow}: ${u.detail}`);
  }

  // ── write ───────────────────────────────────────────────────────────────
  const writes: ResyncWriteResult[] = [];
  if (dryRun) {
    logger.info(`  DRY RUN: ${plan.corrections.length} correction(s) computed, 0 written`);
  } else {
    writes.push(...(await applyCorrections(sheets, plan.corrections, logger)));

    const tally = (o: ResyncWriteOutcome) => writes.filter((w) => w.outcome === o).length;
    const failed = tally('WRITE_FAILED') + tally('MISMATCH');
    const unsure = tally('VERIFY_INCONCLUSIVE');
    if (failed > 0) {
      const w = `${failed} correction(s) did not land (${tally('WRITE_FAILED')} write failed, ${tally('MISMATCH')} read back wrong)`;
      warnings.push(w);
      logger.warn(`  ${w}`);
    }
    if (unsure > 0) {
      // Said precisely: these were ISSUED. Calling them failures would repeat
      // exactly the misreport this distinction exists to prevent.
      const w = `${unsure} correction(s) were issued but could not be confirmed — they may well have landed; re-run to confirm`;
      warnings.push(w);
      logger.warn(`  ${w}`);
    }
  }

  await slack.post(formatSlackMessage(plan, { dryRun, runId }));

  return {
    runId, dryRun, startedAt, finishedAt: new Date().toISOString(),
    masterIdRowsRead: masterRaw.length, contactsRowsRead: contactsRaw.length,
    plan, writes, warnings,
  };
}

/** Google caps a batchUpdate payload generously; 100 single-cell ranges per
 *  request keeps each request small while collapsing 291 writes into 3. */
const WRITE_BATCH_SIZE = 100;

/** Breathing room between batches. With batching the run needs only a handful of
 *  requests, so this is cheap insurance rather than the mechanism — the call
 *  count is what fixed the 429s, not the delay. */
const BATCH_PACE_MS = 1_100;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const rangeFor = (c: RowCorrection): string => `Master_ID!D${c.masterRow}:D${c.masterRow}`;

/**
 * Issue every correction, then verify them all against ONE read.
 *
 * WHY THIS SHAPE. The old loop did update+read per correction — two requests
 * each, unpaced. 291 corrections meant 582 requests at roughly 220/minute
 * against Google's 60/minute ceiling on reads and writes independently, and it
 * blew both. Batched writes plus a single column read take that to 4 requests
 * for the same 291 corrections.
 *
 * Still one small explicit range per correction inside the batch —
 * `Master_ID!D{row}`, never a positional full-row write that would carry every
 * other column along with it.
 *
 * Verification is now against the FINAL state of column D rather than the value
 * immediately after each write. That is strictly stronger: it also catches a
 * correction that landed and was then overwritten later in the same run.
 */
async function applyCorrections(
  sheets: SheetsClient,
  corrections: readonly RowCorrection[],
  logger: Logger,
): Promise<ResyncWriteResult[]> {
  if (corrections.length === 0) return [];

  // ── issue the writes, batched ──────────────────────────────────────────
  const issued = new Map<number, { ok: boolean; detail: string }>();
  const batches = chunk(corrections, WRITE_BATCH_SIZE);
  logger.info(`  writing ${corrections.length} correction(s) in ${batches.length} batch(es) of up to ${WRITE_BATCH_SIZE}`);

  for (const [i, batch] of batches.entries()) {
    const data = batch.map((c) => ({ range: rangeFor(c), values: [[c.newRow]] }));
    try {
      await sheets.batchUpdate(data);
      for (const c of batch) issued.set(c.masterRow, { ok: true, detail: `${rangeFor(c)} = ${c.newRow}` });
      logger.info(`    batch ${i + 1}/${batches.length}: ${batch.length} range(s) issued`);
    } catch (e) {
      // The whole batch failed as one request, so every correction in it is
      // unwritten — not unknown. A failed request wrote nothing.
      for (const c of batch) issued.set(c.masterRow, { ok: false, detail: String(e) });
      logger.warn(`    batch ${i + 1}/${batches.length} FAILED (${batch.length} range(s)): ${String(e)}`);
    }
    if (i < batches.length - 1) await sleep(BATCH_PACE_MS);
  }

  // ── verify: one read of the whole column ───────────────────────────────
  let snapshot: readonly (readonly unknown[])[] | null = null;
  let verifyError = '';
  try {
    snapshot = await sheets.read('Master_ID!D2:D');
    logger.info(`    verification read: ${snapshot.length} row(s) of Master_ID col D`);
  } catch (e) {
    verifyError = String(e);
    logger.warn(`    verification read FAILED: ${verifyError}`);
  }

  // ── classify ───────────────────────────────────────────────────────────
  return corrections.map((c) => {
    const iss = issued.get(c.masterRow) ?? { ok: false, detail: 'not issued' };

    if (!iss.ok) {
      return { correction: c, outcome: 'WRITE_FAILED' as const, written: false, verified: false, detail: iss.detail };
    }
    if (snapshot === null) {
      return {
        correction: c, outcome: 'VERIFY_INCONCLUSIVE' as const,
        written: true, verified: false,
        detail: `${rangeFor(c)} = ${c.newRow} issued; read-back unavailable: ${verifyError}`,
      };
    }
    // Master_ID!D2:D — sheet row N is index N-2. Sheets truncates trailing
    // blanks, so a short array means "blank", not "missing".
    const got = cell(snapshot[c.masterRow - 2] ?? [], 0);
    if (Number.parseInt(got, 10) === c.newRow) {
      return { correction: c, outcome: 'VERIFIED' as const, written: true, verified: true, detail: `${rangeFor(c)} = ${c.newRow}` };
    }
    return {
      correction: c, outcome: 'MISMATCH' as const, written: true, verified: false,
      detail: `${rangeFor(c)} issued as ${c.newRow} but read back as ${got || '(blank)'}`,
    };
  });
}
