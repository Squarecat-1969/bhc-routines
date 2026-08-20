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

/**
 * What actually happened to one correction — four states, not two booleans.
 *
 * The old shape collapsed "the write never landed" and "the write landed but I
 * could not confirm it" into the same `written: false, verified: false`, because
 * a single try/catch wrapped both the update and the read-back. On 2026-08-20
 * that reported four corrections as unwritten when three of them had in fact
 * landed — the 429 had hit their READ-back, not their write. The report implied
 * data loss that had not occurred, and the one genuine miss was hidden among
 * three false alarms.
 *
 * Never claim an outcome you cannot distinguish from a different one.
 */
export type ResyncWriteOutcome =
  /** Write issued and the read-back shows the expected value. */
  | 'VERIFIED'
  /** The write itself failed. Nothing landed — safe to retry. */
  | 'WRITE_FAILED'
  /** Write issued, read-back could not be performed. It probably landed; we
   *  cannot say so. NOT the same as a failure, and must never be reported as one. */
  | 'VERIFY_INCONCLUSIVE'
  /** Write issued, read-back shows a DIFFERENT value. A real problem — either
   *  the write silently did not take, or something overwrote it. */
  | 'MISMATCH';

export interface ResyncWriteResult {
  readonly correction: RowCorrection;
  readonly outcome: ResyncWriteOutcome;
  /** Did the write reach Sheets without erroring. True for VERIFY_INCONCLUSIVE —
   *  that is the entire point of the distinction. */
  readonly written: boolean;
  /** Did a read-back positively confirm the value. Only true for VERIFIED. */
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
