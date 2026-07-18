/**
 * PASS 4.5 — Pipeline Cache.
 *
 * Full nightly rewrite of the derived Pipeline_Cache tab (~2,213 records) so
 * Aida's Contacts page reads cached data instead of hydrating Attio live on
 * every load. Also enqueues ATTIO-only name-drift candidates to Name_Conflicts
 * (never writes a name itself — that's always a human decision via the review
 * card). Runs after PASS 4, before PASS 5 (spec).
 *
 * Two safety properties, matching PASS 4's:
 *   1. The 4.5d identity cross-check is mandatory — no row whose Attio
 *      bhc_contact_id disagrees with its Master_ID BHC_ID is ever cached.
 *   2. 4.5f: any exception inside this pass is caught, logged, and the pass
 *      stops WITHOUT re-raising — a bad PASS 4.5 run must never block PASS 5.
 *      That's why this whole function is wrapped in a top-level try/catch
 *      rather than letting the caller handle it.
 */

import {
  ATTIO_FETCH_BATCH_PAUSE_MS,
  ATTIO_FETCH_BATCH_SIZE,
  ATTIO_PIPELINE_LIST,
  PERSON_SLUGS,
  RANGES,
} from '../../config/constants.js';
import {
  AttioClient,
  dateOf,
  emailOf,
  fetchPersonRecordsBatched,
  nameOf,
  selectTitleOf,
  textOf,
  type AttioPipelineEntry,
} from '../../lib/attio.js';
import { cell, type SheetsClient } from '../../lib/sheets.js';
import { todayIn, type CivilDate } from '../../lib/dates.js';
import type { Logger } from '../../lib/logger.js';
import { makeRunId } from '../../config/constants.js';
import { loadMasterId, type MasterIdEntry } from '../pass4/load.js';
import { normalizeTier, resolveActiveStage } from '../pass4/cadence.js';
import { loadContactsWide } from './contacts.js';
import { buildCacheRow, cacheRowToSheetRow } from './cache.js';
import { classifyNameDrift, shouldEnqueue, type ExistingNameConflictRow } from './name-conflicts.js';
import type { CacheRow, NameConflictEnqueue, Pass45Report, WithheldTarget } from './types.js';
import type { Track } from '../../config/constants.js';
import { TOUCH_MODES, type TouchMode } from '../../config/constants.js';

/** Narrow a raw Attio select string to TouchMode, or null if it's not a recognized value. */
function parseTouchMode(raw: string | null): TouchMode | null {
  if (raw === null) return null;
  return (TOUCH_MODES as readonly string[]).includes(raw) ? (raw as TouchMode) : null;
}

export interface Pass45Options {
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly timezone: string;
  readonly attio: AttioClient;
  readonly sheets: SheetsClient;
  readonly logger: Logger;
  readonly today?: CivilDate;
  /** Cap the number of targets processed — for a fast smoke test. Not in spec. */
  readonly limit?: number;
  /**
   * Override the 4.5b fetch batch size / pause. Not in spec (which assumes a
   * true bulk endpoint — see docs/pass4_5-notes.md #1). Defaults to PASS 4's
   * proven values; raise these once a dry run confirms headroom (zero
   * failures/retries at the current setting).
   */
  readonly fetchBatchSize?: number;
  readonly fetchPauseMs?: number;
  /** Reuse PASS 4's already-fetched pipeline entries instead of re-fetching (spec 4.5c). */
  readonly pipelineEntries?: readonly AttioPipelineEntry[];
}

function emptyReport(partial: {
  runId: string;
  today: CivilDate;
  dryRun: boolean;
  startedAt: string;
  skippedTabAbsent?: boolean;
  aborted?: boolean;
  abortReason?: string | null;
  warnings?: readonly string[];
}): Pass45Report {
  return {
    runId: partial.runId,
    today: partial.today,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    finishedAt: new Date().toISOString(),
    skippedTabAbsent: partial.skippedTabAbsent ?? false,
    aborted: partial.aborted ?? false,
    abortReason: partial.abortReason ?? null,
    targetCount: 0,
    rows: [],
    withheld: [],
    mismatchCount: 0,
    unresolvedCount: 0,
    pipelineCount: 0,
    liteCount: 0,
    nameConflictsEnqueued: [],
    warnings: partial.warnings ?? [],
  };
}

