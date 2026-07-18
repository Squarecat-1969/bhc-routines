import type { ThreadStagingRow } from '../pass1/types.js';

export interface Placeholder {
  readonly activityId: string;
  readonly contactId: string; // BHC_ID, known at placeholder-creation time
  readonly contactName: string;
  readonly timestamp: string; // Activity_Log col B, when Bobby opened the reply
  /** Extracted from "PENDING_CAPTURE thread:{Thread_ID}" in col P — '' if not present. */
  readonly threadIdFromNote: string;
  /** 1-based physical row in Activity_Log (data starts at row 2). */
  readonly sheetRow: number;
}

export type MatchVerdict = 'EXACT' | 'INFERRED' | 'AMBIGUOUS' | 'NO_MATCH';

export interface MatchResult {
  readonly placeholder: Placeholder;
  readonly verdict: MatchVerdict;
  /** The matched candidate for EXACT/INFERRED; the first ambiguous candidate for AMBIGUOUS (all in ambiguousCandidates). */
  readonly candidate: ThreadStagingRow | null;
  readonly ambiguousCandidates: readonly ThreadStagingRow[];
  readonly reason: string;
}

export interface ActivityLogWriteResult {
  readonly activityId: string;
  readonly sheetRow: number;
  readonly threadId: string;
}

export interface ReconciliationQueueEnqueue {
  readonly reconId: string;
  readonly placeholder: Placeholder;
  readonly candidate: ThreadStagingRow;
}

export interface Pass0Report {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly placeholderCount: number;
  readonly exactMatches: readonly ActivityLogWriteResult[];
  readonly inferredMatches: readonly ReconciliationQueueEnqueue[];
  readonly ambiguousCount: number;
  readonly noMatchCount: number;
  readonly stalePlaceholderCount: number;

  readonly warnings: readonly string[];
}
