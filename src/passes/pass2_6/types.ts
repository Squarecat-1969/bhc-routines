import type { SafeCalendarEvent } from '../../lib/calendar.js';
import type { ExtractedParticipants } from './attendees.js';
import type { ResolutionPath } from './identity.js';

/**
 * Verdicts, per the governing spec's §8 as settled 2026-08-31.
 *
 * ⚠ NO_EVIDENCE and UNEVALUABLE are NOT two strengths of the same claim. One
 * says the sources looked and found nothing; the other says the question could
 * not be asked. They imply different actions and must never share a label —
 * that conflation is the whole reason §8 was reopened.
 */
export const CALENDAR_VERDICTS = ['LIKELY_HANDLED_EVIDENCE', 'NO_EVIDENCE', 'UNEVALUABLE'] as const;
export type CalendarVerdict = (typeof CALENDAR_VERDICTS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** An event that survived the filter, with its participants already extracted and the body gone. */
export interface CandidateEvent {
  readonly event: SafeCalendarEvent;
  readonly participants: ExtractedParticipants;
  /** BHC_IDs resolved from addresses (strong) and from the subject (conservative). */
  readonly byAddress: readonly string[];
  readonly bySubject: readonly string[];
}

/**
 * "Schedule a call with X" versus "Discuss X with Y" — the distinction changes
 * what a calendar entry PROVES, not merely how confident to be.
 *
 * ⚠ A SCHEDULED MEETING IS NOT A HELD MEETING. It can be cancelled, no-showed
 * or moved. For a scheduling task the booking IS the completion; for a
 * discussion task the meeting must have happened, and a calendar entry is a
 * hint rather than proof.
 */
export type TaskKind = 'scheduling' | 'discussion';

export interface CalendarReconciliationResult {
  readonly taskId: string;
  readonly source: 'sheet' | 'attio';
  readonly bhcId: string;
  readonly contactName: string;
  readonly description: string;
  readonly taskKind: TaskKind;
  readonly verdict: CalendarVerdict;
  /** ⚠ SUBJECT AND DATE ONLY. Never body text — see the build brief §2. */
  readonly evidenceQuote: string;
  readonly proposedCompletionDate: string;
  readonly confidence: ConfidenceLevel | '';
  readonly brainReasoning: string;
  /** Latest event start considered for this task — the watermark's col E. */
  readonly lastEventSeen: string;
}

export interface Pass26Report {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aborted: boolean;
  readonly abortReason: string | null;

  readonly windowStart: string;
  readonly windowEnd: string;
  readonly eventsFetched: number;
  readonly windowComplete: boolean;
  readonly extractionPaths: Readonly<Record<'path1' | 'path2' | 'path3', number>>;
  readonly filterSurvivors: number;
  readonly filterDrops: Readonly<Record<string, number>>;
  readonly participantsResolved: number;
  /**
   * Which directory produced each BHC_ID. Reported per path and NEVER summed:
   * "12 resolved" hides whether Attio is carrying the pass or Contacts is,
   * and those are different systems with different coverage.
   */
  readonly resolutionByPath: Readonly<Record<ResolutionPath, number>>;
  /** Attio people matched by email but carrying no bhc_contact_id — an NN#15 violation. */
  readonly attioRecordsMissingBhcId: number;

  readonly openTaskCount: number;
  readonly tasksEvaluated: number;
  readonly tasksSkippedByWatermark: number;
  readonly verdictCounts: Readonly<Record<string, number>>;

  /** ⚠ UNEVALUABLE surfaces as a COUNT, never as individual review cards. */
  readonly unevaluableCount: number;

  readonly enqueuedCount: number;
  readonly supersededCount: number;
  readonly watermarkRowsWritten: number;
  readonly results: readonly CalendarReconciliationResult[];
  readonly wouldWrite: readonly string[];
  readonly warnings: readonly string[];
}
