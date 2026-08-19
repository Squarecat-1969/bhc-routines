/**
 * Resync IDs — standalone routine, NOT a Late Edition pass.
 *
 * Re-derives Master_ID.Google_Row for every GOOGLE/BOTH identity by matching
 * Contact_ID against Contacts col A. Writes ONLY Master_ID col D, one small
 * explicit range per correction, each read back before it counts as fixed.
 *
 * Never writes Contacts. Never writes Attio. Never mints. Never deletes.
 * Never touches a SUPERSEDED row.
 */

import { RANGES } from '../../config/constants.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import type { Logger } from '../../lib/logger.js';
import type { SlackPoster } from '../../lib/slack.js';
import { buildContactsIndex, computeResync, formatSlackMessage } from './resync.js';
import type { MasterIdRowLite, ResyncReport, ResyncWriteResult, RowCorrection } from './types.js';

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
    for (const c of plan.corrections) {
      writes.push(await writeCorrection(sheets, c, logger));
    }
    const verified = writes.filter((w) => w.verified).length;
    if (verified !== plan.corrections.length) {
      const w = `${plan.corrections.length - verified} correction(s) did not verify on read-back`;
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

/**
 * One correction, one small explicit range, read back before it counts.
 * `Master_ID!D{row}` — never a positional full-row write, which would carry
 * every other column along with it and overwrite anything edited since the read.
 */
async function writeCorrection(
  sheets: SheetsClient,
  c: RowCorrection,
  logger: Logger,
): Promise<ResyncWriteResult> {
  const range = `Master_ID!D${c.masterRow}:D${c.masterRow}`;
  try {
    await sheets.update(range, [[c.newRow]]);
    const back = await sheets.read(range);
    const got = Number.parseInt(cell(back[0] ?? [], 0), 10);
    const verified = got === c.newRow;
    logger.info(`    wrote ${range} = ${c.newRow} — read-back ${verified ? 'OK' : `MISMATCH (got ${cell(back[0] ?? [], 0)})`}`);
    return {
      correction: c, written: true, verified,
      detail: verified ? `${range} = ${c.newRow}` : `${range} read back as ${cell(back[0] ?? [], 0)}`,
    };
  } catch (e) {
    logger.warn(`    FAILED ${range}: ${String(e)}`);
    return { correction: c, written: false, verified: false, detail: String(e) };
  }
}
