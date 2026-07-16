/**
 * PASS 4 — Attio Cadence Engine.
 *
 * Sweeps the Attio pipeline list, computes each contact's next check-in date,
 * touch mode, and follow-up reason, and writes those three fields back to their
 * Attio person record.
 *
 * Two safety properties hold regardless of mode:
 *   1. Nothing is written unless the record's identity is verified (bhc_contact_id
 *      cross-check + name gate). See `evaluateContact`.
 *   2. In dry-run, no request that mutates anything is issued at all.
 */

import {
  ATTIO_FETCH_BATCH_PAUSE_MS,
  ATTIO_FETCH_BATCH_SIZE,
  ATTIO_PIPELINE_LIST,
  DEFAULT_TIER,
  PERSON_SLUGS,
  PIPELINE_STAGE_SLUGS,
} from '../../config/constants.js';
import {
  AttioClient,
  dateOf,
  nameOf,
  selectTitleOf,
  textOf,
  type AttioPersonRecord,
  type AttioPipelineEntry,
} from '../../lib/attio.js';
import { todayIn, type CivilDate } from '../../lib/dates.js';
import { sleep } from '../../lib/http.js';
import type { Logger } from '../../lib/logger.js';
import { verifyName } from '../../lib/name-verify.js';
import type { SheetsClient } from '../../lib/sheets.js';
import { computeCadence } from './cadence.js';
import { loadMasterId, loadTierIndex, type MasterIdIndex, type TierIndex } from './load.js';
import type { CadenceRow, Pass4Report, WriteResult } from './types.js';

export interface Pass4Options {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly timezone: string;
  readonly attio: AttioClient;
  readonly sheets: SheetsClient;
  readonly logger: Logger;
  /** Cap the number of contacts processed — for a fast smoke test. */
  readonly limit?: number;
  readonly today?: CivilDate;
}

/**
 * Decide what a single pipeline contact's cadence should be, and whether we are
 * allowed to write it.
 *
 * Pure: takes already-fetched data, returns a row. All the gating logic lives
 * here so it can be tested without touching Attio.
 */
