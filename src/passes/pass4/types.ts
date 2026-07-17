import type { Tier, TouchMode, Track } from '../../config/constants.js';
import type { CivilDate } from '../../lib/dates.js';
import type { NameVerdict } from '../../lib/name-verify.js';

/** Why a contact's cadence write was withheld. `null` on the happy path. */
export type WithholdReason =
  | 'ATTIO_ID_MISMATCH'
  | 'NAME_MISMATCH'
  | 'NAME_UNVERIFIABLE'
  | 'MASTER_ID_DUPLICATE_POINTER'
  | 'FETCH_FAILED'
  | 'STAGE_OUT_OF_RANGE';

export interface CadenceRow {
  readonly recordId: string;
  readonly bhcId: string | null;
  readonly name: string | null;
  readonly masterName: string | null;
  readonly tier: Tier;
  /** True when no tier was found and DEFAULT_TIER was applied. */
  readonly tierDefaulted: boolean;

  readonly activeStageNum: number;
  readonly activeTrack: Track | null;
  readonly activeStageLabel: string | null;
  readonly cadenceDays: number;
  readonly touchMode: TouchMode;
  readonly reasonBase: string;
  readonly lastTouch: CivilDate | null;
  readonly nextCheckIn: CivilDate;
  readonly daysSince: number | null;
  readonly stalled: boolean;
  readonly followUpReason: string;
  readonly overdueCatchUp: boolean;

  readonly nameVerdict: NameVerdict | null;
  readonly attioBhcContactId: string | null;
  /** null = cleared to write. Non-null = withheld, with cause. */
  readonly withheld: WithholdReason | null;
  readonly notes: readonly string[];
}

export type WriteOutcome = 'WRITTEN' | 'VERIFIED_MISMATCH' | 'FAILED' | 'SKIPPED_DRY_RUN' | 'WITHHELD';

export interface WriteResult {
  readonly recordId: string;
  readonly name: string | null;
  readonly outcome: WriteOutcome;
  readonly error?: string;
  /** What a read-back actually returned, when it disagreed with what we sent. */
  readonly readBack?: string | null;
}

export interface Pass4Report {
  readonly runId: string;
  readonly today: CivilDate;
  readonly timezone: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;

  readonly pipelineEntryCount: number;
  readonly masterIdRowCount: number;
  readonly tierIndexSize: number;
  readonly tierHeaderTitle: string;

  readonly rows: readonly CadenceRow[];
  readonly writes: readonly WriteResult[];

  readonly counts: {
    readonly eligible: number;
    readonly withheld: number;
    readonly written: number;
    readonly failed: number;
    readonly verifiedMismatch: number;
    readonly stalled: number;
    readonly unmappedToMasterId: number;
    readonly tierDefaulted: number;
  };

  readonly warnings: readonly string[];
}