/** Entry point. Never throws — spec 4.5f: log, stop, don't re-raise, don't block PASS 5. */
export async function runPass45(opts: Pass45Options): Promise<Pass45Report> {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? makeRunId();
  const today = opts.today ?? todayIn(opts.timezone);
  const { logger } = opts;

  try {
    return await runPass45Inner({ ...opts, runId, today, startedAt });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logger.warn(`PASS 4.5 aborted: ${message}`);
    return emptyReport({ runId, today, dryRun: opts.dryRun, startedAt, aborted: true, abortReason: message });
  }
}

async function runPass45Inner(
  opts: Pass45Options & { runId: string; today: CivilDate; startedAt: string },
): Promise<Pass45Report> {
  const { attio, sheets, logger, dryRun, runId, today, startedAt } = opts;
  const warnings: string[] = [];

  logger.info('PASS 4.5 — Pipeline Cache');
  logger.info(`  run_id : ${runId}`);
  logger.info(`  mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes to Sheets)'}`);
  logger.info(`  today  : ${today} (UTC)`);

  // 4.5.0 — Tab guard. Any error reading the header is treated as "tab absent"
  // per the spec's literal wording; we never create the tab from here.
  logger.info('4.5.0 — checking Pipeline_Cache tab exists');
  try {
    await sheets.read(RANGES.pipelineCacheHeader, 'FORMATTED_VALUE');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`  Pipeline_Cache tab absent or unreadable — skipping PASS 4.5: ${message}`);
    return emptyReport({ runId, today, dryRun, startedAt, skippedTabAbsent: true });
  }

  // 4.5a — targets from Master_ID.
  logger.info('4.5a — collecting targets from Master_ID');
  const master = await loadMasterId(sheets);
  let targets = [...master.byBhcId.values()].filter(
    (e) => (e.location === 'ATTIO' || e.location === 'BOTH') && e.attioRecordId !== '',
  );
  logger.info(`  targets: ${targets.length} (Location ATTIO/BOTH with a populated Attio_Record_ID)`);
  if (opts.limit !== undefined && opts.limit < targets.length) {
    logger.info(`  --limit ${opts.limit} applied (of ${targets.length})`);
    targets = targets.slice(0, opts.limit);
  }

  // Contacts wide read (tier + email + segment), once, for the BOTH-location derivations.
  const contactsWide = await loadContactsWide(sheets, logger);

  // 4.5b — bulk-fetch identity from Attio, batched.
  logger.info('4.5b — fetching person records (batched)');
  const batchSize = opts.fetchBatchSize ?? ATTIO_FETCH_BATCH_SIZE;
  const pauseMs = opts.fetchPauseMs ?? ATTIO_FETCH_BATCH_PAUSE_MS;
  logger.info(`  batch size ${batchSize}, pause ${pauseMs}ms between batches`);
  const records = await fetchPersonRecordsBatched(
    attio,
    targets.map((t) => t.attioRecordId),
    {
      batchSize,
      pauseMs,
      onProgress: (done, total) => logger.info(`  fetched ${done}/${total} person records`),
      onFailure: (id, error) => logger.warn(`  Attio fetch failed for ${id}: ${String(error)}`),
    },
  );

  // 4.5c — pipeline entries for Track/Stage (reuse PASS 4's if provided, else fetch).
  logger.info('4.5c — resolving pipeline Track/Stage');
  const pipelineEntries = opts.pipelineEntries ?? (await attio.listEntries(ATTIO_PIPELINE_LIST));
  const stageByRecordId = new Map<string, { track: Track; stage: string }>();
  for (const entry of pipelineEntries) {
    const stages = {
      tnbStage: selectTitleOf(entry.entryValues, 'tnb_stage'),
      fractionalStage: selectTitleOf(entry.entryValues, 'fractional_stage'),
      fteStage: selectTitleOf(entry.entryValues, 'fte_stage'),
    };
    const active = resolveActiveStage(stages);
    if (active.activeTrack && active.activeStageLabel) {
      stageByRecordId.set(entry.recordId, { track: active.activeTrack, stage: active.activeStageLabel });
    }
  }
  logger.info(`  ${stageByRecordId.size} record(s) carry an active Track/Stage`);

  // 4.5d — identity gate + row building.
  logger.info('4.5d — identity cross-check + building cache rows');
  const rows: CacheRow[] = [];
  const withheld: WithheldTarget[] = [];
  let mismatchCount = 0;
  let unresolvedCount = 0;
  const nameConflictCandidates: NameConflictEnqueue[] = [];
  const generatedAt = new Date().toISOString();

  for (const target of targets) {
    const record = records.get(target.attioRecordId) ?? null;

    if (!record) {
      unresolvedCount += 1;
      withheld.push({
        bhcId: target.bhcId,
        name: target.fullName || null,
        reason: 'UNRESOLVED',
        notes: `Attio fetch failed for ${target.attioRecordId} after retries`,
      });
      continue;
    }

    const attioBhcContactId = textOf(record.values, PERSON_SLUGS.bhcContactId);
    if (attioBhcContactId !== target.bhcId) {
      mismatchCount += 1;
      const note =
        `PIPELINE_CACHE_MISMATCH: Master_ID BHC_ID ${target.bhcId} points to Attio record ` +
        `${target.attioRecordId} whose bhc_contact_id is ${attioBhcContactId ?? 'null'}`;
      logger.warn(`  ${note}`);
      withheld.push({ bhcId: target.bhcId, name: target.fullName || null, reason: 'ID_MISMATCH', notes: note });
      continue;
    }

    const attioName = nameOf(record.values, PERSON_SLUGS.name);
    const googleSide = target.googleRow !== null ? contactsWide.byGoogleRow.get(target.googleRow) : undefined;

    // F Email: ATTIO-only -> Attio primary; BOTH -> Google Primary_Email.
    const email = target.location === 'BOTH' ? (googleSide?.primaryEmail ?? null) : emailOf(record.values, PERSON_SLUGS.emailAddresses);
    // I LinkedIn_Segment: BOTH -> Google Effective_Segment; ATTIO-only -> blank.
    const linkedinSegment = target.location === 'BOTH' ? (googleSide?.effectiveSegment ?? null) : null;
    // H Relationship_Tier: Google tier (tier_index, spec's PASS 4b reuse) if
    // present, else the fetched Attio relationship_tier — ATTIO-only rows have
    // no Google tier at all. Attio's select value is normalized the same way
    // any other tier value is (normalizeTier), so an unrecognized Attio option
    // doesn't silently become an untyped string in the cache.
    const attioTierRaw = selectTitleOf(record.values, PERSON_SLUGS.relationshipTier);
    const relationshipTier = googleSide?.tier ?? (attioTierRaw !== null ? normalizeTier(attioTierRaw) : null);

    const stageInfo = stageByRecordId.get(target.attioRecordId) ?? null;

    const row = buildCacheRow({
      bhcId: target.bhcId,
      attioRecordId: target.attioRecordId,
      name: attioName,
      title: textOf(record.values, PERSON_SLUGS.jobTitle),
      companyName: textOf(record.values, PERSON_SLUGS.companyName),
      email,
      linkedinUrl: textOf(record.values, PERSON_SLUGS.linkedin),
      relationshipTier,
      linkedinSegment,
      track: stageInfo?.track ?? null,
      stage: stageInfo?.stage ?? null,
      nextCheckInDate: dateOf(record.values, PERSON_SLUGS.nextCheckInDate),
      nextTouchModePlanned: parseTouchMode(selectTitleOf(record.values, PERSON_SLUGS.nextTouchModePlanned)),
      followUpReason: textOf(record.values, PERSON_SLUGS.followUpReason),
      today,
      runId,
      generatedAt,
    });
    rows.push(row);

    // 4.5h — ATTIO-only name-drift candidates only (BOTH drift is Reconciler I1's job).
    if (target.location === 'ATTIO' && attioName) {
      const verdict = classifyNameDrift(target.fullName, attioName);
      if (verdict === 'CANDIDATE') {
        nameConflictCandidates.push({
          bhcId: target.bhcId,
          masterRow: target.masterRow,
          attioRecordId: target.attioRecordId,
          oldName: target.fullName,
          newName: attioName,
        });
      }
    }
  }

  const pipelineCount = rows.filter((r) => r.track !== null).length;
  const liteCount = rows.length - pipelineCount;

  // 4.5e — write the cache (full rewrite). Blanking trailing rows must happen
  // even when rows.length is 0 (every target withheld this run) — otherwise a
  // bad run would leave a stale prior cache in place instead of clearing it,
  // contradicting "full rewrite each night."
  logger.info(`4.5e — ${dryRun ? 'DRY RUN: would write' : 'writing'} ${rows.length} cache row(s)`);
  if (!dryRun) {
    const priorIds = await sheets.read(RANGES.pipelineCachePriorIds);
    const priorLastRow = 1 + priorIds.length; // A2:A read; row 1 is header
    const newLastRow = 1 + rows.length; // spec's "1+N"; N=0 -> newLastRow=1 (no data rows)

    if (rows.length > 0) {
      await sheets.update(
        `Pipeline_Cache!A2:R${newLastRow}`,
        rows.map((r) => cacheRowToSheetRow(r)),
      );
    }

    if (priorLastRow > newLastRow) {
      const blankRow = new Array(18).fill('');
      const blankCount = priorLastRow - newLastRow;
      const blankRows = Array.from({ length: blankCount }, () => blankRow);
      await sheets.update(`Pipeline_Cache!A${newLastRow + 1}:R${priorLastRow}`, blankRows);
      logger.info(`  blanked ${blankCount} trailing row(s) from the previous run`);
    }
  }

  // 4.5h — enqueue, after suppression check against existing Name_Conflicts.
  const enqueued: NameConflictEnqueue[] = [];
  if (nameConflictCandidates.length > 0) {
    logger.info(`4.5h — checking ${nameConflictCandidates.length} name-drift candidate(s) against Name_Conflicts`);
    const existingRaw = await sheets.read(RANGES.nameConflictsAll);
    const existing: ExistingNameConflictRow[] = existingRaw.map((r) => ({
      bhcId: cell(r, 3),
      oldName: cell(r, 5),
      newName: cell(r, 6),
      status: cell(r, 10),
    }));

    let seq = 0;
    for (const candidate of nameConflictCandidates) {
      if (
        !shouldEnqueue(
          { bhcId: candidate.bhcId, oldName: candidate.oldName, newName: candidate.newName },
          existing,
        )
      ) {
        continue;
      }
      enqueued.push(candidate);
      if (!dryRun) {
        seq += 1;
        const conflictId = `NC-${Date.now()}-${seq}`;
        await sheets.append(RANGES.nameConflictsAppend, [
          [
            conflictId,
            runId,
            'LATE-EDITION',
            candidate.bhcId,
            'ATTIO',
            candidate.oldName,
            candidate.newName,
            'Master_ID',
            'Attio',
            JSON.stringify({ attio_record_id: candidate.attioRecordId, master_row: candidate.masterRow }),
            '',
            new Date().toISOString(),
            'ATTIO-only name drift (PASS 4.5)',
          ],
        ]);
      }
    }
    logger.info(`  ${enqueued.length} enqueued (of ${nameConflictCandidates.length} candidate(s))`);
  }

  if (rows.length === 0 && targets.length > 0) {
    warnings.push('0 cache rows written despite having targets — check identity gate / fetch results above');
  }

  return {
    runId,
    today,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    skippedTabAbsent: false,
    aborted: false,
    abortReason: null,
    targetCount: targets.length,
    rows,
    withheld,
    mismatchCount,
    unresolvedCount,
    pipelineCount,
    liteCount,
    nameConflictsEnqueued: enqueued,
    warnings,
  };
}

export type { MasterIdEntry };