export function evaluateContact(args: {
  entry: AttioPipelineEntry;
  record: AttioPersonRecord | null;
  master: MasterIdIndex;
  tiers: TierIndex;
  today: CivilDate;
}): CadenceRow {
  const { entry, record, master, tiers, today } = args;
  const notes: string[] = [];

  const stages = {
    tnbStage: selectTitleOf(entry.entryValues, PIPELINE_STAGE_SLUGS.tnb),
    fractionalStage: selectTitleOf(entry.entryValues, PIPELINE_STAGE_SLUGS.fractional),
    fteStage: selectTitleOf(entry.entryValues, PIPELINE_STAGE_SLUGS.fte),
  };

  const masterEntry = master.byAttioRecordId.get(entry.recordId) ?? null;
  const bhcId = masterEntry?.bhcId ?? null;
  const masterName = masterEntry?.fullName ?? null;

  const tierFromIndex = bhcId ? tiers.byBhcId.get(bhcId) : undefined;
  const tier = tierFromIndex ?? DEFAULT_TIER;
  const tierDefaulted = tierFromIndex === undefined;

  const attioName = record ? nameOf(record.values, PERSON_SLUGS.name) : null;
  const attioBhcContactId = record ? textOf(record.values, PERSON_SLUGS.bhcContactId) : null;
  const lastTouch = record ? dateOf(record.values, PERSON_SLUGS.lastInteractionAt) : null;

  const cadence = computeCadence({ stages, tier, lastTouch, today });
  notes.push(...cadence.warnings);

  if (tierDefaulted && cadence.activeStageNum < 1) {
    notes.push(
      bhcId
        ? `no tier for ${bhcId} in Contacts; defaulted to ${DEFAULT_TIER}`
        : `record not mapped to a BHC_ID; defaulted to ${DEFAULT_TIER}`,
    );
  }

  const base = {
    recordId: entry.recordId,
    bhcId,
    name: attioName,
    masterName,
    tier,
    tierDefaulted,
    activeStageNum: cadence.activeStageNum,
    activeTrack: cadence.activeTrack,
    activeStageLabel: cadence.activeStageLabel,
    cadenceDays: cadence.cadenceDays,
    touchMode: cadence.touchMode,
    reasonBase: cadence.reasonBase,
    lastTouch,
    nextCheckIn: cadence.nextCheckIn,
    daysSince: cadence.daysSince,
    stalled: cadence.stalled,
    followUpReason: cadence.followUpReason,
    overdueCatchUp: cadence.overdueCatchUp,
    attioBhcContactId,
  };

  if (!record) {
    return { ...base, nameVerdict: null, withheld: 'FETCH_FAILED', notes };
  }

  // --- Identity gate -------------------------------------------------------
  // The write target is the record_id straight off the pipeline list, so the
  // record itself is not in doubt. What IS resolved through a pointer is the
  // Master_ID → tier lookup that feeds the computed value. A stale pointer
  // therefore writes a *plausible but wrong* cadence onto a real person — the
  // same failure class as June. So: verify before writing, always.

  if (master.duplicateAttioRecordIds.includes(entry.recordId)) {
    notes.push('multiple Master_ID rows point at this Attio record — pointer ambiguous');
    return { ...base, nameVerdict: null, withheld: 'MASTER_ID_DUPLICATE_POINTER', notes };
  }

  if (masterEntry) {
    if (attioBhcContactId && attioBhcContactId !== masterEntry.bhcId) {
      notes.push(
        `CADENCE_MISMATCH: Master_ID BHC_ID ${masterEntry.bhcId} points to Attio record ` +
          `${entry.recordId} whose bhc_contact_id is ${attioBhcContactId}`,
      );
      return { ...base, nameVerdict: null, withheld: 'ATTIO_ID_MISMATCH', notes };
    }

    const nameCheck = verifyName(attioName, masterEntry.fullName);
    if (nameCheck.verdict === 'MISMATCH') {
      notes.push(
        `CADENCE-NAME-MISMATCH: Attio shows "${attioName}", Master_ID shows ` +
          `"${masterEntry.fullName}" (${bhcId}). Pointer may reference wrong person — ` +
          `manual review required.`,
      );
      return { ...base, nameVerdict: nameCheck.verdict, withheld: 'NAME_MISMATCH', notes };
    }
    if (nameCheck.verdict === 'UNVERIFIABLE') {
      notes.push(`${nameCheck.reason} — withheld pending manual review`);
      return { ...base, nameVerdict: nameCheck.verdict, withheld: 'NAME_UNVERIFIABLE', notes };
    }
    return { ...base, nameVerdict: nameCheck.verdict, withheld: null, notes };
  }

  // No Master_ID mapping at all: no pointer was resolved, so there is nothing to
  // verify against and no tier was borrowed from another identity. The spec's 4d
  // default ("Strategic") covers this, so we proceed — but it is reported.
  notes.push('no Master_ID row maps this Attio record — cadence computed with default tier');
  return { ...base, nameVerdict: null, withheld: null, notes };
}

async function fetchRecords(
  attio: AttioClient,
  entries: readonly AttioPipelineEntry[],
  logger: Logger,
): Promise<Map<string, AttioPersonRecord | null>> {
  const out = new Map<string, AttioPersonRecord | null>();
  const ids = entries.map((e) => e.recordId);

  for (let i = 0; i < ids.length; i += ATTIO_FETCH_BATCH_SIZE) {
    const batch = ids.slice(i, i + ATTIO_FETCH_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((id) => attio.getPersonRecord(id)));

    settled.forEach((res, j) => {
      const id = batch[j]!;
      if (res.status === 'fulfilled') {
        out.set(id, res.value);
      } else {
        out.set(id, null);
        logger.warn(`Attio fetch failed for ${id}: ${String(res.reason)}`);
      }
    });

    const done = Math.min(i + ATTIO_FETCH_BATCH_SIZE, ids.length);
    logger.info(`  fetched ${done}/${ids.length} person records`);
    if (done < ids.length) await sleep(ATTIO_FETCH_BATCH_PAUSE_MS);
  }

  return out;
}

async function writeCadence(
  attio: AttioClient,
  row: CadenceRow,
  logger: Logger,
): Promise<WriteResult> {
  const values = {
    [PERSON_SLUGS.nextCheckInDate]: row.nextCheckIn,
    [PERSON_SLUGS.nextTouchModePlanned]: row.touchMode,
    [PERSON_SLUGS.followUpReason]: row.followUpReason,
  };

  try {
    await attio.updatePersonRecord(row.recordId, values);

    // QA read-back (spec 4e): a 200 is not proof the value landed.
    const after = await attio.getPersonRecord(row.recordId);
    const readBack = dateOf(after.values, PERSON_SLUGS.nextCheckInDate);
    if (readBack !== row.nextCheckIn) {
      logger.warn(
        `Read-back mismatch for ${row.name ?? row.recordId}: expected ${row.nextCheckIn}, got ${readBack ?? 'null'}`,
      );
      return { recordId: row.recordId, name: row.name, outcome: 'VERIFIED_MISMATCH', readBack };
    }
    return { recordId: row.recordId, name: row.name, outcome: 'WRITTEN' };
  } catch (error) {
    // Spec Non-negotiable #12: one bad write never aborts the pass.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Write failed for ${row.name ?? row.recordId}: ${message}`);
    return { recordId: row.recordId, name: row.name, outcome: 'FAILED', error: message };
  }
}

