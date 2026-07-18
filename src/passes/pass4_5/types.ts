import type { Tier, Track, TouchMode } from '../../config/constants.js';
import type { CivilDate } from '../../lib/dates.js';

/** Why a target was withheld from the cache write (spec 4.5d + fetch failures). */
export type Pass45WithholdReason = 'ID_MISMATCH' | 'UNRESOLVED';

export interface CacheTarget {
  readonly bhcId: string;
  readonly fullName: string;
  readonly location: 'ATTIO' | 'BOTH' | string;
  readonly googleRow: number | null;
  readonly attioRecordId: string;
  readonly masterRow: number;
}

/** One row of the 18-column Pipeline_Cache write (spec 4.5e). */
export interface CacheRow {
  readonly bhcId: string;
  readonly attioRecordId: string;
  readonly name: string | null;
  readonly title: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly linkedinUrl: string | null;
  readonly relationshipTier: Tier | null;
  readonly linkedinSegment: string | null;
  readonly attioSegment: string;
  readonly track: Track | null;
  readonly stage: string | null;
  readonly nextCheckInDate: CivilDate | null;
  readonly nextTouchModePlanned: TouchMode | null;
  readonly followUpReason: string | null;
  readonly pipelineStale: boolean;
  readonly runId: string;
  readonly generatedAt: string;
}

export interface WithheldTarget {
  readonly bhcId: string;
  readonly name: string | null;
  readonly reason: Pass45WithholdReason;
  readonly notes: string;
}

export type NameDriftVerdict = 'EXACT' | 'CANDIDATE' | 'LEAVE_FOR_RECONCILER';

export interface NameConflictEnqueue {
  readonly bhcId: string;
  readonly masterRow: number;
  readonly attioRecordId: string;
  readonly oldName: string;
  readonly newName: string;
}

export interface Pass45Report {
  readonly runId: string;
  readonly today: CivilDate;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;

  /** True only when 4.5.0's tab guard found Pipeline_Cache missing — pass skipped entirely. */
  readonly skippedTabAbsent: boolean;
  /** True when an unexpected exception aborted the pass (spec 4.5f: log, stop, never re-raise). */
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly targetCount: number;
  readonly rows: readonly CacheRow[];
  readonly withheld: readonly WithheldTarget[];
  readonly mismatchCount: number;
  readonly unresolvedCount: number;
  readonly pipelineCount: number;
  readonly liteCount: number;

  readonly nameConflictsEnqueued: readonly NameConflictEnqueue[];

  readonly warnings: readonly string[];
}
