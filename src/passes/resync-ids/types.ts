/** One Master_ID row, as far as Resync IDs cares about it. */
export interface MasterIdRowLite {
  readonly bhcId: string;
  /** Raw Location, uppercased. GOOGLE / ATTIO / BOTH / SUPERSEDED. */
  readonly location: string;
  /** Currently stored Google_Row (col D), or null when blank/unparseable. */
  readonly storedGoogleRow: number | null;
  /** 1-based physical row in Master_ID — the only row authority for the write. */
  readonly masterRow: number;
}

export interface RowCorrection {
  readonly bhcId: string;
  readonly masterRow: number;
  readonly oldRow: number | null;
  readonly newRow: number;
}

export type UnresolvableReason = 'not_in_contacts' | 'duplicate_in_contacts';

export interface Unresolvable {
  readonly bhcId: string;
  readonly masterRow: number;
  readonly storedGoogleRow: number | null;
  readonly reason: UnresolvableReason;
  readonly detail: string;
}

export interface ResyncPlan {
  /** GOOGLE/BOTH rows actually examined. */
  readonly checked: number;
  readonly corrections: readonly RowCorrection[];
  /** Already pointing at the right row — deliberately NOT written. */
  readonly alreadyCorrect: number;
  readonly unresolvable: readonly Unresolvable[];
  readonly skippedSuperseded: number;
  readonly skippedNotGoogle: number;
  readonly skippedGapRows: number;
}

export interface ResyncWriteResult {
  readonly correction: RowCorrection;
  readonly written: boolean;
  readonly verified: boolean;
  readonly detail: string;
}

export interface ResyncReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly masterIdRowsRead: number;
  readonly contactsRowsRead: number;
  readonly plan: ResyncPlan;
  readonly writes: readonly ResyncWriteResult[];
  readonly warnings: readonly string[];
}