export async function runPass4(opts: Pass4Options): Promise<Pass4Report> {
  const { attio, sheets, logger, dryRun, runId, timezone } = opts;
  const startedAt = new Date().toISOString();
  const today = opts.today ?? todayIn(timezone);
  const warnings: string[] = [];

  logger.info(`PASS 4 — Attio Cadence Engine`);
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes to Attio)'}`);
  logger.info(`  today  : ${today} (${timezone})`);

  // 4b — Sheets side: pointers + tiers.
  logger.info('4b — loading Master_ID and tier index');
  const [master, tiers] = await Promise.all([loadMasterId(sheets), loadTierIndex(sheets)]);
  logger.info(`  Master_ID rows      : ${master.rowCount}`);
  logger.info(`  tier index entries  : ${tiers.byBhcId.size} (from "${tiers.headerTitle}")`);
  if (master.duplicateAttioRecordIds.length > 0) {
    const w = `${master.duplicateAttioRecordIds.length} Attio record ID(s) appear on multiple Master_ID rows — those contacts are withheld`;
    warnings.push(w);
    logger.warn(`  ${w}`);
  }

  // 4a — pipeline entries.
  logger.info('4a — loading Attio pipeline entries');
  let entries = await attio.listEntries(ATTIO_PIPELINE_LIST);
  logger.info(`  pipeline entries    : ${entries.length} (spec expects ~44)`);
  if (entries.length === 0) {
    warnings.push('Attio pipeline list returned 0 entries — check the list ID or the API key scope');
  }
  if (opts.limit !== undefined && opts.limit < entries.length) {
    logger.info(`  --limit ${opts.limit} applied (of ${entries.length})`);
    entries = entries.slice(0, opts.limit);
  }

  // 4c — person records.
  logger.info('4c — fetching person records');
  const records = await fetchRecords(attio, entries, logger);

  // 4d — compute + gate.
  logger.info('4d — computing cadence');
  const rows = entries.map((entry) =>
    evaluateContact({ entry, record: records.get(entry.recordId) ?? null, master, tiers, today }),
  );

  // 4e — write.
  const eligible = rows.filter((r) => r.withheld === null);
  const withheldRows = rows.filter((r) => r.withheld !== null);
  const writes: WriteResult[] = withheldRows.map((r) => ({
    recordId: r.recordId,
    name: r.name,
    outcome: 'WITHHELD' as const,
  }));

  if (dryRun) {
    logger.info(`4e — DRY RUN: ${eligible.length} write(s) computed, 0 issued`);
    for (const r of eligible) {
      writes.push({ recordId: r.recordId, name: r.name, outcome: 'SKIPPED_DRY_RUN' });
    }
  } else {
    logger.info(`4e — writing cadence to Attio for ${eligible.length} contact(s)`);
    for (const [i, row] of eligible.entries()) {
      writes.push(await writeCadence(attio, row, logger));
      if ((i + 1) % ATTIO_FETCH_BATCH_SIZE === 0 && i + 1 < eligible.length) {
        await sleep(ATTIO_FETCH_BATCH_PAUSE_MS);
      }
    }
  }

  const counts = {
    eligible: eligible.length,
    withheld: withheldRows.length,
    written: writes.filter((w) => w.outcome === 'WRITTEN').length,
    failed: writes.filter((w) => w.outcome === 'FAILED').length,
    verifiedMismatch: writes.filter((w) => w.outcome === 'VERIFIED_MISMATCH').length,
    stalled: rows.filter((r) => r.stalled).length,
    unmappedToMasterId: rows.filter((r) => r.bhcId === null).length,
    tierDefaulted: rows.filter((r) => r.tierDefaulted).length,
  };

  if (!dryRun && counts.written === 0 && rows.length > 0) {
    warnings.push('0 contacts written — check the Attio pipeline list or the API key scope');
  }

  return {
    runId,
    today,
    timezone,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    pipelineEntryCount: entries.length,
    masterIdRowCount: master.rowCount,
    tierIndexSize: tiers.byBhcId.size,
    tierHeaderTitle: tiers.headerTitle,
    rows,
    writes,
    counts,
    warnings,
  };
}
