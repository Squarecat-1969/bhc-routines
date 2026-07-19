/**
 * Spec 5b. Reuses PASS 4's already-tested `stageNum` and `CadenceRow`
 * (the overall per-contact cadence — winning track, stalled flag, next
 * check-in) rather than recomputing cadence. The one thing not carried by
 * `CadenceRow` is *per-track* stage membership (a contact can hold a stage
 * in more than one track even though `evaluateContact` only resolves a
 * single "winning" track for its own cadence math) — that's rebuilt here
 * directly from each pipeline entry's three raw stage strings.
 */

import { PIPELINE_STAGE_SLUGS } from '../../config/constants.js';
import { selectTitleOf, type AttioPipelineEntry } from '../../lib/attio.js';
import { isSameOrBefore, type CivilDate } from '../../lib/dates.js';
import { stageNum } from '../pass4/cadence.js';
import type { CadenceRow, MissionStatus, TrackMissionStatus } from './types.js';

export interface PipelineEntryStages {
  readonly recordId: string;
  readonly tnbStage: string | null;
  readonly fractionalStage: string | null;
  readonly fteStage: string | null;
}

export function deriveEntryStages(entry: AttioPipelineEntry): PipelineEntryStages {
  return {
    recordId: entry.recordId,
    tnbStage: selectTitleOf(entry.entryValues, PIPELINE_STAGE_SLUGS.tnb),
    fractionalStage: selectTitleOf(entry.entryValues, PIPELINE_STAGE_SLUGS.fractional),
    fteStage: selectTitleOf(entry.entryValues, PIPELINE_STAGE_SLUGS.fte),
  };
}

type TrackKey = 'tnbStage' | 'fractionalStage' | 'fteStage';

function trackEntryIds(entries: readonly PipelineEntryStages[], trackKey: TrackKey): ReadonlySet<string> {
  return new Set(entries.filter((e) => stageNum(e[trackKey]) >= 1).map((e) => e.recordId));
}

function computeTrackStatus(
  entries: readonly PipelineEntryStages[],
  cadenceResults: readonly CadenceRow[],
  trackKey: TrackKey,
  today: CivilDate,
  includeDaysSinceTouch: boolean,
): TrackMissionStatus {
  const activeIds = trackEntryIds(entries, trackKey);
  const actives = cadenceResults.filter((r) => activeIds.has(r.recordId));
  const stalled = actives.filter((r) => r.stalled).length;

  let nextTouch: string | null = null;
  if (actives.length > 0) {
    const overdue = actives.filter((r) => isSameOrBefore(r.nextCheckIn, today));
    const pool = overdue.length > 0 ? overdue : actives;
    const soonest = [...pool].sort((a, b) => (a.nextCheckIn < b.nextCheckIn ? -1 : a.nextCheckIn > b.nextCheckIn ? 1 : 0))[0]!;
    nextTouch = soonest.name ?? soonest.masterName ?? soonest.bhcId ?? soonest.recordId;
  }

  const status: TrackMissionStatus = { active: activeIds.size, stalled, nextTouch };
  if (!includeDaysSinceTouch) return status;

  const withDays = actives.filter((r) => r.daysSince !== null);
  const daysSinceTouch = withDays.length > 0 ? Math.max(...withDays.map((r) => r.daysSince!)) : null;
  return { ...status, daysSinceTouch };
}

export function computeMissionStatus(
  entries: readonly PipelineEntryStages[],
  cadenceResults: readonly CadenceRow[],
  today: CivilDate,
): MissionStatus {
  return {
    tnb: computeTrackStatus(entries, cadenceResults, 'tnbStage', today, false),
    fte: computeTrackStatus(entries, cadenceResults, 'fteStage', today, true), // spec: only FTE gets daysSinceTouch
    fractional: computeTrackStatus(entries, cadenceResults, 'fractionalStage', today, false),
  };
}
