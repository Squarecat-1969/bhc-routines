/**
 * Pure PASS 4.5 cache-row logic — no I/O, so it's testable without credentials.
 */

import { ATTIO_SEGMENT_HARDCODE } from '../../config/constants.js';
import type { Tier, Track, TouchMode } from '../../config/constants.js';
import { isBefore, type CivilDate } from '../../lib/dates.js';
import type { CacheRow } from './types.js';

/** Spec 4.5e: Pipeline_Stale = bool(next_check_in_date and to_date(next_check_in_date) < TODAY). */
export function computePipelineStale(nextCheckInDate: CivilDate | null, today: CivilDate): boolean {
  if (nextCheckInDate === null) return false;
  return isBefore(nextCheckInDate, today);
}

export interface BuildCacheRowInput {
  readonly bhcId: string;
  readonly attioRecordId: string;
  readonly name: string | null;
  readonly title: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly linkedinUrl: string | null;
  readonly relationshipTier: Tier | null;
  readonly linkedinSegment: string | null;
  readonly track: Track | null;
  readonly stage: string | null;
  readonly nextCheckInDate: CivilDate | null;
  readonly nextTouchModePlanned: TouchMode | null;
  readonly followUpReason: string | null;
  readonly today: CivilDate;
  readonly runId: string;
  readonly generatedAt: string;
}

export function buildCacheRow(input: BuildCacheRowInput): CacheRow {
  return {
    bhcId: input.bhcId,
    attioRecordId: input.attioRecordId,
    name: input.name,
    title: input.title,
    companyName: input.companyName,
    email: input.email,
    linkedinUrl: input.linkedinUrl,
    relationshipTier: input.relationshipTier,
    linkedinSegment: input.linkedinSegment,
    attioSegment: ATTIO_SEGMENT_HARDCODE, // spec 4.5b: hardcode "S1", never derived
    track: input.track,
    stage: input.stage,
    nextCheckInDate: input.nextCheckInDate,
    nextTouchModePlanned: input.nextTouchModePlanned,
    followUpReason: input.followUpReason,
    pipelineStale: computePipelineStale(input.nextCheckInDate, input.today),
    runId: input.runId,
    generatedAt: input.generatedAt,
  };
}

/** Row → the 18-column A1 array in Pipeline_Cache's exact column order (spec 4.5e). */
export function cacheRowToSheetRow(row: CacheRow): readonly unknown[] {
  return [
    row.bhcId,
    row.attioRecordId,
    row.name ?? '',
    row.title ?? '',
    row.companyName ?? '',
    row.email ?? '',
    row.linkedinUrl ?? '',
    row.relationshipTier ?? '',
    row.linkedinSegment ?? '',
    row.attioSegment,
    row.track ?? '',
    row.stage ?? '',
    row.nextCheckInDate ?? '',
    row.nextTouchModePlanned ?? '',
    row.followUpReason ?? '',
    row.pipelineStale,
    row.runId,
    row.generatedAt,
  ];
}
